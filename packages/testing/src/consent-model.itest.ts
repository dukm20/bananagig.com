import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONSENT_ACCEPTANCE_STATES,
  CONSENT_ERROR_CODES,
  CONSENT_EVENT_TYPES,
  CONSENT_PURPOSE_STATUSES,
  CONSENT_REQUIREMENT_STATUSES,
  CONSENT_SOURCES,
  consentErrorMessageKey,
  consentEventLabelKey,
  consentPurposeLabelKey,
  consentReacceptanceKey,
  consentRequiredForKey,
  consentStateLabelKey,
  consentStatusLabelKey,
  LEGAL_ENTRY_KEYS,
  PURPOSE_CODE_PATTERN,
  REACCEPTANCE_MODES,
  SEEDED_CONSENT_PURPOSES,
  SHA256_HEX_PATTERN,
  WITHDRAWAL_POLICIES,
} from '../../contracts/src/consent';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase, createTestPool } from './index';

// Migration 0013 adds the account's relationship to the legal documents of the content registry: identity.consent_purposes (what can be consented to, bound to
// exactly ONE LEGAL entry), identity.consent_events (ONE append-only table that is both the immutable acceptance record and the history, every event bound to
// the exact content version by the composite foreign key (version_id, locale, body_sha256)), the single in-force definition identity.consent_version_state, the
// guard triggers (eligibility under a share lock on the version row, sequence and transition rules, append-only incl. TRUNCATE), the audit extension (two
// consent actions and a consent event reference), two LEGAL entry SHELLS (no versions, no text), four consent policy parameters and 40 consent copy entries.
// These tests drive the REAL tables with raw SQL on isolated databases: the shape of the schema (every column, constraint, index, trigger and function by
// name, nothing speculative), the in-force function for every version state, every guard rule with the exact failing statement (SQLSTATE 23000, DETAIL
// identity_rule:<KEY>), the composite foreign keys, the append-only history, the audit widening, the interleavings that matter under real concurrency, the
// seeds and the privacy shape. The service behaviour is covered in packages/accounts (consent-service.itest.ts), the HTTP layer in apps/api.
let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine: only the seed assertions read it
let pool: pg.Pool;
let racePool: pg.Pool;
let seedPool: pg.Pool;
let seq = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  seed = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  seedPool = createTestPool(seed.url, 4);
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await seedPool?.end();
  await iso?.drop();
  await seed?.drop();
});

// ---------------------------------------------------------------- helpers
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const sq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await seedPool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  column?: string;
  message: string;
}
/** The failure of a statement (the test fails when the statement succeeds). */
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
const constraintOf = async (p: Promise<unknown>): Promise<string | undefined> => (await fail(p)).constraint;
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL identity_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `identity_rule:${key}` });
};
/** Asserts the statement is refused by a UNIQUE index (SQLSTATE 23505) and names it. */
const expectUnique = async (p: Promise<unknown>, index: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23505', constraint: index });
};
/** Asserts the statement violates a foreign key (SQLSTATE 23503) and names it. */
const expectForeignKey = async (p: Promise<unknown>, name: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: name });
};
/** Asserts the statement violates a NOT NULL constraint (SQLSTATE 23502) on this column. */
const expectNotNull = async (p: Promise<unknown>, column: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, column: e.column }).toEqual({ code: '23502', column });
};
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const uniq = (): string => `${++seq}-${randomUUID().slice(0, 8)}`;
const hex64 = (): string => randomBytes(32).toString('hex');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Db = pg.Pool | pg.PoolClient;

/** Runs the callback in one transaction on its own connection: COMMIT on success, ROLLBACK on any failure. */
async function inTxOn<T>(from: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const inTx = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => inTxOn(pool, fn);
/** Opens a transaction on a connection of its own (the caller commits or rolls back and releases). */
async function openTx(from: pg.Pool = pool): Promise<pg.PoolClient> {
  const c = await from.connect();
  await c.query('BEGIN');
  return c;
}
const finish = async (c: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<void> => {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
};
/**
 * Runs `prep` statements and then `text` inside a transaction that is ALWAYS rolled back. Used to reach a CHECK or foreign key that a guard trigger would report
 * first: the prep disables the user triggers of one table for this transaction only (foreign key triggers are internal and stay in force).
 */
async function isolated(prep: string[], text: string, params: unknown[] = [], from: pg.Pool = pool): Promise<void> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    for (const p of prep) await c.query(p);
    await c.query(text, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const noTriggers = (table: string): string[] => [`ALTER TABLE ${table} DISABLE TRIGGER USER`];
const ACCOUNTS = 'identity.accounts';
const SESSIONS = 'identity.application_sessions';
const AUDIT = 'identity.account_audit_events';
const EVENTS = 'identity.consent_events';
const PURPOSES = 'identity.consent_purposes';

/** How many sessions of the database of this pool are blocked on a lock right now. */
const waitersOn = async (from: pg.Pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      )
    ).rows[0] as { n: number }
  ).n;
/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number, from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
/** Waits until nothing is blocked on a lock any more. */
async function noLockWaiters(): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(pool)) === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ---------------------------------------------------------------- fixtures: accounts and sessions (the ID-001 shape, as in security-model.itest.ts)
type AccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSURE_REQUESTED' | 'CLOSED';
const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
async function makeAccount(status: 'PENDING' | 'ACTIVE' = 'ACTIVE', from: pg.Pool = pool): Promise<string> {
  return inTxOn(from, async (c) => {
    const r = await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status]);
    const id = r.rows[0].account_id as string;
    await historyRow(c, id, null, status);
    return id;
  });
}
async function setAccountStatus(accountId: string, to: AccountStatus): Promise<void> {
  await inTx(async (c) => {
    const from = (await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0].status as string;
    await c.query(
      "UPDATE identity.accounts SET status = $2::text, closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() END, updated_at = now() WHERE account_id = $1",
      [accountId, to],
    );
    await historyRow(c, accountId, from, to);
  });
}
async function accountIn(status: AccountStatus): Promise<string> {
  if (status === 'PENDING') return makeAccount('PENDING');
  const id = await makeAccount('ACTIVE');
  if (status === 'SUSPENDED' || status === 'CLOSURE_REQUESTED') await setAccountStatus(id, status);
  if (status === 'CLOSED') {
    await setAccountStatus(id, 'SUSPENDED');
    await setAccountStatus(id, 'CLOSED');
  }
  return id;
}
const insertSession = async (accountId: string, db: Db = pool): Promise<string> =>
  (
    await db.query('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2) RETURNING application_session_id', [
      accountId,
      `sid-${uniq()}`,
    ])
  ).rows[0].application_session_id as string;

// ---------------------------------------------------------------- fixtures: LEGAL entries, purposes and content versions (through the REAL content guards)
type VerStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'CANCELLED';
type Scope = 'PLATFORM' | 'COUNTRY' | 'MARKET';
interface Entry {
  id: string;
  key: string;
}
interface VerRef {
  id: string;
  locale: string;
  hash: string;
}
interface Ver extends VerRef {
  entryId: string;
  number: number;
  body: string;
}
interface Purpose extends Entry {
  code: string;
  entryId: string;
}
const AUTHOR = 'legal-author';
const REVIEWER = 'legal-reviewer';

/** A fresh LEGAL entry (the content CHECKs force the legal policy: LEGAL owner, SECOND_APPROVER, CRITICAL, EXACT). */
async function makeEntry(o: { maxScope?: Scope; contentType?: 'LEGAL' | 'UI_LABEL' } = {}, db: Db = pool): Promise<Entry> {
  const key = `legal.test_${uniq().replace('-', '_')}`;
  const legal = (o.contentType ?? 'LEGAL') === 'LEGAL';
  const r = await db.query(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, $2, $3, 'test document', 'PUBLIC', $4, $5, $6, $7, 'test') RETURNING entry_id`,
    [
      key,
      legal ? 'LEGAL' : 'UI_LABEL',
      legal ? 'LEGAL' : 'CONTENT',
      legal ? 'CRITICAL' : 'STANDARD',
      legal ? 'SECOND_APPROVER' : 'NONE',
      legal ? 'EXACT' : 'CHAIN',
      o.maxScope ?? 'PLATFORM',
    ],
  );
  return { id: r.rows[0].entry_id as string, key };
}
/** A fresh consent purpose bound to a fresh LEGAL entry. */
async function makePurpose(o: { withdrawable?: boolean; maxScope?: Scope } = {}, db: Db = pool): Promise<Purpose> {
  const e = await makeEntry({ maxScope: o.maxScope }, db);
  const code = `TEST_${++seq}_${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.query('INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy) VALUES ($1, $2, $3)', [
    code,
    e.id,
    o.withdrawable ? 'WITHDRAWABLE' : 'NOT_WITHDRAWABLE',
  ]);
  return { ...e, code, entryId: e.id };
}
interface VerOpts {
  locale?: string;
  scope?: Scope;
  status?: VerStatus;
  /** SQL expressions (timestamptz) */
  from?: string;
  to?: string | null;
  number?: number;
  body?: string;
}
const setVersionStatus = (db: Db, id: string, status: string) =>
  db.query('UPDATE content.versions SET status = $2, updated_at = now() WHERE version_id = $1', [id, status]);
/**
 * Creates a version and walks it through the REAL lifecycle guard (DRAFT, IN_REVIEW, approval by a second person, APPROVED, SCHEDULED/PUBLISHED, SUPERSEDED) up to
 * the requested status. The default is a PUBLISHED, open-ended version that started an hour ago. A window in the past is possible because the insert guard does
 * not look at the window (the exclusion constraint still forbids two overlapping published versions of one entry, locale and scope).
 */
async function makeVersion(entryId: string, o: VerOpts = {}, db: Db = pool): Promise<Ver> {
  const status = o.status ?? 'PUBLISHED';
  const locale = o.locale ?? 'en-US';
  const scope = o.scope ?? 'PLATFORM';
  const scopeRef = scope === 'PLATFORM' ? null : scope === 'COUNTRY' ? 'US' : 'devtest-market';
  const body = o.body ?? `Test legal text ${uniq()}`;
  const from = o.from ?? "clock_timestamp() - interval '1 hour'";
  const to = o.to === undefined ? (status === 'SUPERSEDED' ? "clock_timestamp() - interval '30 minutes'" : 'NULL') : (o.to ?? 'NULL');
  const number =
    o.number ??
    ((
      await db.query(
        'SELECT coalesce(max(version), 0) + 1 AS n FROM content.versions WHERE entry_id = $1 AND locale = $2 AND scope_type = $3 AND scope_ref IS NOT DISTINCT FROM $4::text',
        [entryId, locale, scope, scopeRef],
      )
    ).rows[0].n as number);
  const ins = await db.query(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, approval_policy, effective_from, effective_to, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'SECOND_APPROVER', ${from}, ${to}, 'test version', $7) RETURNING version_id, body_sha256`,
    [entryId, locale, scope, scopeRef, number, body, AUTHOR],
  );
  const id = ins.rows[0].version_id as string;
  const ver: Ver = { id, entryId, locale, hash: ins.rows[0].body_sha256 as string, number, body };
  if (status === 'DRAFT') return ver;
  if (status === 'CANCELLED') {
    await setVersionStatus(db, id, 'CANCELLED');
    return ver;
  }
  await setVersionStatus(db, id, 'IN_REVIEW');
  if (status === 'IN_REVIEW') return ver;
  if (status === 'REJECTED') {
    await db.query("INSERT INTO content.version_approvals (version_id, approver, decision) VALUES ($1, $2, 'REJECT')", [id, REVIEWER]);
    await setVersionStatus(db, id, 'REJECTED');
    return ver;
  }
  await db.query("INSERT INTO content.version_approvals (version_id, approver, decision) VALUES ($1, $2, 'APPROVE')", [id, REVIEWER]);
  await setVersionStatus(db, id, 'APPROVED');
  if (status === 'APPROVED') return ver;
  await setVersionStatus(db, id, status === 'SCHEDULED' ? 'SCHEDULED' : 'PUBLISHED');
  if (status === 'SUPERSEDED') await setVersionStatus(db, id, 'SUPERSEDED');
  return ver;
}
/** Closes `old` at this statement's instant (the way a publication does) and publishes its successor, which starts right after. */
async function succeed(old: Ver, o: VerOpts = {}): Promise<Ver> {
  await run("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = now(), updated_at = now() WHERE version_id = $1", [old.id]);
  return makeVersion(old.entryId, { ...o, from: o.from ?? 'clock_timestamp()', number: old.number + 1 });
}
const stateOf = async (v: string | null, entry: string | null, at = 'clock_timestamp()', db: pg.Pool = pool): Promise<string> =>
  ((await db.query(`SELECT identity.consent_version_state($1::uuid, $2::uuid, ${at}) AS s`, [v, entry])).rows[0] as { s: string }).s;
/** A locale that exists (the default en-US always does). */
async function makeLocale(locale: string, active = true): Promise<string> {
  await run('INSERT INTO content.locales (locale, is_active) VALUES ($1, $2) ON CONFLICT (locale) DO NOTHING', [locale, active]);
  return locale;
}

// ---------------------------------------------------------------- fixtures: consent events
interface EvOpts {
  seq?: number;
  type?: string;
  session?: string | null;
  correlation?: string;
  /** extra or overriding column values (an explicit null is written as NULL) */
  set?: Record<string, unknown>;
}
function eventInsert(a: string, p: string, v: VerRef, o: EvOpts = {}): { text: string; params: unknown[] } {
  const params: unknown[] = [a, p];
  const set = o.set ?? {};
  const cols: Record<string, string> = { account_id: '$1', purpose_code: '$2' };
  // a value from `set` replaces the default of its column (an explicit null is written as NULL); only the parameters that are used are sent
  const put = (col: string, fallback: unknown, cast = ''): void => {
    const val = col in set ? set[col] : fallback;
    cols[col] = val === null ? 'NULL' : `$${params.push(val)}${cast}`;
  };
  // (a NULL still references $1 and $2, which the next statement needs typed)
  if ('account_id' in set)
    cols.account_id = set.account_id === null ? '(CASE WHEN $1::uuid IS NOT NULL THEN NULL::uuid END)' : `$${params.push(set.account_id)}`;
  if ('purpose_code' in set)
    cols.purpose_code = set.purpose_code === null ? '(CASE WHEN $2::text IS NOT NULL THEN NULL::text END)' : `$${params.push(set.purpose_code)}`;
  if (o.seq === undefined && !('event_seq' in set))
    cols.event_seq = '(SELECT coalesce(max(event_seq), 0) + 1 FROM identity.consent_events WHERE account_id = $1 AND purpose_code = $2)';
  else put('event_seq', o.seq, '::int');
  put('event_type', o.type ?? 'ACCEPTED');
  put('version_id', v.id);
  put('locale', v.locale);
  put('body_sha256', v.hash);
  put('correlation_id', o.correlation ?? 'test-correlation');
  if (o.session !== undefined) put('application_session_id', o.session);
  for (const k of Object.keys(set)) if (!(k in cols)) put(k, set[k]);
  const names = Object.keys(cols);
  return {
    text: `INSERT INTO ${EVENTS} (${names.join(', ')}) VALUES (${names.map((n) => cols[n]).join(', ')}) RETURNING consent_event_id, event_seq, occurred_at`,
    params,
  };
}
interface Inserted {
  consent_event_id: string;
  event_seq: number;
  occurred_at: Date;
}
const addEvent = async (db: Db, a: string, p: string, v: VerRef, o: EvOpts = {}): Promise<Inserted> => {
  const { text, params } = eventInsert(a, p, v, o);
  return (await db.query(text, params)).rows[0] as Inserted;
};
const accept = (a: string, p: string, v: VerRef, o: EvOpts = {}) => addEvent(pool, a, p, v, { ...o, type: 'ACCEPTED' });
const withdraw = (a: string, p: string, v: VerRef, o: EvOpts = {}) => addEvent(pool, a, p, v, { ...o, type: 'WITHDRAWN' });
/** The same insert with the guard trigger of the table disabled (rolled back): reaches the CHECK, UNIQUE and foreign keys behind the guard. */
const bypass = (a: string, p: string, v: VerRef, o: EvOpts = {}) => {
  const { text, params } = eventInsert(a, p, v, o);
  return isolated(noTriggers(EVENTS), text, params);
};
const eventRows = (a: string, p?: string) =>
  q<{
    consent_event_id: string;
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
  }>(`SELECT * FROM ${EVENTS} WHERE account_id = $1 AND ($2::text IS NULL OR purpose_code = $2) ORDER BY purpose_code, event_seq`, [a, p ?? null]);

/** A scene: an ACTIVE account, a fresh purpose and one published, in-force version of its document. */
async function scene(o: { withdrawable?: boolean } = {}): Promise<{ a: string; p: Purpose; v: Ver }> {
  const a = await makeAccount();
  const p = await makePurpose(o);
  const v = await makeVersion(p.entryId);
  return { a, p, v };
}
/** Disables one trigger for the transaction of `fn`, then enables it again (to craft rows the guard would refuse). */
async function withoutTrigger<T>(table: string, trigger: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const r = await fn(c);
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    return r;
  });
}

// ---------------------------------------------------------------- fixtures: audit rows
const CUSTOMER = async (): Promise<string> => (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER'"))[0]!.role_id;
interface AuditRefs {
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  session?: string | null;
  device?: string | null;
  consent?: string | null;
  changes?: string | null;
}
const insertAuditRow = (accountId: string, action: string, refs: AuditRefs = {}, db: Db = pool) =>
  db
    .query(
      `INSERT INTO ${AUDIT} (actor, action, account_id, role_id, email_contact_id, phone_contact_id, application_session_id, account_device_id, consent_event_id, changes, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING audit_event_id`,
      [
        'test',
        action,
        accountId,
        refs.role ?? null,
        refs.email ?? null,
        refs.phone ?? null,
        refs.session ?? null,
        refs.device ?? null,
        refs.consent ?? null,
        refs.changes ?? null,
        'test-correlation',
      ],
    )
    .then((r) => r.rows[0].audit_event_id as string);
let phoneSeq = 0;
/** The valid references an action of any older family needs (the family pairing CHECKs), created on the given account. */
async function refsFor(accountId: string, action: string): Promise<AuditRefs> {
  if (action.startsWith('ROLE_')) return { role: await CUSTOMER() };
  if (action.startsWith('EMAIL_'))
    return {
      email: (
        await q<{ email_contact_id: string }>(
          "INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED') RETURNING email_contact_id",
          [accountId, `audit-${uniq()}@example.test`],
        )
      )[0]!.email_contact_id,
    };
  if (action.startsWith('PHONE_'))
    return {
      phone: (
        await q<{ phone_contact_id: string }>(
          "INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED') RETURNING phone_contact_id",
          [accountId, `+1202${String(++phoneSeq).padStart(7, '0')}`],
        )
      )[0]!.phone_contact_id,
    };
  if (/^SESSION_/.test(action)) return { session: await insertSession(accountId) };
  if (action.startsWith('DEVICE_'))
    return {
      device: (
        await q<{ account_device_id: string }>(
          "INSERT INTO identity.account_devices (account_id, device_hash, browser_family, os_family, device_class) VALUES ($1, $2, 'CHROME', 'MACOS', 'DESKTOP') RETURNING account_device_id",
          [accountId, hex64()],
        )
      )[0]!.account_device_id,
    };
  return {};
}

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const PURPOSE_COLUMNS: ColumnShape[] = [
  ['purpose_code', 'text', false, null],
  ['document_entry_id', 'uuid', false, null],
  ['withdrawal_policy', 'text', false, null],
  ['status', 'text', false, "'ACTIVE'::text"],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['updated_at', 'timestamp with time zone', false, 'now()'],
];
const EVENT_COLUMNS: ColumnShape[] = [
  ['consent_event_id', 'uuid', false, 'gen_random_uuid()'],
  ['account_id', 'uuid', false, null],
  ['purpose_code', 'text', false, null],
  ['event_seq', 'integer', false, null],
  ['event_type', 'text', false, null],
  ['version_id', 'uuid', false, null],
  ['locale', 'text', false, null],
  ['body_sha256', 'text', false, null],
  ['occurred_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['source', 'text', false, "'ACCOUNT_API'::text"],
  ['application_session_id', 'uuid', true, null],
  ['correlation_id', 'text', false, null],
];
const columnsOf = async (table: string, schema = 'identity', from: pg.Pool = pool): Promise<ColumnShape[]> =>
  (
    (
      await from.query(
        'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
        [schema, table],
      )
    ).rows as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
const constraintsOf = async (
  table: string,
  from: pg.Pool = pool,
): Promise<{ conname: string; contype: string; confdeltype: string; confmatchtype: string; target: string | null }[]> =>
  (
    await from.query(
      `SELECT conname, contype, confdeltype, confmatchtype, confrelid::regclass::text AS target FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const constraintDef = async (name: string, from: pg.Pool = pool): Promise<string> =>
  ((await from.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name])).rows[0] as { def: string }).def;
const indexesOf = async (table: string, schema = 'identity', from: pg.Pool = pool): Promise<{ indexname: string; indexdef: string }[]> =>
  (await from.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname COLLATE "C"', [schema, table]))
    .rows;
const commentOn = async (table: string, column?: string, from: pg.Pool = pool): Promise<string | null> =>
  (
    (
      await from.query(
        column
          ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
          : "SELECT obj_description($1::regclass, 'pg_class') AS c",
        column ? [table, column] : [table],
      )
    ).rows[0] as { c: string | null }
  ).c;
const triggersOf = async (table: string) =>
  q<{ tgname: string; def: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
  );
const vocab = (def: string): string[] => [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);

const PURPOSE_CONSTRAINTS = [
  'c:ck_consent_purposes__purpose_code',
  'c:ck_consent_purposes__status',
  'c:ck_consent_purposes__withdrawal_policy',
  'f:fk_consent_purposes__document_entry',
  'p:pk_consent_purposes',
  'u:uq_consent_purposes__document_entry',
];
const EVENT_CONSTRAINTS = [
  'c:ck_consent_events__body_sha256',
  'c:ck_consent_events__correlation_id',
  'c:ck_consent_events__event_seq',
  'c:ck_consent_events__event_type',
  'c:ck_consent_events__source',
  'f:fk_consent_events__account_id',
  'f:fk_consent_events__account_session',
  'f:fk_consent_events__purpose_code',
  'f:fk_consent_events__version',
  'p:pk_consent_events',
  'u:uq_consent_events__account_event',
  'u:uq_consent_events__account_purpose_seq',
];
const AUDIT_CONSTRAINTS_0013 = ['ck_account_audit_events__consent_event', 'fk_account_audit_events__account_consent_event'];
/** The 37 actions that exist before 0013 (7 account, 7 email, 7 phone, 16 security). */
const OLD_ACTIONS = [
  'ACCOUNT_CREATED',
  'EXTERNAL_IDENTITY_LINKED',
  'ROLE_GRANTED',
  'ROLE_ACTIVATED',
  'ROLE_DEACTIVATED',
  'PRIMARY_ROLE_CHANGED',
  'PROFILE_UPDATED',
  'EMAIL_ADDED',
  'EMAIL_CHANGE_REQUESTED',
  'EMAIL_VERIFICATION_REQUESTED',
  'EMAIL_VERIFICATION_FAILED',
  'EMAIL_VERIFICATION_LOCKED',
  'EMAIL_VERIFIED',
  'EMAIL_PRIMARY_CHANGED',
  'PHONE_ADDED',
  'PHONE_CHANGE_REQUESTED',
  'PHONE_VERIFICATION_REQUESTED',
  'PHONE_VERIFICATION_FAILED',
  'PHONE_VERIFICATION_LOCKED',
  'PHONE_VERIFIED',
  'PHONE_PRIMARY_CHANGED',
  'SESSION_CREATED',
  'SESSION_ENDED',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED_ALL',
  'DEVICE_TRUSTED',
  'DEVICE_UNTRUSTED',
  'DEVICE_REMOVED',
  'MFA_ENROLLMENT_REQUESTED',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'RECOVERY_CODES_REQUESTED',
  'RECOVERY_CODES_ENABLED',
  'RECOVERY_CODES_DISABLED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_COMPLETED',
];
const CONSENT_ACTIONS = ['CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN'];

describe('A. schema shape: the account side of the legal documents, bound to immutable content versions and holding no legal text', () => {
  it('adds exactly two tables to the identity schema (seventeen in total after 0014) and no sequence, view, materialized view or partition', async () => {
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'",
    );
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      'account_audit_events',
      'account_devices',
      'account_profiles',
      'account_roles',
      'account_section_roles',
      'account_sections',
      'account_status_history',
      'accounts',
      'application_sessions',
      'consent_events',
      'consent_purposes',
      'email_contacts',
      'email_verification_challenges',
      'external_identities',
      'phone_contacts',
      'phone_verification_challenges',
      'roles',
    ]);
    expect(await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).toEqual([
      { relname: 'account_status_history_history_seq_seq' },
    ]);
    expect(
      await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind IN ('v', 'm', 'p')"),
    ).toEqual([]);
  });

  it('has exactly the documented columns, types, nullability and defaults on consent_purposes', async () => {
    expect(await columnsOf('consent_purposes')).toEqual(PURPOSE_COLUMNS);
  });

  it('has exactly the documented columns, types, nullability and defaults on consent_events (the occurred_at default is the database clock, the source defaults to ACCOUNT_API)', async () => {
    expect(await columnsOf('consent_events')).toEqual(EVENT_COLUMNS);
  });

  it('adds exactly one nullable uuid column without default (consent_event_id) to the audit trail, after account_device_id, and keeps the rest', async () => {
    const cols = await columnsOf('account_audit_events');
    expect(cols.map(([n, t, nullable]) => [n, t, nullable])).toEqual([
      ['audit_event_id', 'uuid', false],
      ['occurred_at', 'timestamp with time zone', false],
      ['actor', 'text', false],
      ['action', 'text', false],
      ['account_id', 'uuid', false],
      ['role_id', 'uuid', true],
      ['changes', 'jsonb', true],
      ['reason', 'text', true],
      ['correlation_id', 'text', false],
      ['email_contact_id', 'uuid', true],
      ['phone_contact_id', 'uuid', true],
      ['application_session_id', 'uuid', true],
      ['account_device_id', 'uuid', true],
      ['consent_event_id', 'uuid', true],
    ]);
    expect(cols.at(-1)![3]).toBeNull();
  });

  it('has exactly the documented constraints on consent_purposes (primary key, one unique, one foreign key, three checks: 6)', async () => {
    const c = await constraintsOf(PURPOSES);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(PURPOSE_CONSTRAINTS);
    expect(c).toHaveLength(6);
  });

  it('has exactly the documented constraints on consent_events (primary key, two uniques, four foreign keys, five checks: 12)', async () => {
    const c = await constraintsOf(EVENTS);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(EVENT_CONSTRAINTS);
    expect(c).toHaveLength(12);
  });

  it('adds exactly two constraints to the audit trail (a composite foreign key and a pairing check) and keeps the action CHECK under its name', async () => {
    const names = (await constraintsOf(AUDIT)).map((r) => r.conname);
    for (const n of AUDIT_CONSTRAINTS_0013) expect(names, n).toContain(n);
    expect(names.sort()).toEqual([
      'ck_account_audit_events__action',
      'ck_account_audit_events__actor',
      'ck_account_audit_events__changes_object',
      'ck_account_audit_events__consent_event',
      'ck_account_audit_events__device',
      'ck_account_audit_events__email_contact',
      'ck_account_audit_events__phone_contact',
      'ck_account_audit_events__role',
      'ck_account_audit_events__session',
      'fk_account_audit_events__account_consent_event',
      'fk_account_audit_events__account_device',
      'fk_account_audit_events__account_email_contact',
      'fk_account_audit_events__account_id',
      'fk_account_audit_events__account_phone_contact',
      'fk_account_audit_events__account_session',
      'fk_account_audit_events__role_id',
      'pk_account_audit_events',
    ]);
  });

  it('brings the identity schema to 155 primary key, unique, foreign key and check constraints (121 before 0013 plus 6 + 12 + 2, plus 14 from 0014)', async () => {
    const { n } = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')",
      )
    )[0]!;
    expect(n).toBe(155);
    expect(PURPOSE_CONSTRAINTS.length + EVENT_CONSTRAINTS.length + AUDIT_CONSTRAINTS_0013.length).toBe(20);
    expect(121 + 20 + 14).toBe(155);
  });

  it('declares every new foreign key ON DELETE RESTRICT with the default MATCH SIMPLE, and no foreign key of the identity schema cascades', async () => {
    const mine = [
      ...(await constraintsOf(PURPOSES)),
      ...(await constraintsOf(EVENTS)),
      ...(await constraintsOf(AUDIT)).filter((r) => r.conname === 'fk_account_audit_events__account_consent_event'),
    ].filter((r) => r.contype === 'f');
    expect(mine.map((r) => [r.conname, r.confdeltype, r.confmatchtype, r.target]).sort()).toEqual(
      [
        ['fk_consent_purposes__document_entry', 'r', 's', 'content.entries'],
        ['fk_consent_events__account_id', 'r', 's', 'identity.accounts'],
        ['fk_consent_events__purpose_code', 'r', 's', 'identity.consent_purposes'],
        ['fk_consent_events__version', 'r', 's', 'content.versions'],
        ['fk_consent_events__account_session', 'r', 's', 'identity.application_sessions'],
        ['fk_account_audit_events__account_consent_event', 'r', 's', 'identity.consent_events'],
      ].sort(),
    );
    expect(
      await q(
        "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype = 'f' AND c.confdeltype <> 'r'",
      ),
    ).toEqual([]);
  });

  it('binds an event to the EXACT text by one COMPOSITE foreign key on (version_id, locale, body_sha256), and every cross-table reference to its own account', async () => {
    expect(await constraintDef('fk_consent_events__version')).toBe(
      'FOREIGN KEY (version_id, locale, body_sha256) REFERENCES content.versions(version_id, locale, body_sha256) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_consent_events__account_session')).toBe(
      'FOREIGN KEY (account_id, application_session_id) REFERENCES identity.application_sessions(account_id, application_session_id) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_account_audit_events__account_consent_event')).toBe(
      'FOREIGN KEY (account_id, consent_event_id) REFERENCES identity.consent_events(account_id, consent_event_id) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_consent_events__account_id')).toBe('FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT');
    expect(await constraintDef('fk_consent_events__purpose_code')).toBe(
      'FOREIGN KEY (purpose_code) REFERENCES identity.consent_purposes(purpose_code) ON DELETE RESTRICT',
    );
    expect(await constraintDef('fk_consent_purposes__document_entry')).toBe(
      'FOREIGN KEY (document_entry_id) REFERENCES content.entries(entry_id) ON DELETE RESTRICT',
    );
    // nothing references an event, a session or a version by its single id from a table that has an account: no single-column foreign key to consent_events exists
    expect(
      await q("SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid = 'identity.consent_events'::regclass AND array_length(conkey, 1) = 1"),
    ).toEqual([]);
  });

  it('defines the unique keys that the composite foreign keys target and the one-event-per-position rule', async () => {
    expect(await constraintDef('uq_consent_events__account_purpose_seq')).toBe('UNIQUE (account_id, purpose_code, event_seq)');
    expect(await constraintDef('uq_consent_events__account_event')).toBe('UNIQUE (account_id, consent_event_id)');
    expect(await constraintDef('uq_consent_purposes__document_entry')).toBe('UNIQUE (document_entry_id)');
    expect(await constraintDef('pk_consent_purposes')).toBe('PRIMARY KEY (purpose_code)');
    expect(await constraintDef('pk_consent_events')).toBe('PRIMARY KEY (consent_event_id)');
  });

  it('CHECKs the closed vocabularies to exactly the contract lists (catalog), so the database and the API cannot drift', async () => {
    expect(vocab(await constraintDef('ck_consent_purposes__withdrawal_policy'))).toEqual([...WITHDRAWAL_POLICIES]);
    expect(vocab(await constraintDef('ck_consent_purposes__status'))).toEqual([...CONSENT_PURPOSE_STATUSES]);
    expect(vocab(await constraintDef('ck_consent_events__event_type'))).toEqual([...CONSENT_EVENT_TYPES]);
    expect(vocab(await constraintDef('ck_consent_events__source'))).toEqual([...CONSENT_SOURCES]);
    expect(CONSENT_EVENT_TYPES).toEqual(['ACCEPTED', 'WITHDRAWN']);
    expect(CONSENT_SOURCES).toEqual(['ACCOUNT_API']);
  });

  it('CHECKs the purpose code and the hash to the contract patterns, the sequence to positive numbers and the correlation id to 1..200 characters (catalog)', async () => {
    expect(await constraintDef('ck_consent_purposes__purpose_code')).toContain(PURPOSE_CODE_PATTERN.source);
    expect(await constraintDef('ck_consent_events__body_sha256')).toContain(SHA256_HEX_PATTERN.source);
    expect(await constraintDef('ck_consent_events__event_seq')).toBe('CHECK ((event_seq > 0))');
    const corr = await constraintDef('ck_consent_events__correlation_id');
    expect(corr).toMatch(/length\(btrim\(correlation_id\)\) >= 1/);
    expect(corr).toMatch(/length\(btrim\(correlation_id\)\) <= 200/);
  });

  it('pairs the CONSENT_ prefix with the consent event reference in the audit trail with an ESCAPED underscore (catalog)', async () => {
    expect(await constraintDef('ck_account_audit_events__consent_event')).toMatch(/\(\(action ~~ 'CONSENT\\_%'::text\) = \(consent_event_id IS NOT NULL\)\)/);
  });

  it('has exactly the documented indexes on consent_purposes: only the two keys', async () => {
    expect((await indexesOf('consent_purposes')).map((r) => r.indexname)).toEqual(['pk_consent_purposes', 'uq_consent_purposes__document_entry']);
  });

  it('has exactly the documented indexes on consent_events: only the three keys (the sequence key serves the latest event and the account history; no plain index)', async () => {
    const idx = await indexesOf('consent_events');
    expect(idx.map((r) => r.indexname)).toEqual(['pk_consent_events', 'uq_consent_events__account_event', 'uq_consent_events__account_purpose_seq']);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.uq_consent_events__account_purpose_seq).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, purpose_code, event_seq\)$/);
    expect(def.uq_consent_events__account_event).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(account_id, consent_event_id\)$/);
    expect(def.pk_consent_events).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(consent_event_id\)$/);
  });

  it('has nothing speculative: NO index on version_id (or the locale, hash, event type, source, session or purpose alone) and none on the new audit column', async () => {
    expect(await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND tablename = 'consent_events' AND indexname !~ '^(pk|uq)_'")).toEqual([]);
    const rows = await q<{ table_name: string; column_name: string }>(
      `SELECT t.relname AS table_name, a.attname AS column_name
         FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
        WHERE n.nspname = 'identity' AND t.relname IN ('consent_events', 'consent_purposes') ORDER BY 1, 2`,
    );
    expect([...new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))].sort()).toEqual([
      'consent_events.account_id',
      'consent_events.consent_event_id',
      'consent_events.event_seq',
      'consent_events.purpose_code',
      'consent_purposes.document_entry_id',
      'consent_purposes.purpose_code',
    ]);
    expect(rows.filter((r) => r.column_name === 'version_id')).toEqual([]);
    // every index that mentions version_id anywhere in the identity schema: none
    expect(await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND indexdef ~ 'version_id'")).toEqual([]);
    // the audit trail keeps its two older indexes plus the security-state one; nothing was added for consent_event_id
    expect((await indexesOf('account_audit_events')).map((r) => r.indexname)).toEqual([
      'idx_account_audit_events__account',
      'idx_account_audit_events__account_security_state',
      'pk_account_audit_events',
    ]);
    expect((await indexesOf('account_audit_events')).filter((r) => /consent_event_id/.test(r.indexdef))).toEqual([]);
  });

  it('adds the unique constraint uq_versions__version_locale_hash to content.versions and nothing else (additive: version_id alone was already unique)', async () => {
    expect(await constraintDef('uq_versions__version_locale_hash')).toBe('UNIQUE (version_id, locale, body_sha256)');
    const c = await constraintsOf('content.versions');
    expect(c.filter((r) => r.contype === 'u').map((r) => r.conname)).toEqual([
      'uq_versions__holder_version',
      'uq_versions__version_entry',
      'uq_versions__version_locale_hash',
    ]);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual([
      'c:ck_versions__approval_policy',
      'c:ck_versions__body_length',
      'c:ck_versions__effective_range',
      'c:ck_versions__platform_has_no_ref',
      'c:ck_versions__reason_not_blank',
      'c:ck_versions__scope_ref_format',
      'c:ck_versions__scope_type',
      'c:ck_versions__status',
      'c:ck_versions__version_positive',
      'x:ex_versions__no_overlap',
      'f:fk_versions__entry_id',
      'f:fk_versions__locale',
      'f:fk_versions__scope_type',
      'p:pk_versions',
      'u:uq_versions__holder_version',
      'u:uq_versions__version_entry',
      'u:uq_versions__version_locale_hash',
    ]);
    expect((await indexesOf('versions', 'content')).map((r) => r.indexname)).toEqual([
      'ex_versions__no_overlap',
      'idx_versions__entry',
      'idx_versions__in_review',
      'idx_versions__resolution',
      'idx_versions__scheduled',
      'pk_versions',
      'uq_versions__holder_version',
      'uq_versions__version_entry',
      'uq_versions__version_locale_hash',
    ]);
  });

  it('wires the guards: one row guard on the purposes, and on the events a row guard (INSERT), the append-only trigger (UPDATE, DELETE) and the TRUNCATE trigger', async () => {
    const purposes = await triggersOf(PURPOSES);
    expect(purposes.map((t) => t.tgname)).toEqual(['trg_consent_purposes__guard']);
    expect(purposes[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.consent_purposes FOR EACH ROW EXECUTE FUNCTION identity\.guard_consent_purposes\(\)/,
    );
    const events = await triggersOf(EVENTS);
    expect(events.map((t) => t.tgname)).toEqual(['trg_consent_events__guard', 'trg_consent_events__immutable', 'trg_consent_events__no_truncate']);
    const def = Object.fromEntries(events.map((t) => [t.tgname, t.def]));
    expect(def.trg_consent_events__guard).toMatch(/BEFORE INSERT ON identity\.consent_events FOR EACH ROW EXECUTE FUNCTION identity\.guard_consent_events\(\)/);
    expect(def.trg_consent_events__immutable).toMatch(
      /BEFORE DELETE OR UPDATE ON identity\.consent_events FOR EACH ROW EXECUTE FUNCTION identity\.forbid_mutation\(\)/,
    );
    expect(def.trg_consent_events__no_truncate).toMatch(
      /BEFORE TRUNCATE ON identity\.consent_events FOR EACH STATEMENT EXECUTE FUNCTION identity\.forbid_mutation\(\)/,
    );
    expect(purposes.concat(events).filter((t) => /CONSTRAINT TRIGGER|DEFERRABLE/.test(t.def))).toEqual([]);
    // the audit trail keeps its single append-only trigger
    expect((await triggersOf(AUDIT)).map((t) => t.tgname)).toEqual(['trg_account_audit_events__immutable']);
  });

  it('defines the in-force function as SQL, STABLE, returning text and NOT SECURITY DEFINER, and the guards as plain plpgsql', async () => {
    expect(
      await q(
        `SELECT p.proname, l.lanname AS lang, p.provolatile AS volatility, p.prosecdef AS secdef, pg_get_function_result(p.oid) AS result,
                pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'identity' AND p.proname = 'consent_version_state'`,
      ),
    ).toEqual([
      {
        proname: 'consent_version_state',
        lang: 'sql',
        volatility: 's',
        secdef: false,
        result: 'text',
        args: 'p_version_id uuid, p_entry_id uuid, p_at timestamp with time zone',
      },
    ]);
    expect(
      await q(
        `SELECT p.proname, l.lanname AS lang, p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'identity' AND p.proname IN ('guard_consent_purposes', 'guard_consent_events') ORDER BY 1`,
      ),
    ).toEqual([
      { proname: 'guard_consent_events', lang: 'plpgsql', secdef: false },
      { proname: 'guard_consent_purposes', lang: 'plpgsql', secdef: false },
    ]);
  });

  it('uses the plan the indexes are for: the latest event of an account and purpose, and the history of an account, by the sequence key (no time index exists)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    await run('ANALYZE identity.consent_events');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const latest = (
        await c.query(`EXPLAIN SELECT event_type FROM ${EVENTS} WHERE account_id = $1 AND purpose_code = $2 ORDER BY event_seq DESC LIMIT 1`, [a, p.code])
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(latest).toContain('uq_consent_events__account_purpose_seq');
      const history = (await c.query(`EXPLAIN SELECT event_type FROM ${EVENTS} WHERE account_id = $1 ORDER BY occurred_at DESC LIMIT 200`, [a])).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(history).toMatch(/consent_events_|uq_consent_events__account|pk_consent_events|Index/);
      expect(history).not.toContain('idx_consent_events__account_time');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

// ====================================================================== B. consent_purposes: constraints and guard
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });
const insertPurposeRaw = (code: string, entryId: string, policy = 'NOT_WITHDRAWABLE', status?: string) =>
  status === undefined
    ? run('INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy) VALUES ($1, $2, $3)', [code, entryId, policy])
    : run('INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy, status) VALUES ($1, $2, $3, $4)', [
        code,
        entryId,
        policy,
        status,
      ]);
const BAD_CODES: [label: string, value: string][] = [
  ['an empty code', ''],
  ['a single character', 'A'],
  ['a lower-case code', 'terms_of_service'],
  ['a mixed-case code', 'Terms_Of_Service'],
  ['a code that starts with a digit', '1TERMS'],
  ['a code that starts with an underscore', '_TERMS'],
  ['a code with a dash', 'TERMS-OF-SERVICE'],
  ['a code with a space', 'TERMS OF_SERVICE'],
  ['a code with a trailing space', 'TERMS_OF_SERVICE '],
  ['a code with a trailing line feed', `TERMS_OF_SERVICE${ch(0x0a)}`],
  ['a code with a leading line feed', `${ch(0x0a)}TERMS_OF_SERVICE`],
  ['a code with a dot', 'TERMS.OF_SERVICE'],
  ['a 65-character code', `A${'B'.repeat(64)}`],
  ['a code with a full-width letter', `TERMS${ch(0xff21)}`],
  ['a code with an accented letter', `TERMS_${ch(0xc9)}`],
  ['a code with a zero-width space', `TERMS_${ch(0x200b)}OF`],
];
const PURPOSE_CASES: ConstraintCase[] = [
  ...BAD_CODES.map(([label, value]) =>
    bad('ck_consent_purposes__purpose_code', `purpose_code: ${label}`, async () => {
      const e = await makeEntry();
      await isolated(
        noTriggers(PURPOSES),
        "INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy) VALUES ($1, $2, 'NOT_WITHDRAWABLE')",
        [value, e.id],
      );
    }),
  ),
  ...['withdrawable', 'REQUIRED', 'NOT WITHDRAWABLE', '', 'Withdrawable', 'WITHDRAWABLE '].map((v) =>
    bad('ck_consent_purposes__withdrawal_policy', `withdrawal_policy "${v}"`, async () => insertPurposeRaw(`T_${++seq}`, (await makeEntry()).id, v)),
  ),
  ...['active', 'DELETED', 'RETIRED', '', 'ACTIVE '].map((v) =>
    bad('ck_consent_purposes__status', `status "${v}"`, async () => insertPurposeRaw(`T_${++seq}`, (await makeEntry()).id, 'NOT_WITHDRAWABLE', v)),
  ),
  bad('ck_consent_purposes__status', 'an update to an unknown status', async () => {
    const p = await makePurpose();
    await run("UPDATE identity.consent_purposes SET status = 'GONE' WHERE purpose_code = $1", [p.code]);
  }),
  bad('pk_consent_purposes', 'a duplicate purpose code', async () => {
    const p = await makePurpose();
    await insertPurposeRaw(p.code, (await makeEntry()).id);
  }),
  bad('uq_consent_purposes__document_entry', 'a second purpose on the same document (one purpose per document)', async () => {
    const p = await makePurpose();
    await insertPurposeRaw(`T_${++seq}`, p.entryId);
  }),
  bad('fk_consent_purposes__document_entry', 'a document entry that does not exist (the entry guard bypassed: it reports the type first)', async () => {
    await isolated(
      noTriggers(PURPOSES),
      "INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy) VALUES ($1, $2, 'NOT_WITHDRAWABLE')",
      [`T_${++seq}`, randomUUID()],
    );
  }),
  bad('fk_consent_purposes__document_entry', 'deleting the LEGAL entry of a purpose (the entry guard bypassed: it refuses every delete)', async () => {
    const p = await makePurpose();
    await isolated(noTriggers('content.entries'), 'DELETE FROM content.entries WHERE entry_id = $1', [p.entryId]);
  }),
];

describe('B. consent_purposes: constraints by name and the guard rules', () => {
  it.each(PURPOSE_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('accepts the boundary values the checks allow: a 2-character code, a 64-character code, digits and underscores', async () => {
    for (const code of ['AB', `A${'B'.repeat(63)}`, 'A1', 'A_', 'TEST_2026_VERSION_9']) {
      const e = await makeEntry();
      await insertPurposeRaw(code, e.id);
      expect(await count(PURPOSES, 'purpose_code = $1', [code])).toBe(1);
    }
  });

  it('defaults the status to ACTIVE and the timestamps to now() (one transaction instant)', async () => {
    const p = await makePurpose();
    expect(
      await q(
        'SELECT status, created_at = updated_at AS same, created_at <= now() AS past, withdrawal_policy FROM identity.consent_purposes WHERE purpose_code = $1',
        [p.code],
      ),
    ).toEqual([{ status: 'ACTIVE', same: true, past: true, withdrawal_policy: 'NOT_WITHDRAWABLE' }]);
  });

  it('CONSENT_PURPOSE_DOCUMENT: refuses a document that is not a LEGAL entry (every other content type) and an entry that does not exist', async () => {
    const ui = await makeEntry({ contentType: 'UI_LABEL' });
    await expectRule(insertPurposeRaw(`T_${++seq}`, ui.id), 'CONSENT_PURPOSE_DOCUMENT');
    for (const type of ['PLAIN_TEXT', 'RICH_TEXT', 'MARKDOWN', 'EMAIL_SUBJECT', 'EMAIL_BODY', 'PUSH_TITLE', 'PUSH_BODY', 'HELP_ARTICLE']) {
      const r = await q<{ entry_id: string }>(
        `INSERT INTO content.entries (key, content_type, owner_role, description, approval_policy, created_by) VALUES ($1, $2, 'CONTENT', 'not legal', 'NONE', 'test') RETURNING entry_id`,
        [`devtest.consent_${type.toLowerCase()}_${uniq().replace('-', '_')}`, type],
      );
      await expectRule(insertPurposeRaw(`T_${++seq}`, r[0]!.entry_id), 'CONSENT_PURPOSE_DOCUMENT');
    }
    await expectRule(insertPurposeRaw(`T_${++seq}`, randomUUID()), 'CONSENT_PURPOSE_DOCUMENT');
    expect(await count(PURPOSES, "purpose_code LIKE 'T\\_%'")).toBe(0);
  });

  it('CONSENT_PURPOSE_IMMUTABLE: refuses a change of the code, the document, the withdrawal policy or the creation time, whatever else changes with it', async () => {
    const p = await makePurpose({ withdrawable: true });
    const other = await makeEntry();
    const updates: [string, unknown[]][] = [
      ["purpose_code = 'OTHER_CODE'", []],
      ['document_entry_id = $2', [other.id]],
      ["withdrawal_policy = 'NOT_WITHDRAWABLE'", []],
      ["created_at = now() - interval '1 day'", []],
      ["withdrawal_policy = 'NOT_WITHDRAWABLE', status = 'INACTIVE'", []],
      ["status = 'INACTIVE', purpose_code = 'OTHER_CODE'", []],
    ];
    for (const [set, extra] of updates) {
      await expectRule(run(`UPDATE identity.consent_purposes SET ${set} WHERE purpose_code = $1`, [p.code, ...extra]), 'CONSENT_PURPOSE_IMMUTABLE');
    }
    expect(
      await q('SELECT purpose_code, document_entry_id, withdrawal_policy, status FROM identity.consent_purposes WHERE purpose_code = $1', [p.code]),
    ).toEqual([{ purpose_code: p.code, document_entry_id: p.entryId, withdrawal_policy: 'WITHDRAWABLE', status: 'ACTIVE' }]);
  });

  it('lets only the status (and updated_at) change, in both directions, and keeps the other columns', async () => {
    const p = await makePurpose();
    await run("UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]);
    expect((await q('SELECT status FROM identity.consent_purposes WHERE purpose_code = $1', [p.code]))[0]).toEqual({ status: 'INACTIVE' });
    await run("UPDATE identity.consent_purposes SET status = 'ACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]);
    await run('UPDATE identity.consent_purposes SET updated_at = now() WHERE purpose_code = $1', [p.code]);
    await run('UPDATE identity.consent_purposes SET status = status WHERE purpose_code = $1', [p.code]);
    expect(await q('SELECT status, document_entry_id FROM identity.consent_purposes WHERE purpose_code = $1', [p.code])).toEqual([
      { status: 'ACTIVE', document_entry_id: p.entryId },
    ]);
  });

  it('NOT_DELETABLE: refuses to delete a purpose (a used one, an unused one and every row at once)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    await expectRule(run('DELETE FROM identity.consent_purposes WHERE purpose_code = $1', [p.code]), 'NOT_DELETABLE');
    const unused = await makePurpose();
    await expectRule(run('DELETE FROM identity.consent_purposes WHERE purpose_code = $1', [unused.code]), 'NOT_DELETABLE');
    const before = await count(PURPOSES);
    await expectRule(run('DELETE FROM identity.consent_purposes'), 'NOT_DELETABLE');
    expect(await count(PURPOSES)).toBe(before);
  });

  it('keeps the document of a purpose from being re-pointed: another purpose on the same document stays impossible even after a status change', async () => {
    const p = await makePurpose();
    await run("UPDATE identity.consent_purposes SET status = 'INACTIVE' WHERE purpose_code = $1", [p.code]);
    await expectUnique(insertPurposeRaw(`T_${++seq}`, p.entryId), 'uq_consent_purposes__document_entry');
  });
});

// ====================================================================== C. consent_events: constraints behind the guard, by name
const BAD_HASHES: [label: string, value: string][] = [
  ['upper-case hex', hex64().toUpperCase().replace(/[0-9]/g, 'A')],
  ['a mixed-case hex', `A${hex64().slice(1)}`],
  ['63 hex characters', hex64().slice(1)],
  ['65 hex characters', `${hex64()}0`],
  ['an empty string', ''],
  ['a non-hex letter g', `g${hex64().slice(1)}`],
  ['a 0x prefix', `0x${hex64().slice(2)}`],
  ['a leading space', ` ${hex64().slice(1)}`],
  ['a trailing space', `${hex64().slice(1)} `],
  ['a trailing line feed', `${hex64().slice(1)}${ch(0x0a)}`],
  ['a UUID (36 characters)', randomUUID()],
  ['base64url', randomBytes(32).toString('base64url')],
  ['full-width digits', ch(0xff10).repeat(64)],
  ['Arabic-Indic digits', ch(0x660).repeat(64)],
];
const BAD_CORRELATIONS: [label: string, value: string][] = [
  ['an empty id', ''],
  ['a blank id', '   '],
  ['a 201-character id', 'c'.repeat(201)],
];
const EVENT_CASES: ConstraintCase[] = [
  ...[0, -1, -2147483648].map((n) =>
    bad('ck_consent_events__event_seq', `event_seq ${n}`, async () => {
      const { a, p, v } = await scene();
      await bypass(a, p.code, v, { seq: n });
    }),
  ),
  ...['accepted', 'REVOKED', 'ACCEPT', 'WITHDRAW', 'GRANTED', '', 'ACCEPTED ', ' WITHDRAWN'].map((t) =>
    bad('ck_consent_events__event_type', `event_type "${t}"`, async () => {
      const { a, p, v } = await scene();
      await bypass(a, p.code, v, { type: t });
    }),
  ),
  ...BAD_HASHES.map(([label, value]) =>
    bad('ck_consent_events__body_sha256', `a body_sha256 with ${label}`, async () => {
      const { a, p, v } = await scene();
      await bypass(a, p.code, v, { set: { body_sha256: value } });
    }),
  ),
  ...['ADMIN', 'account_api', 'ACCOUNT_API ', 'IMPORT', '', 'WEB'].map((s) =>
    bad('ck_consent_events__source', `source "${s}"`, async () => {
      const { a, p, v } = await scene();
      await bypass(a, p.code, v, { set: { source: s } });
    }),
  ),
  ...BAD_CORRELATIONS.map(([label, value]) =>
    bad('ck_consent_events__correlation_id', `correlation_id: ${label}`, async () => {
      const { a, p, v } = await scene();
      await bypass(a, p.code, v, { correlation: value });
    }),
  ),
  bad('pk_consent_events', 'a duplicate consent_event_id (guard bypassed)', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    await bypass(a, p.code, v, { seq: 2, set: { consent_event_id: e.consent_event_id } });
  }),
  bad(
    'uq_consent_events__account_purpose_seq',
    'a second event with the same (account, purpose, sequence) (guard bypassed: the guard reports CONSENT_SEQUENCE first)',
    async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      await bypass(a, p.code, v, { seq: 1 });
    },
  ),
  bad('fk_consent_events__account_id', 'an account that does not exist', async () => {
    const { p, v } = await scene();
    await addEvent(pool, randomUUID(), p.code, v, { seq: 1 });
  }),
  bad('fk_consent_events__purpose_code', 'a purpose that does not exist (the guard lets the foreign key report it)', async () => {
    const { a, v } = await scene();
    await addEvent(pool, a, 'NO_SUCH_PURPOSE', v, { seq: 1 });
  }),
  bad('fk_consent_events__version', 'a hash that is not the hash of the version', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, { ...v, hash: hex64() });
  }),
  bad('fk_consent_events__version', 'a locale that is not the locale of the version (another registered locale)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, { ...v, locale: await makeLocale('fr-FR') });
  }),
  bad('fk_consent_events__version', 'the hash of ANOTHER version with the id of this one', async () => {
    const { a, p, v } = await scene();
    const other = await makeVersion(p.entryId, { status: 'DRAFT' });
    await accept(a, p.code, { ...v, hash: other.hash });
  }),
  bad('fk_consent_events__version', 'a version that does not exist (guard bypassed: the guard reports CONSENT_VERSION_NOT_FOUND first)', async () => {
    const { a, p, v } = await scene();
    await bypass(a, p.code, { ...v, id: randomUUID() });
  }),
  bad('fk_consent_events__account_session', 'a session of ANOTHER account', async () => {
    const { a, p, v } = await scene();
    const foreign = await insertSession(await makeAccount());
    await accept(a, p.code, v, { session: foreign });
  }),
  bad('fk_consent_events__account_session', 'a session that does not exist', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v, { session: randomUUID() });
  }),
];

describe('C. consent_events: every constraint behind the guard rejects bad data, by constraint name', () => {
  it.each(EVENT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it.each([
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
    'correlation_id',
  ])('refuses an explicit NULL in %s (guard bypassed: a BEFORE trigger runs before the NOT NULL check)', async (column) => {
    const { a, p, v } = await scene();
    await expectNotNull(bypass(a, p.code, v, { seq: 1, set: { [column]: null } }), column);
  });

  it('accepts a NULL application_session_id and the boundary correlation ids (1 and 200 characters), and defaults the source and the id', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v, { session: null, correlation: 'c' });
    expect(e.event_seq).toBe(1);
    const b = await makeAccount();
    await accept(b, p.code, v, { correlation: 'c'.repeat(200) });
    const row = (await eventRows(a, p.code))[0]!;
    expect(row).toMatchObject({ source: 'ACCOUNT_API', application_session_id: null, correlation_id: 'c' });
    expect(row.consent_event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("accepts the account's OWN application session and refuses it on another account (the composite foreign key, MATCH SIMPLE only skips a NULL session)", async () => {
    const { a, p, v } = await scene();
    const own = await insertSession(a);
    await accept(a, p.code, v, { session: own });
    expect((await eventRows(a, p.code))[0]!.application_session_id).toBe(own);
    const b = await makeAccount();
    await expect(accept(b, p.code, v, { session: own })).rejects.toMatchObject({ code: '23503', constraint: 'fk_consent_events__account_session' });
    expect(await count(EVENTS, 'account_id = $1', [b])).toBe(0);
  });

  it('keeps a session that an event names: the session cannot be deleted (guard) and the foreign key is RESTRICT when the guard is bypassed', async () => {
    const { a, p, v } = await scene();
    const s = await insertSession(a);
    await accept(a, p.code, v, { session: s });
    await expectRule(run('DELETE FROM identity.application_sessions WHERE application_session_id = $1', [s]), 'NOT_DELETABLE');
    await expectForeignKey(
      isolated(noTriggers(SESSIONS), 'DELETE FROM identity.application_sessions WHERE application_session_id = $1', [s]),
      'fk_consent_events__account_session',
    );
  });

  it('keeps an account, a purpose, an entry and a version that an event names: every delete is refused (guards) and every foreign key is RESTRICT when the guards are bypassed', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    // the account also has status history and the version has approvals: those rows are removed first (guards bypassed) so that the consent foreign key is the one that answers
    await expectForeignKey(
      isolated(
        [
          ...noTriggers(ACCOUNTS),
          'ALTER TABLE identity.account_status_history DISABLE TRIGGER USER',
          `DELETE FROM identity.account_status_history WHERE account_id = '${a}'`,
        ],
        'DELETE FROM identity.accounts WHERE account_id = $1',
        [a],
      ),
      'fk_consent_events__account_id',
    );
    await expectForeignKey(
      isolated(noTriggers(PURPOSES), 'DELETE FROM identity.consent_purposes WHERE purpose_code = $1', [p.code]),
      'fk_consent_events__purpose_code',
    );
    await expectForeignKey(
      isolated(
        [
          ...noTriggers('content.versions'),
          'ALTER TABLE content.version_approvals DISABLE TRIGGER USER',
          `DELETE FROM content.version_approvals WHERE version_id = '${v.id}'`,
        ],
        'DELETE FROM content.versions WHERE version_id = $1',
        [v.id],
      ),
      'fk_consent_events__version',
    );
    await expect(run('DELETE FROM content.versions WHERE version_id = $1', [v.id])).rejects.toMatchObject({ code: '23000' });
    await expect(run('DELETE FROM content.entries WHERE entry_id = $1', [p.entryId])).rejects.toMatchObject({ code: '23000' });
    await expect(run('DELETE FROM identity.accounts WHERE account_id = $1', [a])).rejects.toMatchObject({ code: expect.stringMatching(/^(23000|23503)$/) });
  });

  it('keeps the locale and the hash of an accepted version from changing underneath the event: re-keying the version is refused by the foreign key even when the content guard is bypassed', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    await expectForeignKey(
      isolated(noTriggers('content.versions'), 'UPDATE content.versions SET body_sha256 = $2 WHERE version_id = $1', [v.id, hex64()]),
      'fk_consent_events__version',
    );
    const de = await makeLocale('de-DE');
    await expectForeignKey(
      isolated(noTriggers('content.versions'), 'UPDATE content.versions SET locale = $2 WHERE version_id = $1', [v.id, de]),
      'fk_consent_events__version',
    );
    // and the content guard itself refuses the same changes first
    await expect(run('UPDATE content.versions SET body_sha256 = $2 WHERE version_id = $1', [v.id, hex64()])).rejects.toMatchObject({ code: '23000' });
    await expect(run("UPDATE content.versions SET body = 'edited' WHERE version_id = $1", [v.id])).rejects.toMatchObject({ code: '23000' });
  });
});

// ====================================================================== D. identity.consent_version_state: the single in-force definition
describe('D. consent_version_state: NOT_FOUND, NOT_CURRENT or IN_FORCE for every kind of version', () => {
  const NOT_PUBLISHED: VerStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'];

  it('answers NOT_FOUND for an unknown version and for a null version (never an error, never IN_FORCE)', async () => {
    const e = await makeEntry();
    expect(await stateOf(randomUUID(), e.id)).toBe('NOT_FOUND');
    expect(await stateOf(null, e.id)).toBe('NOT_FOUND');
    expect(await stateOf('00000000-0000-0000-0000-000000000000', e.id)).toBe('NOT_FOUND');
  });

  it('fails closed on NULL arguments: a NULL entry is NOT_FOUND for an in-force version, a not-in-force version and an unknown version; a NULL version is NOT_FOUND; a NULL instant is NOT_CURRENT for an otherwise eligible version', async () => {
    const e = await makeEntry();
    const inForce = await makeVersion(e.id, { to: "clock_timestamp() + interval '12 hours'" });
    const future = await makeVersion(e.id, { status: 'SCHEDULED', from: "clock_timestamp() + interval '1 day'" });
    const draft = await makeVersion(e.id, { status: 'DRAFT' });
    for (const id of [inForce.id, future.id, draft.id, randomUUID()]) expect(await stateOf(id, null), id).toBe('NOT_FOUND');
    expect(await stateOf(null, null)).toBe('NOT_FOUND');
    expect(await stateOf(null, e.id)).toBe('NOT_FOUND');
    expect(await stateOf(inForce.id, e.id, 'NULL::timestamptz')).toBe('NOT_CURRENT');
    expect(await stateOf(inForce.id, e.id)).toBe('IN_FORCE');
  });

  it('answers IN_FORCE for a PUBLISHED, open-ended, platform version of the entry whose entry and locale are active', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id);
    expect(await stateOf(v.id, e.id)).toBe('IN_FORCE');
  });

  it('answers NOT_FOUND when the version belongs to ANOTHER entry, even though it is in force for its own', async () => {
    const e1 = await makeEntry();
    const e2 = await makeEntry();
    const v = await makeVersion(e1.id);
    expect(await stateOf(v.id, e1.id)).toBe('IN_FORCE');
    expect(await stateOf(v.id, e2.id)).toBe('NOT_FOUND');
    expect(await stateOf(v.id, randomUUID())).toBe('NOT_FOUND');
  });

  it.each(['COUNTRY', 'MARKET'] as Scope[])(
    'answers NOT_FOUND for a %s-scoped version (legal acceptance is platform-wide), published and in its window or not',
    async (scope) => {
      const e = await makeEntry({ maxScope: 'MARKET' });
      const inWindow = await makeVersion(e.id, { scope, to: "clock_timestamp() + interval '12 hours'" });
      expect(await stateOf(inWindow.id, e.id)).toBe('NOT_FOUND');
      const future = await makeVersion(e.id, { scope, from: "clock_timestamp() + interval '1 day'" });
      expect(await stateOf(future.id, e.id)).toBe('NOT_FOUND');
      // the platform version of the same entry next to them is untouched
      const platform = await makeVersion(e.id);
      expect(await stateOf(platform.id, e.id)).toBe('IN_FORCE');
    },
  );

  it.each(NOT_PUBLISHED)(
    'answers NOT_FOUND for a %s version whose window contains now (unpublished text is indistinguishable from an unknown id)',
    async (status) => {
      const e = await makeEntry();
      const v = await makeVersion(e.id, { status });
      expect((await q<{ status: string }>('SELECT status FROM content.versions WHERE version_id = $1', [v.id]))[0]!.status).toBe(status);
      expect(await stateOf(v.id, e.id)).toBe('NOT_FOUND');
    },
  );

  it('answers NOT_CURRENT for a SCHEDULED version that has not started and IN_FORCE for a SCHEDULED version whose start passed (the activation job has not advanced it yet)', async () => {
    const e = await makeEntry();
    const started = await makeVersion(e.id, { status: 'SCHEDULED', from: "clock_timestamp() - interval '1 minute'" });
    expect(await stateOf(started.id, e.id)).toBe('IN_FORCE');
    const e2 = await makeEntry();
    const future = await makeVersion(e2.id, { status: 'SCHEDULED', from: "clock_timestamp() + interval '1 hour'" });
    expect(await stateOf(future.id, e2.id)).toBe('NOT_CURRENT');
    expect(await stateOf(future.id, e2.id, "clock_timestamp() + interval '2 hours'")).toBe('IN_FORCE');
  });

  it('answers NOT_CURRENT for a PUBLISHED version that starts in the future', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id, { from: "clock_timestamp() + interval '1 hour'" });
    expect(await stateOf(v.id, e.id)).toBe('NOT_CURRENT');
  });

  it('answers NOT_CURRENT for a SUPERSEDED version whose window ended, and IN_FORCE for one whose window still contains the instant (the status is a workflow marker, the timestamps decide)', async () => {
    const e = await makeEntry();
    const ended = await makeVersion(e.id, { status: 'SUPERSEDED' });
    expect(await stateOf(ended.id, e.id)).toBe('NOT_CURRENT');
    const e2 = await makeEntry();
    const closing = await makeVersion(e2.id, { status: 'SUPERSEDED', to: "clock_timestamp() + interval '1 hour'" });
    expect(await stateOf(closing.id, e2.id)).toBe('IN_FORCE');
    expect(await stateOf(closing.id, e2.id, "clock_timestamp() + interval '2 hours'")).toBe('NOT_CURRENT');
  });

  it('answers NOT_CURRENT for a PUBLISHED version that ended (a window closed in the past)', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id, { to: "clock_timestamp() - interval '1 millisecond'" });
    expect(await stateOf(v.id, e.id)).toBe('NOT_CURRENT');
  });

  it('applies the half-open window [effective_from, effective_to) at the boundary instants, to the microsecond', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id, { from: "timestamptz '2026-03-01 00:00:00+00'", to: "timestamptz '2026-04-01 00:00:00+00'" });
    const at = (t: string) => stateOf(v.id, e.id, `timestamptz '${t}'`);
    expect(await at('2026-02-28 23:59:59.999999+00')).toBe('NOT_CURRENT');
    expect(await at('2026-03-01 00:00:00+00')).toBe('IN_FORCE');
    expect(await at('2026-03-01 00:00:00.000001+00')).toBe('IN_FORCE');
    expect(await at('2026-03-31 23:59:59.999999+00')).toBe('IN_FORCE');
    expect(await at('2026-04-01 00:00:00+00')).toBe('NOT_CURRENT');
    expect(await at('2026-04-01 00:00:00.000001+00')).toBe('NOT_CURRENT');
    // the boundary is a boundary of the instant, not of the session time zone
    expect(await at('2026-03-01 01:00:00+01')).toBe('IN_FORCE');
    expect(await at('2026-02-28 23:59:59+01')).toBe('NOT_CURRENT');
  });

  it('treats an open end as in force for every later instant, and a missing instant as not in force', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id, { from: "timestamptz '2026-03-01 00:00:00+00'" });
    expect(await stateOf(v.id, e.id, "timestamptz '9999-01-01 00:00:00+00'")).toBe('IN_FORCE');
    expect(await stateOf(v.id, e.id, 'NULL::timestamptz')).toBe('NOT_CURRENT');
  });

  it('answers NOT_CURRENT when the entry is inactive, IN_FORCE again when it is reactivated', async () => {
    const e = await makeEntry();
    const v = await makeVersion(e.id);
    await run('UPDATE content.entries SET is_active = false, updated_at = now() WHERE entry_id = $1', [e.id]);
    expect(await stateOf(v.id, e.id)).toBe('NOT_CURRENT');
    await run('UPDATE content.entries SET is_active = true, updated_at = now() WHERE entry_id = $1', [e.id]);
    expect(await stateOf(v.id, e.id)).toBe('IN_FORCE');
  });

  it('answers NOT_CURRENT when the locale is inactive, IN_FORCE again when it is reactivated', async () => {
    const locale = await makeLocale('sv-SE');
    const e = await makeEntry();
    const v = await makeVersion(e.id, { locale });
    expect(await stateOf(v.id, e.id)).toBe('IN_FORCE');
    await run('UPDATE content.locales SET is_active = false, updated_at = now() WHERE locale = $1', [locale]);
    expect(await stateOf(v.id, e.id)).toBe('NOT_CURRENT');
    await run('UPDATE content.locales SET is_active = true, updated_at = now() WHERE locale = $1', [locale]);
    expect(await stateOf(v.id, e.id)).toBe('IN_FORCE');
  });

  it('keeps NOT_FOUND ahead of NOT_CURRENT: an unpublished version outside its window is still NOT_FOUND, an inactive entry does not change a DRAFT', async () => {
    const e = await makeEntry();
    const draftFuture = await makeVersion(e.id, { status: 'DRAFT', from: "clock_timestamp() + interval '1 day'" });
    expect(await stateOf(draftFuture.id, e.id)).toBe('NOT_FOUND');
    await run('UPDATE content.entries SET is_active = false, updated_at = now() WHERE entry_id = $1', [e.id]);
    expect(await stateOf(draftFuture.id, e.id)).toBe('NOT_FOUND');
  });

  it('is exactly one definition: for every state above, at most one version per entry, locale and scope is IN_FORCE at an instant (the exclusion constraint)', async () => {
    const e = await makeEntry();
    const v1 = await makeVersion(e.id, { from: "timestamptz '2026-01-01+00'", to: "timestamptz '2026-02-01+00'" });
    const v2 = await makeVersion(e.id, { from: "timestamptz '2026-02-01+00'", to: "timestamptz '2026-03-01+00'" });
    const v3 = await makeVersion(e.id, { from: "timestamptz '2026-03-01+00'" });
    for (const [at, inForce] of [
      ['2026-01-15+00', v1],
      ['2026-02-01+00', v2],
      ['2026-02-28 23:59:59+00', v2],
      ['2026-03-01+00', v3],
      ['2030-01-01+00', v3],
    ] as [string, Ver][]) {
      const states = await Promise.all([v1, v2, v3].map(async (v) => [v.id, await stateOf(v.id, e.id, `timestamptz '${at}'`)] as const));
      expect(
        states.filter(([, s]) => s === 'IN_FORCE').map(([id]) => id),
        at,
      ).toEqual([inForce.id]);
    }
    // a second published version overlapping an existing window cannot exist
    await expect(makeVersion(e.id, { from: "timestamptz '2026-01-15+00'", to: "timestamptz '2026-01-20+00'", number: 9 })).rejects.toMatchObject({
      code: '23P01',
      constraint: 'ex_versions__no_overlap',
    });
  });
});

// ====================================================================== E. the guard rules, one failing statement each
describe('E. guard rules: the exact failing statement of every rule key of the consent events', () => {
  it('records an ACCEPTED event of a version in force: sequence 1, the database clock, the source default and the given session', async () => {
    const { a, p, v } = await scene();
    const s = await insertSession(a);
    const before = (await q<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t;
    const e = await accept(a, p.code, v, { session: s, correlation: 'corr-1' });
    const after = (await q<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t;
    expect(e.event_seq).toBe(1);
    expect(e.occurred_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(e.occurred_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await eventRows(a, p.code)).toEqual([
      expect.objectContaining({
        event_seq: 1,
        event_type: 'ACCEPTED',
        version_id: v.id,
        locale: 'en-US',
        body_sha256: v.hash,
        source: 'ACCOUNT_API',
        application_session_id: s,
        correlation_id: 'corr-1',
      }),
    ]);
  });

  describe('ACCOUNT_CLOSED', () => {
    it('refuses an ACCEPTED event for a CLOSED account, and a WITHDRAWN event for a withdrawable purpose of a CLOSED account', async () => {
      const a = await accountIn('CLOSED');
      const p = await makePurpose({ withdrawable: true });
      const v = await makeVersion(p.entryId);
      await expectRule(accept(a, p.code, v), 'ACCOUNT_CLOSED');
      await expectRule(withdraw(a, p.code, v, { seq: 2 }), 'ACCOUNT_CLOSED');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(0);
    });
    it('refuses a WITHDRAWN event once the account is closed, although it holds an accepted consent from before', async () => {
      const a = await makeAccount();
      const p = await makePurpose({ withdrawable: true });
      const v = await makeVersion(p.entryId);
      await accept(a, p.code, v);
      await setAccountStatus(a, 'SUSPENDED');
      await setAccountStatus(a, 'CLOSED');
      await expectRule(withdraw(a, p.code, v), 'ACCOUNT_CLOSED');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
    });
    it.each(['PENDING', 'SUSPENDED', 'CLOSURE_REQUESTED'] as AccountStatus[])(
      'does not refuse an account that is %s (the database only closes the door on CLOSED accounts; the service refuses the others)',
      async (status) => {
        const a = await accountIn(status);
        const p = await makePurpose();
        const v = await makeVersion(p.entryId);
        expect((await accept(a, p.code, v)).event_seq).toBe(1);
      },
    );
    it('reports ACCOUNT_CLOSED before every other rule (a closed account with a wrong sequence and an unknown version)', async () => {
      const a = await accountIn('CLOSED');
      const p = await makePurpose();
      const v = await makeVersion(p.entryId);
      await expectRule(accept(a, p.code, { ...v, id: randomUUID() }, { seq: 7 }), 'ACCOUNT_CLOSED');
    });
  });

  describe('CONSENT_SEQUENCE', () => {
    it('requires event_seq 1 for the first event: 2, 3, 0, -1 and a huge number are refused (the guard runs before the CHECK)', async () => {
      const { a, p, v } = await scene();
      for (const n of [2, 3, 10, 0, -1, 2147483647]) await expectRule(accept(a, p.code, v, { seq: n }), 'CONSENT_SEQUENCE');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(0);
    });
    it('requires previous + 1: a repeat, a gap and a step back are refused, the next number is accepted', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      await accept(a, p.code, v, { seq: 1 });
      for (const n of [1, 3, 4, 0]) await expectRule(withdraw(a, p.code, v, { seq: n }), 'CONSENT_SEQUENCE');
      expect((await withdraw(a, p.code, v, { seq: 2 })).event_seq).toBe(2);
      await expectRule(accept(a, p.code, v, { seq: 2 }), 'CONSENT_SEQUENCE');
      await expectRule(accept(a, p.code, v, { seq: 4 }), 'CONSENT_SEQUENCE');
      expect((await accept(a, p.code, v, { seq: 3 })).event_seq).toBe(3);
    });
    it('counts per account AND per purpose: another purpose and another account each start at 1', async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      const p2 = await makePurpose();
      const v2 = await makeVersion(p2.entryId);
      await expectRule(accept(a, p2.code, v2, { seq: 2 }), 'CONSENT_SEQUENCE');
      expect((await accept(a, p2.code, v2, { seq: 1 })).event_seq).toBe(1);
      const b = await makeAccount();
      expect((await accept(b, p.code, v, { seq: 1 })).event_seq).toBe(1);
    });
    it('sees the earlier rows of its own transaction (accept, withdraw, re-grant in one transaction) and leaves nothing behind when that transaction rolls back', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      const c2 = await openTx();
      try {
        await addEvent(c2, a, p.code, v, { type: 'ACCEPTED' });
        await addEvent(c2, a, p.code, v, { type: 'WITHDRAWN' });
        expect((await addEvent(c2, a, p.code, v, { type: 'ACCEPTED' })).event_seq).toBe(3);
      } finally {
        await finish(c2);
      }
      expect((await eventRows(a, p.code)).map((r) => [r.event_seq, r.event_type])).toEqual([
        [1, 'ACCEPTED'],
        [2, 'WITHDRAWN'],
        [3, 'ACCEPTED'],
      ]);
    });
    it('applies the rules row by row inside ONE multi-row INSERT (positions 1 and 2 pass, a repeated position fails the whole statement)', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      const row = (n: number, t: string) => `('${a}', '${p.code}', ${n}, '${t}', '${v.id}', 'en-US', '${v.hash}', 'multi')`;
      const cols = 'account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id';
      await run(`INSERT INTO ${EVENTS} (${cols}) VALUES ${row(1, 'ACCEPTED')}, ${row(2, 'WITHDRAWN')}`);
      expect((await eventRows(a, p.code)).map((r) => r.event_seq)).toEqual([1, 2]);
      const b = await scene({ withdrawable: true });
      const rowB = (n: number, t: string) => `('${b.a}', '${b.p.code}', ${n}, '${t}', '${b.v.id}', 'en-US', '${b.v.hash}', 'multi')`;
      const e = await fail(run(`INSERT INTO ${EVENTS} (${cols}) VALUES ${rowB(1, 'ACCEPTED')}, ${rowB(1, 'WITHDRAWN')}`));
      expect(e.code === '23000' ? e.detail : e.constraint).toMatch(/identity_rule:CONSENT_SEQUENCE|uq_consent_events__account_purpose_seq/);
      expect(await count(EVENTS, 'account_id = $1', [b.a])).toBe(0);
    });
    it('is the guard that stands in front of the unique key; without the guard the unique key refuses the same position (23505)', async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      await expectRule(accept(a, p.code, v, { seq: 1 }), 'CONSENT_SEQUENCE');
      await expectUnique(bypass(a, p.code, v, { seq: 1 }), 'uq_consent_events__account_purpose_seq');
    });
  });

  describe('CONSENT_PURPOSE_INACTIVE', () => {
    it('refuses an ACCEPTED event for an INACTIVE purpose and accepts again after the purpose is reactivated', async () => {
      const { a, p, v } = await scene();
      await run("UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]);
      await expectRule(accept(a, p.code, v), 'CONSENT_PURPOSE_INACTIVE');
      await run("UPDATE identity.consent_purposes SET status = 'ACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]);
      expect((await accept(a, p.code, v)).event_seq).toBe(1);
    });
    it('is checked before the version: an INACTIVE purpose with an unknown version reports the purpose', async () => {
      const { a, p, v } = await scene();
      await run("UPDATE identity.consent_purposes SET status = 'INACTIVE' WHERE purpose_code = $1", [p.code]);
      await expectRule(accept(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_PURPOSE_INACTIVE');
    });
    it('still lets an accepted WITHDRAWABLE consent be withdrawn after the purpose was retired, and refuses a re-grant', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      await accept(a, p.code, v);
      await run("UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]);
      expect((await withdraw(a, p.code, v)).event_seq).toBe(2);
      await expectRule(accept(a, p.code, v), 'CONSENT_PURPOSE_INACTIVE');
    });
  });

  describe('CONSENT_VERSION_NOT_FOUND', () => {
    it('refuses an unknown version id (the guard answers before the foreign key) and a nil uuid', async () => {
      const { a, p, v } = await scene();
      await expectRule(accept(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_VERSION_NOT_FOUND');
      await expectRule(accept(a, p.code, { ...v, id: '00000000-0000-0000-0000-000000000000' }), 'CONSENT_VERSION_NOT_FOUND');
    });
    it.each(['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'] as VerStatus[])(
      'refuses a %s version of the document, whose window contains now',
      async (status) => {
        const a = await makeAccount();
        const p = await makePurpose();
        const v = await makeVersion(p.entryId, { status });
        await expectRule(accept(a, p.code, v), 'CONSENT_VERSION_NOT_FOUND');
      },
    );
    it('refuses a version of ANOTHER document even though it is in force for its own purpose (uniform: nothing tells it apart from an unknown id)', async () => {
      const { a, p } = await scene();
      const other = await scene();
      await expectRule(accept(a, p.code, other.v), 'CONSENT_VERSION_NOT_FOUND');
      expect((await accept(a, other.p.code, other.v)).event_seq).toBe(1);
    });
    it.each(['COUNTRY', 'MARKET'] as Scope[])('refuses a %s-scoped version of the document', async (scope) => {
      const a = await makeAccount();
      const p = await makePurpose({ maxScope: 'MARKET' });
      const v = await makeVersion(p.entryId, { scope });
      await expectRule(accept(a, p.code, v), 'CONSENT_VERSION_NOT_FOUND');
    });
    it('is checked before the claimed locale and hash: a wrong hash on an unpublished version reports NOT_FOUND, never the foreign key', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const v = await makeVersion(p.entryId, { status: 'DRAFT' });
      await expectRule(accept(a, p.code, { ...v, hash: hex64() }), 'CONSENT_VERSION_NOT_FOUND');
    });
  });

  describe('CONSENT_VERSION_NOT_CURRENT', () => {
    it('refuses a SCHEDULED version that has not started, and accepts it once it started (SCHEDULED is a marker; the timestamps decide)', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const future = await makeVersion(p.entryId, { status: 'SCHEDULED', from: "clock_timestamp() + interval '1 hour'" });
      await expectRule(accept(a, p.code, future), 'CONSENT_VERSION_NOT_CURRENT');
      const p2 = await makePurpose();
      const started = await makeVersion(p2.entryId, { status: 'SCHEDULED', from: "clock_timestamp() - interval '1 minute'" });
      expect((await accept(a, p2.code, started)).event_seq).toBe(1);
    });
    it('refuses a PUBLISHED version that starts in the future', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      await expectRule(accept(a, p.code, await makeVersion(p.entryId, { from: "clock_timestamp() + interval '1 hour'" })), 'CONSENT_VERSION_NOT_CURRENT');
    });
    it('refuses a SUPERSEDED version whose window ended, and one that ended a millisecond ago', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      await expectRule(accept(a, p.code, await makeVersion(p.entryId, { status: 'SUPERSEDED' })), 'CONSENT_VERSION_NOT_CURRENT');
      const p2 = await makePurpose();
      await expectRule(
        accept(a, p2.code, await makeVersion(p2.entryId, { to: "clock_timestamp() - interval '1 millisecond'" })),
        'CONSENT_VERSION_NOT_CURRENT',
      );
    });
    it('accepts a SUPERSEDED version whose window still contains now (the status is a marker)', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const v = await makeVersion(p.entryId, { status: 'SUPERSEDED', to: "clock_timestamp() + interval '1 hour'" });
      expect((await accept(a, p.code, v)).event_seq).toBe(1);
    });
    it('refuses the previous version after its successor took over, accepts the successor', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const v1 = await makeVersion(p.entryId);
      const v2 = await succeed(v1);
      await expectRule(accept(a, p.code, v1), 'CONSENT_VERSION_NOT_CURRENT');
      expect((await accept(a, p.code, v2)).event_seq).toBe(1);
    });
    it('refuses a version of an inactive entry and of an inactive locale', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const v = await makeVersion(p.entryId);
      await run('UPDATE content.entries SET is_active = false, updated_at = now() WHERE entry_id = $1', [p.entryId]);
      await expectRule(accept(a, p.code, v), 'CONSENT_VERSION_NOT_CURRENT');
      const locale = await makeLocale('nb-NO');
      const p2 = await makePurpose();
      const v2 = await makeVersion(p2.entryId, { locale });
      expect((await accept(a, p2.code, v2)).event_seq).toBe(1);
      const b = await makeAccount();
      await run('UPDATE content.locales SET is_active = false, updated_at = now() WHERE locale = $1', [locale]);
      await expectRule(accept(b, p2.code, v2), 'CONSENT_VERSION_NOT_CURRENT');
      await run('UPDATE content.locales SET is_active = true, updated_at = now() WHERE locale = $1', [locale]);
    });
    it('decides with the database clock at the INSERT: a version that starts 1.5 s from now is refused now and accepted once the database clock passed its start; a window that ends in 1.5 s closes the same way', async () => {
      const p = await makePurpose();
      const startsLater = await makeVersion(p.entryId, { from: "clock_timestamp() + interval '1500 milliseconds'" });
      const a = await makeAccount();
      await expectRule(accept(a, p.code, startsLater), 'CONSENT_VERSION_NOT_CURRENT');
      const p2 = await makePurpose();
      const endsSoon = await makeVersion(p2.entryId, { to: "clock_timestamp() + interval '1500 milliseconds'" });
      const b = await makeAccount();
      expect((await accept(b, p2.code, endsSoon)).event_seq).toBe(1);
      for (let n = 0; n < 200; n++) {
        const past = (
          await q<{ ok: boolean }>('SELECT clock_timestamp() > (SELECT max(effective_from) FROM content.versions WHERE version_id = $1) AS ok', [
            startsLater.id,
          ])
        )[0]!.ok;
        const closed = (
          await q<{ ok: boolean }>('SELECT clock_timestamp() >= (SELECT effective_to FROM content.versions WHERE version_id = $1) AS ok', [endsSoon.id])
        )[0]!.ok;
        if (past && closed) break;
        await sleep(25);
      }
      expect((await accept(a, p.code, startsLater)).event_seq).toBe(1);
      const c = await makeAccount();
      await expectRule(accept(c, p2.code, endsSoon), 'CONSENT_VERSION_NOT_CURRENT');
    });
    it('is checked after NOT_FOUND and before DUPLICATE: an accepted version that was superseded reports NOT_CURRENT when accepted again', async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      await succeed(v);
      await expectRule(accept(a, p.code, v), 'CONSENT_VERSION_NOT_CURRENT');
    });
  });

  describe('CONSENT_DUPLICATE and CONSENT_VERSION_STALE', () => {
    it('refuses ACCEPTED after ACCEPTED of the same version, however often, and records nothing', async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      await expectRule(accept(a, p.code, v), 'CONSENT_DUPLICATE');
      await expectRule(accept(a, p.code, v, { seq: 2 }), 'CONSENT_DUPLICATE');
      await expectRule(accept(a, p.code, v, { session: await insertSession(a), correlation: 'another' }), 'CONSENT_DUPLICATE');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
    });
    it('accepts ACCEPTED after ACCEPTED of the NEXT version (the normal re-acceptance of a newer document)', async () => {
      const { a, p, v } = await scene();
      await accept(a, p.code, v);
      const v2 = await succeed(v);
      expect((await accept(a, p.code, v2)).event_seq).toBe(2);
      const v3 = await succeed(v2);
      expect((await accept(a, p.code, v3)).event_seq).toBe(3);
      expect((await eventRows(a, p.code)).map((r) => [r.event_seq, r.event_type, r.version_id])).toEqual([
        [1, 'ACCEPTED', v.id],
        [2, 'ACCEPTED', v2.id],
        [3, 'ACCEPTED', v3.id],
      ]);
    });
    it('accepts a second locale next to the first (version numbers are per locale, so another locale is not comparable)', async () => {
      const de = await makeLocale('de-DE');
      const a = await makeAccount();
      const p = await makePurpose();
      const en1 = await makeVersion(p.entryId);
      const en2 = await succeed(en1);
      const deV = await makeVersion(p.entryId, { locale: de });
      expect(deV.number).toBe(1);
      await accept(a, p.code, en2);
      expect((await accept(a, p.code, deV)).event_seq).toBe(2);
      expect((await eventRows(a, p.code)).map((r) => r.locale)).toEqual(['en-US', 'de-DE']);
    });
    it('refuses an older version number after a newer one in the same entry and locale (crafted: the window of the accepted version is closed behind the exclusion constraint)', async () => {
      const a = await makeAccount();
      const p = await makePurpose();
      const newer = await makeVersion(p.entryId, { number: 2 });
      await accept(a, p.code, newer);
      // craft: version 2 ends in the past (the content guard forbids it; the exclusion constraint then lets version 1 take the place)
      await withoutTrigger('content.versions', 'trg_versions__guard', (c) =>
        c.query("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = clock_timestamp() - interval '1 minute' WHERE version_id = $1", [newer.id]),
      );
      const older = await makeVersion(p.entryId, { number: 1, from: "clock_timestamp() - interval '30 seconds'" });
      expect(await stateOf(older.id, p.entryId)).toBe('IN_FORCE');
      await expectRule(accept(a, p.code, older), 'CONSENT_VERSION_STALE');
      // the same version number is not greater either
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
      // after a withdrawal the stale rule does not apply (a re-grant is any version in force), and for a fresh account the older version is plain acceptable
      const b = await makeAccount();
      expect((await accept(b, p.code, older)).event_seq).toBe(1);
    });
    it('does not apply the stale rule to a re-grant after a withdrawal', async () => {
      const a = await makeAccount();
      const p = await makePurpose({ withdrawable: true });
      const newer = await makeVersion(p.entryId, { number: 2 });
      await accept(a, p.code, newer);
      await withdraw(a, p.code, newer);
      await withoutTrigger('content.versions', 'trg_versions__guard', (c) =>
        c.query("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = clock_timestamp() - interval '1 minute' WHERE version_id = $1", [newer.id]),
      );
      const older = await makeVersion(p.entryId, { number: 1, from: "clock_timestamp() - interval '30 seconds'" });
      expect((await accept(a, p.code, older)).event_seq).toBe(3);
    });
  });

  describe('CONSENT_NOT_WITHDRAWABLE, CONSENT_NOT_ACCEPTED and CONSENT_WITHDRAWAL_VERSION', () => {
    it('CONSENT_NOT_WITHDRAWABLE: refuses WITHDRAWN on a NOT_WITHDRAWABLE purpose, before and after an acceptance, and before the sequence-independent rules', async () => {
      const { a, p, v } = await scene();
      await expectRule(withdraw(a, p.code, v, { seq: 1 }), 'CONSENT_NOT_WITHDRAWABLE');
      await accept(a, p.code, v);
      await expectRule(withdraw(a, p.code, v), 'CONSENT_NOT_WITHDRAWABLE');
      await expectRule(withdraw(a, p.code, { ...v, hash: hex64() }), 'CONSENT_NOT_WITHDRAWABLE');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
    });
    it('CONSENT_NOT_ACCEPTED: refuses WITHDRAWN as the first event, and WITHDRAWN after WITHDRAWN', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      await expectRule(withdraw(a, p.code, v), 'CONSENT_NOT_ACCEPTED');
      await accept(a, p.code, v);
      await withdraw(a, p.code, v);
      await expectRule(withdraw(a, p.code, v), 'CONSENT_NOT_ACCEPTED');
      await expectRule(withdraw(a, p.code, v, { seq: 4 }), 'CONSENT_SEQUENCE');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(2);
    });
    it('CONSENT_WITHDRAWAL_VERSION: a WITHDRAWN event must carry the version, the locale and the hash of the acceptance it withdraws', async () => {
      const de = await makeLocale('de-DE');
      const { a, p, v } = await scene({ withdrawable: true });
      const deV = await makeVersion(p.entryId, { locale: de });
      await accept(a, p.code, v);
      await expectRule(withdraw(a, p.code, deV), 'CONSENT_WITHDRAWAL_VERSION'); // another version (a valid one, in another locale)
      await expectRule(withdraw(a, p.code, { ...v, hash: hex64() }), 'CONSENT_WITHDRAWAL_VERSION'); // the right version with another hash
      await expectRule(withdraw(a, p.code, { ...v, locale: de }), 'CONSENT_WITHDRAWAL_VERSION'); // the right version with another locale
      await expectRule(withdraw(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_WITHDRAWAL_VERSION');
      await expectRule(withdraw(a, p.code, v, { set: { version_id: null } }), 'CONSENT_WITHDRAWAL_VERSION');
      expect((await withdraw(a, p.code, v)).event_seq).toBe(2);
    });
    it('withdraws the version that was accepted although it is no longer in force (superseded) and although its entry and locale are inactive', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      await accept(a, p.code, v);
      await succeed(v);
      await run('UPDATE content.entries SET is_active = false, updated_at = now() WHERE entry_id = $1', [p.entryId]);
      await run('UPDATE content.locales SET is_active = false, updated_at = now() WHERE locale = $1', [await makeLocale('da-DK')]);
      expect((await withdraw(a, p.code, v)).event_seq).toBe(2);
      // a re-grant of that old version is then refused: it is not in force
      await expectRule(accept(a, p.code, v), 'CONSENT_VERSION_NOT_CURRENT');
    });
    it('records a WITHDRAWN event with the database clock and the version of the withdrawn acceptance', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      const first = await accept(a, p.code, v);
      const w = await withdraw(a, p.code, v, { set: { occurred_at: '2001-01-01T00:00:00Z' } });
      expect(w.occurred_at.getTime()).toBeGreaterThanOrEqual(first.occurred_at.getTime());
      expect(w.occurred_at.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    });
  });

  describe('occurred_at is the database clock, whatever the client sends', () => {
    it.each([
      ['a date in 2001', '2001-01-01T00:00:00Z'],
      ['the epoch', '1970-01-01T00:00:00Z'],
      ['a date far in the future', '2999-12-31T23:59:59Z'],
      ['an instant one hour ago', null],
      ['an explicit NULL', 'NULL'],
    ])('overwrites %s with the instant of the insert', async (_label, client) => {
      const { a, p, v } = await scene();
      const before = (await q<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t;
      const set =
        client === 'NULL'
          ? { occurred_at: null }
          : client === null
            ? { occurred_at: new Date(before.getTime() - 3_600_000).toISOString() }
            : { occurred_at: client };
      const e = await accept(a, p.code, v, { set });
      const after = (await q<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t;
      expect(e.occurred_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(e.occurred_at.getTime()).toBeLessThanOrEqual(after.getTime());
      expect((await eventRows(a, p.code))[0]!.occurred_at.getTime()).toBe(e.occurred_at.getTime());
    });
    it('gives later events of one history later (or equal) instants, in sequence order', async () => {
      const { a, p, v } = await scene({ withdrawable: true });
      for (let n = 0; n < 6; n++) await addEvent(pool, a, p.code, v, { type: n % 2 === 0 ? 'ACCEPTED' : 'WITHDRAWN' });
      const rows = await eventRows(a, p.code);
      for (let n = 1; n < rows.length; n++) expect(rows[n]!.occurred_at.getTime()).toBeGreaterThanOrEqual(rows[n - 1]!.occurred_at.getTime());
    });
  });

  it('applies the rules in a fixed order: ACCOUNT_CLOSED, SEQUENCE, PURPOSE_INACTIVE, VERSION_NOT_FOUND, NOT_CURRENT, DUPLICATE (and NOT_WITHDRAWABLE, NOT_ACCEPTED, WITHDRAWAL_VERSION for a withdrawal)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    // sequence before everything else behind it
    await expectRule(accept(a, p.code, { ...v, id: randomUUID() }, { seq: 5 }), 'CONSENT_SEQUENCE');
    // then the purpose, before the version
    await run("UPDATE identity.consent_purposes SET status = 'INACTIVE' WHERE purpose_code = $1", [p.code]);
    await expectRule(accept(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_PURPOSE_INACTIVE');
    await run("UPDATE identity.consent_purposes SET status = 'ACTIVE' WHERE purpose_code = $1", [p.code]);
    // then the version
    await expectRule(accept(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_VERSION_NOT_FOUND');
    // not withdrawable before not accepted before the version check of a withdrawal
    await expectRule(withdraw(a, p.code, { ...v, id: randomUUID() }), 'CONSENT_NOT_WITHDRAWABLE');
  });

  it('does not let an event of one account touch the history of another account or purpose', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    const b = await makeAccount();
    await accept(a, p.code, v);
    await expectRule(withdraw(b, p.code, v), 'CONSENT_NOT_ACCEPTED');
    expect(await count(EVENTS, 'account_id = $1', [b])).toBe(0);
  });
});

// ====================================================================== F. append-only: UPDATE, DELETE, TRUNCATE
describe('F. the events and their audit rows are append-only', () => {
  it('refuses UPDATE of every column of an event (ROW_IMMUTABLE), also to the same value, and changes nothing', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    const e = await accept(a, p.code, v, { session: await insertSession(a) });
    const other = await makeAccount();
    const sets = [
      `consent_event_id = '${randomUUID()}'`,
      `account_id = '${other}'`,
      "purpose_code = 'OTHER_PURPOSE'",
      'event_seq = 2',
      "event_type = 'WITHDRAWN'",
      `version_id = '${randomUUID()}'`,
      "locale = 'de-DE'",
      `body_sha256 = '${hex64()}'`,
      "occurred_at = timestamptz '2001-01-01+00'",
      'occurred_at = occurred_at',
      "source = 'ACCOUNT_API'",
      'application_session_id = NULL',
      "correlation_id = 'edited'",
      'event_seq = event_seq',
    ];
    const before = JSON.stringify(await eventRows(a, p.code));
    for (const set of sets) await expectRule(run(`UPDATE ${EVENTS} SET ${set} WHERE consent_event_id = $1`, [e.consent_event_id]), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${EVENTS} SET correlation_id = 'bulk' WHERE account_id = $1`, [a]), 'ROW_IMMUTABLE');
    expect(JSON.stringify(await eventRows(a, p.code))).toBe(before);
  });

  it('refuses DELETE of one event and of every event (ROW_IMMUTABLE)', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    await expectRule(run(`DELETE FROM ${EVENTS} WHERE consent_event_id = $1`, [e.consent_event_id]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${EVENTS} WHERE account_id = $1`, [a]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${EVENTS}`), 'ROW_IMMUTABLE');
    expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
  });

  it('refuses TRUNCATE: a plain TRUNCATE is stopped by PostgreSQL itself (0A000: the audit trail references the table), TRUNCATE ... CASCADE by the trigger (ROW_IMMUTABLE)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    const plain = await fail(run(`TRUNCATE ${EVENTS}`));
    expect(plain.code).toBe('0A000');
    await expectRule(run(`TRUNCATE ${EVENTS} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${EVENTS} RESTART IDENTITY CASCADE`), 'ROW_IMMUTABLE');
    expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
  });

  it('refuses TRUNCATE of the tables the events reference, even with CASCADE (the cascade reaches the events and their trigger refuses it)', async () => {
    const { a, p, v } = await scene();
    await accept(a, p.code, v);
    expect((await fail(run(`TRUNCATE ${PURPOSES}`))).code).toBe('0A000');
    await expectRule(run(`TRUNCATE ${PURPOSES} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${ACCOUNTS} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE content.versions CASCADE'), 'ROW_IMMUTABLE');
    expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
    expect(await count(PURPOSES, 'purpose_code = $1', [p.code])).toBe(1);
  });

  it('keeps ROW_IMMUTABLE in force for a bulk statement that would also touch rows of other accounts', async () => {
    const before = await count(EVENTS);
    await expectRule(run(`UPDATE ${EVENTS} SET source = 'ACCOUNT_API'`), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${EVENTS} WHERE true`), 'ROW_IMMUTABLE');
    expect(await count(EVENTS)).toBe(before);
  });
});

// ====================================================================== G. the history shape
describe('G. append-only history: alternating events, re-grants, a gap-free sequence, the exact version of each event', () => {
  it('records accept, withdraw, re-grant of the SAME version, withdraw, accept of the next version: sequence 1..5 without gaps, alternating where the rules say so', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    await accept(a, p.code, v);
    await withdraw(a, p.code, v);
    await accept(a, p.code, v); // re-grant of the very same version
    await withdraw(a, p.code, v);
    const v2 = await succeed(v);
    await accept(a, p.code, v2); // the first acceptance after a withdrawal may be the successor
    const rows = await eventRows(a, p.code);
    expect(rows.map((r) => [r.event_seq, r.event_type, r.version_id])).toEqual([
      [1, 'ACCEPTED', v.id],
      [2, 'WITHDRAWN', v.id],
      [3, 'ACCEPTED', v.id],
      [4, 'WITHDRAWN', v.id],
      [5, 'ACCEPTED', v2.id],
    ]);
    // each event carries the locale and the hash of ITS version (the foreign key proves it; read it back through the join)
    expect(
      await q(
        `SELECT count(*)::int AS n FROM ${EVENTS} e JOIN content.versions v ON v.version_id = e.version_id AND v.locale = e.locale AND v.body_sha256 = e.body_sha256
          WHERE e.account_id = $1 AND e.purpose_code = $2`,
        [a, p.code],
      ),
    ).toEqual([{ n: 5 }]);
  });

  it('keeps the histories of different purposes and accounts independent, each gap-free from 1', async () => {
    const p1 = await makePurpose({ withdrawable: true });
    const p2 = await makePurpose({ withdrawable: true });
    const v1 = await makeVersion(p1.entryId);
    const v2 = await makeVersion(p2.entryId);
    const accounts = await Promise.all([makeAccount(), makeAccount(), makeAccount()]);
    for (const a of accounts) {
      await accept(a, p1.code, v1);
      await accept(a, p2.code, v2);
      await withdraw(a, p1.code, v1);
      await accept(a, p1.code, v1);
    }
    for (const a of accounts) {
      expect((await eventRows(a, p1.code)).map((r) => r.event_seq)).toEqual([1, 2, 3]);
      expect((await eventRows(a, p2.code)).map((r) => r.event_seq)).toEqual([1]);
    }
  });

  it('derives the current state from the latest event only (there is no current flag): the latest event per purpose decides', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    const latest = () => q(`SELECT event_type FROM ${EVENTS} WHERE account_id = $1 AND purpose_code = $2 ORDER BY event_seq DESC LIMIT 1`, [a, p.code]);
    expect(await latest()).toEqual([]);
    await accept(a, p.code, v);
    expect(await latest()).toEqual([{ event_type: 'ACCEPTED' }]);
    await withdraw(a, p.code, v);
    expect(await latest()).toEqual([{ event_type: 'WITHDRAWN' }]);
    expect((await columnsOf('consent_events')).map(([n]) => n).filter((n) => /current|active|accepted$|withdrawn$|status/.test(n))).toEqual([]);
    expect((await columnsOf('consent_purposes')).map(([n]) => n).filter((n) => /current|accepted|withdrawn/.test(n))).toEqual([]);
  });

  it('writes a multi-statement history the same in one transaction as in many (rollback leaves no event and no gap)', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    await accept(a, p.code, v);
    const c = await openTx();
    await addEvent(c, a, p.code, v, { type: 'WITHDRAWN' });
    await finish(c, 'ROLLBACK');
    expect((await eventRows(a, p.code)).map((r) => r.event_seq)).toEqual([1]);
    expect((await withdraw(a, p.code, v)).event_seq).toBe(2);
  });
});

// ====================================================================== H. audit extension
describe('H. audit extension: the two consent actions and the consent event they concern', () => {
  it('lists exactly 37 older and 2 new actions (39)', () => {
    expect(OLD_ACTIONS).toHaveLength(37);
    expect(new Set([...OLD_ACTIONS, ...CONSENT_ACTIONS]).size).toBe(39);
  });

  it('names every one of the 39 actions in the CHECK definition (catalog) and nothing else', async () => {
    expect(vocab(await constraintDef('ck_account_audit_events__action')).sort()).toEqual([...OLD_ACTIONS, ...CONSENT_ACTIONS].sort());
  });

  it.each(CONSENT_ACTIONS)('accepts %s with the event it concerns, and records the purpose code and the sequence in the changes', async (action) => {
    const { a, p, v } = await scene({ withdrawable: true });
    const e = await accept(a, p.code, v);
    const id = await insertAuditRow(a, action, { consent: e.consent_event_id, changes: JSON.stringify({ purposeCode: p.code, eventSeq: 1 }) });
    expect(await q(`SELECT action, consent_event_id, changes FROM ${AUDIT} WHERE audit_event_id = $1`, [id])).toEqual([
      { action, consent_event_id: e.consent_event_id, changes: { purposeCode: p.code, eventSeq: 1 } },
    ]);
  });

  it.each(CONSENT_ACTIONS)('requires a consent event for %s (ck_account_audit_events__consent_event)', async (action) => {
    expect(await constraintOf(insertAuditRow(await makeAccount(), action))).toBe('ck_account_audit_events__consent_event');
  });

  it.each(OLD_ACTIONS)('refuses a consent event on the older action %s (the pairing holds in both directions)', async (action) => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    const refs = await refsFor(a, action);
    expect(await constraintOf(insertAuditRow(a, action, { ...refs, consent: e.consent_event_id }))).toBe('ck_account_audit_events__consent_event');
  });

  it.each([
    'CONSENT_REVOKED',
    'CONSENT_',
    'CONSENT',
    'CONSENTED',
    'consent_accepted',
    'Consent_Accepted',
    'CONSENT_ACCEPTED ',
    ' CONSENT_WITHDRAWN',
    'CONSENTS_ACCEPTED',
    'CONSENT_UPDATED',
    '',
  ])('refuses the unknown action "%s" even with a valid consent event (ck_account_audit_events__action)', async (action) => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    expect(await constraintOf(insertAuditRow(a, action, { consent: e.consent_event_id }))).toBe('ck_account_audit_events__action');
  });

  it('keeps the LIKE pattern literal: an underscore does not match any character (CONSENTXACCEPTED is no consent action)', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    expect(await constraintOf(insertAuditRow(a, 'CONSENTXACCEPTED', { consent: e.consent_event_id }))).toBe('ck_account_audit_events__action');
  });

  it("composite foreign key: refuses a consent action naming the event of ANOTHER account, and an event that does not exist; accepts the account's own", async () => {
    const own = await scene();
    const foreign = await scene();
    const e = await accept(foreign.a, foreign.p.code, foreign.v);
    for (const action of CONSENT_ACTIONS) {
      expect(await constraintOf(insertAuditRow(own.a, action, { consent: e.consent_event_id }))).toBe('fk_account_audit_events__account_consent_event');
      expect(await constraintOf(insertAuditRow(own.a, action, { consent: randomUUID() }))).toBe('fk_account_audit_events__account_consent_event');
    }
    expect(await count(AUDIT, 'consent_event_id = $1', [e.consent_event_id])).toBe(0);
    await insertAuditRow(foreign.a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id });
    expect(await count(AUDIT, 'consent_event_id = $1', [e.consent_event_id])).toBe(1);
  });

  it('refuses a consent action that also carries a session, device, contact or role reference (the other family pairings still hold)', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    expect(await constraintOf(insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id, session: await insertSession(a) }))).toBe(
      'ck_account_audit_events__session',
    );
    expect(await constraintOf(insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id, role: await CUSTOMER() }))).toBe(
      'ck_account_audit_events__role',
    );
  });

  it('writes the audit row and the event in one transaction: a rollback leaves neither', async () => {
    const { a, p, v } = await scene();
    const c = await openTx();
    const e = await addEvent(c, a, p.code, v);
    await insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id }, c);
    await finish(c, 'ROLLBACK');
    expect(await count(EVENTS, 'account_id = $1', [a])).toBe(0);
    expect(await count(AUDIT, 'account_id = $1', [a])).toBe(0);
  });

  it('keeps an event that an audit row names: the foreign key is RESTRICT even when the append-only trigger is bypassed', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    await insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id });
    await expectRule(run(`DELETE FROM ${EVENTS} WHERE consent_event_id = $1`, [e.consent_event_id]), 'ROW_IMMUTABLE');
    await expectForeignKey(
      isolated(noTriggers(EVENTS), `DELETE FROM ${EVENTS} WHERE consent_event_id = $1`, [e.consent_event_id]),
      'fk_account_audit_events__account_consent_event',
    );
  });

  it('keeps the consent audit rows append-only (UPDATE and DELETE refused, ROW_IMMUTABLE)', async () => {
    const { a, p, v } = await scene();
    const e = await accept(a, p.code, v);
    const id = await insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id });
    for (const set of ["actor = 'someone'", 'consent_event_id = NULL', "action = 'CONSENT_WITHDRAWN'", "changes = '{}'::jsonb", "reason = 'edited'"])
      await expectRule(run(`UPDATE ${AUDIT} SET ${set} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
  });

  it('skips the composite key for the older actions (MATCH SIMPLE: consent_event_id NULL) and keeps their other rules', async () => {
    const a = await makeAccount();
    await insertAuditRow(a, 'PROFILE_UPDATED');
    expect(await constraintOf(insertAuditRow(a, 'MFA_ENABLED', { changes: '[1]' }))).toBe('ck_account_audit_events__changes_object');
    expect(await constraintOf(insertAuditRow(a, 'ROLE_GRANTED'))).toBe('ck_account_audit_events__role');
  });
});

// ====================================================================== I. SQL-level concurrency
/** An accept holds its transaction open; a publication-style UPDATE closes the window of the version from another connection. */
interface Closing {
  blocked: boolean;
  a: string;
  p: Purpose;
  v: Ver;
  eventAt: Date;
}
async function acceptThenClose(main: pg.Pool, race: pg.Pool): Promise<Closing> {
  const a = await makeAccount('ACTIVE', main);
  const p = await makePurpose({}, main);
  const v = await makeVersion(p.entryId, {}, main);
  const holder = await main.connect();
  await holder.query('BEGIN');
  let closed = false;
  let closer: Promise<void> = Promise.resolve();
  let blocked = false;
  let eventAt: Date;
  try {
    eventAt = (await addEvent(holder, a, p.code, v)).occurred_at;
    closer = inTxOn(race, (c) =>
      c.query("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = now(), updated_at = now() WHERE version_id = $1", [v.id]),
    ).then(() => {
      closed = true;
    });
    for (let n = 0; n < 60 && !closed; n++) {
      if ((await waitersOn(main)) >= 1) {
        blocked = true;
        break;
      }
      await sleep(20);
    }
    expect(closed && blocked).toBe(false);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  await closer;
  return { blocked, a, p, v, eventAt };
}

describe('I. real concurrency: one winner per history position, the share locks that serialize an accept with a publication, a closure and a retirement', () => {
  it('lets exactly ONE of two writers take a position when the first has not committed: the second waits on the sequence key and then fails with the named unique violation (23505)', async () => {
    const { a, p, v } = await scene();
    const first = await openTx();
    await addEvent(first, a, p.code, v, { seq: 1 });
    const second = rejection(addEvent(racePool, a, p.code, v, { seq: 1 }));
    await lockWaiters(1);
    await finish(first);
    const e = (await second) as PgFailure;
    expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_consent_events__account_purpose_seq' });
    expect((await eventRows(a, p.code)).map((r) => r.event_seq)).toEqual([1]);
  });

  it('does the same for two ACCEPTED events of DIFFERENT versions (two locales, both in force): one wins position 1, the other is refused and the history stays gap-free', async () => {
    const de = await makeLocale('de-DE');
    const a = await makeAccount();
    const p = await makePurpose();
    const en = await makeVersion(p.entryId);
    const deV = await makeVersion(p.entryId, { locale: de });
    const first = await openTx();
    await addEvent(first, a, p.code, en, { seq: 1 });
    const second = rejection(addEvent(racePool, a, p.code, deV, { seq: 1 }));
    await lockWaiters(1);
    await finish(first);
    expect(((await second) as PgFailure).constraint).toBe('uq_consent_events__account_purpose_seq');
    const rows = await eventRows(a, p.code);
    expect(rows.map((r) => [r.event_seq, r.locale])).toEqual([[1, 'en-US']]);
    // the loser retries on the committed state and takes position 2 (another locale is a valid next acceptance)
    expect((await addEvent(racePool, a, p.code, deV)).event_seq).toBe(2);
  });

  it('keeps ONE winner when 24 writers insert the same position at once (repeated with fresh accounts): the others get the unique violation or the sequence rule, nothing else', async () => {
    for (let round = 0; round < 3; round++) {
      const { a, p, v } = await scene();
      const results = await Promise.allSettled(Array.from({ length: 24 }, () => addEvent(racePool, a, p.code, v, { seq: 1 })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        const e = r.reason as PgFailure;
        const ok =
          (e.code === '23505' && e.constraint === 'uq_consent_events__account_purpose_seq') ||
          (e.code === '23000' && e.detail === 'identity_rule:CONSENT_SEQUENCE');
        expect(ok, `${e.code} ${e.constraint ?? ''} ${e.detail ?? ''}`).toBe(true);
      }
      expect((await eventRows(a, p.code)).map((r) => r.event_seq)).toEqual([1]);
    }
  });

  it('records ONE acceptance when 24 writers accept the same version with the next-position subselect (the others see a duplicate, a taken position or the sequence rule)', async () => {
    const { a, p, v } = await scene();
    const results = await Promise.allSettled(Array.from({ length: 24 }, () => addEvent(racePool, a, p.code, v)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      const e = r.reason as PgFailure;
      const ok =
        (e.code === '23505' && e.constraint === 'uq_consent_events__account_purpose_seq') ||
        (e.code === '23000' && ['identity_rule:CONSENT_SEQUENCE', 'identity_rule:CONSENT_DUPLICATE'].includes(e.detail ?? ''));
      expect(ok, `${e.code} ${e.constraint ?? ''} ${e.detail ?? ''}`).toBe(true);
    }
    expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
  });

  it('keeps the history gap-free when 12 accept/withdraw writers race on one withdrawable purpose: the sequence is 1..n and the types follow the rules', async () => {
    const { a, p, v } = await scene({ withdrawable: true });
    await accept(a, p.code, v);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => addEvent(racePool, a, p.code, v, { type: i % 2 === 0 ? 'WITHDRAWN' : 'ACCEPTED' })),
    );
    const won = results.filter((r) => r.status === 'fulfilled').length;
    expect(won).toBeGreaterThanOrEqual(1);
    const rows = await eventRows(a, p.code);
    expect(rows.map((r) => r.event_seq)).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    expect(rows).toHaveLength(won + 1);
    for (let n = 1; n < rows.length; n++) expect(rows[n]!.event_type, `position ${n + 1}`).not.toBe(rows[n - 1]!.event_type);
  });

  it('never blocks different accounts on each other: 24 accounts accept the same version at once and each gets position 1', async () => {
    const p = await makePurpose();
    const v = await makeVersion(p.entryId);
    const accounts = await Promise.all(Array.from({ length: 24 }, () => makeAccount()));
    const rows = await Promise.all(accounts.map((a) => addEvent(racePool, a, p.code, v)));
    expect(rows.map((r) => r.event_seq)).toEqual(Array(24).fill(1));
    expect(await count(EVENTS, 'purpose_code = $1', [p.code])).toBe(24);
  });

  describe('the version row is read FOR SHARE: an accept serializes with the publication that closes its window', () => {
    it('blocks the window-closing UPDATE until the accepting transaction commits; the accept is a valid historical fact recorded before the window closed', async () => {
      const r = await acceptThenClose(pool, racePool);
      expect(r.blocked).toBe(true);
      const row = (await q<{ status: string; effective_to: Date }>('SELECT status, effective_to FROM content.versions WHERE version_id = $1', [r.v.id]))[0]!;
      expect(row.status).toBe('SUPERSEDED');
      // JavaScript dates hold milliseconds and the two instants (microseconds in PostgreSQL) can fall in the same one
      expect(r.eventAt.getTime()).toBeLessThanOrEqual(row.effective_to.getTime());
      expect((await eventRows(r.a, r.p.code)).map((e) => e.event_seq)).toEqual([1]);
      // after the closure the same version is refused
      await expectRule(accept(await makeAccount(), r.p.code, r.v), 'CONSENT_VERSION_NOT_CURRENT');
    });

    it('MUTATION CHECK: with the FOR SHARE lock removed from the guard in a scratch database the same interleaving does NOT block (the test above would fail)', async () => {
      const scratch = await createIsolatedDatabase();
      const sp = createTestPool(scratch.url, 6);
      const srace = createTestPool(scratch.url, 6);
      try {
        const def = ((await sp.query("SELECT pg_get_functiondef('identity.guard_consent_events'::regproc) AS d")).rows[0] as { d: string }).d;
        const needle = 'PERFORM 1 FROM content.versions WHERE version_id = NEW.version_id FOR SHARE;';
        expect(def).toContain(needle);
        await sp.query(def.replace(needle, 'PERFORM 1 FROM content.versions WHERE version_id = NEW.version_id;'));
        const r = await acceptThenClose(sp, srace);
        expect(r.blocked).toBe(false);
      } finally {
        await sp.end();
        await srace.end();
        await scratch.drop();
      }
    });

    it('lets the publication win when it commits first: the accept waits for it and is then refused as NOT_CURRENT (the window it closed is seen after the lock wait)', async () => {
      const { a, p, v } = await scene();
      const closing = await openTx();
      await closing.query("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = now(), updated_at = now() WHERE version_id = $1", [v.id]);
      const insert = rejection(addEvent(racePool, a, p.code, v));
      await lockWaiters(1);
      await finish(closing);
      await expectRule(Promise.reject(await insert), 'CONSENT_VERSION_NOT_CURRENT');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(0);
    });

    it('does not block two accepts of the same version on each other (share locks are compatible); they differ only by account', async () => {
      const p = await makePurpose();
      const v = await makeVersion(p.entryId);
      const [a1, a2] = [await makeAccount(), await makeAccount()];
      const t1 = await openTx();
      const t2 = await openTx();
      await addEvent(t1, a1, p.code, v);
      await addEvent(t2, a2, p.code, v);
      expect(await waitersOn(pool)).toBe(0);
      await finish(t1);
      await finish(t2);
    });
  });

  describe('the account row is read FOR SHARE: an accept serializes with the closure of the account', () => {
    const closeIn = async (c: pg.PoolClient, a: string) => {
      await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [a]);
      await c.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(c, a, 'SUSPENDED', 'CLOSED');
    };
    it('blocks an insert while the account is being CLOSED and then refuses it (ACCOUNT_CLOSED)', async () => {
      const a = await accountIn('SUSPENDED');
      const p = await makePurpose();
      const v = await makeVersion(p.entryId);
      const closing = await openTx();
      await closeIn(closing, a);
      const insert = rejection(addEvent(racePool, a, p.code, v));
      await lockWaiters(1);
      await finish(closing);
      const e = (await insert) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(0);
    });
    it('blocks the closure while an insert is in flight; the closure then completes and the event stays (a valid fact of the time before the closure)', async () => {
      const a = await accountIn('SUSPENDED');
      const p = await makePurpose();
      const v = await makeVersion(p.entryId);
      const inserting = await openTx();
      await addEvent(inserting, a, p.code, v);
      const closing = inTxOn(racePool, (c) => closeIn(c, a));
      await lockWaiters(1);
      await finish(inserting);
      await closing;
      expect((await q<{ status: string }>('SELECT status FROM identity.accounts WHERE account_id = $1', [a]))[0]!.status).toBe('CLOSED');
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);
      await expectRule(accept(a, p.code, v, { seq: 2 }), 'ACCOUNT_CLOSED');
    });
  });

  describe('the purpose row is read FOR SHARE: an accept serializes with the retirement of the purpose', () => {
    it('blocks the retirement while an accept is in flight, then retires; and blocks an accept while the retirement is in flight, then refuses it (CONSENT_PURPOSE_INACTIVE)', async () => {
      const { a, p, v } = await scene();
      const inserting = await openTx();
      await addEvent(inserting, a, p.code, v);
      const retiring = inTxOn(racePool, (c) =>
        c.query("UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code = $1", [p.code]),
      );
      await lockWaiters(1);
      await finish(inserting);
      await retiring;
      expect(await count(EVENTS, 'account_id = $1', [a])).toBe(1);

      const second = await scene();
      const retire = await openTx();
      await retire.query("UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code = $1", [second.p.code]);
      const blocked = rejection(addEvent(racePool, second.a, second.p.code, second.v));
      await lockWaiters(1);
      await finish(retire);
      const e = (await blocked) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:CONSENT_PURPOSE_INACTIVE' });
    });
  });

  it('leaves no lock waiter behind after the races above', async () => {
    await noLockWaiters();
  });
});

// ====================================================================== J. seeds (read from a pristine database)
const CONSENT_PARAMS = [
  { key: consentRequiredForKey('TERMS_OF_SERVICE'), type: 'JSON', value: ['CUSTOMER', 'PROVIDER'], assumption: false, prd: 'CU-03' },
  { key: consentReacceptanceKey('TERMS_OF_SERVICE'), type: 'ENUM', value: 'REACCEPT_REQUIRED', assumption: true, prd: '' },
  { key: consentRequiredForKey('PRIVACY_POLICY'), type: 'JSON', value: ['CUSTOMER', 'PROVIDER'], assumption: false, prd: 'CU-03' },
  { key: consentReacceptanceKey('PRIVACY_POLICY'), type: 'ENUM', value: 'REACCEPT_REQUIRED', assumption: true, prd: '' },
];
const parameterId = async (key: string): Promise<string> =>
  (await sq<{ parameter_id: string }>('SELECT parameter_id FROM configuration.parameters WHERE key = $1', [key]))[0]!.parameter_id;

describe('J1. seeded legal document shells and consent purposes', () => {
  it('seeds exactly two LEGAL entries, with the exact governance policy of the content CHECKs, created by the migration', async () => {
    const rows = await sq(
      `SELECT key, content_type, owner_role, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, is_active, created_by, description
         FROM content.entries WHERE content_type = 'LEGAL' ORDER BY key COLLATE "C"`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as { key: string }).key)).toEqual([LEGAL_ENTRY_KEYS.PRIVACY_POLICY, LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE]);
    for (const r of rows as Record<string, unknown>[]) {
      expect(r).toMatchObject({
        content_type: 'LEGAL',
        owner_role: 'LEGAL',
        sensitivity: 'PUBLIC',
        criticality: 'CRITICAL',
        approval_policy: 'SECOND_APPROVER',
        fallback_policy: 'EXACT',
        max_scope_type: 'PLATFORM',
        is_active: true,
        created_by: 'system:migration',
      });
      expect(String(r.description).length).toBeGreaterThan(20);
    }
  });

  it('seeds the shells WITHOUT any version, variable, snapshot or text: nothing can be accepted until Legal publishes through the content workflow', async () => {
    expect(
      await sq("SELECT count(*)::int AS n FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.content_type = 'LEGAL'"),
    ).toEqual([{ n: 0 }]);
    expect(
      await sq("SELECT count(*)::int AS n FROM content.entry_variables x JOIN content.entries e ON e.entry_id = x.entry_id WHERE e.content_type = 'LEGAL'"),
    ).toEqual([{ n: 0 }]);
    expect(
      await sq("SELECT count(*)::int AS n FROM content.snapshot_items i JOIN content.entries e ON e.entry_id = i.entry_id WHERE e.content_type = 'LEGAL'"),
    ).toEqual([{ n: 0 }]);
    expect(await sq("SELECT count(*)::int AS n FROM content.entries WHERE key LIKE 'legal.%'")).toEqual([{ n: 2 }]);
  });

  it('writes the ENTRY_CREATED audit row of each shell exactly as the content service does (one row, no version, actor system:migration, correlation seed-0013)', async () => {
    const rows = await sq(
      `SELECT e.key, a.action, a.actor, a.correlation_id, a.version_id, a.previous_version_id, a.locale, a.reason
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE e.content_type = 'LEGAL' ORDER BY e.key COLLATE "C", a.occurred_at`,
    );
    expect(rows).toEqual(
      [LEGAL_ENTRY_KEYS.PRIVACY_POLICY, LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE].map((key) => ({
        key,
        action: 'ENTRY_CREATED',
        actor: 'system:migration',
        correlation_id: 'seed-0013',
        version_id: null,
        previous_version_id: null,
        locale: null,
        reason: expect.stringMatching(/Legal publishes the first versions through the content workflow/),
      })),
    );
  });

  it('seeds exactly two ACTIVE, NOT_WITHDRAWABLE purposes bound to the two shells (one purpose per document), and no event', async () => {
    expect(
      await sq(
        `SELECT p.purpose_code, e.key, p.withdrawal_policy, p.status, p.created_at = p.updated_at AS same, p.created_at <= now() AS past FROM identity.consent_purposes p
           JOIN content.entries e ON e.entry_id = p.document_entry_id ORDER BY p.purpose_code`,
      ),
    ).toEqual([
      { purpose_code: 'PRIVACY_POLICY', key: 'legal.privacy_policy', withdrawal_policy: 'NOT_WITHDRAWABLE', status: 'ACTIVE', same: true, past: true },
      { purpose_code: 'TERMS_OF_SERVICE', key: 'legal.terms_of_service', withdrawal_policy: 'NOT_WITHDRAWABLE', status: 'ACTIVE', same: true, past: true },
    ]);
    expect([...SEEDED_CONSENT_PURPOSES].sort()).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE']);
    expect(await sq('SELECT count(*)::int AS n FROM identity.consent_events')).toEqual([{ n: 0 }]);
    expect(await sq("SELECT count(*)::int AS n FROM identity.account_audit_events WHERE action LIKE 'CONSENT\\_%'")).toEqual([{ n: 0 }]);
  });

  it('starts with no account, no outbox event of the consent family and no other new row beyond the seeds', async () => {
    expect(await sq('SELECT count(*)::int AS n FROM identity.accounts')).toEqual([{ n: 0 }]);
    expect(await sq("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.consent%'")).toEqual([{ n: 0 }]);
  });

  it('refuses to change a seeded purpose (code, document, policy) and to delete it; the seeded rows are untouched afterwards', async () => {
    const before = JSON.stringify(await sq('SELECT * FROM identity.consent_purposes ORDER BY purpose_code'));
    await expectRule(
      seedPool.query("UPDATE identity.consent_purposes SET withdrawal_policy = 'WITHDRAWABLE' WHERE purpose_code = 'TERMS_OF_SERVICE'"),
      'CONSENT_PURPOSE_IMMUTABLE',
    );
    await expectRule(
      seedPool.query("UPDATE identity.consent_purposes SET purpose_code = 'X_TERMS' WHERE purpose_code = 'TERMS_OF_SERVICE'"),
      'CONSENT_PURPOSE_IMMUTABLE',
    );
    await expectRule(seedPool.query("DELETE FROM identity.consent_purposes WHERE purpose_code = 'PRIVACY_POLICY'"), 'NOT_DELETABLE');
    expect(JSON.stringify(await sq('SELECT * FROM identity.consent_purposes ORDER BY purpose_code'))).toBe(before);
  });

  it('refuses to edit or deactivate-and-redefine a seeded shell (entry identity and policy are immutable) and to delete it', async () => {
    await expect(seedPool.query("UPDATE content.entries SET content_type = 'PLAIN_TEXT' WHERE key = 'legal.terms_of_service'")).rejects.toMatchObject({
      code: '23000',
    });
    await expect(seedPool.query("DELETE FROM content.entries WHERE key = 'legal.privacy_policy'")).rejects.toMatchObject({ code: '23000' });
  });
});

describe('J2. seeded configuration: the four consent policy parameters', () => {
  const reasonOf = async (key: string): Promise<string> =>
    (
      await sq<{ reason: string }>(
        `SELECT v.reason FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
           JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = $1`,
        [key],
      )
    )[0]!.reason;

  it('seeds exactly the four consent.* parameters (a required_for and a reacceptance per seeded purpose) and no other', async () => {
    const rows = await sq<{ key: string }>('SELECT key FROM configuration.parameters WHERE key LIKE \'consent.%\' ORDER BY key COLLATE "C"');
    expect(rows.map((r) => r.key)).toEqual(CONSENT_PARAMS.map((p) => p.key).sort());
    expect(CONSENT_PARAMS.map((p) => p.key).sort()).toEqual([
      'consent.privacy_policy.reacceptance',
      'consent.privacy_policy.required_for',
      'consent.terms_of_service.reacceptance',
      'consent.terms_of_service.required_for',
    ]);
    // 28 of 0010 to 0013 plus the five provider.registration.* parameters of 0018 (asserted in provider-model.itest.ts)
    expect(await sq('SELECT count(*)::int AS n FROM configuration.parameters')).toEqual([{ n: 33 }]);
    expect(await sq("SELECT count(*)::int AS n FROM configuration.parameters WHERE key NOT LIKE 'provider.registration.%'")).toEqual([{ n: 28 }]);
  });

  it.each(CONSENT_PARAMS)(
    'defines $key ($type) as a required, active, CRITICAL INTERNAL parameter owned by legal with a SECOND_APPROVER policy',
    async ({ key, type }) => {
      expect(
        await sq(
          'SELECT data_type, unit, owner_role, approval_policy, criticality, sensitivity, is_required, is_active, created_by FROM configuration.parameters WHERE key = $1',
          [key],
        ),
      ).toEqual([
        {
          data_type: type,
          unit: null,
          owner_role: 'legal',
          approval_policy: 'SECOND_APPROVER',
          criticality: 'CRITICAL',
          sensitivity: 'INTERNAL',
          is_required: true,
          is_active: true,
          created_by: 'system:migration',
        },
      ]);
    },
  );

  it.each(CONSENT_PARAMS)('allows the scopes PLATFORM, COUNTRY and MARKET for $key (the consent law differs by region)', async ({ key }) => {
    expect(
      (
        await sq<{ scope_type: string }>(
          'SELECT s.scope_type FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id WHERE p.key = $1 ORDER BY s.scope_type',
          [key],
        )
      ).map((r) => r.scope_type),
    ).toEqual(['COUNTRY', 'MARKET', 'PLATFORM']);
  });

  it('declares the validation rules: a unique, bounded array of role-code strings for required_for, and exactly the three reacceptance modes of the contract for reacceptance', async () => {
    for (const code of SEEDED_CONSENT_PURPOSES) {
      expect(await sq('SELECT validation_rules FROM configuration.parameters WHERE key = $1', [consentRequiredForKey(code)])).toEqual([
        { validation_rules: { schema: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,29}$' }, uniqueItems: true, maxItems: 10 } } },
      ]);
      expect(await sq('SELECT validation_rules FROM configuration.parameters WHERE key = $1', [consentReacceptanceKey(code)])).toEqual([
        { validation_rules: { enum: [...REACCEPTANCE_MODES] } },
      ]);
    }
  });

  it.each(CONSENT_PARAMS)('holds one PLATFORM value version 1 for $key, effective now and open-ended, created by the migration', async ({ key, value }) => {
    expect(
      await sq(
        `SELECT h.scope_type, h.scope_ref, v.version, v.value, v.effective_from <= now() AS started, v.effective_to, v.created_by
           FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
           JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE p.key = $1`,
        [key],
      ),
    ).toEqual([{ scope_type: 'PLATFORM', scope_ref: null, version: 1, value, started: true, effective_to: null, created_by: 'system:migration' }]);
  });

  it('seeds values that satisfy their own rules and name roles that exist: required_for lists CUSTOMER and PROVIDER (PRD CU-03, PR-01), reacceptance is a known mode', async () => {
    const roles = (await sq<{ code: string }>('SELECT code FROM identity.roles')).map((r) => r.code);
    for (const p of CONSENT_PARAMS) {
      const stored = (
        await sq<{ value: unknown }>(
          'SELECT v.value FROM configuration.parameters x JOIN configuration.parameter_values h ON h.parameter_id = x.parameter_id JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE x.key = $1',
          [p.key],
        )
      )[0]!.value;
      if (p.type === 'JSON') {
        const list = stored as string[];
        expect(new Set(list).size).toBe(list.length);
        expect(list.length).toBeLessThanOrEqual(10);
        for (const role of list) {
          expect(role).toMatch(/^[A-Z][A-Z0-9_]{1,29}$/);
          expect(roles, role).toContain(role);
        }
        expect(list).toEqual(['CUSTOMER', 'PROVIDER']);
      } else {
        expect(REACCEPTANCE_MODES as readonly string[]).toContain(stored);
        expect(stored).toBe('REACCEPT_REQUIRED');
      }
    }
  });

  it('flags the two reacceptance defaults as an ENGINEERING ASSUMPTION not in the PRD (version reason and description), and cites the PRD for required_for', async () => {
    for (const p of CONSENT_PARAMS) {
      const reason = await reasonOf(p.key);
      expect(reason, p.key).toMatch(/^Initial value \(migration 0013\): /);
      if (p.assumption) {
        expect(reason, p.key).toMatch(/engineering assumption, not in the PRD/);
        expect(reason, p.key).toMatch(/confirmed by the legal owner/);
      } else {
        expect(reason, p.key).toMatch(/PRD CU-03 sign-up consent and PR-01 provider sign-up/);
        expect(reason, p.key).not.toMatch(/assumption/);
      }
    }
    expect(CONSENT_PARAMS.filter((p) => p.assumption).map((p) => p.key)).toEqual([
      consentReacceptanceKey('TERMS_OF_SERVICE'),
      consentReacceptanceKey('PRIVACY_POLICY'),
    ]);
  });

  it('describes each parameter in words a legal owner can act on (the roles, the three modes), without hardcoding a business value in a column', async () => {
    const d = Object.fromEntries(
      (await sq<{ key: string; description: string }>("SELECT key, description FROM configuration.parameters WHERE key LIKE 'consent.%'")).map((r) => [
        r.key,
        r.description,
      ]),
    );
    expect(d[consentRequiredForKey('TERMS_OF_SERVICE')]).toMatch(/Terms of Service/);
    expect(d[consentRequiredForKey('PRIVACY_POLICY')]).toMatch(/Privacy Policy/);
    for (const code of SEEDED_CONSENT_PURPOSES)
      for (const mode of REACCEPTANCE_MODES) expect(d[consentReacceptanceKey(code)], `${code} ${mode}`).toContain(mode);
  });

  it.each(CONSENT_PARAMS)(
    'records exactly one ACTIVE change request for $key, published as its value version, approved by a second person',
    async ({ key, value }) => {
      expect(
        await sq(
          `SELECT r.state, r.scope_type, r.scope_ref, r.proposed_value, r.effective_to, r.requested_by, r.approval_policy, r.value_version_id = v.version_id AS linked, v.value AS version_value,
                (SELECT array_agg(a.approver || ':' || a.decision) FROM configuration.change_approvals a WHERE a.change_request_id = r.change_request_id) AS approvals
           FROM configuration.change_requests r LEFT JOIN configuration.value_versions v ON v.version_id = r.value_version_id WHERE r.parameter_id = $1`,
          [await parameterId(key)],
        ),
      ).toEqual([
        {
          state: 'ACTIVE',
          scope_type: 'PLATFORM',
          scope_ref: null,
          proposed_value: value,
          effective_to: null,
          requested_by: 'system:migration',
          approval_policy: 'SECOND_APPROVER',
          linked: true,
          version_value: value,
          approvals: ['system:migration-review:APPROVE'],
        },
      ]);
    },
  );

  it.each(CONSENT_PARAMS)(
    'writes the six-step audit trail of $key exactly like the real workflow, in order, under the correlation seed-0013',
    async ({ key }) => {
      const rows = await sq<{ action: string; actor: string; correlation_id: string }>(
        'SELECT action, actor, correlation_id FROM configuration.audit_events WHERE parameter_id = $1 ORDER BY occurred_at',
        [await parameterId(key)],
      );
      expect(rows.map((r) => r.action)).toEqual([
        'PARAMETER_CREATED',
        'CHANGE_DRAFTED',
        'CHANGE_SUBMITTED',
        'CHANGE_APPROVED',
        'CHANGE_PUBLISHED',
        'CHANGE_ACTIVATED',
      ]);
      expect(rows.map((r) => r.actor)).toEqual([
        'system:migration',
        'system:migration',
        'system:migration',
        'system:migration-review',
        'system:migration',
        'system:migration',
      ]);
      for (const r of rows) expect(r.correlation_id).toBe('seed-0013');
    },
  );

  it('resolves exactly one effective version per parameter at the database clock (the no-overlap rule)', async () => {
    const rows = await sq<{ key: string; n: number }>(
      `SELECT p.key, count(*)::int AS n FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
         JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
        WHERE p.key LIKE 'consent.%' AND v.effective_from <= now() AND (v.effective_to IS NULL OR v.effective_to > now()) GROUP BY p.key`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.n, r.key).toBe(1);
  });

  it('refuses to change or delete a seeded value version (corrections create a new version) and to rename or delete the definition', async () => {
    const id = await parameterId(consentRequiredForKey('TERMS_OF_SERVICE'));
    const version = (
      await sq<{ version_id: string }>(
        'SELECT v.version_id FROM configuration.parameter_values h JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id WHERE h.parameter_id = $1',
        [id],
      )
    )[0]!.version_id;
    await expect(seedPool.query(`UPDATE configuration.value_versions SET value = '[]'::jsonb WHERE version_id = $1`, [version])).rejects.toMatchObject({
      code: '23000',
    });
    await expect(seedPool.query('DELETE FROM configuration.value_versions WHERE version_id = $1', [version])).rejects.toMatchObject({ code: '23000' });
    await expect(seedPool.query("UPDATE configuration.parameters SET key = 'consent.other' WHERE parameter_id = $1", [id])).rejects.toMatchObject({
      code: '23000',
    });
    await expect(seedPool.query('DELETE FROM configuration.parameters WHERE parameter_id = $1', [id])).rejects.toMatchObject({ code: '23000' });
  });

  it('leaves the 24 older parameters untouched (8 email, 10 phone, 6 session/security/reset)', async () => {
    expect(await sq("SELECT count(*)::int AS n FROM configuration.parameters WHERE key LIKE 'verification.email.%'")).toEqual([{ n: 8 }]);
    expect(await sq("SELECT count(*)::int AS n FROM configuration.parameters WHERE key LIKE 'verification.phone.%'")).toEqual([{ n: 10 }]);
    expect(
      await sq("SELECT count(*)::int AS n FROM configuration.parameters WHERE key LIKE 'session.%' OR key LIKE 'security.%' OR key LIKE 'reset_link.%'"),
    ).toEqual([{ n: 6 }]);
  });
});

// ====================================================================== J3. seeded content: the consent screen copy (40 entries)
const COPY_TYPES: [key: string, type: 'UI_LABEL' | 'PLAIN_TEXT'][] = [
  ['title', 'UI_LABEL'],
  ['intro', 'PLAIN_TEXT'],
  ['requirements.title', 'UI_LABEL'],
  ['requirements.all_done', 'PLAIN_TEXT'],
  ['requirements.outstanding_intro', 'PLAIN_TEXT'],
  ['history.title', 'UI_LABEL'],
  ['history.empty', 'PLAIN_TEXT'],
  ['document.unavailable_note', 'PLAIN_TEXT'],
  ['document.read', 'UI_LABEL'],
  ['document.version', 'PLAIN_TEXT'],
  ['document.locale', 'PLAIN_TEXT'],
  ['action.accept', 'UI_LABEL'],
  ['action.withdraw', 'UI_LABEL'],
  ['accepted_on', 'PLAIN_TEXT'],
  ['purpose.terms_of_service', 'UI_LABEL'],
  ['purpose.privacy_policy', 'UI_LABEL'],
  ...CONSENT_REQUIREMENT_STATUSES.map((s): [string, 'UI_LABEL'] => [`status.${s.toLowerCase()}`, 'UI_LABEL']),
  ...CONSENT_ACCEPTANCE_STATES.map((s): [string, 'UI_LABEL'] => [`state.${s.toLowerCase()}`, 'UI_LABEL']),
  ...CONSENT_EVENT_TYPES.map((s): [string, 'UI_LABEL'] => [`event.${s.toLowerCase()}`, 'UI_LABEL']),
  ['notice.accepted', 'PLAIN_TEXT'],
  ['notice.withdrawn', 'PLAIN_TEXT'],
  ['notice.already_accepted', 'PLAIN_TEXT'],
  ...CONSENT_ERROR_CODES.map((c): [string, 'PLAIN_TEXT'] => [consentErrorMessageKey(c).replace('account.consent.', ''), 'PLAIN_TEXT']),
  ['error.unavailable', 'PLAIN_TEXT'],
];
const CONSENT_COPY = COPY_TYPES.map(([k, t]): [string, string] => [`account.consent.${k}`, t]);
const COPY_FILTER = "e.key LIKE 'account.consent.%'";
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
/** The keys the web needs, computed from the contract helpers (a missing label fails the test). */
const REQUIRED_BY_CONTRACTS: string[] = [
  ...SEEDED_CONSENT_PURPOSES.map((c) => consentPurposeLabelKey(c)),
  ...CONSENT_REQUIREMENT_STATUSES.map((s) => consentStatusLabelKey(s)),
  ...CONSENT_ACCEPTANCE_STATES.map((s) => consentStateLabelKey(s)),
  ...CONSENT_EVENT_TYPES.map((t) => consentEventLabelKey(t)),
  ...CONSENT_ERROR_CODES.map((c) => consentErrorMessageKey(c)),
];
const REQUIRED_BY_SPEC: string[] = [
  ...[
    'title',
    'intro',
    'requirements.title',
    'requirements.all_done',
    'requirements.outstanding_intro',
    'history.title',
    'history.empty',
    'document.unavailable_note',
    'document.read',
    'document.version',
    'document.locale',
    'action.accept',
    'action.withdraw',
    'accepted_on',
    'notice.accepted',
    'notice.withdrawn',
    'notice.already_accepted',
    // any failure that is not one of the consent error codes (service unavailable, unexpected error)
    'error.unavailable',
  ].map((k) => `account.consent.${k}`),
];
const copyEntries = async (): Promise<{ entry_id: string; key: string; content_type: string }[]> =>
  sq(`SELECT e.entry_id, e.key, e.content_type FROM content.entries e WHERE ${COPY_FILTER} ORDER BY e.key COLLATE "C"`);
const copyBodies = async (): Promise<{ key: string; content_type: string; body: string }[]> =>
  sq(
    `SELECT e.key, e.content_type, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER} ORDER BY e.key COLLATE "C"`,
  );
const bodyOf = async (key: string): Promise<string> =>
  (await sq<{ body: string }>('SELECT v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = $1', [key]))[0]!.body;

describe('J3. seeded content: the consent screen copy (40 entries, no legal text)', () => {
  it('seeds exactly 40 account.consent.* entries, each key once', async () => {
    const rows = await copyEntries();
    expect(rows).toHaveLength(40);
    expect(CONSENT_COPY).toHaveLength(40);
    expect(new Set(CONSENT_COPY.map(([k]) => k)).size).toBe(40);
    expect(rows.map((r) => r.key)).toEqual(CONSENT_COPY.map(([k]) => k).sort(cmp));
  });

  it('gives each entry its content type (UI_LABEL for titles, buttons and labels: 18; PLAIN_TEXT for sentences: 22) and never a LEGAL type', async () => {
    const rows = await copyEntries();
    expect(Object.fromEntries(rows.map((r) => [r.key, r.content_type]))).toEqual(Object.fromEntries(CONSENT_COPY));
    const types = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.content_type]: (acc[r.content_type] ?? 0) + 1 }), {});
    expect(types).toEqual({ UI_LABEL: 18, PLAIN_TEXT: 22 });
  });

  it('seeds every entry as PUBLIC, STANDARD, owned by CONTENT, approval NONE, CHAIN fallback, PLATFORM maximum scope, active', async () => {
    expect(
      await sq(
        `SELECT DISTINCT sensitivity, criticality, owner_role, approval_policy, fallback_policy, max_scope_type, is_active, created_by FROM content.entries e WHERE ${COPY_FILTER}`,
      ),
    ).toEqual([
      {
        sensitivity: 'PUBLIC',
        criticality: 'STANDARD',
        owner_role: 'CONTENT',
        approval_policy: 'NONE',
        fallback_policy: 'CHAIN',
        max_scope_type: 'PLATFORM',
        is_active: true,
        created_by: 'system:migration',
      },
    ]);
  });

  it('gives every entry exactly one en-US PLATFORM version 1, PUBLISHED, effective now and open-ended', async () => {
    const rows = await sq(
      `SELECT e.key, count(*)::int AS versions, bool_and(v.locale = 'en-US') AS en_us, bool_and(v.scope_type = 'PLATFORM' AND v.scope_ref IS NULL) AS platform,
              bool_and(v.version = 1) AS v1, bool_and(v.status = 'PUBLISHED') AS published, bool_and(v.effective_from <= now()) AS started,
              bool_and(v.effective_to IS NULL) AS open_ended, bool_and(v.approval_policy = 'NONE') AS no_approval
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(40);
    for (const r of rows)
      expect(r, (r as { key: string }).key).toMatchObject({
        versions: 1,
        en_us: true,
        platform: true,
        v1: true,
        published: true,
        started: true,
        open_ended: true,
        no_approval: true,
      });
  });

  it('records each body hash as the SHA-256 of its text (computed by the database, never trusted from the seed)', async () => {
    const rows = await sq<{ key: string; body: string; body_sha256: string }>(
      `SELECT e.key, v.body, v.body_sha256 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER}`,
    );
    expect(rows).toHaveLength(40);
    for (const r of rows) expect(r.body_sha256, r.key).toBe(sha256(r.body));
  });

  it('writes the content audit trail of every entry: ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED, under seed-0013', async () => {
    const rows = await sq<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at) AS actions, array_agg(DISTINCT a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE ${COPY_FILTER} GROUP BY e.key`,
    );
    expect(rows).toHaveLength(40);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.actors).toEqual(['system:migration']);
      expect(r.correlations).toEqual(['seed-0013']);
    }
  });

  it('declares exactly the typed variables of the three strings that carry one (version COUNT, locale STRING, date STRING; required, no personal data) and none on any other entry', async () => {
    const rows = await sq<{ key: string; name: string; var_type: string; pii_class: string; is_required: boolean; example_value: unknown }>(
      `SELECT e.key, x.name, x.var_type, x.pii_class, x.is_required, x.example_value FROM content.entries e JOIN content.entry_variables x ON x.entry_id = e.entry_id
        WHERE ${COPY_FILTER} ORDER BY e.key, x.name`,
    );
    const grouped: Record<string, [string, string, string][]> = {};
    for (const r of rows) (grouped[r.key] ??= []).push([r.name, r.var_type, r.pii_class]);
    expect(grouped).toEqual({
      'account.consent.document.version': [['version', 'COUNT', 'NONE']],
      'account.consent.document.locale': [['locale', 'STRING', 'NONE']],
      'account.consent.accepted_on': [['date', 'STRING', 'NONE']],
    });
    for (const r of rows) expect(r.is_required, `${r.key}.${r.name}`).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.name, typeof r.example_value]))).toEqual({ version: 'number', locale: 'string', date: 'string' });
  });

  it('uses only the placeholders the entry declares, and every declared variable appears in its text', async () => {
    const rows = await sq<{ key: string; body: string; names: string[] | null }>(
      `SELECT e.key, v.body, (SELECT array_agg(x.name ORDER BY x.name) FROM content.entry_variables x WHERE x.entry_id = e.entry_id) AS names
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE ${COPY_FILTER}`,
    );
    for (const r of rows) {
      const used = [...new Set([...r.body.matchAll(/\{([a-z][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();
      expect(used, r.key).toEqual(r.names ?? []);
    }
    expect(await bodyOf('account.consent.document.version')).toBe('Version {version}');
    expect(await bodyOf('account.consent.document.locale')).toBe('Language: {locale}');
    expect(await bodyOf('account.consent.accepted_on')).toBe('Accepted on {date}');
  });

  describe('every key the web needs exists (computed from the contract helpers, so a missing label fails here)', () => {
    it('has a label for every seeded purpose (2), requirement status (5), acceptance state (3) and event type (2)', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const c of SEEDED_CONSENT_PURPOSES) expect(present.has(consentPurposeLabelKey(c)), c).toBe(true);
      for (const s of CONSENT_REQUIREMENT_STATUSES) expect(present.has(consentStatusLabelKey(s)), s).toBe(true);
      for (const s of CONSENT_ACCEPTANCE_STATES) expect(present.has(consentStateLabelKey(s)), s).toBe(true);
      for (const t of CONSENT_EVENT_TYPES) expect(present.has(consentEventLabelKey(t)), t).toBe(true);
      expect(CONSENT_REQUIREMENT_STATUSES).toHaveLength(5);
      expect(CONSENT_ACCEPTANCE_STATES).toHaveLength(3);
    });
    it('has a message for every consent error code (10) and the catch-all error.unavailable: eleven error keys', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const c of CONSENT_ERROR_CODES) expect(present.has(consentErrorMessageKey(c)), c).toBe(true);
      expect(CONSENT_ERROR_CODES).toHaveLength(10);
      expect([...present].filter((k) => k.startsWith('account.consent.error.'))).toHaveLength(11);
      expect(present.has('account.consent.error.unavailable')).toBe(true);
    });
    it('has every key the spec names for the page, the notices and the history', async () => {
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const k of REQUIRED_BY_SPEC) expect(present.has(k), k).toBe(true);
    });
    it('contains nothing but the keys above: every seeded key is required by a contract helper or by the spec (no orphan copy)', async () => {
      const required = new Set([...REQUIRED_BY_CONTRACTS, ...REQUIRED_BY_SPEC]);
      expect((await copyEntries()).map((r) => r.key).filter((k) => !required.has(k))).toEqual([]);
      expect(required.size).toBe(40);
    });
    it('covers every literal key of the /consents page and the session page link (the page asks for key(...) literals; each exists)', async () => {
      const root = path.join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'src', 'app');
      const page = readFileSync(path.join(root, 'consents', 'page.tsx'), 'utf8');
      const session = readFileSync(path.join(root, 'session', 'page.tsx'), 'utf8');
      const literals = [...page.matchAll(/\bkey\('([a-z_.]+)'\)/g)].map((m) => `account.consent.${m[1]!}`);
      literals.push(...[...session.matchAll(/'(account\.consent\.[a-z_.]+)'/g)].map((m) => m[1]!));
      expect(literals.length).toBeGreaterThan(15);
      const present = new Set((await copyEntries()).map((r) => r.key));
      for (const k of new Set(literals)) expect(present.has(k), k).toBe(true);
    });
  });

  it('states plainly that nothing is accepted for the person, and offers the explicit choice (PRD R-13: no pre-ticked acceptance)', async () => {
    const intro = await bodyOf('account.consent.intro');
    expect(intro).toMatch(/Nothing is accepted for you/);
    expect(intro).toMatch(/only when you choose to accept/);
    expect(await bodyOf('account.consent.action.accept')).toBe('Accept');
    expect(await bodyOf('account.consent.action.withdraw')).toBe('Withdraw consent');
  });

  it('keeps the error messages free of numbers, timings, keys and system names (they must not expose an identifier or a limit)', async () => {
    for (const r of (await copyBodies()).filter((x) => /\.error\./.test(x.key))) {
      expect(r.body, r.key).not.toMatch(/\d/);
      expect(r.body, r.key).not.toMatch(/keycloak|valkey|postgres|redis|nats|session id|sid\b|token|jwt|http|hash|sha|[A-Z_]{6,}/);
    }
  });

  it('carries no legal text, link, email address, number, code or token in any seeded text', async () => {
    for (const r of await copyBodies()) {
      expect(r.body, r.key).not.toMatch(/https?:\/\//i);
      expect(r.body, r.key).not.toMatch(/www\./i);
      expect(r.body, r.key).not.toMatch(/@/);
      expect(r.body, r.key).not.toMatch(/\d{4,}/);
      expect(r.body, r.key).not.toMatch(/[A-Za-z0-9_-]{32,}/);
      expect(r.body, r.key).not.toMatch(/\b(hereby|indemnif|liabilit|governing law|arbitration|jurisdiction|warrant(y|ies)|licen[cs]e grant)\b/i);
      expect(r.body.length, r.key).toBeLessThanOrEqual(r.content_type === 'UI_LABEL' ? 40 : 400);
    }
  });

  it('keeps every seeded text non-blank, single-line, free of control characters and without leading or trailing space', async () => {
    for (const r of await copyBodies()) {
      expect(r.body.trim().length, r.key).toBeGreaterThan(0);
      expect(r.body, r.key).toBe(r.body.trim());
      expect(
        [...r.body].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        r.key,
      ).toBe(false);
    }
  });

  it('leaves the older copy untouched (security 86, email 34, phone 33) and adds no entry outside account.consent.* and legal.*', async () => {
    expect(await sq("SELECT count(*)::int AS n FROM content.entries WHERE key LIKE 'account.security.%' OR key LIKE 'account.password_reset.%'")).toEqual([
      { n: 86 },
    ]);
    expect(await sq("SELECT count(*)::int AS n FROM content.entries WHERE key LIKE 'account.email.%'")).toEqual([{ n: 34 }]);
    expect(await sq("SELECT count(*)::int AS n FROM content.entries WHERE key LIKE 'account.phone.%' OR key = 'sms.verification.phone.body'")).toEqual([
      { n: 33 },
    ]);
    // the migration created exactly the 2 shells and the 40 copy entries
    expect(
      await sq("SELECT count(DISTINCT a.entry_id)::int AS n FROM content.audit_events a WHERE a.correlation_id = 'seed-0013' AND a.action = 'ENTRY_CREATED'"),
    ).toEqual([{ n: 42 }]);
  });

  it('refuses to edit or delete a seeded published version (the text is immutable; corrections are new versions)', async () => {
    const version = (
      await sq<{ version_id: string }>(
        "SELECT v.version_id FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = 'account.consent.action.accept'",
      )
    )[0]!.version_id;
    await expect(seedPool.query("UPDATE content.versions SET body = 'Agree' WHERE version_id = $1", [version])).rejects.toMatchObject({ code: '23000' });
    await expect(seedPool.query('DELETE FROM content.versions WHERE version_id = $1', [version])).rejects.toMatchObject({ code: '23000' });
  });
});

// ====================================================================== K. privacy shape
const NEW_TABLES = ['consent_purposes', 'consent_events'];
describe('K. privacy shape: nothing in the consent tables or their audit rows can hold legal text, an IP address, a user agent, a token or a client timestamp', () => {
  const columnsWithTypes = async (tables: string[]): Promise<{ table_name: string; column_name: string; data_type: string }[]> =>
    q(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = ANY($1) ORDER BY table_name, ordinal_position",
      [tables],
    );

  it('has no column on the new tables named like legal text, an address, location, agent, token, secret, credential, cookie, password, email, phone or client time', async () => {
    const forbidden =
      /(^|_)(body|text|content|document_text|title|html|markdown|markup|clause|terms_text|legal|ip|ipv4|ipv6|addr|address|host|hostname|geo|lat|lng|city|region|country|location|agent|ua|useragent|user_agent|header|referer|referrer|fingerprint|token|jwt|secret|otp|totp|pin|passw|password|credential|cookie|key|salt|plain|raw|link|url|email|phone|mobile|name|subject|sub|sid|claims?|client|device|timezone|tz)(_|$)/i;
    // body_sha256 is the hash of the text, not the text (its type, length CHECK and pattern are tested in A and C)
    const offenders = (await columnsWithTypes(NEW_TABLES))
      .filter((c) => c.column_name !== 'body_sha256' && forbidden.test(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(offenders).toEqual([]);
  });

  it('holds only identifiers, a hash, a locale tag, closed vocabularies, a sequence number and database timestamps: the only types are uuid, text, integer and timestamptz', async () => {
    const cols = await columnsWithTypes(NEW_TABLES);
    expect([...new Set(cols.map((c) => c.data_type))].sort()).toEqual(['integer', 'text', 'timestamp with time zone', 'uuid']);
    expect(cols.filter((c) => c.data_type === 'timestamp with time zone').map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'consent_events.occurred_at',
      'consent_purposes.created_at',
      'consent_purposes.updated_at',
    ]);
  });

  it('bounds every text column: by a vocabulary or pattern CHECK, or by a foreign key (the locale is the locale of an existing version; the id is a CHECKed 1..200 correlation id)', async () => {
    const textCols = (await columnsWithTypes(NEW_TABLES)).filter((c) => c.data_type === 'text').map((c) => `${c.table_name}.${c.column_name}`);
    expect(textCols.sort()).toEqual([
      'consent_events.body_sha256',
      'consent_events.correlation_id',
      'consent_events.event_type',
      'consent_events.locale',
      'consent_events.purpose_code',
      'consent_events.source',
      'consent_purposes.purpose_code',
      'consent_purposes.status',
      'consent_purposes.withdrawal_policy',
    ]);
    for (const col of textCols) {
      const [table, column] = col.split('.') as [string, string];
      const checks = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ('identity.' || $1)::regclass AND contype IN ('c', 'f') AND pg_get_constraintdef(oid) ~ ('\\m' || $2 || '\\M')`,
        [table, column],
      );
      expect(checks.length, col).toBeGreaterThan(0);
    }
  });

  it('adds no JSON, array, binary or network column anywhere in the identity schema except the audit "changes" object that already existed', async () => {
    const rows = await q<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'identity' AND data_type IN ('json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr', 'ARRAY', 'USER-DEFINED') ORDER BY 1, 2",
    );
    expect(rows).toEqual([{ table_name: 'account_audit_events', column_name: 'changes' }]);
  });

  it('keeps the legal TEXT only in content.versions: no table of the identity schema has a text column that could hold a document (no column of the new tables is unbounded free text)', async () => {
    const unbounded = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = ANY($1) AND data_type = 'text' AND character_maximum_length IS NULL
         AND column_name IN ('body', 'text', 'content', 'document', 'excerpt', 'summary')`,
      [NEW_TABLES],
    );
    expect(unbounded).toEqual([]);
  });

  it('stores a realistic acceptance without a trace of the document text, a client address, an agent, a token or the typed claims: a full dump holds the id, the locale and the hash only', async () => {
    const marker = `LEGALBODYMARK-${randomUUID()}`;
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    const ip = '203.0.113.77';
    const token = `eyJ${randomBytes(24).toString('base64url')}.${randomBytes(24).toString('base64url')}`;
    const a = await makeAccount();
    const p = await makePurpose({ withdrawable: true });
    const v = await makeVersion(p.entryId, { body: `${marker} the full text of the agreement ${userAgent} ${ip}` });
    const s = await insertSession(a);
    const e = await accept(a, p.code, v, { session: s, correlation: 'req-1' });
    await insertAuditRow(a, 'CONSENT_ACCEPTED', { consent: e.consent_event_id, changes: JSON.stringify({ purposeCode: p.code, eventSeq: 1 }) });
    const w = await withdraw(a, p.code, v);
    await insertAuditRow(a, 'CONSENT_WITHDRAWN', { consent: w.consent_event_id, changes: JSON.stringify({ purposeCode: p.code, eventSeq: 2 }) });
    const dump = JSON.stringify({
      events: await q(`SELECT * FROM ${EVENTS} WHERE account_id = $1`, [a]),
      audit: await q(`SELECT * FROM ${AUDIT} WHERE account_id = $1`, [a]),
      purposes: await q('SELECT * FROM identity.consent_purposes WHERE purpose_code = $1', [p.code]),
      account: await q('SELECT * FROM identity.accounts WHERE account_id = $1', [a]),
    });
    for (const needle of [marker, 'full text of the agreement', userAgent, 'Mozilla', ip, token]) expect(dump).not.toContain(needle);
    expect(dump).toContain(v.hash);
    expect(dump).toContain(v.id);
    // the text is reachable only through the version row the event points to
    expect(
      (
        await q<{ body: string }>(
          'SELECT v.body FROM content.versions v JOIN identity.consent_events e ON e.version_id = v.version_id WHERE e.consent_event_id = $1',
          [e.consent_event_id],
        )
      )[0]!.body,
    ).toContain(marker);
  });

  it('holds no client timestamp: occurred_at is the only event time and the guard overwrites what the client sends (tested in E); no other timestamp column exists on the events', async () => {
    expect((await columnsOf('consent_events')).filter(([, t]) => /timestamp/.test(t)).map(([n]) => n)).toEqual(['occurred_at']);
  });

  it('holds no login subject or Keycloak identifier in the consent tables (the account is the only person reference)', async () => {
    const cols = (await columnsWithTypes(NEW_TABLES)).filter((c) => /subject|keycloak|issuer|^sub$/i.test(c.column_name));
    expect(cols).toEqual([]);
  });
});

// ====================================================================== L. data comments (the data dictionary source)
describe('L. data comments: tables, columns, the function and the new constraint are documented in the catalog', () => {
  const constraintComment = async (name: string): Promise<string | null> =>
    (await q<{ c: string | null }>("SELECT obj_description(oid, 'pg_constraint') AS c FROM pg_constraint WHERE conname = $1", [name]))[0]!.c;

  it('documents both new tables', async () => {
    const purposes = await commentOn(PURPOSES);
    expect(purposes).toMatch(/bound to exactly ONE LEGAL document entry/);
    expect(purposes).toMatch(/rows are never deleted/);
    expect(purposes).toMatch(/purpose_code, document_entry_id and withdrawal_policy are immutable/);
    const events = await commentOn(EVENTS);
    expect(events).toMatch(/immutable record/);
    expect(events).toMatch(/Current consent is DERIVED from the latest event/);
    expect(events).toMatch(/NO raw IP address, NO user agent and NO client timestamp/);
    expect(events).toMatch(/Rows are never updated, deleted or truncated/);
    expect(events).toMatch(/without copying a word of it/);
    expect(events).toMatch(/no legal text/);
  });

  it.each([
    [PURPOSES, 'document_entry_id', /one purpose per document/],
    [PURPOSES, 'withdrawal_policy', /Structural/],
    [PURPOSES, 'withdrawal_policy', /Immutable/],
    [PURPOSES, 'status', /ACTIVE \(can be accepted/],
    [EVENTS, 'event_seq', /previous \+ 1/],
    [EVENTS, 'event_type', /ACCEPTED after ACCEPTED must be a different, not older version/],
    [EVENTS, 'version_id', /composite foreign key/],
    [EVENTS, 'locale', /compared exactly, never normalized/],
    [EVENTS, 'body_sha256', /Lower-case hex SHA-256/],
    [EVENTS, 'occurred_at', /DATABASE clock/],
    [EVENTS, 'source', /ACCOUNT_API is the only source/],
    [EVENTS, 'application_session_id', /Never the Keycloak session id/],
    [AUDIT, 'consent_event_id', /composite foreign key \(account_id, consent_event_id\)/],
  ] as [string, string, RegExp][])('documents %s.%s', async (table, column, pattern) => {
    expect(await commentOn(table, column)).toMatch(pattern);
  });

  it('documents the in-force function with its definition (half-open window, the three answers, the workflow-marker rule) and the unique constraint with its purpose', async () => {
    const fn = (await q<{ c: string }>("SELECT obj_description('identity.consent_version_state(uuid, uuid, timestamptz)'::regprocedure, 'pg_proc') AS c"))[0]!
      .c;
    expect(fn).toMatch(/THE definition of "in force"/);
    for (const word of ['NOT_FOUND', 'NOT_CURRENT', 'IN_FORCE', 'half-open']) expect(fn, word).toContain(word);
    expect(fn).toMatch(/SCHEDULED, PUBLISHED or SUPERSEDED: these are workflow markers/);
    expect(await constraintComment('uq_versions__version_locale_hash')).toMatch(/target of the composite foreign key \(version_id, locale, body_sha256\)/);
  });

  it('says in the events comment that every table of the family is described: every column that carries a rule has a comment', async () => {
    for (const col of ['event_seq', 'event_type', 'version_id', 'locale', 'body_sha256', 'occurred_at', 'source', 'application_session_id'])
      expect(await commentOn(EVENTS, col), col).toBeTruthy();
    for (const col of ['document_entry_id', 'withdrawal_policy', 'status']) expect(await commentOn(PURPOSES, col), col).toBeTruthy();
  });
});

// ====================================================================== M. the seeded purposes work end to end (own database: the pristine seeds stay untouched)
describe('M. end to end on the seeded purposes: publish a LEGAL version through the real lifecycle, accept it, see the rules', () => {
  it('accepts a published version of the seeded Terms of Service, refuses the Privacy Policy with it, refuses a withdrawal, and records the audit row', async () => {
    const db = await createIsolatedDatabase();
    const p = createTestPool(db.url, 4);
    try {
      const entryId = (await p.query("SELECT entry_id FROM content.entries WHERE key = 'legal.terms_of_service'")).rows[0].entry_id as string;
      const privacyEntry = (await p.query("SELECT entry_id FROM content.entries WHERE key = 'legal.privacy_policy'")).rows[0].entry_id as string;
      const tos = await makeVersion(entryId, {}, p);
      const acc = await makeAccount('ACTIVE', p);
      // before any version: nothing in force
      expect(await stateOf(tos.id, privacyEntry, 'clock_timestamp()', p)).toBe('NOT_FOUND');
      await expectRule(addEvent(p, acc, 'PRIVACY_POLICY', tos), 'CONSENT_VERSION_NOT_FOUND');
      const e = await addEvent(p, acc, 'TERMS_OF_SERVICE', tos);
      expect(e.event_seq).toBe(1);
      await expectRule(addEvent(p, acc, 'TERMS_OF_SERVICE', tos), 'CONSENT_DUPLICATE');
      await expectRule(addEvent(p, acc, 'TERMS_OF_SERVICE', tos, { type: 'WITHDRAWN' }), 'CONSENT_NOT_WITHDRAWABLE');
      await p.query(
        `INSERT INTO identity.account_audit_events (actor, action, account_id, consent_event_id, changes, correlation_id) VALUES ('test', 'CONSENT_ACCEPTED', $1, $2, '{"purposeCode":"TERMS_OF_SERVICE","eventSeq":1}', 'c')`,
        [acc, e.consent_event_id],
      );
      // the Privacy Policy still has no version at all
      expect((await p.query('SELECT count(*)::int AS n FROM content.versions WHERE entry_id = $1', [privacyEntry])).rows[0].n).toBe(0);
      // the seeded version wins over its document: the successor takes over and the old one is refused
      const next = await (async () => {
        await p.query("UPDATE content.versions SET status = 'SUPERSEDED', effective_to = now(), updated_at = now() WHERE version_id = $1", [tos.id]);
        return makeVersion(entryId, { from: 'clock_timestamp()', number: tos.number + 1 }, p);
      })();
      expect((await addEvent(p, acc, 'TERMS_OF_SERVICE', next)).event_seq).toBe(2);
    } finally {
      await p.end();
      await db.drop();
    }
  });
});
