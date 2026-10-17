import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { categoryNameKey, serviceTypeNameKey, type CatalogStatus } from '../../contracts/src/catalog';
import {
  TRUST_CASE_STATUSES,
  TRUST_DEFINITION_STATUSES,
  TRUST_DOCUMENT_SIZE_CEILING,
  TRUST_DOCUMENT_STATUSES,
  TRUST_DOCUMENT_TYPE_CODES,
  TRUST_ERROR_CODES,
  TRUST_EVIDENCE_KINDS,
  TRUST_EXTERNAL_STATUSES,
  TRUST_OVERALL_STATUSES,
  TRUST_POLICY_KEYS,
  TRUST_REASON_CODES,
  TRUST_REQUIREMENT_STATUSES,
  TRUST_REQUIREMENT_TYPES,
  TRUST_REVIEW_DECISIONS,
  TRUST_SCAN_STATUSES,
  TRUST_EVIDENCE_OPEN_STATUSES,
  TrustDocumentPolicy,
  isTrustDefinitionTransitionAllowed,
  isTrustRequirementTransitionAllowed,
  trustDocumentStatusKey,
  trustDocumentTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  trustRequirementInstructionsKey,
  trustRequirementNameKey,
  trustRequirementStatusKey,
  trustScanStatusKey,
  trustVerificationStatusKey,
  type TrustCaseStatus,
  type TrustDefinitionStatus,
  type TrustRequirementStatus,
  type TrustRequirementType,
} from '../../contracts/src/trust';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';
import { ConfigurationService } from '../../configuration/src/index';
import { ContentService } from '../../content/src/index';
import { createIsolatedDatabase, createTestPool, migrationsDir, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0019 (TRUST-001, provider verification and documents) creates the `trust` schema: requirement DEFINITIONS (what can be asked), the RULES that say where each applies (market,
// service type), one verification CASE per account (the provider is NOT a second account), one requirement INSTANCE per definition and cycle, document METADATA (the bytes live in
// private object storage), append-only structured REVIEWS, external verification references and an immutable audit trail. Ten functions guard it (SQLSTATE 23000, DETAIL
// trust_rule:<KEY>) through 21 triggers, and two seeds go through the real workflows: six evidence policy parameters (configuration) and 97 managed copy entries (content), plus four
// requirement definitions, seven document types, seven reason codes and ONE rule (identity verification everywhere). No case is seeded and no older object changes.
// These tests drive the REAL tables with raw SQL on isolated databases: the exact shape, the seeds (resolved through ConfigurationService and ContentService and compared with the
// contract in both directions), every CHECK, every guard rule on the exact failing statement, the status matrices against the contract, the one-live-case rule, the expiry clock, RESTRICT
// and TRUNCATE, the interleavings that matter under real concurrency (lock waiters polled in pg_stat_activity, then repeated simultaneous races, in both orders), the access paths and
// the privacy shape. The service is covered in packages/trust and the API in apps/api.
//
// Mutation runs (done by hand on private copies, never in place): TRUST_MODEL_MIGRATIONS_DIR names a directory whose 0019_trust_verification.sql replaces the real one in every
// database this file creates. Unset, the real migration is used.
// several tests wait for a real clock (an approval that ends in one second) or run dozens of statements: give them room when the machine is busy with other test files
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });
const MUTANT_DIR = process.env.TRUST_MODEL_MIGRATIONS_DIR;
const MIGRATION_19 = '0019_trust_verification.sql';
const migration19 = (): string => readFileSync(path.join(MUTANT_DIR ?? migrationsDir(), MIGRATION_19), 'utf8');

/** A database migrated through migration `through` (all migrations when it is Infinity); 0019 is read from the mutant directory when one is named. */
async function migratedDatabase(through: number): Promise<IsolatedDatabase> {
  const dir = mkdtempSync(path.join(tmpdir(), `bananagig-mig-${Number.isFinite(through) ? through : 'head'}-`));
  const db = await createIsolatedDatabase({ migrate: false });
  try {
    for (const f of readdirSync(migrationsDir()).filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= through))
      copyFileSync(path.join(f === MIGRATION_19 ? (MUTANT_DIR ?? migrationsDir()) : migrationsDir(), f), path.join(dir, f));
    await runMigrations({ url: db.url, dir });
    return db;
  } catch (e) {
    await db.drop();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine, migrated through 0019: the seed assertions and the comparison with 0018 read it
let base: IsolatedDatabase; // pristine, migrated through 0018
let pool: pg.Pool;
let racePool: pg.Pool;
let seedPool: pg.Pool;
let basePool: pg.Pool;
let seq = 0;
let laOc: string; // the seeded market la-oc
let categoryId: string; // one ACTIVE category the test service types live under
let identityDef: string; // the seeded ACTIVE, DOCUMENT, no-expiry definition identity_verification
interface Def {
  id: string;
  code: string;
}
let docDef: Def; // ACTIVE, IDENTITY, DOCUMENT, no expiry
let expDef: Def; // ACTIVE, LICENSE, DOCUMENT, expiry required
let extDef: Def; // ACTIVE, BACKGROUND_CHECK, EXTERNAL, expiry required
beforeAll(async () => {
  const made = await Promise.allSettled([migratedDatabase(Infinity), migratedDatabase(19), migratedDatabase(18)]);
  if (made.some((m) => m.status === 'rejected')) {
    for (const m of made) if (m.status === 'fulfilled') await m.value.drop();
    throw (made.find((m) => m.status === 'rejected') as PromiseRejectedResult).reason;
  }
  [iso, seed, base] = made.map((m) => (m as PromiseFulfilledResult<IsolatedDatabase>).value) as [IsolatedDatabase, IsolatedDatabase, IsolatedDatabase];
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  seedPool = createTestPool(seed.url, 4);
  basePool = createTestPool(base.url, 3);
  laOc = ((await pool.query("SELECT market_id FROM geography.markets WHERE code = 'la-oc'")).rows[0] as { market_id: string }).market_id;
  identityDef = (
    (await pool.query("SELECT requirement_definition_id AS id FROM trust.requirement_definitions WHERE code = 'identity_verification'")).rows[0] as {
      id: string;
    }
  ).id;
  await ensureEntry(categoryNameKey('trust_tests'));
  categoryId = ((await pool.query("INSERT INTO catalog.categories (code) VALUES ('trust_tests') RETURNING category_id")).rows[0] as { category_id: string })
    .category_id;
  await pool.query('UPDATE catalog.categories SET status = $2 WHERE category_id = $1', [categoryId, 'ACTIVE']);
  docDef = await makeDef({ type: 'IDENTITY', kind: 'DOCUMENT', expiry: false, status: 'ACTIVE' });
  expDef = await makeDef({ type: 'LICENSE', kind: 'DOCUMENT', expiry: true, status: 'ACTIVE' });
  extDef = await makeDef({ type: 'BACKGROUND_CHECK', kind: 'EXTERNAL', expiry: true, status: 'ACTIVE' });
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await seedPool?.end();
  await basePool?.end();
  await iso?.drop();
  await seed?.drop();
  await base?.drop();
});

// ---------------------------------------------------------------- helpers
type Db = pg.Pool | pg.PoolClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], from: Db = pool): Promise<T[]> =>
  (await from.query(sql, params)).rows as T[];
const sq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await seedPool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = [], from: Db = pool) => from.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = [], from: Db = pool): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params, from))[0]!.n;
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
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL trust_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `trust_rule:${key}` });
};
/** Asserts the statement is refused by a named constraint with the SQLSTATE of its kind (check 23514, foreign key 23503, unique 23505). */
const expectConstraint = async (p: Promise<unknown>, constraint: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({
    code: constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505',
    constraint,
  });
};
const expectNotNull = async (p: Promise<unknown>, column: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, column: e.column }).toEqual({ code: '23502', column });
};
const asRule = (e: PgFailure | undefined): { code?: string; detail?: string } | undefined => (e ? { code: e.code, detail: e.detail } : undefined);
const rule = (key: string) => ({ code: '23000', detail: `trust_rule:${key}` });
const outcomeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  if (!e) return 'ACCEPTED';
  return e.detail?.startsWith('trust_rule:') ? e.detail.slice('trust_rule:'.length) : (e.constraint ?? e.code ?? 'ERROR');
};

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
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>, from: pg.Pool = pool): Promise<T> {
  const c = await openTx(from);
  try {
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
/** Runs the prep statements and then `text` in a transaction that is ALWAYS rolled back (the prep may disable the user triggers of a table for this transaction). */
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
async function rolledBack<T>(fn: (c: pg.PoolClient) => Promise<T>, from: pg.Pool = pool): Promise<T> {
  const c = await from.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const noTriggers = (...tables: string[]): string[] => tables.map((t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`);
/** Disables the user triggers of every table outside the trust schema (so that only the trust guards can answer), for the rolled-back transaction that follows. */
const NO_FOREIGN_TRIGGERS = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname IN ('identity', 'geography', 'catalog', 'content', 'configuration', 'integration', 'provider') LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER USER', r.nspname, r.relname);
  END LOOP; END $$`;

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
async function noLockWaiters(from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ---------------------------------------------------------------- fixtures
const DEF = 'trust.requirement_definitions';
const DTYPE = 'trust.document_types';
const REASON = 'trust.reason_codes';
const RULE = 'trust.requirement_rules';
const CASES = 'trust.verification_cases';
const CR = 'trust.case_requirements';
const DOC = 'trust.documents';
const REV = 'trust.reviews';
const EXT = 'trust.external_verifications';
const AUDIT = 'trust.audit_events';
/** Every table of the schema, children first. */
const TABLES = [AUDIT, REV, EXT, DOC, CR, CASES, RULE, REASON, DTYPE, DEF];
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const PATH: Record<CatalogStatus, CatalogStatus[]> = { DRAFT: [], ACTIVE: ['ACTIVE'], INACTIVE: ['ACTIVE', 'INACTIVE'], RETIRED: ['RETIRED'] };
type AccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSURE_REQUESTED' | 'CLOSED';

const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
/** An account in its creation state (PENDING or ACTIVE) with the creation history row, in one transaction (the deferred trigger demands both). */
async function makeAccount(status: 'PENDING' | 'ACTIVE' = 'ACTIVE'): Promise<string> {
  return inTx(async (c) => {
    const r = await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status]);
    const id = (r.rows[0] as { account_id: string }).account_id;
    await historyRow(c, id, null, status);
    return id;
  });
}
/** Moves an account to another status together with its history row (the service does the same in one transaction). */
async function setStatus(accountId: string, to: AccountStatus): Promise<void> {
  await inTx(async (c) => {
    const from = ((await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0] as { status: string }).status;
    await c.query(
      "UPDATE identity.accounts SET status = $2::text, closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() END, updated_at = now() WHERE account_id = $1",
      [accountId, to],
    );
    await historyRow(c, accountId, from, to);
  });
}
/** An account in the given status, reached along a legal path (no role is held, so it can be closed). */
async function accountIn(status: AccountStatus): Promise<string> {
  if (status === 'PENDING') return makeAccount('PENDING');
  const id = await makeAccount('ACTIVE');
  if (status === 'SUSPENDED' || status === 'CLOSURE_REQUESTED') await setStatus(id, status);
  if (status === 'CLOSED') {
    await setStatus(id, 'SUSPENDED');
    await setStatus(id, 'CLOSED');
  }
  return id;
}
/** The statements of an account suspension in one transaction body (lock, update, history). */
async function suspendOn(c: Db, accountId: string): Promise<void> {
  await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
  await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [accountId]);
  await historyRow(c, accountId, 'ACTIVE', 'SUSPENDED');
}

/** A content entry with this key (no version: the trust tables only need the key to exist). */
async function ensureEntry(key: string, from: Db = pool): Promise<void> {
  await from.query(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, 'UI_LABEL', 'CONTENT', 'test entry', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'test') ON CONFLICT (key) DO NOTHING`,
    [key],
  );
}
interface Row {
  id: string;
  code: string;
}
/** A service type under the ACTIVE test category, moved along legal steps to the status asked for (default ACTIVE). */
async function makeServiceType(status: CatalogStatus = 'ACTIVE', from: Db = pool): Promise<Row> {
  const code = `tst_${++seq}`;
  await ensureEntry(serviceTypeNameKey(code), from);
  const id = (
    (await from.query('INSERT INTO catalog.service_types (category_id, code) VALUES ($1, $2) RETURNING service_type_id', [categoryId, code])).rows[0] as {
      service_type_id: string;
    }
  ).service_type_id;
  for (const s of PATH[status]) await from.query('UPDATE catalog.service_types SET status = $2 WHERE service_type_id = $1', [id, s]);
  return { id, code };
}

interface DefSpec {
  type?: TrustRequirementType;
  kind?: 'DOCUMENT' | 'EXTERNAL';
  expiry?: boolean;
  status?: TrustDefinitionStatus;
}
/** A requirement definition with its two content entries (the generated keys are foreign keys), inserted INACTIVE or ACTIVE and moved on to RETIRED when asked. */
async function makeDef(spec: DefSpec = {}, from: Db = pool): Promise<Def> {
  const code = `tdef_${++seq}`;
  await ensureEntry(trustRequirementNameKey(code), from);
  await ensureEntry(trustRequirementInstructionsKey(code), from);
  const status = spec.status ?? 'ACTIVE';
  const id = (
    (
      await from.query(
        `INSERT INTO ${DEF} (code, requirement_type, evidence_kind, expiry_required, status) VALUES ($1, $2, $3, $4, $5) RETURNING requirement_definition_id`,
        [code, spec.type ?? 'IDENTITY', spec.kind ?? 'DOCUMENT', spec.expiry ?? false, status === 'RETIRED' ? 'INACTIVE' : status],
      )
    ).rows[0] as { requirement_definition_id: string }
  ).requirement_definition_id;
  if (status === 'RETIRED') await from.query(`UPDATE ${DEF} SET status = 'RETIRED' WHERE requirement_definition_id = $1`, [id]);
  return { id, code };
}
const setDef = (id: string, status: string, from: Db = pool) => from.query(`UPDATE ${DEF} SET status = $2 WHERE requirement_definition_id = $1`, [id, status]);
/** A reason code with its content entry; INACTIVE reasons are inserted INACTIVE. */
async function makeReason(appliesTo: 'REJECT' | 'ACTION_REQUIRED' | 'BOTH', status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE', from: Db = pool): Promise<string> {
  const code = `TESTREASON${++seq}`;
  await ensureEntry(trustReasonNameKey(code), from);
  await from.query(`INSERT INTO ${REASON} (code, applies_to, status) VALUES ($1, $2, $3)`, [code, appliesTo, status]);
  return code;
}
// cases and requirements
const caseRow = async <T = Record<string, unknown>>(id: string, from: Db = pool): Promise<T> =>
  (await q<T>(`SELECT * FROM ${CASES} WHERE verification_case_id = $1`, [id], from))[0]!;
/** Inserts the next case of an account (the guard accepts only the highest case number plus one). */
async function openCase(account: string, from: Db = pool): Promise<string> {
  const r = await from.query(
    `INSERT INTO ${CASES} (account_id, case_number) SELECT $1::uuid, COALESCE(max(case_number), 0) + 1 FROM ${CASES} WHERE account_id = $1 RETURNING verification_case_id`,
    [account],
  );
  return (r.rows[0] as { verification_case_id: string }).verification_case_id;
}
type CaseKind = 'OPEN' | 'IN_REVIEW' | 'ACTION_REQUIRED' | 'APPROVED' | 'EXPIRED' | 'CANCELLED';
/** A case of a fresh ACTIVE account, moved to the status asked for (the guard fixes only the initial and the terminal state, so any other move is one UPDATE). */
async function makeCase(kind: CaseKind = 'OPEN'): Promise<{ account: string; caseId: string }> {
  const account = await makeAccount();
  const caseId = await openCase(account);
  if (kind !== 'OPEN') await run(`UPDATE ${CASES} SET status = $2 WHERE verification_case_id = $1`, [caseId, kind]);
  return { account, caseId };
}
const crRow = async <T = Record<string, unknown>>(id: string, from: Db = pool): Promise<T> =>
  (await q<T>(`SELECT * FROM ${CR} WHERE case_requirement_id = $1`, [id], from))[0]!;
/** Adds the requirement (the next cycle of the definition) to a case. */
async function addReq(caseId: string, defId: string, from: Db = pool): Promise<string> {
  const r = await from.query(
    `INSERT INTO ${CR} (verification_case_id, requirement_definition_id, cycle) SELECT $1::uuid, $2::uuid, COALESCE(max(cycle), 0) + 1 FROM ${CR} WHERE verification_case_id = $1 AND requirement_definition_id = $2 RETURNING case_requirement_id`,
    [caseId, defId],
  );
  return (r.rows[0] as { case_requirement_id: string }).case_requirement_id;
}
interface Req {
  account: string;
  caseId: string;
  id: string;
  def: Def;
}
/** A NOT_STARTED requirement of the given definition in a case of a fresh account. */
async function makeReq(def: Def = docDef): Promise<Req> {
  const { account, caseId } = await makeCase();
  return { account, caseId, id: await addReq(caseId, def.id), def };
}
const setReq = (id: string, set: string, params: unknown[] = [], from: Db = pool) =>
  from.query(`UPDATE ${CR} SET ${set} WHERE case_requirement_id = $1`, [id, ...params]);
const submitReq = (id: string, from: Db = pool) => setReq(id, "status = 'PENDING', round = round + 1", [], from);
const startReq = (id: string, from: Db = pool) => setReq(id, "status = 'IN_REVIEW'", [], from);
const approveReq = (id: string, expires: string | null = null, from: Db = pool) =>
  setReq(id, `status = 'APPROVED', expires_at = ${expires ?? 'NULL'}`, [], from);
const HOUR = "now() + interval '1 hour'";
const SOON = "now() + interval '1 second'";
type ReqKind = TrustRequirementStatus;
/**
 * A requirement in the given status, reached along a legal path. APPROVED ends in one hour (or never, for a definition without expiry unless `expires` says otherwise).
 * EXPIRED needs the clock: it is approved to end in one second and the caller must wait: use `expireWhenDue` after `sleep` (see makeApprovedSoon).
 */
async function makeReqIn(kind: ReqKind, def: Def = docDef, expires: string | null = null): Promise<Req> {
  const r = await makeReq(def);
  if (kind === 'NOT_STARTED') return r;
  if (kind === 'NOT_REQUIRED') {
    await setReq(r.id, "status = 'NOT_REQUIRED'");
    return r;
  }
  await submitReq(r.id);
  if (kind === 'PENDING') return r;
  if (kind === 'IN_REVIEW') await startReq(r.id);
  else if (kind === 'ACTION_REQUIRED' || kind === 'REJECTED') await setReq(r.id, `status = '${kind}'`);
  else if (kind === 'APPROVED') await approveReq(r.id, expires ?? (def.id === docDef.id ? null : HOUR));
  else if (kind === 'EXPIRED') await approveReq(r.id, expires ?? SOON);
  return r;
}
/** Approves `n` requirements to end in one second; the caller waits and then expires them. */
async function makeApprovedSoon(n: number, def: Def = docDef): Promise<Req[]> {
  const out: Req[] = [];
  for (let i = 0; i < n; i++) out.push(await makeReqIn('APPROVED', def, SOON));
  return out;
}
/** The statement that records the expiry of an approval whose end has passed. */
const expireReq = (id: string, from: Db = pool) => setReq(id, "status = 'EXPIRED'", [], from);
const supersedeReq = (id: string, from: Db = pool) => setReq(id, 'superseded_at = now()', [], from);

// documents
const caseOfReq = async (reqId: string, from: Db = pool): Promise<string> =>
  (await q<{ c: string }>(`SELECT verification_case_id AS c FROM ${CR} WHERE case_requirement_id = $1`, [reqId], from))[0]!.c;
const docRow = async <T = Record<string, unknown>>(id: string, from: Db = pool): Promise<T> =>
  (await q<T>(`SELECT * FROM ${DOC} WHERE verification_document_id = $1`, [id], from))[0]!;
interface DocSpec {
  type?: string;
  mime?: string;
  size?: number;
  key?: string;
  id?: string;
  expires?: string;
}
/** Inserts a document (UPLOAD_PENDING, unscanned) for the requirement under the server-style key trust/evidence/<case>/<document>. */
async function mkDoc(reqId: string, o: DocSpec = {}, from: Db = pool): Promise<string> {
  const id = o.id ?? randomUUID();
  const caseId = await caseOfReq(reqId, from);
  await from.query(
    `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at)
     VALUES ($1, $2, (SELECT document_type_id FROM ${DTYPE} WHERE code = $3), $4, $5, $6, ${o.expires ?? "now() + interval '15 minutes'"})`,
    [id, reqId, o.type ?? 'drivers_license', o.key ?? `trust/evidence/${caseId}/${id}`, o.mime ?? 'application/pdf', o.size ?? 1234],
  );
  return id;
}
const attachDoc = (id: string, sha = SHA, from: Db = pool) =>
  from.query(`UPDATE ${DOC} SET status = 'ATTACHED', sha256 = $2, scan_status = 'CLEAN' WHERE verification_document_id = $1`, [id, sha]);
const submitDoc = (id: string, round: number, from: Db = pool) =>
  from.query(`UPDATE ${DOC} SET status = 'SUBMITTED', round = $2 WHERE verification_document_id = $1`, [id, round]);
const setDoc = (id: string, set: string, params: unknown[] = [], from: Db = pool) =>
  from.query(`UPDATE ${DOC} SET ${set} WHERE verification_document_id = $1`, [id, ...params]);
type DocKind = 'UPLOAD_PENDING' | 'ATTACHED' | 'SUBMITTED' | 'WITHDRAWN' | 'ABANDONED';
/** A document in the given status of a fresh requirement; for ATTACHED the requirement is submitted afterwards (round 1) so that the document could be submitted too. */
async function makeDocIn(kind: DocKind): Promise<{ req: Req; id: string }> {
  const req = await makeReq();
  const id = await mkDoc(req.id);
  if (kind === 'UPLOAD_PENDING') return { req, id };
  if (kind === 'ABANDONED') {
    await setDoc(id, "status = 'ABANDONED'");
    return { req, id };
  }
  await attachDoc(id);
  if (kind === 'WITHDRAWN') await setDoc(id, "status = 'WITHDRAWN'");
  else {
    await submitReq(req.id);
    if (kind === 'SUBMITTED') await submitDoc(id, 1);
  }
  return { req, id };
}

// reviews, external verifications, rules, audit
interface RevSpec {
  round?: number;
  reason?: string | null;
  expires?: string | null;
  reviewer?: string;
  correlation?: string;
}
const review = (reqId: string, decision: string, o: RevSpec = {}, from: Db = pool) =>
  from.query(
    `INSERT INTO ${REV} (case_requirement_id, round, decision, reason_code, reviewer, expires_at, correlation_id) VALUES ($1, $2, $3, $4, $5, ${o.expires ?? 'NULL'}, $6)`,
    [reqId, o.round ?? 1, decision, o.reason ?? null, o.reviewer ?? 'admin:reviewer-1', o.correlation ?? 'test-correlation'],
  );
const reviewCount = (reqId: string, from: Db = pool) => count(REV, 'case_requirement_id = $1', [reqId], from);
const extRef = (reqId: string, o: { round?: number; adapter?: string; externalId?: string; status?: string } = {}, from: Db = pool) =>
  from.query(`INSERT INTO ${EXT} (case_requirement_id, round, adapter, external_id, status) VALUES ($1, $2, $3, $4, $5)`, [
    reqId,
    o.round ?? 1,
    o.adapter ?? 'fake',
    o.externalId ?? `ext-${++seq}`,
    o.status ?? 'CREATED',
  ]);
const addRule = (defId: string, market: string | null, serviceType: string | null, enabled = true, from: Db = pool) =>
  from.query(`INSERT INTO ${RULE} (requirement_definition_id, market_id, service_type_id, enabled) VALUES ($1, $2, $3, $4) RETURNING requirement_rule_id`, [
    defId,
    market,
    serviceType,
    enabled,
  ]);
const audit = (
  o: {
    caseId?: string | null;
    reqId?: string | null;
    defId?: string | null;
    action?: string;
    actor?: string;
    changes?: unknown;
    reason?: string | null;
    correlation?: string;
  },
  from: Db = pool,
) =>
  from.query(
    `INSERT INTO ${AUDIT} (actor, action, verification_case_id, case_requirement_id, requirement_definition_id, changes, reason_code, correlation_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      o.actor ?? 'account:test',
      o.action ?? 'VERIFICATION_CASE_OPENED',
      o.caseId ?? null,
      o.reqId ?? null,
      o.defId ?? null,
      o.changes === undefined ? null : JSON.stringify(o.changes),
      o.reason ?? null,
      o.correlation ?? 'test-correlation',
    ],
  );

/** Invariants of the verification data that must hold whatever the interleaving: none of these may ever have a row. */
async function violations(from: Db = pool): Promise<Record<string, unknown[]>> {
  const rows = async (text: string) => (await from.query(text)).rows;
  return {
    moreThanOneLiveCase: await rows(`SELECT account_id FROM ${CASES} WHERE status <> 'CANCELLED' GROUP BY 1 HAVING count(*) > 1`),
    caseNumbersNotContiguous: await rows(`SELECT account_id FROM ${CASES} GROUP BY 1 HAVING min(case_number) <> 1 OR max(case_number) <> count(*)`),
    caseLifecycleBroken: await rows(
      `SELECT verification_case_id FROM ${CASES}
        WHERE NOT ((status = 'OPEN' AND submitted_at IS NULL AND decided_at IS NULL AND cancelled_at IS NULL)
                OR (status IN ('IN_REVIEW', 'ACTION_REQUIRED', 'EXPIRED') AND submitted_at IS NOT NULL AND cancelled_at IS NULL)
                OR (status = 'APPROVED' AND submitted_at IS NOT NULL AND decided_at IS NOT NULL AND cancelled_at IS NULL)
                OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL))`,
    ),
    moreThanOneCurrentInstance: await rows(
      `SELECT verification_case_id, requirement_definition_id FROM ${CR} WHERE superseded_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1`,
    ),
    cyclesNotContiguous: await rows(
      `SELECT verification_case_id, requirement_definition_id FROM ${CR} GROUP BY 1, 2 HAVING min(cycle) <> 1 OR max(cycle) <> count(*)`,
    ),
    supersededButNotExpired: await rows(`SELECT case_requirement_id FROM ${CR} WHERE superseded_at IS NOT NULL AND status <> 'EXPIRED'`),
    approvalBroken: await rows(
      `SELECT case_requirement_id FROM ${CR}
        WHERE (status IN ('APPROVED', 'EXPIRED')) <> (approved_at IS NOT NULL) OR (status = 'EXPIRED' AND expires_at IS NULL) OR (status NOT IN ('APPROVED', 'EXPIRED') AND expires_at IS NOT NULL)`,
    ),
    evidenceWithoutRound: await rows(
      `SELECT case_requirement_id FROM ${CR} WHERE status IN ('PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED', 'APPROVED', 'EXPIRED') AND (round < 1 OR submitted_at IS NULL)`,
    ),
    documentLifecycleBroken: await rows(
      `SELECT verification_document_id FROM ${DOC}
        WHERE NOT ((status = 'UPLOAD_PENDING' AND sha256 IS NULL AND round IS NULL) OR (status = 'ATTACHED' AND sha256 IS NOT NULL AND round IS NULL)
                OR (status = 'SUBMITTED' AND sha256 IS NOT NULL AND round >= 1 AND submitted_at IS NOT NULL) OR (status = 'WITHDRAWN' AND sha256 IS NOT NULL AND round IS NULL)
                OR (status = 'ABANDONED' AND round IS NULL))`,
    ),
    submittedDocumentOutsideItsRound: await rows(
      `SELECT d.verification_document_id FROM ${DOC} d JOIN ${CR} r USING (case_requirement_id) WHERE d.status = 'SUBMITTED' AND d.round > r.round`,
    ),
    moreThanOneDecisionPerRound: await rows(`SELECT case_requirement_id, round FROM ${REV} WHERE decision <> 'STARTED' GROUP BY 1, 2 HAVING count(*) > 1`),
    moreThanOneStartPerRound: await rows(`SELECT case_requirement_id, round FROM ${REV} WHERE decision = 'STARTED' GROUP BY 1, 2 HAVING count(*) > 1`),
    reviewBeyondItsRequirement: await rows(`SELECT v.review_id FROM ${REV} v JOIN ${CR} r USING (case_requirement_id) WHERE v.round > r.round`),
    duplicateExternalPerRound: await rows(`SELECT case_requirement_id, round FROM ${EXT} GROUP BY 1, 2 HAVING count(*) > 1`),
  };
}
const NO_VIOLATIONS = Object.fromEntries(
  [
    'moreThanOneLiveCase',
    'caseNumbersNotContiguous',
    'caseLifecycleBroken',
    'moreThanOneCurrentInstance',
    'cyclesNotContiguous',
    'supersededButNotExpired',
    'approvalBroken',
    'evidenceWithoutRound',
    'documentLifecycleBroken',
    'submittedDocumentOutsideItsRound',
    'moreThanOneDecisionPerRound',
    'moreThanOneStartPerRound',
    'reviewBeyondItsRequirement',
    'duplicateExternalPerRound',
  ].map((k) => [k, []]),
);

/**
 * The holder transaction runs `hold` and stays OPEN; the racer statement is started on another connection WITHOUT being awaited; the test polls pg_stat_activity until
 * the racer is blocked on a lock; only then the holder commits (or rolls back). Returns the racer's failure (undefined when it succeeded). No sleep synchronizes anything.
 */
interface RaceSql {
  text: string;
  params?: unknown[];
}
type Racer = RaceSql | ((c: pg.PoolClient) => Promise<unknown>);
const runRacer = async (from: pg.Pool, r: Racer): Promise<unknown> => {
  if (typeof r !== 'function') return from.query(r.text, r.params ?? []);
  const c = await openTx(from);
  try {
    await r(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};
async function holdThenRace(hold: (c: pg.PoolClient) => Promise<unknown>, race: Racer, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<PgFailure | undefined> {
  const tx = await openTx();
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(runRacer(racePool, race));
    await lockWaiters(1);
  } finally {
    await finish(tx, how);
  }
  return (await racer) as PgFailure | undefined;
}
/** Fires both at once on separate pooled connections and returns their failures (undefined = succeeded). */
const both = (a: Racer, b: Racer) =>
  Promise.all([rejection(runRacer(racePool, a)), rejection(runRacer(racePool, b))]) as Promise<[PgFailure | undefined, PgFailure | undefined]>;
const winners = (r: (PgFailure | undefined)[]): number => r.filter((x) => x === undefined).length;
const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);
const sqlOf = (text: string, ...params: unknown[]): RaceSql => ({ text, params });
const exec = (c: Db, r: RaceSql) => c.query(r.text, r.params ?? []);

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const columnsOf = async (table: string, from: pg.Pool = pool): Promise<ColumnShape[]> =>
  (
    (
      await from.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'trust' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
interface ConstraintRow {
  conname: string;
  contype: string;
  confdeltype: string;
  confupdtype: string;
  confmatchtype: string;
  condeferrable: boolean;
  convalidated: boolean;
  target: string | null;
  def: string;
}
const constraintsOf = async (table: string, from: pg.Pool = pool): Promise<ConstraintRow[]> =>
  (
    await from.query(
      `SELECT conname, contype, confdeltype, confupdtype, confmatchtype, condeferrable, convalidated, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'f', 'c', 'x', 't') ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const indexesOf = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
  (await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = \'trust\' AND tablename = $1 ORDER BY indexname COLLATE "C"', [table])).rows;
const triggersOf = async (table: string) =>
  q<{ tgname: string; def: string; enabled: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled AS enabled FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
  );
const commentOn = async (table: string, column?: string): Promise<string | null> =>
  (
    (
      await pool.query(
        column
          ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
          : "SELECT obj_description($1::regclass, 'pg_class') AS c",
        column ? [table, column] : [table],
      )
    ).rows[0] as { c: string | null }
  ).c;
const vocab = (def: string): string[] => [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const TS = 'timestamp with time zone';
const COLUMNS_BY_TABLE: Record<string, ColumnShape[]> = {
  audit_events: [
    ['audit_event_id', 'uuid', false, 'gen_random_uuid()'],
    ['occurred_at', TS, false, 'clock_timestamp()'],
    ['actor', 'text', false, null],
    ['action', 'text', false, null],
    ['verification_case_id', 'uuid', true, null],
    ['case_requirement_id', 'uuid', true, null],
    ['requirement_definition_id', 'uuid', true, null],
    ['changes', 'jsonb', true, null],
    ['reason_code', 'text', true, null],
    ['correlation_id', 'text', false, null],
  ],
  case_requirements: [
    ['case_requirement_id', 'uuid', false, 'gen_random_uuid()'],
    ['verification_case_id', 'uuid', false, null],
    ['requirement_definition_id', 'uuid', false, null],
    ['cycle', 'integer', false, '1'],
    ['status', 'text', false, `'NOT_STARTED'::text`],
    ['round', 'integer', false, '0'],
    ['revision', 'integer', false, '1'],
    ['required_at', TS, false, 'now()'],
    ['submitted_at', TS, true, null],
    ['decided_at', TS, true, null],
    ['approved_at', TS, true, null],
    ['expires_at', TS, true, null],
    ['superseded_at', TS, true, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  document_types: [
    ['document_type_id', 'uuid', false, 'gen_random_uuid()'],
    ['code', 'text', false, null],
    ['requirement_type', 'text', false, null],
    ['status', 'text', false, `'ACTIVE'::text`],
    ['name_content_key', 'text', false, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  documents: [
    ['verification_document_id', 'uuid', false, 'gen_random_uuid()'],
    ['case_requirement_id', 'uuid', false, null],
    ['document_type_id', 'uuid', false, null],
    ['object_key', 'text', false, null],
    ['mime_type', 'text', false, null],
    ['size_bytes', 'bigint', false, null],
    ['sha256', 'text', true, null],
    ['status', 'text', false, `'UPLOAD_PENDING'::text`],
    ['scan_status', 'text', false, `'PENDING'::text`],
    ['round', 'integer', true, null],
    ['upload_expires_at', TS, false, null],
    ['finalized_at', TS, true, null],
    ['scanned_at', TS, true, null],
    ['submitted_at', TS, true, null],
    ['withdrawn_at', TS, true, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  external_verifications: [
    ['external_verification_id', 'uuid', false, 'gen_random_uuid()'],
    ['case_requirement_id', 'uuid', false, null],
    ['round', 'integer', false, null],
    ['adapter', 'text', false, null],
    ['external_id', 'text', false, null],
    ['status', 'text', false, `'CREATED'::text`],
    ['last_checked_at', TS, true, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  reason_codes: [
    ['reason_code_id', 'uuid', false, 'gen_random_uuid()'],
    ['code', 'text', false, null],
    ['applies_to', 'text', false, null],
    ['status', 'text', false, `'ACTIVE'::text`],
    ['name_content_key', 'text', false, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  requirement_definitions: [
    ['requirement_definition_id', 'uuid', false, 'gen_random_uuid()'],
    ['code', 'text', false, null],
    ['requirement_type', 'text', false, null],
    ['evidence_kind', 'text', false, null],
    ['expiry_required', 'boolean', false, 'false'],
    ['status', 'text', false, `'INACTIVE'::text`],
    ['name_content_key', 'text', false, null],
    ['instructions_content_key', 'text', false, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  requirement_rules: [
    ['requirement_rule_id', 'uuid', false, 'gen_random_uuid()'],
    ['requirement_definition_id', 'uuid', false, null],
    ['market_id', 'uuid', true, null],
    ['service_type_id', 'uuid', true, null],
    ['enabled', 'boolean', false, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
  reviews: [
    ['review_id', 'uuid', false, 'gen_random_uuid()'],
    ['case_requirement_id', 'uuid', false, null],
    ['round', 'integer', false, null],
    ['decision', 'text', false, null],
    ['reason_code', 'text', true, null],
    ['reviewer', 'text', false, null],
    ['expires_at', TS, true, null],
    ['correlation_id', 'text', false, null],
    ['reviewed_at', TS, false, 'clock_timestamp()'],
  ],
  verification_cases: [
    ['verification_case_id', 'uuid', false, 'gen_random_uuid()'],
    ['account_id', 'uuid', false, null],
    ['case_number', 'integer', false, null],
    ['status', 'text', false, `'OPEN'::text`],
    ['revision', 'integer', false, '1'],
    ['submitted_at', TS, true, null],
    ['decided_at', TS, true, null],
    ['cancelled_at', TS, true, null],
    ['created_at', TS, false, 'now()'],
    ['updated_at', TS, false, 'now()'],
  ],
};
/** The generated columns: the content keys are derived from the code, so a definition cannot name a key of its own. */
const GENERATED: [table: string, column: string, expression: string][] = [
  ['document_types', 'name_content_key', "(('trust.document_type.'::text || code) || '.name'::text)"],
  ['reason_codes', 'name_content_key', "(('trust.reason.'::text || lower(code)) || '.name'::text)"],
  ['requirement_definitions', 'instructions_content_key', "(('trust.requirement.'::text || code) || '.instructions'::text)"],
  ['requirement_definitions', 'name_content_key', "(('trust.requirement.'::text || code) || '.name'::text)"],
];
const AUDIT_ACTIONS = [
  'VERIFICATION_CASE_OPENED',
  'VERIFICATION_REQUIREMENTS_SYNCED',
  'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
  'VERIFICATION_DOCUMENT_SUBMITTED',
  'VERIFICATION_DOCUMENT_REPLACED',
  'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
  'VERIFICATION_DOCUMENT_ACCESSED',
  'VERIFICATION_SUBMITTED',
  'VERIFICATION_REVIEW_STARTED',
  'VERIFICATION_APPROVED',
  'VERIFICATION_REJECTED',
  'VERIFICATION_ACTION_REQUIRED',
  'VERIFICATION_EXPIRED',
  'VERIFICATION_REVERIFICATION_REQUESTED',
  'VERIFICATION_CASE_CANCELLED',
  'VERIFICATION_EXTERNAL_STARTED',
  'VERIFICATION_EXTERNAL_UPDATED',
  'TRUST_REQUIREMENT_STATUS_CHANGED',
  'TRUST_RULE_CHANGED',
];
const CONSTRAINT_DEFS: Record<string, Record<string, string>> = {
  audit_events: {
    ck_audit_events__action: `CHECK ((action = ANY (ARRAY['VERIFICATION_CASE_OPENED'::text, 'VERIFICATION_REQUIREMENTS_SYNCED'::text, 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED'::text, 'VERIFICATION_DOCUMENT_SUBMITTED'::text, 'VERIFICATION_DOCUMENT_REPLACED'::text, 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED'::text, 'VERIFICATION_DOCUMENT_ACCESSED'::text, 'VERIFICATION_SUBMITTED'::text, 'VERIFICATION_REVIEW_STARTED'::text, 'VERIFICATION_APPROVED'::text, 'VERIFICATION_REJECTED'::text, 'VERIFICATION_ACTION_REQUIRED'::text, 'VERIFICATION_EXPIRED'::text, 'VERIFICATION_REVERIFICATION_REQUESTED'::text, 'VERIFICATION_CASE_CANCELLED'::text, 'VERIFICATION_EXTERNAL_STARTED'::text, 'VERIFICATION_EXTERNAL_UPDATED'::text, 'TRUST_REQUIREMENT_STATUS_CHANGED'::text, 'TRUST_RULE_CHANGED'::text])))`,
    ck_audit_events__actor: 'CHECK (((length(btrim(actor)) > 0) AND (length(actor) <= 200)))',
    ck_audit_events__changes_object: `CHECK (((changes IS NULL) OR (jsonb_typeof(changes) = 'object'::text)))`,
    ck_audit_events__subject: 'CHECK (((verification_case_id IS NOT NULL) OR (case_requirement_id IS NOT NULL) OR (requirement_definition_id IS NOT NULL)))',
    fk_audit_events__case_id: 'FOREIGN KEY (verification_case_id) REFERENCES trust.verification_cases(verification_case_id) ON DELETE RESTRICT',
    fk_audit_events__case_requirement_id: 'FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements(case_requirement_id) ON DELETE RESTRICT',
    fk_audit_events__definition_id:
      'FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions(requirement_definition_id) ON DELETE RESTRICT',
    pk_audit_events: 'PRIMARY KEY (audit_event_id)',
  },
  case_requirements: {
    ck_case_requirements__approval: `CHECK ((((status = ANY (ARRAY['APPROVED'::text, 'EXPIRED'::text])) AND (approved_at IS NOT NULL) AND ((expires_at IS NULL) OR (expires_at > approved_at)) AND ((status = 'APPROVED'::text) OR (expires_at IS NOT NULL))) OR ((status <> ALL (ARRAY['APPROVED'::text, 'EXPIRED'::text])) AND (approved_at IS NULL) AND (expires_at IS NULL))))`,
    ck_case_requirements__cycle: 'CHECK ((cycle >= 1))',
    ck_case_requirements__evidence: `CHECK (((status <> ALL (ARRAY['PENDING'::text, 'IN_REVIEW'::text, 'ACTION_REQUIRED'::text, 'REJECTED'::text, 'APPROVED'::text, 'EXPIRED'::text])) OR ((round >= 1) AND (submitted_at IS NOT NULL))))`,
    ck_case_requirements__revision: 'CHECK ((revision >= 1))',
    ck_case_requirements__round: 'CHECK ((round >= 0))',
    ck_case_requirements__status: `CHECK ((status = ANY (ARRAY['NOT_STARTED'::text, 'PENDING'::text, 'IN_REVIEW'::text, 'ACTION_REQUIRED'::text, 'APPROVED'::text, 'REJECTED'::text, 'EXPIRED'::text, 'NOT_REQUIRED'::text])))`,
    ck_case_requirements__superseded: `CHECK (((superseded_at IS NULL) OR (status = 'EXPIRED'::text)))`,
    fk_case_requirements__case_id: 'FOREIGN KEY (verification_case_id) REFERENCES trust.verification_cases(verification_case_id) ON DELETE RESTRICT',
    fk_case_requirements__definition_id:
      'FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions(requirement_definition_id) ON DELETE RESTRICT',
    pk_case_requirements: 'PRIMARY KEY (case_requirement_id)',
    uq_case_requirements__cycle: 'UNIQUE (verification_case_id, requirement_definition_id, cycle)',
  },
  documents: {
    ck_documents__lifecycle: `CHECK ((((status = 'UPLOAD_PENDING'::text) AND (sha256 IS NULL) AND (finalized_at IS NULL) AND (round IS NULL) AND (submitted_at IS NULL) AND (withdrawn_at IS NULL)) OR ((status = 'ATTACHED'::text) AND (sha256 IS NOT NULL) AND (finalized_at IS NOT NULL) AND (round IS NULL) AND (submitted_at IS NULL) AND (withdrawn_at IS NULL)) OR ((status = 'SUBMITTED'::text) AND (sha256 IS NOT NULL) AND (finalized_at IS NOT NULL) AND (round IS NOT NULL) AND (round >= 1) AND (submitted_at IS NOT NULL) AND (withdrawn_at IS NULL)) OR ((status = 'WITHDRAWN'::text) AND (sha256 IS NOT NULL) AND (finalized_at IS NOT NULL) AND (round IS NULL) AND (submitted_at IS NULL) AND (withdrawn_at IS NOT NULL)) OR ((status = 'ABANDONED'::text) AND (round IS NULL) AND (submitted_at IS NULL))))`,
    ck_documents__mime: `CHECK (((mime_type ~ '^[a-z]+/[a-z0-9.+-]+$'::text) AND (length(mime_type) <= 100)))`,
    ck_documents__object_key: `CHECK ((object_key ~ '^trust/evidence/[0-9a-f-]{36}/[0-9a-f-]{36}$'::text))`,
    ck_documents__scan: `CHECK ((scan_status = ANY (ARRAY['PENDING'::text, 'CLEAN'::text, 'INFECTED'::text, 'ERROR'::text])))`,
    ck_documents__sha256: `CHECK (((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'::text)))`,
    ck_documents__size: 'CHECK (((size_bytes >= 1) AND (size_bytes <= 52428800)))',
    ck_documents__status: `CHECK ((status = ANY (ARRAY['UPLOAD_PENDING'::text, 'ATTACHED'::text, 'SUBMITTED'::text, 'WITHDRAWN'::text, 'ABANDONED'::text])))`,
    fk_documents__case_requirement_id: 'FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements(case_requirement_id) ON DELETE RESTRICT',
    fk_documents__document_type_id: 'FOREIGN KEY (document_type_id) REFERENCES trust.document_types(document_type_id) ON DELETE RESTRICT',
    pk_documents: 'PRIMARY KEY (verification_document_id)',
    uq_documents__object_key: 'UNIQUE (object_key)',
  },
  document_types: {
    ck_document_types__code: `CHECK (((code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(code) >= 2) AND (length(code) <= 48))))`,
    ck_document_types__requirement_type: `CHECK ((requirement_type = ANY (ARRAY['IDENTITY'::text, 'BACKGROUND_CHECK'::text, 'LICENSE'::text, 'INSURANCE'::text, 'CERTIFICATION'::text, 'BUSINESS_REGISTRATION'::text, 'OTHER_DOCUMENT'::text])))`,
    ck_document_types__status: `CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])))`,
    fk_document_types__name_content_key: 'FOREIGN KEY (name_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    pk_document_types: 'PRIMARY KEY (document_type_id)',
    uq_document_types__code: 'UNIQUE (code)',
  },
  external_verifications: {
    ck_external_verifications__adapter: `CHECK ((adapter ~ '^[a-z][a-z0-9_]{1,31}$'::text))`,
    ck_external_verifications__external_id: `CHECK ((external_id ~ '^[A-Za-z0-9._:-]{1,128}$'::text))`,
    ck_external_verifications__round: 'CHECK ((round >= 1))',
    ck_external_verifications__status: `CHECK ((status = ANY (ARRAY['CREATED'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'ERROR'::text, 'CANCELLED'::text])))`,
    fk_external_verifications__case_requirement_id:
      'FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements(case_requirement_id) ON DELETE RESTRICT',
    pk_external_verifications: 'PRIMARY KEY (external_verification_id)',
    uq_external_verifications__external: 'UNIQUE (adapter, external_id)',
    uq_external_verifications__round: 'UNIQUE (case_requirement_id, round)',
  },
  reason_codes: {
    ck_reason_codes__applies_to: `CHECK ((applies_to = ANY (ARRAY['REJECT'::text, 'ACTION_REQUIRED'::text, 'BOTH'::text])))`,
    ck_reason_codes__code: `CHECK (((code ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'::text) AND ((length(code) >= 3) AND (length(code) <= 48))))`,
    ck_reason_codes__status: `CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])))`,
    fk_reason_codes__name_content_key: 'FOREIGN KEY (name_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    pk_reason_codes: 'PRIMARY KEY (reason_code_id)',
    uq_reason_codes__code: 'UNIQUE (code)',
  },
  requirement_definitions: {
    ck_requirement_definitions__code: `CHECK (((code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'::text) AND ((length(code) >= 2) AND (length(code) <= 48))))`,
    ck_requirement_definitions__evidence_kind: `CHECK ((evidence_kind = ANY (ARRAY['DOCUMENT'::text, 'EXTERNAL'::text])))`,
    ck_requirement_definitions__status: `CHECK ((status = ANY (ARRAY['INACTIVE'::text, 'ACTIVE'::text, 'RETIRED'::text])))`,
    ck_requirement_definitions__type: `CHECK ((requirement_type = ANY (ARRAY['IDENTITY'::text, 'BACKGROUND_CHECK'::text, 'LICENSE'::text, 'INSURANCE'::text, 'CERTIFICATION'::text, 'BUSINESS_REGISTRATION'::text, 'OTHER_DOCUMENT'::text])))`,
    fk_requirement_definitions__instructions_content_key: 'FOREIGN KEY (instructions_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    fk_requirement_definitions__name_content_key: 'FOREIGN KEY (name_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
    pk_requirement_definitions: 'PRIMARY KEY (requirement_definition_id)',
    uq_requirement_definitions__code: 'UNIQUE (code)',
  },
  requirement_rules: {
    fk_requirement_rules__definition_id:
      'FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions(requirement_definition_id) ON DELETE RESTRICT',
    fk_requirement_rules__market_id: 'FOREIGN KEY (market_id) REFERENCES geography.markets(market_id) ON DELETE RESTRICT',
    fk_requirement_rules__service_type_id: 'FOREIGN KEY (service_type_id) REFERENCES catalog.service_types(service_type_id) ON DELETE RESTRICT',
    pk_requirement_rules: 'PRIMARY KEY (requirement_rule_id)',
    uq_requirement_rules__scope: 'UNIQUE NULLS NOT DISTINCT (requirement_definition_id, market_id, service_type_id)',
  },
  reviews: {
    ck_reviews__decision: `CHECK ((decision = ANY (ARRAY['STARTED'::text, 'APPROVED'::text, 'REJECTED'::text, 'ACTION_REQUIRED'::text])))`,
    ck_reviews__expires: `CHECK (((expires_at IS NULL) OR (decision = 'APPROVED'::text)))`,
    ck_reviews__reason: `CHECK ((((decision = ANY (ARRAY['STARTED'::text, 'APPROVED'::text])) AND (reason_code IS NULL)) OR ((decision = ANY (ARRAY['REJECTED'::text, 'ACTION_REQUIRED'::text])) AND (reason_code IS NOT NULL))))`,
    ck_reviews__reviewer: `CHECK ((reviewer ~ '^(admin|external):[A-Za-z0-9._:@-]{1,160}$'::text))`,
    ck_reviews__round: 'CHECK ((round >= 1))',
    fk_reviews__case_requirement_id: 'FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements(case_requirement_id) ON DELETE RESTRICT',
    fk_reviews__reason_code: 'FOREIGN KEY (reason_code) REFERENCES trust.reason_codes(code) ON DELETE RESTRICT',
    pk_reviews: 'PRIMARY KEY (review_id)',
  },
  verification_cases: {
    ck_verification_cases__lifecycle: `CHECK ((((status = 'OPEN'::text) AND (submitted_at IS NULL) AND (decided_at IS NULL) AND (cancelled_at IS NULL)) OR ((status = ANY (ARRAY['IN_REVIEW'::text, 'ACTION_REQUIRED'::text, 'EXPIRED'::text])) AND (submitted_at IS NOT NULL) AND (cancelled_at IS NULL)) OR ((status = 'APPROVED'::text) AND (submitted_at IS NOT NULL) AND (decided_at IS NOT NULL) AND (cancelled_at IS NULL)) OR ((status = 'CANCELLED'::text) AND (cancelled_at IS NOT NULL))))`,
    ck_verification_cases__number: 'CHECK ((case_number >= 1))',
    ck_verification_cases__revision: 'CHECK ((revision >= 1))',
    ck_verification_cases__status: `CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_REVIEW'::text, 'ACTION_REQUIRED'::text, 'APPROVED'::text, 'EXPIRED'::text, 'CANCELLED'::text])))`,
    fk_verification_cases__account_id: 'FOREIGN KEY (account_id) REFERENCES identity.accounts(account_id) ON DELETE RESTRICT',
    pk_verification_cases: 'PRIMARY KEY (verification_case_id)',
    uq_verification_cases__number: 'UNIQUE (account_id, case_number)',
  },
};
const FK_TARGETS: Record<string, string> = {
  fk_audit_events__case_id: 'trust.verification_cases',
  fk_audit_events__case_requirement_id: 'trust.case_requirements',
  fk_audit_events__definition_id: 'trust.requirement_definitions',
  fk_case_requirements__case_id: 'trust.verification_cases',
  fk_case_requirements__definition_id: 'trust.requirement_definitions',
  fk_document_types__name_content_key: 'content.entries',
  fk_documents__case_requirement_id: 'trust.case_requirements',
  fk_documents__document_type_id: 'trust.document_types',
  fk_external_verifications__case_requirement_id: 'trust.case_requirements',
  fk_reason_codes__name_content_key: 'content.entries',
  fk_requirement_definitions__instructions_content_key: 'content.entries',
  fk_requirement_definitions__name_content_key: 'content.entries',
  fk_requirement_rules__definition_id: 'trust.requirement_definitions',
  fk_requirement_rules__market_id: 'geography.markets',
  fk_requirement_rules__service_type_id: 'catalog.service_types',
  fk_reviews__case_requirement_id: 'trust.case_requirements',
  fk_reviews__reason_code: 'trust.reason_codes',
  fk_verification_cases__account_id: 'identity.accounts',
};
const INDEX_DEFS: Record<string, Record<string, string>> = {
  audit_events: {
    pk_audit_events: 'CREATE UNIQUE INDEX pk_audit_events ON trust.audit_events USING btree (audit_event_id)',
  },
  case_requirements: {
    idx_case_requirements__expiry: `CREATE INDEX idx_case_requirements__expiry ON trust.case_requirements USING btree (expires_at, case_requirement_id) WHERE ((status = 'APPROVED'::text) AND (expires_at IS NOT NULL) AND (superseded_at IS NULL))`,
    idx_case_requirements__queue: `CREATE INDEX idx_case_requirements__queue ON trust.case_requirements USING btree (updated_at, case_requirement_id) WHERE ((status = ANY (ARRAY['PENDING'::text, 'IN_REVIEW'::text])) AND (superseded_at IS NULL))`,
    pk_case_requirements: 'CREATE UNIQUE INDEX pk_case_requirements ON trust.case_requirements USING btree (case_requirement_id)',
    uq_case_requirements__current:
      'CREATE UNIQUE INDEX uq_case_requirements__current ON trust.case_requirements USING btree (verification_case_id, requirement_definition_id) WHERE (superseded_at IS NULL)',
    uq_case_requirements__cycle:
      'CREATE UNIQUE INDEX uq_case_requirements__cycle ON trust.case_requirements USING btree (verification_case_id, requirement_definition_id, cycle)',
  },
  document_types: {
    pk_document_types: 'CREATE UNIQUE INDEX pk_document_types ON trust.document_types USING btree (document_type_id)',
    uq_document_types__code: 'CREATE UNIQUE INDEX uq_document_types__code ON trust.document_types USING btree (code)',
  },
  documents: {
    idx_documents__requirement: 'CREATE INDEX idx_documents__requirement ON trust.documents USING btree (case_requirement_id, created_at)',
    pk_documents: 'CREATE UNIQUE INDEX pk_documents ON trust.documents USING btree (verification_document_id)',
    uq_documents__object_key: 'CREATE UNIQUE INDEX uq_documents__object_key ON trust.documents USING btree (object_key)',
  },
  external_verifications: {
    pk_external_verifications: 'CREATE UNIQUE INDEX pk_external_verifications ON trust.external_verifications USING btree (external_verification_id)',
    uq_external_verifications__external:
      'CREATE UNIQUE INDEX uq_external_verifications__external ON trust.external_verifications USING btree (adapter, external_id)',
    uq_external_verifications__round:
      'CREATE UNIQUE INDEX uq_external_verifications__round ON trust.external_verifications USING btree (case_requirement_id, round)',
  },
  reason_codes: {
    pk_reason_codes: 'CREATE UNIQUE INDEX pk_reason_codes ON trust.reason_codes USING btree (reason_code_id)',
    uq_reason_codes__code: 'CREATE UNIQUE INDEX uq_reason_codes__code ON trust.reason_codes USING btree (code)',
  },
  requirement_definitions: {
    pk_requirement_definitions: 'CREATE UNIQUE INDEX pk_requirement_definitions ON trust.requirement_definitions USING btree (requirement_definition_id)',
    uq_requirement_definitions__code: 'CREATE UNIQUE INDEX uq_requirement_definitions__code ON trust.requirement_definitions USING btree (code)',
  },
  requirement_rules: {
    pk_requirement_rules: 'CREATE UNIQUE INDEX pk_requirement_rules ON trust.requirement_rules USING btree (requirement_rule_id)',
    uq_requirement_rules__scope:
      'CREATE UNIQUE INDEX uq_requirement_rules__scope ON trust.requirement_rules USING btree (requirement_definition_id, market_id, service_type_id) NULLS NOT DISTINCT',
  },
  reviews: {
    idx_reviews__requirement: 'CREATE INDEX idx_reviews__requirement ON trust.reviews USING btree (case_requirement_id, reviewed_at)',
    pk_reviews: 'CREATE UNIQUE INDEX pk_reviews ON trust.reviews USING btree (review_id)',
    uq_reviews__decision: `CREATE UNIQUE INDEX uq_reviews__decision ON trust.reviews USING btree (case_requirement_id, round) WHERE (decision <> 'STARTED'::text)`,
    uq_reviews__started: `CREATE UNIQUE INDEX uq_reviews__started ON trust.reviews USING btree (case_requirement_id, round) WHERE (decision = 'STARTED'::text)`,
  },
  verification_cases: {
    idx_verification_cases__queue: `CREATE INDEX idx_verification_cases__queue ON trust.verification_cases USING btree (submitted_at, verification_case_id) WHERE (status = 'IN_REVIEW'::text)`,
    pk_verification_cases: 'CREATE UNIQUE INDEX pk_verification_cases ON trust.verification_cases USING btree (verification_case_id)',
    uq_verification_cases__live: `CREATE UNIQUE INDEX uq_verification_cases__live ON trust.verification_cases USING btree (account_id) WHERE (status <> 'CANCELLED'::text)`,
    uq_verification_cases__number: 'CREATE UNIQUE INDEX uq_verification_cases__number ON trust.verification_cases USING btree (account_id, case_number)',
  },
};
const TRIGGER_DEFS: Record<string, Record<string, string>> = {
  audit_events: {
    trg_audit_events__immutable:
      'CREATE TRIGGER trg_audit_events__immutable BEFORE DELETE OR UPDATE ON trust.audit_events FOR EACH ROW EXECUTE FUNCTION trust.forbid_mutation()',
    trg_audit_events__no_truncate:
      'CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON trust.audit_events FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  case_requirements: {
    trg_case_requirements__guard:
      'CREATE TRIGGER trg_case_requirements__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.case_requirements FOR EACH ROW EXECUTE FUNCTION trust.guard_case_requirements()',
    trg_case_requirements__no_truncate:
      'CREATE TRIGGER trg_case_requirements__no_truncate BEFORE TRUNCATE ON trust.case_requirements FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  document_types: {
    trg_document_types__guard:
      'CREATE TRIGGER trg_document_types__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.document_types FOR EACH ROW EXECUTE FUNCTION trust.guard_document_types()',
    trg_document_types__no_truncate:
      'CREATE TRIGGER trg_document_types__no_truncate BEFORE TRUNCATE ON trust.document_types FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  documents: {
    trg_documents__guard:
      'CREATE TRIGGER trg_documents__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.documents FOR EACH ROW EXECUTE FUNCTION trust.guard_documents()',
    trg_documents__no_truncate:
      'CREATE TRIGGER trg_documents__no_truncate BEFORE TRUNCATE ON trust.documents FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  external_verifications: {
    trg_external_verifications__guard:
      'CREATE TRIGGER trg_external_verifications__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.external_verifications FOR EACH ROW EXECUTE FUNCTION trust.guard_external_verifications()',
    trg_external_verifications__no_truncate:
      'CREATE TRIGGER trg_external_verifications__no_truncate BEFORE TRUNCATE ON trust.external_verifications FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  reason_codes: {
    trg_reason_codes__guard:
      'CREATE TRIGGER trg_reason_codes__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.reason_codes FOR EACH ROW EXECUTE FUNCTION trust.guard_reason_codes()',
    trg_reason_codes__no_truncate:
      'CREATE TRIGGER trg_reason_codes__no_truncate BEFORE TRUNCATE ON trust.reason_codes FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  requirement_definitions: {
    trg_requirement_definitions__guard:
      'CREATE TRIGGER trg_requirement_definitions__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.requirement_definitions FOR EACH ROW EXECUTE FUNCTION trust.guard_requirement_definitions()',
    trg_requirement_definitions__no_truncate:
      'CREATE TRIGGER trg_requirement_definitions__no_truncate BEFORE TRUNCATE ON trust.requirement_definitions FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  requirement_rules: {
    trg_requirement_rules__guard:
      'CREATE TRIGGER trg_requirement_rules__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.requirement_rules FOR EACH ROW EXECUTE FUNCTION trust.guard_requirement_rules()',
    trg_requirement_rules__no_truncate:
      'CREATE TRIGGER trg_requirement_rules__no_truncate BEFORE TRUNCATE ON trust.requirement_rules FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  reviews: {
    trg_reviews__guard: 'CREATE TRIGGER trg_reviews__guard BEFORE INSERT ON trust.reviews FOR EACH ROW EXECUTE FUNCTION trust.guard_reviews()',
    trg_reviews__immutable:
      'CREATE TRIGGER trg_reviews__immutable BEFORE DELETE OR UPDATE ON trust.reviews FOR EACH ROW EXECUTE FUNCTION trust.forbid_mutation()',
    trg_reviews__no_truncate:
      'CREATE TRIGGER trg_reviews__no_truncate BEFORE TRUNCATE ON trust.reviews FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
  verification_cases: {
    trg_verification_cases__guard:
      'CREATE TRIGGER trg_verification_cases__guard BEFORE INSERT OR DELETE OR UPDATE ON trust.verification_cases FOR EACH ROW EXECUTE FUNCTION trust.guard_verification_cases()',
    trg_verification_cases__no_truncate:
      'CREATE TRIGGER trg_verification_cases__no_truncate BEFORE TRUNCATE ON trust.verification_cases FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation()',
  },
};
/** The rule keys each function can raise (the documented contract of the SQLSTATE 23000 details). */
const RULES_BY_FUNCTION: Record<string, string[]> = {
  forbid_mutation: ['ROW_IMMUTABLE'],
  guard_case_requirements: [
    'CASE_FROZEN',
    'CYCLE_NEEDS_EXPIRED',
    'CYCLE_SEQUENCE',
    'EXPIRY_IN_PAST',
    'EXPIRY_NOT_REACHED',
    'EXPIRY_REQUIRED',
    'FIELDS_FROZEN',
    'IMMUTABLE_IDENTITY',
    'MUST_START_NOT_STARTED',
    'NOT_DELETABLE',
    'REQUIREMENT_NOT_ACTIVE',
    'REVISION_ONLY_GROWS',
    'ROUND_SEQUENCE',
    'STATUS_TRANSITION',
    'SUPERSEDED_FROZEN',
    'SUPERSEDE_STATE',
  ],
  guard_document_types: ['IMMUTABLE_IDENTITY', 'NOT_DELETABLE'],
  guard_documents: [
    'CASE_FROZEN',
    'DOCUMENT_FROZEN',
    'DOCUMENT_MUST_START_PENDING',
    'DOCUMENT_NOT_SUPPORTED',
    'DOCUMENT_REQUIREMENT_STATE',
    'DOCUMENT_ROUND',
    'DOCUMENT_TYPE_MISMATCH',
    'HASH_IMMUTABLE',
    'IMMUTABLE_IDENTITY',
    'NOT_DELETABLE',
    'SCAN_TRANSITION',
    'STATUS_TRANSITION',
  ],
  guard_external_verifications: ['CASE_FROZEN', 'EXTERNAL_FROZEN', 'EXTERNAL_NOT_SUPPORTED', 'EXTERNAL_STATE', 'IMMUTABLE_IDENTITY', 'NOT_DELETABLE'],
  guard_reason_codes: ['IMMUTABLE_IDENTITY', 'NOT_DELETABLE'],
  guard_requirement_definitions: ['IMMUTABLE_IDENTITY', 'INITIAL_STATUS', 'NOT_DELETABLE', 'STATUS_TRANSITION'],
  guard_requirement_rules: ['IMMUTABLE_IDENTITY', 'NOT_DELETABLE', 'RULE_DEFINITION_RETIRED'],
  guard_reviews: ['CASE_FROZEN', 'REASON_INACTIVE', 'REASON_NOT_APPLICABLE', 'REVIEW_EXPIRY', 'REVIEW_ROUND', 'REVIEW_STATE', 'REVIEW_SUPERSEDED'],
  guard_verification_cases: [
    'ACCOUNT_NOT_ACTIVE',
    'CASE_FROZEN',
    'CASE_MUST_START_OPEN',
    'CASE_NUMBER_SEQUENCE',
    'IMMUTABLE_IDENTITY',
    'NOT_DELETABLE',
    'REVISION_ONLY_GROWS',
    'STATUS_TRANSITION',
  ],
};
/** The 40 distinct keys of the whole schema (the design lists them; a key that is raised but not listed, or listed but never raised, is a drift). */
const ALL_RULE_KEYS = [
  'ACCOUNT_NOT_ACTIVE',
  'CASE_FROZEN',
  'CASE_MUST_START_OPEN',
  'CASE_NUMBER_SEQUENCE',
  'CYCLE_NEEDS_EXPIRED',
  'CYCLE_SEQUENCE',
  'DOCUMENT_FROZEN',
  'DOCUMENT_MUST_START_PENDING',
  'DOCUMENT_NOT_SUPPORTED',
  'DOCUMENT_REQUIREMENT_STATE',
  'DOCUMENT_ROUND',
  'DOCUMENT_TYPE_MISMATCH',
  'EXPIRY_IN_PAST',
  'EXPIRY_NOT_REACHED',
  'EXPIRY_REQUIRED',
  'EXTERNAL_FROZEN',
  'EXTERNAL_NOT_SUPPORTED',
  'EXTERNAL_STATE',
  'FIELDS_FROZEN',
  'HASH_IMMUTABLE',
  'IMMUTABLE_IDENTITY',
  'INITIAL_STATUS',
  'MUST_START_NOT_STARTED',
  'NOT_DELETABLE',
  'REASON_INACTIVE',
  'REASON_NOT_APPLICABLE',
  'REQUIREMENT_NOT_ACTIVE',
  'REVIEW_EXPIRY',
  'REVIEW_ROUND',
  'REVIEW_STATE',
  'REVIEW_SUPERSEDED',
  'REVISION_ONLY_GROWS',
  'ROUND_SEQUENCE',
  'ROW_IMMUTABLE',
  'RULE_DEFINITION_RETIRED',
  'SCAN_TRANSITION',
  'STATUS_TRANSITION',
  'SUPERSEDED_FROZEN',
  'SUPERSEDE_STATE',
];
const FUNCTIONS = Object.keys(RULES_BY_FUNCTION)
  .sort(byName)
  .map((proname) => ({ proname, args: '', volatility: 'v', result: 'trigger' }));
/** The columns that carry a comment in the catalog (the others are self-explanatory), as the migration documents them. */
const COMMENTED_COLUMNS = [
  'audit_events.actor',
  'case_requirements.expires_at',
  'case_requirements.round',
  'case_requirements.status',
  'case_requirements.superseded_at',
  'document_types.requirement_type',
  'documents.object_key',
  'documents.round',
  'documents.scan_status',
  'documents.sha256',
  'documents.upload_expires_at',
  'external_verifications.external_id',
  'requirement_definitions.code',
  'requirement_definitions.evidence_kind',
  'requirement_definitions.expiry_required',
  'requirement_definitions.instructions_content_key',
  'requirement_definitions.name_content_key',
  'requirement_definitions.requirement_type',
  'requirement_definitions.status',
  'requirement_rules.market_id',
  'requirement_rules.service_type_id',
  'reviews.reviewer',
  'verification_cases.decided_at',
  'verification_cases.revision',
  'verification_cases.status',
  'verification_cases.submitted_at',
];

/** A fingerprint of every object of the database that does NOT belong to the trust schema (compared between 0018 and 0019). */
async function outsideTrust(from: pg.Pool) {
  const rows = async (text: string) => (await from.query(text)).rows.map((r) => JSON.stringify(r));
  const other = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'trust')";
  return {
    schemas: await rows("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'trust') ORDER BY 1"),
    relations: await rows(`SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} ORDER BY 1, 2`),
    columns: await rows(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression, ordinal_position FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'trust') ORDER BY table_schema, table_name, ordinal_position`,
    ),
    constraints: await rows(
      `SELECT n.nspname, t.relname, c.conname, c.contype, c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, c.conname COLLATE "C"`,
    ),
    indexes: await rows(
      `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'trust') ORDER BY schemaname, tablename, indexname COLLATE "C"`,
    ),
    triggers: await rows(
      `SELECT n.nspname, t.relname, g.tgname, g.tgenabled, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT g.tgisinternal AND ${other} ORDER BY n.nspname, t.relname, g.tgname COLLATE "C"`,
    ),
    functions: await rows(
      `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, p.prosecdef, obj_description(p.oid, 'pg_proc') AS comment FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'trust') AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname, args`,
    ),
    comments: await rows(
      `SELECT n.nspname, t.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class t ON t.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${other} ORDER BY n.nspname, t.relname, d.objsubid`,
    ),
    schemaComments: await rows(
      "SELECT nspname, obj_description(oid, 'pg_namespace') AS comment, nspacl::text AS acl FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'trust') ORDER BY 1",
    ),
    acls: await rows(
      `SELECT n.nspname, c.relname, c.relacl::text AS acl, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${other} AND c.relkind IN ('r', 'v', 'S') ORDER BY 1, 2`,
    ),
  };
}
/** Row counts of every ordinary table outside the trust schema. */
async function rowCounts(from: pg.Pool): Promise<Record<string, number>> {
  const r = await from.query(
    `SELECT n.nspname || '.' || c.relname AS t,
            (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'trust') AND n.nspname NOT LIKE 'pg_%' ORDER BY 1`,
  );
  return Object.fromEntries((r.rows as { t: string; n: number }[]).map((x) => [x.t, x.n]));
}
/** What migration 0019 ADDS to the rows of the older tables: six configuration parameters (6 audit rows each) and 97 content entries (5 audit rows each). */
const EXPECTED_ROW_DELTAS: Record<string, number> = {
  'configuration.audit_events': 36,
  'configuration.change_approvals': 6,
  'configuration.change_requests': 6,
  'configuration.parameter_scopes': 6,
  'configuration.parameter_values': 6,
  'configuration.parameters': 6,
  'configuration.value_versions': 6,
  'content.audit_events': 485,
  'content.entries': 97,
  'content.versions': 97,
};

describe('A. schema shape: ten tables, ten functions and 21 triggers in a new schema, an immutable review and audit trail, holding nothing about a person', () => {
  it('creates the trust schema with exactly ten tables and 28 indexes; no sequence, view, materialized view, partition, composite type, policy, rule, inheritance or ACL; everything is owned by the role that owns the catalogue', async () => {
    expect(
      await q(
        "SELECT nspname, obj_description(oid, 'pg_namespace') IS NOT NULL AS commented, nspacl IS NULL AS no_acl FROM pg_namespace WHERE nspname = 'trust'",
      ),
    ).toEqual([{ nspname: 'trust', commented: true, no_acl: true }]);
    expect(
      (
        await q<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'trust' AND table_type = 'BASE TABLE' ORDER BY 1",
        )
      ).map((r) => r.table_name),
    ).toEqual(
      [
        'audit_events',
        'case_requirements',
        'document_types',
        'documents',
        'external_verifications',
        'reason_codes',
        'requirement_definitions',
        'requirement_rules',
        'reviews',
        'verification_cases',
      ].sort(byName),
    );
    // every relation of the schema: ten ordinary tables and 28 indexes (10 primary keys + 9 unique keys + 9 further indexes, seven of them partial); nothing else
    expect(await q("SELECT relkind, count(*)::int AS n FROM pg_class WHERE relnamespace = 'trust'::regnamespace GROUP BY 1 ORDER BY 1")).toEqual([
      { relkind: 'i', n: 28 },
      { relkind: 'r', n: 10 },
    ]);
    expect(
      await q("SELECT t.typname FROM pg_type t WHERE t.typnamespace = 'trust'::regnamespace AND t.typtype NOT IN ('c') AND t.typname NOT LIKE '\\_%'"),
    ).toEqual([]);
    expect(
      await q(
        "SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'trust'::regnamespace AND c.relkind IN ('r', 'i') AND (c.relacl IS NOT NULL OR c.relrowsecurity OR c.relispartition OR c.relhasrules OR c.relhassubclass)",
      ),
    ).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'trust'::regnamespace)")).toEqual(
      [{ n: 0 }],
    );
    expect(
      await q("SELECT count(*)::int AS n FROM pg_inherits WHERE inhrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'trust'::regnamespace)"),
    ).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclnamespace = 'trust'::regnamespace")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'trust'::regnamespace AND proacl IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(
      await q(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'catalog.categories'::regclass) AS same_owner
           FROM pg_class c WHERE c.relnamespace = 'trust'::regnamespace`,
      ),
    ).toEqual([{ same_owner: true }]);
    expect(await q("SELECT DISTINCT pg_get_userbyid(c.relowner) = current_user AS mine FROM pg_class c WHERE c.relnamespace = 'trust'::regnamespace")).toEqual([
      { mine: true },
    ]);
    expect(await q("SELECT pg_get_userbyid(nspowner) = current_user AS mine FROM pg_namespace WHERE nspname = 'trust'")).toEqual([{ mine: true }]);
    expect(await q("SELECT DISTINCT pg_get_userbyid(proowner) = current_user AS mine FROM pg_proc WHERE pronamespace = 'trust'::regnamespace")).toEqual([
      { mine: true },
    ]);
  });

  it.each(Object.entries(COLUMNS_BY_TABLE))('has exactly the documented columns, types, nullability and defaults on %s', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it('has 101 columns in the ten tables, and exactly four generated columns (the content keys, stored, derived from the code) and no identity column', async () => {
    expect(Object.values(COLUMNS_BY_TABLE).reduce((a, c) => a + c.length, 0)).toBe(101);
    expect(await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'trust'")).toEqual([{ n: 101 }]);
    expect(
      await q<{ table_name: string; column_name: string; generation_expression: string; is_generated: string }>(
        `SELECT table_name, column_name, generation_expression, is_generated FROM information_schema.columns WHERE table_schema = 'trust' AND is_generated <> 'NEVER' ORDER BY 1, 2`,
      ),
    ).toEqual(
      GENERATED.map(([table_name, column_name, generation_expression]) => ({ table_name, column_name, generation_expression, is_generated: 'ALWAYS' })),
    );
    expect(
      await q(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'trust'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> ''`,
      ),
    ).toEqual([]);
    expect(
      await q(
        `SELECT c.relname, a.attname, a.attgenerated FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'trust'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '' AND a.attgenerated <> 's'`,
      ),
    ).toEqual([]);
  });

  it.each(Object.entries(CONSTRAINT_DEFS))(
    'defines every constraint of %s exactly as documented (names and definition text), and no other',
    async (table, defs) => {
      const rows = await constraintsOf(`trust.${table}`);
      expect(rows.map((r) => r.conname)).toEqual(Object.keys(defs).sort(byName));
      expect(Object.fromEntries(rows.map((r) => [r.conname, r.def]))).toEqual(defs);
      expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true); // none deferrable, none NOT VALID
    },
  );

  it('has 78 primary key, unique, foreign key and check constraints (10 + 9 + 18 + 41) and no exclusion constraint', async () => {
    const n = await q<{ contype: string; n: number }>(
      "SELECT c.contype, count(*)::int AS n FROM pg_constraint c WHERE c.connamespace = 'trust'::regnamespace GROUP BY 1 ORDER BY 1",
    );
    expect(n).toEqual([
      { contype: 'c', n: 41 },
      { contype: 'f', n: 18 },
      { contype: 'p', n: 10 },
      { contype: 'u', n: 9 },
    ]);
    expect(Object.values(CONSTRAINT_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(78);
    expect(Object.keys(FK_TARGETS)).toHaveLength(18);
  });

  it('names every NOT NULL column as documented (the nullable columns are the optional timestamps, the optional market and service type, the hash, the round of a draft, the audit subject columns and the reason)', async () => {
    const nullable = Object.fromEntries(Object.entries(COLUMNS_BY_TABLE).map(([t, cols]) => [t, cols.filter((c) => c[2]).map((c) => c[0])]));
    expect(nullable).toEqual({
      audit_events: ['verification_case_id', 'case_requirement_id', 'requirement_definition_id', 'changes', 'reason_code'],
      case_requirements: ['submitted_at', 'decided_at', 'approved_at', 'expires_at', 'superseded_at'],
      document_types: [],
      documents: ['sha256', 'round', 'finalized_at', 'scanned_at', 'submitted_at', 'withdrawn_at'],
      external_verifications: ['last_checked_at'],
      reason_codes: [],
      requirement_definitions: [],
      requirement_rules: ['market_id', 'service_type_id'],
      reviews: ['reason_code', 'expires_at'],
      verification_cases: ['submitted_at', 'decided_at', 'cancelled_at'],
    });
  });

  it('declares every foreign key ON DELETE RESTRICT and ON UPDATE NO ACTION with MATCH SIMPLE and the documented target; nothing in the trust schema cascades or sets null', async () => {
    const fks: ConstraintRow[] = [];
    for (const t of Object.keys(CONSTRAINT_DEFS)) fks.push(...(await constraintsOf(`trust.${t}`)).filter((r) => r.contype === 'f'));
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
    expect(fks).toHaveLength(18);
  });

  it.each(Object.entries(INDEX_DEFS))('has exactly the documented indexes on %s and no other', async (table, defs) => {
    const idx = await indexesOf(table);
    expect(Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))).toEqual(defs);
    expect(idx.map((r) => r.indexname)).toEqual(Object.keys(defs).sort(byName));
  });

  it('has exactly 28 indexes in the schema, seven of them partial, one NULLS NOT DISTINCT; none on the reference columns the migration deliberately leaves out; the foreign key columns WITHOUT a supporting index are exactly the twelve it documents', async () => {
    expect(Object.values(INDEX_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(28);
    expect(
      (
        await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'trust' AND indexdef ~ ' WHERE ' ORDER BY indexname COLLATE \"C\"")
      ).map((r) => r.indexname),
    ).toEqual([
      'idx_case_requirements__expiry',
      'idx_case_requirements__queue',
      'idx_verification_cases__queue',
      'uq_case_requirements__current',
      'uq_reviews__decision',
      'uq_reviews__started',
      'uq_verification_cases__live',
    ]);
    expect(
      (await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'trust' AND indexdef ~ 'NULLS NOT DISTINCT'")).map(
        (r) => r.indexname,
      ),
    ).toEqual(['uq_requirement_rules__scope']);
    expect(await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'trust' AND indexdef ~ 'INCLUDE'")).toEqual([]);
    expect(
      (
        await q<{ conname: string }>(
          `SELECT conname FROM pg_constraint c
            WHERE contype = 'f' AND connamespace = 'trust'::regnamespace
              AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`,
        )
      )
        .map((r) => r.conname)
        .sort(byName),
    ).toEqual([
      'fk_audit_events__case_id',
      'fk_audit_events__case_requirement_id',
      'fk_audit_events__definition_id',
      'fk_case_requirements__definition_id',
      'fk_document_types__name_content_key',
      'fk_documents__document_type_id',
      'fk_reason_codes__name_content_key',
      'fk_requirement_definitions__instructions_content_key',
      'fk_requirement_definitions__name_content_key',
      'fk_requirement_rules__market_id',
      'fk_requirement_rules__service_type_id',
      'fk_reviews__reason_code',
    ]);
  });

  it.each(Object.entries(TRIGGER_DEFS))(
    'wires the triggers of %s exactly (name, timing, events, level, function), enabled, none deferrable or constraint triggers',
    async (table, defs) => {
      const t = await triggersOf(`trust.${table}`);
      expect(Object.fromEntries(t.map((x) => [x.tgname, x.def]))).toEqual(defs);
      expect(t.every((x) => x.enabled === 'O')).toBe(true);
      expect(t.filter((x) => /CONSTRAINT TRIGGER|DEFERRABLE|AFTER|INSTEAD/.test(x.def))).toEqual([]);
    },
  );

  it('has exactly 21 triggers in the schema (a row guard and a TRUNCATE refusal per table, and the reviews and the audit trail also refuse UPDATE and DELETE), every one BEFORE, and no trigger of the trust schema on a table outside it', async () => {
    expect(
      (
        await q<{ tgname: string }>(
          "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = 'trust'::regnamespace AND NOT g.tgisinternal ORDER BY 1",
        )
      ).length,
    ).toBe(21);
    expect(Object.values(TRIGGER_DEFS).reduce((a, d) => a + Object.keys(d).length, 0)).toBe(21);
    expect(
      await q(
        "SELECT g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace <> 'trust'::regnamespace AND pg_get_triggerdef(g.oid) ~ 'trust\\.'",
      ),
    ).toEqual([]);
  });

  it('defines the ten functions as plpgsql trigger functions, VOLATILE, not SECURITY DEFINER, without a custom search_path, not leakproof or strict', async () => {
    const rows = await q<{ proname: string; args: string; volatility: string; result: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile AS volatility, pg_get_function_result(p.oid) AS result FROM pg_proc p WHERE p.pronamespace = 'trust'::regnamespace ORDER BY 1`,
    );
    expect(rows).toEqual(FUNCTIONS);
    expect(rows).toHaveLength(10);
    // every function carries a comment that names what it guards
    const comments = Object.fromEntries(
      (
        await q<{ proname: string; c: string | null }>(
          "SELECT proname, obj_description(oid, 'pg_proc') AS c FROM pg_proc WHERE pronamespace = 'trust'::regnamespace",
        )
      ).map((r) => [r.proname, r.c]),
    );
    const TABLE_OF: Record<string, string> = {
      guard_requirement_definitions: 'requirement_definitions',
      guard_document_types: 'document_types',
      guard_reason_codes: 'reason_codes',
      guard_requirement_rules: 'requirement_rules',
      guard_verification_cases: 'verification_cases',
      guard_case_requirements: 'case_requirements',
      guard_documents: 'documents',
      guard_reviews: 'reviews',
      guard_external_verifications: 'external_verifications',
    };
    expect(Object.keys(TABLE_OF)).toHaveLength(9);
    for (const [fn, table] of Object.entries(TABLE_OF)) expect(comments[fn], fn).toMatch(new RegExp(`^Guard of trust\\.${table}\\b`));
    expect(comments['forbid_mutation']).toMatch(/ROW_IMMUTABLE/);
    expect(comments['guard_documents']).toMatch(/the case is live/);
    expect(comments['guard_verification_cases']).toMatch(/cannot recompute the status/);
    expect(
      await q(
        `SELECT p.proname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.pronamespace = 'trust'::regnamespace AND (l.lanname <> 'plpgsql' OR p.prosecdef OR p.proconfig IS NOT NULL OR p.proleakproof OR p.proisstrict)`,
      ),
    ).toEqual([]);
  });

  it.each(Object.entries(RULES_BY_FUNCTION))(
    '%s raises exactly the documented rule keys, each with SQLSTATE 23000 (integrity_constraint_violation) and a DETAIL: no bare RAISE EXCEPTION',
    async (fn, keys) => {
      const r = (await q<{ prosrc: string }>("SELECT prosrc FROM pg_proc WHERE pronamespace = 'trust'::regnamespace AND proname = $1", [fn]))[0]!;
      const raised = [...new Set([...r.prosrc.matchAll(/trust_rule:([A-Z_]+)/g)].map((m) => m[1]!))].sort(byName);
      expect(raised).toEqual(keys);
      const raises = r.prosrc.match(/RAISE EXCEPTION/g) ?? [];
      expect(raises.length).toBeGreaterThanOrEqual(keys.length);
      expect(r.prosrc.match(/ERRCODE = 'integrity_constraint_violation'/g)?.length).toBe(raises.length);
      expect(r.prosrc.match(/DETAIL = 'trust_rule:[A-Z_]+'/g)?.length).toBe(raises.length);
    },
  );

  it('raises 39 distinct rule keys across the schema, and the union of the functions is exactly the documented list (so the keys the API maps cannot drift from the database)', async () => {
    const src = (await q<{ prosrc: string }>("SELECT prosrc FROM pg_proc WHERE pronamespace = 'trust'::regnamespace")).map((r) => r.prosrc).join('\n');
    const all = [...new Set([...src.matchAll(/trust_rule:([A-Z_]+)/g)].map((m) => m[1]!))].sort(byName);
    expect(all).toEqual([...ALL_RULE_KEYS].sort(byName));
    expect(all).toHaveLength(39);
    expect([...new Set(Object.values(RULES_BY_FUNCTION).flat())].sort(byName)).toEqual(all);
  });

  it('CHECKs every status vocabulary to exactly the contract list, so the database and the API cannot drift, and the default of each status column is the initial state the guard demands', async () => {
    const defs = async (table: string) => Object.fromEntries((await constraintsOf(`trust.${table}`)).map((r) => [r.conname, r.def]));
    const [d, dt, rc, cr, cs, doc, rev, ext, aud] = [
      await defs('requirement_definitions'),
      await defs('document_types'),
      await defs('reason_codes'),
      await defs('case_requirements'),
      await defs('verification_cases'),
      await defs('documents'),
      await defs('reviews'),
      await defs('external_verifications'),
      await defs('audit_events'),
    ];
    expect(vocab(d['ck_requirement_definitions__type']!)).toEqual([...TRUST_REQUIREMENT_TYPES]);
    expect(vocab(dt['ck_document_types__requirement_type']!)).toEqual([...TRUST_REQUIREMENT_TYPES]);
    expect(vocab(d['ck_requirement_definitions__evidence_kind']!)).toEqual([...TRUST_EVIDENCE_KINDS]);
    expect(vocab(d['ck_requirement_definitions__status']!)).toEqual([...TRUST_DEFINITION_STATUSES]);
    expect(vocab(cr['ck_case_requirements__status']!)).toEqual([...TRUST_REQUIREMENT_STATUSES]);
    expect(vocab(cs['ck_verification_cases__status']!)).toEqual([...TRUST_CASE_STATUSES]);
    expect(vocab(doc['ck_documents__status']!)).toEqual([...TRUST_DOCUMENT_STATUSES]);
    expect(vocab(doc['ck_documents__scan']!)).toEqual([...TRUST_SCAN_STATUSES]);
    expect(vocab(rev['ck_reviews__decision']!)).toEqual([...TRUST_REVIEW_DECISIONS]);
    expect(vocab(ext['ck_external_verifications__status']!)).toEqual([...TRUST_EXTERNAL_STATUSES]);
    expect(vocab(rc['ck_reason_codes__applies_to']!)).toEqual(['REJECT', 'ACTION_REQUIRED', 'BOTH']);
    expect(vocab(rc['ck_reason_codes__status']!)).toEqual(['ACTIVE', 'INACTIVE']);
    expect(vocab(dt['ck_document_types__status']!)).toEqual(['ACTIVE', 'INACTIVE']);
    expect(vocab(aud['ck_audit_events__action']!)).toEqual(AUDIT_ACTIONS);
    const dflt = async (table: string, column: string) => (await columnsOf(table)).find((c) => c[0] === column)![3];
    expect(await dflt('requirement_definitions', 'status')).toBe(`'${TRUST_DEFINITION_STATUSES[0]}'::text`);
    expect(await dflt('case_requirements', 'status')).toBe(`'${TRUST_REQUIREMENT_STATUSES[0]}'::text`);
    expect(await dflt('verification_cases', 'status')).toBe(`'${TRUST_CASE_STATUSES[0]}'::text`);
    expect(await dflt('documents', 'status')).toBe(`'${TRUST_DOCUMENT_STATUSES[0]}'::text`);
    expect(await dflt('documents', 'scan_status')).toBe(`'${TRUST_SCAN_STATUSES[0]}'::text`);
    expect(await dflt('external_verifications', 'status')).toBe(`'${TRUST_EXTERNAL_STATUSES[0]}'::text`);
    expect(await dflt('reason_codes', 'status')).toBe("'ACTIVE'::text");
    expect(await dflt('document_types', 'status')).toBe("'ACTIVE'::text");
    // the overall status the provider sees is the case status plus "nothing required" and "no case yet", which are never stored
    expect(TRUST_OVERALL_STATUSES.filter((s) => !(TRUST_CASE_STATUSES as readonly string[]).includes(s))).toEqual(['NOT_REQUIRED', 'NOT_STARTED']);
    expect(TRUST_CASE_STATUSES.filter((s) => !(TRUST_OVERALL_STATUSES as readonly string[]).includes(s))).toEqual(['CANCELLED']);
  });

  it('documents the schema, every table, the refusal function and the meaningful columns in the catalog (comments say what is never done: deleted, truncated, updated, stored in PostgreSQL)', async () => {
    for (const t of TABLES) expect(await commentOn(t), t).toBeTruthy();
    expect(await commentOn(DEF)).toMatch(/never deleted/);
    expect(await commentOn(DEF)).toMatch(/stable immutable code/);
    expect(await commentOn(DTYPE)).toMatch(/Never deleted/);
    expect(await commentOn(REASON)).toMatch(/no free text/);
    expect(await commentOn(RULE)).toMatch(/switched off, never deleted/);
    expect(await commentOn(CASES)).toMatch(/the provider is not a second account/);
    expect(await commentOn(CASES)).toMatch(/holds no copy of its contacts, name or profile/);
    expect(await commentOn(CASES)).toMatch(/APPROVED here is NOT Go-Live/);
    expect(await commentOn(CR)).toMatch(/No account id is stored/);
    expect(await commentOn(DOC)).toMatch(/bytes are NEVER in PostgreSQL/);
    expect(await commentOn(DOC)).toMatch(/No row is deleted/);
    expect(await commentOn(REV)).toMatch(/there is no free-text note column/);
    expect(await commentOn(REV)).toMatch(/Append-only/);
    expect(await commentOn(EXT)).toMatch(/No vendor payload/);
    expect(await commentOn(AUDIT)).toMatch(/never document content, an object key, a hash, a signed URL, a vendor payload or personal data/);
    expect(
      (
        await q<{ c: string }>(
          "SELECT obj_description(oid, 'pg_proc') AS c FROM pg_proc WHERE pronamespace = 'trust'::regnamespace AND proname = 'forbid_mutation'",
        )
      )[0]!.c,
    ).toMatch(/ROW_IMMUTABLE/);
    expect((await q<{ c: string }>("SELECT obj_description('trust'::regnamespace, 'pg_namespace') AS c"))[0]!.c).toMatch(/Go-Live is PRO-003/);
    const commented = await q<{ relname: string; attname: string }>(
      `SELECT c.relname, a.attname FROM pg_description d JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
        WHERE c.relnamespace = 'trust'::regnamespace AND d.objsubid > 0 ORDER BY 1, 2`,
    );
    expect(commented.map((r) => `${r.relname}.${r.attname}`)).toEqual(COMMENTED_COLUMNS);
    expect(await commentOn(DOC, 'object_key')).toMatch(/Never returned by an API, never logged, never in an event or an audit row/);
    expect(await commentOn(DOC, 'sha256')).toMatch(/never exposed to the provider/);
    expect(await commentOn(CR, 'round')).toMatch(/Incremented by the guard on every move to PENDING/);
    expect(await commentOn(CR, 'expires_at')).toMatch(/only once the time has passed/);
    expect(await commentOn(REV, 'reviewer')).toMatch(/No name/);
  });

  it('did not alter any older object: every column, constraint, index, trigger, function, relation, comment, ACL and owner outside the trust schema equals the schema migrated to 0018', async () => {
    const [a, b] = [await outsideTrust(basePool), await outsideTrust(seedPool)];
    for (const k of Object.keys(a) as (keyof typeof a)[]) {
      expect(b[k], k).toEqual(a[k]);
      expect(b[k].length, `${k} is not vacuous`).toBeGreaterThan(5);
    }
    expect(b.schemas.map((s) => JSON.parse(s).nspname)).toEqual(
      expect.arrayContaining(['identity', 'content', 'geography', 'configuration', 'integration', 'catalog', 'provider']),
    );
    expect(b.schemas.map((s) => JSON.parse(s).nspname)).not.toContain('trust');
    // and the only schema the migration adds is trust
    const schemas = async (from: pg.Pool) =>
      (await from.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1")).rows.map(
        (r) => r.nspname,
      );
    const older = await schemas(basePool);
    expect((await schemas(seedPool)).filter((s) => !older.includes(s))).toEqual(['trust']);
  });

  it('changes the rows of the older tables by exactly six configuration parameters and 97 content entries (with their versions, change requests, approvals and audit rows) and nothing else: no account, outbox event, market, role, locale or provider registration', async () => {
    const [x, y] = [await rowCounts(basePool), await rowCounts(seedPool)];
    expect(Object.keys(y)).toEqual(Object.keys(x)); // the same tables
    const ledger = y['public.schema_migrations']! - x['public.schema_migrations']!;
    expect(ledger).toBe(1); // the migration ledger records 0019 itself
    delete y['public.schema_migrations'];
    delete x['public.schema_migrations'];
    const delta = Object.fromEntries(
      Object.keys(y)
        .map((t) => [t, y[t]! - x[t]!])
        .filter(([, d]) => d !== 0),
    );
    expect(delta).toEqual(EXPECTED_ROW_DELTAS);
    expect(Object.keys(x).length).toBeGreaterThan(40);
    // the older rows themselves are the same: the keys of the older entries and parameters are identical
    const keys = async (from: pg.Pool) =>
      (
        await from.query(
          "SELECT 'content' AS k, key FROM content.entries WHERE key NOT LIKE 'trust.%' UNION ALL SELECT 'configuration', key FROM configuration.parameters WHERE key NOT LIKE 'trust.%' ORDER BY 1, 2",
        )
      ).rows;
    expect(await keys(seedPool)).toEqual(await keys(basePool));
    // the trust tables hold exactly the reference data the migration seeds and no case, requirement, document, review, external reference or audit row
    const seeded = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t, 'true', [], seedPool)] as const)));
    expect(seeded).toEqual({
      [AUDIT]: 0,
      [REV]: 0,
      [EXT]: 0,
      [DOC]: 0,
      [CR]: 0,
      [CASES]: 0,
      [RULE]: 1,
      [REASON]: 7,
      [DTYPE]: 7,
      [DEF]: 4,
    });
    // the seed emitted no outbox event (the seeds run before any consumer exists) and no account audit
    expect(await count('integration.outbox_events', 'true', [], seedPool)).toBe(await count('integration.outbox_events', 'true', [], basePool));
    expect(await count('identity.account_audit_events', 'true', [], seedPool)).toBe(await count('identity.account_audit_events', 'true', [], basePool));
  });

  it('is referenced by nothing outside the schema and references only identity.accounts, geography.markets, catalog.service_types, content.entries and itself', async () => {
    expect(
      await q(
        `SELECT conrelid::regclass::text AS from_table, conname FROM pg_constraint
          WHERE contype = 'f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'trust'::regnamespace) AND connamespace <> 'trust'::regnamespace`,
      ),
    ).toEqual([]);
    expect(
      (
        await q<{ target: string }>(
          `SELECT DISTINCT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND connamespace = 'trust'::regnamespace AND confrelid::regclass::text NOT LIKE 'trust.%' ORDER BY 1`,
        )
      ).map((r) => r.target),
    ).toEqual(['catalog.service_types', 'content.entries', 'geography.markets', 'identity.accounts']);
    // the trust schema references the account by id only: the one foreign key into identity is the case's account
    expect(
      await q(
        `SELECT conrelid::regclass::text AS from_table, conname FROM pg_constraint WHERE contype = 'f' AND connamespace = 'trust'::regnamespace AND confrelid = 'identity.accounts'::regclass`,
      ),
    ).toEqual([{ from_table: 'trust.verification_cases', conname: 'fk_verification_cases__account_id' }]);
    // no view, function or trigger outside the schema names a trust table (nothing else depends on it yet)
    expect(
      await q(
        "SELECT count(*)::int AS n FROM pg_depend d JOIN pg_class c ON c.oid = d.refobjid WHERE c.relnamespace = 'trust'::regnamespace AND d.classid = 'pg_rewrite'::regclass",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('contains no ALTER, DROP, DELETE, GRANT or REVOKE in the migration text and touches no older object but through the two seed workflows', () => {
    const text = migration19();
    expect(text).toMatch(/^-- checkpoint: TRUST-001$/m);
    expect(text).toMatch(/^-- destructive: none$/m);
    const body = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT ON'))
      .join('\n');
    expect(body).not.toMatch(
      /\b(ALTER\s|DROP\s|DELETE\s+FROM|GRANT\s|REVOKE\s|CREATE\s+(OR\s+REPLACE\s+)?VIEW|CREATE\s+SEQUENCE|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+POLICY|CREATE\s+RULE)/i,
    );
    expect(body.replace(/BEFORE TRUNCATE/gi, '')).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\b(pg_notify|NOTIFY|outbox_events|SECURITY\s+DEFINER|search_path)\b/i);
    expect(
      [...body.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(SCHEMA|TABLE|FUNCTION|TRIGGER|INDEX)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`),
    ).toEqual([
      'SCHEMA trust',
      'FUNCTION trust.forbid_mutation',
      'TABLE trust.requirement_definitions',
      'TABLE trust.document_types',
      'TABLE trust.reason_codes',
      'TABLE trust.requirement_rules',
      'TABLE trust.verification_cases',
      'INDEX uq_verification_cases__live',
      'INDEX idx_verification_cases__queue',
      'TABLE trust.case_requirements',
      'INDEX uq_case_requirements__current',
      'INDEX idx_case_requirements__queue',
      'INDEX idx_case_requirements__expiry',
      'TABLE trust.documents',
      'INDEX idx_documents__requirement',
      'TABLE trust.reviews',
      'INDEX uq_reviews__decision',
      'INDEX uq_reviews__started',
      'INDEX idx_reviews__requirement',
      'TABLE trust.external_verifications',
      'TABLE trust.audit_events',
      'FUNCTION trust.guard_requirement_definitions',
      'TRIGGER trg_requirement_definitions__guard',
      'TRIGGER trg_requirement_definitions__no_truncate',
      'FUNCTION trust.guard_document_types',
      'TRIGGER trg_document_types__guard',
      'TRIGGER trg_document_types__no_truncate',
      'FUNCTION trust.guard_reason_codes',
      'TRIGGER trg_reason_codes__guard',
      'TRIGGER trg_reason_codes__no_truncate',
      'FUNCTION trust.guard_requirement_rules',
      'TRIGGER trg_requirement_rules__guard',
      'TRIGGER trg_requirement_rules__no_truncate',
      'FUNCTION trust.guard_verification_cases',
      'TRIGGER trg_verification_cases__guard',
      'TRIGGER trg_verification_cases__no_truncate',
      'FUNCTION trust.guard_case_requirements',
      'TRIGGER trg_case_requirements__guard',
      'TRIGGER trg_case_requirements__no_truncate',
      'FUNCTION trust.guard_documents',
      'TRIGGER trg_documents__guard',
      'TRIGGER trg_documents__no_truncate',
      'FUNCTION trust.guard_reviews',
      'TRIGGER trg_reviews__guard',
      'TRIGGER trg_reviews__immutable',
      'TRIGGER trg_reviews__no_truncate',
      'FUNCTION trust.guard_external_verifications',
      'TRIGGER trg_external_verifications__guard',
      'TRIGGER trg_external_verifications__no_truncate',
      'TRIGGER trg_audit_events__immutable',
      'TRIGGER trg_audit_events__no_truncate',
    ]);
    // the only UPDATEs are the workflow steps of the seeds (configuration change request states, content version states); the seeds INSERT only into configuration, content and the reference tables
    const tally = (xs: (string | undefined)[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k!]: (a[k!] ?? 0) + 1 }), {});
    expect(tally([...body.matchAll(/^\s*UPDATE\s+([a-z_]+\.[a-z_]+)/gim)].map((m) => m[1]))).toEqual({
      'configuration.change_requests': 3,
      'content.versions': 2,
    });
    expect(tally([...body.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1]))).toEqual({
      'configuration.parameters': 1,
      'configuration.parameter_scopes': 1,
      'configuration.audit_events': 6,
      'configuration.change_requests': 1,
      'configuration.change_approvals': 1,
      'configuration.parameter_values': 1,
      'configuration.value_versions': 1,
      'content.entries': 1,
      'content.audit_events': 5,
      'content.versions': 1,
      'trust.requirement_definitions': 1,
      'trust.document_types': 1,
      'trust.reason_codes': 1,
      'trust.requirement_rules': 1,
    });
  });
});

// ====================================================================== B. the seeds: six evidence policy parameters, the reference data and the copy of the minimal flow, through the real workflows
const SEED_CONTENT: [key: string, type: 'UI_LABEL' | 'PLAIN_TEXT', body: string][] = [
  ['trust.requirement.identity_verification.name', 'UI_LABEL', 'Identity verification'],
  [
    'trust.requirement.identity_verification.instructions',
    'PLAIN_TEXT',
    'Upload a clear photo or scan of one valid government-issued photo ID. Make sure the whole document is visible and readable.',
  ],
  ['trust.requirement.background_check.name', 'UI_LABEL', 'Background check'],
  ['trust.requirement.background_check.instructions', 'PLAIN_TEXT', 'A background check is run by our verification partner. Follow the steps it shows you.'],
  ['trust.requirement.professional_license.name', 'UI_LABEL', 'Professional license'],
  ['trust.requirement.professional_license.instructions', 'PLAIN_TEXT', 'Upload a clear copy of your current license, showing its number and its end date.'],
  ['trust.requirement.liability_insurance.name', 'UI_LABEL', 'Liability insurance'],
  ['trust.requirement.liability_insurance.instructions', 'PLAIN_TEXT', 'Upload your current insurance certificate, showing the coverage and its end date.'],
  ['trust.document_type.drivers_license.name', 'UI_LABEL', "Driver's license"],
  ['trust.document_type.state_id.name', 'UI_LABEL', 'State ID card'],
  ['trust.document_type.passport.name', 'UI_LABEL', 'Passport'],
  ['trust.document_type.professional_license.name', 'UI_LABEL', 'Professional license'],
  ['trust.document_type.business_license.name', 'UI_LABEL', 'Business license'],
  ['trust.document_type.insurance_certificate.name', 'UI_LABEL', 'Insurance certificate'],
  ['trust.document_type.certification.name', 'UI_LABEL', 'Certification'],
  ['trust.reason.document_unreadable.name', 'PLAIN_TEXT', 'The document could not be read. Upload a clearer copy.'],
  ['trust.reason.document_expired.name', 'PLAIN_TEXT', 'The document has expired. Upload a current one.'],
  ['trust.reason.name_mismatch.name', 'PLAIN_TEXT', 'The name on the document does not match your account.'],
  ['trust.reason.license_invalid.name', 'PLAIN_TEXT', 'The license could not be confirmed as valid.'],
  ['trust.reason.insurance_expired.name', 'PLAIN_TEXT', 'The insurance coverage shown has expired.'],
  ['trust.reason.requires_resubmission.name', 'PLAIN_TEXT', 'Please submit your evidence again.'],
  ['trust.reason.other_review_required.name', 'PLAIN_TEXT', 'More information is needed. Please submit updated evidence.'],
  ['trust.verification.requirement_status.not_started', 'UI_LABEL', 'Not started'],
  ['trust.verification.requirement_status.pending', 'UI_LABEL', 'Waiting for review'],
  ['trust.verification.requirement_status.in_review', 'UI_LABEL', 'Being reviewed'],
  ['trust.verification.requirement_status.action_required', 'UI_LABEL', 'Action needed'],
  ['trust.verification.requirement_status.approved', 'UI_LABEL', 'Approved'],
  ['trust.verification.requirement_status.rejected', 'UI_LABEL', 'Not accepted'],
  ['trust.verification.requirement_status.expired', 'UI_LABEL', 'Expired'],
  ['trust.verification.requirement_status.not_required', 'UI_LABEL', 'Not required'],
  ['trust.verification.status.not_required', 'UI_LABEL', 'Nothing to verify'],
  ['trust.verification.status.not_started', 'UI_LABEL', 'Not started'],
  ['trust.verification.status.open', 'UI_LABEL', 'Getting ready'],
  ['trust.verification.status.in_review', 'UI_LABEL', 'In review'],
  ['trust.verification.status.action_required', 'UI_LABEL', 'Action needed'],
  ['trust.verification.status.approved', 'UI_LABEL', 'Verified'],
  ['trust.verification.status.expired', 'UI_LABEL', 'Renewal needed'],
  ['trust.verification.status.cancelled', 'UI_LABEL', 'Cancelled'],
  ['trust.verification.document_status.upload_pending', 'UI_LABEL', 'Waiting for the file'],
  ['trust.verification.document_status.attached', 'UI_LABEL', 'Ready to submit'],
  ['trust.verification.document_status.submitted', 'UI_LABEL', 'Submitted'],
  ['trust.verification.document_status.withdrawn', 'UI_LABEL', 'Removed'],
  ['trust.verification.document_status.abandoned', 'UI_LABEL', 'Not accepted'],
  ['trust.verification.scan_status.pending', 'UI_LABEL', 'Not checked yet'],
  ['trust.verification.scan_status.clean', 'UI_LABEL', 'Checked'],
  ['trust.verification.scan_status.infected', 'UI_LABEL', 'Rejected by the safety check'],
  ['trust.verification.scan_status.error', 'UI_LABEL', 'Could not be checked'],
  ['trust.verification.error.not_found', 'PLAIN_TEXT', 'We could not find that.'],
  ['trust.verification.error.account_not_active', 'PLAIN_TEXT', 'Your account is not active.'],
  ['trust.verification.error.prerequisite_not_met', 'PLAIN_TEXT', 'Finish your provider registration and verify your email and phone first.'],
  ['trust.verification.error.requirement_not_applicable', 'PLAIN_TEXT', 'That requirement does not apply to you.'],
  ['trust.verification.error.document_type_not_accepted', 'PLAIN_TEXT', 'That kind of document is not accepted for this requirement.'],
  ['trust.verification.error.mime_not_allowed', 'PLAIN_TEXT', 'That file type is not allowed.'],
  ['trust.verification.error.file_too_large', 'PLAIN_TEXT', 'That file is too large.'],
  ['trust.verification.error.too_many_documents', 'PLAIN_TEXT', 'You have added the most documents allowed for this requirement.'],
  ['trust.verification.error.evidence_not_accepted', 'PLAIN_TEXT', 'You cannot add documents to this requirement right now.'],
  ['trust.verification.error.upload_expired', 'PLAIN_TEXT', 'The upload took too long. Start again.'],
  ['trust.verification.error.object_missing', 'PLAIN_TEXT', 'We did not receive your file. Try again.'],
  ['trust.verification.error.object_mismatch', 'PLAIN_TEXT', 'The file did not match what you described. Try again with the original file.'],
  ['trust.verification.error.scan_unavailable', 'PLAIN_TEXT', 'We could not check your file right now. Try again later.'],
  ['trust.verification.error.scan_infected', 'PLAIN_TEXT', 'Your file was rejected by the safety check.'],
  ['trust.verification.error.invalid_state', 'PLAIN_TEXT', 'That is not possible right now.'],
  ['trust.verification.error.submission_incomplete', 'PLAIN_TEXT', 'Add a document for every requirement that needs one first.'],
  ['trust.verification.error.stale_case', 'PLAIN_TEXT', 'This page is out of date. Reload it and try again.'],
  ['trust.verification.error.stale_round', 'PLAIN_TEXT', 'The provider changed this evidence while you were reviewing it. Reload and review again.'],
  ['trust.verification.error.already_decided', 'PLAIN_TEXT', 'This evidence was already decided.'],
  ['trust.verification.error.reason_invalid', 'PLAIN_TEXT', 'Choose a valid reason.'],
  ['trust.verification.error.not_reverifiable', 'PLAIN_TEXT', 'This requirement cannot be verified again yet.'],
  ['trust.verification.error.external_unavailable', 'PLAIN_TEXT', 'The verification service is not available right now.'],
  ['trust.verification.error.validation_failed', 'PLAIN_TEXT', 'Check the highlighted fields.'],
  ['trust.verification.error.conflict', 'PLAIN_TEXT', 'Another change happened at the same time. Try again.'],
  ['trust.verification.error.unavailable', 'PLAIN_TEXT', 'Verification is temporarily unavailable.'],
  ['trust.verification.page.title', 'UI_LABEL', 'Verification'],
  [
    'trust.verification.page.intro',
    'PLAIN_TEXT',
    'We check a few things before you can be offered to customers. Your documents are used only for this and are never shown to customers.',
  ],
  ['trust.verification.page.open_action', 'UI_LABEL', 'Start verification'],
  ['trust.verification.page.requirements_heading', 'UI_LABEL', 'What we need'],
  ['trust.verification.page.documents_heading', 'UI_LABEL', 'Your documents'],
  ['trust.verification.page.upload_heading', 'UI_LABEL', 'Add a document'],
  ['trust.verification.page.document_type_label', 'UI_LABEL', 'Kind of document'],
  ['trust.verification.page.file_label', 'UI_LABEL', 'File'],
  ['trust.verification.page.file_help', 'PLAIN_TEXT', 'A PDF, JPEG or PNG file. Do not send a photo of a screen.'],
  ['trust.verification.page.upload_action', 'UI_LABEL', 'Upload'],
  ['trust.verification.page.submit_action', 'UI_LABEL', 'Submit for review'],
  ['trust.verification.page.cancel_action', 'UI_LABEL', 'Cancel verification'],
  ['trust.verification.page.withdraw_action', 'UI_LABEL', 'Remove'],
  ['trust.verification.page.reverify_action', 'UI_LABEL', 'Verify again'],
  ['trust.verification.page.status_label', 'UI_LABEL', 'Status'],
  ['trust.verification.page.reason_label', 'UI_LABEL', 'Reason'],
  ['trust.verification.page.valid_until_label', 'UI_LABEL', 'Valid until'],
  ['trust.verification.page.empty_requirements', 'PLAIN_TEXT', 'Nothing needs to be verified for your account right now.'],
  ['trust.verification.page.empty_documents', 'PLAIN_TEXT', 'No documents yet.'],
  ['trust.verification.page.prerequisite_hint', 'PLAIN_TEXT', 'Finish your provider registration and verify your email and phone first.'],
  ['trust.verification.page.submitted_notice', 'PLAIN_TEXT', 'Your documents were submitted for review.'],
  ['trust.verification.page.uploaded_notice', 'PLAIN_TEXT', 'Your document was added. Submit when everything is ready.'],
  ['trust.verification.page.withdrawn_notice', 'PLAIN_TEXT', 'The document was removed.'],
  ['trust.verification.page.cancelled_notice', 'PLAIN_TEXT', 'Your verification was cancelled.'],
  ['trust.verification.page.golive_note', 'PLAIN_TEXT', 'Being verified does not make you live. Going live needs other steps.'],
];
/** Every managed content key the contract can name (the helpers of packages/contracts/src/trust.ts), for every member of its vocabulary. */
const SEEDED_DEFINITIONS = [
  { code: 'identity_verification', requirement_type: 'IDENTITY', evidence_kind: 'DOCUMENT', expiry_required: false, status: 'ACTIVE' },
  { code: 'background_check', requirement_type: 'BACKGROUND_CHECK', evidence_kind: 'EXTERNAL', expiry_required: true, status: 'INACTIVE' },
  { code: 'liability_insurance', requirement_type: 'INSURANCE', evidence_kind: 'DOCUMENT', expiry_required: true, status: 'INACTIVE' },
  { code: 'professional_license', requirement_type: 'LICENSE', evidence_kind: 'DOCUMENT', expiry_required: true, status: 'INACTIVE' },
];
const SEEDED_DOCUMENT_TYPES = [
  { code: 'business_license', requirement_type: 'BUSINESS_REGISTRATION' },
  { code: 'certification', requirement_type: 'CERTIFICATION' },
  { code: 'drivers_license', requirement_type: 'IDENTITY' },
  { code: 'insurance_certificate', requirement_type: 'INSURANCE' },
  { code: 'passport', requirement_type: 'IDENTITY' },
  { code: 'professional_license', requirement_type: 'LICENSE' },
  { code: 'state_id', requirement_type: 'IDENTITY' },
];
const SEEDED_REASONS = [
  { code: 'DOCUMENT_EXPIRED', applies_to: 'BOTH' },
  { code: 'DOCUMENT_UNREADABLE', applies_to: 'BOTH' },
  { code: 'INSURANCE_EXPIRED', applies_to: 'BOTH' },
  { code: 'LICENSE_INVALID', applies_to: 'REJECT' },
  { code: 'NAME_MISMATCH', applies_to: 'BOTH' },
  { code: 'OTHER_REVIEW_REQUIRED', applies_to: 'BOTH' },
  { code: 'REQUIRES_RESUBMISSION', applies_to: 'ACTION_REQUIRED' },
];
const CONTRACT_KEYS = [
  ...SEEDED_DEFINITIONS.flatMap((d) => [trustRequirementNameKey(d.code), trustRequirementInstructionsKey(d.code)]),
  ...TRUST_DOCUMENT_TYPE_CODES.map(trustDocumentTypeNameKey),
  ...TRUST_REASON_CODES.map(trustReasonNameKey),
  ...TRUST_REQUIREMENT_STATUSES.map(trustRequirementStatusKey),
  ...[...new Set<string>([...TRUST_OVERALL_STATUSES, ...TRUST_CASE_STATUSES])].map((s) => trustVerificationStatusKey(s as TrustCaseStatus)),
  ...TRUST_DOCUMENT_STATUSES.map(trustDocumentStatusKey),
  ...TRUST_SCAN_STATUSES.map(trustScanStatusKey),
  ...TRUST_ERROR_CODES.map(trustErrorKey),
];
const PAGE_PREFIX = 'trust.verification.page.';
interface PolicySeed {
  key: string;
  field: keyof TrustDocumentPolicy;
  type: 'BOOLEAN' | 'JSON' | 'INTEGER';
  unit: string | null;
  rules: unknown;
  value: unknown;
}
const POLICY_SEEDS: PolicySeed[] = [
  { key: TRUST_POLICY_KEYS.maxSizeBytes, field: 'maxSizeBytes', type: 'INTEGER', unit: 'bytes', rules: { min: 1024, max: 52428800 }, value: 10485760 },
  {
    key: TRUST_POLICY_KEYS.allowedMimeTypes,
    field: 'allowedMimeTypes',
    type: 'JSON',
    unit: null,
    rules: { schema: { type: 'array', items: { type: 'string', pattern: '^[a-z]+/[a-z0-9.+-]+$' }, uniqueItems: true, minItems: 1, maxItems: 10 } },
    value: ['application/pdf', 'image/jpeg', 'image/png'],
  },
  {
    key: TRUST_POLICY_KEYS.maxDocumentsPerRequirement,
    field: 'maxDocumentsPerRequirement',
    type: 'INTEGER',
    unit: 'documents',
    rules: { min: 1, max: 20 },
    value: 5,
  },
  { key: TRUST_POLICY_KEYS.uploadUrlTtlSeconds, field: 'uploadUrlTtlSeconds', type: 'INTEGER', unit: 'seconds', rules: { min: 60, max: 3600 }, value: 300 },
  { key: TRUST_POLICY_KEYS.downloadUrlTtlSeconds, field: 'downloadUrlTtlSeconds', type: 'INTEGER', unit: 'seconds', rules: { min: 15, max: 900 }, value: 60 },
  { key: TRUST_POLICY_KEYS.requireCleanScan, field: 'requireCleanScan', type: 'BOOLEAN', unit: null, rules: {}, value: true },
];
const POLICY_KEYS = POLICY_SEEDS.map((p) => p.key);
const sortedPolicy = () => [...POLICY_SEEDS].sort((a, b) => byName(a.key, b.key));

describe('B1. seeded configuration: the six evidence policy parameters, resolved through the real ConfigurationService', () => {
  it('resolves to 10 MiB, the three MIME types, 5 documents, 300 s, 60 s and true at PLATFORM scope, version 1, typed as the seed says, and the values satisfy the contract policy schema', async () => {
    const cfg = new ConfigurationService({ database: seed.database, env: 'test' });
    const { values } = await cfg.resolveMany(POLICY_KEYS);
    expect([...values.keys()].sort(byName)).toEqual([...POLICY_KEYS].sort(byName));
    for (const p of POLICY_SEEDS) {
      const r = values.get(p.key)!;
      expect({ key: r.key, value: r.value, dataType: r.dataType, sourceScope: r.sourceScope, scopeRef: r.scopeRef, version: r.version }, p.key).toEqual({
        key: p.key,
        value: p.value,
        dataType: p.type,
        sourceScope: 'PLATFORM',
        scopeRef: null,
        version: 1,
      });
      expect(r.criticality, p.key).toBe('STANDARD');
      expect(r.sensitivity, p.key).toBe('INTERNAL');
      expect(r.effectiveTo, p.key).toBeNull();
      expect(r.effectiveFrom.getTime(), p.key).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(await cfg.value<number>(TRUST_POLICY_KEYS.maxSizeBytes)).toBe(10 * 1024 * 1024);
    expect(await cfg.value<string[]>(TRUST_POLICY_KEYS.allowedMimeTypes)).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(await cfg.value<number>(TRUST_POLICY_KEYS.maxDocumentsPerRequirement)).toBe(5);
    expect(await cfg.value<number>(TRUST_POLICY_KEYS.uploadUrlTtlSeconds)).toBe(300);
    expect(await cfg.value<number>(TRUST_POLICY_KEYS.downloadUrlTtlSeconds)).toBe(60);
    expect(await cfg.value<boolean>(TRUST_POLICY_KEYS.requireCleanScan)).toBe(true);
    // the contract and the seed agree: the resolved set is a valid TrustDocumentPolicy, built field by field from the keys
    const resolved = Object.fromEntries(POLICY_SEEDS.map((p) => [p.field, values.get(p.key)!.value]));
    expect(TrustDocumentPolicy.parse(resolved)).toEqual({
      maxSizeBytes: 10485760,
      allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      maxDocumentsPerRequirement: 5,
      uploadUrlTtlSeconds: 300,
      downloadUrlTtlSeconds: 60,
      requireCleanScan: true,
    });
    // a context that names a market, a provider or a plan still resolves the PLATFORM value (nothing is overridden)
    const inMarket = await cfg.resolveMany(POLICY_KEYS, { market: 'la-oc' });
    expect([...inMarket.values.values()].map((r) => [r.key, r.value, r.sourceScope]).sort()).toEqual(
      POLICY_SEEDS.map((p) => [p.key, p.value, 'PLATFORM']).sort(),
    );
  });

  it('defines each parameter with the documented type, unit, validation rules, owner, sensitivity, approval policy and criticality, required and active, created by the migration', async () => {
    const rows = await sq<Record<string, unknown>>(
      `SELECT key, data_type, unit, validation_rules, owner_role, sensitivity, approval_policy, criticality, is_required, is_active, created_by, length(btrim(description)) > 20 AS described
         FROM configuration.parameters WHERE key LIKE 'trust.%' ORDER BY key COLLATE "C"`,
    );
    expect(rows).toEqual(
      sortedPolicy().map((p) => ({
        key: p.key,
        data_type: p.type,
        unit: p.unit,
        validation_rules: p.rules,
        owner_role: 'platform',
        sensitivity: 'INTERNAL',
        approval_policy: 'SECOND_APPROVER',
        criticality: 'STANDARD',
        is_required: true,
        is_active: true,
        created_by: 'system:migration',
        described: true,
      })),
    );
    expect(await count('configuration.parameters', "key LIKE 'trust.%'", [], seedPool)).toBe(6);
    expect(await count('configuration.parameters', 'true', [], seedPool)).toBe(39);
  });

  it('allows each parameter at PLATFORM scope only (no override level), with exactly one PLATFORM value holder and one version each', async () => {
    expect(
      await sq(
        `SELECT p.key, array_agg(s.scope_type ORDER BY s.scope_type) AS scopes FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id
          WHERE p.key LIKE 'trust.%' GROUP BY p.key ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual([...POLICY_KEYS].sort(byName).map((key) => ({ key, scopes: ['PLATFORM'] })));
    expect(
      await sq(
        `SELECT p.key, h.scope_type, h.scope_ref, v.version, v.value, v.effective_to IS NULL AS open_ended, v.created_by, v.reason LIKE 'Initial value (migration 0019): %' AS reason_ok
           FROM configuration.parameters p JOIN configuration.parameter_values h ON h.parameter_id = p.parameter_id
           JOIN configuration.value_versions v ON v.parameter_value_id = h.parameter_value_id
          WHERE p.key LIKE 'trust.%' ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual(
      sortedPolicy().map((p) => ({
        key: p.key,
        scope_type: 'PLATFORM',
        scope_ref: null,
        version: 1,
        value: p.value,
        open_ended: true,
        created_by: 'system:migration',
        reason_ok: true,
      })),
    );
  });

  it('went through the real change lifecycle: a request drafted, submitted, approved by a DIFFERENT actor and activated, with the six audit rows of the workflow in order, all under the correlation seed-0019', async () => {
    expect(
      await sq(
        `SELECT p.key, cr.state, cr.scope_type, cr.scope_ref, cr.requested_by, cr.approval_policy, cr.value_version_id IS NOT NULL AS has_version,
                (SELECT count(*)::int FROM configuration.change_approvals a WHERE a.change_request_id = cr.change_request_id) AS approvals,
                (SELECT string_agg(a.approver || ':' || a.decision, ',') FROM configuration.change_approvals a WHERE a.change_request_id = cr.change_request_id) AS approval
           FROM configuration.parameters p JOIN configuration.change_requests cr ON cr.parameter_id = p.parameter_id WHERE p.key LIKE 'trust.%' ORDER BY p.key COLLATE "C"`,
      ),
    ).toEqual(
      [...POLICY_KEYS].sort(byName).map((key) => ({
        key,
        state: 'ACTIVE',
        scope_type: 'PLATFORM',
        scope_ref: null,
        requested_by: 'system:migration',
        approval_policy: 'SECOND_APPROVER',
        has_version: true,
        approvals: 1,
        approval: 'system:migration-review:APPROVE',
      })),
    );
    const audit = await sq<{ key: string; actions: string[]; actors: string[]; correlations: string[] }>(
      `SELECT p.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions, array_agg(DISTINCT a.actor ORDER BY a.actor) AS actors, array_agg(DISTINCT a.correlation_id) AS correlations
         FROM configuration.parameters p JOIN configuration.audit_events a ON a.parameter_id = p.parameter_id WHERE p.key LIKE 'trust.%' GROUP BY p.key ORDER BY p.key COLLATE "C"`,
    );
    expect(audit).toHaveLength(6);
    for (const a of audit) {
      expect(a.actions, a.key).toEqual(['PARAMETER_CREATED', 'CHANGE_DRAFTED', 'CHANGE_SUBMITTED', 'CHANGE_APPROVED', 'CHANGE_PUBLISHED', 'CHANGE_ACTIVATED']);
      expect(a.actors, a.key).toEqual(['system:migration', 'system:migration-review']);
      expect(a.correlations, a.key).toEqual(['seed-0019']);
    }
  });

  it('keeps every seeded number inside its own validation rules AND exactly on the bounds of the contract schema: the minimum and maximum of each rule are accepted by TrustDocumentPolicy and the value one beyond is not (so the parameter definitions and the contract cannot drift)', async () => {
    const stored = Object.fromEntries(
      (
        await sq<{ key: string; validation_rules: { min?: number; max?: number; schema?: { maxItems: number } } }>(
          "SELECT key, validation_rules FROM configuration.parameters WHERE key LIKE 'trust.%'",
        )
      ).map((r) => [r.key, r.validation_rules]),
    );
    const good = Object.fromEntries(POLICY_SEEDS.map((p) => [p.field, p.value]));
    expect(TrustDocumentPolicy.safeParse(good).success).toBe(true);
    for (const p of POLICY_SEEDS.filter((x) => x.type === 'INTEGER')) {
      const { min, max } = stored[p.key]! as { min: number; max: number };
      expect(p.value as number, p.key).toBeGreaterThanOrEqual(min);
      expect(p.value as number, p.key).toBeLessThanOrEqual(max);
      expect(TrustDocumentPolicy.safeParse({ ...good, [p.field]: min }).success, `${p.key} min`).toBe(true);
      expect(TrustDocumentPolicy.safeParse({ ...good, [p.field]: max }).success, `${p.key} max`).toBe(true);
      expect(TrustDocumentPolicy.safeParse({ ...good, [p.field]: min - 1 }).success, `${p.key} below min`).toBe(false);
      expect(TrustDocumentPolicy.safeParse({ ...good, [p.field]: max + 1 }).success, `${p.key} above max`).toBe(false);
    }
    expect((stored[TRUST_POLICY_KEYS.maxSizeBytes] as { max: number }).max).toBe(TRUST_DOCUMENT_SIZE_CEILING);
    // the structural ceiling of one document is the CHECK of the documents table
    expect(TRUST_DOCUMENT_SIZE_CEILING).toBe(52428800);
    const mime = (stored[TRUST_POLICY_KEYS.allowedMimeTypes] as { schema: { maxItems: number } }).schema;
    expect(TrustDocumentPolicy.safeParse({ ...good, allowedMimeTypes: Array.from({ length: mime.maxItems }, (_, i) => `application/x${i}`) }).success).toBe(
      true,
    );
    expect(TrustDocumentPolicy.safeParse({ ...good, allowedMimeTypes: Array.from({ length: mime.maxItems + 1 }, (_, i) => `application/x${i}`) }).success).toBe(
      false,
    );
    expect(TrustDocumentPolicy.safeParse({ ...good, allowedMimeTypes: [] }).success).toBe(false);
  });
});

describe('B2. seeded reference data: four requirement definitions (only identity verification ACTIVE), seven document types, seven reason codes and ONE rule', () => {
  it('seeds exactly the four definitions with their type, evidence kind, expiry flag and status; the generated content keys name seeded copy; identity verification needs no expiry and the others do', async () => {
    const rows = await sq<{
      code: string;
      requirement_type: string;
      evidence_kind: string;
      expiry_required: boolean;
      status: string;
      name_content_key: string;
      instructions_content_key: string;
    }>(
      `SELECT code, requirement_type, evidence_kind, expiry_required, status, name_content_key, instructions_content_key FROM ${DEF} ORDER BY code COLLATE "C"`,
    );
    expect(rows.map(({ name_content_key: _n, instructions_content_key: _i, ...r }) => r)).toEqual(
      [...SEEDED_DEFINITIONS].sort((a, b) => byName(a.code, b.code)),
    );
    for (const r of rows) {
      expect(r.name_content_key).toBe(trustRequirementNameKey(r.code));
      expect(r.instructions_content_key).toBe(trustRequirementInstructionsKey(r.code));
    }
    expect(rows.filter((r) => r.status === 'ACTIVE').map((r) => r.code)).toEqual(['identity_verification']);
    expect(rows.filter((r) => r.evidence_kind === 'EXTERNAL').map((r) => r.code)).toEqual(['background_check']);
    expect(rows.filter((r) => !r.expiry_required).map((r) => r.code)).toEqual(['identity_verification']);
    // the requirement types cover the vocabulary except the three nobody asks for yet
    expect(new Set(rows.map((r) => r.requirement_type))).toEqual(new Set(['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE', 'LICENSE']));
    expect(await count(DEF, 'created_at = updated_at', [], seedPool)).toBe(4);
  });

  it('seeds exactly the seven document types, ACTIVE, each for one requirement type; the codes are the contract list; the three identity documents evidence IDENTITY and no document type evidences BACKGROUND_CHECK', async () => {
    const rows = await sq<{ code: string; requirement_type: string; status: string; name_content_key: string }>(
      `SELECT code, requirement_type, status, name_content_key FROM ${DTYPE} ORDER BY code COLLATE "C"`,
    );
    expect(rows.map(({ code, requirement_type }) => ({ code, requirement_type }))).toEqual(SEEDED_DOCUMENT_TYPES);
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(rows.map((r) => r.code).sort(byName)).toEqual([...TRUST_DOCUMENT_TYPE_CODES].sort(byName));
    for (const r of rows) expect(r.name_content_key).toBe(trustDocumentTypeNameKey(r.code));
    expect(rows.filter((r) => r.requirement_type === 'IDENTITY').map((r) => r.code)).toEqual(['drivers_license', 'passport', 'state_id']);
    expect(rows.some((r) => r.requirement_type === 'BACKGROUND_CHECK')).toBe(false);
  });

  it('seeds exactly the seven reason codes, ACTIVE, with the documented scope; the codes are the contract list; only LICENSE_INVALID is reject-only and only REQUIRES_RESUBMISSION is action-only', async () => {
    const rows = await sq<{ code: string; applies_to: string; status: string; name_content_key: string }>(
      `SELECT code, applies_to, status, name_content_key FROM ${REASON} ORDER BY code COLLATE "C"`,
    );
    expect(rows.map(({ code, applies_to }) => ({ code, applies_to }))).toEqual(SEEDED_REASONS);
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(rows.map((r) => r.code).sort(byName)).toEqual([...TRUST_REASON_CODES].sort(byName));
    for (const r of rows) expect(r.name_content_key).toBe(trustReasonNameKey(r.code));
  });

  it('seeds ONE rule: identity verification for every market and every service type, enabled; so exactly one definition is required of a provider whatever the market and service type, and the three INACTIVE ones are required nowhere', async () => {
    expect(await sq(`SELECT d.code, r.market_id, r.service_type_id, r.enabled FROM ${RULE} r JOIN ${DEF} d USING (requirement_definition_id)`)).toEqual([
      { code: 'identity_verification', market_id: null, service_type_id: null, enabled: true },
    ]);
    // required = ACTIVE definition with at least one enabled rule that matches the provider's market (NULL = all) and service type (NULL = all)
    const required = async (market: string | null, serviceType: string | null) =>
      (
        await sq<{ code: string }>(
          `SELECT d.code FROM ${DEF} d WHERE d.status = 'ACTIVE' AND EXISTS (
             SELECT 1 FROM ${RULE} r WHERE r.requirement_definition_id = d.requirement_definition_id AND r.enabled
              AND (r.market_id IS NULL OR r.market_id = $1) AND (r.service_type_id IS NULL OR r.service_type_id = $2)) ORDER BY 1`,
          [market, serviceType],
        )
      ).map((r) => r.code);
    const market = (await sq<{ market_id: string }>("SELECT market_id FROM geography.markets WHERE code = 'la-oc'"))[0]!.market_id;
    expect(await required(market, null)).toEqual(['identity_verification']);
    expect(await required(null, null)).toEqual(['identity_verification']);
    expect(await required(market, randomUUID())).toEqual(['identity_verification']);
    expect(await count(RULE, 'true', [], seedPool)).toBe(1);
  });
});

describe('B3. seeded content: 97 PUBLISHED entries of managed copy for the minimal flow, resolved through the real ContentService', () => {
  const ALL_KEYS = SEED_CONTENT.map((r) => r[0]);
  const pageKeys = ALL_KEYS.filter((k) => k.startsWith(PAGE_PREFIX));

  it('seeds exactly the keys the contract helpers name (every requirement, document type, reason, requirement status, case and overall status, document status, scan status and error code) plus the 25 page keys, and no other trust.* entry: checked in both directions', async () => {
    expect(pageKeys).toHaveLength(25);
    expect(CONTRACT_KEYS).toHaveLength(72);
    expect(new Set(CONTRACT_KEYS).size).toBe(72);
    expect(ALL_KEYS).toHaveLength(97);
    expect(new Set(ALL_KEYS).size).toBe(97);
    const stored = (await sq<{ key: string }>('SELECT key FROM content.entries WHERE key LIKE \'trust.%\' ORDER BY key COLLATE "C"')).map((r) => r.key);
    expect(stored).toEqual([...CONTRACT_KEYS, ...pageKeys].sort(byName));
    expect(stored).toHaveLength(97);
    // direction 1: every key a helper can produce exists; direction 2: every seeded key is produced by a helper or is a page key
    for (const k of CONTRACT_KEYS) expect(stored, k).toContain(k);
    expect(stored.filter((k) => !CONTRACT_KEYS.includes(k) && !k.startsWith(PAGE_PREFIX))).toEqual([]);
    // and the keys the generated columns derive are seeded too (a definition, document type or reason added later needs its copy first: the foreign key says so)
    const derived = await sq<{ k: string }>(
      `SELECT name_content_key AS k FROM ${DEF} UNION ALL SELECT instructions_content_key FROM ${DEF} UNION ALL SELECT name_content_key FROM ${DTYPE} UNION ALL SELECT name_content_key FROM ${REASON}`,
    );
    expect(derived).toHaveLength(22);
    for (const { k } of derived) expect(stored, k).toContain(k);
    // the keys follow the contract's own naming (lower-case member of the vocabulary), one helper at a time
    expect(trustErrorKey('STALE_ROUND')).toBe('trust.verification.error.stale_round');
    expect(trustVerificationStatusKey('ACTION_REQUIRED')).toBe('trust.verification.status.action_required');
    expect(trustRequirementStatusKey('NOT_REQUIRED')).toBe('trust.verification.requirement_status.not_required');
    expect(trustReasonNameKey('DOCUMENT_UNREADABLE')).toBe('trust.reason.document_unreadable.name');
  });

  it('labels the case status vocabulary of the contract (open, in review, action required, approved, expired, cancelled) and the two overall-only values (not required, not started)', () => {
    for (const s of [...TRUST_CASE_STATUSES, 'NOT_REQUIRED', 'NOT_STARTED'] as const)
      expect(ALL_KEYS, s).toContain(trustVerificationStatusKey(s as TrustCaseStatus));
    expect(ALL_KEYS.filter((k) => k.startsWith('trust.verification.status.'))).toHaveLength(8);
  });

  it('defines every entry as PUBLIC, STANDARD, CONTENT-owned, approval NONE, fallback CHAIN, up to MARKET scope, created by the migration; UI_LABEL for labels and headings, PLAIN_TEXT for sentences; never LEGAL', async () => {
    const rows = await sq<Record<string, unknown>>(
      `SELECT key, content_type, owner_role, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by, length(btrim(description)) > 10 AS described
         FROM content.entries WHERE key LIKE 'trust.%' ORDER BY key COLLATE "C"`,
    );
    expect(rows).toHaveLength(97);
    const types = new Map(SEED_CONTENT.map((r) => [r[0], r[1]]));
    for (const r of rows) {
      expect(r, String(r.key)).toMatchObject({
        owner_role: 'CONTENT',
        sensitivity: 'PUBLIC',
        criticality: 'STANDARD',
        approval_policy: 'NONE',
        fallback_policy: 'CHAIN',
        max_scope_type: 'MARKET',
        created_by: 'system:migration',
        described: true,
      });
      expect(r.content_type, String(r.key)).toBe(types.get(r.key as string));
      expect(r.content_type).not.toBe('LEGAL');
    }
    expect(rows.filter((r) => r.content_type === 'UI_LABEL')).toHaveLength(SEED_CONTENT.filter((r) => r[1] === 'UI_LABEL').length);
    // every error message and every reason message is a sentence (PLAIN_TEXT); every label of a status or a name is a label
    for (const k of TRUST_ERROR_CODES.map(trustErrorKey)) expect(types.get(k), k).toBe('PLAIN_TEXT');
    for (const k of TRUST_REASON_CODES.map(trustReasonNameKey)) expect(types.get(k), k).toBe('PLAIN_TEXT');
    for (const k of [
      ...TRUST_REQUIREMENT_STATUSES.map(trustRequirementStatusKey),
      ...TRUST_DOCUMENT_STATUSES.map(trustDocumentStatusKey),
      ...TRUST_SCAN_STATUSES.map(trustScanStatusKey),
    ])
      expect(types.get(k), k).toBe('UI_LABEL');
    for (const d of SEEDED_DEFINITIONS) {
      expect(types.get(trustRequirementNameKey(d.code)), d.code).toBe('UI_LABEL');
      expect(types.get(trustRequirementInstructionsKey(d.code)), d.code).toBe('PLAIN_TEXT');
    }
  });

  it('gives each entry exactly one version: en-US, PLATFORM scope, version 1, PUBLISHED, in force, with the exact English copy of the seed', async () => {
    const rows = await sq<{
      key: string;
      locale: string;
      scope_type: string;
      scope_ref: string | null;
      version: number;
      status: string;
      approval_policy: string;
      body: string;
      in_force: string;
      created_by: string;
    }>(
      `SELECT e.key, v.locale, v.scope_type, v.scope_ref, v.version, v.status, v.approval_policy, v.body, v.created_by,
              identity.consent_version_state(v.version_id, e.entry_id, now()) AS in_force
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'trust.%' ORDER BY e.key COLLATE "C"`,
    );
    expect(rows).toHaveLength(97);
    const bodies = new Map(SEED_CONTENT.map((r) => [r[0], r[2]]));
    for (const r of rows) {
      expect(
        { locale: r.locale, scope: r.scope_type, ref: r.scope_ref, version: r.version, status: r.status, approval: r.approval_policy, by: r.created_by },
        r.key,
      ).toEqual({
        locale: 'en-US',
        scope: 'PLATFORM',
        ref: null,
        version: 1,
        status: 'PUBLISHED',
        approval: 'NONE',
        by: 'system:migration',
      });
      expect(r.in_force, r.key).toBe('IN_FORCE');
      expect(r.body, r.key).toBe(bodies.get(r.key));
    }
  });

  it('went through the real content lifecycle: five audit rows per entry (created, drafted, approved, published, activated) under the correlation seed-0019', async () => {
    const rows = await sq<{ key: string; actions: string[]; correlations: string[]; actors: string[] }>(
      `SELECT e.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions, array_agg(DISTINCT a.correlation_id) AS correlations, array_agg(DISTINCT a.actor) AS actors
         FROM content.entries e JOIN content.audit_events a ON a.entry_id = e.entry_id WHERE e.key LIKE 'trust.%' GROUP BY e.key ORDER BY e.key COLLATE "C"`,
    );
    expect(rows).toHaveLength(97);
    for (const r of rows) {
      expect(r.actions, r.key).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      expect(r.correlations, r.key).toEqual(['seed-0019']);
      expect(r.actors, r.key).toEqual(['system:migration']);
    }
  });

  it('renders non-empty, exact en-US text for every one of the 97 keys with the content registry itself, with and without a market, in the public view', async () => {
    const content = new ContentService({ database: seed.database, env: 'test' });
    for (const [key, , body] of SEED_CONTENT) {
      expect((await content.render(key, { locale: 'en-US' })).value, key).toBe(body);
      expect((await content.render(key, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false })).value, key).toBe(body);
    }
    const batch = await content.resolveRendered(ALL_KEYS, { locale: 'en-US', context: { market: 'la-oc' }, includeInternal: false });
    expect(batch.missing.size).toBe(0);
    expect(batch.items.size).toBe(97);
    // every key the contract can name resolves (the contract helpers and the seed cannot drift)
    const contract = await content.resolveRendered(CONTRACT_KEYS, { locale: 'en-US', includeInternal: false });
    expect(contract.missing.size).toBe(0);
    expect(contract.items.size).toBe(72);
  });

  it('holds no variable, markup, address, number, URL, identifier or legal wording in any copy, no error message leaks an internal (a code, a constraint, a table), and the page says that being verified is not being live', () => {
    for (const [key, , body] of SEED_CONTENT) {
      expect(body, key).not.toMatch(/[{}<>@]|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d/i);
      expect(body.trim(), key).toBe(body);
      expect(body.length, key).toBeGreaterThan(2);
      expect(body.length, key).toBeLessThan(200);
      expect(body, key).not.toMatch(/\b(constraint|SQL|exception|stack|undefined|null|trust_rule|uuid|table|object key|sha)\b/i);
      expect(body, key).not.toMatch(/\b(guarantee|warranty|lawful|illegal|criminal|convicted|liable|liability waiver)\b/i);
    }
    expect(ALL_KEYS.filter((k) => /terms|privacy|price|fee|commission|legal_text/i.test(k))).toEqual([]);
    for (const [key, type, body] of SEED_CONTENT) if (type === 'UI_LABEL') expect(body.length, key).toBeLessThan(50);
    expect(SEED_CONTENT.find((r) => r[0] === 'trust.verification.page.golive_note')![2]).toMatch(/does not make you live/);
    expect(SEED_CONTENT.find((r) => r[0] === 'trust.verification.page.intro')![2]).toMatch(/never shown to customers/);
  });

  it('is referenced by the sources: every trust.* key literal the contract, the trust package, the API and the web app name exists as seeded copy or as a seeded parameter (or is a prefix the code completes)', () => {
    const root = path.join(import.meta.dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'dist' || name === 'testing' || name.startsWith('.')) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(test|itest)\.tsx?$/.test(name)) files.push(p);
      }
    };
    for (const d of ['apps', 'packages']) walk(path.join(root, d));
    const known = new Set([...ALL_KEYS, ...POLICY_KEYS]);
    const prefixes = new Set([
      'trust.verification.page',
      'trust.verification.error',
      'trust.verification.status',
      'trust.verification.requirement_status',
      'trust.verification.document_status',
      'trust.verification.scan_status',
      'trust.requirement',
      'trust.document_type',
      'trust.reason',
      'trust.verification',
    ]);
    const unknown: string[] = [];
    let found = 0;
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/trust\.(?:requirement|document_type|reason|verification|document)\.[a-z_]+(?:\.[a-z_]+)*/g)) {
        found++;
        if (!known.has(m[0]) && !prefixes.has(m[0])) unknown.push(`${path.relative(root, f)}: ${m[0]}`);
      }
    }
    expect(found, 'the scan is not vacuous').toBeGreaterThan(10);
    expect(unknown).toEqual([]);
  });
});

// ====================================================================== C. every CHECK, NOT NULL and the vocabularies (the guard triggers are disabled for the rolled-back statement, so the constraint alone answers)
/** Makes the content entries a code needs (ignoring a key the content registry itself refuses: such a code fails its own CHECK before any foreign key is looked at). */
async function entriesFor(...keys: string[]): Promise<void> {
  for (const k of keys) await ensureEntry(k).catch(() => undefined);
}
describe('C1. requirement_definitions: code format and length, the type, evidence kind and status vocabularies, the generated content keys, NOT NULL', () => {
  const raw = async (o: { code?: string; type?: string; kind?: string; expiry?: boolean | null; status?: string | null }, entries = true) => {
    const code = o.code ?? `cdef_${++seq}`;
    if (entries) await entriesFor(trustRequirementNameKey(code), trustRequirementInstructionsKey(code));
    return isolated(noTriggers(DEF), `INSERT INTO ${DEF} (code, requirement_type, evidence_kind, expiry_required, status) VALUES ($1, $2, $3, $4, $5)`, [
      code,
      o.type === undefined ? 'IDENTITY' : o.type,
      o.kind === undefined ? 'DOCUMENT' : o.kind,
      o.expiry === undefined ? false : o.expiry,
      o.status === undefined ? 'INACTIVE' : o.status,
    ]);
  };
  it('accepts a lower-case snake_case code of 2 to 48 characters and refuses anything else by the code constraint', async () => {
    for (const ok of ['ab', 'a1', 'a_b', 'a1_b2_c3', 'x'.repeat(48), `a${'_b'.repeat(23)}`]) await raw({ code: `${ok}` });
    for (const bad of [
      '',
      'a',
      'A',
      'Ab',
      'aB',
      '_a',
      'a_',
      'a__b',
      '1a',
      'a-b',
      'a b',
      'a.b',
      'é1',
      'x'.repeat(49),
      `a${'_b'.repeat(24)}`,
      ' ab',
      'ab ',
      'a\n',
    ])
      await expectConstraint(raw({ code: bad }, false), 'ck_requirement_definitions__code');
  });
  it('accepts exactly the seven requirement types of the contract and refuses any other, whatever the case or blank', async () => {
    for (const t of TRUST_REQUIREMENT_TYPES) await raw({ type: t });
    for (const bad of ['BOGUS', 'identity', 'Identity', '', ' IDENTITY', 'IDENTITY ', 'ID', 'BACKGROUND', 'DRIVERS_LICENSE'])
      await expectConstraint(raw({ type: bad }), 'ck_requirement_definitions__type');
  });
  it('accepts exactly DOCUMENT and EXTERNAL as the evidence kind', async () => {
    for (const k of TRUST_EVIDENCE_KINDS) await raw({ kind: k });
    for (const bad of ['BOGUS', 'document', 'MANUAL', '', 'DOCUMENT ']) await expectConstraint(raw({ kind: bad }), 'ck_requirement_definitions__evidence_kind');
  });
  it('accepts exactly the three definition statuses (with the guards off) and refuses any other', async () => {
    for (const s of TRUST_DEFINITION_STATUSES) await raw({ status: s });
    for (const bad of ['BOGUS', 'active', 'DRAFT', '', 'ACTIVE ', 'DELETED'])
      await expectConstraint(raw({ status: bad }), 'ck_requirement_definitions__status');
  });
  it('requires both generated content keys to exist as content entries (the foreign keys), by name', async () => {
    const onlyName = `cdef_${++seq}`;
    await entriesFor(trustRequirementNameKey(onlyName));
    await expectConstraint(raw({ code: onlyName }, false), 'fk_requirement_definitions__instructions_content_key');
    const onlyInstructions = `cdef_${++seq}`;
    await entriesFor(trustRequirementInstructionsKey(onlyInstructions));
    await expectConstraint(raw({ code: onlyInstructions }, false), 'fk_requirement_definitions__name_content_key');
    await expect(rejection(raw({ code: `cdef_${++seq}` }, false))).resolves.toMatchObject({ code: '23503' });
  });
  it('refuses a NULL in every NOT NULL column by name, and refuses to write a generated column', async () => {
    const code = `cdef_${++seq}`;
    await entriesFor(trustRequirementNameKey(code), trustRequirementInstructionsKey(code));
    await expectNotNull(raw({ code, type: null as unknown as string }), 'requirement_type');
    await expectNotNull(raw({ code, kind: null as unknown as string }), 'evidence_kind');
    await expectNotNull(raw({ code, expiry: null }), 'expiry_required');
    await expectNotNull(raw({ code, status: null }), 'status');
    await expectNotNull(isolated(noTriggers(DEF), `INSERT INTO ${DEF} (code, requirement_type, evidence_kind) VALUES (NULL, 'IDENTITY', 'DOCUMENT')`), 'code');
    await expectNotNull(
      isolated(
        noTriggers(DEF),
        `INSERT INTO ${DEF} (requirement_definition_id, code, requirement_type, evidence_kind) VALUES (NULL, $1, 'IDENTITY', 'DOCUMENT')`,
        [code],
      ),
      'requirement_definition_id',
    );
    for (const col of ['created_at', 'updated_at'])
      await expectNotNull(
        isolated(noTriggers(DEF), `INSERT INTO ${DEF} (code, requirement_type, evidence_kind, ${col}) VALUES ($1, 'IDENTITY', 'DOCUMENT', NULL)`, [code]),
        col,
      );
    for (const col of ['name_content_key', 'instructions_content_key'])
      await expect(
        rejection(run(`INSERT INTO ${DEF} (code, requirement_type, evidence_kind, ${col}) VALUES ($1, 'IDENTITY', 'DOCUMENT', 'x.y')`, [code])),
      ).resolves.toMatchObject({ code: '428C9' });
  });
});

describe('C2. document_types and reason_codes: code formats, vocabularies, the generated content key', () => {
  const rawType = async (o: { code?: string; type?: string; status?: string | null }, entries = true) => {
    const code = o.code ?? `cdt_${++seq}`;
    if (entries) await entriesFor(trustDocumentTypeNameKey(code));
    return isolated(noTriggers(DTYPE), `INSERT INTO ${DTYPE} (code, requirement_type, status) VALUES ($1, $2, $3)`, [
      code,
      o.type === undefined ? 'IDENTITY' : o.type,
      o.status === undefined ? 'ACTIVE' : o.status,
    ]);
  };
  const rawReason = async (o: { code?: string; applies?: string; status?: string | null }, entries = true) => {
    const code = o.code ?? `CREASON${++seq}`;
    if (entries) await entriesFor(trustReasonNameKey(code));
    return isolated(noTriggers(REASON), `INSERT INTO ${REASON} (code, applies_to, status) VALUES ($1, $2, $3)`, [
      code,
      o.applies === undefined ? 'BOTH' : o.applies,
      o.status === undefined ? 'ACTIVE' : o.status,
    ]);
  };
  it('document types: a lower-case snake_case code of 2 to 48 characters, the seven requirement types, ACTIVE or INACTIVE, the name key must exist', async () => {
    for (const ok of ['ab', 'a_b1', 'x'.repeat(48)]) await rawType({ code: ok });
    for (const bad of ['', 'a', 'A_b', '_a', 'a__b', 'a-b', 'x'.repeat(49)]) await expectConstraint(rawType({ code: bad }, false), 'ck_document_types__code');
    for (const t of TRUST_REQUIREMENT_TYPES) await rawType({ type: t });
    for (const bad of ['BOGUS', 'identity', '', 'LICENCE']) await expectConstraint(rawType({ type: bad }), 'ck_document_types__requirement_type');
    for (const s of ['ACTIVE', 'INACTIVE']) await rawType({ status: s });
    for (const bad of ['RETIRED', 'active', '', 'BOGUS']) await expectConstraint(rawType({ status: bad }), 'ck_document_types__status');
    await expectConstraint(rawType({ code: `cdt_${++seq}` }, false), 'fk_document_types__name_content_key');
    await expectNotNull(rawType({ type: null as unknown as string }), 'requirement_type');
    await expectNotNull(rawType({ status: null }), 'status');
  });
  it('reason codes: an UPPER_SNAKE code of 3 to 48 characters, REJECT, ACTION_REQUIRED or BOTH, ACTIVE or INACTIVE, the name key (lower-cased code) must exist', async () => {
    for (const ok of ['ABC', 'A_B', 'AB1_C2', 'X'.repeat(48), 'A1B']) await rawReason({ code: ok });
    for (const bad of ['', 'A', 'AB', 'abc', 'Abc', 'A__B', '_AB', 'AB_', '1AB', 'A-B', 'A B', 'X'.repeat(49)])
      await expectConstraint(rawReason({ code: bad }, false), 'ck_reason_codes__code');
    for (const a of ['REJECT', 'ACTION_REQUIRED', 'BOTH']) await rawReason({ applies: a });
    for (const bad of ['APPROVE', 'reject', '', 'EITHER', 'BOTH ']) await expectConstraint(rawReason({ applies: bad }), 'ck_reason_codes__applies_to');
    for (const bad of ['RETIRED', 'active', '', 'BOGUS']) await expectConstraint(rawReason({ status: bad }), 'ck_reason_codes__status');
    await expectConstraint(rawReason({ code: `CREASON${++seq}` }, false), 'fk_reason_codes__name_content_key');
    await expectNotNull(rawReason({ applies: null as unknown as string }), 'applies_to');
  });
});

describe('C3. verification_cases: the status list, number and revision >= 1, the lifecycle in all 48 combinations, NOT NULL', () => {
  let acct: string;
  beforeAll(async () => {
    acct = await makeAccount();
  });
  interface RawCase {
    status?: string | null;
    number?: number | null;
    revision?: number | null;
    submitted?: boolean;
    decided?: boolean;
    cancelled?: boolean;
  }
  const rawCase = (account: string | null, o: RawCase = {}): [string, unknown[]] => [
    `INSERT INTO ${CASES} (account_id, case_number, status, revision, submitted_at, decided_at, cancelled_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      account,
      o.number === undefined ? 1 : o.number,
      o.status === undefined ? 'OPEN' : o.status,
      o.revision === undefined ? 1 : o.revision,
      o.submitted ? new Date() : null,
      o.decided ? new Date() : null,
      o.cancelled ? new Date() : null,
    ],
  ];
  const insertRaw = (account: string | null, o: RawCase = {}) => isolated(noTriggers(CASES), ...rawCase(account, o));

  it('accepts exactly the six statuses of the contract (with a consistent lifecycle) and rejects anything else, whatever the case or blank', async () => {
    for (const s of TRUST_CASE_STATUSES) await insertRaw(acct, { status: s, submitted: s !== 'OPEN', decided: s === 'APPROVED', cancelled: s === 'CANCELLED' });
    for (const bad of ['BOGUS', 'REJECTED', 'open', 'Approved', '', ' OPEN', 'OPEN ', 'CANCELED', 'SUBMITTED'])
      expect(['ck_verification_cases__lifecycle', 'ck_verification_cases__status'], JSON.stringify(bad)).toContain(
        await outcomeOf(insertRaw(acct, { status: bad })),
      );
  });
  it('refuses a case number below 1 and a revision below 1 by their own constraints, and accepts 1 and large values', async () => {
    for (const n of [0, -1, -2147483648]) await expectConstraint(insertRaw(acct, { number: n }), 'ck_verification_cases__number');
    for (const n of [0, -1, -2147483648]) await expectConstraint(insertRaw(acct, { revision: n }), 'ck_verification_cases__revision');
    for (const n of [1, 2, 99, 2147483647]) {
      await insertRaw(acct, { number: n });
      await insertRaw(acct, { revision: n });
    }
  });
  it('enforces the lifecycle in all 48 combinations of status x submitted_at x decided_at x cancelled_at: OPEN has none; IN_REVIEW, ACTION_REQUIRED and EXPIRED have submitted_at and no cancelled_at (decided_at free: it keeps the time of the last approval); APPROVED has submitted_at and decided_at and no cancelled_at; CANCELLED has cancelled_at (the rest free)', async () => {
    const allowed = (status: string, s: boolean, d: boolean, c: boolean): boolean =>
      status === 'OPEN' ? !s && !d && !c : status === 'APPROVED' ? s && d && !c : status === 'CANCELLED' ? c : s && !c; // IN_REVIEW, ACTION_REQUIRED, EXPIRED
    const observed: { status: string; s: boolean; d: boolean; c: boolean; outcome: string }[] = [];
    for (const status of TRUST_CASE_STATUSES)
      for (const s of [false, true])
        for (const d of [false, true])
          for (const c of [false, true])
            observed.push({ status, s, d, c, outcome: await outcomeOf(insertRaw(acct, { status, submitted: s, decided: d, cancelled: c })) });
    expect(observed).toHaveLength(48);
    expect(observed).toEqual(observed.map((o) => ({ ...o, outcome: allowed(o.status, o.s, o.d, o.c) ? 'ACCEPTED' : 'ck_verification_cases__lifecycle' })));
    expect(observed.filter((o) => o.outcome === 'ACCEPTED')).toHaveLength(12);
  });
  it('refuses a NULL in every NOT NULL column by name, and a missing account by the foreign key (guards off)', async () => {
    await expectNotNull(insertRaw(null), 'account_id');
    await expectNotNull(insertRaw(acct, { number: null }), 'case_number');
    await expectNotNull(insertRaw(acct, { status: null }), 'status');
    await expectNotNull(insertRaw(acct, { revision: null }), 'revision');
    for (const col of ['created_at', 'updated_at'])
      await expectNotNull(isolated(noTriggers(CASES), `INSERT INTO ${CASES} (account_id, case_number, ${col}) VALUES ($1, 1, NULL)`, [acct]), col);
    await expectNotNull(
      isolated(noTriggers(CASES), `INSERT INTO ${CASES} (verification_case_id, account_id, case_number) VALUES (NULL, $1, 1)`, [acct]),
      'verification_case_id',
    );
    await expectConstraint(insertRaw(randomUUID()), 'fk_verification_cases__account_id');
    // with the guards ON a NULL case number reaches the NOT NULL constraint (the guard cannot compare it) and a NULL account is not an ACTIVE account
    await expectNotNull(run(...rawCase(acct, { number: null })), 'case_number');
    await expectRule(run(...rawCase(null)), 'ACCOUNT_NOT_ACTIVE');
  });
});

describe('C4. case_requirements: the status list, cycle, round and revision bounds, the evidence rule, the approval rule in every combination, the superseded rule, NOT NULL', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = (await makeCase()).caseId;
  });
  interface RawReq {
    def?: string;
    cycle?: number | null;
    status?: string | null;
    round?: number | null;
    revision?: number | null;
    submitted?: boolean;
    approved?: boolean;
    expires?: 'none' | 'after' | 'before';
    superseded?: boolean;
  }
  const rawReq = (o: RawReq = {}): [string, unknown[]] => [
    `INSERT INTO ${CR} (verification_case_id, requirement_definition_id, cycle, status, round, revision, submitted_at, approved_at, expires_at, superseded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, ${o.expires === 'after' ? "$8::timestamptz + interval '1 day'" : o.expires === 'before' ? "$8::timestamptz - interval '1 day'" : 'NULL'}, $9)`,
    [
      caseId,
      o.def ?? docDef.id,
      o.cycle === undefined ? 1 : o.cycle,
      o.status === undefined ? 'NOT_STARTED' : o.status,
      o.round === undefined ? 0 : o.round,
      o.revision === undefined ? 1 : o.revision,
      o.submitted ? new Date() : null,
      o.approved || o.expires === 'after' || o.expires === 'before' ? new Date() : null,
      o.superseded ? new Date() : null,
    ],
  ];
  const insertRaw = (o: RawReq = {}) => isolated(noTriggers(CR), ...rawReq(o));
  const EVIDENCE_STATUSES = ['PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED', 'APPROVED', 'EXPIRED'];

  it('accepts exactly the eight statuses of the contract (with consistent fields) and rejects anything else', async () => {
    for (const s of TRUST_REQUIREMENT_STATUSES) {
      const evidence = EVIDENCE_STATUSES.includes(s);
      const approval = s === 'APPROVED' || s === 'EXPIRED';
      await insertRaw({ status: s, round: evidence ? 1 : 0, submitted: evidence, approved: approval, expires: s === 'EXPIRED' ? 'after' : 'none' });
    }
    for (const bad of ['BOGUS', 'SUBMITTED', 'pending', 'Approved', '', 'NOT STARTED', 'CANCELLED', 'REVOKED'])
      await expectConstraint(insertRaw({ status: bad }), 'ck_case_requirements__status');
  });
  it('refuses a cycle below 1, a round below 0 and a revision below 1 by their own constraints, and accepts the bounds', async () => {
    for (const n of [0, -1]) await expectConstraint(insertRaw({ cycle: n }), 'ck_case_requirements__cycle');
    for (const n of [-1, -5]) await expectConstraint(insertRaw({ round: n }), 'ck_case_requirements__round');
    for (const n of [0, -1]) await expectConstraint(insertRaw({ revision: n }), 'ck_case_requirements__revision');
    for (const n of [1, 2, 99]) await insertRaw({ cycle: n });
    for (const n of [0, 1, 99, 2147483647]) await insertRaw({ round: n });
    for (const n of [1, 2147483647]) await insertRaw({ revision: n });
  });
  it('enforces the evidence rule for the six statuses that follow a submission (round >= 1 AND submitted_at) in all combinations; NOT_STARTED and NOT_REQUIRED are free of it', async () => {
    const observed: Record<string, string> = {};
    for (const status of TRUST_REQUIREMENT_STATUSES)
      for (const round of [0, 1])
        for (const submitted of [false, true]) {
          const approval = status === 'APPROVED' || status === 'EXPIRED';
          observed[`${status}/round${round}/${submitted ? 'submitted' : 'unsubmitted'}`] = await outcomeOf(
            insertRaw({ status, round, submitted, approved: approval, expires: status === 'EXPIRED' ? 'after' : 'none' }),
          );
        }
    const expected = Object.fromEntries(
      Object.keys(observed).map((k) => {
        const [status, round, sub] = k.split('/') as [string, string, string];
        const needs = EVIDENCE_STATUSES.includes(status);
        const ok = !needs || (round === 'round1' && sub === 'submitted');
        return [k, ok ? 'ACCEPTED' : 'ck_case_requirements__evidence'];
      }),
    );
    expect(observed).toEqual(expected);
    expect(Object.values(observed).filter((v) => v === 'ACCEPTED')).toHaveLength(2 * 4 + 6);
  });
  it('enforces the approval rule in all combinations of status x approved_at x expires_at (none, after, before approved_at): APPROVED and EXPIRED need approved_at, an expiry only after it, and EXPIRED needs an expiry; every other status has neither', async () => {
    const observed: Record<string, string> = {};
    for (const status of TRUST_REQUIREMENT_STATUSES)
      for (const approved of [false, true])
        for (const expires of ['none', 'after', 'before'] as const) {
          const evidence = EVIDENCE_STATUSES.includes(status);
          observed[`${status}/${approved ? 'approved' : 'unapproved'}/${expires}`] = await outcomeOf(
            insertRaw({ status, round: evidence ? 1 : 0, submitted: evidence, approved, expires }),
          );
        }
    expect(Object.keys(observed)).toHaveLength(48);
    const expected = Object.fromEntries(
      Object.keys(observed).map((k) => {
        const [status, ap, ex] = k.split('/') as [string, string, string];
        const hasApproval = status === 'APPROVED' || status === 'EXPIRED';
        // an expires_at without approved_at cannot be built by this helper: it stamps approved_at whenever an expiry is asked for, so 'unapproved/after' is 'approved + after'
        const approvedAt = ap === 'approved' || ex !== 'none';
        const ok = hasApproval ? approvedAt && ex !== 'before' && (status === 'APPROVED' || ex === 'after') : !approvedAt && ex === 'none';
        return [k, ok ? 'ACCEPTED' : 'ck_case_requirements__approval'];
      }),
    );
    expect(observed).toEqual(expected);
  });
  it('refuses a superseded_at on any status but EXPIRED', async () => {
    for (const status of TRUST_REQUIREMENT_STATUSES) {
      const evidence = EVIDENCE_STATUSES.includes(status);
      const approval = status === 'APPROVED' || status === 'EXPIRED';
      const outcome = await outcomeOf(
        insertRaw({
          status,
          round: evidence ? 1 : 0,
          submitted: evidence,
          approved: approval,
          expires: status === 'EXPIRED' ? 'after' : 'none',
          superseded: true,
        }),
      );
      expect(outcome, status).toBe(status === 'EXPIRED' ? 'ACCEPTED' : 'ck_case_requirements__superseded');
    }
  });
  it('refuses a NULL in every NOT NULL column by name and the case or definition that does not exist by the foreign keys (guards off)', async () => {
    await expectNotNull(insertRaw({ cycle: null }), 'cycle');
    await expectNotNull(insertRaw({ status: null }), 'status');
    await expectNotNull(insertRaw({ round: null }), 'round');
    await expectNotNull(insertRaw({ revision: null }), 'revision');
    for (const col of ['required_at', 'created_at', 'updated_at'])
      await expectNotNull(
        isolated(noTriggers(CR), `INSERT INTO ${CR} (verification_case_id, requirement_definition_id, ${col}) VALUES ($1, $2, NULL)`, [caseId, docDef.id]),
        col,
      );
    await expectNotNull(
      isolated(noTriggers(CR), `INSERT INTO ${CR} (verification_case_id, requirement_definition_id) VALUES (NULL, $1)`, [docDef.id]),
      'verification_case_id',
    );
    await expectNotNull(
      isolated(noTriggers(CR), `INSERT INTO ${CR} (verification_case_id, requirement_definition_id) VALUES ($1, NULL)`, [caseId]),
      'requirement_definition_id',
    );
    await expectConstraint(
      isolated(noTriggers(CR), `INSERT INTO ${CR} (verification_case_id, requirement_definition_id) VALUES (gen_random_uuid(), $1)`, [docDef.id]),
      'fk_case_requirements__case_id',
    );
    await expectConstraint(
      isolated(noTriggers(CR), `INSERT INTO ${CR} (verification_case_id, requirement_definition_id) VALUES ($1, gen_random_uuid())`, [caseId]),
      'fk_case_requirements__definition_id',
    );
  });
});

describe('C5. documents: key, content type, size and hash formats, the vocabularies, the lifecycle in every combination, NOT NULL', () => {
  let reqId: string;
  let caseId: string;
  beforeAll(async () => {
    const r = await makeReq();
    reqId = r.id;
    caseId = r.caseId;
  });
  interface RawDoc {
    key?: string;
    mime?: string;
    size?: number | null;
    sha?: string | null;
    status?: string | null;
    scan?: string | null;
    round?: number | null;
    finalized?: boolean;
    submitted?: boolean;
    withdrawn?: boolean;
  }
  const rawDoc = (o: RawDoc = {}): [string, unknown[]] => {
    const id = randomUUID();
    return [
      `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, sha256, status, scan_status, round, upload_expires_at, finalized_at, submitted_at, withdrawn_at)
       VALUES ($1, $2, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'drivers_license'), $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12)`,
      [
        id,
        reqId,
        o.key ?? `trust/evidence/${caseId}/${id}`,
        o.mime === undefined ? 'application/pdf' : o.mime,
        o.size === undefined ? 10 : o.size,
        o.sha === undefined ? null : o.sha,
        o.status === undefined ? 'UPLOAD_PENDING' : o.status,
        o.scan === undefined ? 'PENDING' : o.scan,
        o.round === undefined ? null : o.round,
        o.finalized ? new Date() : null,
        o.submitted ? new Date() : null,
        o.withdrawn ? new Date() : null,
      ],
    ];
  };
  const insertRaw = (o: RawDoc = {}) => isolated(noTriggers(DOC), ...rawDoc(o));
  const UUID_A = '0123456789abcdef0123456789abcdef0123'; // 36 hex-or-dash characters (the pattern asks for the length and the alphabet, not the uuid layout)

  it('accepts the server key trust/evidence/<case>/<document> and refuses a key that could expose a name, an account or a path: other prefixes, a file name, upper case, extra segments, the wrong length', async () => {
    const good = [`trust/evidence/${caseId}/${randomUUID()}`, `trust/evidence/${UUID_A}/${UUID_A}`, `trust/evidence/${'-'.repeat(36)}/${'f'.repeat(36)}`];
    for (const k of good) await insertRaw({ key: k });
    const id = randomUUID();
    for (const bad of [
      '',
      'evidence/x',
      `evidence/${caseId}/${id}`,
      `trust/evidence/${caseId}/${id}.pdf`,
      `trust/evidence/${caseId}/passport.pdf`,
      `trust/evidence/${caseId}/${id}/extra`,
      `trust/evidence/${caseId}/${id}/`,
      `/trust/evidence/${caseId}/${id}`,
      `trust/evidence/${caseId.toUpperCase()}/${id}`,
      `trust/evidence/${caseId}/${id.toUpperCase()}`,
      `trust/evidence/${caseId.slice(1)}/${id}`,
      `trust/evidence/${caseId}/${id}0`,
      `trust/evidence/${caseId}/../${id}`,
      `trust/evidence/accounts/${id}`,
      `trust/evidence/${caseId}-${id}`,
      `trust/evidence/${'g'.repeat(36)}/${id}`,
      `trust/other/${caseId}/${id}`,
      `trust/evidence/${caseId}/${id}\n`,
      ` trust/evidence/${caseId}/${id}`,
    ])
      await expectConstraint(insertRaw({ key: bad }), 'ck_documents__object_key');
  });
  it('keeps the object key unique (two documents never share an object)', async () => {
    const key = `trust/evidence/${caseId}/${randomUUID()}`;
    await insertRaw({ key });
    await expect(
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${DOC} DISABLE TRIGGER USER`);
        await c.query(...rawDoc({ key }));
        await c.query(...rawDoc({ key }));
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_documents__object_key' });
    // a key committed earlier is refused too
    const first = randomUUID();
    await mkDoc(reqId, { id: first });
    await expect(rejection(mkDoc(reqId, { id: randomUUID(), key: `trust/evidence/${caseId}/${first}` }))).resolves.toMatchObject({
      code: '23505',
      constraint: 'uq_documents__object_key',
    });
  });
  it('accepts a type/subtype content type of at most 100 characters and refuses a malformed one (upper case, parameters, spaces, a missing half, 101 characters)', async () => {
    for (const ok of ['application/pdf', 'image/jpeg', 'image/png', 'image/svg+xml', 'text/x.y-z', `a/${'b'.repeat(98)}`]) await insertRaw({ mime: ok });
    for (const bad of [
      '',
      'pdf',
      'APPLICATION/PDF',
      'application/',
      '/pdf',
      'application/pdf; charset=utf-8',
      'application /pdf',
      'a/b c',
      'application/PDF',
      `a/${'b'.repeat(99)}`,
      '1/pdf',
      'application//pdf',
    ])
      await expectConstraint(insertRaw({ mime: bad }), 'ck_documents__mime');
  });
  it('accepts a size of 1 to 52 428 800 bytes (the structural ceiling the contract names) and refuses 0, a negative size and one byte more', async () => {
    for (const n of [1, 2, 10485760, TRUST_DOCUMENT_SIZE_CEILING]) await insertRaw({ size: n });
    for (const n of [0, -1, TRUST_DOCUMENT_SIZE_CEILING + 1, 4294967296]) await expectConstraint(insertRaw({ size: n }), 'ck_documents__size');
    expect(TRUST_DOCUMENT_SIZE_CEILING).toBe(50 * 1024 * 1024);
  });
  it('accepts a lower-case hex SHA-256 of 64 characters and refuses a short, long, upper-case or non-hex hash', async () => {
    const attached = { status: 'ATTACHED', finalized: true };
    for (const ok of [SHA, '0123456789abcdef'.repeat(4), 'f'.repeat(64)]) await insertRaw({ ...attached, sha: ok });
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(63)}`, `${'a'.repeat(63)}\n`])
      await expectConstraint(insertRaw({ ...attached, sha: bad }), 'ck_documents__sha256');
  });
  it('accepts exactly the five document statuses and the four scan statuses of the contract and refuses any other', async () => {
    // a status outside the list fails the lifecycle CHECK too; the constraints are evaluated by name, so the lifecycle one answers first
    for (const bad of ['BOGUS', 'uploaded', 'upload_pending', '', 'PENDING', 'DELETED', 'REPLACED'])
      expect(['ck_documents__lifecycle', 'ck_documents__status'], JSON.stringify(bad)).toContain(await outcomeOf(insertRaw({ status: bad })));
    for (const s of TRUST_SCAN_STATUSES) await insertRaw({ scan: s });
    for (const bad of ['BOGUS', 'clean', 'DIRTY', '', 'SKIPPED', 'CLEAN ']) await expectConstraint(insertRaw({ scan: bad }), 'ck_documents__scan');
  });
  it('enforces the lifecycle in all 160 combinations of status x hash x finalized_at x round (none or 1) x submitted_at x withdrawn_at, and refuses round 0 on a submitted document', async () => {
    const allowed = (status: string, sha: boolean, fin: boolean, round: number | null, sub: boolean, wd: boolean): boolean => {
      switch (status) {
        case 'UPLOAD_PENDING':
          return !sha && !fin && round === null && !sub && !wd;
        case 'ATTACHED':
          return sha && fin && round === null && !sub && !wd;
        case 'SUBMITTED':
          return sha && fin && round !== null && sub && !wd;
        case 'WITHDRAWN':
          return sha && fin && round === null && !sub && wd;
        default: // ABANDONED
          return round === null && !sub;
      }
    };
    const observed: { key: string; outcome: string; expected: string }[] = [];
    for (const status of TRUST_DOCUMENT_STATUSES)
      for (const sha of [false, true])
        for (const fin of [false, true])
          for (const round of [null, 1])
            for (const sub of [false, true])
              for (const wd of [false, true]) {
                const outcome = await outcomeOf(insertRaw({ status, sha: sha ? SHA : null, finalized: fin, round, submitted: sub, withdrawn: wd }));
                const key = `${status}/sha:${sha}/fin:${fin}/round:${round}/sub:${sub}/wd:${wd}`;
                observed.push({ key, outcome, expected: allowed(status, sha, fin, round, sub, wd) ? 'ACCEPTED' : 'ck_documents__lifecycle' });
              }
    expect(observed).toHaveLength(160);
    expect(observed.filter((o) => o.outcome !== o.expected)).toEqual([]);
    expect(observed.filter((o) => o.outcome === 'ACCEPTED')).toHaveLength(1 + 1 + 1 + 1 + 8);
    await expectConstraint(insertRaw({ status: 'SUBMITTED', sha: SHA, finalized: true, round: 0, submitted: true }), 'ck_documents__lifecycle');
  });
  it('refuses a NULL in every NOT NULL column by name, and a missing requirement or document type by the foreign keys (guards off)', async () => {
    await expectNotNull(insertRaw({ size: null }), 'size_bytes');
    await expectNotNull(insertRaw({ status: null }), 'status');
    await expectNotNull(insertRaw({ scan: null }), 'scan_status');
    await expectNotNull(insertRaw({ mime: null as unknown as string }), 'mime_type');
    await expectNotNull(
      isolated(
        noTriggers(DOC),
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes) VALUES ($1, (SELECT document_type_id FROM ${DTYPE} LIMIT 1), 'trust/evidence/${caseId}/${randomUUID()}', 'a/b', 1)`,
        [reqId],
      ),
      'upload_expires_at',
    );
    await expectNotNull(
      isolated(
        noTriggers(DOC),
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, mime_type, size_bytes, upload_expires_at) VALUES ($1, (SELECT document_type_id FROM ${DTYPE} LIMIT 1), 'a/b', 1, now())`,
        [reqId],
      ),
      'object_key',
    );
    await expectConstraint(
      isolated(
        noTriggers(DOC),
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES (gen_random_uuid(), (SELECT document_type_id FROM ${DTYPE} LIMIT 1), 'trust/evidence/${caseId}/${randomUUID()}', 'a/b', 1, now())`,
      ),
      'fk_documents__case_requirement_id',
    );
    await expectConstraint(
      isolated(
        noTriggers(DOC),
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, gen_random_uuid(), 'trust/evidence/${caseId}/${randomUUID()}', 'a/b', 1, now())`,
        [reqId],
      ),
      'fk_documents__document_type_id',
    );
  });
});

describe('C6. reviews: round >= 1, the decision list, the reason in every combination, the expiry only on an approval, the reviewer format, the unique decisions, NOT NULL', () => {
  let req: Req;
  beforeAll(async () => {
    req = await makeReqIn('IN_REVIEW');
  });
  interface RawRev {
    round?: number | null;
    decision?: string;
    reason?: string | null;
    expires?: boolean;
    reviewer?: string | null;
    correlation?: string | null;
    reqId?: string | null;
  }
  const rawRev = (o: RawRev = {}): [string, unknown[]] => [
    `INSERT INTO ${REV} (case_requirement_id, round, decision, reason_code, reviewer, expires_at, correlation_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      o.reqId === undefined ? req.id : o.reqId,
      o.round === undefined ? 1 : o.round,
      o.decision ?? 'STARTED',
      o.reason === undefined ? null : o.reason,
      o.reviewer === undefined ? 'admin:reviewer-1' : o.reviewer,
      o.expires ? new Date(Date.now() + 86400000) : null,
      o.correlation === undefined ? 'c-1' : o.correlation,
    ],
  ];
  const insertRaw = (o: RawRev = {}) => isolated(noTriggers(REV), ...rawRev(o));

  it('accepts exactly the four decisions of the contract (with a consistent reason) and refuses any other', async () => {
    for (const d of TRUST_REVIEW_DECISIONS)
      await insertRaw({ decision: d, reason: d === 'REJECTED' || d === 'ACTION_REQUIRED' ? 'DOCUMENT_UNREADABLE' : null });
    for (const bad of ['BOGUS', 'approved', 'REVOKED', '', 'EXPIRED', 'CANCELLED', 'STARTED '])
      await expectConstraint(insertRaw({ decision: bad }), 'ck_reviews__decision');
  });
  it('refuses a round below 1 and accepts 1 and large rounds', async () => {
    for (const n of [0, -1]) await expectConstraint(insertRaw({ round: n }), 'ck_reviews__round');
    for (const n of [1, 2, 10000, 2147483647]) await insertRaw({ round: n });
  });
  it('requires a reason code exactly for REJECTED and ACTION_REQUIRED, and none for STARTED and APPROVED (all 8 combinations)', async () => {
    for (const d of TRUST_REVIEW_DECISIONS)
      for (const reason of [null, 'DOCUMENT_UNREADABLE']) {
        const needs = d === 'REJECTED' || d === 'ACTION_REQUIRED';
        expect(await outcomeOf(insertRaw({ decision: d, reason })), `${d}/${reason}`).toBe((reason !== null) === needs ? 'ACCEPTED' : 'ck_reviews__reason');
      }
  });
  it('allows an expiry only on an approval (all four decisions x with and without an expiry)', async () => {
    for (const d of TRUST_REVIEW_DECISIONS)
      for (const expires of [false, true]) {
        const reason = d === 'REJECTED' || d === 'ACTION_REQUIRED' ? 'DOCUMENT_UNREADABLE' : null;
        expect(await outcomeOf(insertRaw({ decision: d, reason, expires })), `${d}/${expires}`).toBe(
          expires && d !== 'APPROVED' ? 'ck_reviews__expires' : 'ACCEPTED',
        );
      }
  });
  it('accepts `admin:<subject>` and `external:<adapter>` reviewers of 1 to 160 characters from the allowed alphabet and refuses everything else (no name, no free text)', async () => {
    for (const ok of [
      'admin:a',
      'admin:3f2c9e1a-0000-4000-8000-000000000000',
      'admin:a.b_c-d:e@f',
      'external:fake',
      `admin:${'x'.repeat(160)}`,
      `external:${'x'.repeat(160)}`,
    ])
      await insertRaw({ reviewer: ok });
    for (const bad of [
      '',
      'admin',
      'admin:',
      'external:',
      'user:x',
      'Admin:x',
      'ADMIN:x',
      'admin x',
      'admin:x y',
      'admin:é',
      `admin:${'x'.repeat(161)}`,
      ' admin:x',
      'admin:x\n',
      'system:job',
      'admin:a/b',
      'admin:a#b',
    ])
      await expectConstraint(insertRaw({ reviewer: bad }), 'ck_reviews__reviewer');
  });
  it('keeps at most ONE terminal decision and ONE start per requirement and round (guards off): two decisions of different kinds in one round collide, a start beside a decision does not, a new round starts again', async () => {
    const two = async (a: [string, string | null], b: [string, string | null], round2 = 1) =>
      outcomeOf(
        rolledBack(async (c) => {
          await c.query(`ALTER TABLE ${REV} DISABLE TRIGGER USER`);
          await c.query(...rawRev({ decision: a[0], reason: a[1] }));
          await c.query(...rawRev({ decision: b[0], reason: b[1], round: round2 }));
        }),
      );
    const R = 'DOCUMENT_UNREADABLE';
    expect(await two(['APPROVED', null], ['APPROVED', null])).toBe('uq_reviews__decision');
    expect(await two(['APPROVED', null], ['REJECTED', R])).toBe('uq_reviews__decision');
    expect(await two(['REJECTED', R], ['ACTION_REQUIRED', R])).toBe('uq_reviews__decision');
    expect(await two(['ACTION_REQUIRED', R], ['ACTION_REQUIRED', R])).toBe('uq_reviews__decision');
    expect(await two(['STARTED', null], ['STARTED', null])).toBe('uq_reviews__started');
    expect(await two(['STARTED', null], ['APPROVED', null])).toBe('ACCEPTED');
    expect(await two(['REJECTED', R], ['STARTED', null])).toBe('ACCEPTED');
    expect(await two(['APPROVED', null], ['APPROVED', null], 2)).toBe('ACCEPTED');
    expect(await two(['STARTED', null], ['STARTED', null], 2)).toBe('ACCEPTED');
  });
  it('refuses a NULL in every NOT NULL column by name, and a missing requirement or reason code by the foreign keys', async () => {
    await expectNotNull(insertRaw({ round: null }), 'round');
    await expectNotNull(insertRaw({ reviewer: null }), 'reviewer');
    await expectNotNull(insertRaw({ correlation: null }), 'correlation_id');
    await expectNotNull(insertRaw({ reqId: null }), 'case_requirement_id');
    await expectNotNull(
      isolated(noTriggers(REV), `INSERT INTO ${REV} (case_requirement_id, round, reviewer, correlation_id) VALUES ($1, 1, 'admin:x', 'c')`, [req.id]),
      'decision',
    );
    await expectNotNull(
      isolated(
        noTriggers(REV),
        `INSERT INTO ${REV} (case_requirement_id, round, decision, reviewer, correlation_id, reviewed_at) VALUES ($1, 1, 'STARTED', 'admin:x', 'c', NULL)`,
        [req.id],
      ),
      'reviewed_at',
    );
    await expectConstraint(insertRaw({ reqId: randomUUID() }), 'fk_reviews__case_requirement_id');
    await expectConstraint(insertRaw({ decision: 'REJECTED', reason: 'NO_SUCH_REASON' }), 'fk_reviews__reason_code');
  });
});

describe('C7. external_verifications and audit_events: formats, vocabularies, uniqueness, the subject rule, NOT NULL', () => {
  let ext: Req;
  beforeAll(async () => {
    ext = await makeReqIn('PENDING', extDef);
  });
  const rawExt = (o: { round?: number | null; adapter?: string | null; externalId?: string | null; status?: string | null; reqId?: string | null } = {}) =>
    isolated(noTriggers(EXT), `INSERT INTO ${EXT} (case_requirement_id, round, adapter, external_id, status) VALUES ($1, $2, $3, $4, $5)`, [
      o.reqId === undefined ? ext.id : o.reqId,
      o.round === undefined ? 1 : o.round,
      o.adapter === undefined ? 'fake' : o.adapter,
      o.externalId === undefined ? `x-${++seq}` : o.externalId,
      o.status === undefined ? 'CREATED' : o.status,
    ]);
  it('external verifications: round >= 1; adapter a lower-case word of 2 to 32 characters; external id of 1 to 128 characters from a safe alphabet; exactly the six statuses', async () => {
    for (const n of [0, -1]) await expectConstraint(rawExt({ round: n }), 'ck_external_verifications__round');
    for (const n of [1, 7]) await rawExt({ round: n });
    for (const ok of ['fa', 'fake', 'id_me2', `a${'b'.repeat(31)}`]) await rawExt({ adapter: ok });
    for (const bad of ['', 'a', 'A', 'Fake', '1fake', '_fake', 'fa-ke', 'fa ke', 'fake.x', `a${'b'.repeat(32)}`, 'fake\n'])
      await expectConstraint(rawExt({ adapter: bad }), 'ck_external_verifications__adapter');
    for (const ok of ['a', 'abc-123', 'A.b_c:d-1', 'x'.repeat(128)]) await rawExt({ externalId: ok });
    for (const bad of ['', ' ', 'a b', 'a/b', 'a@b', 'x'.repeat(129), 'é', 'a\n'])
      await expectConstraint(rawExt({ externalId: bad }), 'ck_external_verifications__external_id');
    for (const s of TRUST_EXTERNAL_STATUSES) await rawExt({ status: s });
    for (const bad of ['BOGUS', 'created', 'DONE', '', 'APPROVED ']) await expectConstraint(rawExt({ status: bad }), 'ck_external_verifications__status');
  });
  it('keeps an external reference unique per adapter and external id, and one per requirement and round (guards off)', async () => {
    const dup = (a: { adapter?: string; externalId?: string; round?: number }, b: { adapter?: string; externalId?: string; round?: number }) =>
      outcomeOf(
        rolledBack(async (c) => {
          await c.query(`ALTER TABLE ${EXT} DISABLE TRIGGER USER`);
          for (const o of [a, b])
            await c.query(`INSERT INTO ${EXT} (case_requirement_id, round, adapter, external_id) VALUES ($1, $2, $3, $4)`, [
              ext.id,
              o.round ?? 1,
              o.adapter ?? 'fake',
              o.externalId ?? 'same',
            ]);
        }),
      );
    expect(await dup({}, { round: 2 })).toBe('uq_external_verifications__external');
    expect(await dup({ externalId: 'one' }, { externalId: 'two' })).toBe('uq_external_verifications__round');
    expect(await dup({ externalId: 'one' }, { externalId: 'two', round: 2 })).toBe('ACCEPTED');
    expect(await dup({}, { adapter: 'other', round: 2 })).toBe('ACCEPTED');
  });
  it('external verifications: NOT NULL by name and the foreign key', async () => {
    await expectNotNull(rawExt({ round: null }), 'round');
    await expectNotNull(rawExt({ adapter: null }), 'adapter');
    await expectNotNull(rawExt({ externalId: null }), 'external_id');
    await expectNotNull(rawExt({ status: null }), 'status');
    await expectNotNull(rawExt({ reqId: null }), 'case_requirement_id');
    await expectConstraint(rawExt({ reqId: randomUUID() }), 'fk_external_verifications__case_requirement_id');
  });

  const insAudit = (o: {
    action?: string;
    actor?: string | null;
    changes?: string | null;
    reason?: string | null;
    correlation?: string | null;
    caseId?: string | null;
    reqId?: string | null;
    defId?: string | null;
  }) =>
    isolated(
      [],
      `INSERT INTO ${AUDIT} (actor, action, verification_case_id, case_requirement_id, requirement_definition_id, changes, reason_code, correlation_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        o.actor === undefined ? 'account:test' : o.actor,
        o.action ?? 'VERIFICATION_CASE_OPENED',
        o.caseId === undefined ? ext.caseId : o.caseId,
        o.reqId === undefined ? null : o.reqId,
        o.defId === undefined ? null : o.defId,
        o.changes === undefined ? null : o.changes,
        o.reason === undefined ? null : o.reason,
        o.correlation === undefined ? 'c-1' : o.correlation,
      ],
    );
  it('audit: accepts exactly the 19 actions of the design and refuses any other, including the near misses', async () => {
    for (const a of AUDIT_ACTIONS) await insAudit({ action: a });
    expect(AUDIT_ACTIONS).toHaveLength(19);
    for (const bad of [
      'VERIFICATION_APPROVED_BY',
      'VERIFICATION_DOCUMENT_DOWNLOADED',
      'verification_case_opened',
      '',
      ' VERIFICATION_CASE_OPENED',
      'VERIFICATION_CASE_OPENED ',
      'PROVIDER_REGISTRATION_STARTED',
      'VERIFICATION_REJECTED_ALL',
    ])
      await expectConstraint(insAudit({ action: bad }), 'ck_audit_events__action');
  });
  it('audit: needs at least one subject (a case, a requirement or a definition); any one of them is enough', async () => {
    await expectConstraint(insAudit({ caseId: null }), 'ck_audit_events__subject');
    await insAudit({ caseId: ext.caseId });
    await insAudit({ caseId: null, reqId: ext.id });
    await insAudit({ caseId: null, defId: docDef.id });
    await insAudit({ caseId: ext.caseId, reqId: ext.id, defId: docDef.id });
  });
  it('audit: accepts NULL or a JSON OBJECT as the diff and refuses an array, a scalar, a string and a JSON null; a blank or over-long actor is refused', async () => {
    for (const ok of [null, '{}', '{"a":1}', '{"status":["PENDING","APPROVED"],"round":2}']) await insAudit({ changes: ok });
    for (const bad of ['[]', '[1]', '"x"', '1', 'true', 'null']) await expectConstraint(insAudit({ changes: bad }), 'ck_audit_events__changes_object');
    for (const ok of ['account:00000000-0000-0000-0000-000000000000', 'admin:sub', 'external:fake', 'system:job', 'a', 'a'.repeat(200)])
      await insAudit({ actor: ok });
    for (const bad of ['', ' ', '    ', 'a'.repeat(201)]) await expectConstraint(insAudit({ actor: bad }), 'ck_audit_events__actor');
  });
  it('audit: refuses a NULL actor, action or correlation id by column name and a case, requirement or definition that does not exist by the foreign keys', async () => {
    await expectNotNull(insAudit({ actor: null }), 'actor');
    await expectNotNull(insAudit({ correlation: null }), 'correlation_id');
    await expectNotNull(
      isolated([], `INSERT INTO ${AUDIT} (actor, action, verification_case_id, correlation_id) VALUES ('a', NULL, $1, 'c')`, [ext.caseId]),
      'action',
    );
    await expectNotNull(
      isolated(
        [],
        `INSERT INTO ${AUDIT} (audit_event_id, actor, action, verification_case_id, correlation_id) VALUES (NULL, 'a', 'VERIFICATION_CASE_OPENED', $1, 'c')`,
        [ext.caseId],
      ),
      'audit_event_id',
    );
    await expectNotNull(
      isolated(
        [],
        `INSERT INTO ${AUDIT} (occurred_at, actor, action, verification_case_id, correlation_id) VALUES (NULL, 'a', 'VERIFICATION_CASE_OPENED', $1, 'c')`,
        [ext.caseId],
      ),
      'occurred_at',
    );
    await expectConstraint(insAudit({ caseId: randomUUID() }), 'fk_audit_events__case_id');
    await expectConstraint(insAudit({ caseId: null, reqId: randomUUID() }), 'fk_audit_events__case_requirement_id');
    await expectConstraint(insAudit({ caseId: null, defId: randomUUID() }), 'fk_audit_events__definition_id');
  });
  it('audit: stamps the time of the event itself with clock_timestamp (a time that advances inside one transaction), and takes a row for a case in ANY status (the event follows the change)', async () => {
    const cancelled = await makeCase('CANCELLED');
    await audit({ caseId: cancelled.caseId, action: 'VERIFICATION_CASE_CANCELLED' });
    const times = await inTx(async (x) => {
      await audit({ caseId: ext.caseId }, x);
      await sleep(5);
      await audit({ caseId: ext.caseId }, x);
      return (await x.query(`SELECT occurred_at FROM ${AUDIT} WHERE verification_case_id = $1 ORDER BY occurred_at DESC LIMIT 2`, [ext.caseId])).rows as {
        occurred_at: Date;
      }[];
    });
    expect(times[0]!.occurred_at.getTime()).toBeGreaterThan(times[1]!.occurred_at.getTime());
  });
});

describe('C5b. documents: a SUBMITTED document must name its round (the CHECK says `round IS NOT NULL AND round >= 1`: a NULL round is refused, not passed as unknown)', () => {
  it('refuses a SUBMITTED row without a round by the lifecycle CHECK (guards off), and with round 0', async () => {
    const req = await makeReq();
    const raw = (round: number | null) => {
      const id = randomUUID();
      return isolated(
        noTriggers(DOC),
        `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, sha256, status, round, upload_expires_at, finalized_at, submitted_at)
         VALUES ($1, $2, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'drivers_license'), $3, 'a/b', 1, $4, 'SUBMITTED', $5, now(), now(), now())`,
        [id, req.id, `trust/evidence/${req.caseId}/${id}`, SHA, round],
      );
    };
    await expectConstraint(raw(null), 'ck_documents__lifecycle');
    await expectConstraint(raw(0), 'ck_documents__lifecycle');
    await raw(1);
  });
});
// ====================================================================== D. the guards, each on its exact failing statement
interface Rows {
  /** a fresh row of the table, its identifying column and its id */
  table: string;
  idCol: string;
  make: () => Promise<string>;
}
async function makeDocType(type: TrustRequirementType, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<string> {
  const code = `tdt_${++seq}`;
  await ensureEntry(trustDocumentTypeNameKey(code));
  return (
    await q<{ id: string }>(`INSERT INTO ${DTYPE} (code, requirement_type, status) VALUES ($1, $2, $3) RETURNING document_type_id AS id`, [code, type, status])
  )[0]!.id;
}
const ROWS: Rows[] = [
  { table: DEF, idCol: 'requirement_definition_id', make: async () => (await makeDef({ status: 'INACTIVE' })).id },
  { table: DTYPE, idCol: 'document_type_id', make: () => makeDocType('IDENTITY') },
  {
    table: REASON,
    idCol: 'reason_code_id',
    make: async () => (await q<{ id: string }>(`SELECT reason_code_id AS id FROM ${REASON} WHERE code = (SELECT $1::text)`, [await makeReason('BOTH')]))[0]!.id,
  },
  {
    table: RULE,
    idCol: 'requirement_rule_id',
    make: async () => ((await addRule((await makeDef({ status: 'INACTIVE' })).id, null, null)).rows[0] as { requirement_rule_id: string }).requirement_rule_id,
  },
  { table: CASES, idCol: 'verification_case_id', make: async () => (await makeCase()).caseId },
  { table: CR, idCol: 'case_requirement_id', make: async () => (await makeReq()).id },
  { table: DOC, idCol: 'verification_document_id', make: async () => mkDoc((await makeReq()).id) },
  {
    table: EXT,
    idCol: 'external_verification_id',
    make: async () => {
      const r = await makeReqIn('PENDING', extDef);
      await extRef(r.id);
      return (await q<{ id: string }>(`SELECT external_verification_id AS id FROM ${EXT} WHERE case_requirement_id = $1`, [r.id]))[0]!.id;
    },
  },
];

describe('D1. NOT_DELETABLE: nothing in the verification domain is ever deleted (cancel, switch off, retire, withdraw or expire instead)', () => {
  it.each(ROWS)('refuses DELETE of a row of $table, one row and all rows, and leaves it untouched', async ({ table, idCol, make }) => {
    const id = await make();
    const before = await q(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id]);
    const n = await count(table);
    await expectRule(run(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]), 'NOT_DELETABLE');
    await expectRule(run(`DELETE FROM ${table}`), 'NOT_DELETABLE');
    await expectRule(run(`DELETE FROM ${table} WHERE true`), 'NOT_DELETABLE');
    expect(await q(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id])).toEqual(before);
    expect(await count(table)).toBe(n);
  });
  it.each(ROWS)('lets a DELETE of $table that matches no row through (nothing is deleted, nothing to refuse)', async ({ table, idCol }) => {
    await run(`DELETE FROM ${table} WHERE ${idCol} = gen_random_uuid()`);
    await run(`DELETE FROM ${table} WHERE false`);
  });
  it('refuses to delete a seeded definition, document type, reason code or the seeded rule', async () => {
    await expectRule(run(`DELETE FROM ${DEF} WHERE code = 'identity_verification'`), 'NOT_DELETABLE');
    await expectRule(run(`DELETE FROM ${DTYPE} WHERE code = 'passport'`), 'NOT_DELETABLE');
    await expectRule(run(`DELETE FROM ${REASON} WHERE code = 'NAME_MISMATCH'`), 'NOT_DELETABLE');
    await expectRule(
      run(`DELETE FROM ${RULE} WHERE market_id IS NULL AND service_type_id IS NULL AND requirement_definition_id = $1`, [identityDef]),
      'NOT_DELETABLE',
    );
  });
});

describe('D2. IMMUTABLE_IDENTITY: the ids, codes, owners, scope and creation times never change', () => {
  type Change = [label: string, set: string, params?: unknown[]];
  const cases: [Rows, Change[]][] = [
    [
      ROWS[0]!,
      [
        ['the id', 'requirement_definition_id = gen_random_uuid()'],
        ['the code', "code = 'other_code'"],
        ['the requirement type', "requirement_type = 'LICENSE'"],
        ['the evidence kind', "evidence_kind = 'EXTERNAL'"],
        ['the creation time', "created_at = created_at - interval '1 day'"],
        [
          'everything at once',
          "requirement_definition_id = gen_random_uuid(), code = 'x1', requirement_type = 'LICENSE', evidence_kind = 'EXTERNAL', created_at = now() - interval '1 year'",
        ],
      ],
    ],
    [
      ROWS[1]!,
      [
        ['the id', 'document_type_id = gen_random_uuid()'],
        ['the code', "code = 'other_code'"],
        ['the requirement type', "requirement_type = 'LICENSE'"],
        ['the creation time', "created_at = created_at + interval '1 second'"],
      ],
    ],
    [
      ROWS[2]!,
      [
        ['the id', 'reason_code_id = gen_random_uuid()'],
        ['the code', "code = 'OTHER'"],
        ['the scope', "applies_to = CASE WHEN applies_to = 'BOTH' THEN 'REJECT' ELSE 'BOTH' END"],
        ['the creation time', "created_at = created_at - interval '1 day'"],
      ],
    ],
    [
      ROWS[3]!,
      [
        ['the id', 'requirement_rule_id = gen_random_uuid()'],
        [
          'the definition',
          "requirement_definition_id = (SELECT requirement_definition_id FROM trust.requirement_definitions WHERE code = 'identity_verification')",
        ],
        ['the market', 'market_id = (SELECT market_id FROM geography.markets LIMIT 1)'],
        ['the service type', 'service_type_id = (SELECT service_type_id FROM catalog.service_types LIMIT 1)'],
        ['the creation time', "created_at = created_at - interval '1 day'"],
      ],
    ],
    [
      ROWS[4]!,
      [
        ['the id', 'verification_case_id = gen_random_uuid()'],
        ['the account', 'account_id = gen_random_uuid()'],
        ['the case number', 'case_number = case_number + 1'],
        ['the creation time', "created_at = created_at - interval '1 day'"],
        [
          'everything at once',
          "verification_case_id = gen_random_uuid(), account_id = gen_random_uuid(), case_number = 9, created_at = now() - interval '1 year'",
        ],
      ],
    ],
    [
      ROWS[5]!,
      [
        ['the id', 'case_requirement_id = gen_random_uuid()'],
        ['the case', 'verification_case_id = gen_random_uuid()'],
        [
          'the definition',
          "requirement_definition_id = (SELECT requirement_definition_id FROM trust.requirement_definitions WHERE code = 'identity_verification')",
        ],
        ['the cycle', 'cycle = cycle + 1'],
        ['the creation time', "created_at = created_at - interval '1 day'"],
        ['the time it was required', "required_at = required_at + interval '1 day'"],
      ],
    ],
    [
      ROWS[6]!,
      [
        ['the id', 'verification_document_id = gen_random_uuid()'],
        ['the requirement', 'case_requirement_id = gen_random_uuid()'],
        ['the document type', 'document_type_id = gen_random_uuid()'],
        ['the object key', `object_key = 'trust/evidence/${randomUUID()}/${randomUUID()}'`],
        ['the content type', "mime_type = 'image/png'"],
        ['the size', 'size_bytes = size_bytes + 1'],
        ['the upload deadline', "upload_expires_at = upload_expires_at + interval '1 hour'"],
        ['the creation time', "created_at = created_at - interval '1 day'"],
      ],
    ],
    [
      ROWS[7]!,
      [
        ['the id', 'external_verification_id = gen_random_uuid()'],
        ['the requirement', 'case_requirement_id = gen_random_uuid()'],
        ['the round', 'round = round + 1'],
        ['the adapter', "adapter = 'other'"],
        ['the external id', "external_id = 'other'"],
        ['the creation time', "created_at = created_at - interval '1 day'"],
      ],
    ],
  ];
  for (const [rows, changes] of cases)
    it.each(changes)(`${rows.table}: refuses to change %s, and the row stays`, async (_label, set, params = []) => {
      const id = await rows.make();
      const before = await q(`SELECT * FROM ${rows.table} WHERE ${rows.idCol} = $1`, [id]);
      await expectRule(run(`UPDATE ${rows.table} SET ${set} WHERE ${rows.idCol} = $1`, [id, ...params]), 'IMMUTABLE_IDENTITY');
      expect(await q(`SELECT * FROM ${rows.table} WHERE ${rows.idCol} = $1`, [id])).toEqual(before);
    });
  it.each(ROWS.filter((r) => r.table !== EXT && r.table !== DOC && r.table !== CASES && r.table !== CR))(
    '$table: accepts an UPDATE that sets the identity columns to their own values and leaves the identity alone when other columns change',
    async ({ table, idCol, make }) => {
      const id = await make();
      const before = (await q<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id]))[0]!;
      const ident = Object.keys(before).filter(
        (c) => c === idCol || c === 'created_at' || c === 'code' || c === 'requirement_type' || c === 'applies_to' || c === 'evidence_kind',
      );
      await run(`UPDATE ${table} SET ${ident.map((c) => `${c} = ${c}`).join(', ')} WHERE ${idCol} = $1`, [id]);
      expect((await q<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id]))[0]).toMatchObject(
        Object.fromEntries(ident.map((c) => [c, before[c]])),
      );
    },
  );
});

describe('D3. requirement_definitions: INITIAL_STATUS, STATUS_TRANSITION (the 3 x 3 matrix against the contract), the frozen RETIRED definition, the expiry flag', () => {
  it('refuses to insert a RETIRED definition and an unknown status (the rule answers before the CHECK), and accepts INACTIVE and ACTIVE explicitly and by default', async () => {
    for (const status of ['RETIRED', 'BOGUS', 'active', '', 'DRAFT']) {
      const code = `tdef_${++seq}`;
      await ensureEntry(trustRequirementNameKey(code));
      await ensureEntry(trustRequirementInstructionsKey(code));
      await expectRule(
        run(`INSERT INTO ${DEF} (code, requirement_type, evidence_kind, status) VALUES ($1, 'IDENTITY', 'DOCUMENT', $2)`, [code, status]),
        'INITIAL_STATUS',
      );
      expect(await count(DEF, 'code = $1', [code])).toBe(0);
    }
    for (const status of ['INACTIVE', 'ACTIVE']) await makeDef({ status: status as TrustDefinitionStatus });
    const code = `tdef_${++seq}`;
    await ensureEntry(trustRequirementNameKey(code));
    await ensureEntry(trustRequirementInstructionsKey(code));
    await run(`INSERT INTO ${DEF} (code, requirement_type, evidence_kind) VALUES ($1, 'IDENTITY', 'DOCUMENT')`, [code]);
    expect((await q<{ status: string; expiry_required: boolean }>(`SELECT status, expiry_required FROM ${DEF} WHERE code = $1`, [code]))[0]).toEqual({
      status: 'INACTIVE',
      expiry_required: false,
    });
  });
  const PAIRS = TRUST_DEFINITION_STATUSES.flatMap((from) =>
    TRUST_DEFINITION_STATUSES.map((to) => [from, to] as [TrustDefinitionStatus, TrustDefinitionStatus]),
  );
  it.each(PAIRS)(
    "%s -> %s: the outcome is the contract's (allowed transitions succeed; RETIRED is terminal; a same-state UPDATE is a plain field change, not a transition)",
    async (from, to) => {
      const d = await makeDef({ status: from });
      const outcome = await outcomeOf(setDef(d.id, to));
      expect(outcome).toBe(from === to || isTrustDefinitionTransitionAllowed(from, to) ? 'ACCEPTED' : 'STATUS_TRANSITION');
      expect((await q<{ status: string }>(`SELECT status FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id]))[0]!.status).toBe(
        outcome === 'ACCEPTED' ? to : from,
      );
    },
  );
  it('agrees with isTrustDefinitionTransitionAllowed on every pair of distinct statuses, exactly four of the six moves being allowed', async () => {
    const seen: string[] = [];
    for (const from of TRUST_DEFINITION_STATUSES)
      for (const to of TRUST_DEFINITION_STATUSES) {
        if (from === to) continue;
        const ok = (await outcomeOf(setDef((await makeDef({ status: from })).id, to))) === 'ACCEPTED';
        expect(ok, `${from} -> ${to}`).toBe(isTrustDefinitionTransitionAllowed(from, to));
        seen.push(`${from}>${to}:${ok}`);
      }
    expect(seen.sort()).toEqual([
      'ACTIVE>INACTIVE:true',
      'ACTIVE>RETIRED:true',
      'INACTIVE>ACTIVE:true',
      'INACTIVE>RETIRED:true',
      'RETIRED>ACTIVE:false',
      'RETIRED>INACTIVE:false',
    ]);
  });
  it('refuses an unknown target status as a transition (before the CHECK could), and the definition stays', async () => {
    const d = await makeDef({ status: 'ACTIVE' });
    for (const bad of ['BOGUS', 'active', '', 'DRAFT']) await expectRule(setDef(d.id, bad), 'STATUS_TRANSITION');
    expect((await q<{ status: string }>(`SELECT status FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id]))[0]!.status).toBe('ACTIVE');
  });
  it('lets the expiry flag change while the definition is INACTIVE or ACTIVE (also together with the status), and freezes it once RETIRED; a RETIRED definition accepts an UPDATE that changes nothing', async () => {
    for (const status of ['INACTIVE', 'ACTIVE'] as const) {
      const d = await makeDef({ status, expiry: false });
      await run(`UPDATE ${DEF} SET expiry_required = true WHERE requirement_definition_id = $1`, [d.id]);
      expect((await q<{ e: boolean }>(`SELECT expiry_required AS e FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id]))[0]!.e).toBe(true);
    }
    const d = await makeDef({ status: 'INACTIVE', expiry: false });
    await run(`UPDATE ${DEF} SET status = 'ACTIVE', expiry_required = true WHERE requirement_definition_id = $1`, [d.id]);
    await run(`UPDATE ${DEF} SET status = 'RETIRED', expiry_required = false WHERE requirement_definition_id = $1`, [d.id]);
    const retired = await makeDef({ status: 'RETIRED', expiry: true });
    await expectRule(run(`UPDATE ${DEF} SET expiry_required = false WHERE requirement_definition_id = $1`, [retired.id]), 'STATUS_TRANSITION');
    await expectRule(run(`UPDATE ${DEF} SET expiry_required = NOT expiry_required WHERE requirement_definition_id = $1`, [retired.id]), 'STATUS_TRANSITION');
    await expectRule(setDef(retired.id, 'ACTIVE'), 'STATUS_TRANSITION');
    await run(`UPDATE ${DEF} SET expiry_required = true, status = 'RETIRED' WHERE requirement_definition_id = $1`, [retired.id]);
    expect((await q<{ e: boolean }>(`SELECT expiry_required AS e FROM ${DEF} WHERE requirement_definition_id = $1`, [retired.id]))[0]!.e).toBe(true);
  });
  it('stamps updated_at at the transaction time on every accepted UPDATE and keeps created_at', async () => {
    const d = await makeDef({ status: 'INACTIVE' });
    const before = (
      await q<{ created_at: Date; updated_at: Date }>(`SELECT created_at, updated_at FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id])
    )[0]!;
    await sleep(20);
    await run(`UPDATE ${DEF} SET status = 'ACTIVE', updated_at = '2001-01-01' WHERE requirement_definition_id = $1`, [d.id]);
    const after = (
      await q<{ created_at: Date; updated_at: Date }>(`SELECT created_at, updated_at FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id])
    )[0]!;
    expect(after.created_at).toEqual(before.created_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.updated_at.getFullYear()).toBeGreaterThan(2020);
  });
});

describe('D4. document_types and reason_codes: only the status moves (any way between ACTIVE and INACTIVE), the identity is immutable, updated_at is stamped', () => {
  it('lets a document type and a reason code be deactivated and activated again, any number of times, and stamps updated_at', async () => {
    const dt = await makeDocType('LICENSE');
    for (const s of ['INACTIVE', 'ACTIVE', 'INACTIVE', 'INACTIVE', 'ACTIVE']) await run(`UPDATE ${DTYPE} SET status = $2 WHERE document_type_id = $1`, [dt, s]);
    const code = await makeReason('BOTH');
    for (const s of ['INACTIVE', 'ACTIVE', 'INACTIVE', 'INACTIVE', 'ACTIVE']) await run(`UPDATE ${REASON} SET status = $2 WHERE code = $1`, [code, s]);
    const before = (await q<{ updated_at: Date }>(`SELECT updated_at FROM ${DTYPE} WHERE document_type_id = $1`, [dt]))[0]!;
    await sleep(20);
    await run(`UPDATE ${DTYPE} SET status = 'INACTIVE', updated_at = '2001-01-01' WHERE document_type_id = $1`, [dt]);
    const after = (await q<{ updated_at: Date }>(`SELECT updated_at FROM ${DTYPE} WHERE document_type_id = $1`, [dt]))[0]!;
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
  it('refuses an unknown status of either (the CHECK answers: the guard does not model these two)', async () => {
    const dt = await makeDocType('LICENSE');
    await expectConstraint(run(`UPDATE ${DTYPE} SET status = 'RETIRED' WHERE document_type_id = $1`, [dt]), 'ck_document_types__status');
    const code = await makeReason('BOTH');
    await expectConstraint(run(`UPDATE ${REASON} SET status = 'RETIRED' WHERE code = $1`, [code]), 'ck_reason_codes__status');
  });
});

describe('D5. requirement_rules: the unique scope (NULLS NOT DISTINCT), RULE_DEFINITION_RETIRED, the switch, the foreign keys', () => {
  it('keeps ONE rule per definition, market and service type, NULL counting as a value: (all, all), (market, all), (all, service type) and (market, service type) coexist, and each exactly once', async () => {
    const d = await makeDef({ status: 'ACTIVE' });
    const st = await makeServiceType();
    const combos: [string | null, string | null][] = [
      [null, null],
      [laOc, null],
      [null, st.id],
      [laOc, st.id],
    ];
    for (const [m, s] of combos) await addRule(d.id, m, s);
    expect(await count(RULE, 'requirement_definition_id = $1', [d.id])).toBe(4);
    for (const [m, s] of combos) {
      await expectConstraint(addRule(d.id, m, s), 'uq_requirement_rules__scope');
      await expectConstraint(addRule(d.id, m, s, false), 'uq_requirement_rules__scope'); // enabled or not, the scope is taken
    }
    // another definition has its own scopes; the seeded all-markets rule of identity verification blocks a second one
    const other = await makeDef({ status: 'ACTIVE' });
    await addRule(other.id, null, null);
    await expectConstraint(addRule(identityDef, null, null), 'uq_requirement_rules__scope');
    await addRule(identityDef, laOc, null); // a market-specific rule beside the all-markets one is a different scope
    expect(await count(RULE, 'requirement_definition_id = $1', [identityDef])).toBe(2);
  });
  it('refuses an enabled rule for a RETIRED definition at INSERT and when it is switched on at UPDATE, accepts a disabled one, and lets a rule of an INACTIVE or ACTIVE definition be enabled', async () => {
    const retired = await makeDef({ status: 'RETIRED' });
    const st = await makeServiceType();
    await expectRule(addRule(retired.id, null, null, true), 'RULE_DEFINITION_RETIRED');
    expect(await count(RULE, 'requirement_definition_id = $1', [retired.id])).toBe(0);
    const id = ((await addRule(retired.id, null, st.id, false)).rows[0] as { requirement_rule_id: string }).requirement_rule_id;
    await expectRule(run(`UPDATE ${RULE} SET enabled = true WHERE requirement_rule_id = $1`, [id]), 'RULE_DEFINITION_RETIRED');
    expect((await q<{ enabled: boolean }>(`SELECT enabled FROM ${RULE} WHERE requirement_rule_id = $1`, [id]))[0]!.enabled).toBe(false);
    await run(`UPDATE ${RULE} SET enabled = false WHERE requirement_rule_id = $1`, [id]);
    for (const status of ['INACTIVE', 'ACTIVE'] as const) {
      const d = await makeDef({ status });
      const rid = ((await addRule(d.id, null, null, false)).rows[0] as { requirement_rule_id: string }).requirement_rule_id;
      await run(`UPDATE ${RULE} SET enabled = true WHERE requirement_rule_id = $1`, [rid]);
      await run(`UPDATE ${RULE} SET enabled = false WHERE requirement_rule_id = $1`, [rid]);
    }
  });
  it('lets a rule be switched off after its definition is RETIRED, and refuses to switch it on again; the definition itself retires with an enabled rule in place (history)', async () => {
    const d = await makeDef({ status: 'ACTIVE' });
    const rid = ((await addRule(d.id, null, null, true)).rows[0] as { requirement_rule_id: string }).requirement_rule_id;
    await setDef(d.id, 'RETIRED');
    await run(`UPDATE ${RULE} SET enabled = false WHERE requirement_rule_id = $1`, [rid]);
    await expectRule(run(`UPDATE ${RULE} SET enabled = true WHERE requirement_rule_id = $1`, [rid]), 'RULE_DEFINITION_RETIRED');
  });
  it('stamps updated_at when a rule is switched, keeps created_at, and refuses a missing definition, market or service type by the foreign keys and NULL for enabled', async () => {
    const d = await makeDef({ status: 'ACTIVE' });
    const rid = ((await addRule(d.id, null, null, true)).rows[0] as { requirement_rule_id: string }).requirement_rule_id;
    const before = (await q<{ created_at: Date; updated_at: Date }>(`SELECT created_at, updated_at FROM ${RULE} WHERE requirement_rule_id = $1`, [rid]))[0]!;
    await sleep(20);
    await run(`UPDATE ${RULE} SET enabled = false, updated_at = '2001-01-01' WHERE requirement_rule_id = $1`, [rid]);
    const after = (await q<{ created_at: Date; updated_at: Date }>(`SELECT created_at, updated_at FROM ${RULE} WHERE requirement_rule_id = $1`, [rid]))[0]!;
    expect(after.created_at).toEqual(before.created_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    await expectConstraint(addRule(randomUUID(), null, null), 'fk_requirement_rules__definition_id');
    await expectConstraint(addRule(d.id, randomUUID(), null), 'fk_requirement_rules__market_id');
    await expectConstraint(addRule(d.id, null, randomUUID()), 'fk_requirement_rules__service_type_id');
    await expectNotNull(run(`INSERT INTO ${RULE} (requirement_definition_id) VALUES ($1)`, [d.id]), 'enabled');
  });
});

describe('D6. verification_cases (INSERT): CASE_MUST_START_OPEN, ACCOUNT_NOT_ACTIVE (the account row is read FOR SHARE), CASE_NUMBER_SEQUENCE, judged in that order', () => {
  const insertWith = (
    account: string,
    set: Partial<Record<'status' | 'revision' | 'submitted_at' | 'decided_at' | 'cancelled_at' | 'case_number', string | number>>,
  ) => {
    const cols = ['account_id', ...(set.case_number === undefined ? ['case_number'] : []), ...Object.keys(set)];
    const vals = ['$1', ...(set.case_number === undefined ? ['1'] : []), ...Object.values(set).map((v) => (typeof v === 'number' ? String(v) : `'${v}'`))];
    return run(`INSERT INTO ${CASES} (${cols.join(', ')}) VALUES (${vals.join(', ')})`, [account]);
  };
  const bad: [string, Parameters<typeof insertWith>[1]][] = [
    ['IN_REVIEW', { status: 'IN_REVIEW' }],
    ['APPROVED', { status: 'APPROVED' }],
    ['CANCELLED', { status: 'CANCELLED' }],
    ['an unknown status', { status: 'BOGUS' }],
    ['REJECTED (there is no rejected case)', { status: 'REJECTED' }],
    ['revision 2', { revision: 2 }],
    ['revision 0 (the rule, before the CHECK)', { revision: 0 }],
    ['revision 1000', { revision: 1000 }],
    ['a submitted_at', { submitted_at: '2030-01-01T00:00:00Z' }],
    ['a decided_at', { decided_at: '2030-01-01T00:00:00Z' }],
    ['a cancelled_at', { cancelled_at: '2030-01-01T00:00:00Z' }],
    ['CANCELLED with its timestamp', { status: 'CANCELLED', cancelled_at: '2030-01-01T00:00:00Z' }],
    ['APPROVED with its timestamps', { status: 'APPROVED', submitted_at: '2030-01-01T00:00:00Z', decided_at: '2030-01-01T00:00:00Z' }],
  ];
  it.each(bad)('refuses to insert %s', async (_label, set) => {
    const account = await makeAccount();
    await expectRule(insertWith(account, set), 'CASE_MUST_START_OPEN');
    expect(await count(CASES, 'account_id = $1', [account])).toBe(0);
  });
  it('judges the start state BEFORE the account and the number (a bad start for a suspended account and a wrong number still answers CASE_MUST_START_OPEN)', async () => {
    const suspended = await accountIn('SUSPENDED');
    await expectRule(run(`INSERT INTO ${CASES} (account_id, case_number, status) VALUES ($1, 7, 'APPROVED')`, [suspended]), 'CASE_MUST_START_OPEN');
  });
  it.each(['PENDING', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED'] as AccountStatus[])(
    'refuses to open a case for a %s account (only an ACTIVE account can), and leaves no row',
    async (status) => {
      const account = await accountIn(status);
      await expectRule(openCase(account), 'ACCOUNT_NOT_ACTIVE');
      expect(await count(CASES, 'account_id = $1', [account])).toBe(0);
    },
  );
  it('refuses an account that does not exist as not ACTIVE (the guard answers before the foreign key)', async () => {
    await expectRule(run(`INSERT INTO ${CASES} (account_id, case_number) VALUES (gen_random_uuid(), 1)`), 'ACCOUNT_NOT_ACTIVE');
  });
  it('judges the account BEFORE the number (a suspended account with a wrong number answers ACCOUNT_NOT_ACTIVE)', async () => {
    const suspended = await accountIn('SUSPENDED');
    await expectRule(run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, 5)`, [suspended]), 'ACCOUNT_NOT_ACTIVE');
  });
  it('refuses a first case number other than 1 (a gap, 0 and a negative number: the rule answers before the CHECK) and accepts 1', async () => {
    const a = await makeAccount();
    for (const n of [2, 3, 100, 0, -1]) await expectRule(run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, $2)`, [a, n]), 'CASE_NUMBER_SEQUENCE');
    expect(await count(CASES, 'account_id = $1', [a])).toBe(0);
    await run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, 1)`, [a]);
  });
  it('refuses a gap (3 after 1), a repeat (1 after 1) and a step back, in the guard (before the unique key could), and accepts 2 once the first case is cancelled', async () => {
    const a = await makeAccount();
    const first = await openCase(a);
    for (const n of [3, 1, 0, 4]) await expectRule(run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, $2)`, [a, n]), 'CASE_NUMBER_SEQUENCE');
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [first]);
    await run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, 2)`, [a]);
    expect(await count(CASES, 'account_id = $1', [a])).toBe(2);
  });
  it('counts the numbers of ONE account only: a second account starts at 1 whatever the first one did', async () => {
    const [a, b] = [await makeAccount(), await makeAccount()];
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [await openCase(a)]);
    await openCase(a);
    await run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, 1)`, [b]);
    expect(await q(`SELECT case_number FROM ${CASES} WHERE account_id = $1 ORDER BY 1`, [a])).toEqual([{ case_number: 1 }, { case_number: 2 }]);
    expect(await q(`SELECT case_number FROM ${CASES} WHERE account_id = $1 ORDER BY 1`, [b])).toEqual([{ case_number: 1 }]);
  });
  it('accepts an insert that names the initial state explicitly (OPEN, revision 1, NULL timestamps) and by default', async () => {
    const a = await makeAccount();
    await run(
      `INSERT INTO ${CASES} (account_id, case_number, status, revision, submitted_at, decided_at, cancelled_at) VALUES ($1, 1, 'OPEN', 1, NULL, NULL, NULL)`,
      [a],
    );
    const b = await makeAccount();
    const id = await openCase(b);
    expect(await caseRow(id)).toMatchObject({ status: 'OPEN', revision: 1, case_number: 1, submitted_at: null, decided_at: null, cancelled_at: null });
  });
});

describe('D7. verification_cases (UPDATE): the 6 x 6 status matrix, the stamps, REVISION_ONLY_GROWS, CASE_FROZEN', () => {
  const expectedOutcome = (from: TrustCaseStatus, to: TrustCaseStatus): string => {
    if (from === 'CANCELLED') return 'CASE_FROZEN';
    if (from === to) return 'ACCEPTED';
    if (to === 'OPEN') return 'STATUS_TRANSITION';
    if (to === 'CANCELLED' && (from === 'APPROVED' || from === 'EXPIRED')) return 'STATUS_TRANSITION';
    return 'ACCEPTED';
  };
  const PAIRS = TRUST_CASE_STATUSES.flatMap((from) => TRUST_CASE_STATUSES.map((to) => [from, to] as [TrustCaseStatus, TrustCaseStatus]));
  it.each(PAIRS)(
    '%s -> %s: a cancelled case is frozen, a submitted case never returns to OPEN, an approved or expired case is never cancelled, every other move is accepted (the status is DERIVED by the service)',
    async (from, to) => {
      const { caseId } = await makeCase(from);
      const outcome = await outcomeOf(run(`UPDATE ${CASES} SET status = $2 WHERE verification_case_id = $1`, [caseId, to]));
      expect(outcome).toBe(expectedOutcome(from, to));
      expect((await caseRow<{ status: string }>(caseId)).status).toBe(outcome === 'ACCEPTED' ? to : from);
    },
  );
  it('accepts 24 of the 36 moves (6 from OPEN, 5 each from IN_REVIEW and ACTION_REQUIRED, 4 each from APPROVED and EXPIRED) and refuses 12 (6 out of CANCELLED, 4 back into OPEN, 2 cancellations of an end state)', () => {
    let accepted = 0;
    const refused: Record<string, number> = {};
    for (const [from, to] of PAIRS) {
      const o = expectedOutcome(from, to);
      if (o === 'ACCEPTED') accepted++;
      else refused[o] = (refused[o] ?? 0) + 1;
    }
    expect(PAIRS).toHaveLength(36);
    expect(accepted).toBe(24);
    expect(refused).toEqual({ CASE_FROZEN: 6, STATUS_TRANSITION: 6 });
  });
  it('stamps submitted_at when the case first leaves OPEN (the supplied value is ignored), never clears it, and keeps it through every later status', async () => {
    const { caseId } = await makeCase();
    await run(`UPDATE ${CASES} SET status = 'IN_REVIEW', submitted_at = '2001-01-01' WHERE verification_case_id = $1`, [caseId]);
    const first = (await caseRow<{ submitted_at: Date }>(caseId)).submitted_at;
    expect(first.getFullYear()).toBeGreaterThan(2020);
    await sleep(20);
    for (const s of ['ACTION_REQUIRED', 'IN_REVIEW', 'APPROVED', 'EXPIRED', 'APPROVED']) {
      await run(`UPDATE ${CASES} SET status = $2, submitted_at = NULL WHERE verification_case_id = $1`, [caseId, s]);
      expect((await caseRow<{ submitted_at: Date }>(caseId)).submitted_at).toEqual(first);
    }
    // a case that goes straight from OPEN to a non-OPEN status gets the stamp too, and an OPEN case that is only touched keeps NULL
    const open = await makeCase();
    await run(`UPDATE ${CASES} SET revision = revision + 1, submitted_at = '2001-01-01' WHERE verification_case_id = $1`, [open.caseId]);
    expect(await caseRow(open.caseId)).toMatchObject({ status: 'OPEN', submitted_at: null });
  });
  it('stamps decided_at when the case becomes APPROVED (the supplied value is ignored), keeps it after the approval ends, and stamps it again when the case is approved anew', async () => {
    const { caseId } = await makeCase('IN_REVIEW');
    expect((await caseRow(caseId)).decided_at).toBeNull();
    await run(`UPDATE ${CASES} SET status = 'APPROVED', decided_at = '2001-01-01' WHERE verification_case_id = $1`, [caseId]);
    const approved = (await caseRow<{ decided_at: Date }>(caseId)).decided_at;
    expect(approved.getFullYear()).toBeGreaterThan(2020);
    await sleep(20);
    await run(`UPDATE ${CASES} SET status = 'APPROVED', revision = revision + 1, decided_at = NULL WHERE verification_case_id = $1`, [caseId]); // still approved: not a new decision
    expect((await caseRow<{ decided_at: Date }>(caseId)).decided_at).toEqual(approved);
    await run(`UPDATE ${CASES} SET status = 'EXPIRED', decided_at = NULL WHERE verification_case_id = $1`, [caseId]);
    expect((await caseRow<{ decided_at: Date }>(caseId)).decided_at).toEqual(approved); // the time of the last approval
    await sleep(20);
    await run(`UPDATE ${CASES} SET status = 'ACTION_REQUIRED' WHERE verification_case_id = $1`, [caseId]);
    await sleep(20);
    await run(`UPDATE ${CASES} SET status = 'APPROVED' WHERE verification_case_id = $1`, [caseId]);
    expect((await caseRow<{ decided_at: Date }>(caseId)).decided_at.getTime()).toBeGreaterThan(approved.getTime());
  });
  it('stamps cancelled_at when the case is cancelled (the supplied value is ignored), keeps the submitted and decided times it had, and cancels an OPEN case without inventing a submission', async () => {
    const open = await makeCase();
    await run(
      `UPDATE ${CASES} SET status = 'CANCELLED', cancelled_at = '2001-01-01', submitted_at = '2001-01-01', decided_at = '2001-01-01' WHERE verification_case_id = $1`,
      [open.caseId],
    );
    const c = await caseRow<{ cancelled_at: Date; submitted_at: Date | null; decided_at: Date | null }>(open.caseId);
    expect(c.cancelled_at.getFullYear()).toBeGreaterThan(2020);
    expect([c.submitted_at, c.decided_at]).toEqual([null, null]);
    const review = await makeCase('IN_REVIEW');
    const submitted = (await caseRow<{ submitted_at: Date }>(review.caseId)).submitted_at;
    await run(`UPDATE ${CASES} SET status = 'CANCELLED', submitted_at = NULL, decided_at = now() WHERE verification_case_id = $1`, [review.caseId]);
    expect(await caseRow(review.caseId)).toMatchObject({ status: 'CANCELLED', submitted_at: submitted, decided_at: null });
    // a case cancelled from ACTION_REQUIRED after an earlier approval keeps the decision time
    const again = await makeCase('IN_REVIEW');
    await run(`UPDATE ${CASES} SET status = 'APPROVED' WHERE verification_case_id = $1`, [again.caseId]);
    const decided = (await caseRow<{ decided_at: Date }>(again.caseId)).decided_at;
    await run(`UPDATE ${CASES} SET status = 'ACTION_REQUIRED' WHERE verification_case_id = $1`, [again.caseId]);
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [again.caseId]);
    expect((await caseRow<{ decided_at: Date }>(again.caseId)).decided_at).toEqual(decided);
  });
  it('clears a supplied cancelled_at on every status but CANCELLED and stamps updated_at at the transaction time', async () => {
    const { caseId } = await makeCase();
    const before = (await caseRow<{ updated_at: Date }>(caseId)).updated_at;
    await sleep(20);
    await run(`UPDATE ${CASES} SET status = 'IN_REVIEW', cancelled_at = now(), updated_at = '2001-01-01' WHERE verification_case_id = $1`, [caseId]);
    const after = await caseRow<{ cancelled_at: Date | null; updated_at: Date }>(caseId);
    expect(after.cancelled_at).toBeNull();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.getTime());
  });
  it('accepts the same revision, +1 and a jump, and refuses a lower one (to 0 and below 1 the rule answers before the CHECK)', async () => {
    const { caseId } = await makeCase();
    await run(`UPDATE ${CASES} SET revision = 1 WHERE verification_case_id = $1`, [caseId]);
    await run(`UPDATE ${CASES} SET revision = 2 WHERE verification_case_id = $1`, [caseId]);
    await run(`UPDATE ${CASES} SET revision = 50 WHERE verification_case_id = $1`, [caseId]);
    for (const n of [49, 2, 1, 0, -1, -2147483648])
      await expectRule(run(`UPDATE ${CASES} SET revision = $2 WHERE verification_case_id = $1`, [caseId, n]), 'REVISION_ONLY_GROWS');
    await expectRule(run(`UPDATE ${CASES} SET revision = revision - 1 WHERE verification_case_id = $1`, [caseId]), 'REVISION_ONLY_GROWS');
    expect((await caseRow<{ revision: number }>(caseId)).revision).toBe(50);
    // the revision is judged before the status: a refused revision does not move the status
    await expectRule(run(`UPDATE ${CASES} SET revision = 1, status = 'IN_REVIEW' WHERE verification_case_id = $1`, [caseId]), 'REVISION_ONLY_GROWS');
    expect((await caseRow<{ status: string }>(caseId)).status).toBe('OPEN');
  });
  const statements: [string, string][] = [
    ['a no-op revision', 'revision = revision'],
    ['a revision bump', 'revision = revision + 1'],
    ['the same status', 'status = status'],
    ['reopening to OPEN', "status = 'OPEN'"],
    ['approving', "status = 'APPROVED'"],
    ['a timestamp', 'submitted_at = now()'],
    ['clearing cancelled_at', 'cancelled_at = NULL'],
    ['a no-op updated_at', 'updated_at = now()'],
  ];
  it.each(statements)('refuses on a CANCELLED case: %s (CASE_FROZEN), and the case does not change', async (_label, set) => {
    const { caseId } = await makeCase('CANCELLED');
    const before = await caseRow(caseId);
    await expectRule(run(`UPDATE ${CASES} SET ${set} WHERE verification_case_id = $1`, [caseId]), 'CASE_FROZEN');
    expect(await caseRow(caseId)).toEqual(before);
  });
  it('judges the identity BEFORE the frozen state (a cancelled case whose account is changed answers IMMUTABLE_IDENTITY) and lets an UPDATE that matches no row through', async () => {
    const { caseId } = await makeCase('CANCELLED');
    await expectRule(run(`UPDATE ${CASES} SET case_number = 9 WHERE verification_case_id = $1`, [caseId]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run(`UPDATE ${CASES} SET created_at = now() + interval '1 day', revision = revision + 1 WHERE verification_case_id = $1`, [caseId]),
      'IMMUTABLE_IDENTITY',
    );
    await run(`UPDATE ${CASES} SET revision = revision WHERE false`);
    await run(`UPDATE ${CASES} SET revision = revision WHERE verification_case_id = gen_random_uuid()`);
  });
  it('accepts an UPDATE that sets the identity columns to their own values (no change)', async () => {
    const { caseId } = await makeCase();
    await run(
      `UPDATE ${CASES} SET verification_case_id = verification_case_id, account_id = account_id, case_number = case_number, created_at = created_at WHERE verification_case_id = $1`,
      [caseId],
    );
  });
});

describe('D8. at most one live case per account: every status but CANCELLED holds the account, CANCELLED does not, accounts are independent', () => {
  const insertCase = (account: string, n: number) => run(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, $2)`, [account, n]);
  it.each(['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[])(
    'blocks a second case while the first is %s, by the partial unique key (the case number itself is the correct next one)',
    async (kind) => {
      const { account } = await makeCase(kind);
      await expectConstraint(insertCase(account, 2), 'uq_verification_cases__live');
      expect(await count(CASES, 'account_id = $1', [account])).toBe(1);
    },
  );
  it('allows the next case after a CANCELLED one, any number of times, and blocks again while the new one is live; the numbers read 1, 2, 3 and 4 without gaps', async () => {
    const a = await makeAccount();
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      ids.push(await openCase(a));
      await expectConstraint(insertCase(a, n + 1), 'uq_verification_cases__live');
      await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [ids[n - 1]]);
    }
    ids.push(await openCase(a));
    expect(await q<{ case_number: number; status: string }>(`SELECT case_number, status FROM ${CASES} WHERE account_id = $1 ORDER BY 1`, [a])).toEqual([
      { case_number: 1, status: 'CANCELLED' },
      { case_number: 2, status: 'CANCELLED' },
      { case_number: 3, status: 'CANCELLED' },
      { case_number: 4, status: 'OPEN' },
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('keeps two accounts independent: each has its own live case and its own numbers', async () => {
    const [a, b] = [await makeAccount(), await makeAccount()];
    const [ca, cb] = [await openCase(a), await openCase(b)];
    expect([(await caseRow<{ case_number: number }>(ca)).case_number, (await caseRow<{ case_number: number }>(cb)).case_number]).toEqual([1, 1]);
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [ca]);
    await expectConstraint(insertCase(b, 2), 'uq_verification_cases__live');
    await openCase(a);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('is the PARTIAL key and the number key that decide, with the guards off: two CANCELLED rows of one account coexist, a live row beside a cancelled one coexists, two live rows (whatever their statuses) do not, and one number twice does not', async () => {
    const a = await makeAccount();
    const raw = (n: number, status: string): [string, unknown[]] => [
      `INSERT INTO ${CASES} (account_id, case_number, status, submitted_at, decided_at, cancelled_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        a,
        n,
        status,
        status === 'OPEN' || status === 'CANCELLED' ? null : new Date(),
        status === 'APPROVED' ? new Date() : null,
        status === 'CANCELLED' ? new Date() : null,
      ],
    ];
    const two = async (s1: string, s2: string, n2 = 2) =>
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${CASES} DISABLE TRIGGER USER`);
        await c.query(...raw(1, s1));
        await c.query(...raw(n2, s2));
      });
    expect(await outcomeOf(two('CANCELLED', 'CANCELLED'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('CANCELLED', 'OPEN'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('APPROVED', 'CANCELLED'))).toBe('ACCEPTED');
    expect(await outcomeOf(two('OPEN', 'OPEN'))).toBe('uq_verification_cases__live');
    expect(await outcomeOf(two('APPROVED', 'OPEN'))).toBe('uq_verification_cases__live');
    expect(await outcomeOf(two('IN_REVIEW', 'EXPIRED'))).toBe('uq_verification_cases__live');
    expect(await outcomeOf(two('EXPIRED', 'ACTION_REQUIRED'))).toBe('uq_verification_cases__live');
    expect(await outcomeOf(two('CANCELLED', 'CANCELLED', 1))).toBe('uq_verification_cases__number');
  });
});

/** Approves `n` requirements to end in one second, waits for the database clock to pass the end (a real 1.5 s: the guard reads clock_timestamp()) and records their expiry. */
async function expiredReqs(n: number, def: Def = docDef): Promise<Req[]> {
  const reqs = await makeApprovedSoon(n, def);
  await sleep(1500);
  for (const r of reqs) await expireReq(r.id);
  return reqs;
}
const statusOf = async (id: string): Promise<string> => (await crRow<{ status: string }>(id)).status;

describe('D9. case_requirements (INSERT): CASE_FROZEN, REQUIREMENT_NOT_ACTIVE, MUST_START_NOT_STARTED, CYCLE_SEQUENCE, CYCLE_NEEDS_EXPIRED, judged in that order', () => {
  const ins = (caseId: string, defId: string, set: Record<string, string | number | null> = {}, cycle = 1) => {
    const cols = ['verification_case_id', 'requirement_definition_id', 'cycle', ...Object.keys(set)];
    const vals = ['$1', '$2', String(cycle), ...Object.values(set).map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))];
    return run(`INSERT INTO ${CR} (${cols.join(', ')}) VALUES (${vals.join(', ')})`, [caseId, defId]);
  };
  it('refuses a requirement for a CANCELLED case and for a case that does not exist (CASE_FROZEN, before the foreign key), and accepts one for every other case status (policy can add a requirement to a case already in progress)', async () => {
    const { caseId } = await makeCase('CANCELLED');
    await expectRule(ins(caseId, docDef.id), 'CASE_FROZEN');
    await expectRule(ins(randomUUID(), docDef.id), 'CASE_FROZEN');
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
    for (const kind of ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[]) {
      const c = await makeCase(kind);
      await ins(c.caseId, docDef.id);
      expect(await count(CR, 'verification_case_id = $1', [c.caseId]), kind).toBe(1);
    }
  });
  it('refuses a definition that is INACTIVE, RETIRED or missing (REQUIREMENT_NOT_ACTIVE), the seeded INACTIVE ones included, and accepts ACTIVE', async () => {
    const { caseId } = await makeCase();
    for (const status of ['INACTIVE', 'RETIRED'] as const) await expectRule(ins(caseId, (await makeDef({ status })).id), 'REQUIREMENT_NOT_ACTIVE');
    for (const code of ['background_check', 'professional_license', 'liability_insurance']) {
      const id = (await q<{ id: string }>(`SELECT requirement_definition_id AS id FROM ${DEF} WHERE code = $1`, [code]))[0]!.id;
      await expectRule(ins(caseId, id), 'REQUIREMENT_NOT_ACTIVE');
    }
    await expectRule(ins(caseId, randomUUID()), 'REQUIREMENT_NOT_ACTIVE');
    await ins(caseId, identityDef);
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
  });
  it('judges the case BEFORE the definition (a cancelled case and an INACTIVE definition answer CASE_FROZEN), and the definition BEFORE the start state', async () => {
    const { caseId } = await makeCase('CANCELLED');
    await expectRule(ins(caseId, (await makeDef({ status: 'INACTIVE' })).id), 'CASE_FROZEN');
    const open = await makeCase();
    await expectRule(ins(open.caseId, (await makeDef({ status: 'INACTIVE' })).id, { status: 'PENDING' }), 'REQUIREMENT_NOT_ACTIVE');
  });
  const startBad: [string, Record<string, string | number | null>][] = [
    ['PENDING', { status: 'PENDING' }],
    ['APPROVED', { status: 'APPROVED' }],
    ['NOT_REQUIRED', { status: 'NOT_REQUIRED' }],
    ['an unknown status (the rule, before the CHECK)', { status: 'BOGUS' }],
    ['round 1', { round: 1 }],
    ['revision 2', { revision: 2 }],
    ['revision 0 (the rule, before the CHECK)', { revision: 0 }],
    ['a submitted_at', { submitted_at: '2030-01-01T00:00:00Z' }],
    ['a decided_at', { decided_at: '2030-01-01T00:00:00Z' }],
    ['an approved_at', { approved_at: '2030-01-01T00:00:00Z' }],
    ['an expires_at', { expires_at: '2030-01-01T00:00:00Z' }],
    ['a superseded_at', { superseded_at: '2030-01-01T00:00:00Z' }],
  ];
  it.each(startBad)('refuses to insert %s', async (_label, set) => {
    const { caseId } = await makeCase();
    await expectRule(ins(caseId, docDef.id, set), 'MUST_START_NOT_STARTED');
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
  });
  it('accepts an insert that names the initial state explicitly (NOT_STARTED, round 0, revision 1, NULL timestamps) and by default, and stamps required_at at the transaction time', async () => {
    const { caseId } = await makeCase();
    await ins(caseId, docDef.id, {
      status: 'NOT_STARTED',
      round: 0,
      revision: 1,
      submitted_at: null,
      decided_at: null,
      approved_at: null,
      expires_at: null,
      superseded_at: null,
    });
    const id = await addReq(caseId, expDef.id);
    expect(await crRow(id)).toMatchObject({
      status: 'NOT_STARTED',
      round: 0,
      revision: 1,
      cycle: 1,
      submitted_at: null,
      decided_at: null,
      approved_at: null,
      expires_at: null,
      superseded_at: null,
    });
    expect((await crRow<{ required_at: Date }>(id)).required_at.getFullYear()).toBeGreaterThan(2020);
  });
  it('refuses a first cycle other than 1 (a gap, 0 and a negative number: the rule answers before the CHECK), a repeat of cycle 1 and a gap (3 after 1), and accepts 1', async () => {
    const { caseId } = await makeCase();
    for (const n of [2, 3, 100, 0, -1]) await expectRule(ins(caseId, docDef.id, {}, n), 'CYCLE_SEQUENCE');
    await ins(caseId, docDef.id, {}, 1);
    for (const n of [1, 3, 0, 4]) await expectRule(ins(caseId, docDef.id, {}, n), 'CYCLE_SEQUENCE');
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
  });
  it('counts the cycles per case AND definition: another definition in the same case, and the same definition in another case, start at 1', async () => {
    const [a, b] = [await makeCase(), await makeCase()];
    await ins(a.caseId, docDef.id);
    await ins(a.caseId, expDef.id);
    await ins(b.caseId, docDef.id);
    expect(await count(CR, 'verification_case_id = ANY($1)', [[a.caseId, b.caseId]])).toBe(3);
  });
  it.each(TRUST_REQUIREMENT_STATUSES.filter((s) => s !== 'EXPIRED'))(
    'refuses cycle 2 while cycle 1 is %s (a new cycle replaces an EXPIRED, superseded one), and leaves the case with one instance',
    async (kind) => {
      const r = await makeReqIn(kind);
      await expectRule(ins(r.caseId, docDef.id, {}, 2), 'CYCLE_NEEDS_EXPIRED');
      expect(await count(CR, 'verification_case_id = $1', [r.caseId])).toBe(1);
    },
  );
  it('refuses cycle 2 while cycle 1 is EXPIRED but not superseded, accepts it once cycle 1 is superseded, and then demands the same of cycle 3', async () => {
    const [r] = await expiredReqs(1);
    expect(await statusOf(r!.id)).toBe('EXPIRED');
    await expectRule(ins(r!.caseId, docDef.id, {}, 2), 'CYCLE_NEEDS_EXPIRED');
    await supersedeReq(r!.id);
    await ins(r!.caseId, docDef.id, {}, 2);
    await expectRule(ins(r!.caseId, docDef.id, {}, 3), 'CYCLE_NEEDS_EXPIRED');
    await expectRule(ins(r!.caseId, docDef.id, {}, 2), 'CYCLE_SEQUENCE');
    expect(
      await q<{ cycle: number; superseded: boolean }>(
        `SELECT cycle, superseded_at IS NOT NULL AS superseded FROM ${CR} WHERE verification_case_id = $1 ORDER BY cycle`,
        [r!.caseId],
      ),
    ).toEqual([
      { cycle: 1, superseded: true },
      { cycle: 2, superseded: false },
    ]);
  });
  it('supersedes and starts the next cycle in ONE transaction (the order the service uses), and the new cycle starts NOT_STARTED at round 0 with the old approval kept as history', async () => {
    const [r] = await expiredReqs(1);
    const approvedAt = (await crRow<{ approved_at: Date; expires_at: Date }>(r!.id)).approved_at;
    const next = await inTx(async (c) => {
      await supersedeReq(r!.id, c);
      return addReq(r!.caseId, docDef.id, c);
    });
    expect(await crRow(next)).toMatchObject({ cycle: 2, status: 'NOT_STARTED', round: 0, superseded_at: null });
    expect(await crRow(r!.id)).toMatchObject({ cycle: 1, status: 'EXPIRED', round: 1, approved_at: approvedAt });
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('keeps one row per (case, definition, cycle) and ONE current instance per case and definition (guards off): a repeated cycle and two live cycles collide, a superseded cycle beside a live one does not', async () => {
    const { caseId } = await makeCase();
    const raw = (cycle: number, superseded: boolean): [string, unknown[]] => [
      `INSERT INTO ${CR} (verification_case_id, requirement_definition_id, cycle, status, round, submitted_at, approved_at, expires_at, superseded_at)
       VALUES ($1, $2, $3, ${superseded ? "'EXPIRED', 1, now(), now(), now() + interval '1 day', now()" : "'NOT_STARTED', 0, NULL, NULL, NULL, NULL"})`,
      [caseId, docDef.id, cycle],
    ];
    const two = (a: [number, boolean], b: [number, boolean]) =>
      outcomeOf(
        rolledBack(async (c) => {
          await c.query(`ALTER TABLE ${CR} DISABLE TRIGGER USER`);
          await c.query(...raw(...a));
          await c.query(...raw(...b));
        }),
      );
    expect(await two([1, false], [1, false])).toBe('uq_case_requirements__cycle');
    expect(await two([1, false], [2, false])).toBe('uq_case_requirements__current');
    expect(await two([1, true], [2, false])).toBe('ACCEPTED');
    expect(await two([1, true], [2, true])).toBe('ACCEPTED');
    expect(await two([1, true], [1, false])).toBe('uq_case_requirements__cycle');
  });
});

describe('D10. case_requirements (UPDATE): the 8 x 8 status matrix against the contract', () => {
  const STATEMENT: Record<TrustRequirementStatus, string> = {
    NOT_STARTED: "status = 'NOT_STARTED'",
    PENDING: "status = 'PENDING', round = round + 1",
    IN_REVIEW: "status = 'IN_REVIEW'",
    ACTION_REQUIRED: "status = 'ACTION_REQUIRED'",
    APPROVED: "status = 'APPROVED', expires_at = now() + interval '1 hour'",
    REJECTED: "status = 'REJECTED'",
    EXPIRED: "status = 'EXPIRED'",
    NOT_REQUIRED: "status = 'NOT_REQUIRED'",
  };
  const sources = new Map<string, Req>();
  const key = (from: string, to: string) => `${from}>${to}`;
  beforeAll(async () => {
    // one requirement per pair, built along a legal path; every approval ends in one second so that APPROVED -> EXPIRED can be tried after the clock has passed it
    for (const from of TRUST_REQUIREMENT_STATUSES)
      for (const to of TRUST_REQUIREMENT_STATUSES)
        sources.set(key(from, to), await makeReqIn(from, docDef, from === 'APPROVED' || from === 'EXPIRED' ? SOON : null));
    await sleep(1500);
    for (const [k, r] of sources) if (k.startsWith('EXPIRED>')) await expireReq(r.id);
  });

  it('answers every one of the 64 pairs: a same-state UPDATE is a field change (accepted), an allowed transition is accepted, every other one is refused STATUS_TRANSITION; the allowed set is exactly the contract (17 transitions)', async () => {
    const observed: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (const from of TRUST_REQUIREMENT_STATUSES)
      for (const to of TRUST_REQUIREMENT_STATUSES) {
        const r = sources.get(key(from, to))!;
        expect(await statusOf(r.id), `source ${from}`).toBe(from);
        observed[key(from, to)] = await outcomeOf(setReq(r.id, from === to ? 'status = status' : STATEMENT[to]));
        after[key(from, to)] = await statusOf(r.id);
      }
    const expected = Object.fromEntries(
      TRUST_REQUIREMENT_STATUSES.flatMap((from) =>
        TRUST_REQUIREMENT_STATUSES.map(
          (to) => [key(from, to), from === to || isTrustRequirementTransitionAllowed(from, to) ? 'ACCEPTED' : 'STATUS_TRANSITION'] as const,
        ),
      ),
    );
    expect(observed).toEqual(expected);
    expect(Object.values(observed).filter((o) => o === 'ACCEPTED')).toHaveLength(8 + 17);
    expect(Object.entries(observed).filter(([k, o]) => o === 'ACCEPTED' && k.split('>')[0] !== k.split('>')[1])).toHaveLength(17);
    // an accepted move landed, a refused one changed nothing
    expect(after).toEqual(Object.fromEntries(Object.entries(observed).map(([k, o]) => [k, o === 'ACCEPTED' ? k.split('>')[1]! : k.split('>')[0]!])));
  });
  it('allows exactly these 17 moves (the workflow of the design) and no other', () => {
    const allowed = TRUST_REQUIREMENT_STATUSES.flatMap((f) =>
      TRUST_REQUIREMENT_STATUSES.filter((t) => isTrustRequirementTransitionAllowed(f, t)).map((t) => `${f}>${t}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'NOT_STARTED>PENDING',
        'NOT_STARTED>NOT_REQUIRED',
        'PENDING>IN_REVIEW',
        'PENDING>ACTION_REQUIRED',
        'PENDING>APPROVED',
        'PENDING>REJECTED',
        'PENDING>NOT_REQUIRED',
        'IN_REVIEW>ACTION_REQUIRED',
        'IN_REVIEW>APPROVED',
        'IN_REVIEW>REJECTED',
        'IN_REVIEW>NOT_REQUIRED',
        'ACTION_REQUIRED>PENDING',
        'ACTION_REQUIRED>NOT_REQUIRED',
        'REJECTED>PENDING',
        'REJECTED>NOT_REQUIRED',
        'APPROVED>EXPIRED',
        'NOT_REQUIRED>NOT_STARTED',
      ].sort(),
    );
  });
  it('refuses an unknown target status as a transition (before the CHECK could), from every status, and nothing changes', async () => {
    for (const from of ['NOT_STARTED', 'PENDING', 'APPROVED', 'NOT_REQUIRED'] as const) {
      const r = await makeReqIn(from);
      for (const bad of ['BOGUS', 'pending', '', 'CANCELLED', 'SUBMITTED']) await expectRule(setReq(r.id, 'status = $2', [bad]), 'STATUS_TRANSITION');
      expect(await statusOf(r.id)).toBe(from);
    }
  });
  it('lets the evidence be re-submitted only from the three states that wait for it: the states the contract lists as open are exactly NOT_STARTED, ACTION_REQUIRED and REJECTED', () => {
    expect([...TRUST_EVIDENCE_OPEN_STATUSES]).toEqual(['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED']);
    expect(TRUST_REQUIREMENT_STATUSES.filter((s) => isTrustRequirementTransitionAllowed(s, 'PENDING'))).toEqual(
      [...TRUST_EVIDENCE_OPEN_STATUSES].sort((a, b) => TRUST_REQUIREMENT_STATUSES.indexOf(a) - TRUST_REQUIREMENT_STATUSES.indexOf(b)),
    );
  });
});

describe('D11. case_requirements (UPDATE): ROUND_SEQUENCE, the stamps, the expiry rules (EXPIRY_REQUIRED, EXPIRY_IN_PAST, EXPIRY_NOT_REACHED), FIELDS_FROZEN, REVISION_ONLY_GROWS', () => {
  it.each(['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED'] as const)(
    '%s -> PENDING must be the NEXT round: +1 is accepted, the same round, +2 and a lower round are ROUND_SEQUENCE',
    async (from) => {
      const r = await makeReqIn(from);
      const round = (await crRow<{ round: number }>(r.id)).round;
      for (const set of ['round = round', 'round = round + 2', 'round = round - 1', 'round = 0', 'round = 99', 'round = round + 1000000'])
        await expectRule(setReq(r.id, `status = 'PENDING', ${set}`), 'ROUND_SEQUENCE');
      // the move is judged before the round: an impossible move with a wrong round is a STATUS_TRANSITION
      await expectRule(setReq(r.id, "status = 'APPROVED', round = round + 1"), 'STATUS_TRANSITION');
      expect(await crRow(r.id)).toMatchObject({ status: from, round });
      await setReq(r.id, "status = 'PENDING', round = round + 1");
      expect(await crRow(r.id)).toMatchObject({ status: 'PENDING', round: round + 1 });
    },
  );
  it('refuses a round change with any other move (PENDING -> IN_REVIEW with round + 1, APPROVED with round - 1, a reviewer decision with a new round, NOT_REQUIRED -> NOT_STARTED with round + 1) and with no move at all (FIELDS_FROZEN)', async () => {
    const p = await makeReqIn('PENDING');
    await expectRule(setReq(p.id, "status = 'IN_REVIEW', round = round + 1"), 'ROUND_SEQUENCE');
    await expectRule(setReq(p.id, "status = 'APPROVED', round = round - 1"), 'ROUND_SEQUENCE');
    await expectRule(setReq(p.id, "status = 'REJECTED', round = 5"), 'ROUND_SEQUENCE');
    await expectRule(setReq(p.id, 'round = round + 1'), 'FIELDS_FROZEN');
    const gone = await makeReqIn('NOT_REQUIRED');
    await expectRule(setReq(gone.id, "status = 'NOT_STARTED', round = round + 1"), 'ROUND_SEQUENCE');
    expect(await statusOf(p.id)).toBe('PENDING');
  });
  it('numbers the rounds without gaps over a whole history: submit, reject, resubmit, ask for action, resubmit, approve = rounds 1, 2, 3', async () => {
    const r = await makeReq();
    const rounds: number[] = [];
    for (const decision of ['REJECTED', 'ACTION_REQUIRED', 'APPROVED']) {
      await submitReq(r.id);
      rounds.push((await crRow<{ round: number }>(r.id)).round);
      await setReq(r.id, `status = '${decision}'`);
    }
    expect(rounds).toEqual([1, 2, 3]);
    expect(await crRow(r.id)).toMatchObject({ status: 'APPROVED', round: 3 });
  });
  it('a requirement that policy withdrew and asked for again keeps counting rounds: PENDING (1) -> NOT_REQUIRED -> NOT_STARTED -> PENDING must be round 2', async () => {
    const r = await makeReqIn('PENDING');
    await setReq(r.id, "status = 'NOT_REQUIRED'");
    await setReq(r.id, "status = 'NOT_STARTED'");
    await expectRule(setReq(r.id, "status = 'PENDING', round = 1"), 'ROUND_SEQUENCE');
    await submitReq(r.id);
    expect(await crRow(r.id)).toMatchObject({ status: 'PENDING', round: 2 });
  });
  it('stamps submitted_at at the transaction time on EVERY move to PENDING (the supplied value is ignored) and refreshes it on a resubmission', async () => {
    const r = await makeReq();
    await setReq(r.id, "status = 'PENDING', round = round + 1, submitted_at = '2001-01-01'");
    const first = (await crRow<{ submitted_at: Date }>(r.id)).submitted_at;
    expect(first.getFullYear()).toBeGreaterThan(2020);
    await setReq(r.id, "status = 'REJECTED'");
    await sleep(20);
    await setReq(r.id, "status = 'PENDING', round = round + 1, submitted_at = NULL");
    expect((await crRow<{ submitted_at: Date }>(r.id)).submitted_at.getTime()).toBeGreaterThan(first.getTime());
  });
  it('stamps decided_at on APPROVED, REJECTED and ACTION_REQUIRED (the supplied value is ignored) and approved_at on APPROVED only', async () => {
    for (const to of ['APPROVED', 'REJECTED', 'ACTION_REQUIRED'] as const) {
      const r = await makeReqIn('PENDING');
      await setReq(r.id, `status = '${to}', decided_at = '2001-01-01', approved_at = '2001-01-01'`);
      const row = await crRow<{ decided_at: Date; approved_at: Date | null }>(r.id);
      expect(row.decided_at.getFullYear(), to).toBeGreaterThan(2020);
      if (to === 'APPROVED') expect(row.approved_at!.getFullYear()).toBeGreaterThan(2020);
      else expect(row.approved_at, to).toBeNull();
    }
  });
  it('clears approved_at and expires_at on every move that is not an approval or an expiry (a supplied value is ignored), and keeps them on the expiry', async () => {
    for (const to of ['REJECTED', 'ACTION_REQUIRED', 'IN_REVIEW', 'NOT_REQUIRED'] as const) {
      const r = await makeReqIn('PENDING');
      await setReq(r.id, `status = '${to}', approved_at = now(), expires_at = now() + interval '1 day'`);
      expect(await crRow(r.id), to).toMatchObject({ approved_at: null, expires_at: null });
    }
    const [e] = await expiredReqs(1);
    const row = await crRow<{ approved_at: Date; expires_at: Date }>(e!.id);
    expect(row.approved_at).toBeTruthy();
    expect(row.expires_at).toBeTruthy();
    expect(row.expires_at.getTime()).toBeGreaterThan(row.approved_at.getTime());
  });
  it('requires an expiry date when the definition says expiry_required (EXPIRY_REQUIRED), from PENDING and from IN_REVIEW, and accepts one; a definition without the flag accepts an approval with or without an end', async () => {
    for (const from of ['PENDING', 'IN_REVIEW'] as const) {
      const r = await makeReqIn(from, expDef);
      await expectRule(setReq(r.id, "status = 'APPROVED'"), 'EXPIRY_REQUIRED');
      await expectRule(setReq(r.id, "status = 'APPROVED', expires_at = NULL"), 'EXPIRY_REQUIRED');
      expect(await statusOf(r.id)).toBe(from);
      await setReq(r.id, `status = 'APPROVED', expires_at = ${HOUR}`);
      expect(await crRow(r.id)).toMatchObject({ status: 'APPROVED' });
    }
    const plain = await makeReqIn('PENDING', docDef);
    await setReq(plain.id, "status = 'APPROVED'");
    expect((await crRow<{ expires_at: Date | null }>(plain.id)).expires_at).toBeNull();
    const plain2 = await makeReqIn('PENDING', docDef);
    await setReq(plain2.id, `status = 'APPROVED', expires_at = ${HOUR}`);
    expect((await crRow<{ expires_at: Date | null }>(plain2.id)).expires_at).not.toBeNull();
  });
  it('reads the expiry flag of the definition at the time of the approval: a flag switched on later makes the next approval need an end', async () => {
    const d = await makeDef({ status: 'ACTIVE', expiry: false });
    const r = await makeReqIn('PENDING', d);
    await run(`UPDATE ${DEF} SET expiry_required = true WHERE requirement_definition_id = $1`, [d.id]);
    await expectRule(setReq(r.id, "status = 'APPROVED'"), 'EXPIRY_REQUIRED');
    await run(`UPDATE ${DEF} SET expiry_required = false WHERE requirement_definition_id = $1`, [d.id]);
    await setReq(r.id, "status = 'APPROVED'");
  });
  it('refuses an approval that already ended or ends at this very instant (EXPIRY_IN_PAST), for a definition with and without the flag, and judges the missing end first (EXPIRY_REQUIRED)', async () => {
    for (const def of [docDef, expDef]) {
      const r = await makeReqIn('IN_REVIEW', def);
      for (const e of ["now() - interval '1 day'", "now() - interval '1 second'", 'now()', "timestamptz '2001-01-01'"])
        await expectRule(setReq(r.id, `status = 'APPROVED', expires_at = ${e}`), 'EXPIRY_IN_PAST');
      expect(await statusOf(r.id)).toBe('IN_REVIEW');
      await setReq(r.id, "status = 'APPROVED', expires_at = now() + interval '1 second'");
    }
  });
  it('refuses to record an expiry before the end of the approval has really passed (EXPIRY_NOT_REACHED): an approval without an end, one ending in an hour, one ending in two seconds; and accepts it once the clock has passed the end (a real wait)', async () => {
    const never = await makeReqIn('APPROVED', docDef);
    const hour = await makeReqIn('APPROVED', expDef);
    const soon = await makeReqIn('APPROVED', docDef, "now() + interval '2 seconds'");
    for (const r of [never, hour, soon]) await expectRule(expireReq(r.id), 'EXPIRY_NOT_REACHED');
    for (const r of [never, hour, soon]) expect(await statusOf(r.id)).toBe('APPROVED');
    await sleep(2300);
    await expectRule(expireReq(never.id), 'EXPIRY_NOT_REACHED'); // an approval that never ends never expires
    await expectRule(expireReq(hour.id), 'EXPIRY_NOT_REACHED');
    await expireReq(soon.id);
    expect(await crRow(soon.id)).toMatchObject({ status: 'EXPIRED' });
  });
  it('keeps the approval time and the end of an approval when it expires, whatever the statement supplies, and an expired instance goes no further', async () => {
    const [e] = await expiredReqs(1);
    const row = await crRow<{ approved_at: Date; expires_at: Date; decided_at: Date }>(e!.id);
    const r2 = (await makeApprovedSoon(1))[0]!;
    await sleep(1500);
    const before = await crRow<{ approved_at: Date; expires_at: Date }>(r2.id);
    await setReq(r2.id, "status = 'EXPIRED', approved_at = now(), expires_at = NULL");
    const after = await crRow<{ approved_at: Date; expires_at: Date }>(r2.id);
    expect([after.approved_at, after.expires_at]).toEqual([before.approved_at, before.expires_at]);
    for (const to of TRUST_REQUIREMENT_STATUSES.filter((s) => s !== 'EXPIRED')) await expectRule(setReq(e!.id, 'status = $2', [to]), 'STATUS_TRANSITION');
    expect(row.approved_at).toBeTruthy();
  });
  it('freezes the evidence and decision fields between status changes (FIELDS_FROZEN): round, submitted_at, decided_at, approved_at and expires_at on every status, while the revision and updated_at move freely', async () => {
    for (const kind of ['NOT_STARTED', 'PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED', 'APPROVED', 'NOT_REQUIRED'] as const) {
      const r = await makeReqIn(kind, expDef);
      const before = await crRow(r.id);
      for (const set of [
        'round = round + 1',
        "submitted_at = now() + interval '1 day'",
        "decided_at = now() + interval '1 day'",
        "approved_at = now() + interval '1 day'",
        "expires_at = now() + interval '9 days'",
      ]) {
        const o = await outcomeOf(setReq(r.id, set)); // every one of these statements changes the field
        expect(o, `${kind}: ${set}`).toBe('FIELDS_FROZEN');
      }
      expect(await crRow(r.id)).toEqual(before);
      await setReq(r.id, 'revision = revision + 1, updated_at = now()');
      await setReq(r.id, 'revision = revision');
    }
  });
  it('accepts a statement that restates the fields it already has', async () => {
    const r = await makeReqIn('APPROVED', expDef);
    await setReq(r.id, 'round = round, submitted_at = submitted_at, decided_at = decided_at, approved_at = approved_at, expires_at = expires_at');
  });
  it('accepts the same revision, +1 and a jump, and refuses a lower one (to 0 and below 1 the rule answers before the CHECK)', async () => {
    const r = await makeReq();
    await setReq(r.id, 'revision = 1');
    await setReq(r.id, 'revision = 2');
    await setReq(r.id, 'revision = 50');
    for (const n of [49, 2, 1, 0, -1, -2147483648]) await expectRule(setReq(r.id, 'revision = $2', [n]), 'REVISION_ONLY_GROWS');
    await expectRule(setReq(r.id, 'revision = revision - 1'), 'REVISION_ONLY_GROWS');
    // judged before the status: a refused revision does not move the status
    await expectRule(setReq(r.id, "revision = 1, status = 'PENDING', round = round + 1"), 'REVISION_ONLY_GROWS');
    expect(await crRow(r.id)).toMatchObject({ status: 'NOT_STARTED', revision: 50 });
  });
  it('freezes every requirement of a CANCELLED case (CASE_FROZEN): a status move, a revision bump and a no-op restating its status alike; the rule is read from the case at the time of the UPDATE', async () => {
    for (const kind of ['NOT_STARTED', 'PENDING', 'IN_REVIEW', 'APPROVED', 'ACTION_REQUIRED', 'REJECTED', 'NOT_REQUIRED'] as const) {
      const r = await makeReqIn(kind);
      await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
      const before = await crRow(r.id);
      await expectRule(setReq(r.id, 'revision = revision + 1'), 'CASE_FROZEN');
      await expectRule(setReq(r.id, 'status = status'), 'CASE_FROZEN');
      await expectRule(setReq(r.id, "status = 'NOT_REQUIRED'"), 'CASE_FROZEN');
      expect(await crRow(r.id), kind).toEqual(before);
    }
  });
  it('judges the rules in the documented order: identity, superseded, revision, case', async () => {
    const [e] = await expiredReqs(1);
    await supersedeReq(e!.id);
    await expectRule(setReq(e!.id, 'cycle = 9'), 'IMMUTABLE_IDENTITY');
    await expectRule(setReq(e!.id, 'revision = 0'), 'SUPERSEDED_FROZEN'); // superseded before revision
    const r = await makeReqIn('PENDING');
    await expectRule(setReq(r.id, 'revision = 0, cycle = 4'), 'IMMUTABLE_IDENTITY');
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(setReq(r.id, 'revision = 0'), 'REVISION_ONLY_GROWS'); // revision before the case
    await expectRule(setReq(r.id, "status = 'APPROVED'"), 'CASE_FROZEN'); // the case before the transition
  });
  it('lets a requirement go on after its definition was deactivated or retired (the guard reads the definition only for the expiry flag): history is not stranded by a policy change', async () => {
    for (const to of ['INACTIVE', 'RETIRED'] as const) {
      const d = await makeDef({ status: 'ACTIVE', expiry: true });
      const r = await makeReqIn('PENDING', d);
      await setDef(d.id, to);
      await setReq(r.id, "status = 'IN_REVIEW'");
      await setReq(r.id, `status = 'APPROVED', expires_at = ${HOUR}`);
      expect(await statusOf(r.id)).toBe('APPROVED');
    }
  });
});

describe('D12. case_requirements: only an EXPIRED cycle can be superseded (SUPERSEDE_STATE), and a superseded cycle is frozen history (SUPERSEDED_FROZEN)', () => {
  let expired: Req[];
  beforeAll(async () => {
    expired = await expiredReqs(10);
  });
  it.each(TRUST_REQUIREMENT_STATUSES.filter((s) => s !== 'EXPIRED'))(
    'refuses to supersede a %s instance (SUPERSEDE_STATE), and the row stays',
    async (kind) => {
      const r = await makeReqIn(kind);
      await expectRule(supersedeReq(r.id), 'SUPERSEDE_STATE');
      await expectRule(setReq(r.id, "superseded_at = '2001-01-01'"), 'SUPERSEDE_STATE');
      expect((await crRow<{ superseded_at: Date | null }>(r.id)).superseded_at).toBeNull();
      expect(await statusOf(r.id)).toBe(kind);
    },
  );
  it('supersedes an EXPIRED instance at the transaction time (the supplied time is ignored) and changes nothing else; the instance stays EXPIRED with its approval', async () => {
    const r = expired[0]!;
    const before = await crRow<Record<string, unknown>>(r.id);
    await setReq(r.id, "superseded_at = '2001-01-01'");
    const after = await crRow<Record<string, unknown>>(r.id);
    expect((after.superseded_at as Date).getFullYear()).toBeGreaterThan(2020);
    const { superseded_at: _a, updated_at: _b, ...restAfter } = after;
    const { superseded_at: _c, updated_at: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after).toMatchObject({ status: 'EXPIRED', superseded_at: expect.any(Date) });
  });
  it('refuses to supersede together with any other change (SUPERSEDE_STATE): the round, a timestamp, the expiry, or a status move', async () => {
    const stmts = [
      'round = round + 1',
      'submitted_at = now()',
      'decided_at = now()',
      'approved_at = now()',
      "expires_at = now() + interval '1 day'",
      "status = 'NOT_REQUIRED'",
      "status = 'APPROVED'",
    ];
    for (const [i, set] of stmts.entries()) {
      const r = expired[1 + (i % 4)]!;
      await expectRule(setReq(r.id, `superseded_at = now(), ${set}`), 'SUPERSEDE_STATE');
    }
    for (const r of expired.slice(1, 5)) expect((await crRow<{ superseded_at: Date | null }>(r.id)).superseded_at).toBeNull();
  });
  it('freezes a superseded instance for good (SUPERSEDED_FROZEN): any status move, a revision bump, a no-op, clearing superseded_at, and a field change alike', async () => {
    const r = expired[5]!;
    await supersedeReq(r.id);
    const before = await crRow(r.id);
    for (const set of [
      'revision = revision + 1',
      'status = status',
      "status = 'NOT_REQUIRED'",
      'superseded_at = NULL',
      "superseded_at = now() + interval '1 day'",
      'round = round + 1',
      "expires_at = now() + interval '1 year'",
      'updated_at = now()',
    ])
      await expectRule(setReq(r.id, set), 'SUPERSEDED_FROZEN');
    expect(await crRow(r.id)).toEqual(before);
  });
  it('judges the identity of a superseded instance first (IMMUTABLE_IDENTITY), and a superseded instance of a cancelled case answers SUPERSEDED_FROZEN (before the case)', async () => {
    const r = expired[6]!;
    await supersedeReq(r.id);
    await expectRule(setReq(r.id, 'cycle = cycle + 1'), 'IMMUTABLE_IDENTITY');
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(setReq(r.id, 'revision = revision + 1'), 'SUPERSEDED_FROZEN');
  });
  it('refuses to supersede an instance of a cancelled case (CASE_FROZEN: the case is read before the supersede rule)', async () => {
    const r = expired[7]!;
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(supersedeReq(r.id), 'CASE_FROZEN');
  });
  it('gives a superseded instance no further evidence or review (DOCUMENT_REQUIREMENT_STATE, REVIEW_SUPERSEDED): history stays history', async () => {
    const r = expired[8]!;
    await supersedeReq(r.id);
    await expectRule(mkDoc(r.id), 'DOCUMENT_REQUIREMENT_STATE');
    await expectRule(review(r.id, 'STARTED', { round: 1 }), 'REVIEW_SUPERSEDED');
    await expectRule(review(r.id, 'APPROVED', { round: 99 }), 'REVIEW_SUPERSEDED'); // before the round is looked at
  });
  it('keeps the (case, definition) slot while the instance is current (a second live cycle collides on the current-instance key), and superseding it frees the slot for the next cycle', async () => {
    const r = expired[9]!;
    await expectConstraint(
      rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${CR} DISABLE TRIGGER USER`);
        await c.query(`INSERT INTO ${CR} (verification_case_id, requirement_definition_id, cycle) VALUES ($1, $2, 2)`, [r.caseId, docDef.id]);
        await c.query(`INSERT INTO ${CR} (verification_case_id, requirement_definition_id, cycle) VALUES ($1, $2, 3)`, [r.caseId, docDef.id]);
      }),
      'uq_case_requirements__current',
    );
    await inTx(async (c) => {
      await supersedeReq(r.id, c);
      await addReq(r.caseId, docDef.id, c);
    });
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe("D11b. case_requirements (UPDATE): the timestamps are the database's - a caller-supplied value is never stored on a status move", () => {
  it('ignores a supplied submitted_at / decided_at on a move that does not stamp them (PENDING -> IN_REVIEW keeps the submission time and leaves decided_at NULL)', async () => {
    const r = await makeReqIn('PENDING');
    const before = await crRow<{ submitted_at: Date }>(r.id);
    await setReq(r.id, "status = 'IN_REVIEW', submitted_at = '2001-01-01', decided_at = '2002-02-02'");
    const row = await crRow<{ submitted_at: Date; decided_at: Date | null }>(r.id);
    expect(row.submitted_at).toEqual(before.submitted_at);
    expect(row.decided_at).toBeNull();
  });
  it('ignores them on every allowed move, and keeps the earlier decision time on moves that do not decide (REJECTED -> PENDING -> IN_REVIEW keeps the time of the rejection; NOT_REQUIRED keeps it too)', async () => {
    const r = await makeReqIn('PENDING');
    await setReq(r.id, "status = 'REJECTED'");
    const decided = (await crRow<{ decided_at: Date }>(r.id)).decided_at;
    await sleep(20);
    await setReq(r.id, "status = 'PENDING', round = round + 1, decided_at = '2002-02-02'");
    expect((await crRow<{ decided_at: Date }>(r.id)).decided_at).toEqual(decided);
    await setReq(r.id, "status = 'IN_REVIEW', decided_at = NULL, submitted_at = NULL");
    const row = await crRow<{ decided_at: Date; submitted_at: Date }>(r.id);
    expect(row.decided_at).toEqual(decided);
    expect(row.submitted_at.getTime()).toBeGreaterThan(decided.getTime());
    const gone = await makeReqIn('NOT_STARTED');
    await setReq(gone.id, "status = 'NOT_REQUIRED', submitted_at = now(), decided_at = now()");
    expect(await crRow(gone.id)).toMatchObject({ submitted_at: null, decided_at: null });
  });
  it('a move that is refused stores nothing either, and an expiry keeps the decision time of the approval', async () => {
    const r = await makeReqIn('PENDING');
    await expectRule(setReq(r.id, "status = 'NOT_STARTED', decided_at = now()"), 'STATUS_TRANSITION');
    expect((await crRow<{ decided_at: Date | null }>(r.id)).decided_at).toBeNull();
    const [e] = await expiredReqs(1);
    const decided = (await crRow<{ decided_at: Date }>(e!.id)).decided_at;
    expect(decided.getFullYear()).toBeGreaterThan(2020);
  });
});

describe('D13. documents (INSERT): CASE_FROZEN, DOCUMENT_REQUIREMENT_STATE, DOCUMENT_NOT_SUPPORTED, DOCUMENT_TYPE_MISMATCH, DOCUMENT_MUST_START_PENDING, judged in that order', () => {
  let expired: Req[];
  beforeAll(async () => {
    expired = await expiredReqs(3);
  });
  const reqIn = async (kind: TrustRequirementStatus): Promise<Req> => (kind === 'EXPIRED' ? expired[0]! : makeReqIn(kind));
  it.each(TRUST_REQUIREMENT_STATUSES)(
    'a requirement that is %s: a document is accepted exactly while the requirement waits for evidence (the three open states of the contract) and refused DOCUMENT_REQUIREMENT_STATE otherwise',
    async (kind) => {
      const r = await reqIn(kind);
      const open = (TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(kind);
      if (open) {
        const id = await mkDoc(r.id);
        expect(await docRow(id)).toMatchObject({
          status: 'UPLOAD_PENDING',
          scan_status: 'PENDING',
          sha256: null,
          round: null,
          finalized_at: null,
          submitted_at: null,
          withdrawn_at: null,
        });
      } else {
        await expectRule(mkDoc(r.id), 'DOCUMENT_REQUIREMENT_STATE');
        expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
      }
    },
  );
  it.each(TRUST_REQUIREMENT_STATUSES)(
    'a requirement that is %s in a CANCELLED case: a document is refused CASE_FROZEN whatever the requirement state (the case is read before the requirement), and no row lands',
    async (kind) => {
      const r = await reqIn(kind === 'EXPIRED' ? 'EXPIRED' : kind);
      const target = kind === 'EXPIRED' ? expired[1]! : r;
      await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [target.caseId]);
      await expectRule(mkDoc(target.id), 'CASE_FROZEN');
      expect(await count(DOC, 'case_requirement_id = $1', [target.id])).toBe(0);
    },
  );
  it('judges the cancelled case BEFORE the evidence kind, the document type and the start state (an EXTERNAL requirement, a wrong type and an ATTACHED start in a cancelled case all answer CASE_FROZEN)', async () => {
    const ext = await makeReq(extDef);
    const doc = await makeReq();
    for (const r of [ext, doc]) await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(mkDoc(ext.id), 'CASE_FROZEN');
    await expectRule(mkDoc(doc.id, { type: 'professional_license' }), 'CASE_FROZEN');
    await expectRule(
      run(
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, status, upload_expires_at) VALUES ($1, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'passport'), 'trust/evidence/${doc.caseId}/${randomUUID()}', 'a/b', 1, 'ATTACHED', now())`,
        [doc.id],
      ),
      'CASE_FROZEN',
    );
  });
  it('accepts a document for a case of any status but CANCELLED (the provider can add to a case in review: the requirement state decides)', async () => {
    for (const kind of ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[]) {
      const { caseId } = await makeCase(kind);
      const id = await addReq(caseId, docDef.id);
      await mkDoc(id);
      expect(await count(DOC, 'case_requirement_id = $1', [id]), kind).toBe(1);
    }
  });
  it('refuses a requirement that does not exist as one that is not waiting for evidence (the guard answers before the foreign key)', async () => {
    await expectRule(
      run(
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES (gen_random_uuid(), (SELECT document_type_id FROM ${DTYPE} LIMIT 1), 'trust/evidence/${randomUUID()}/${randomUUID()}', 'a/b', 1, now())`,
      ),
      'DOCUMENT_REQUIREMENT_STATE',
    );
  });
  it('refuses a document for a requirement evidenced EXTERNALLY (DOCUMENT_NOT_SUPPORTED), in every open state', async () => {
    const r = await makeReq(extDef);
    await expectRule(mkDoc(r.id, { type: 'drivers_license' }), 'DOCUMENT_NOT_SUPPORTED');
    for (const kind of ['ACTION_REQUIRED', 'REJECTED'] as const) await expectRule(mkDoc((await makeReqIn(kind, extDef)).id), 'DOCUMENT_NOT_SUPPORTED');
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
  });
  it('accepts only a document type of the requirement type of the definition (DOCUMENT_TYPE_MISMATCH), and an ACTIVE one: a type of another requirement type, an INACTIVE type and a missing type are refused', async () => {
    const identity = await makeReq(); // IDENTITY
    const license = await makeReq(expDef); // LICENSE
    for (const t of ['drivers_license', 'state_id', 'passport']) await mkDoc(identity.id, { type: t });
    for (const t of ['professional_license', 'insurance_certificate', 'certification', 'business_license'])
      await expectRule(mkDoc(identity.id, { type: t }), 'DOCUMENT_TYPE_MISMATCH');
    await mkDoc(license.id, { type: 'professional_license' });
    for (const t of ['drivers_license', 'passport', 'insurance_certificate']) await expectRule(mkDoc(license.id, { type: t }), 'DOCUMENT_TYPE_MISMATCH');
    const inactive = await makeDocType('IDENTITY', 'INACTIVE');
    const insertWithType = (typeSql: string, params: unknown[] = []) =>
      run(
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, ${typeSql}, 'trust/evidence/${identity.caseId}/${randomUUID()}', 'a/b', 1, now())`,
        [identity.id, ...params],
      );
    await expectRule(insertWithType('$2', [inactive]), 'DOCUMENT_TYPE_MISMATCH');
    await expectRule(insertWithType('gen_random_uuid()'), 'DOCUMENT_TYPE_MISMATCH');
    // an active type of the right requirement type is accepted, and deactivating it stops further documents but not the ones already there
    const dt = await makeDocType('IDENTITY');
    await insertWithType('$2', [dt]);
    await run(`UPDATE ${DTYPE} SET status = 'INACTIVE' WHERE document_type_id = $1`, [dt]);
    await expectRule(insertWithType('$2', [dt]), 'DOCUMENT_TYPE_MISMATCH');
    expect(await count(DOC, 'case_requirement_id = $1 AND document_type_id = $2', [identity.id, dt])).toBe(1);
  });
  it('requires a document to start UPLOAD_PENDING and unscanned (DOCUMENT_MUST_START_PENDING): any other status, a scan result, and an unknown status (the rule answers before the CHECK)', async () => {
    const r = await makeReq();
    const ins = (status: string, scan: string) =>
      run(
        `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, status, scan_status, upload_expires_at) VALUES ($1, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'passport'), 'trust/evidence/${r.caseId}/${randomUUID()}', 'a/b', 1, $2, $3, now())`,
        [r.id, status, scan],
      );
    for (const [status, scan] of [
      ['ATTACHED', 'PENDING'],
      ['SUBMITTED', 'PENDING'],
      ['WITHDRAWN', 'PENDING'],
      ['ABANDONED', 'PENDING'],
      ['BOGUS', 'PENDING'],
      ['UPLOAD_PENDING', 'CLEAN'],
      ['UPLOAD_PENDING', 'INFECTED'],
      ['UPLOAD_PENDING', 'ERROR'],
      ['UPLOAD_PENDING', 'BOGUS'],
    ] as const)
      await expectRule(ins(status, scan), 'DOCUMENT_MUST_START_PENDING');
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
    await ins('UPLOAD_PENDING', 'PENDING');
  });
  it('judges the requirement state, then the evidence kind, then the type, then the start state', async () => {
    const pending = await makeReqIn('PENDING', extDef);
    await expectRule(mkDoc(pending.id, { type: 'professional_license' }), 'DOCUMENT_REQUIREMENT_STATE'); // state first, though the kind and the type are wrong too
    const ext = await makeReq(extDef);
    await expectRule(mkDoc(ext.id, { type: 'professional_license' }), 'DOCUMENT_NOT_SUPPORTED'); // kind before type
  });
  it('lets a requirement collect several documents (the maximum is policy in the service, not a database rule), and takes new ones in a later round after a rejection or an action request', async () => {
    const r = await makeReq();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await mkDoc(r.id));
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(8);
    for (const id of ids) await attachDoc(id, SHA);
    await submitReq(r.id);
    for (const id of ids) await submitDoc(id, 1);
    await expectRule(mkDoc(r.id), 'DOCUMENT_REQUIREMENT_STATE'); // PENDING: no more evidence
    await startReq(r.id);
    await setReq(r.id, "status = 'REJECTED'");
    const again = await mkDoc(r.id);
    await attachDoc(again, SHA_B);
    await submitReq(r.id);
    await submitDoc(again, 2);
    expect(await q(`SELECT round, count(*)::int AS n FROM ${DOC} WHERE case_requirement_id = $1 GROUP BY 1 ORDER BY 1`, [r.id])).toEqual([
      { round: 1, n: 8 },
      { round: 2, n: 1 },
    ]);
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('D14. documents (UPDATE): HASH_IMMUTABLE, the SCAN_TRANSITION matrix, the STATUS_TRANSITION 5 x 5 matrix, DOCUMENT_ROUND, DOCUMENT_FROZEN', () => {
  it('sets the hash once, at the move to ATTACHED, and never changes or clears it again (HASH_IMMUTABLE), also together with a scan change or a status move; restating it is fine', async () => {
    const { id } = await makeDocIn('ATTACHED');
    await expectRule(setDoc(id, 'sha256 = $2', [SHA_B]), 'HASH_IMMUTABLE');
    await expectRule(setDoc(id, 'sha256 = NULL'), 'HASH_IMMUTABLE');
    await expectRule(setDoc(id, "sha256 = $2, scan_status = 'INFECTED'", [SHA_B]), 'HASH_IMMUTABLE'); // before the scan rule
    await expectRule(setDoc(id, "sha256 = $2, status = 'WITHDRAWN'", [SHA_B]), 'HASH_IMMUTABLE'); // before the status rule
    await expectRule(setDoc(id, "sha256 = NULL, status = 'WITHDRAWN'"), 'HASH_IMMUTABLE');
    await setDoc(id, 'sha256 = $2', [SHA]);
    expect((await docRow<{ sha256: string }>(id)).sha256).toBe(SHA);
    const draft = await mkDoc((await makeReq()).id);
    await setDoc(draft, "status = 'ATTACHED', sha256 = $2", [SHA_B]); // OLD hash is NULL: set once
    expect((await docRow<{ sha256: string }>(draft)).sha256).toBe(SHA_B);
  });
  it('a hash alone does not attach a document: the lifecycle CHECK refuses a hash on an UPLOAD_PENDING one', async () => {
    const id = await mkDoc((await makeReq()).id);
    await expectConstraint(setDoc(id, 'sha256 = $2', [SHA]), 'ck_documents__lifecycle');
  });

  const SCAN_ALLOWED = new Set(['PENDING>CLEAN', 'PENDING>INFECTED', 'PENDING>ERROR', 'ERROR>PENDING', 'ERROR>CLEAN', 'ERROR>INFECTED', 'CLEAN>INFECTED']);
  const SCAN_PAIRS = TRUST_SCAN_STATUSES.flatMap((from) => TRUST_SCAN_STATUSES.map((to) => [from, to] as [string, string]));
  const docWithScan = async (scan: string): Promise<string> => {
    const id = await mkDoc((await makeReq()).id);
    if (scan === 'ERROR') await setDoc(id, "scan_status = 'ERROR'");
    else if (scan !== 'PENDING') await setDoc(id, 'scan_status = $2', [scan]);
    return id;
  };
  it.each(SCAN_PAIRS)(
    'scan %s -> %s: only PENDING -> any, ERROR -> any (a retry), and CLEAN -> INFECTED (a later finding) are allowed; INFECTED is final, CLEAN never goes back; the same value is a no-op',
    async (from, to) => {
      const id = await docWithScan(from);
      const outcome = await outcomeOf(setDoc(id, 'scan_status = $2', [to]));
      expect(outcome).toBe(from === to || SCAN_ALLOWED.has(`${from}>${to}`) ? 'ACCEPTED' : 'SCAN_TRANSITION');
      expect((await docRow<{ scan_status: string }>(id)).scan_status).toBe(outcome === 'ACCEPTED' ? to : from);
    },
  );
  it('allows exactly seven scan moves of the twelve distinct ones', () => {
    expect(SCAN_ALLOWED.size).toBe(7);
    expect(SCAN_PAIRS.filter(([f, t]) => f !== t)).toHaveLength(12);
  });
  it('refuses an unknown scan status as a scan move (before the CHECK could), and the document stays', async () => {
    const id = await docWithScan('PENDING');
    for (const bad of ['BOGUS', 'clean', '']) await expectRule(setDoc(id, 'scan_status = $2', [bad]), 'SCAN_TRANSITION');
    expect((await docRow<{ scan_status: string }>(id)).scan_status).toBe('PENDING');
  });
  it('stamps scanned_at at the transaction time on every scan move except back to PENDING (which clears it), ignores a supplied scanned_at, and keeps it when the scan status does not change', async () => {
    const id = await docWithScan('PENDING');
    expect((await docRow<{ scanned_at: Date | null }>(id)).scanned_at).toBeNull();
    await setDoc(id, "scan_status = 'ERROR', scanned_at = '2001-01-01'");
    const err = (await docRow<{ scanned_at: Date }>(id)).scanned_at;
    expect(err.getFullYear()).toBeGreaterThan(2020);
    await setDoc(id, "size_bytes = size_bytes, scanned_at = '2001-01-01'");
    expect((await docRow<{ scanned_at: Date }>(id)).scanned_at).toEqual(err);
    await setDoc(id, "scan_status = 'PENDING', scanned_at = now()");
    expect((await docRow<{ scanned_at: Date | null }>(id)).scanned_at).toBeNull();
    await sleep(20);
    await setDoc(id, "scan_status = 'CLEAN'");
    const clean = (await docRow<{ scanned_at: Date }>(id)).scanned_at;
    expect(clean.getTime()).toBeGreaterThan(err.getTime());
  });

  const DOC_ALLOWED = new Set(['UPLOAD_PENDING>ATTACHED', 'UPLOAD_PENDING>ABANDONED', 'ATTACHED>SUBMITTED', 'ATTACHED>WITHDRAWN']);
  const FROZEN = new Set(['SUBMITTED', 'WITHDRAWN', 'ABANDONED']);
  const DOC_STATEMENT: Record<string, string> = {
    UPLOAD_PENDING: "status = 'UPLOAD_PENDING'",
    ATTACHED: `status = 'ATTACHED', sha256 = COALESCE(sha256, '${SHA_B}')`,
    SUBMITTED: "status = 'SUBMITTED', round = COALESCE(round, 1)",
    WITHDRAWN: "status = 'WITHDRAWN'",
    ABANDONED: "status = 'ABANDONED'",
  };
  const DOC_PAIRS = TRUST_DOCUMENT_STATUSES.flatMap((from) => TRUST_DOCUMENT_STATUSES.map((to) => [from, to] as [DocKind, DocKind]));
  it.each(DOC_PAIRS)(
    '%s -> %s: the draft moves forward only (UPLOAD_PENDING -> ATTACHED | ABANDONED, ATTACHED -> SUBMITTED | WITHDRAWN); a submitted, withdrawn or abandoned document is frozen; the same status is a field change',
    async (from, to) => {
      const { id } = await makeDocIn(from);
      const outcome = await outcomeOf(setDoc(id, from === to ? 'status = status' : DOC_STATEMENT[to]!));
      const expected = from === to ? 'ACCEPTED' : FROZEN.has(from) ? 'DOCUMENT_FROZEN' : DOC_ALLOWED.has(`${from}>${to}`) ? 'ACCEPTED' : 'STATUS_TRANSITION';
      expect(outcome).toBe(expected);
      expect((await docRow<{ status: string }>(id)).status).toBe(outcome === 'ACCEPTED' ? to : from);
    },
  );
  it('allows exactly four status moves of the twenty distinct ones', () => {
    expect(DOC_ALLOWED.size).toBe(4);
    expect(DOC_PAIRS.filter(([f, t]) => f !== t)).toHaveLength(20);
  });
  it('refuses an unknown target status from a draft as a transition and from a frozen document as frozen', async () => {
    const draft = await makeDocIn('UPLOAD_PENDING');
    for (const bad of ['BOGUS', 'attached', '']) await expectRule(setDoc(draft.id, 'status = $2', [bad]), 'STATUS_TRANSITION');
    const done = await makeDocIn('SUBMITTED');
    await expectRule(setDoc(done.id, "status = 'BOGUS'"), 'DOCUMENT_FROZEN');
  });
  it('stamps finalized_at at the move to ATTACHED, submitted_at at SUBMITTED and withdrawn_at at WITHDRAWN (the supplied times are ignored), each at the transaction time, and nothing else', async () => {
    const req = await makeReq();
    const a = await mkDoc(req.id);
    await setDoc(a, "status = 'ATTACHED', sha256 = $2, finalized_at = '2001-01-01'", [SHA]);
    const att = await docRow<{ finalized_at: Date; submitted_at: Date | null; withdrawn_at: Date | null }>(a);
    expect(att.finalized_at.getFullYear()).toBeGreaterThan(2020);
    expect([att.submitted_at, att.withdrawn_at]).toEqual([null, null]);
    const w = await mkDoc(req.id);
    await attachDoc(w);
    await setDoc(w, "status = 'WITHDRAWN', withdrawn_at = '2001-01-01'");
    expect((await docRow<{ withdrawn_at: Date }>(w)).withdrawn_at.getFullYear()).toBeGreaterThan(2020);
    await submitReq(req.id);
    await setDoc(a, "status = 'SUBMITTED', round = 1, submitted_at = '2001-01-01'");
    expect((await docRow<{ submitted_at: Date }>(a)).submitted_at.getFullYear()).toBeGreaterThan(2020);
  });

  it('submits a document only in the round its requirement was just submitted in (DOCUMENT_ROUND): the requirement must be PENDING and the document round must equal the requirement round; NULL, a lower, a higher and a far round are refused', async () => {
    const req = await makeReq();
    const id = await mkDoc(req.id);
    await attachDoc(id);
    // the requirement has not been submitted yet (NOT_STARTED, round 0)
    for (const round of [1, 0, 2]) await expectRule(submitDoc(id, round), 'DOCUMENT_ROUND');
    await submitReq(req.id);
    for (const round of [2, 3, 99, 0]) await expectRule(submitDoc(id, round), 'DOCUMENT_ROUND');
    await expectRule(setDoc(id, "status = 'SUBMITTED', round = NULL"), 'DOCUMENT_ROUND');
    expect((await docRow<{ status: string }>(id)).status).toBe('ATTACHED');
    await submitDoc(id, 1);
    expect(await docRow(id)).toMatchObject({ status: 'SUBMITTED', round: 1 });
  });
  it.each(['IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED', 'APPROVED', 'NOT_REQUIRED'] as const)(
    'refuses to submit a draft once its requirement is %s (DOCUMENT_ROUND): the round it names is no longer the one being submitted',
    async (kind) => {
      const req = await makeReq();
      const id = await mkDoc(req.id);
      await attachDoc(id);
      await submitReq(req.id);
      if (kind === 'NOT_REQUIRED') await setReq(req.id, "status = 'NOT_REQUIRED'");
      else if (kind === 'APPROVED') await approveReq(req.id);
      else if (kind === 'IN_REVIEW') await startReq(req.id);
      else await setReq(req.id, `status = '${kind}'`);
      await expectRule(submitDoc(id, 1), 'DOCUMENT_ROUND');
      expect((await docRow<{ status: string }>(id)).status).toBe('ATTACHED');
    },
  );
  it('submits a draft collected in an earlier round only in the round of the resubmission (the old round is refused)', async () => {
    const req = await makeReqIn('REJECTED');
    const id = await mkDoc(req.id);
    await attachDoc(id);
    await submitReq(req.id); // round 2
    await expectRule(submitDoc(id, 1), 'DOCUMENT_ROUND');
    await submitDoc(id, 2);
  });
  it.each(['SUBMITTED', 'WITHDRAWN', 'ABANDONED'] as const)(
    'freezes a %s document: no field of its lifecycle changes (DOCUMENT_FROZEN), while its scan status may still be recorded and a no-op is fine',
    async (kind) => {
      const { id } = await makeDocIn(kind);
      const before = await docRow(id);
      const stmts: string[] = ['finalized_at = now()', "submitted_at = now() + interval '1 day'", 'withdrawn_at = now()', 'round = 7'];
      if (kind === 'SUBMITTED') stmts.push('round = NULL');
      if (kind === 'ABANDONED') stmts.push(`sha256 = '${SHA}'`); // an abandoned upload has no hash yet: it still cannot get one
      for (const set of stmts) expect(await outcomeOf(setDoc(id, set)), `${kind}: ${set}`).toMatch(/^(DOCUMENT_FROZEN|HASH_IMMUTABLE)$/);
      await expectRule(setDoc(id, "status = 'UPLOAD_PENDING'"), 'DOCUMENT_FROZEN');
      expect(await docRow(id)).toEqual(before);
      await setDoc(id, 'size_bytes = size_bytes');
      await setDoc(id, "scan_status = 'INFECTED'"); // PENDING/CLEAN -> INFECTED, allowed whatever the document status
      expect(await docRow<{ scan_status: string; status: string }>(id)).toMatchObject({ scan_status: 'INFECTED', status: kind });
      await expectRule(setDoc(id, "scan_status = 'CLEAN'"), 'SCAN_TRANSITION');
    },
  );
  it('a hash change on a submitted document answers HASH_IMMUTABLE (the hash rule is judged first), the other frozen fields DOCUMENT_FROZEN', async () => {
    const { id } = await makeDocIn('SUBMITTED');
    await expectRule(setDoc(id, 'sha256 = $2', [SHA_B]), 'HASH_IMMUTABLE');
    await expectRule(setDoc(id, "finalized_at = now() + interval '1 hour'"), 'DOCUMENT_FROZEN');
  });
  it('stamps updated_at at the transaction time on every accepted UPDATE and keeps created_at', async () => {
    const { id } = await makeDocIn('ATTACHED');
    const before = await docRow<{ created_at: Date; updated_at: Date }>(id);
    await sleep(20);
    await setDoc(id, "size_bytes = size_bytes, updated_at = '2001-01-01'");
    const after = await docRow<{ created_at: Date; updated_at: Date }>(id);
    expect(after.created_at).toEqual(before.created_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
  it('keeps a submitted document exactly as submitted while its requirement moves on (approval, expiry, a new cycle): the document of round 1 is still round 1 with the same hash', async () => {
    const req = await makeReq();
    const id = await mkDoc(req.id);
    await attachDoc(id, SHA);
    await submitReq(req.id);
    await submitDoc(id, 1);
    const before = await docRow(id);
    await startReq(req.id);
    await approveReq(req.id, SOON);
    await sleep(1500);
    await expireReq(req.id);
    await supersedeReq(req.id);
    await addReq(req.caseId, docDef.id);
    expect(await docRow(id)).toEqual(before);
  });
});

describe('D14b. documents (UPDATE): the move to ATTACHED and to SUBMITTED re-check the case and the requirement (CASE_FROZEN, DOCUMENT_REQUIREMENT_STATE)', () => {
  let expired: Req[];
  beforeAll(async () => {
    expired = await expiredReqs(2);
  });
  /** A draft (UPLOAD_PENDING) document of a requirement that was open when the document was made and has been moved on since (the fixture goes through legal moves only). */
  const draftOf = async (req: Req): Promise<string> => mkDoc(req.id);
  const attach = (id: string) => setDoc(id, "status = 'ATTACHED', sha256 = $2", [SHA]);
  const cancelCase = (caseId: string) => run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [caseId]);

  it('refuses to attach an upload of a CANCELLED case (CASE_FROZEN), for every state the requirement was left in, and the draft stays UPLOAD_PENDING with no hash', async () => {
    for (const kind of ['NOT_STARTED', 'PENDING', 'APPROVED', 'ACTION_REQUIRED', 'REJECTED'] as const) {
      const r = await makeReq();
      const id = await draftOf(r);
      if (kind !== 'NOT_STARTED') {
        await submitReq(r.id);
        if (kind === 'APPROVED') await approveReq(r.id);
        else if (kind !== 'PENDING') await setReq(r.id, `status = '${kind}'`);
      }
      await cancelCase(r.caseId);
      await expectRule(attach(id), 'CASE_FROZEN'); // the case is judged before the requirement state
      expect(await docRow(id), kind).toMatchObject({ status: 'UPLOAD_PENDING', sha256: null, finalized_at: null });
    }
  });
  it.each(['PENDING', 'IN_REVIEW', 'APPROVED', 'NOT_REQUIRED'] as const)(
    'refuses to attach an upload whose requirement is %s (DOCUMENT_REQUIREMENT_STATE): the evidence is only accepted while the requirement waits for it',
    async (kind) => {
      const r = await makeReq();
      const id = await draftOf(r);
      if (kind === 'NOT_REQUIRED') await setReq(r.id, "status = 'NOT_REQUIRED'");
      else {
        await submitReq(r.id);
        if (kind === 'IN_REVIEW') await startReq(r.id);
        if (kind === 'APPROVED') await approveReq(r.id);
      }
      await expectRule(attach(id), 'DOCUMENT_REQUIREMENT_STATE');
      expect(await docRow(id)).toMatchObject({ status: 'UPLOAD_PENDING', sha256: null });
    },
  );
  it('refuses to attach an upload whose requirement EXPIRED or was superseded (DOCUMENT_REQUIREMENT_STATE)', async () => {
    const [plain, superseded] = expired;
    // an upload authorised before the approval was granted: draw it on a fresh requirement of the same shape and attach it after the requirement expired is impossible to build legally,
    // so the draft is made on an open requirement of another case and the guard is exercised on a raw row of the expired one (guards bypassed for the fixture only)
    for (const r of [plain!, superseded!]) {
      const id = randomUUID();
      await rolledBack(async (c) => {
        await c.query(`ALTER TABLE ${DOC} DISABLE TRIGGER USER`);
        await c.query(
          `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'drivers_license'), $3, 'a/b', 1, now())`,
          [id, r.id, `trust/evidence/${r.caseId}/${id}`],
        );
        await c.query(`ALTER TABLE ${DOC} ENABLE TRIGGER USER`);
        if (r === superseded) await c.query(`UPDATE ${CR} SET superseded_at = now() WHERE case_requirement_id = $1`, [r.id]);
        await expectRule(
          c.query(`UPDATE ${DOC} SET status = 'ATTACHED', sha256 = $2 WHERE verification_document_id = $1`, [id, SHA]),
          'DOCUMENT_REQUIREMENT_STATE',
        );
      });
    }
  });
  it.each(['ACTION_REQUIRED', 'REJECTED'] as const)(
    'attaches an upload whose requirement came back to %s (the provider is asked to add evidence again), and stamps finalized_at',
    async (kind) => {
      const r = await makeReq();
      const id = await draftOf(r);
      await submitReq(r.id);
      await setReq(r.id, `status = '${kind}'`);
      await attach(id);
      expect(await docRow<{ status: string; finalized_at: Date }>(id)).toMatchObject({ status: 'ATTACHED', finalized_at: expect.any(Date) });
    },
  );
  it('judges the case BEFORE the requirement state when attaching (a cancelled case with a PENDING requirement answers CASE_FROZEN), and leaves a scan result on the draft alone (no re-check without a status move)', async () => {
    const r = await makeReq();
    const id = await draftOf(r);
    await submitReq(r.id);
    await setDoc(id, "scan_status = 'CLEAN'"); // a scan result on a draft whose requirement is already PENDING: no status move, no re-check
    await cancelCase(r.caseId);
    await setDoc(id, "scan_status = 'INFECTED'");
    await expectRule(attach(id), 'CASE_FROZEN');
  });
  it('refuses to submit a draft of a CANCELLED case (CASE_FROZEN), also when the round is wrong (the case is judged before the round), and the draft stays ATTACHED', async () => {
    const { req, id } = await makeDocIn('ATTACHED'); // the requirement is PENDING in round 1
    await cancelCase(req.caseId);
    await expectRule(submitDoc(id, 1), 'CASE_FROZEN');
    await expectRule(submitDoc(id, 7), 'CASE_FROZEN');
    expect(await docRow(id)).toMatchObject({ status: 'ATTACHED', round: null, submitted_at: null });
  });
  it('still submits, withdraws and scans a draft of a live case in every case status but CANCELLED', async () => {
    for (const kind of ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[]) {
      const { req, id } = await makeDocIn('ATTACHED');
      await run(`UPDATE ${CASES} SET status = $2 WHERE verification_case_id = $1`, [req.caseId, kind]);
      await submitDoc(id, 1);
      expect((await docRow<{ status: string }>(id)).status, kind).toBe('SUBMITTED');
    }
  });
});

describe('D15. reviews (INSERT): REVIEW_SUPERSEDED, REVIEW_ROUND, REVIEW_STATE, REVIEW_EXPIRY, REASON_INACTIVE, REASON_NOT_APPLICABLE, judged in that order', () => {
  const roundOf = async (id: string): Promise<number> => (await crRow<{ round: number }>(id)).round;
  const REASON_FOR = (d: string): string | null => (d === 'REJECTED' || d === 'ACTION_REQUIRED' ? 'DOCUMENT_UNREADABLE' : null);
  it('records a decision only in the state the requirement was JUST moved to: all 32 pairs of decision x requirement status, in the right round; the four matching pairs are accepted and every other is REVIEW_STATE', async () => {
    const expired = await expiredReqs(4);
    const MATCH: Record<string, string> = { STARTED: 'IN_REVIEW', APPROVED: 'APPROVED', REJECTED: 'REJECTED', ACTION_REQUIRED: 'ACTION_REQUIRED' };
    const observed: Record<string, string> = {};
    for (const decision of TRUST_REVIEW_DECISIONS)
      for (const status of TRUST_REQUIREMENT_STATUSES) {
        const r = status === 'EXPIRED' ? expired.pop()! : await makeReqIn(status);
        observed[`${decision}/${status}`] = await outcomeOf(review(r.id, decision, { round: await roundOf(r.id), reason: REASON_FOR(decision) }));
      }
    const expected = Object.fromEntries(Object.keys(observed).map((k) => [k, MATCH[k.split('/')[0]!] === k.split('/')[1] ? 'ACCEPTED' : 'REVIEW_STATE']));
    expect(observed).toEqual(expected);
    expect(Object.values(observed).filter((o) => o === 'ACCEPTED')).toHaveLength(4);
    expect(Object.values(observed)).toHaveLength(32);
  });
  it('names the evidence round the requirement is in (REVIEW_ROUND): a higher, a lower, zero and a negative round are refused, the right one accepted; after a resubmission the old round is refused', async () => {
    const r = await makeReqIn('IN_REVIEW');
    for (const round of [2, 3, 99, 0, -1]) await expectRule(review(r.id, 'STARTED', { round }), 'REVIEW_ROUND');
    await review(r.id, 'STARTED', { round: 1 });
    await setReq(r.id, "status = 'REJECTED'");
    await review(r.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' });
    await submitReq(r.id);
    await startReq(r.id);
    await expectRule(review(r.id, 'STARTED', { round: 1 }), 'REVIEW_ROUND'); // stale evidence
    await review(r.id, 'STARTED', { round: 2 });
    expect(await reviewCount(r.id)).toBe(3);
  });
  it('judges the round BEFORE the state (a wrong round on a wrong state answers REVIEW_ROUND) and the superseded cycle BEFORE both', async () => {
    const r = await makeReqIn('PENDING');
    await expectRule(review(r.id, 'APPROVED', { round: 7 }), 'REVIEW_ROUND');
    await expectRule(review(r.id, 'APPROVED', { round: 1 }), 'REVIEW_STATE');
    const [e] = await expiredReqs(1);
    await supersedeReq(e!.id);
    await expectRule(review(e!.id, 'APPROVED', { round: 99 }), 'REVIEW_SUPERSEDED');
    await expectRule(review(e!.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' }), 'REVIEW_SUPERSEDED');
  });
  it('lets the review of an approval carry exactly the expiry the requirement was approved with (REVIEW_EXPIRY): none for none, the same time for a time, and refuses a missing, different or invented end', async () => {
    const withEnd = await makeReqIn('APPROVED', expDef);
    const sameEnd = `(SELECT expires_at FROM ${CR} WHERE case_requirement_id = '${withEnd.id}')`;
    await expectRule(review(withEnd.id, 'APPROVED', { round: 1 }), 'REVIEW_EXPIRY');
    await expectRule(review(withEnd.id, 'APPROVED', { round: 1, expires: "now() + interval '2 hours'" }), 'REVIEW_EXPIRY');
    await expectRule(review(withEnd.id, 'APPROVED', { round: 1, expires: `${sameEnd} + interval '1 second'` }), 'REVIEW_EXPIRY');
    await review(withEnd.id, 'APPROVED', { round: 1, expires: sameEnd });
    const noEnd = await makeReqIn('APPROVED', docDef);
    await expectRule(review(noEnd.id, 'APPROVED', { round: 1, expires: "now() + interval '1 day'" }), 'REVIEW_EXPIRY');
    await review(noEnd.id, 'APPROVED', { round: 1 });
    expect(await reviewCount(withEnd.id)).toBe(1);
    expect(await reviewCount(noEnd.id)).toBe(1);
  });
  it('refuses a reason code that is INACTIVE or unknown (REASON_INACTIVE, before the foreign key), and accepts it again when the code is reactivated', async () => {
    const code = await makeReason('BOTH');
    const r = await makeReqIn('PENDING');
    await setReq(r.id, "status = 'REJECTED'");
    await run(`UPDATE ${REASON} SET status = 'INACTIVE' WHERE code = $1`, [code]);
    await expectRule(review(r.id, 'REJECTED', { round: 1, reason: code }), 'REASON_INACTIVE');
    await expectRule(review(r.id, 'REJECTED', { round: 1, reason: 'NO_SUCH_REASON' }), 'REASON_INACTIVE');
    const inactiveFromTheStart = await makeReason('BOTH', 'INACTIVE');
    await expectRule(review(r.id, 'REJECTED', { round: 1, reason: inactiveFromTheStart }), 'REASON_INACTIVE');
    await run(`UPDATE ${REASON} SET status = 'ACTIVE' WHERE code = $1`, [code]);
    await review(r.id, 'REJECTED', { round: 1, reason: code });
  });
  it('applies a reason only to the decisions its scope allows (REASON_NOT_APPLICABLE): REJECT-only to REJECTED, ACTION_REQUIRED-only to ACTION_REQUIRED, BOTH to both; the seeded codes behave the same', async () => {
    const codes = { REJECT: await makeReason('REJECT'), ACTION_REQUIRED: await makeReason('ACTION_REQUIRED'), BOTH: await makeReason('BOTH') };
    for (const [scope, code] of Object.entries(codes))
      for (const decision of ['REJECTED', 'ACTION_REQUIRED'] as const) {
        const r = await makeReqIn('PENDING');
        await setReq(r.id, `status = '${decision}'`);
        const ok = scope === 'BOTH' || scope === decision.replace('REJECTED', 'REJECT');
        expect(await outcomeOf(review(r.id, decision, { round: 1, reason: code })), `${scope}/${decision}`).toBe(ok ? 'ACCEPTED' : 'REASON_NOT_APPLICABLE');
      }
    const seeded: [string, string, string][] = [
      ['LICENSE_INVALID', 'REJECTED', 'ACCEPTED'],
      ['LICENSE_INVALID', 'ACTION_REQUIRED', 'REASON_NOT_APPLICABLE'],
      ['REQUIRES_RESUBMISSION', 'ACTION_REQUIRED', 'ACCEPTED'],
      ['REQUIRES_RESUBMISSION', 'REJECTED', 'REASON_NOT_APPLICABLE'],
      ['NAME_MISMATCH', 'REJECTED', 'ACCEPTED'],
      ['NAME_MISMATCH', 'ACTION_REQUIRED', 'ACCEPTED'],
    ];
    for (const [code, decision, want] of seeded) {
      const r = await makeReqIn('PENDING');
      await setReq(r.id, `status = '${decision}'`);
      expect(await outcomeOf(review(r.id, decision, { round: 1, reason: code })), `${code}/${decision}`).toBe(want);
    }
  });
  it('judges the reason AFTER the decision rules, and a reason on an approval or a start is refused by the guard when the scope does not fit (REASON_NOT_APPLICABLE) and by the CHECK otherwise', async () => {
    const approved = await makeReqIn('APPROVED');
    await expectRule(review(approved.id, 'APPROVED', { round: 1, reason: 'LICENSE_INVALID' }), 'REASON_NOT_APPLICABLE');
    await expectConstraint(review(approved.id, 'APPROVED', { round: 1, reason: 'DOCUMENT_UNREADABLE' }), 'ck_reviews__reason');
    const started = await makeReqIn('IN_REVIEW');
    await expectConstraint(review(started.id, 'STARTED', { round: 1, reason: 'NAME_MISMATCH' }), 'ck_reviews__reason');
    const rejected = await makeReqIn('PENDING');
    await setReq(rejected.id, "status = 'REJECTED'");
    await expectRule(review(rejected.id, 'REJECTED', { round: 5, reason: 'NO_SUCH_REASON' }), 'REVIEW_ROUND');
    await expectRule(review(rejected.id, 'APPROVED', { round: 1, reason: 'NO_SUCH_REASON' }), 'REVIEW_STATE');
  });
  it('refuses a requirement that does not exist by the foreign key (the guard has nothing to compare), and a reviewer that is not admin: or external:', async () => {
    await expectConstraint(review(randomUUID(), 'STARTED', { round: 1 }), 'fk_reviews__case_requirement_id');
    const r = await makeReqIn('IN_REVIEW');
    await expectConstraint(review(r.id, 'STARTED', { round: 1, reviewer: 'someone' }), 'ck_reviews__reviewer');
  });
  it('allows ONE start and ONE terminal decision per requirement and round: a second identical decision collides on the decision key, a second start on the start key, a start after a decision is a REVIEW_STATE', async () => {
    const approved = await makeReqIn('APPROVED');
    await review(approved.id, 'APPROVED', { round: 1 });
    await expectConstraint(review(approved.id, 'APPROVED', { round: 1 }), 'uq_reviews__decision');
    await expectRule(review(approved.id, 'STARTED', { round: 1 }), 'REVIEW_STATE');
    await expectRule(review(approved.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' }), 'REVIEW_STATE');
    const started = await makeReqIn('IN_REVIEW');
    await review(started.id, 'STARTED', { round: 1 });
    await expectConstraint(review(started.id, 'STARTED', { round: 1 }), 'uq_reviews__started');
    const rejected = await makeReqIn('PENDING');
    await setReq(rejected.id, "status = 'REJECTED'");
    await review(rejected.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' });
    await expectConstraint(review(rejected.id, 'REJECTED', { round: 1, reason: 'NAME_MISMATCH' }), 'uq_reviews__decision');
    expect(await reviewCount(approved.id)).toBe(1);
  });
  it('records a whole history append-only: start, reject (round 1), resubmit, start, ask for action (round 2), resubmit, approve (round 3), and nothing about an earlier round can be added afterwards', async () => {
    const r = await makeReq();
    const trail: [string, number][] = [];
    const step = async (decision: string, round: number, reason: string | null = null) => {
      await review(r.id, decision, { round, reason });
      trail.push([decision, round]);
    };
    await submitReq(r.id);
    await startReq(r.id);
    await step('STARTED', 1);
    await setReq(r.id, "status = 'REJECTED'");
    await step('REJECTED', 1, 'DOCUMENT_UNREADABLE');
    await submitReq(r.id);
    await startReq(r.id);
    await step('STARTED', 2);
    await setReq(r.id, "status = 'ACTION_REQUIRED'");
    await step('ACTION_REQUIRED', 2, 'REQUIRES_RESUBMISSION');
    await submitReq(r.id);
    await setReq(r.id, "status = 'APPROVED'");
    await step('APPROVED', 3);
    expect(await q(`SELECT decision, round FROM ${REV} WHERE case_requirement_id = $1 ORDER BY reviewed_at, review_id`, [r.id])).toEqual(
      trail.map(([decision, round]) => ({ decision, round })),
    );
    for (const round of [1, 2]) await expectRule(review(r.id, 'APPROVED', { round }), 'REVIEW_ROUND');
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('stamps reviewed_at with clock_timestamp (a time that advances inside one transaction) and takes the reviewer and correlation id as given', async () => {
    const r = await makeReqIn('IN_REVIEW');
    await review(r.id, 'STARTED', { round: 1, reviewer: 'admin:sub-1', correlation: 'corr-1' });
    const row = (
      await q<{ reviewer: string; correlation_id: string; reviewed_at: Date; expires_at: Date | null; reason_code: string | null }>(
        `SELECT * FROM ${REV} WHERE case_requirement_id = $1`,
        [r.id],
      )
    )[0]!;
    expect(row).toMatchObject({ reviewer: 'admin:sub-1', correlation_id: 'corr-1', expires_at: null, reason_code: null });
    expect(Math.abs(row.reviewed_at.getTime() - Date.now())).toBeLessThan(60000);
    const a = await makeReqIn('IN_REVIEW');
    const b = await makeReqIn('IN_REVIEW');
    const times = await inTx(async (x) => {
      await review(a.id, 'STARTED', { round: 1 }, x);
      await sleep(5);
      await review(b.id, 'STARTED', { round: 1 }, x);
      return (await x.query(`SELECT reviewed_at FROM ${REV} WHERE case_requirement_id = ANY($1) ORDER BY reviewed_at DESC`, [[a.id, b.id]])).rows as {
        reviewed_at: Date;
      }[];
    });
    expect(times[0]!.reviewed_at.getTime()).toBeGreaterThan(times[1]!.reviewed_at.getTime());
  });
});

describe('D16. reviews and audit_events: append-only (ROW_IMMUTABLE for UPDATE and DELETE)', () => {
  let r: Req;
  beforeAll(async () => {
    r = await makeReqIn('PENDING');
    await setReq(r.id, "status = 'REJECTED'");
    await review(r.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' });
    await audit({ caseId: r.caseId, reqId: r.id, action: 'VERIFICATION_REJECTED', changes: { round: 1 }, reason: 'DOCUMENT_UNREADABLE' });
    await audit({ caseId: r.caseId, action: 'VERIFICATION_CASE_OPENED', changes: { caseNumber: 1 } });
  });
  it.each([
    ['round', 'round = round + 1'],
    ['decision', "decision = 'APPROVED'"],
    ['reason_code', "reason_code = 'NAME_MISMATCH'"],
    ['reviewer', "reviewer = 'admin:other'"],
    ['expires_at', 'expires_at = now()'],
    ['correlation_id', "correlation_id = 'other'"],
    ['reviewed_at', 'reviewed_at = now()'],
    ['case_requirement_id', 'case_requirement_id = gen_random_uuid()'],
    ['no column at all', 'round = round'],
  ])('refuses to update the %s of a review', async (_label, set) => {
    const before = await q(`SELECT * FROM ${REV} ORDER BY review_id`);
    await expectRule(run(`UPDATE ${REV} SET ${set}`), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${REV} SET ${set} WHERE case_requirement_id = $1`, [r.id]), 'ROW_IMMUTABLE');
    expect(await q(`SELECT * FROM ${REV} ORDER BY review_id`)).toEqual(before);
  });
  it('refuses to delete one review or all, and lets a statement that matches nothing through', async () => {
    const n = await count(REV);
    await expectRule(run(`DELETE FROM ${REV} WHERE case_requirement_id = $1`, [r.id]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${REV}`), 'ROW_IMMUTABLE');
    expect(await count(REV)).toBe(n);
    await run(`DELETE FROM ${REV} WHERE false`);
    await run(`UPDATE ${REV} SET round = 9 WHERE false`);
  });
  it.each([
    ['actor', "actor = 'someone'"],
    ['action', "action = 'VERIFICATION_APPROVED'"],
    ['changes', "changes = '{}'::jsonb"],
    ['reason_code', "reason_code = 'x'"],
    ['correlation_id', "correlation_id = 'other'"],
    ['occurred_at', 'occurred_at = now()'],
    ['verification_case_id', 'verification_case_id = NULL'],
    ['no column at all', 'actor = actor'],
    ['every column', "actor = 'x', action = 'VERIFICATION_APPROVED', changes = NULL, reason_code = NULL, correlation_id = 'y', occurred_at = now()"],
  ])('refuses to update the %s of an audit event', async (_label, set) => {
    const before = await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`);
    await expectRule(run(`UPDATE ${AUDIT} SET ${set}`), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${AUDIT} SET ${set} WHERE verification_case_id = $1`, [r.caseId]), 'ROW_IMMUTABLE');
    expect(await q(`SELECT * FROM ${AUDIT} ORDER BY audit_event_id`)).toEqual(before);
  });
  it('refuses to delete one audit event or all, lets a statement that matches nothing through, and appends: an insert is accepted at any time, so the trail only grows', async () => {
    const n = await count(AUDIT);
    await expectRule(run(`DELETE FROM ${AUDIT} WHERE verification_case_id = $1`, [r.caseId]), 'ROW_IMMUTABLE');
    await expectRule(run(`DELETE FROM ${AUDIT}`), 'ROW_IMMUTABLE');
    expect(await count(AUDIT)).toBe(n);
    await run(`DELETE FROM ${AUDIT} WHERE false`);
    await run(`UPDATE ${AUDIT} SET actor = 'x' WHERE false`);
    await audit({ caseId: r.caseId, action: 'VERIFICATION_SUBMITTED', changes: { count: 2 } });
    expect(await count(AUDIT)).toBe(n + 1);
  });
  it('is immutable even for the statements the services would never write: the row guard of the audit trail and of the reviews cannot be bypassed by an UPDATE that changes nothing', async () => {
    await expectRule(run(`UPDATE ${AUDIT} SET audit_event_id = audit_event_id`), 'ROW_IMMUTABLE');
    await expectRule(run(`UPDATE ${REV} SET review_id = review_id`), 'ROW_IMMUTABLE');
  });
});

describe('D17. external_verifications (INSERT and UPDATE): EXTERNAL_NOT_SUPPORTED, EXTERNAL_STATE, EXTERNAL_FROZEN', () => {
  it('refuses a reference for a requirement evidenced by DOCUMENTS and for a requirement that does not exist (EXTERNAL_NOT_SUPPORTED, before the foreign key)', async () => {
    const r = await makeReqIn('PENDING', docDef);
    await expectRule(extRef(r.id), 'EXTERNAL_NOT_SUPPORTED');
    await expectRule(extRef(randomUUID()), 'EXTERNAL_NOT_SUPPORTED');
    expect(await count(EXT, 'case_requirement_id = $1', [r.id])).toBe(0);
  });
  it.each(TRUST_REQUIREMENT_STATUSES)(
    'a requirement that is %s: a reference is accepted while it is PENDING or IN_REVIEW (just submitted, in the round it names) and refused EXTERNAL_STATE otherwise',
    async (kind) => {
      const r = kind === 'EXPIRED' ? (await expiredReqs(1, extDef))[0]! : await makeReqIn(kind, extDef);
      const round = (await crRow<{ round: number }>(r.id)).round;
      const ok = kind === 'PENDING' || kind === 'IN_REVIEW';
      expect(await outcomeOf(extRef(r.id, { round: Math.max(round, 1) })), kind).toBe(ok ? 'ACCEPTED' : 'EXTERNAL_STATE');
    },
  );
  it('names the round the requirement was just submitted in (a higher, a lower and a zero round are refused, before the CHECK), and starts CREATED (any other status is refused)', async () => {
    const r = await makeReqIn('PENDING', extDef);
    for (const round of [2, 3, 0, -1]) await expectRule(extRef(r.id, { round }), 'EXTERNAL_STATE');
    for (const status of TRUST_EXTERNAL_STATUSES.filter((s) => s !== 'CREATED')) await expectRule(extRef(r.id, { round: 1, status }), 'EXTERNAL_STATE');
    await expectRule(extRef(r.id, { round: 1, status: 'BOGUS' }), 'EXTERNAL_STATE');
    await extRef(r.id, { round: 1, status: 'CREATED' });
    await expectConstraint(extRef(r.id, { round: 1 }), 'uq_external_verifications__round');
  });
  it('refuses a superseded cycle (EXTERNAL_STATE) and judges the evidence kind before the state', async () => {
    const [e] = await expiredReqs(1, extDef);
    await supersedeReq(e!.id);
    await expectRule(extRef(e!.id, { round: 1 }), 'EXTERNAL_STATE');
    const doc = await makeReqIn('NOT_STARTED', docDef);
    await expectRule(extRef(doc.id, { round: 1 }), 'EXTERNAL_NOT_SUPPORTED'); // kind first, though the state is also wrong
  });
  it('keeps one reference per adapter and external id, and one per requirement and round, under the guard', async () => {
    const [a, b] = [await makeReqIn('PENDING', extDef), await makeReqIn('PENDING', extDef)];
    await extRef(a.id, { adapter: 'fake', externalId: 'ref-1' });
    await expectConstraint(extRef(b.id, { adapter: 'fake', externalId: 'ref-1' }), 'uq_external_verifications__external');
    await extRef(b.id, { adapter: 'other', externalId: 'ref-1' });
  });

  const EXT_FINISHED = new Set(['APPROVED', 'REJECTED', 'CANCELLED']);
  const EXT_PAIRS = TRUST_EXTERNAL_STATUSES.flatMap((from) => TRUST_EXTERNAL_STATUSES.map((to) => [from, to] as [string, string]));
  const extIn = async (status: string): Promise<string> => {
    const r = await makeReqIn('PENDING', extDef);
    await extRef(r.id);
    const id = (await q<{ id: string }>(`SELECT external_verification_id AS id FROM ${EXT} WHERE case_requirement_id = $1`, [r.id]))[0]!.id;
    if (status !== 'CREATED') await run(`UPDATE ${EXT} SET status = $2 WHERE external_verification_id = $1`, [id, status]);
    return id;
  };
  it.each(EXT_PAIRS)(
    'status %s -> %s: a finished reference (APPROVED, REJECTED, CANCELLED) never changes its status (EXTERNAL_FROZEN); CREATED, PENDING and ERROR move to any status; the same status is a field change',
    async (from, to) => {
      const id = await extIn(from);
      const outcome = await outcomeOf(run(`UPDATE ${EXT} SET status = $2 WHERE external_verification_id = $1`, [id, to]));
      expect(outcome).toBe(from !== to && EXT_FINISHED.has(from) ? 'EXTERNAL_FROZEN' : 'ACCEPTED');
      expect((await q<{ status: string }>(`SELECT status FROM ${EXT} WHERE external_verification_id = $1`, [id]))[0]!.status).toBe(
        outcome === 'ACCEPTED' ? to : from,
      );
    },
  );
  it('refuses an unknown status as a move from a live reference (the CHECK) and as a move from a finished one (the guard)', async () => {
    const live = await extIn('PENDING');
    await expectConstraint(run(`UPDATE ${EXT} SET status = 'BOGUS' WHERE external_verification_id = $1`, [live]), 'ck_external_verifications__status');
    const done = await extIn('APPROVED');
    await expectRule(run(`UPDATE ${EXT} SET status = 'BOGUS' WHERE external_verification_id = $1`, [done]), 'EXTERNAL_FROZEN');
  });
  it('records when the adapter was last asked (last_checked_at), also on a finished reference, and stamps updated_at; the reference survives its requirement moving on', async () => {
    const id = await extIn('APPROVED');
    const before = (await q<{ updated_at: Date }>(`SELECT updated_at FROM ${EXT} WHERE external_verification_id = $1`, [id]))[0]!;
    await sleep(20);
    await run(`UPDATE ${EXT} SET last_checked_at = now(), updated_at = '2001-01-01' WHERE external_verification_id = $1`, [id]);
    const after = (
      await q<{ updated_at: Date; last_checked_at: Date }>(`SELECT updated_at, last_checked_at FROM ${EXT} WHERE external_verification_id = $1`, [id])
    )[0]!;
    expect(after.last_checked_at.getFullYear()).toBeGreaterThan(2020);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    const pending = await extIn('PENDING');
    const reqId = (await q<{ r: string }>(`SELECT case_requirement_id AS r FROM ${EXT} WHERE external_verification_id = $1`, [pending]))[0]!.r;
    await setReq(reqId, "status = 'APPROVED', expires_at = now() + interval '1 hour'");
    await run(`UPDATE ${EXT} SET status = 'APPROVED' WHERE external_verification_id = $1`, [pending]); // the snapshot may follow after the requirement was decided
  });
  it('relays an external decision as a review by external:<adapter> (the reviewer format) and nothing else about the vendor is stored', async () => {
    const r = await makeReqIn('PENDING', extDef);
    await extRef(r.id, { adapter: 'fake', externalId: 'v-1' });
    await setReq(r.id, `status = 'APPROVED', expires_at = ${HOUR}`);
    await review(r.id, 'APPROVED', { round: 1, reviewer: 'external:fake', expires: `(SELECT expires_at FROM ${CR} WHERE case_requirement_id = '${r.id}')` });
    expect((await q<{ reviewer: string }>(`SELECT reviewer FROM ${REV} WHERE case_requirement_id = $1`, [r.id]))[0]!.reviewer).toBe('external:fake');
  });
});

describe('D15b. reviews and external references (INSERT): a CANCELLED case is frozen (CASE_FROZEN), judged before everything else', () => {
  it('refuses a review for a requirement of a CANCELLED case, in every decision, with a wrong round and a superseded cycle alike (the case is read first), and no row lands', async () => {
    const r = await makeReqIn('IN_REVIEW');
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(review(r.id, 'STARTED', { round: 1 }), 'CASE_FROZEN');
    await expectRule(review(r.id, 'STARTED', { round: 99 }), 'CASE_FROZEN');
    await expectRule(review(r.id, 'APPROVED', { round: 1 }), 'CASE_FROZEN');
    await expectRule(review(r.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' }), 'CASE_FROZEN');
    expect(await reviewCount(r.id)).toBe(0);
    const [e] = await expiredReqs(1);
    await supersedeReq(e!.id);
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [e!.caseId]);
    await expectRule(review(e!.id, 'APPROVED', { round: 1 }), 'CASE_FROZEN');
  });
  it('still records a review for every case status but CANCELLED (the requirement state decides)', async () => {
    for (const kind of ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[]) {
      const r = await makeReqIn('IN_REVIEW');
      await run(`UPDATE ${CASES} SET status = $2 WHERE verification_case_id = $1`, [r.caseId, kind]);
      await review(r.id, 'STARTED', { round: 1 });
      expect(await reviewCount(r.id), kind).toBe(1);
    }
  });
  it('refuses an external reference for a requirement of a CANCELLED case (CASE_FROZEN), also when the definition is documentary or the round is wrong (the case is read before the kind and the state)', async () => {
    const e = await makeReqIn('PENDING', extDef);
    const d = await makeReqIn('PENDING', docDef);
    for (const r of [e, d]) await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [r.caseId]);
    await expectRule(extRef(e.id), 'CASE_FROZEN');
    await expectRule(extRef(e.id, { round: 9 }), 'CASE_FROZEN');
    await expectRule(extRef(d.id), 'CASE_FROZEN');
    expect(await count(EXT, 'case_requirement_id = ANY($1)', [[e.id, d.id]])).toBe(0);
  });
  it('still creates an external reference for every case status but CANCELLED', async () => {
    for (const kind of ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as CaseKind[]) {
      const r = await makeReqIn('PENDING', extDef);
      await run(`UPDATE ${CASES} SET status = $2 WHERE verification_case_id = $1`, [r.caseId, kind]);
      await extRef(r.id);
      expect(await count(EXT, 'case_requirement_id = $1', [r.id]), kind).toBe(1);
    }
  });
});

describe('F. RESTRICT: every foreign key holds when the guards are bypassed, and TRUNCATE is refused for every table', () => {
  // one fixture per foreign key, each referenced by exactly ONE child table, so that the constraint that answers is unambiguous
  let r: Req; // a requirement that only a review names
  let withDoc: Req; // a requirement that only a document names
  let ext: Req; // a requirement that only an external reference names
  let bareCase: Req; // a case that only a requirement names
  let reasonCode: string;
  let entryKeys: { def: string; dt: string; reason: string };
  beforeAll(async () => {
    r = await makeReqIn('PENDING');
    withDoc = await makeReq();
    await mkDoc(withDoc.id);
    bareCase = await makeReq();
    await setReq(r.id, "status = 'REJECTED'");
    reasonCode = await makeReason('BOTH');
    await review(r.id, 'REJECTED', { round: 1, reason: reasonCode });
    ext = await makeReqIn('PENDING', extDef);
    await extRef(ext.id);
    await audit({ caseId: (await makeCase()).caseId }); // the trail is not empty (the TRUNCATE tests below need a row in every table)
    // the content entries of a definition, a document type and a reason code that nothing else references (no version): deletable but for the foreign keys of the trust tables
    const def = await makeDef({ status: 'INACTIVE' });
    const dt = await makeDocType('IDENTITY');
    const dtCode = (await q<{ code: string }>(`SELECT code FROM ${DTYPE} WHERE document_type_id = $1`, [dt]))[0]!.code;
    entryKeys = { def: trustRequirementNameKey(def.code), dt: trustDocumentTypeNameKey(dtCode), reason: trustReasonNameKey(reasonCode) };
  });
  const guardsOff =
    (...tables: string[]) =>
    async (c: pg.PoolClient) => {
      await c.query(NO_FOREIGN_TRIGGERS);
      for (const s of noTriggers(...tables)) await c.query(s);
    };

  it('holds the account: an account with a case cannot be deleted even with every guard off (fk_verification_cases__account_id)', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(CASES)(c);
        const id = ((await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0] as { account_id: string })
          .account_id;
        await c.query(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, 1)`, [id]);
        await c.query('DELETE FROM identity.accounts WHERE account_id = $1', [id]);
      }),
      'fk_verification_cases__account_id',
    );
    // with every guard ON the account is refused by whichever rule answers first: it is never deleted
    await fail(run('DELETE FROM identity.accounts WHERE account_id = $1', [r.account]));
    expect(await count('identity.accounts', 'account_id = $1', [r.account])).toBe(1);
  });
  it('holds the market and the service type: one named by a rule cannot be deleted (fk_requirement_rules__market_id, fk_requirement_rules__service_type_id), and a rule cannot name one that does not exist', async () => {
    const MARKET_INSERT = `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT 'zz-trust', 'zz-trust', c.country_id, 'PLANNED', 'en-US', 'USD', t.time_zone_id, now()
         FROM geography.countries c, geography.time_zones t WHERE c.iso_alpha2 = 'US' AND t.iana_name = 'America/Los_Angeles' RETURNING market_id`;
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(RULE)(c);
        const market = ((await c.query(MARKET_INSERT)).rows[0] as { market_id: string }).market_id;
        await addRule(docDef.id, market, null, true, c);
        await c.query('DELETE FROM geography.markets WHERE market_id = $1', [market]);
      }),
      'fk_requirement_rules__market_id',
    );
    const st = await makeServiceType();
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(RULE)(c);
        await addRule(docDef.id, null, st.id, true, c);
        await c.query('DELETE FROM catalog.service_types WHERE service_type_id = $1', [st.id]);
      }),
      'fk_requirement_rules__service_type_id',
    );
  });
  it('holds the content entries: the name and instructions of a definition, the name of a document type and of a reason code cannot be deleted while they are named (the generated keys are foreign keys)', async () => {
    const delEntry = (key: string) =>
      rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        await c.query('DELETE FROM content.entries WHERE key = $1', [key]);
      });
    await expectConstraint(delEntry(entryKeys.def), 'fk_requirement_definitions__name_content_key');
    await expectConstraint(delEntry(entryKeys.def.replace(/\.name$/, '.instructions')), 'fk_requirement_definitions__instructions_content_key');
    await expectConstraint(delEntry(entryKeys.dt), 'fk_document_types__name_content_key');
    await expectConstraint(delEntry(entryKeys.reason), 'fk_reason_codes__name_content_key');
  });
  it('holds the definition (a rule, an instance or an audit event names it), the document type (a document names it) and the reason code (a review names it), even with their own guards off', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(DEF)(c);
        await c.query(`DELETE FROM ${DEF} WHERE requirement_definition_id = $1`, [identityDef]);
      }),
      'fk_requirement_rules__definition_id',
    );
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(DEF)(c);
        await c.query(`DELETE FROM ${DEF} WHERE requirement_definition_id = $1`, [docDef.id]);
      }),
      'fk_case_requirements__definition_id',
    );
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(DTYPE)(c);
        await c.query(`DELETE FROM ${DTYPE} WHERE code = 'drivers_license'`);
      }),
      'fk_documents__document_type_id',
    );
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(REASON)(c);
        await c.query(`DELETE FROM ${REASON} WHERE code = $1`, [reasonCode]);
      }),
      'fk_reviews__reason_code',
    );
  });
  it('holds the case (a requirement or an audit event names it) and the requirement (a document, a review, an external reference or an audit event names it), even with their own guards off', async () => {
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(CASES)(c);
        await c.query(`DELETE FROM ${CASES} WHERE verification_case_id = $1`, [bareCase.caseId]);
      }),
      'fk_case_requirements__case_id',
    );
    // (the fixtures are made BEFORE the transaction that switches the guards off: disabling a trigger locks the table, and a second connection would wait for it)
    const bareAudited = await makeCase();
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(CASES)(c);
        const bare = bareAudited;
        await audit({ caseId: bare.caseId }, c);
        await c.query(`DELETE FROM ${CASES} WHERE verification_case_id = $1`, [bare.caseId]);
      }),
      'fk_audit_events__case_id',
    );
    for (const [id, fk] of [
      [withDoc.id, 'fk_documents__case_requirement_id'],
      [r.id, 'fk_reviews__case_requirement_id'],
      [ext.id, 'fk_external_verifications__case_requirement_id'],
    ] as const)
      await expectConstraint(
        rolledBack(async (c) => {
          await guardsOff(CR)(c);
          await c.query(`DELETE FROM ${CR} WHERE case_requirement_id = $1`, [id]);
        }),
        fk,
      );
    const bareReq = await makeReq();
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(CR)(c);
        const bare = bareReq;
        await audit({ reqId: bare.id }, c);
        await c.query(`DELETE FROM ${CR} WHERE case_requirement_id = $1`, [bare.id]);
      }),
      'fk_audit_events__case_requirement_id',
    );
    await expectConstraint(
      rolledBack(async (c) => {
        await guardsOff(DEF)(c);
        const d = await makeDef({ status: 'INACTIVE' }, c);
        await audit({ defId: d.id }, c);
        await c.query(`DELETE FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id]);
      }),
      'fk_audit_events__definition_id',
    );
  });

  const REFERENCED = [DEF, DTYPE, REASON, CASES, CR];
  const UNREFERENCED = [RULE, DOC, REV, EXT, AUDIT];
  it('refuses a plain TRUNCATE of a table that others reference (PostgreSQL itself, 0A000) and of the five that nothing references (ROW_IMMUTABLE), and every CASCADE and multi-table form (ROW_IMMUTABLE); every row survives', async () => {
    const before = await Promise.all(TABLES.map((t) => count(t)));
    expect(before.every((n) => n > 0)).toBe(true);
    for (const t of REFERENCED) await expect(pool.query(`TRUNCATE ${t}`), t).rejects.toMatchObject({ code: '0A000' });
    for (const t of UNREFERENCED) await expectRule(run(`TRUNCATE ${t}`), 'ROW_IMMUTABLE');
    for (const t of TABLES) await expectRule(run(`TRUNCATE ${t} CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${TABLES.join(', ')}`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`), 'ROW_IMMUTABLE');
    await expectRule(run(`TRUNCATE ${[...TABLES].reverse().join(', ')} CONTINUE IDENTITY`), 'ROW_IMMUTABLE');
    expect(await Promise.all(TABLES.map((t) => count(t)))).toEqual(before);
  });
  it('lists the referenced and unreferenced tables truthfully (no table references documents, reviews, external references, rules or the audit trail)', async () => {
    const referenced = (
      await q<{ t: string }>(
        `SELECT DISTINCT confrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND connamespace = 'trust'::regnamespace AND confrelid::regclass::text LIKE 'trust.%'`,
      )
    ).map((x) => x.t);
    expect(referenced.sort(byName)).toEqual([...REFERENCED].sort(byName));
    expect(new Set([...REFERENCED, ...UNREFERENCED])).toEqual(new Set(TABLES));
  });
  /** The roots a CASCADE can start from, and the trust tables each one reaches. */
  const ROOTS: [string, string[]][] = [
    ['identity.accounts', [CASES, CR, DOC, REV, EXT, AUDIT]],
    ['geography.markets', [RULE]],
    ['catalog.service_types', [RULE]],
    ['content.entries', [DEF, DTYPE, REASON, RULE, CR, DOC, REV, EXT, AUDIT]],
  ];
  it.each(ROOTS)(
    'refuses a TRUNCATE of %s CASCADE that reaches the trust tables, as a trust guard failure (the guards of every other schema are switched off in that transaction, so only the trust schema can answer); with the trust guards off the same statement would go through',
    async (root, reached) => {
      const before = await Promise.all(TABLES.map((t) => count(t)));
      await expectRule(
        rolledBack(async (c) => {
          await c.query(NO_FOREIGN_TRIGGERS);
          await c.query(`TRUNCATE ${root} CASCADE`);
        }),
        'ROW_IMMUTABLE',
      );
      await rolledBack(async (c) => {
        await c.query(NO_FOREIGN_TRIGGERS);
        for (const s of noTriggers(...TABLES)) await c.query(s);
        await c.query(`TRUNCATE ${root} CASCADE`); // not refused by anything else: the trust triggers were the only thing in the way
        for (const t of reached) expect(await count(t, 'true', [], c), `${t} was truncated`).toBe(0);
      });
      await expect(pool.query(`TRUNCATE ${root}`)).rejects.toMatchObject({ code: '0A000' });
      expect(await Promise.all(TABLES.map((t) => count(t)))).toEqual(before);
    },
  );
  it('is not enough to disable the guards of all tables but one: the one left still refuses a TRUNCATE CASCADE from the account', async () => {
    for (const keep of [CASES, CR, DOC, REV, EXT, AUDIT]) {
      await expectRule(
        rolledBack(async (c) => {
          await c.query(NO_FOREIGN_TRIGGERS);
          for (const s of noTriggers(...TABLES.filter((t) => t !== keep))) await c.query(s);
          await c.query('TRUNCATE identity.accounts CASCADE');
        }),
        'ROW_IMMUTABLE',
      );
    }
  });
});

// ====================================================================== H. concurrency: real lock waiters first, then repeated simultaneous races (both orders of every pair)
const insertCaseSql = (account: string, n = 1): RaceSql => sqlOf(`INSERT INTO ${CASES} (account_id, case_number) VALUES ($1, $2)`, account, n);
const cancelCaseSql = (caseId: string): RaceSql => sqlOf(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, caseId);
const insertReqSql = (caseId: string, defId: string): RaceSql =>
  sqlOf(`INSERT INTO ${CR} (verification_case_id, requirement_definition_id) VALUES ($1, $2)`, caseId, defId);
const defStatusSql = (defId: string, status: string): RaceSql => sqlOf(`UPDATE ${DEF} SET status = $2 WHERE requirement_definition_id = $1`, defId, status);
const insertRuleSql = (defId: string): RaceSql => sqlOf(`INSERT INTO ${RULE} (requirement_definition_id, enabled) VALUES ($1, true)`, defId);
const submitSql = (reqId: string): RaceSql => sqlOf(`UPDATE ${CR} SET status = 'PENDING', round = round + 1 WHERE case_requirement_id = $1`, reqId);
const reqStatusSql = (reqId: string, set: string): RaceSql => sqlOf(`UPDATE ${CR} SET ${set} WHERE case_requirement_id = $1`, reqId);
const insertDocSql = (caseId: string, reqId: string): RaceSql => {
  const id = randomUUID();
  return sqlOf(
    `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at)
     VALUES ($1, $2, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'drivers_license'), $3, 'application/pdf', 1, now() + interval '15 minutes')`,
    id,
    reqId,
    `trust/evidence/${caseId}/${id}`,
  );
};
const attachSql = (docId: string): RaceSql => sqlOf(`UPDATE ${DOC} SET status = 'ATTACHED', sha256 = $2 WHERE verification_document_id = $1`, docId, SHA);
const submitDocSql = (docId: string, round: number): RaceSql =>
  sqlOf(`UPDATE ${DOC} SET status = 'SUBMITTED', round = $2 WHERE verification_document_id = $1`, docId, round);
const reviewSql = (reqId: string, decision: string, round = 1, reason: string | null = null): RaceSql =>
  sqlOf(
    `INSERT INTO ${REV} (case_requirement_id, round, decision, reason_code, reviewer, correlation_id) VALUES ($1, $2, $3, $4, 'admin:racer', 'race')`,
    reqId,
    round,
    decision,
    reason,
  );
const extSql = (reqId: string): RaceSql =>
  sqlOf(`INSERT INTO ${EXT} (case_requirement_id, round, adapter, external_id) VALUES ($1, 1, 'fake', $2)`, reqId, `race-${randomUUID()}`);
const accountStatus = async (account: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM identity.accounts WHERE account_id = $1', [account]))[0]!.status;
const suspend = (account: string) => (c: pg.PoolClient) => suspendOn(c, account);

describe('H1. two first cases of one account serialize on the unique keys (real lock waiter, then 30 simultaneous rounds)', () => {
  it('holds the second insert back while the first is open, then refuses it with a unique violation (no partial row); a rolled-back first lets the second through', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => exec(tx, insertCaseSql(a)), insertCaseSql(a));
    expect(e?.code).toBe('23505');
    expect(['uq_verification_cases__number', 'uq_verification_cases__live']).toContain(e?.constraint);
    expect(await count(CASES, 'account_id = $1', [a])).toBe(1);
    const b = await makeAccount();
    const e2 = await holdThenRace((tx) => exec(tx, insertCaseSql(b)), insertCaseSql(b), 'ROLLBACK');
    expect(e2).toBeUndefined();
    expect(await count(CASES, 'account_id = $1', [b])).toBe(1);
    await noLockWaiters();
  });
  it('holds the RESTART of an account whose case was cancelled back the same way: two simultaneous second cases, one winner', async () => {
    const a = await makeAccount();
    await cancelCase(await openCase(a));
    const e = await holdThenRace((tx) => exec(tx, insertCaseSql(a, 2)), insertCaseSql(a, 2));
    expect(e?.code).toBe('23505');
    expect((await q<{ case_number: number }>(`SELECT case_number FROM ${CASES} WHERE account_id = $1 ORDER BY 1`, [a])).map((r) => r.case_number)).toEqual([
      1, 2,
    ]);
  });
  it('30 rounds of two simultaneous first cases: exactly one wins, the other gets a unique violation or the sequence rule, never a deadlock, never two rows', async () => {
    for (let round = 0; round < 30; round++) {
      const a = await makeAccount();
      const r = await both(insertCaseSql(a), insertCaseSql(a));
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      const loser = r.find((x) => x !== undefined)!;
      const kind = loser.code === '23505' ? `unique:${loser.constraint}` : `${loser.code}:${loser.detail}`;
      expect(
        ['unique:uq_verification_cases__number', 'unique:uq_verification_cases__live', '23000:trust_rule:CASE_NUMBER_SEQUENCE'],
        `round ${round}`,
      ).toContain(kind);
      expect(await count(CASES, 'account_id = $1', [a])).toBe(1);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('30 rounds of two simultaneous restarts after a cancellation: exactly one new case, numbered 2', async () => {
    for (let round = 0; round < 30; round++) {
      const a = await makeAccount();
      await cancelCase(await openCase(a));
      const next = sqlOf(
        `INSERT INTO ${CASES} (account_id, case_number) SELECT $1::uuid, COALESCE(max(case_number), 0) + 1 FROM ${CASES} WHERE account_id = $1`,
        a,
      );
      const r = await both(next, next);
      r.forEach(notDeadlock);
      expect(winners(r), `round ${round}`).toBe(1);
      expect((await q<{ case_number: number }>(`SELECT case_number FROM ${CASES} WHERE account_id = $1 ORDER BY 1`, [a])).map((x) => x.case_number)).toEqual([
        1, 2,
      ]);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});
async function cancelCase(caseId: string): Promise<void> {
  await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE verification_case_id = $1`, [caseId]);
}

describe('H2. opening a case against a suspension of the account (the account row is read FOR SHARE)', () => {
  it('holds the INSERT back while a suspension is open, then refuses it: ACCOUNT_NOT_ACTIVE, no row', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => suspendOn(tx, a), insertCaseSql(a));
    expect(asRule(e)).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
    expect(await count(CASES, 'account_id = $1', [a])).toBe(0);
    expect(await accountStatus(a)).toBe('SUSPENDED');
  });
  it('holds the suspension back while an INSERT is open (it needs the account row exclusively); the suspension then succeeds and the case exists', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => exec(tx, insertCaseSql(a)), suspend(a));
    expect(e).toBeUndefined();
    expect(await count(CASES, 'account_id = $1', [a])).toBe(1);
    expect(await accountStatus(a)).toBe('SUSPENDED');
  });
  it('lets the INSERT through when the suspension is rolled back (the wait is only for the open transaction, nothing stays locked)', async () => {
    const a = await makeAccount();
    const e = await holdThenRace((tx) => suspendOn(tx, a), insertCaseSql(a), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect(await count(CASES, 'account_id = $1', [a])).toBe(1);
    expect(await accountStatus(a)).toBe('ACTIVE');
    await noLockWaiters();
  });
  it('25 rounds of an INSERT against a suspension at the same instant: the suspension always wins its row, the INSERT either lands first or is refused ACCOUNT_NOT_ACTIVE; never a deadlock, and the rows agree with the outcome', async () => {
    const outcomes = { inserted: 0, refused: 0 };
    for (let round = 0; round < 25; round++) {
      const a = await makeAccount();
      const r = await both(insertCaseSql(a), suspend(a));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the suspension`).toBeUndefined();
      expect(await accountStatus(a)).toBe('SUSPENDED');
      if (r[0] === undefined) {
        outcomes.inserted++;
        expect(await count(CASES, 'account_id = $1', [a])).toBe(1);
      } else {
        outcomes.refused++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('ACCOUNT_NOT_ACTIVE'));
        expect(await count(CASES, 'account_id = $1', [a])).toBe(0);
      }
    }
    expect(outcomes.inserted + outcomes.refused).toBe(25);
  });
});

describe('H3. a requirement or a document against the cancellation of its case (the case row is read FOR SHARE)', () => {
  it('holds a requirement INSERT back while a cancellation is open, then refuses it: CASE_FROZEN, no row', async () => {
    const { caseId } = await makeCase();
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(caseId)), insertReqSql(caseId, docDef.id));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
  });
  it('holds the cancellation back while a requirement INSERT is open; both then succeed (the requirement stays in the cancelled case as history)', async () => {
    const { caseId } = await makeCase();
    const e = await holdThenRace((tx) => exec(tx, insertReqSql(caseId, docDef.id)), cancelCaseSql(caseId));
    expect(e).toBeUndefined();
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
    expect((await caseRow<{ status: string }>(caseId)).status).toBe('CANCELLED');
  });
  it('lets the requirement INSERT through when the cancellation is rolled back', async () => {
    const { caseId } = await makeCase();
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(caseId)), insertReqSql(caseId, docDef.id), 'ROLLBACK');
    expect(e).toBeUndefined();
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
    await noLockWaiters();
  });
  it('holds a requirement UPDATE back while a cancellation is open, then refuses it: CASE_FROZEN, the requirement keeps its state', async () => {
    const r = await makeReqIn('PENDING');
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(r.caseId)), reqStatusSql(r.id, "status = 'IN_REVIEW'"));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    expect(await statusOf(r.id)).toBe('PENDING');
  });
  it('holds a document INSERT back while a cancellation is open, then refuses it: CASE_FROZEN, no row; and holds the cancellation back while a document INSERT is open', async () => {
    const r = await makeReq();
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(r.caseId)), insertDocSql(r.caseId, r.id));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
    const s = await makeReq();
    const e2 = await holdThenRace((tx) => exec(tx, insertDocSql(s.caseId, s.id)), cancelCaseSql(s.caseId));
    expect(e2).toBeUndefined();
    expect(await count(DOC, 'case_requirement_id = $1', [s.id])).toBe(1);
  });
  it('holds the ATTACH of an upload back while a cancellation is open (CASE_FROZEN), and the cancellation back while an ATTACH is open; the same for the SUBMIT of an attached draft', async () => {
    const a = await makeReq();
    const draftA = await mkDoc(a.id);
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(a.caseId)), attachSql(draftA));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    const b = await makeReq();
    const draftB = await mkDoc(b.id);
    expect(await holdThenRace((tx) => exec(tx, attachSql(draftB)), cancelCaseSql(b.caseId))).toBeUndefined();
    expect((await docRow<{ status: string }>(draftB)).status).toBe('ATTACHED');
    const { req, id } = await makeDocIn('ATTACHED');
    const e2 = await holdThenRace((tx) => exec(tx, cancelCaseSql(req.caseId)), submitDocSql(id, 1));
    expect(asRule(e2)).toEqual(rule('CASE_FROZEN'));
    const second = await makeDocIn('ATTACHED');
    expect(await holdThenRace((tx) => exec(tx, submitDocSql(second.id, 1)), cancelCaseSql(second.req.caseId))).toBeUndefined();
    expect((await docRow<{ status: string }>(second.id)).status).toBe('SUBMITTED');
  });
  it('25 rounds of a requirement INSERT against a cancellation at the same instant: the cancellation always succeeds, the INSERT lands first or is refused CASE_FROZEN; never a deadlock, and the rows agree', async () => {
    const outcomes = { inserted: 0, refused: 0 };
    for (let round = 0; round < 25; round++) {
      const { caseId } = await makeCase();
      const r = await both(insertReqSql(caseId, docDef.id), cancelCaseSql(caseId));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}: the cancellation`).toBeUndefined();
      if (r[0] === undefined) {
        outcomes.inserted++;
        expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
      } else {
        outcomes.refused++;
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('CASE_FROZEN'));
        expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
      }
    }
    expect(outcomes.inserted + outcomes.refused).toBe(25);
  });
});

describe('H4. a requirement or a rule against the deactivation or retirement of its definition (the definition row is read FOR SHARE)', () => {
  it.each([
    ['deactivation', 'INACTIVE'],
    ['retirement', 'RETIRED'],
  ] as const)('holds a requirement INSERT back while a %s is open, then refuses it: REQUIREMENT_NOT_ACTIVE, no row', async (_label, to) => {
    const d = await makeDef({ status: 'ACTIVE' });
    const { caseId } = await makeCase();
    const e = await holdThenRace((tx) => exec(tx, defStatusSql(d.id, to)), insertReqSql(caseId, d.id));
    expect(asRule(e)).toEqual(rule('REQUIREMENT_NOT_ACTIVE'));
    expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
  });
  it.each(['INACTIVE', 'RETIRED'] as const)(
    'holds a %s back while a requirement INSERT is open (a real lock waiter); the definition then changes and the requirement stays (history)',
    async (to) => {
      const d = await makeDef({ status: 'ACTIVE' });
      const { caseId } = await makeCase();
      const e = await holdThenRace((tx) => exec(tx, insertReqSql(caseId, d.id)), defStatusSql(d.id, to));
      expect(e).toBeUndefined();
      expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
      expect((await q<{ status: string }>(`SELECT status FROM ${DEF} WHERE requirement_definition_id = $1`, [d.id]))[0]!.status).toBe(to);
    },
  );
  it('holds an ENABLED rule INSERT back while a retirement is open (RULE_DEFINITION_RETIRED), and the retirement back while a rule INSERT is open', async () => {
    const d = await makeDef({ status: 'ACTIVE' });
    const e = await holdThenRace((tx) => exec(tx, defStatusSql(d.id, 'RETIRED')), insertRuleSql(d.id));
    expect(asRule(e)).toEqual(rule('RULE_DEFINITION_RETIRED'));
    expect(await count(RULE, 'requirement_definition_id = $1', [d.id])).toBe(0);
    const d2 = await makeDef({ status: 'ACTIVE' });
    expect(await holdThenRace((tx) => exec(tx, insertRuleSql(d2.id)), defStatusSql(d2.id, 'RETIRED'))).toBeUndefined();
    expect(await count(RULE, 'requirement_definition_id = $1', [d2.id])).toBe(1);
  });
  it('25 rounds of a requirement INSERT against a deactivation at the same instant: the deactivation always succeeds, the INSERT lands first or is refused REQUIREMENT_NOT_ACTIVE; never a deadlock', async () => {
    for (let round = 0; round < 25; round++) {
      const d = await makeDef({ status: 'ACTIVE' });
      const { caseId } = await makeCase();
      const r = await both(insertReqSql(caseId, d.id), defStatusSql(d.id, 'INACTIVE'));
      r.forEach(notDeadlock);
      expect(r[1], `round ${round}`).toBeUndefined();
      if (r[0] !== undefined) {
        expect(asRule(r[0]), `round ${round}`).toEqual(rule('REQUIREMENT_NOT_ACTIVE'));
        expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(0);
      } else expect(await count(CR, 'verification_case_id = $1', [caseId])).toBe(1);
    }
  });
});

describe('H5. a document against the submission of its requirement (the requirement row is read FOR SHARE)', () => {
  it('holds a document INSERT back while a submission is open, then refuses it: DOCUMENT_REQUIREMENT_STATE, no row', async () => {
    const r = await makeReq();
    const e = await holdThenRace((tx) => exec(tx, submitSql(r.id)), insertDocSql(r.caseId, r.id));
    expect(asRule(e)).toEqual(rule('DOCUMENT_REQUIREMENT_STATE'));
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
    expect(await statusOf(r.id)).toBe('PENDING');
  });
  it('holds the submission back while a document INSERT is open; the submission then succeeds (the draft stays a draft: only a submit of the document puts it in the round)', async () => {
    const r = await makeReq();
    const e = await holdThenRace((tx) => exec(tx, insertDocSql(r.caseId, r.id)), submitSql(r.id));
    expect(e).toBeUndefined();
    expect(await count(DOC, 'case_requirement_id = $1 AND status = $2', [r.id, 'UPLOAD_PENDING'])).toBe(1);
    expect(await statusOf(r.id)).toBe('PENDING');
  });
  it('holds the ATTACH of an upload back while a submission of its requirement is open (DOCUMENT_REQUIREMENT_STATE), and the submission back while an ATTACH is open', async () => {
    const a = await makeReq();
    const draftA = await mkDoc(a.id);
    const e = await holdThenRace((tx) => exec(tx, submitSql(a.id)), attachSql(draftA));
    expect(asRule(e)).toEqual(rule('DOCUMENT_REQUIREMENT_STATE'));
    expect((await docRow<{ status: string }>(draftA)).status).toBe('UPLOAD_PENDING');
    const b = await makeReq();
    const draftB = await mkDoc(b.id);
    expect(await holdThenRace((tx) => exec(tx, attachSql(draftB)), submitSql(b.id))).toBeUndefined();
    expect(await statusOf(b.id)).toBe('PENDING');
    expect((await docRow<{ status: string }>(draftB)).status).toBe('ATTACHED');
  });
  it('holds the SUBMIT of an attached draft back while its requirement is being moved to review (DOCUMENT_ROUND), and the move back while the SUBMIT is open; the final states agree', async () => {
    const a = await makeDocIn('ATTACHED');
    const e = await holdThenRace((tx) => exec(tx, reqStatusSql(a.req.id, "status = 'IN_REVIEW'")), submitDocSql(a.id, 1));
    expect(asRule(e)).toEqual(rule('DOCUMENT_ROUND'));
    expect((await docRow<{ status: string }>(a.id)).status).toBe('ATTACHED');
    const b = await makeDocIn('ATTACHED');
    expect(await holdThenRace((tx) => exec(tx, submitDocSql(b.id, 1)), reqStatusSql(b.req.id, "status = 'IN_REVIEW'"))).toBeUndefined();
    expect(await statusOf(b.req.id)).toBe('IN_REVIEW');
    expect((await docRow<{ status: string }>(b.id)).status).toBe('SUBMITTED');
  });
  it('25 rounds each of a document INSERT and of an ATTACH against a submission at the same instant: the submission always succeeds, the document lands first or is refused DOCUMENT_REQUIREMENT_STATE; never a deadlock', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReq();
      const x = await both(insertDocSql(r.caseId, r.id), submitSql(r.id));
      x.forEach(notDeadlock);
      expect(x[1], `insert round ${round}`).toBeUndefined();
      if (x[0] !== undefined) expect(asRule(x[0]), `insert round ${round}`).toEqual(rule('DOCUMENT_REQUIREMENT_STATE'));
      const s = await makeReq();
      const draft = await mkDoc(s.id);
      const y = await both(attachSql(draft), submitSql(s.id));
      y.forEach(notDeadlock);
      expect(y[1], `attach round ${round}`).toBeUndefined();
      if (y[0] !== undefined) expect(asRule(y[0]), `attach round ${round}`).toEqual(rule('DOCUMENT_REQUIREMENT_STATE'));
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H6. a review against the move of its requirement, against the deactivation of its reason, and two reviewers against each other', () => {
  it('holds a start of review back while the requirement is being approved (REVIEW_STATE), and the approval back while a start is open; both orders end consistent', async () => {
    const a = await makeReqIn('IN_REVIEW');
    const e = await holdThenRace((tx) => exec(tx, reqStatusSql(a.id, "status = 'APPROVED'")), reviewSql(a.id, 'STARTED'));
    expect(asRule(e)).toEqual(rule('REVIEW_STATE'));
    expect(await reviewCount(a.id)).toBe(0);
    const b = await makeReqIn('IN_REVIEW');
    expect(await holdThenRace((tx) => exec(tx, reviewSql(b.id, 'STARTED')), reqStatusSql(b.id, "status = 'APPROVED'"))).toBeUndefined();
    expect(await reviewCount(b.id)).toBe(1);
    expect(await statusOf(b.id)).toBe('APPROVED');
  });
  it('holds a review with a reason back while the reason is being deactivated (REASON_INACTIVE), and the deactivation back while such a review is open', async () => {
    const code = await makeReason('BOTH');
    const a = await makeReqIn('PENDING');
    await setReq(a.id, "status = 'REJECTED'");
    const e = await holdThenRace((tx) => tx.query(`UPDATE ${REASON} SET status = 'INACTIVE' WHERE code = $1`, [code]), reviewSql(a.id, 'REJECTED', 1, code));
    expect(asRule(e)).toEqual(rule('REASON_INACTIVE'));
    const code2 = await makeReason('BOTH');
    const b = await makeReqIn('PENDING');
    await setReq(b.id, "status = 'REJECTED'");
    expect(
      await holdThenRace((tx) => exec(tx, reviewSql(b.id, 'REJECTED', 1, code2)), sqlOf(`UPDATE ${REASON} SET status = 'INACTIVE' WHERE code = $1`, code2)),
    ).toBeUndefined();
    expect(await reviewCount(b.id)).toBe(1);
  });
  it('holds an external reference back while the requirement is being approved (EXTERNAL_STATE), and the approval back while a reference INSERT is open', async () => {
    const a = await makeReqIn('PENDING', extDef);
    const e = await holdThenRace((tx) => exec(tx, reqStatusSql(a.id, `status = 'APPROVED', expires_at = ${HOUR}`)), extSql(a.id));
    expect(asRule(e)).toEqual(rule('EXTERNAL_STATE'));
    expect(await count(EXT, 'case_requirement_id = $1', [a.id])).toBe(0);
    const b = await makeReqIn('PENDING', extDef);
    expect(await holdThenRace((tx) => exec(tx, extSql(b.id)), reqStatusSql(b.id, `status = 'APPROVED', expires_at = ${HOUR}`))).toBeUndefined();
    expect(await count(EXT, 'case_requirement_id = $1', [b.id])).toBe(1);
  });
  it('30 rounds of two reviewers recording the SAME approval at the same instant: exactly one review lands, the other gets the unique violation of the decision key; never a deadlock', async () => {
    for (let round = 0; round < 30; round++) {
      const r = await makeReqIn('APPROVED');
      const x = await both(reviewSql(r.id, 'APPROVED'), reviewSql(r.id, 'APPROVED'));
      x.forEach(notDeadlock);
      expect(winners(x), `round ${round}`).toBe(1);
      const loser = x.find((e) => e !== undefined)!;
      expect({ code: loser.code, constraint: loser.constraint }, `round ${round}`).toEqual({ code: '23505', constraint: 'uq_reviews__decision' });
      expect(await reviewCount(r.id)).toBe(1);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('25 rounds of two reviewers DECIDING DIFFERENTLY (approve and reject) at the same instant, each in one transaction (move the requirement, record the review): one decision wins, the other is refused STATUS_TRANSITION, and the requirement and its single terminal review agree', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReqIn('IN_REVIEW');
      const approve: Racer = async (c) => {
        await exec(c, reqStatusSql(r.id, "status = 'APPROVED'"));
        await exec(c, reviewSql(r.id, 'APPROVED'));
      };
      const reject: Racer = async (c) => {
        await exec(c, reqStatusSql(r.id, "status = 'REJECTED'"));
        await exec(c, reviewSql(r.id, 'REJECTED', 1, 'DOCUMENT_UNREADABLE'));
      };
      const x = await both(approve, reject);
      x.forEach(notDeadlock);
      expect(winners(x), `round ${round}`).toBe(1);
      expect(asRule(x.find((e) => e !== undefined)), `round ${round}`).toEqual(rule('STATUS_TRANSITION'));
      const decisions = await q<{ decision: string }>(`SELECT decision FROM ${REV} WHERE case_requirement_id = $1`, [r.id]);
      expect(decisions).toHaveLength(1);
      expect(await statusOf(r.id)).toBe(decisions[0]!.decision);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H7. a re-verification and a resubmission against themselves', () => {
  it('20 rounds of two simultaneous "supersede the expired cycle and start the next" transactions: exactly one wins, the other is refused SUPERSEDED_FROZEN, and the case ends with cycles 1 (superseded) and 2', async () => {
    const reqs = await expiredReqs(20);
    for (const [round, r] of reqs.entries()) {
      const reverify: Racer = async (c) => {
        await supersedeReq(r.id, c);
        await addReq(r.caseId, docDef.id, c);
      };
      const x = await both(reverify, reverify);
      x.forEach(notDeadlock);
      expect(winners(x), `round ${round}`).toBe(1);
      expect(asRule(x.find((e) => e !== undefined)), `round ${round}`).toEqual(rule('SUPERSEDED_FROZEN'));
      expect(await q(`SELECT cycle, superseded_at IS NOT NULL AS superseded FROM ${CR} WHERE verification_case_id = $1 ORDER BY cycle`, [r.caseId])).toEqual([
        { cycle: 1, superseded: true },
        { cycle: 2, superseded: false },
      ]);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
  it('25 rounds of two simultaneous resubmissions of a rejected requirement: exactly one wins, round 2, and the other is refused FIELDS_FROZEN (it would be round 3 of a requirement that is already PENDING)', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReqIn('PENDING');
      await setReq(r.id, "status = 'REJECTED'");
      const x = await both(submitSql(r.id), submitSql(r.id));
      x.forEach(notDeadlock);
      expect(winners(x), `round ${round}`).toBe(1);
      expect(asRule(x.find((e) => e !== undefined)), `round ${round}`).toEqual(rule('FIELDS_FROZEN'));
      expect(await crRow(r.id)).toMatchObject({ status: 'PENDING', round: 2 });
    }
  });
  it('a case cancelled and a requirement started in the same instant: at most one side wins its row, no deadlock (25 rounds)', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReqIn('PENDING');
      const x = await both(cancelCaseSql(r.caseId), reqStatusSql(r.id, "status = 'IN_REVIEW'"));
      x.forEach(notDeadlock);
      expect(x[0], `round ${round}: the cancellation`).toBeUndefined();
      if (x[1] !== undefined) expect(asRule(x[1])).toEqual(rule('CASE_FROZEN'));
    }
  });
});

describe('H8. a mixed storm: eight different writers at the same instant on one requirement, its definition and its case, no deadlock and no invalid state', () => {
  it('20 rounds: start, approve, reject, ask for action, withdraw, cancel the case, deactivate the definition and add a document; any outcome but a deadlock, every invariant holds, and the requirement ends in a state the contract allows', async () => {
    for (let round = 0; round < 20; round++) {
      const d = await makeDef({ status: 'ACTIVE' });
      const r = await makeReqIn('PENDING', d);
      const writers: RaceSql[] = [
        reqStatusSql(r.id, "status = 'IN_REVIEW'"),
        reqStatusSql(r.id, "status = 'APPROVED', expires_at = now() + interval '1 hour'"),
        reqStatusSql(r.id, "status = 'REJECTED'"),
        reqStatusSql(r.id, "status = 'ACTION_REQUIRED'"),
        reqStatusSql(r.id, "status = 'NOT_REQUIRED'"),
        cancelCaseSql(r.caseId),
        defStatusSql(d.id, 'INACTIVE'),
        insertDocSql(r.caseId, r.id),
      ];
      const results = (await Promise.all(writers.map((w) => rejection(runRacer(racePool, w))))) as (PgFailure | undefined)[];
      results.forEach(notDeadlock);
      for (const e of results) if (e) expect(e.code, `${round}: ${e.message}`).toBe('23000');
      expect(winners(results), `round ${round}`).toBeGreaterThanOrEqual(2);
      const final = await statusOf(r.id);
      expect(['IN_REVIEW', 'APPROVED', 'REJECTED', 'ACTION_REQUIRED', 'NOT_REQUIRED'], `round ${round}`).toContain(final);
      // the moves that succeeded form a path the contract allows from PENDING (the row lock serializes them), whatever their order
      expect(isTrustRequirementTransitionAllowed('PENDING', final as TrustRequirementStatus) || final === 'PENDING', `round ${round}`).toBe(true);
    }
    expect(await violations()).toEqual(NO_VIOLATIONS);
  });
});

describe('H9. a document against the deactivation of its document type, and a review or external reference against the cancellation of the case (the parents are read FOR SHARE)', () => {
  const insertDocWithType = (caseId: string, reqId: string, typeId: string): RaceSql => {
    const id = randomUUID();
    return sqlOf(
      `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, $4, 'application/pdf', 1, now() + interval '15 minutes')`,
      id,
      reqId,
      typeId,
      `trust/evidence/${caseId}/${id}`,
    );
  };
  const typeStatusSql = (typeId: string, status: string): RaceSql => sqlOf(`UPDATE ${DTYPE} SET status = $2 WHERE document_type_id = $1`, typeId, status);
  it('holds a document INSERT back while its document type is being deactivated (DOCUMENT_TYPE_MISMATCH, no row), and the deactivation back while a document INSERT is open', async () => {
    const r = await makeReq();
    const t = await makeDocType('IDENTITY');
    const e = await holdThenRace((tx) => exec(tx, typeStatusSql(t, 'INACTIVE')), insertDocWithType(r.caseId, r.id, t));
    expect(asRule(e)).toEqual(rule('DOCUMENT_TYPE_MISMATCH'));
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(0);
    const t2 = await makeDocType('IDENTITY');
    expect(await holdThenRace((tx) => exec(tx, insertDocWithType(r.caseId, r.id, t2)), typeStatusSql(t2, 'INACTIVE'))).toBeUndefined();
    expect(await count(DOC, 'case_requirement_id = $1', [r.id])).toBe(1);
    expect((await q<{ status: string }>(`SELECT status FROM ${DTYPE} WHERE document_type_id = $1`, [t2]))[0]!.status).toBe('INACTIVE');
  });
  it('25 rounds of a document INSERT against the deactivation of its type at the same instant: the deactivation always succeeds, the INSERT lands first or is refused DOCUMENT_TYPE_MISMATCH; never a deadlock', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReq();
      const t = await makeDocType('IDENTITY');
      const x = await both(insertDocWithType(r.caseId, r.id, t), typeStatusSql(t, 'INACTIVE'));
      x.forEach(notDeadlock);
      expect(x[1], `round ${round}`).toBeUndefined();
      if (x[0] !== undefined) expect(asRule(x[0]), `round ${round}`).toEqual(rule('DOCUMENT_TYPE_MISMATCH'));
    }
  });
  it('holds a REVIEW back while the case is being cancelled (CASE_FROZEN, no row), and the cancellation back while a review INSERT is open', async () => {
    const a = await makeReqIn('IN_REVIEW');
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(a.caseId)), reviewSql(a.id, 'STARTED'));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    expect(await reviewCount(a.id)).toBe(0);
    const b = await makeReqIn('IN_REVIEW');
    expect(await holdThenRace((tx) => exec(tx, reviewSql(b.id, 'STARTED')), cancelCaseSql(b.caseId))).toBeUndefined();
    expect(await reviewCount(b.id)).toBe(1);
    expect((await caseRow<{ status: string }>(b.caseId)).status).toBe('CANCELLED');
  });
  it('holds an external reference back while the case is being cancelled (CASE_FROZEN, no row), and the cancellation back while a reference INSERT is open', async () => {
    const a = await makeReqIn('PENDING', extDef);
    const e = await holdThenRace((tx) => exec(tx, cancelCaseSql(a.caseId)), extSql(a.id));
    expect(asRule(e)).toEqual(rule('CASE_FROZEN'));
    expect(await count(EXT, 'case_requirement_id = $1', [a.id])).toBe(0);
    const b = await makeReqIn('PENDING', extDef);
    expect(await holdThenRace((tx) => exec(tx, extSql(b.id)), cancelCaseSql(b.caseId))).toBeUndefined();
    expect(await count(EXT, 'case_requirement_id = $1', [b.id])).toBe(1);
  });
  it('25 rounds of a review against a cancellation at the same instant: the cancellation always succeeds, the review lands first or is refused CASE_FROZEN; never a deadlock', async () => {
    for (let round = 0; round < 25; round++) {
      const r = await makeReqIn('IN_REVIEW');
      const x = await both(reviewSql(r.id, 'STARTED'), cancelCaseSql(r.caseId));
      x.forEach(notDeadlock);
      expect(x[1], `round ${round}`).toBeUndefined();
      if (x[0] !== undefined) expect(asRule(x[0]), `round ${round}`).toEqual(rule('CASE_FROZEN'));
    }
  });
});

// ====================================================================== I. the access paths
async function planOf(text: string, params: unknown[], settings: string[], analyze = false): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of settings) await c.query(s);
    return (await c.query(`EXPLAIN (${analyze ? 'ANALYZE, TIMING OFF, SUMMARY OFF, ' : ''}COSTS OFF) ${text}`, params)).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
describe('I. the access path: the live case, the latest case, the review queues, the current requirements, the expiry sweep, the documents and the reviews of a requirement read their keys, and no index is missing or extra', () => {
  let s: {
    liveAccount: string; // an account with one live OPEN case
    historyAccount: string; // an account with a cancelled case 1 and a live case 2
    liveCase: string;
    historyCase: string;
    req: string; // a requirement with documents and reviews
    docKey: string;
    ext: { adapter: string; externalId: string };
  };
  beforeAll(async () => {
    const accounts = await inTx(async (c) => {
      const r = await c.query(
        `WITH a AS (INSERT INTO identity.accounts (status) SELECT 'ACTIVE' FROM generate_series(1, 300) RETURNING account_id),
              h AS (INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) SELECT account_id, NULL, 'ACTIVE', NULL, 'test', 'c' FROM a)
         SELECT array_agg(account_id) AS ids FROM a`,
      );
      return (r.rows[0] as { ids: string[] }).ids;
    });
    const [review, open, history] = [accounts.slice(0, 100), accounts.slice(100, 200), accounts.slice(200)];
    await run(`INSERT INTO ${CASES} (account_id, case_number) SELECT x, 1 FROM unnest($1::uuid[]) AS x`, [accounts]);
    await run(`UPDATE ${CASES} SET status = 'CANCELLED' WHERE account_id = ANY($1)`, [history]);
    await run(`INSERT INTO ${CASES} (account_id, case_number) SELECT x, 2 FROM unnest($1::uuid[]) AS x`, [history]);
    const live = `SELECT verification_case_id FROM ${CASES} WHERE account_id = ANY($1) AND status <> 'CANCELLED'`;
    for (const d of [docDef.id, expDef.id])
      await run(
        `INSERT INTO ${CR} (verification_case_id, requirement_definition_id) SELECT verification_case_id, '${d}' FROM ${CASES} WHERE account_id = ANY($1) AND status <> 'CANCELLED'`,
        [accounts],
      );
    // three documents of the identity requirement of every case in review, attached and then submitted with the requirement (round 1)
    await run(
      `INSERT INTO ${DOC} (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at)
       SELECT d.id, r.case_requirement_id, (SELECT document_type_id FROM ${DTYPE} WHERE code = 'drivers_license'), 'trust/evidence/' || r.verification_case_id || '/' || d.id, 'application/pdf', 1000, now() + interval '15 minutes'
         FROM ${CR} r CROSS JOIN LATERAL (SELECT md5(r.case_requirement_id::text || g.n::text)::uuid AS id FROM generate_series(1, 3) g(n)) d
        WHERE r.requirement_definition_id = '${docDef.id}' AND r.verification_case_id IN (${live})`,
      [review],
    );
    await run(
      `UPDATE ${DOC} SET status = 'ATTACHED', sha256 = '${SHA}', scan_status = 'CLEAN' WHERE case_requirement_id IN (SELECT case_requirement_id FROM ${CR} WHERE verification_case_id IN (${live}))`,
      [review],
    );
    await run(`UPDATE ${CR} SET status = 'PENDING', round = round + 1 WHERE verification_case_id IN (${live})`, [review]);
    await run(
      `UPDATE ${DOC} SET status = 'SUBMITTED', round = 1 WHERE case_requirement_id IN (SELECT case_requirement_id FROM ${CR} WHERE verification_case_id IN (${live}))`,
      [review],
    );
    await run(`UPDATE ${CR} SET status = 'IN_REVIEW' WHERE requirement_definition_id = '${docDef.id}' AND verification_case_id IN (${live})`, [review]);
    await run(
      `INSERT INTO ${REV} (case_requirement_id, round, decision, reviewer, correlation_id) SELECT case_requirement_id, 1, 'STARTED', 'admin:seed', 'seed' FROM ${CR} WHERE status = 'IN_REVIEW' AND verification_case_id IN (${live})`,
      [review],
    );
    await run(`UPDATE ${CASES} SET status = 'IN_REVIEW' WHERE account_id = ANY($1) AND status = 'OPEN'`, [review]);
    // the licence requirement of the accounts with a history is approved, each ending at another hour
    await run(`UPDATE ${CR} SET status = 'PENDING', round = round + 1 WHERE requirement_definition_id = '${expDef.id}' AND verification_case_id IN (${live})`, [
      history,
    ]);
    await run(
      `UPDATE ${CR} r SET status = 'APPROVED', expires_at = now() + (n.n || ' hours')::interval FROM (SELECT case_requirement_id, row_number() OVER () AS n FROM ${CR} WHERE status = 'PENDING' AND requirement_definition_id = '${expDef.id}') n WHERE r.case_requirement_id = n.case_requirement_id`,
    );
    await run(`UPDATE ${CASES} SET status = 'APPROVED' WHERE account_id = ANY($1) AND status = 'OPEN'`, [history]);
    for (const t of TABLES) await run(`ANALYZE ${t}`);
    const hist = (
      await q<{ verification_case_id: string }>(`SELECT verification_case_id FROM ${CASES} WHERE account_id = $1 AND case_number = 2`, [history[0]])
    )[0]!;
    const liveC = (await q<{ verification_case_id: string }>(`SELECT verification_case_id FROM ${CASES} WHERE account_id = $1`, [open[0]]))[0]!;
    const req = (
      await q<{ id: string }>(
        `SELECT case_requirement_id AS id FROM ${CR} WHERE status = 'IN_REVIEW' AND requirement_definition_id = '${docDef.id}' AND verification_case_id IN (${live}) LIMIT 1`,
        [review],
      )
    )[0]!.id;
    const extReq = await makeReqIn('PENDING', extDef);
    await extRef(extReq.id, { adapter: 'fake', externalId: 'plan-1' });
    s = {
      liveAccount: open[0]!,
      historyAccount: history[0]!,
      liveCase: liveC.verification_case_id,
      historyCase: hist.verification_case_id,
      req,
      docKey: (await q<{ object_key: string }>(`SELECT object_key FROM ${DOC} WHERE case_requirement_id = $1 LIMIT 1`, [req]))[0]!.object_key,
      ext: { adapter: 'fake', externalId: 'plan-1' },
    };
    expect(await count(CASES, 'account_id = ANY($1)', [accounts])).toBe(400);
    expect(await count(DOC, 'case_requirement_id = $1', [req])).toBe(3);
    expect(await count(CASES, "status = 'IN_REVIEW'")).toBeGreaterThanOrEqual(100);
  });
  // sequential and bitmap scans are switched off so that the question is asked of the INDEXES: an ordered read must come out of the index order, without a sort step
  const SEQ_OFF = ['SET LOCAL enable_seqscan = off', 'SET LOCAL enable_bitmapscan = off'];
  const usedIndexes = (plan: string): string[] =>
    [...new Set([...plan.matchAll(/(?:Scan(?: Backward)? using|Bitmap Index Scan on) (\w+)/g)].map((m) => m[1]!))].sort();
  const ALLOWED = new Set(Object.values(INDEX_DEFS).flatMap((d) => Object.keys(d)));

  it('reads the LIVE case of an account (account_id and status <> CANCELLED) through the partial unique key alone: one index probe, no filter, no sort', async () => {
    const sql = `SELECT verification_case_id, status, revision FROM ${CASES} WHERE account_id = $1 AND status <> 'CANCELLED'`;
    const plan = await planOf(sql, [s.liveAccount], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['uq_verification_cases__live']);
    expect(plan).not.toMatch(/Filter:|Sort|Seq Scan/);
    expect(await planOf(sql, [s.liveAccount], SEQ_OFF, true)).toMatch(/actual rows=1 loops=1/);
    expect(await q(sql, [s.liveAccount])).toHaveLength(1);
    expect(await q(sql, [s.historyAccount])).toHaveLength(1); // the account with a cancelled case 1 has exactly its case 2
  });
  it('reads the LATEST case number of an account backwards from the number key with no sort step, and the highest number (the question the open guard asks) from the same key', async () => {
    const latest = `SELECT verification_case_id, case_number, status FROM ${CASES} WHERE account_id = $1 ORDER BY case_number DESC LIMIT 1`;
    const plan = await planOf(latest, [s.historyAccount], SEQ_OFF);
    expect(plan).toMatch(/Index Scan Backward using uq_verification_cases__number on verification_cases/);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await q(latest, [s.historyAccount])).toEqual([expect.objectContaining({ case_number: 2 })]);
    const maxPlan = await planOf(`SELECT COALESCE(max(case_number), 0) FROM ${CASES} WHERE account_id = $1`, [s.historyAccount], SEQ_OFF);
    expect(usedIndexes(maxPlan)).toEqual(['uq_verification_cases__number']);
    expect(maxPlan).not.toMatch(/Seq Scan/);
  });
  it("reads the reviewers' CASE QUEUE (IN_REVIEW, oldest submission first) from the partial queue index in order, with no sort", async () => {
    const sql = `SELECT verification_case_id, submitted_at FROM ${CASES} WHERE status = 'IN_REVIEW' ORDER BY submitted_at, verification_case_id LIMIT 20`;
    const plan = await planOf(sql, [], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['idx_verification_cases__queue']);
    expect(plan).not.toMatch(/Sort|Seq Scan|Filter:/);
    expect(await planOf(sql, [], SEQ_OFF, true)).toMatch(/actual rows=20 loops=1/);
  });
  it('reads the CURRENT requirements of a case (superseded_at IS NULL) through a partial key of the instances: no sequential scan, no sort, both requirements of the case', async () => {
    const sql = `SELECT case_requirement_id, requirement_definition_id, status FROM ${CR} WHERE verification_case_id = $1 AND superseded_at IS NULL`;
    const plan = await planOf(sql, [s.liveCase], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['uq_case_requirements__current']);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await planOf(sql, [s.liveCase], SEQ_OFF, true)).toMatch(/actual rows=2 loops=1/);
  });
  it('reads one requirement of a case by definition (current instance), and the highest cycle of it (the question the cycle guard asks) from the cycle key', async () => {
    const one = `SELECT * FROM ${CR} WHERE verification_case_id = $1 AND requirement_definition_id = $2 AND superseded_at IS NULL`;
    expect(usedIndexes(await planOf(one, [s.liveCase, docDef.id], SEQ_OFF))).toEqual(['uq_case_requirements__current']);
    const max = await planOf(
      `SELECT COALESCE(max(cycle), 0) FROM ${CR} WHERE verification_case_id = $1 AND requirement_definition_id = $2`,
      [s.liveCase, docDef.id],
      SEQ_OFF,
    );
    expect(usedIndexes(max)).toEqual(['uq_case_requirements__cycle']);
    expect(max).not.toMatch(/Seq Scan/);
    expect(usedIndexes(await planOf(`SELECT * FROM ${CR} WHERE case_requirement_id = $1 FOR SHARE`, [s.req], SEQ_OFF))).toEqual(['pk_case_requirements']);
  });
  it('reads the REQUIREMENT QUEUE (PENDING or IN_REVIEW, current, oldest update first) from its partial index in order, with no sort', async () => {
    const sql = `SELECT case_requirement_id, updated_at FROM ${CR} WHERE status IN ('PENDING', 'IN_REVIEW') AND superseded_at IS NULL ORDER BY updated_at, case_requirement_id LIMIT 20`;
    const plan = await planOf(sql, [], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['idx_case_requirements__queue']);
    expect(plan).not.toMatch(/Sort|Seq Scan|Filter:/);
    expect(await planOf(sql, [], SEQ_OFF, true)).toMatch(/actual rows=20 loops=1/);
  });
  it('reads the EXPIRY SWEEP (approved, with an end, current, due first) from its partial index in order, with no sort; the rows it finds are the due ones', async () => {
    const sql = `SELECT case_requirement_id, expires_at FROM ${CR} WHERE status = 'APPROVED' AND expires_at IS NOT NULL AND superseded_at IS NULL AND expires_at <= $1 ORDER BY expires_at, case_requirement_id LIMIT 100`;
    const horizon = new Date(Date.now() + 40 * 3600 * 1000);
    const plan = await planOf(sql, [horizon], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['idx_case_requirements__expiry']);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    const rows = await q<{ expires_at: Date }>(sql, [horizon]);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r, i) => i === 0 || r.expires_at >= rows[i - 1]!.expires_at)).toBe(true);
    expect(rows.every((r) => r.expires_at <= horizon)).toBe(true);
  });
  it('reads the documents of a requirement in upload order from the requirement index (no sort), a document by its object key from the unique key, and the primary key for the guard lookups', async () => {
    const docs = `SELECT verification_document_id, status FROM ${DOC} WHERE case_requirement_id = $1 ORDER BY created_at`;
    const plan = await planOf(docs, [s.req], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['idx_documents__requirement']);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await planOf(docs, [s.req], SEQ_OFF, true)).toMatch(/actual rows=3 loops=1/);
    expect(usedIndexes(await planOf(`SELECT * FROM ${DOC} WHERE object_key = $1`, [s.docKey], SEQ_OFF))).toEqual(['uq_documents__object_key']);
    expect(usedIndexes(await planOf(`SELECT * FROM ${DOC} WHERE verification_document_id = $1`, [randomUUID()], SEQ_OFF))).toEqual(['pk_documents']);
  });
  it('reads ALL the reviews of a requirement in review order from the requirement index (no sort), and the decision of one round from the partial decision key', async () => {
    const all = `SELECT review_id, decision, round FROM ${REV} WHERE case_requirement_id = $1 ORDER BY reviewed_at`;
    const plan = await planOf(all, [s.req], SEQ_OFF);
    expect(usedIndexes(plan)).toEqual(['idx_reviews__requirement']);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
    expect(await q(all, [s.req])).toHaveLength(1);
    const decision = `SELECT review_id FROM ${REV} WHERE case_requirement_id = $1 AND round = $2 AND decision <> 'STARTED'`;
    expect(usedIndexes(await planOf(decision, [s.req, 1], SEQ_OFF))).toEqual(['uq_reviews__decision']);
    const started = `SELECT review_id FROM ${REV} WHERE case_requirement_id = $1 AND round = $2 AND decision = 'STARTED'`;
    expect(usedIndexes(await planOf(started, [s.req, 1], SEQ_OFF))).toEqual(['uq_reviews__started']);
  });
  it('reads an external reference by adapter and external id, and by requirement and round, from the unique keys; the rules of a definition and a definition by code from theirs', async () => {
    expect(usedIndexes(await planOf(`SELECT * FROM ${EXT} WHERE adapter = $1 AND external_id = $2`, [s.ext.adapter, s.ext.externalId], SEQ_OFF))).toEqual([
      'uq_external_verifications__external',
    ]);
    expect(usedIndexes(await planOf(`SELECT * FROM ${EXT} WHERE case_requirement_id = $1 AND round = 1`, [s.req], SEQ_OFF))).toEqual([
      'uq_external_verifications__round',
    ]);
    expect(usedIndexes(await planOf(`SELECT * FROM ${RULE} WHERE requirement_definition_id = $1`, [identityDef], SEQ_OFF))).toEqual([
      'uq_requirement_rules__scope',
    ]);
    expect(usedIndexes(await planOf(`SELECT * FROM ${DEF} WHERE code = $1`, ['identity_verification'], SEQ_OFF))).toEqual(['uq_requirement_definitions__code']);
    expect(usedIndexes(await planOf(`SELECT * FROM ${REASON} WHERE code = $1 FOR SHARE`, ['NAME_MISMATCH'], SEQ_OFF))).toEqual(['uq_reason_codes__code']);
    expect(usedIndexes(await planOf(`SELECT * FROM ${DTYPE} WHERE code = $1`, ['passport'], SEQ_OFF))).toEqual(['uq_document_types__code']);
  });
  it('has no index for the audit trail (it is written once and read only for investigation): every audit lookup scans the table, and that is the documented choice', async () => {
    expect(await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'trust' AND tablename = 'audit_events'")).toEqual([{ indexname: 'pk_audit_events' }]);
    expect(usedIndexes(await planOf(`SELECT * FROM ${AUDIT} WHERE verification_case_id = $1`, [s.liveCase], SEQ_OFF))).toEqual([]);
  });
  it('uses no index outside the 28 of the schema in any of these plans, and returns the same rows whatever the plan (sequential scans allowed or not)', async () => {
    const statements: [string, unknown[]][] = [
      [`SELECT * FROM ${CASES} WHERE account_id = $1 AND status <> 'CANCELLED'`, [s.liveAccount]],
      [`SELECT * FROM ${CASES} WHERE account_id = $1 ORDER BY case_number DESC LIMIT 1`, [s.historyAccount]],
      [`SELECT * FROM ${CR} WHERE verification_case_id = $1 AND superseded_at IS NULL ORDER BY requirement_definition_id`, [s.liveCase]],
      [`SELECT * FROM ${DOC} WHERE case_requirement_id = $1 ORDER BY created_at, verification_document_id`, [s.req]],
      [`SELECT * FROM ${REV} WHERE case_requirement_id = $1 ORDER BY reviewed_at`, [s.req]],
    ];
    for (const [sql, params] of statements) {
      const plan = await planOf(sql, params, SEQ_OFF);
      for (const idx of usedIndexes(plan)) expect(ALLOWED.has(idx), `${idx} in ${sql}`).toBe(true);
      const withIndex = await q(sql, params);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const st of ['enable_indexscan', 'enable_bitmapscan', 'enable_indexonlyscan']) await c.query(`SET LOCAL ${st} = off`);
        expect((await c.query(sql, params)).rows, sql).toEqual(withIndex);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });
});

// ====================================================================== J. no personal data, no duplicated state
describe('J. the trust tables cannot hold, and do not hold, anything about a person, a contact, an address, a name, a free-text note or a document body', () => {
  const FORBIDDEN_WORDS = new Set(
    'email mail phone mobile tel name address street city postal zip token secret password credential birth ssn note notes comment comments body text title description payload person user member profile locale language lat lng lon geo point ip device cookie session subscription plan payment credit invoice price fee cost amount currency tax label message content_text file filename'.split(
      ' ',
    ),
  );
  const forbidden = (column: string): boolean => column.split('_').some((w) => FORBIDDEN_WORDS.has(w));
  /** The one column name that contains the word `name`: a foreign key to a content entry, never a person's name. */
  const CONTENT_KEY_COLUMNS = ['name_content_key', 'instructions_content_key'];
  const WORDS = [
    'account',
    'action',
    'actor',
    'adapter',
    'applies',
    'approved',
    'at',
    'audit',
    'bytes',
    'cancelled',
    'case',
    'changes',
    'checked',
    'code',
    'content',
    'correlation',
    'created',
    'cycle',
    'decided',
    'decision',
    'definition',
    'document',
    'enabled',
    'event',
    'evidence',
    'expires',
    'expiry',
    'external',
    'finalized',
    'id',
    'instructions',
    'key',
    'kind',
    'last',
    'market',
    'mime',
    'name',
    'number',
    'object',
    'occurred',
    'reason',
    'required',
    'requirement',
    'review',
    'reviewed',
    'reviewer',
    'revision',
    'round',
    'rule',
    'scan',
    'scanned',
    'service',
    'sha256',
    'size',
    'status',
    'submitted',
    'superseded',
    'to',
    'type',
    'updated',
    'upload',
    'verification',
    'withdrawn',
  ];

  it('has no column named after a person, a contact, an address, a token, a note, a free text or a price: every word of every column name belongs to the verification vocabulary (the content-key columns are keys, not names)', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'trust' ORDER BY 1, ordinal_position",
    );
    expect(rows).toHaveLength(101);
    const named = rows.filter((r) => !CONTENT_KEY_COLUMNS.includes(r.column_name));
    expect(named.filter((r) => forbidden(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
    expect(rows.filter((r) => CONTENT_KEY_COLUMNS.includes(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'document_types.name_content_key',
      'reason_codes.name_content_key',
      'requirement_definitions.name_content_key',
      'requirement_definitions.instructions_content_key',
    ]);
    expect([...new Set(rows.flatMap((r) => r.column_name.split('_')))].sort(byName)).toEqual([...WORDS].sort(byName));
    // the account is referenced by id only: the one column that names an account is the uuid foreign key of the case
    expect(rows.filter((r) => r.column_name.split('_').includes('account')).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`)).toEqual([
      'verification_cases.account_id:uuid',
    ]);
    expect([...new Set(rows.map((r) => r.data_type))].sort()).toEqual(['bigint', 'boolean', 'integer', 'jsonb', 'text', 'timestamp with time zone', 'uuid']);
  });
  it('limits the text columns to the 32 documented ones: statuses, codes, content keys, the object key, the content type, the hash, the actor, the reviewer, the adapter, the external id and the correlation id; jsonb is the audit diff and nothing else', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'trust'",
    );
    expect(
      rows
        .filter((r) => r.data_type === 'text')
        .map((r) => `${r.table_name}.${r.column_name}`)
        .sort(byName),
    ).toEqual(
      [
        'audit_events.actor',
        'audit_events.action',
        'audit_events.reason_code',
        'audit_events.correlation_id',
        'case_requirements.status',
        'document_types.code',
        'document_types.requirement_type',
        'document_types.status',
        'document_types.name_content_key',
        'documents.object_key',
        'documents.mime_type',
        'documents.sha256',
        'documents.status',
        'documents.scan_status',
        'external_verifications.adapter',
        'external_verifications.external_id',
        'external_verifications.status',
        'reason_codes.code',
        'reason_codes.applies_to',
        'reason_codes.status',
        'reason_codes.name_content_key',
        'requirement_definitions.code',
        'requirement_definitions.requirement_type',
        'requirement_definitions.evidence_kind',
        'requirement_definitions.status',
        'requirement_definitions.name_content_key',
        'requirement_definitions.instructions_content_key',
        'reviews.decision',
        'reviews.reason_code',
        'reviews.reviewer',
        'reviews.correlation_id',
        'verification_cases.status',
      ].sort(byName),
    );
    expect(rows.filter((r) => r.data_type === 'jsonb').map((r) => `${r.table_name}.${r.column_name}`)).toEqual(['audit_events.changes']);
    expect(rows.filter((r) => r.data_type === 'bytea')).toEqual([]); // no document bytes in PostgreSQL
  });
  it('applies its own forbidden-word filter by whole words (a check that is not vacuous: first_name, contact_email, note, payload_json, phone_number, street_address and a document body would be caught; correlation_id and reason_code would not)', () => {
    expect(
      ['first_name', 'contact_email', 'review_note', 'payload_json', 'phone_number', 'street_address', 'document_body', 'free_text', 'unit_price'].filter(
        forbidden,
      ),
    ).toHaveLength(9);
    expect(
      ['correlation_id', 'reason_code', 'object_key', 'size_bytes', 'sha256', 'case_number', 'external_id', 'reviewer', 'changes'].filter(forbidden),
    ).toEqual([]);
  });
  it("stores no duplicate of state owned elsewhere: no column repeats the account status, an email, a phone, a market code, a service type code or a registration status (only ids, and the verification domain's own lifecycle)", async () => {
    const cols = (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trust'")).map(
      (r) => r.column_name,
    );
    for (const dup of [
      'account_status',
      'role_status',
      'email_verified',
      'phone_verified',
      'consent_status',
      'market_code',
      'service_type_code',
      'registration_status',
      'verified_at',
      'verified',
      'is_verified',
      'live',
      'go_live',
      'eligible',
      'locale',
      'currency',
    ])
      expect(cols, dup).not.toContain(dup);
    expect(cols.filter((c) => /code$/.test(c)).sort()).toEqual(['code', 'code', 'code', 'reason_code', 'reason_code']); // definition, document type and reason code identities, and the reason of a review and of an audit event
  });
  it('has no verified flag anywhere (verification is multi-dimensional and the overall state is derived) and no go-live column: "approved" is a status of a requirement, never a column of an account', async () => {
    expect(
      await q(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'trust' AND column_name ~ '(^|_)(verified|is_verified|live|golive|eligible|bookable)($|_)'",
      ),
    ).toEqual([]);
    expect(
      await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'accounts' AND column_name ~ 'verif'"),
    ).toEqual([]);
  });
  it('lets the object key carry only two identifiers: the pattern admits trust/evidence/<case>/<document> and nothing in it can be a name, an account or a file name (a key built from a person is refused by the CHECK)', async () => {
    const key = (await q<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_documents__object_key'`))[0]!.def;
    expect(key).toContain('^trust/evidence/[0-9a-f-]{36}/[0-9a-f-]{36}$');
    const r = await makeReq();
    for (const bad of [`trust/evidence/${r.account}/passport.pdf`, `trust/evidence/jane-doe/${randomUUID()}`, `trust/evidence/${r.caseId}/${randomUUID()}.pdf`])
      await expectConstraint(
        isolated(
          noTriggers(DOC),
          `INSERT INTO ${DOC} (case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, (SELECT document_type_id FROM ${DTYPE} LIMIT 1), $2, 'a/b', 1, now())`,
          [r.id, bad],
        ),
        'ck_documents__object_key',
      );
  });
  it('writes nothing outside its own tables and reads only what it protects: the guards SELECT from identity.accounts and the trust tables (the parents FOR SHARE), and never INSERT, UPDATE, DELETE, notify, touch the outbox or the audit trail; no business value is hardcoded', async () => {
    const src = Object.fromEntries(
      (await q<{ proname: string; prosrc: string }>("SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'trust'::regnamespace")).map((r) => [
        r.proname,
        r.prosrc,
      ]),
    );
    const FROM: Record<string, string[]> = {
      forbid_mutation: [],
      guard_requirement_definitions: [],
      guard_document_types: [],
      guard_reason_codes: [],
      guard_requirement_rules: ['trust.requirement_definitions'],
      guard_verification_cases: ['identity.accounts', 'trust.verification_cases'],
      guard_case_requirements: ['trust.case_requirements', 'trust.requirement_definitions', 'trust.verification_cases'],
      guard_documents: ['trust.case_requirements', 'trust.document_types', 'trust.requirement_definitions', 'trust.verification_cases'],
      guard_reviews: ['trust.case_requirements', 'trust.reason_codes', 'trust.verification_cases'],
      guard_external_verifications: ['trust.case_requirements', 'trust.requirement_definitions', 'trust.verification_cases'],
    };
    expect(Object.keys(src).sort(byName)).toEqual(Object.keys(FROM).sort(byName));
    for (const [fn, text] of Object.entries(src)) {
      expect(text, fn).not.toMatch(
        /INSERT\s+INTO|UPDATE\s+[a-z]|DELETE\s+FROM|pg_notify|NOTIFY|outbox|audit_events|TRUNCATE\s+[a-z]|EXECUTE\s|dblink|set_config/i,
      );
      expect(
        [...new Set([...text.matchAll(/\b(?:FROM|JOIN)\s+((?:identity|trust|geography|catalog|content|configuration)\.\w+)/gi)].map((m) => m[1]))].sort(),
        fn,
      ).toEqual(FROM[fn]!.sort());
      // the only numbers are 0 and 1 (the first cycle, case number and revision, the zero of an empty history)
      expect(
        [...text.matchAll(/(?<![\w'.])\d+(?![\w'])/g)].map((m) => m[0]).filter((n) => n !== '0' && n !== '1'),
        fn,
      ).toEqual([]);
    }
    // every parent the guards read is read FOR SHARE, so a concurrent change of the parent waits for the child write (tested in H)
    expect(src.guard_verification_cases!).toMatch(/FROM identity\.accounts WHERE account_id = NEW\.account_id FOR SHARE/);
    expect(src.guard_requirement_rules!).toMatch(
      /FROM trust\.requirement_definitions WHERE requirement_definition_id = NEW\.requirement_definition_id FOR SHARE/,
    );
    expect((src.guard_case_requirements!.match(/FOR SHARE/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((src.guard_documents!.match(/FOR SHARE OF cr, c/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src.guard_reviews!).toMatch(/JOIN trust\.verification_cases c ON[^;]*WHERE cr\.case_requirement_id = NEW\.case_requirement_id FOR SHARE OF cr, c;/);
    expect(src.guard_documents!).toMatch(/FROM trust\.document_types WHERE document_type_id = NEW\.document_type_id FOR SHARE;/);
    expect(src.guard_reviews!).toMatch(/FROM trust\.reason_codes WHERE code = NEW\.reason_code FOR SHARE/);
    expect(src.guard_external_verifications!).toMatch(/FOR SHARE OF cr, c;/);
  });
  it("leaves the audit trail and the outbox exactly as they were when the tables are changed by raw SQL (the audit rows and events are the service's job, in its own transaction)", async () => {
    const snap = async () => ({
      audit: await count(AUDIT),
      outbox: await count('integration.outbox_events'),
      accountAudit: await count('identity.account_audit_events'),
    });
    const before = await snap();
    const r = await makeReqIn('PENDING');
    const id = await mkDoc((await makeReq()).id);
    await attachDoc(id);
    await setReq(r.id, "status = 'REJECTED'");
    await review(r.id, 'REJECTED', { round: 1, reason: 'DOCUMENT_UNREADABLE' });
    expect(await snap()).toEqual(before);
  });
  it('holds no case, requirement, document, review, external reference or audit row in a freshly migrated database and creates no account or role', async () => {
    for (const t of [CASES, CR, DOC, REV, EXT, AUDIT]) expect(await count(t, 'true', [], seedPool), t).toBe(0);
    expect(await count('identity.accounts', 'true', [], seedPool)).toBe(await count('identity.accounts', 'true', [], basePool));
    expect(await count('identity.account_roles', 'true', [], seedPool)).toBe(await count('identity.account_roles', 'true', [], basePool));
  });
});

describe('Z. final state of the mutated database', () => {
  it('holds every invariant after all of the above, leaves no session waiting on a lock and no transaction open', async () => {
    expect(await violations()).toEqual(NO_VIOLATIONS);
    await noLockWaiters();
    await noLockWaiters(racePool);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
      ),
    ).toEqual([{ n: 0 }]);
    // the same guards still answer on the database all of this ran against
    const { caseId } = await makeCase('CANCELLED');
    await expectRule(run(`UPDATE ${CASES} SET revision = revision + 1 WHERE verification_case_id = $1`, [caseId]), 'CASE_FROZEN');
    // and the seeded reference data is still the seed (nothing above changed an identity, a code or a seeded rule)
    expect(
      await q<{ code: string }>(
        `SELECT code FROM ${DEF} WHERE code IN ('identity_verification', 'background_check', 'professional_license', 'liability_insurance') ORDER BY 1`,
      ),
    ).toHaveLength(4);
    expect(await count(RULE, 'requirement_definition_id = $1 AND market_id IS NULL AND service_type_id IS NULL AND enabled', [identityDef])).toBe(1);
  });
});
