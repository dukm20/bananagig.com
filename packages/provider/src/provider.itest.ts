// Integration tests of ProviderRegistrationService (PRO-001) over a real, freshly migrated PostgreSQL database (migration 0018 with its guard triggers and seeds).
//
// Written by an author who did not write the service. Everything is asserted against the rows the database holds (registrations, selections, provider audit events, the outbox,
// the identity role rows), never against the service's own return value alone. Domain packages never import each other, so the ports the service needs are FAKES that live here:
//  - AccountPort: reads the real identity rows and performs the PENDING / ACTIVE role grants with plain SQL, with the same audit and event semantics as the identity service
//    (ROLE_GRANTED for a request, ROLE_ACTIVATED plus the account-role-granted event for an activation). It uses the SAME Database as the service, so inside the service's
//    transaction it JOINS that transaction, exactly like the real identity service does.
//  - ConsentPort: a state the test sets; it records whether it was called inside a transaction and, like the real consent service, opens its own REPEATABLE READ snapshot, which
//    cannot nest in a registration transaction.
//  - MarketPort and CatalogPort: read the real geography and catalogue rows (built here with plain SQL), with overrides for the tests that make a port lie.
// Statements issued by the ports are counted separately from the statements of the service (an AsyncLocalStorage marks the port scope).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_EVENTS, type ProviderRegistrationPolicy } from '@bananagig/contracts';
import { createDatabase, sql, TransactionOptionError, type Database } from '@bananagig/database';
import { getCorrelationId, runWithCorrelation } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  ProviderError,
  ProviderRegistrationService,
  StaticPolicyProvider,
  type AccountFacts,
  type AccountPort,
  type CatalogPort,
  type ConsentFacts,
  type ConsentPort,
  type MarketFacts,
  type MarketPort,
  type PrerequisitePort,
  type PrerequisiteState,
  type RegistrationState,
} from './index';

// every log call of the code under test is captured here (and nothing is printed)
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

type Pool = ReturnType<typeof createTestPool>;
type Row = Record<string, unknown>;
const EMAIL_CANARY = 'privacy.canary';
const PHONE_CANARY = '+15550001234';

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const portScope = new AsyncLocalStorage<true>();
const svcStatements: string[] = [];
const portStatements: string[] = [];
let transactionsOpened = 0;
const DEFAULT_POLICY: ProviderRegistrationPolicy = {
  requireVerifiedEmail: true,
  requireVerifiedPhone: true,
  marketStatusesAllowed: ['ACTIVE'],
  minServiceTypes: 1,
  maxServiceTypes: 10,
};
const policyProvider = new StaticPolicyProvider({ ...DEFAULT_POLICY });
const setPolicy = (over: Partial<ProviderRegistrationPolicy>): void => {
  policyProvider.value = { ...DEFAULT_POLICY, marketStatusesAllowed: ['ACTIVE'], ...over };
};

interface Grant {
  accountId: string;
  roleCode: string;
  pending: boolean;
  actor: string;
  reason: string;
  inTransaction: boolean;
}
class FakeAccounts implements AccountPort {
  grants: Grant[] = [];
  factsCalls = 0;
  /** Lets a test change what `facts` answers on a given call (1-based), to simulate a change between two reads. */
  factsHook: ((accountId: string, n: number, real: AccountFacts) => AccountFacts) | undefined;
  constructor(private readonly database: Database) {}

  async facts(accountId: string): Promise<AccountFacts> {
    const n = ++this.factsCalls;
    const real = await portScope.run(true, async () => {
      const r = (
        await sql<Row>`SELECT a.status,
            EXISTS (SELECT 1 FROM identity.email_contacts e WHERE e.account_id = a.account_id AND e.status = 'VERIFIED') AS email_verified,
            EXISTS (SELECT 1 FROM identity.phone_contacts p WHERE p.account_id = a.account_id AND p.status = 'VERIFIED') AS phone_verified,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('code', ro.code, 'status', m.status) ORDER BY ro.code)
                        FROM identity.account_roles m JOIN identity.roles ro ON ro.role_id = m.role_id WHERE m.account_id = a.account_id), '[]'::jsonb) AS memberships
          FROM identity.accounts a WHERE a.account_id = ${accountId}`.execute(this.database.db)
      ).rows[0];
      if (!r) throw new Error('the account does not exist');
      return {
        accountId,
        status: r.status as string,
        memberships: r.memberships as AccountFacts['memberships'],
        emailVerified: r.email_verified as boolean,
        phoneVerified: r.phone_verified as boolean,
      } satisfies AccountFacts;
    });
    return this.factsHook ? this.factsHook(accountId, n, real) : real;
  }

  /** The semantics of the identity service's grantRole: idempotent, ROLE_GRANTED for a request, ROLE_ACTIVATED plus an event for an activation, joins the caller's transaction. */
  async grantRole(accountId: string, roleCode: string, o: { pending: boolean; actor: string; reason: string }): Promise<{ changed: boolean; status: string }> {
    this.grants.push({ accountId, roleCode, ...o, inTransaction: this.database.inTransaction });
    const cid = getCorrelationId() ?? randomUUID();
    return portScope.run(true, () =>
      this.database.transaction(async (trx) => {
        await sql`SELECT 1 FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
        const role = (await sql<Row>`SELECT role_id, status FROM identity.roles WHERE code = ${roleCode} FOR SHARE`.execute(trx)).rows[0];
        if (!role) throw new Error('ROLE_NOT_FOUND');
        if (role.status !== 'ACTIVE') throw new Error('ROLE_NOT_ACTIVE');
        const wanted = o.pending ? 'PENDING' : 'ACTIVE';
        const cur = (
          await sql<Row>`SELECT status FROM identity.account_roles WHERE account_id = ${accountId} AND role_id = ${role.role_id as string} FOR UPDATE`.execute(
            trx,
          )
        ).rows[0]?.status as string | undefined;
        const audit = (action: string, changes: Record<string, unknown>) =>
          sql`INSERT INTO identity.account_audit_events (actor, action, account_id, role_id, changes, reason, correlation_id)
            VALUES (${o.actor}, ${action}, ${accountId}, ${role.role_id as string}, ${JSON.stringify(changes)}::jsonb, ${o.reason}, ${cid})`.execute(trx);
        if (cur === undefined) {
          await sql`INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
            VALUES (${accountId}, ${role.role_id as string}, ${wanted}, ${wanted === 'ACTIVE' ? sql`now()` : sql`NULL`}, ${o.actor}, 'SIGNUP')`.execute(trx);
          await audit('ROLE_GRANTED', { status: [null, wanted], source: 'SIGNUP' });
        } else if (cur === 'ACTIVE' || (cur === 'PENDING' && wanted === 'PENDING')) {
          return { changed: false, status: cur };
        } else if (wanted === 'PENDING') {
          throw new Error('an inactive role cannot go back to pending');
        } else {
          await sql`UPDATE identity.account_roles SET status = 'ACTIVE', activated_at = now(), deactivated_at = NULL, granted_at = now(), granted_by = ${o.actor},
              grant_source = 'SIGNUP', updated_at = now() WHERE account_id = ${accountId} AND role_id = ${role.role_id as string}`.execute(trx);
          await audit('ROLE_ACTIVATED', { status: [cur, 'ACTIVE'], source: 'SIGNUP' });
        }
        if (wanted === 'ACTIVE') {
          await insertOutboxEvent(trx, {
            aggregateType: 'identity_account',
            aggregateId: accountId,
            eventType: 'bananagig.identity.account-role-granted.v1',
            actorType: 'user',
            actorId: o.actor,
            correlationId: cid,
            payload: { accountId, roleCode, source: 'SIGNUP' },
          });
        }
        return { changed: true, status: wanted };
      }),
    );
  }
}

class FakeConsent implements ConsentPort {
  state: ConsentFacts | Error = { satisfied: true, outstanding: [], unavailable: [], requiredCount: 2 };
  calls: { accountId: string; locale: string | undefined; inTransaction: boolean }[] = [];
  /** Held until released: lets a test order the consent evaluation of one call against another change. */
  gate: Promise<void> | undefined;
  constructor(private readonly database: Database) {}
  async requirements(accountId: string, opts: { locale?: string }): Promise<ConsentFacts> {
    this.calls.push({ accountId, locale: opts.locale, inTransaction: this.database.inTransaction });
    if (this.gate) await this.gate;
    // like the real consent service: its own repeatable-read snapshot, which cannot nest inside another transaction
    await this.database.transaction(async () => undefined, { isolationLevel: 'repeatable read', readOnly: true });
    if (this.state instanceof Error) throw this.state;
    return this.state;
  }
}

class FakeMarkets implements MarketPort {
  /** A market the registration should see differently from the database (null = "does not exist"). */
  overrides = new Map<string, MarketFacts | null>();
  lookups: string[] = [];
  constructor(private readonly database: Database) {}
  async lookup(code: string): Promise<MarketFacts | null> {
    this.lookups.push(code);
    if (this.overrides.has(code)) return this.overrides.get(code)!;
    return portScope.run(true, async () => {
      const r = (
        await sql<Row>`SELECT status, effective_from <= now() AND (effective_to IS NULL OR now() < effective_to) AS in_effect FROM geography.markets WHERE code = ${code}`.execute(
          this.database.db,
        )
      ).rows[0];
      return r ? { code, status: r.status as string, inEffect: r.in_effect as boolean } : null;
    });
  }
}

class FakeCatalog implements CatalogPort {
  /** A market whose offered list is forced (a port that lies). */
  overrides = new Map<string, string[]>();
  asked: string[] = [];
  constructor(private readonly database: Database) {}
  async offeredServiceTypes(marketCode: string): Promise<readonly string[]> {
    this.asked.push(marketCode);
    const forced = this.overrides.get(marketCode);
    if (forced) return forced;
    return portScope.run(true, async () =>
      (
        await sql<Row>`SELECT st.code FROM catalog.market_service_types mst
            JOIN geography.markets m ON m.market_id = mst.market_id
            JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
            JOIN catalog.categories c ON c.category_id = st.category_id
            JOIN catalog.market_categories mc ON mc.market_id = mst.market_id AND mc.category_id = st.category_id
           WHERE m.code = ${marketCode} AND mst.enabled AND st.status = 'ACTIVE' AND c.status = 'ACTIVE' AND mc.enabled
           ORDER BY st.code COLLATE "C"`.execute(this.database.db)
      ).rows.map((r) => r.code as string),
    );
  }
}

let accounts: FakeAccounts;
let consent: FakeConsent;
let markets: FakeMarkets;
let catalog: FakeCatalog;
let svc: ProviderRegistrationService;
const mkService = (extra: { prerequisites?: PrerequisitePort; database?: Database; policy?: StaticPolicyProvider } = {}): ProviderRegistrationService =>
  new ProviderRegistrationService({
    database: extra.database ?? iso.database,
    accounts,
    consent,
    markets,
    catalog,
    policy: extra.policy ?? policyProvider,
    ...(extra.prerequisites ? { prerequisites: extra.prerequisites } : {}),
  });

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      overrides: { poolMax: 40, connectionTimeoutMs: 30_000 },
      onQuery: (e) => (portScope.getStore() ? portStatements : svcStatements).push(e.sql),
      onTransaction: () => {
        transactionsOpened++;
      },
    },
  });
  pool = createTestPool(iso.url, 10);
  accounts = new FakeAccounts(iso.database);
  consent = new FakeConsent(iso.database);
  markets = new FakeMarkets(iso.database);
  catalog = new FakeCatalog(iso.database);
  svc = mkService();
});
beforeEach(() => {
  setPolicy({});
  policyProvider.failure = undefined;
  policyProvider.reads = 0;
  consent.state = { satisfied: true, outstanding: [], unavailable: [], requiredCount: 2 };
  consent.gate = undefined;
  accounts.factsHook = undefined;
  markets.overrides.clear();
  catalog.overrides.clear();
});
afterEach(async () => {
  for (const rollback of openRaw) await rollback().catch(() => undefined);
  openRaw.clear();
  for (const drop of triggersToDrop.splice(0)) await drop().catch(() => undefined);
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Row>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const one = async <T = Row>(text: string, params: unknown[] = []): Promise<T> => (await q<T>(text, params))[0]!;

// ---------------------------------------------------------------- raw sessions, waiting, crafted failures
const openRaw = new Set<() => Promise<void>>();
async function rawTx() {
  const c = await pool.connect();
  await c.query('BEGIN');
  let done = false;
  const finish = async (how: 'COMMIT' | 'ROLLBACK') => {
    if (done) return;
    done = true;
    try {
      await c.query(how);
    } finally {
      c.release();
    }
  };
  openRaw.add(() => finish('ROLLBACK'));
  return { query: (text: string, params: unknown[] = []) => c.query(text, params), commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}
async function waitUntilBlocked(n = 1): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND state = 'active'`, [
      iso.name,
    ]);
    if (r.n >= n) return;
    await sleep(20);
  }
  throw new Error('no session ever blocked on a lock');
}
const triggersToDrop: (() => Promise<void>)[] = [];
let triggerSeq = 0;
/** A trigger that makes the next matching INSERT fail: a failure AFTER earlier writes of the same transaction. Dropped by afterEach. */
async function failInsert(table: string, whenSql: string): Promise<void> {
  const n = ++triggerSeq;
  await q(
    `CREATE FUNCTION public.fail_${n}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${whenSql} THEN RAISE EXCEPTION 'crafted failure %', ${n} USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`,
  );
  await q(`CREATE TRIGGER trg_fail_${n} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.fail_${n}()`);
  triggersToDrop.push(async () => {
    await q(`DROP TRIGGER IF EXISTS trg_fail_${n} ON ${table}`);
    await q(`DROP FUNCTION IF EXISTS public.fail_${n}()`);
  });
}

// ---------------------------------------------------------------- builders
let seq = 0;
const nextSeq = (): number => ++seq;
interface AcctOpts {
  status?: 'ACTIVE' | 'PENDING';
  email?: boolean;
  phone?: boolean;
  customer?: boolean;
  profile?: boolean;
}
/** An account with a verified email and phone, an ACTIVE CUSTOMER role (the preferred role) and a core profile, by plain SQL, as the identity domain leaves them. */
async function mkAccount(o: AcctOpts = {}): Promise<string> {
  const n = nextSeq();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const status = o.status ?? 'ACTIVE';
    const id = (await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status])).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, $2, 'test', 'test')",
      [id, status],
    );
    if (o.customer !== false) {
      await c.query(
        `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
         SELECT $1, role_id, 'ACTIVE', now(), 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code = 'CUSTOMER'`,
        [id],
      );
      await c.query(`UPDATE identity.accounts SET primary_role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER') WHERE account_id = $1`, [id]);
    }
    if (o.profile !== false) await c.query("INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, 'Ada', 'Tester')", [id]);
    if (o.email !== false)
      await c.query(
        `INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())`,
        [id, `${EMAIL_CANARY}.${n}@example.test`],
      );
    if (o.phone !== false) {
      const phone = (
        await c.query(
          `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED') RETURNING phone_contact_id`,
          [id, `${PHONE_CANARY}${String(n).padStart(3, '0')}`],
        )
      ).rows[0].phone_contact_id as string;
      await c.query(`UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1`, [phone]);
    }
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
/** Moves the account to another status through its history (the status is only changed together with a history row). */
async function setAccountStatus(accountId: string, to: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const from = (await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0].status as string;
    await c.query(
      `UPDATE identity.accounts SET status = $2, closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE NULL END, updated_at = now() WHERE account_id = $1`,
      [accountId, to],
    );
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, $2, $3, 'test', 'test')",
      [accountId, from, to],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
/** Runs `fn` with the user triggers of the given tables disabled (a crafted state the guards would refuse), always restoring them. */
async function withoutTriggers<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}
const dropEmail = (accountId: string) =>
  withoutTriggers(['identity.email_contacts'], () =>
    q(`UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE account_id = $1`, [
      accountId,
    ]),
  );
const dropPhone = (accountId: string) =>
  withoutTriggers(['identity.phone_contacts'], () =>
    q(`UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE account_id = $1`, [
      accountId,
    ]),
  );
/** The PROVIDER membership by plain SQL (a crafted state: ACTIVE from the bootstrap, INACTIVE after a deactivation). */
async function setProviderRole(accountId: string, status: 'PENDING' | 'ACTIVE' | 'INACTIVE'): Promise<void> {
  const exists = (
    await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 AND r.code = 'PROVIDER'`,
      [accountId],
    )
  ).n;
  if (!exists) {
    await q(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
       SELECT $1, role_id, $2, CASE WHEN $2 = 'ACTIVE' THEN now() END, 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code = 'PROVIDER'`,
      [accountId, status === 'INACTIVE' ? 'ACTIVE' : status],
    );
    if (status !== 'INACTIVE') return;
  }
  if (status === 'INACTIVE')
    await q(
      `UPDATE identity.account_roles SET status = 'INACTIVE', deactivated_at = now() WHERE account_id = $1 AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
      [accountId],
    );
  else if (exists)
    await q(
      `UPDATE identity.account_roles SET status = $2, activated_at = CASE WHEN $2 = 'ACTIVE' THEN now() END, deactivated_at = NULL WHERE account_id = $1 AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
      [accountId, status],
    );
}

/** A market row of the given status. `window` = the window is in force (default), already ended, or not yet begun. */
async function mkMarket(status: 'PLANNED' | 'ACTIVE' | 'INACTIVE' = 'ACTIVE', window: 'in' | 'ended' | 'future' = 'in'): Promise<string> {
  const c = `devtest-m${nextSeq()}`;
  const [from, to] =
    window === 'in'
      ? ["now() - interval '1 day'", 'NULL']
      : window === 'ended'
        ? ["now() - interval '2 days'", "now() - interval '1 day'"]
        : ["now() + interval '1 day'", 'NULL'];
  await q(
    `WITH m AS (
       INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from, effective_to)
       SELECT $1, 'Test market', country_id, 'PLANNED', default_locale, currency_code, default_time_zone_id, ${from}, ${to} FROM geography.markets WHERE code = 'la-oc'
       RETURNING market_id, country_id, default_locale)
     INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM m`,
    [c],
  );
  if (status !== 'PLANNED') await q('UPDATE geography.markets SET status = $2 WHERE code = $1', [c, status]);
  return c;
}
const setMarketStatus = (code: string, status: string) => q('UPDATE geography.markets SET status = $2 WHERE code = $1', [code, status]);

interface Offer {
  market: string;
  category: string;
  types: string[];
}
/** A category, ACTIVE and enabled in the market, with `n` ACTIVE service types enabled there. Codes sort in creation order. */
async function mkOffer(market: string, n = 3): Promise<Offer> {
  const stem = `pt${nextSeq()}`;
  const category = `${stem}_cat`;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'provider integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'pro-itest' FROM unnest($1::text[]) AS k`,
    [[`catalog.category.${category}.name`, ...Array.from({ length: n }, (_, i) => `catalog.service_type.${stem}_t${i}.name`)]],
  );
  await q('INSERT INTO catalog.categories (code) VALUES ($1)', [category]);
  await q("UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = $1", [category]);
  await q(
    `INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) SELECT m.market_id, c.category_id, true, 10 FROM geography.markets m, catalog.categories c WHERE m.code = $1 AND c.code = $2`,
    [market, category],
  );
  const types: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = `${stem}_t${i}`;
    types.push(t);
    await q('INSERT INTO catalog.service_types (category_id, code) SELECT category_id, $2 FROM catalog.categories WHERE code = $1', [category, t]);
    await q("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [t]);
    await q(
      `INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) SELECT m.market_id, s.service_type_id, true, $3 FROM geography.markets m, catalog.service_types s WHERE m.code = $1 AND s.code = $2`,
      [market, t, (i + 1) * 10],
    );
  }
  return { market, category, types };
}
const setTypeStatus = (code: string, status: 'ACTIVE' | 'INACTIVE' | 'RETIRED') =>
  q('UPDATE catalog.service_types SET status = $2 WHERE code = $1', [code, status]);

// ---------------------------------------------------------------- observation
const err = async (p: Promise<unknown>): Promise<ProviderError | undefined> => (await rejection(p)) as ProviderError | undefined;
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<ProviderError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(ProviderError);
  expect(e!.code, JSON.stringify(e!.details)).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(e!.details.reason).toBe(reasonWanted);
  return e!;
};
const surface = (e: ProviderError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const isTxControl = (s: string): boolean => /^(start transaction|begin|commit|rollback)/i.test(s);
/** The statements issued by the service (transaction control excluded) and by the ports while `fn` runs, and how many transactions were opened. */
const counting = async <T>(fn: () => Promise<T>): Promise<{ result: T; svc: string[]; port: string[]; tx: number }> => {
  const s0 = svcStatements.length;
  const p0 = portStatements.length;
  const t0 = transactionsOpened;
  const result = await fn();
  return {
    result,
    svc: svcStatements.slice(s0).filter((x) => !isTxControl(x)),
    port: portStatements.slice(p0).filter((x) => !isTxControl(x)),
    tx: transactionsOpened - t0,
  };
};

interface RegRow {
  provider_registration_id: string;
  account_id: string;
  attempt_number: number;
  status: string;
  market_code: string | null;
  revision: number;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
const regs = (accountId: string) =>
  q<RegRow>(
    `SELECT r.provider_registration_id, r.account_id, r.attempt_number, r.status, m.code AS market_code, r.revision, r.completed_at, r.cancelled_at, r.created_at, r.updated_at
       FROM provider.registrations r LEFT JOIN geography.markets m ON m.market_id = r.market_id WHERE r.account_id = $1 ORDER BY r.attempt_number`,
    [accountId],
  );
const selection = async (registrationId: string): Promise<string[]> =>
  (
    await q<{ code: string }>(
      `SELECT st.code FROM provider.registration_service_types rs JOIN catalog.service_types st ON st.service_type_id = rs.service_type_id WHERE rs.provider_registration_id = $1 ORDER BY st.code COLLATE "C"`,
      [registrationId],
    )
  ).map((r) => r.code);
interface AuditRow {
  action: string;
  actor: string;
  changes: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string;
  provider_registration_id: string;
}
const audits = (accountId: string) =>
  q<AuditRow>(
    `SELECT a.action, a.actor, a.changes, a.reason, a.correlation_id, a.provider_registration_id FROM provider.audit_events a
       JOIN provider.registrations r ON r.provider_registration_id = a.provider_registration_id WHERE r.account_id = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [accountId],
  );
interface EventRow {
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: Record<string, unknown>;
  correlation_id: string;
}
const EVENT_COLS = 'event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, payload_json, correlation_id';
const providerEvents = (accountId: string) =>
  q<EventRow>(
    `SELECT ${EVENT_COLS} FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%' AND payload_json->>'accountId' = $1 ORDER BY created_at, outbox_event_id`,
    [accountId],
  );
const identityEvents = (accountId: string) =>
  q<EventRow>(
    `SELECT ${EVENT_COLS} FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.%' AND aggregate_id = $1 ORDER BY created_at, outbox_event_id`,
    [accountId],
  );
interface RoleRow {
  status: string;
  granted_by: string;
  grant_source: string;
  activated_at: Date | null;
  deactivated_at: Date | null;
  granted_at: Date;
  updated_at: Date;
}
const roleRow = (accountId: string, code = 'PROVIDER') =>
  q<RoleRow>(
    `SELECT m.status, m.granted_by, m.grant_source, m.activated_at, m.deactivated_at, m.granted_at, m.updated_at FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 AND r.code = $2`,
    [accountId, code],
  ).then((r) => r[0]);
const identityAudits = (accountId: string) =>
  q<{ action: string; actor: string; changes: Record<string, unknown>; reason: string }>(
    `SELECT a.action, a.actor, a.changes, a.reason FROM identity.account_audit_events a WHERE a.account_id = $1 AND a.action LIKE 'ROLE\\_%' ORDER BY a.occurred_at, a.audit_event_id`,
    [accountId],
  );
/** Every row that belongs to one account in the identity domain that the registration must never touch (customer role, profile, contacts, the account row, consent history), as one hash. */
const customerHash = async (accountId: string): Promise<string> =>
  (
    await one<{ h: string }>(
      `SELECT md5(concat_ws('|',
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.role_id), '[]') FROM identity.account_roles t JOIN identity.roles r USING (role_id) WHERE t.account_id = $1 AND r.code = 'CUSTOMER')::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM identity.account_profiles t WHERE t.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.email_contact_id), '[]') FROM identity.email_contacts t WHERE t.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.phone_contact_id), '[]') FROM identity.phone_contacts t WHERE t.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.consent_event_id), '[]') FROM identity.consent_events t WHERE t.account_id = $1)::text,
        (SELECT to_jsonb(t) FROM (SELECT account_id, status, primary_role_id, created_at, updated_at, closed_at FROM identity.accounts WHERE account_id = $1) t)::text)) AS h`,
      [accountId],
    )
  ).h;
/** Every provider-domain row of one account plus its events, as one hash: equal before and after means nothing was written or read-modified. */
const providerHash = async (accountId: string): Promise<string> =>
  (
    await one<{ h: string }>(
      `SELECT md5(concat_ws('|',
        (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.attempt_number), '[]') FROM provider.registrations t WHERE t.account_id::text = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.provider_registration_id, s.service_type_id), '[]') FROM provider.registration_service_types s JOIN provider.registrations t USING (provider_registration_id) WHERE t.account_id::text = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.audit_event_id), '[]') FROM provider.audit_events a JOIN provider.registrations t USING (provider_registration_id) WHERE t.account_id::text = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'created_at' ORDER BY e.outbox_event_id), '[]') FROM integration.outbox_events e WHERE e.payload_json->>'accountId' = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.role_id), '[]') FROM identity.account_roles m WHERE m.account_id::text = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'occurred_at' ORDER BY a.audit_event_id), '[]') FROM identity.account_audit_events a WHERE a.account_id::text = $1)::text)) AS h`,
      [accountId],
    )
  ).h;
const totals = async () => ({
  registrations: (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.registrations')).n,
  audits: (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.audit_events')).n,
  providerEvents: (await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'")).n,
  identityAudits: (await one<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_audit_events')).n,
});

// ---------------------------------------------------------------- scenario helpers
interface Flow {
  accountId: string;
  offer: Offer;
  market: string;
}
/** An account that has started, with a market that offers `n` service types. */
async function started(o: AcctOpts & { market?: Offer; types?: number } = {}): Promise<Flow & { registrationId: string }> {
  const accountId = await mkAccount(o);
  const offer = o.market ?? (await mkOffer(await mkMarket('ACTIVE'), o.types ?? 3));
  const s = await svc.startRegistration(accountId);
  return { accountId, offer, market: offer.market, registrationId: s.state.registration!.providerRegistrationId };
}
/** Started, market chosen and `count` service types chosen: ready to submit. */
async function ready(o: AcctOpts & { market?: Offer; types?: number; count?: number } = {}): Promise<Flow & { registrationId: string; revision: number }> {
  const f = await started(o);
  await svc.selectMarket(f.accountId, { marketCode: f.market });
  const st = await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: f.offer.types.slice(0, o.count ?? 2) });
  return { ...f, revision: st.registration!.revision };
}
const regOf = (s: RegistrationState) => s.registration!;
const sortC = (xs: string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ====================================================================== 0. the harness itself
describe('the test harness', () => {
  it('migration 0018 is applied, the five policy parameters and the copy are seeded, and no registration exists', async () => {
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM configuration.parameters WHERE key LIKE 'provider.registration.%'")).n).toBe(5);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM content.entries WHERE key LIKE 'provider.registration.%'")).n).toBe(56);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.registrations')).n).toBe(0);
  });

  it('an account, a market and an offer can be built; the account facts and the offered codes read them', async () => {
    const a = await mkAccount();
    const o = await mkOffer(await mkMarket('ACTIVE'), 3);
    const facts = await accounts.facts(a);
    expect(facts).toMatchObject({ accountId: a, status: 'ACTIVE', emailVerified: true, phoneVerified: true });
    expect(facts.memberships).toEqual([{ code: 'CUSTOMER', status: 'ACTIVE' }]);
    expect(await catalog.offeredServiceTypes(o.market)).toEqual(o.types);
    expect(await markets.lookup(o.market)).toEqual({ code: o.market, status: 'ACTIVE', inEffect: true });
    const planned = await mkMarket('PLANNED');
    expect((await markets.lookup(planned))!.status).toBe('PLANNED');
    expect((await markets.lookup(await mkMarket('ACTIVE', 'ended')))!.inEffect).toBe(false);
    expect((await markets.lookup(await mkMarket('ACTIVE', 'future')))!.inEffect).toBe(false);
    expect(await markets.lookup('devtest-ghost')).toBeNull();
  });

  it('statements are attributed to the service or to a port (the port scope survives awaits and transactions)', async () => {
    const a = await mkAccount();
    const r = await counting(() => iso.database.transaction(async () => accounts.facts(a)));
    expect(r.port.length).toBe(1);
    expect(r.svc).toEqual([]);
  });
});

// ====================================================================== 1. start
describe('startRegistration', () => {
  it('creates, in one transaction, a PENDING provider role, attempt 1, the audit row and the started event; nothing else', async () => {
    const accountId = await mkAccount();
    const before = await totals();
    const r = await runWithCorrelation('cid-start-1', () => svc.startRegistration(accountId));
    expect(r.created).toBe(true);
    expect(r.state.providerRole).toBe('PENDING');
    const view = regOf(r.state);
    expect(view).toMatchObject({
      attempt: 1,
      status: 'IN_PROGRESS',
      revision: 1,
      marketCode: null,
      serviceTypeCodes: [],
      completedAt: null,
      cancelledAt: null,
    });

    const rows = await regs(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_registration_id: view.providerRegistrationId,
      attempt_number: 1,
      status: 'IN_PROGRESS',
      market_code: null,
      revision: 1,
      completed_at: null,
      cancelled_at: null,
    });
    expect(await selection(view.providerRegistrationId)).toEqual([]);

    const role = (await roleRow(accountId))!;
    expect(role).toMatchObject({ status: 'PENDING', granted_by: `account:${accountId}`, grant_source: 'SIGNUP', activated_at: null, deactivated_at: null });
    expect(accounts.grants.filter((g) => g.accountId === accountId)).toEqual([
      { accountId, roleCode: 'PROVIDER', pending: true, actor: `account:${accountId}`, reason: 'Provider registration started', inTransaction: true },
    ]);
    // identity audit: one ROLE_GRANTED, no activation, no identity event for a mere request
    expect((await identityAudits(accountId)).map((a) => a.action)).toEqual(['ROLE_GRANTED']);
    expect(await identityEvents(accountId)).toEqual([]);

    const trail = await audits(accountId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'PROVIDER_REGISTRATION_STARTED',
      actor: `account:${accountId}`,
      reason: null,
      correlation_id: 'cid-start-1',
      provider_registration_id: view.providerRegistrationId,
      changes: { attempt: [null, 1], providerRole: ['NONE', 'PENDING'] },
    });
    const events = await providerEvents(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event_type: PROVIDER_EVENTS.registrationStarted,
      event_version: 1,
      aggregate_type: 'provider_registration',
      aggregate_id: view.providerRegistrationId,
      actor_type: 'user',
      actor_id: `account:${accountId}`,
      payload_json: { accountId, providerRegistrationId: view.providerRegistrationId, attempt: 1 },
      correlation_id: 'cid-start-1',
    });
    const after = await totals();
    expect(after.registrations - before.registrations).toBe(1);
    expect(after.audits - before.audits).toBe(1);
    expect(after.providerEvents - before.providerEvents).toBe(1);
    expect(after.identityAudits - before.identityAudits).toBe(1);
  });

  it('the CUSTOMER role, the core profile, the contacts, the account row and the consent history are untouched', async () => {
    const accountId = await mkAccount();
    const before = await customerHash(accountId);
    const customerBefore = await roleRow(accountId, 'CUSTOMER');
    await svc.startRegistration(accountId);
    expect(await customerHash(accountId)).toBe(before);
    expect(await roleRow(accountId, 'CUSTOMER')).toEqual(customerBefore);
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_profiles WHERE account_id = $1', [accountId])).toEqual({ n: 1 });
  });

  it('without a caller correlation id it still writes one (the same on the audit row and on the event)', async () => {
    const accountId = await mkAccount();
    await svc.startRegistration(accountId);
    const a = (await audits(accountId))[0]!;
    const e = (await providerEvents(accountId))[0]!;
    expect(a.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.correlation_id).toBe(a.correlation_id);
  });

  it('is idempotent on a live IN_PROGRESS registration: the same view comes back and nothing is written, audited, published or granted', async () => {
    const accountId = await mkAccount();
    const first = await svc.startRegistration(accountId);
    const hash = await providerHash(accountId);
    const grants = accounts.grants.length;
    const again = await svc.startRegistration(accountId);
    expect(again.created).toBe(false);
    expect(again.state).toEqual(first.state);
    expect(await providerHash(accountId)).toBe(hash);
    expect(accounts.grants.length).toBe(grants);
    expect(await regs(accountId)).toHaveLength(1);
  });

  it('is idempotent on a COMPLETED registration: returned as it is (role ACTIVE), no second attempt, no second audit, event or role write', async () => {
    const f = await ready();
    const done = await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(done.changed).toBe(true);
    const hash = await providerHash(f.accountId);
    const grants = accounts.grants.length;
    const again = await svc.startRegistration(f.accountId);
    expect(again.created).toBe(false);
    expect(again.state.providerRole).toBe('ACTIVE');
    expect(regOf(again.state)).toMatchObject({ attempt: 1, status: 'COMPLETED' });
    expect(await providerHash(f.accountId)).toBe(hash);
    expect(accounts.grants.length).toBe(grants);
  });

  for (const existing of ['PENDING', 'ACTIVE'] as const)
    it(`an account that already holds the PROVIDER role ${existing} keeps it: the registration starts, the role row and the identity audit are not touched`, async () => {
      const accountId = await mkAccount();
      await setProviderRole(accountId, existing);
      const roleBefore = await roleRow(accountId);
      const identityBefore = await identityAudits(accountId);
      const grants = accounts.grants.length;
      const r = await svc.startRegistration(accountId);
      expect(r.created).toBe(true);
      expect(r.state.providerRole).toBe(existing);
      expect(await roleRow(accountId)).toEqual(roleBefore);
      expect(await identityAudits(accountId)).toEqual(identityBefore);
      expect(accounts.grants.length).toBe(grants);
      const a = (await audits(accountId))[0]!;
      expect(a.changes).toEqual({ attempt: [null, 1], providerRole: [existing, existing] });
    });

  it('an INACTIVE provider role refuses the start (ROLE_INACTIVE) and nothing at all is written', async () => {
    const accountId = await mkAccount();
    await setProviderRole(accountId, 'INACTIVE');
    const hash = await providerHash(accountId);
    const customer = await customerHash(accountId);
    const e = await expectError(svc.startRegistration(accountId), 'ROLE_INACTIVE', 'ROLE_INACTIVE');
    expect(e.details).toEqual({ reason: 'ROLE_INACTIVE' });
    expect(await providerHash(accountId)).toBe(hash);
    expect(await customerHash(accountId)).toBe(customer);
    expect(await regs(accountId)).toEqual([]);
    expect((await roleRow(accountId))!.status).toBe('INACTIVE');
  });

  it('an unknown account, and a closed, suspended, closure-requested or pending one, cannot start; nothing is written', async () => {
    const before = await totals();
    await expectError(svc.startRegistration(randomUUID()), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_FOUND');
    for (const to of ['SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED']) {
      const a = await mkAccount({ customer: false });
      await setAccountStatus(a, to === 'CLOSED' ? 'CLOSURE_REQUESTED' : to);
      if (to === 'CLOSED') await setAccountStatus(a, 'CLOSED');
      const h = await providerHash(a);
      const e = await expectError(svc.startRegistration(a), 'ACCOUNT_NOT_ACTIVE');
      // CLOSURE_REQUESTED is "still usable" for the identity domain but not for a NEW provider registration
      expect(e.details.reason).toBe('ACCOUNT_NOT_ACTIVE');
      expect(await providerHash(a)).toBe(h);
      expect(await regs(a)).toEqual([]);
    }
    const pending = await mkAccount({ status: 'PENDING', customer: false });
    await expectError(svc.startRegistration(pending), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_ACTIVE');
    expect(await regs(pending)).toEqual([]);
    expect(await totals()).toEqual(before);
  });

  it('an account id that is not a uuid fails without writing anything', async () => {
    const before = await totals();
    expect(await err(svc.startRegistration('not-a-uuid'))).toBeInstanceOf(Error);
    expect(await totals()).toEqual(before);
  });

  it('a start that fails after the audit insert (the event insert) rolls back the registration, the role request, the audit and the identity audit', async () => {
    const accountId = await mkAccount();
    await failInsert(
      'integration.outbox_events',
      `NEW.event_type = '${PROVIDER_EVENTS.registrationStarted}' AND NEW.payload_json->>'accountId' = '${accountId}'`,
    );
    const before = await totals();
    const e = await err(svc.startRegistration(accountId));
    expect(e).toBeInstanceOf(Error);
    expect(String(e?.message)).toContain('crafted failure');
    expect(await regs(accountId)).toEqual([]);
    expect(await roleRow(accountId)).toBeUndefined();
    expect(await audits(accountId)).toEqual([]);
    expect(await providerEvents(accountId)).toEqual([]);
    expect(await totals()).toEqual(before);
    expect((await accounts.facts(accountId)).memberships).toEqual([{ code: 'CUSTOMER', status: 'ACTIVE' }]);
  });

  it('a start that fails after the registration insert because the audit insert failed leaves no registration behind either', async () => {
    const accountId = await mkAccount();
    await failInsert('provider.audit_events', `NEW.action = 'PROVIDER_REGISTRATION_STARTED' AND NEW.actor = 'account:${accountId}'`);
    await err(svc.startRegistration(accountId));
    expect(await regs(accountId)).toEqual([]);
    expect(await roleRow(accountId)).toBeUndefined();
  });

  it('after the crafted failure is gone the same account starts normally (no half state was left)', async () => {
    const accountId = await mkAccount();
    await failInsert('provider.audit_events', `NEW.actor = 'account:${accountId}'`);
    await err(svc.startRegistration(accountId));
    while (triggersToDrop.length) await triggersToDrop.pop()!();
    const r = await svc.startRegistration(accountId);
    expect(r.created).toBe(true);
    expect(regOf(r.state).attempt).toBe(1);
  });
});

// ====================================================================== 2. market
describe('selectMarket', () => {
  it('sets the market, bumps the revision once, audits the change by codes and publishes no event', async () => {
    const f = await started();
    const eventsBefore = await providerEvents(f.accountId);
    const s = await runWithCorrelation('cid-market', () => svc.selectMarket(f.accountId, { marketCode: f.market }));
    expect(regOf(s)).toMatchObject({ marketCode: f.market, revision: 2, status: 'IN_PROGRESS', attempt: 1 });
    expect(s.providerRole).toBe('PENDING');
    expect((await regs(f.accountId))[0]).toMatchObject({ market_code: f.market, revision: 2 });
    const trail = await audits(f.accountId);
    expect(trail.map((a) => a.action)).toEqual(['PROVIDER_REGISTRATION_STARTED', 'PROVIDER_MARKET_SELECTED']);
    expect(trail[1]).toMatchObject({
      actor: `account:${f.accountId}`,
      correlation_id: 'cid-market',
      reason: null,
      changes: { market: [null, f.market], revision: [1, 2] },
    });
    expect(await providerEvents(f.accountId)).toEqual(eventsBefore);
  });

  it('needs a started registration: none -> REGISTRATION_NOT_FOUND, a cancelled latest attempt -> REGISTRATION_NOT_FOUND, a COMPLETED one -> REGISTRATION_NOT_IN_PROGRESS', async () => {
    const offer = await mkOffer(await mkMarket('ACTIVE'));
    const none = await mkAccount();
    await expectError(svc.selectMarket(none, { marketCode: offer.market }), 'REGISTRATION_NOT_FOUND');
    expect(await regs(none)).toEqual([]);

    const cancelled = await started({ market: offer });
    await svc.cancelRegistration(cancelled.accountId);
    const h = await providerHash(cancelled.accountId);
    await expectError(svc.selectMarket(cancelled.accountId, { marketCode: offer.market }), 'REGISTRATION_NOT_FOUND');
    expect(await providerHash(cancelled.accountId)).toBe(h);

    const done = await ready({ market: offer });
    await svc.submitRegistration(done.accountId, { expectedRevision: done.revision });
    const h2 = await providerHash(done.accountId);
    await expectError(svc.selectMarket(done.accountId, { marketCode: offer.market }), 'REGISTRATION_NOT_IN_PROGRESS');
    expect(await providerHash(done.accountId)).toBe(h2);
  });

  describe('contacts first (PRD PR-01.03 / PR-01.05)', () => {
    for (const reqE of [true, false])
      for (const reqP of [true, false])
        for (const vE of [true, false])
          for (const vP of [true, false]) {
            const allowed = (!reqE || vE) && (!reqP || vP);
            it(`policy email ${reqE ? 'required' : 'optional'} / phone ${reqP ? 'required' : 'optional'}, email ${vE ? 'verified' : 'unverified'} / phone ${vP ? 'verified' : 'unverified'} -> ${allowed ? 'allowed' : 'PREREQUISITE_NOT_MET'}`, async () => {
              const f = await started({ email: vE, phone: vP });
              setPolicy({ requireVerifiedEmail: reqE, requireVerifiedPhone: reqP });
              const call = svc.selectMarket(f.accountId, { marketCode: f.market });
              if (allowed) {
                expect(regOf(await call).marketCode).toBe(f.market);
              } else {
                const e = await expectError(call, 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
                expect(e.details).toEqual({ reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
                const row = (await regs(f.accountId))[0]!;
                expect(row).toMatchObject({ market_code: null, revision: 1 });
              }
            });
          }

    it('the contact check comes BEFORE the market check: an unverified account asking for an unknown market hears about the contacts', async () => {
      const f = await started({ email: false });
      await expectError(svc.selectMarket(f.accountId, { marketCode: 'devtest-ghost' }), 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
    });

    it('a contact that stops being verified after the start blocks the next step (the facts are read fresh)', async () => {
      const f = await started();
      await svc.selectMarket(f.accountId, { marketCode: f.market });
      await dropEmail(f.accountId);
      await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!] }), 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
      expect(await selection((await regs(f.accountId))[0]!.provider_registration_id)).toEqual([]);
    });
  });

  describe('the market must accept providers', () => {
    it('an unknown market, a PLANNED one, an INACTIVE one and an ACTIVE one outside its window all give the SAME answer, and write nothing', async () => {
      const f = await started();
      const planned = await mkMarket('PLANNED');
      const inactive = await mkMarket('INACTIVE');
      const ended = await mkMarket('ACTIVE', 'ended');
      const future = await mkMarket('ACTIVE', 'future');
      const h = await providerHash(f.accountId);
      const answers = new Set<string>();
      for (const code of ['devtest-ghost', planned, inactive, ended, future]) {
        const e = await expectError(svc.selectMarket(f.accountId, { marketCode: code }), 'MARKET_NOT_ELIGIBLE', 'MARKET_NOT_ELIGIBLE');
        answers.add(surface(e));
      }
      expect(answers.size).toBe(1);
      expect(await providerHash(f.accountId)).toBe(h);
    });

    it('the seeded la-oc market is PLANNED: refused with the default policy, accepted only when the policy lists PLANNED', async () => {
      const f = await started();
      expect((await markets.lookup('la-oc'))!.status).toBe('PLANNED');
      await expectError(svc.selectMarket(f.accountId, { marketCode: 'la-oc' }), 'MARKET_NOT_ELIGIBLE');
      setPolicy({ marketStatusesAllowed: ['ACTIVE'] });
      await expectError(svc.selectMarket(f.accountId, { marketCode: 'la-oc' }), 'MARKET_NOT_ELIGIBLE');
      setPolicy({ marketStatusesAllowed: ['ACTIVE', 'PLANNED'] });
      const s = await svc.selectMarket(f.accountId, { marketCode: 'la-oc' });
      expect(regOf(s)).toMatchObject({ marketCode: 'la-oc', revision: 2 });
      // and an ACTIVE market stays acceptable under that policy
      expect(regOf(await svc.selectMarket(f.accountId, { marketCode: f.market })).marketCode).toBe(f.market);
    });

    it('a policy that lists only PLANNED refuses an ACTIVE market; one that lists INACTIVE accepts an INACTIVE market', async () => {
      const f = await started();
      setPolicy({ marketStatusesAllowed: ['PLANNED'] });
      await expectError(svc.selectMarket(f.accountId, { marketCode: f.market }), 'MARKET_NOT_ELIGIBLE');
      const inactive = await mkMarket('INACTIVE');
      setPolicy({ marketStatusesAllowed: ['INACTIVE'] });
      expect(regOf(await svc.selectMarket(f.accountId, { marketCode: inactive })).marketCode).toBe(inactive);
    });

    it('a market the port reports but the database does not hold is refused inside the transaction too (nothing is written)', async () => {
      const f = await started();
      markets.overrides.set('devtest-phantom', { code: 'devtest-phantom', status: 'ACTIVE', inEffect: true });
      const h = await providerHash(f.accountId);
      await expectError(svc.selectMarket(f.accountId, { marketCode: 'devtest-phantom' }), 'MARKET_NOT_ELIGIBLE');
      expect(await providerHash(f.accountId)).toBe(h);
    });

    it('the policy is read fresh on every call and a policy outage fails closed with nothing written', async () => {
      const f = await started();
      const h = await providerHash(f.accountId);
      policyProvider.failure = new ProviderError('UNAVAILABLE', 'the provider registration policy is not available', { reason: 'POLICY_INVALID' });
      const e = await expectError(svc.selectMarket(f.accountId, { marketCode: f.market }), 'UNAVAILABLE', 'POLICY_INVALID');
      expect(e).toBe(policyProvider.failure);
      expect(await providerHash(f.accountId)).toBe(h);
      policyProvider.failure = undefined;
      const reads = policyProvider.reads;
      await svc.selectMarket(f.accountId, { marketCode: f.market });
      expect(policyProvider.reads).toBe(reads + 1);
    });
  });

  it('choosing the same market again is idempotent: no revision bump, no audit row', async () => {
    const f = await started();
    const first = await svc.selectMarket(f.accountId, { marketCode: f.market });
    const hash = await providerHash(f.accountId);
    const again = await svc.selectMarket(f.accountId, { marketCode: f.market });
    expect(again).toEqual(first);
    expect(await providerHash(f.accountId)).toBe(hash);
    expect(regOf(again).revision).toBe(2);
  });

  it('a different market bumps the revision, keeps the chosen service types, and the evaluator then reports the ones that are not offered as BLOCKED', async () => {
    const f = await ready({ count: 2 });
    const other = await mkOffer(await mkMarket('ACTIVE'), 2);
    const s = await svc.selectMarket(f.accountId, { marketCode: other.market });
    expect(regOf(s)).toMatchObject({ marketCode: other.market, revision: f.revision + 1, serviceTypeCodes: f.offer.types.slice(0, 2) });
    expect(await selection(regOf(s).providerRegistrationId)).toEqual(f.offer.types.slice(0, 2));
    const trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({
      action: 'PROVIDER_MARKET_SELECTED',
      changes: { market: [f.market, other.market], revision: [f.revision, f.revision + 1] },
    });
    const r = await svc.getRequirements(f.accountId);
    const services = r.steps.find((x) => x.step === 'SERVICES')!;
    expect(services.status).toBe('BLOCKED');
    expect(services.detail).toMatchObject({ selected: 2, notOffered: f.offer.types.slice(0, 2) });
    expect(r.steps.find((x) => x.step === 'MARKET')!.status).toBe('COMPLETE');
    expect(r.overall).toMatchObject({ registrationReady: false, blockedBy: ['SERVICES'] });
    // the provider fixes it with replaceServiceTypes
    const fixed = await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [other.types[0]!] });
    expect(regOf(fixed).serviceTypeCodes).toEqual([other.types[0]]);
    expect((await svc.getRequirements(f.accountId)).overall.registrationReady).toBe(true);
  });

  it('a stale expectedRevision is refused (also for the same market) and writes nothing; the current one is accepted', async () => {
    const f = await started();
    const other = await mkOffer(await mkMarket('ACTIVE'), 1);
    const h = await providerHash(f.accountId);
    await expectError(svc.selectMarket(f.accountId, { marketCode: f.market, expectedRevision: 2 }), 'STALE_REGISTRATION', 'STALE_REGISTRATION');
    await expectError(svc.selectMarket(f.accountId, { marketCode: f.market, expectedRevision: 99 }), 'STALE_REGISTRATION');
    expect(await providerHash(f.accountId)).toBe(h);
    const ok = await svc.selectMarket(f.accountId, { marketCode: f.market, expectedRevision: 1 });
    expect(regOf(ok).revision).toBe(2);
    await expectError(svc.selectMarket(f.accountId, { marketCode: f.market, expectedRevision: 1 }), 'STALE_REGISTRATION');
    await expectError(svc.selectMarket(f.accountId, { marketCode: other.market, expectedRevision: 1 }), 'STALE_REGISTRATION');
    expect(regOf(await svc.selectMarket(f.accountId, { marketCode: other.market, expectedRevision: 2 })).revision).toBe(3);
  });

  it('a market selection that fails after the update (the audit insert) rolls the market and the revision back', async () => {
    const f = await started();
    await failInsert('provider.audit_events', `NEW.action = 'PROVIDER_MARKET_SELECTED' AND NEW.provider_registration_id = '${f.registrationId}'`);
    const h = await providerHash(f.accountId);
    expect(String((await err(svc.selectMarket(f.accountId, { marketCode: f.market })))?.message)).toContain('crafted failure');
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]).toMatchObject({ market_code: null, revision: 1 });
  });
});

// ====================================================================== 3. services
describe('replaceServiceTypes', () => {
  const selectedAt = (registrationId: string) =>
    q<{ code: string; created_at: Date }>(
      `SELECT st.code, rs.created_at FROM provider.registration_service_types rs JOIN catalog.service_types st ON st.service_type_id = rs.service_type_id WHERE rs.provider_registration_id = $1 ORDER BY st.code COLLATE "C"`,
      [registrationId],
    );
  /** Started with a market chosen. */
  async function withMarket(types = 4) {
    const f = await started({ types });
    await svc.selectMarket(f.accountId, { marketCode: f.market });
    return f;
  }

  it('needs a started registration and a chosen market (MARKET_REQUIRED), and writes nothing without them', async () => {
    const offer = await mkOffer(await mkMarket('ACTIVE'), 2);
    const none = await mkAccount();
    await expectError(svc.replaceServiceTypes(none, { serviceTypeCodes: [offer.types[0]!] }), 'REGISTRATION_NOT_FOUND');
    const f = await started({ market: offer });
    const h = await providerHash(f.accountId);
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [offer.types[0]!] }), 'MARKET_REQUIRED', 'MARKET_REQUIRED');
    expect(await providerHash(f.accountId)).toBe(h);
    await svc.cancelRegistration(f.accountId);
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [offer.types[0]!] }), 'REGISTRATION_NOT_FOUND');
  });

  it('a COMPLETED registration is frozen: REGISTRATION_NOT_IN_PROGRESS and the selection is unchanged', async () => {
    const f = await ready();
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const h = await providerHash(f.accountId);
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[2]!] }), 'REGISTRATION_NOT_IN_PROGRESS');
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('stores the selection, bumps the revision once and audits added / removed as CODES with the counts', async () => {
    const f = await withMarket();
    const [a, b, c] = f.offer.types as [string, string, string];
    const r1 = await runWithCorrelation('cid-svc', () => svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [b, a] }));
    expect(regOf(r1)).toMatchObject({ revision: 3, serviceTypeCodes: sortC([a, b]) });
    expect(await selection(regOf(r1).providerRegistrationId)).toEqual(sortC([a, b]));
    let trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({
      action: 'PROVIDER_SERVICES_UPDATED',
      correlation_id: 'cid-svc',
      reason: null,
      changes: { added: sortC([a, b]), removed: [], count: [0, 2], revision: [2, 3] },
    });
    const keptAt = (await selectedAt(regOf(r1).providerRegistrationId)).find((x) => x.code === b)!.created_at;
    await sleep(15);
    const r2 = await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [c, b] });
    expect(regOf(r2)).toMatchObject({ revision: 4, serviceTypeCodes: sortC([b, c]) });
    trail = await audits(f.accountId);
    expect(trail.at(-1)!.changes).toEqual({ added: [c], removed: [a], count: [2, 2], revision: [3, 4] });
    // the service type that stays is not deleted and re-inserted
    expect((await selectedAt(regOf(r2).providerRegistrationId)).find((x) => x.code === b)!.created_at).toEqual(keptAt);
    expect(trail.filter((x) => x.action === 'PROVIDER_SERVICES_UPDATED')).toHaveLength(2);
    expect((await providerEvents(f.accountId)).map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted]);
  });

  it('an equal set writes nothing, whatever the order the codes come in', async () => {
    const f = await withMarket();
    const [a, b] = f.offer.types as [string, string];
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [a, b] });
    const h = await providerHash(f.accountId);
    const s0 = (await selectedAt((await regs(f.accountId))[0]!.provider_registration_id)).map((x) => x.created_at.getTime());
    const same = await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [b, a] });
    expect(regOf(same).revision).toBe(3);
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await selectedAt(regOf(same).providerRegistrationId)).map((x) => x.created_at.getTime())).toEqual(s0);
  });

  it('every code must be offered in the chosen market: an unknown code, a code of another market, a DRAFT / INACTIVE / RETIRED type and a type of a disabled category are all refused, atomically', async () => {
    const f = await withMarket(5);
    const [ok, draftLike, inactive, retired] = f.offer.types as [string, string, string, string];
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [ok] });
    await setTypeStatus(inactive, 'INACTIVE');
    await setTypeStatus(retired, 'RETIRED');
    // a type that was never enabled in the market
    const orphan = `${f.offer.category}_orphan`;
    await q(
      `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
             VALUES ($1, 'UI_LABEL', 'CONTENT', 'x', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'pro-itest')`,
      [`catalog.service_type.${orphan}.name`],
    );
    await q('INSERT INTO catalog.service_types (category_id, code) SELECT category_id, $2 FROM catalog.categories WHERE code = $1', [f.offer.category, orphan]);
    await q("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [orphan]);
    const elsewhere = await mkOffer(await mkMarket('ACTIVE'), 1);
    const h = await providerHash(f.accountId);
    for (const bad of ['devtest_no_such_type', inactive, retired, orphan, elsewhere.types[0]!]) {
      const e = await expectError(
        svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [ok, bad] }),
        'SERVICE_TYPE_NOT_ELIGIBLE',
        'SERVICE_TYPE_NOT_ELIGIBLE',
      );
      expect(e.details.codes).toEqual([bad]);
      expect(await providerHash(f.accountId)).toBe(h);
    }
    // two bad ones are both named, a good one never is
    const both = await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [inactive, ok, retired] }), 'SERVICE_TYPE_NOT_ELIGIBLE');
    expect(both.details.codes).toEqual(sortC([inactive, retired]));
    expect(draftLike).toBeDefined();
    expect(await selection(f.registrationId)).toEqual([ok]);
    // a category switched off for the market removes its types from the offer
    await withoutTriggers(['catalog.market_categories'], () =>
      q(`UPDATE catalog.market_categories SET enabled = false WHERE category_id = (SELECT category_id FROM catalog.categories WHERE code = $1)`, [
        f.offer.category,
      ]),
    );
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [ok] }), 'SERVICE_TYPE_NOT_ELIGIBLE');
  });

  it('the count must lie within the configured [min, max], checked before any lock; min 0 allows the empty set', async () => {
    const f = await withMarket(4);
    const [a, b, c, d] = f.offer.types as [string, string, string, string];
    setPolicy({ minServiceTypes: 2, maxServiceTypes: 3 });
    const h = await providerHash(f.accountId);
    for (const set of [[], [a], [a, b, c, d]]) {
      const e = await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: set }), 'SERVICE_COUNT_OUT_OF_RANGE', 'SERVICE_COUNT_OUT_OF_RANGE');
      expect(e.details).toEqual({ reason: 'SERVICE_COUNT_OUT_OF_RANGE', min: 2, max: 3 });
    }
    expect(await providerHash(f.accountId)).toBe(h);
    expect(regOf(await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [a, b] })).serviceTypeCodes).toHaveLength(2);
    expect(regOf(await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [a, b, c] })).serviceTypeCodes).toHaveLength(3);
    // min 0: the empty set is accepted (it empties the selection), an empty set on an empty selection writes nothing
    setPolicy({ minServiceTypes: 0, maxServiceTypes: 3 });
    const emptied = await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [] });
    expect(regOf(emptied).serviceTypeCodes).toEqual([]);
    expect(await selection(f.registrationId)).toEqual([]);
    expect((await audits(f.accountId)).at(-1)!.changes).toMatchObject({ added: [], removed: sortC([a, b, c]), count: [3, 0] });
    const h2 = await providerHash(f.accountId);
    expect(regOf(await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [] })).revision).toBe(regOf(emptied).revision);
    expect(await providerHash(f.accountId)).toBe(h2);
  });

  it('duplicates are a validation error and nothing is written', async () => {
    const f = await withMarket();
    const h = await providerHash(f.accountId);
    const e = await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!, f.offer.types[0]!] }), 'VALIDATION_FAILED');
    expect(e.details).toEqual({ field: 'serviceTypeCodes', reason: 'INVALID_REQUEST' });
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('a market that no longer accepts providers (closed after it was chosen) refuses the change', async () => {
    const f = await withMarket();
    await setMarketStatus(f.market, 'INACTIVE');
    const h = await providerHash(f.accountId);
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!] }), 'MARKET_NOT_ELIGIBLE');
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('a stale expectedRevision is refused and writes nothing; the current one is accepted', async () => {
    const f = await withMarket();
    const t = f.offer.types[0]!;
    const h = await providerHash(f.accountId);
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [t], expectedRevision: 1 }), 'STALE_REGISTRATION', 'STALE_REGISTRATION');
    expect(await providerHash(f.accountId)).toBe(h);
    expect(regOf(await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [t], expectedRevision: 2 })).revision).toBe(3);
    // an equal set with a stale revision is stale too (the revision is checked first)
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [t], expectedRevision: 2 }), 'STALE_REGISTRATION');
  });

  it('the guard is the backstop when the catalogue port lies: a DRAFT / INACTIVE type is SERVICE_TYPE_NOT_ACTIVE, a RETIRED one SERVICE_TYPE_RETIRED; nothing is written', async () => {
    const f = await withMarket(4);
    const [ok, inactive, retired, draft] = f.offer.types as [string, string, string, string];
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [ok] });
    await setTypeStatus(inactive, 'INACTIVE');
    await setTypeStatus(retired, 'RETIRED');
    await withoutTriggers(['catalog.service_types'], () => q("UPDATE catalog.service_types SET status = 'DRAFT' WHERE code = $1", [draft]));
    catalog.overrides.set(f.market, [ok, inactive, retired, draft]);
    const h = await providerHash(f.accountId);
    const wanted: [string, string][] = [
      [inactive, 'SERVICE_TYPE_NOT_ACTIVE'],
      [retired, 'SERVICE_TYPE_RETIRED'],
      [draft, 'SERVICE_TYPE_NOT_ACTIVE'],
    ];
    for (const [code, reason] of wanted) {
      const e = await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [ok, code] }), 'SERVICE_TYPE_NOT_ELIGIBLE', reason);
      expect(e.message).toBe('a selected service type is not available');
      expect(await providerHash(f.accountId)).toBe(h);
    }
    expect(await selection(f.registrationId)).toEqual([ok]);
  });

  it('a service type deactivated in a concurrent, still uncommitted transaction is caught by the guard (FOR SHARE) once that commits, and the whole change rolls back', async () => {
    const f = await withMarket(3);
    const [keep, victim] = f.offer.types as [string, string];
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [keep] });
    const h = await providerHash(f.accountId);
    const raw = await rawTx();
    await raw.query("UPDATE catalog.service_types SET status = 'INACTIVE' WHERE code = $1", [victim]);
    const call = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [keep, victim] });
    await waitUntilBlocked();
    await raw.commit();
    await expectError(call, 'SERVICE_TYPE_NOT_ELIGIBLE', 'SERVICE_TYPE_NOT_ACTIVE');
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('a change that fails after the writes (the audit insert) restores the previous selection and revision', async () => {
    const f = await withMarket();
    const [a, b] = f.offer.types as [string, string];
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [a] });
    await failInsert('provider.audit_events', `NEW.action = 'PROVIDER_SERVICES_UPDATED' AND NEW.provider_registration_id = '${f.registrationId}'`);
    const h = await providerHash(f.accountId);
    expect(String((await err(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [b] })))?.message)).toContain('crafted failure');
    expect(await providerHash(f.accountId)).toBe(h);
    expect(await selection(f.registrationId)).toEqual([a]);
  });
});

// ====================================================================== 4. getRegistration / getRequirements
describe('getRegistration', () => {
  it('reports NONE and no registration for an account that never started, and the latest attempt (any status) afterwards', async () => {
    const accountId = await mkAccount();
    expect(await svc.getRegistration(accountId)).toEqual({ providerRole: 'NONE', registration: null });
    const s = await svc.startRegistration(accountId);
    expect(await svc.getRegistration(accountId)).toEqual({ providerRole: 'PENDING', registration: regOf(s.state) });
    await svc.cancelRegistration(accountId);
    const cancelled = await svc.getRegistration(accountId);
    expect(cancelled.registration).toMatchObject({ attempt: 1, status: 'CANCELLED' });
    expect(cancelled.registration!.cancelledAt).not.toBeNull();
    expect(cancelled.providerRole).toBe('PENDING');
    await svc.startRegistration(accountId);
    expect((await svc.getRegistration(accountId)).registration).toMatchObject({ attempt: 2, status: 'IN_PROGRESS' });
  });

  it('is a pure read: nothing is written, no event, and the timestamps are ISO strings', async () => {
    const f = await ready();
    const h = await providerHash(f.accountId);
    const r = await svc.getRegistration(f.accountId);
    expect(await providerHash(f.accountId)).toBe(h);
    expect(r.registration!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(r.registration!.serviceTypeCodes).toEqual(f.offer.types.slice(0, 2));
  });
});

describe('getRequirements: the composition of the owning domains', () => {
  const step = (r: Awaited<ReturnType<ProviderRegistrationService['getRequirements']>>, s: string) => r.steps.find((x) => x.step === s)!;

  it('before any start: ACCOUNT not started, the consent is not even asked (no provider role), the future steps are NOT_AVAILABLE', async () => {
    const accountId = await mkAccount();
    const calls = consent.calls.length;
    const r = await svc.getRequirements(accountId);
    expect(consent.calls.length).toBe(calls);
    expect(r.providerRole).toBe('NONE');
    expect(r.registration).toBeNull();
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ['ACCOUNT', 'NOT_STARTED'],
      ['CONTACT', 'COMPLETE'],
      ['LEGAL', 'NOT_STARTED'],
      ['MARKET', 'NOT_STARTED'],
      ['SERVICES', 'NOT_STARTED'],
      ['VERIFICATION', 'NOT_AVAILABLE'],
      ['SUBSCRIPTION', 'NOT_AVAILABLE'],
      ['PROFILE', 'NOT_AVAILABLE'],
      ['GIGS', 'NOT_AVAILABLE'],
    ]);
    expect(r.overall).toEqual({
      registrationComplete: false,
      registrationReady: false,
      blockedBy: ['ACCOUNT', 'LEGAL', 'MARKET', 'SERVICES'],
      goLive: { evaluated: false, eligible: false },
    });
  });

  it('after the start it composes the contact state, the consent state, the market and the services', async () => {
    const f = await started();
    const r = await svc.getRequirements(f.accountId);
    expect(r.providerRole).toBe('PENDING');
    expect(step(r, 'ACCOUNT').status).toBe('COMPLETE');
    expect(step(r, 'CONTACT')).toMatchObject({ status: 'COMPLETE', detail: { email: 'VERIFIED', phone: 'VERIFIED' } });
    expect(step(r, 'LEGAL').status).toBe('COMPLETE');
    expect(step(r, 'MARKET').status).toBe('NOT_STARTED');
    expect(step(r, 'SERVICES').status).toBe('NOT_STARTED');
    expect(r.overall.blockedBy).toEqual(['MARKET', 'SERVICES']);
    await svc.selectMarket(f.accountId, { marketCode: f.market });
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!] });
    const ready1 = await svc.getRequirements(f.accountId);
    expect(step(ready1, 'MARKET')).toMatchObject({ status: 'COMPLETE', detail: { marketCode: f.market } });
    expect(step(ready1, 'SERVICES')).toMatchObject({ status: 'COMPLETE', detail: { selected: 1, min: 1, max: 10 } });
    expect(ready1.overall).toEqual({ registrationComplete: false, registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
  });

  it('the contact step follows the real verification state and the policy', async () => {
    const f = await started({ phone: false });
    expect(step(await svc.getRequirements(f.accountId), 'CONTACT')).toMatchObject({
      status: 'IN_PROGRESS',
      detail: { email: 'VERIFIED', phone: 'NOT_VERIFIED' },
    });
    setPolicy({ requireVerifiedPhone: false });
    expect(step(await svc.getRequirements(f.accountId), 'CONTACT')).toMatchObject({ status: 'COMPLETE', detail: { email: 'VERIFIED', phone: 'NOT_REQUIRED' } });
    setPolicy({ requireVerifiedPhone: false, requireVerifiedEmail: false });
    expect(step(await svc.getRequirements(f.accountId), 'CONTACT').status).toBe('NOT_REQUIRED');
    setPolicy({});
    const none = await started({ phone: false, email: false });
    expect(step(await svc.getRequirements(none.accountId), 'CONTACT').status).toBe('NOT_STARTED');
  });

  const legalCases: [string, ConsentFacts, string, string[] | undefined][] = [
    ['nothing required', { satisfied: true, outstanding: [], unavailable: [], requiredCount: 0 }, 'NOT_REQUIRED', undefined],
    ['all satisfied', { satisfied: true, outstanding: [], unavailable: [], requiredCount: 2 }, 'COMPLETE', undefined],
    ['one of two outstanding', { satisfied: false, outstanding: ['TERMS'], unavailable: [], requiredCount: 2 }, 'IN_PROGRESS', ['TERMS']],
    ['all outstanding', { satisfied: false, outstanding: ['TERMS', 'PRIVACY'], unavailable: [], requiredCount: 2 }, 'NOT_STARTED', ['TERMS', 'PRIVACY']],
    ['a document unavailable', { satisfied: false, outstanding: ['TERMS'], unavailable: ['TERMS'], requiredCount: 2 }, 'BLOCKED', ['TERMS']],
  ];
  for (const [label, facts, wanted, purposes] of legalCases)
    it(`the legal step reads the consent port: ${label} -> ${wanted}`, async () => {
      const f = await started();
      consent.state = facts;
      const r = await svc.getRequirements(f.accountId);
      expect(step(r, 'LEGAL').status).toBe(wanted);
      expect(step(r, 'LEGAL').detail?.outstandingPurposes).toEqual(purposes);
      expect(r.overall.blockedBy.includes('LEGAL')).toBe(wanted !== 'COMPLETE' && wanted !== 'NOT_REQUIRED');
    });

  it('a consent outage fails the whole read closed (the error comes through, no partial answer)', async () => {
    const f = await started();
    consent.state = new ProviderError('UNAVAILABLE', 'consent policy unreadable');
    expect(await err(svc.getRequirements(f.accountId))).toBe(consent.state);
  });

  it('the consent is evaluated for the account, with the locale asked for, never inside a transaction', async () => {
    const f = await started();
    const before = consent.calls.length;
    await svc.getRequirements(f.accountId, { locale: 'es-US' });
    await svc.getRequirements(f.accountId);
    expect(consent.calls.slice(before)).toEqual([
      { accountId: f.accountId, locale: 'es-US', inTransaction: false },
      { accountId: f.accountId, locale: undefined, inTransaction: false },
    ]);
  });

  it('a market that is closed or gone after it was chosen shows MARKET as BLOCKED; a cancelled attempt reads as not started', async () => {
    const f = await ready();
    await setMarketStatus(f.market, 'INACTIVE');
    const r = await svc.getRequirements(f.accountId);
    expect(step(r, 'MARKET')).toMatchObject({ status: 'BLOCKED', detail: { marketCode: f.market } });
    expect(r.overall.blockedBy).toEqual(['MARKET']);
    await svc.cancelRegistration(f.accountId);
    const c = await svc.getRequirements(f.accountId);
    expect(c.registration!.status).toBe('CANCELLED');
    expect(step(c, 'ACCOUNT').status).toBe('NOT_STARTED');
    expect(step(c, 'MARKET').status).toBe('NOT_STARTED');
    expect(step(c, 'SERVICES')).toEqual({ step: 'SERVICES', status: 'NOT_STARTED', owner: 'PRO-001' });
  });

  it('a suspended account shows ACCOUNT as BLOCKED', async () => {
    const f = await started();
    await setAccountStatus(f.accountId, 'SUSPENDED');
    const r = await svc.getRequirements(f.accountId);
    expect(step(r, 'ACCOUNT').status).toBe('BLOCKED');
    expect(r.overall.blockedBy).toContain('ACCOUNT');
  });

  it('the future steps come from the prerequisite port and never decide readiness, completion or Go-Live; the service stores no state for them', async () => {
    const f = await ready();
    const custom: PrerequisitePort = {
      verification: async () => ({ status: 'COMPLETE' }),
      subscription: async () => ({ status: 'BLOCKED' }),
      profile: async () => ({ status: 'IN_PROGRESS' }),
      gigs: async () => ({ status: 'NOT_STARTED' }),
    };
    const r = await mkService({ prerequisites: custom }).getRequirements(f.accountId);
    expect(r.steps.slice(5).map((s) => [s.step, s.status])).toEqual([
      ['VERIFICATION', 'COMPLETE'],
      ['SUBSCRIPTION', 'BLOCKED'],
      ['PROFILE', 'IN_PROGRESS'],
      ['GIGS', 'NOT_STARTED'],
    ]);
    expect(r.overall).toMatchObject({ registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
    // the default port: all NOT_AVAILABLE
    expect((await svc.getRequirements(f.accountId)).steps.slice(5).map((s) => s.status)).toEqual([
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
    ]);
    // and a registration completed through a service whose future steps are all COMPLETE is still not live
    const all: PrerequisitePort = {
      verification: async () => ({ status: 'COMPLETE' }),
      subscription: async () => ({ status: 'COMPLETE' }),
      profile: async () => ({ status: 'COMPLETE' }),
      gigs: async () => ({ status: 'COMPLETE' }),
    };
    const done = await mkService({ prerequisites: all }).submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(done.requirements.overall.goLive).toEqual({ evaluated: false, eligible: false });
    expect((await mkService({ prerequisites: all }).getRequirements(f.accountId)).overall).toMatchObject({
      registrationComplete: true,
      goLive: { evaluated: false, eligible: false },
    });
  });

  it('the provider tables hold no contact, consent, verification, subscription or profile state: their columns and their rows carry none', async () => {
    const f = await ready();
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const cols = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'provider' ORDER BY table_name, ordinal_position`,
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`).join(' ')).not.toMatch(
      /email|phone|consent|verif|subscri|payment|document|first_name|last_name|address|token|secret|legal|profile|gig/,
    );
    expect([...new Set(cols.map((c) => c.table_name))].sort()).toEqual(['audit_events', 'registration_service_types', 'registrations']);
    const dump = (
      await one<{ t: string }>(
        `SELECT concat_ws(' ', (SELECT jsonb_agg(to_jsonb(r)) FROM provider.registrations r), (SELECT jsonb_agg(to_jsonb(r)) FROM provider.registration_service_types r),
                (SELECT jsonb_agg(to_jsonb(r)) FROM provider.audit_events r), (SELECT jsonb_agg(to_jsonb(e)) FROM integration.outbox_events e WHERE e.event_type LIKE 'bananagig.provider.%'))::text AS t`,
      )
    ).t;
    expect(dump).not.toContain(EMAIL_CANARY);
    expect(dump).not.toContain(PHONE_CANARY);
    expect(dump).not.toContain('example.test');
  });

  it('supplied account facts are used as they are: the account port is not asked again, and they decide the role and the contact state', async () => {
    const f = await started();
    const real = await accounts.facts(f.accountId);
    const asked = accounts.factsCalls;
    const r = await svc.getRequirements(f.accountId, {
      facts: { ...real, emailVerified: false, phoneVerified: false, memberships: [{ code: 'PROVIDER', status: 'ACTIVE' }] },
    });
    expect(accounts.factsCalls).toBe(asked);
    expect(r.providerRole).toBe('ACTIVE');
    expect(step(r, 'CONTACT')).toMatchObject({ status: 'NOT_STARTED' });
    const g = await svc.getRegistration(f.accountId, { facts: { ...real, memberships: [] } });
    expect(g.providerRole).toBe('NONE');
    expect(accounts.factsCalls).toBe(asked);
  });
});

// ====================================================================== 5. submit
describe('submitRegistration', () => {
  it('completes a ready registration: COMPLETED, the role PENDING -> ACTIVE with the identity grant semantics, the audit and the completed event with the market and the service codes', async () => {
    const f = await ready({ count: 3 });
    const customer = await customerHash(f.accountId);
    const identityBefore = await identityAudits(f.accountId);
    const r = await runWithCorrelation('cid-submit', () => svc.submitRegistration(f.accountId, { expectedRevision: f.revision }));
    expect(r.changed).toBe(true);
    expect(r.state.providerRole).toBe('ACTIVE');
    expect(regOf(r.state)).toMatchObject({ status: 'COMPLETED', revision: f.revision, marketCode: f.market, serviceTypeCodes: f.offer.types.slice(0, 3) });
    expect(regOf(r.state).completedAt).not.toBeNull();
    expect(r.requirements.overall).toEqual({
      registrationComplete: true,
      registrationReady: true,
      blockedBy: [],
      goLive: { evaluated: false, eligible: false },
    });
    expect(r.requirements.providerRole).toBe('ACTIVE');
    expect(r.requirements.registration).toEqual(regOf(r.state));

    const row = (await regs(f.accountId))[0]!;
    expect(row).toMatchObject({ status: 'COMPLETED', market_code: f.market, revision: f.revision, cancelled_at: null });
    expect(row.completed_at).toBeInstanceOf(Date);
    expect(await selection(f.registrationId)).toEqual(f.offer.types.slice(0, 3));

    const role = (await roleRow(f.accountId))!;
    expect(role).toMatchObject({ status: 'ACTIVE', granted_by: `account:${f.accountId}`, grant_source: 'SIGNUP', deactivated_at: null });
    expect(role.activated_at).toBeInstanceOf(Date);
    const ident = await identityAudits(f.accountId);
    expect(ident.slice(identityBefore.length).map((a) => [a.action, a.changes])).toEqual([
      ['ROLE_ACTIVATED', { status: ['PENDING', 'ACTIVE'], source: 'SIGNUP' }],
    ]);
    const ie = await identityEvents(f.accountId);
    expect(ie).toHaveLength(1);
    expect(ie[0]).toMatchObject({
      event_type: 'bananagig.identity.account-role-granted.v1',
      payload_json: { accountId: f.accountId, roleCode: 'PROVIDER', source: 'SIGNUP' },
      correlation_id: 'cid-submit',
    });
    const grant = accounts.grants.filter((g) => g.accountId === f.accountId).at(-1)!;
    expect(grant).toEqual({
      accountId: f.accountId,
      roleCode: 'PROVIDER',
      pending: false,
      actor: `account:${f.accountId}`,
      reason: 'Provider registration completed',
      inTransaction: true,
    });

    const trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({
      action: 'PROVIDER_REGISTRATION_COMPLETED',
      actor: `account:${f.accountId}`,
      correlation_id: 'cid-submit',
      reason: null,
      changes: { status: ['IN_PROGRESS', 'COMPLETED'], providerRole: ['PENDING', 'ACTIVE'], market: f.market, serviceTypes: 3 },
    });
    const events = await providerEvents(f.accountId);
    expect(events.map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted, PROVIDER_EVENTS.registrationCompleted]);
    expect(events[1]).toEqual({
      event_type: PROVIDER_EVENTS.registrationCompleted,
      event_version: 1,
      aggregate_type: 'provider_registration',
      aggregate_id: f.registrationId,
      actor_type: 'user',
      actor_id: `account:${f.accountId}`,
      payload_json: {
        accountId: f.accountId,
        providerRegistrationId: f.registrationId,
        attempt: 1,
        marketCode: f.market,
        serviceTypeCodes: f.offer.types.slice(0, 3),
      },
      correlation_id: 'cid-submit',
    });
    // the customer side is untouched (the preferred role was already set)
    expect(await customerHash(f.accountId)).toBe(customer);
  });

  it('a provider role that is already ACTIVE stays as it is (no grant, no second activation)', async () => {
    const f = await ready();
    await setProviderRole(f.accountId, 'ACTIVE');
    const roleBefore = await roleRow(f.accountId);
    const grants = accounts.grants.length;
    const r = await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(r.changed).toBe(true);
    expect(r.state.providerRole).toBe('ACTIVE');
    expect(accounts.grants.length).toBe(grants);
    expect(await roleRow(f.accountId)).toEqual(roleBefore);
    expect((await audits(f.accountId)).at(-1)!.changes).toMatchObject({ providerRole: ['ACTIVE', 'ACTIVE'] });
  });

  it('the consent is evaluated OUTSIDE the registration transaction (the real consent opens its own snapshot, which cannot nest)', async () => {
    const f = await ready();
    const before = consent.calls.length;
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const mine = consent.calls.slice(before);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({ accountId: f.accountId, locale: undefined, inTransaction: false });
  });

  it('a consent evaluation that cannot run (an outage) refuses the submit and writes nothing', async () => {
    const f = await ready();
    const h = await providerHash(f.accountId);
    consent.state = new ProviderError('UNAVAILABLE', 'consent policy unreadable');
    expect(await err(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }))).toBe(consent.state);
    expect(await providerHash(f.accountId)).toBe(h);
  });

  describe('every unmet step is named in REGISTRATION_INCOMPLETE and nothing is written', () => {
    const expectIncomplete = async (accountId: string, revision: number, steps: string[]) => {
      const h = await providerHash(accountId);
      const e = await expectError(svc.submitRegistration(accountId, { expectedRevision: revision }), 'REGISTRATION_INCOMPLETE', 'REGISTRATION_INCOMPLETE');
      expect(e.details).toEqual({ reason: 'REGISTRATION_INCOMPLETE', steps });
      expect(await providerHash(accountId)).toBe(h);
      const row = (await regs(accountId))[0]!;
      expect(row.status).toBe('IN_PROGRESS');
      expect((await roleRow(accountId))!.status).toBe('PENDING');
    };

    it('no market and no services -> MARKET, SERVICES', async () => {
      const f = await started();
      await expectIncomplete(f.accountId, 1, ['MARKET', 'SERVICES']);
    });
    it('a market but no services -> SERVICES', async () => {
      const f = await started();
      const s = await svc.selectMarket(f.accountId, { marketCode: f.market });
      await expectIncomplete(f.accountId, regOf(s).revision, ['SERVICES']);
    });
    it('too few services for the configured minimum -> SERVICES', async () => {
      const f = await ready({ count: 1 });
      setPolicy({ minServiceTypes: 2 });
      await expectIncomplete(f.accountId, f.revision, ['SERVICES']);
    });
    it('more services than the configured maximum (the maximum was lowered later) -> SERVICES', async () => {
      const f = await ready({ count: 3 });
      setPolicy({ maxServiceTypes: 2 });
      await expectIncomplete(f.accountId, f.revision, ['SERVICES']);
    });
    it('an unverified email, an unverified phone, or both -> CONTACT', async () => {
      const f = await ready();
      await dropEmail(f.accountId);
      await expectIncomplete(f.accountId, f.revision, ['CONTACT']);
      const g = await ready();
      await dropPhone(g.accountId);
      await expectIncomplete(g.accountId, g.revision, ['CONTACT']);
      await dropEmail(g.accountId);
      await expectIncomplete(g.accountId, g.revision, ['CONTACT']);
      setPolicy({ requireVerifiedEmail: false, requireVerifiedPhone: false });
      expect((await svc.submitRegistration(g.accountId, { expectedRevision: g.revision })).changed).toBe(true);
    });
    it('a contact the policy does not require does not block', async () => {
      setPolicy({ requireVerifiedEmail: false });
      const f = await ready({ email: false });
      expect((await svc.submitRegistration(f.accountId, { expectedRevision: f.revision })).changed).toBe(true);
    });
    for (const [label, facts] of [
      ['outstanding purposes', { satisfied: false, outstanding: ['TERMS'], unavailable: [], requiredCount: 2 }],
      ['all purposes outstanding', { satisfied: false, outstanding: ['TERMS', 'PRIVACY'], unavailable: [], requiredCount: 2 }],
      ['a purpose without a published document', { satisfied: false, outstanding: ['TERMS'], unavailable: ['TERMS'], requiredCount: 2 }],
    ] as [string, ConsentFacts][])
      it(`the legal step: ${label} -> LEGAL`, async () => {
        const f = await ready();
        consent.state = facts;
        await expectIncomplete(f.accountId, f.revision, ['LEGAL']);
      });
    it('nothing required by the consent policy does not block', async () => {
      const f = await ready();
      consent.state = { satisfied: true, outstanding: [], unavailable: [], requiredCount: 0 };
      expect((await svc.submitRegistration(f.accountId, { expectedRevision: f.revision })).changed).toBe(true);
    });
    it('several unmet steps are all named, in the order of the steps', async () => {
      const f = await ready();
      await dropEmail(f.accountId);
      consent.state = { satisfied: false, outstanding: ['TERMS'], unavailable: [], requiredCount: 1 };
      setPolicy({ minServiceTypes: 5 });
      await expectIncomplete(f.accountId, f.revision, ['CONTACT', 'LEGAL', 'SERVICES']);
    });
    it('the market closed after it was chosen -> MARKET; a market outside its window -> MARKET', async () => {
      const f = await ready();
      await setMarketStatus(f.market, 'INACTIVE');
      await expectIncomplete(f.accountId, f.revision, ['MARKET']);
      const g = await ready({ market: await mkOffer(await mkMarket('ACTIVE'), 2) });
      markets.overrides.set(g.market, { code: g.market, status: 'ACTIVE', inEffect: false });
      await expectIncomplete(g.accountId, g.revision, ['MARKET']);
    });
    it('a chosen market that is PLANNED when the policy no longer lists PLANNED -> MARKET', async () => {
      const f = await started();
      setPolicy({ marketStatusesAllowed: ['ACTIVE', 'PLANNED'] });
      await svc.selectMarket(f.accountId, { marketCode: 'la-oc' });
      setPolicy({ marketStatusesAllowed: ['ACTIVE'] });
      const r = await svc.getRequirements(f.accountId);
      expect(r.steps.find((s) => s.step === 'MARKET')!.status).toBe('BLOCKED');
      const e = await expectError(svc.submitRegistration(f.accountId, { expectedRevision: 2 }), 'REGISTRATION_INCOMPLETE');
      expect((e.details.steps as string[]).includes('MARKET')).toBe(true);
    });
    it('a selected service type deactivated or retired after it was chosen -> SERVICES', async () => {
      const f = await ready({ count: 2, types: 3 });
      await setTypeStatus(f.offer.types[0]!, 'INACTIVE');
      await expectIncomplete(f.accountId, f.revision, ['SERVICES']);
      const g = await ready({ count: 2, types: 3 });
      await setTypeStatus(g.offer.types[1]!, 'RETIRED');
      await expectIncomplete(g.accountId, g.revision, ['SERVICES']);
      // and switched off in the market
      const h = await ready({ count: 2, types: 3 });
      await withoutTriggers(['catalog.market_service_types'], () =>
        q(
          'UPDATE catalog.market_service_types SET enabled = false WHERE service_type_id = (SELECT service_type_id FROM catalog.service_types WHERE code = $1)',
          [h.offer.types[0]!],
        ),
      );
      await expectIncomplete(h.accountId, h.revision, ['SERVICES']);
    });
    it('a suspended account cannot submit (ACCOUNT_NOT_ACTIVE) and its registration stays IN_PROGRESS', async () => {
      const f = await ready();
      await setAccountStatus(f.accountId, 'SUSPENDED');
      const h = await providerHash(f.accountId);
      await expectError(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_ACTIVE');
      expect(await providerHash(f.accountId)).toBe(h);
    });
  });

  it('needs a started registration: none or a cancelled latest attempt -> REGISTRATION_NOT_FOUND', async () => {
    const none = await mkAccount();
    await expectError(svc.submitRegistration(none, { expectedRevision: 1 }), 'REGISTRATION_NOT_FOUND');
    const f = await ready();
    await svc.cancelRegistration(f.accountId);
    const h = await providerHash(f.accountId);
    await expectError(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'REGISTRATION_NOT_FOUND');
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('a stale expectedRevision is STALE_REGISTRATION and writes nothing (also when the registration is otherwise ready)', async () => {
    const f = await ready();
    const h = await providerHash(f.accountId);
    for (const wrong of [f.revision - 1, f.revision + 1, 99])
      await expectError(svc.submitRegistration(f.accountId, { expectedRevision: wrong }), 'STALE_REGISTRATION', 'STALE_REGISTRATION');
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await svc.submitRegistration(f.accountId, { expectedRevision: f.revision })).changed).toBe(true);
  });

  it('a double submit is idempotent: the second call changes nothing and returns the completed registration (no second audit, event, role write)', async () => {
    const f = await ready();
    const first = await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const hash = await providerHash(f.accountId);
    const grants = accounts.grants.length;
    const second = await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(second.changed).toBe(false);
    expect(second.state).toEqual(first.state);
    expect(second.requirements.overall.registrationComplete).toBe(true);
    expect(second.requirements.registration).toEqual(regOf(first.state));
    expect(await providerHash(f.accountId)).toBe(hash);
    expect(accounts.grants.length).toBe(grants);
    expect((await providerEvents(f.accountId)).filter((e) => e.event_type === PROVIDER_EVENTS.registrationCompleted)).toHaveLength(1);
    // the revision of a COMPLETED registration is not compared: a repeat with an old revision is still the same answer
    expect((await svc.submitRegistration(f.accountId, { expectedRevision: 1 })).changed).toBe(false);
  });

  it('an INACTIVE provider role on an IN_PROGRESS registration is named as such up front (409 ROLE_INACTIVE, not "incomplete: LEGAL"): consent and the later prerequisites are not even read, nothing is written, the role stays INACTIVE', async () => {
    const f = await ready();
    await setProviderRole(f.accountId, 'INACTIVE');
    const h = await providerHash(f.accountId);
    const grants = accounts.grants.length;
    const reads: string[] = [];
    const spy = (k: string) => async (): Promise<{ status: 'NOT_AVAILABLE' }> => {
      reads.push(k);
      return { status: 'NOT_AVAILABLE' };
    };
    const watched = mkService({
      prerequisites: { verification: spy('verification'), subscription: spy('subscription'), profile: spy('profile'), gigs: spy('gigs') },
    });
    // the consent port is down: a role that is INACTIVE must still be reported as INACTIVE (the consent is never asked)
    consent.state = new Error('consent is down');
    const c0 = consent.calls.length;
    const e = await expectError(watched.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'ROLE_INACTIVE', 'ROLE_INACTIVE');
    expect(e.details).toEqual({ reason: 'ROLE_INACTIVE' });
    expect(consent.calls.length).toBe(c0);
    expect(reads).toEqual([]);
    expect(await providerHash(f.accountId)).toBe(h);
    expect(accounts.grants.length).toBe(grants);
    expect((await roleRow(f.accountId))!.status).toBe('INACTIVE');
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
    // with the consent port healthy the answer is the same
    consent.state = { satisfied: true, outstanding: [], unavailable: [], requiredCount: 2 };
    await expectError(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'ROLE_INACTIVE', 'ROLE_INACTIVE');
  });

  it('the up-front ROLE_INACTIVE concerns the attempt in progress only: a COMPLETED registration whose role was deactivated later still answers a repeat submit idempotently (nothing written)', async () => {
    const f = await ready();
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    await setProviderRole(f.accountId, 'INACTIVE');
    const h = await providerHash(f.accountId);
    const again = await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(again.changed).toBe(false);
    expect(regOf(again.state).status).toBe('COMPLETED');
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await roleRow(f.accountId))!.status).toBe('INACTIVE');
  });

  it('a role that turns INACTIVE between the consent evaluation and the transaction is ROLE_INACTIVE: not reactivated, nothing written', async () => {
    const f = await ready();
    accounts.factsHook = (_id, n, real) =>
      n === 2 ? { ...real, memberships: real.memberships.map((m) => (m.code === 'PROVIDER' ? { ...m, status: 'INACTIVE' as const } : m)) } : real;
    const factsBefore = accounts.factsCalls;
    const grants = accounts.grants.length;
    const h = await providerHash(f.accountId);
    const hook = accounts.factsHook;
    accounts.factsHook = (id, n, real) => hook(id, n - factsBefore, real);
    await expectError(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'ROLE_INACTIVE', 'ROLE_INACTIVE');
    expect(accounts.grants.length).toBe(grants);
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
  });

  it('a submit that fails after the completion (the event insert) restores the registration, the role and the identity audit', async () => {
    const f = await ready();
    await failInsert(
      'integration.outbox_events',
      `NEW.event_type = '${PROVIDER_EVENTS.registrationCompleted}' AND NEW.payload_json->>'accountId' = '${f.accountId}'`,
    );
    const h = await providerHash(f.accountId);
    expect(String((await err(svc.submitRegistration(f.accountId, { expectedRevision: f.revision })))?.message)).toContain('crafted failure');
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
    expect((await roleRow(f.accountId))!.status).toBe('PENDING');
    expect(await identityEvents(f.accountId)).toEqual([]);
  });

  it('a submit that fails because the role activation failed leaves the registration IN_PROGRESS', async () => {
    const f = await ready();
    await failInsert('identity.account_audit_events', `NEW.action = 'ROLE_ACTIVATED' AND NEW.account_id = '${f.accountId}'`);
    const h = await providerHash(f.accountId);
    await err(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }));
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
  });

  it('the selected service types are share-locked until the commit: a deactivation that is still uncommitted holds the submit back, and the submit then sees it (REGISTRATION_INCOMPLETE)', async () => {
    const f = await ready({ count: 2, types: 3 });
    const raw = await rawTx();
    await raw.query("UPDATE catalog.service_types SET status = 'INACTIVE' WHERE code = $1", [f.offer.types[0]!]);
    const h = await providerHash(f.accountId);
    const call = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const settled = vi.fn();
    void call.then(settled, settled);
    await waitUntilBlocked();
    await sleep(100);
    expect(settled).not.toHaveBeenCalled();
    await raw.commit();
    const e = await expectError(call, 'REGISTRATION_INCOMPLETE');
    expect(e.details.steps).toEqual(['SERVICES']);
    expect(await providerHash(f.accountId)).toBe(h);
  });

  it('the account row is locked first: a submit waits for another transaction that holds the account, and nothing is written meanwhile', async () => {
    const f = await ready();
    const raw = await rawTx();
    await raw.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [f.accountId]);
    const call = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const settled = vi.fn();
    void call.then(settled, settled);
    await waitUntilBlocked();
    await sleep(100);
    expect(settled).not.toHaveBeenCalled();
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
    await raw.commit();
    expect((await call).changed).toBe(true);
  });
});

// ====================================================================== 5b. what changes between the pre-transaction reads and the transaction
describe('submitRegistration: the transaction re-checks what the pre-transaction reads saw', () => {
  /** Holds the consent evaluation (the last thing before the transaction) until `release()`, so a test can change the world in between. */
  function holdConsent() {
    let release!: () => void;
    consent.gate = new Promise<void>((r) => (release = r));
    return release;
  }
  const waitForConsent = async (n: number): Promise<void> => {
    for (let i = 0; i < 300 && consent.calls.length < n; i++) await sleep(10);
    expect(consent.calls.length).toBeGreaterThanOrEqual(n);
  };

  it('a services replace that commits in between makes the submit STALE (the revision is compared again under the lock)', async () => {
    const f = await ready({ count: 1, types: 3 });
    const c0 = consent.calls.length;
    const release = holdConsent();
    const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    await waitForConsent(c0 + 1);
    consent.gate = undefined;
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[1]!, f.offer.types[2]!] });
    release();
    await expectError(submit, 'STALE_REGISTRATION');
    expect((await regs(f.accountId))[0]).toMatchObject({ status: 'IN_PROGRESS', revision: f.revision + 1 });
    expect((await roleRow(f.accountId))!.status).toBe('PENDING');
  });

  it('a market change that commits in between makes the submit STALE', async () => {
    const f = await ready({ count: 1 });
    const other = await mkOffer(await mkMarket('ACTIVE'), 1);
    const c0 = consent.calls.length;
    const release = holdConsent();
    const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    await waitForConsent(c0 + 1);
    consent.gate = undefined;
    await svc.selectMarket(f.accountId, { marketCode: other.market });
    release();
    await expectError(submit, 'STALE_REGISTRATION');
    expect((await regs(f.accountId))[0]).toMatchObject({ status: 'IN_PROGRESS', market_code: other.market });
  });

  it('a cancellation that commits in between makes the submit REGISTRATION_NOT_FOUND', async () => {
    const f = await ready({ count: 1 });
    const c0 = consent.calls.length;
    const release = holdConsent();
    const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    await waitForConsent(c0 + 1);
    consent.gate = undefined;
    await svc.cancelRegistration(f.accountId);
    release();
    await expectError(submit, 'REGISTRATION_NOT_FOUND');
    expect((await regs(f.accountId))[0]!.status).toBe('CANCELLED');
    expect((await roleRow(f.accountId))!.status).toBe('PENDING');
  });

  it('a market closed in between, a service type deactivated in between and a contact lost in between are all caught under the lock (REGISTRATION_INCOMPLETE)', async () => {
    const cases: [string, (f: Awaited<ReturnType<typeof ready>>) => Promise<unknown>, string][] = [
      ['the market closes', (f) => setMarketStatus(f.market, 'INACTIVE'), 'MARKET'],
      ['a selected service type is retired', (f) => setTypeStatus(f.offer.types[0]!, 'RETIRED'), 'SERVICES'],
      ['the email stops being verified', (f) => dropEmail(f.accountId), 'CONTACT'],
    ];
    for (const [label, change, step] of cases) {
      const f = await ready({ count: 1 });
      const c0 = consent.calls.length;
      const release = holdConsent();
      const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
      await waitForConsent(c0 + 1);
      consent.gate = undefined;
      await change(f);
      release();
      const e = await expectError(submit, 'REGISTRATION_INCOMPLETE');
      expect(e.details.steps, label).toEqual([step]);
      expect((await regs(f.accountId))[0]!.status, label).toBe('IN_PROGRESS');
    }
  });

  it('the account suspended in between is refused under the lock (ACCOUNT_NOT_ACTIVE)', async () => {
    const f = await ready({ count: 1 });
    const c0 = consent.calls.length;
    const release = holdConsent();
    const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    await waitForConsent(c0 + 1);
    consent.gate = undefined;
    await setAccountStatus(f.accountId, 'SUSPENDED');
    release();
    await expectError(submit, 'ACCOUNT_NOT_ACTIVE');
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
  });
});

// ====================================================================== 5c. the contacts are checked again under the account lock
describe('selectMarket and replaceServiceTypes: the contact prerequisite is re-checked under the account lock', () => {
  /** An open transaction that holds the account row: the call under test passes its pre-transaction checks, then waits for the lock. */
  async function holdAccount(accountId: string) {
    const raw = await rawTx();
    await raw.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
    return raw;
  }
  const losses: [string, (accountId: string) => Promise<unknown>][] = [
    ['the email stops being verified', dropEmail],
    ['the phone stops being verified', dropPhone],
  ];

  for (const [label, lose] of losses) {
    it(`selectMarket: ${label} between the first check and the lock -> PREREQUISITE_NOT_MET (CONTACT); the market is not chosen and nothing is written`, async () => {
      const f = await started();
      const h = await providerHash(f.accountId);
      const raw = await holdAccount(f.accountId);
      const call = svc.selectMarket(f.accountId, { marketCode: f.market });
      await waitUntilBlocked();
      await lose(f.accountId);
      await raw.commit();
      const e = await expectError(call, 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
      expect(e.details).toEqual({ reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
      expect(await providerHash(f.accountId)).toBe(h);
      expect((await regs(f.accountId))[0]).toMatchObject({ status: 'IN_PROGRESS', market_code: null, revision: 1 });
      expect((await audits(f.accountId)).map((a) => a.action)).toEqual(['PROVIDER_REGISTRATION_STARTED']);
    });

    it(`replaceServiceTypes: ${label} between the first check and the lock -> PREREQUISITE_NOT_MET (CONTACT); the selection is unchanged and nothing is written`, async () => {
      const f = await started();
      await svc.selectMarket(f.accountId, { marketCode: f.market });
      const h = await providerHash(f.accountId);
      const raw = await holdAccount(f.accountId);
      const call = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!] });
      await waitUntilBlocked();
      await lose(f.accountId);
      await raw.commit();
      const e = await expectError(call, 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
      expect(e.details).toEqual({ reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
      expect(await providerHash(f.accountId)).toBe(h);
      expect(await selection(f.registrationId)).toEqual([]);
      expect((await regs(f.accountId))[0]).toMatchObject({ status: 'IN_PROGRESS', revision: 2 });
    });
  }

  it('a contact that is NOT lost lets the very same blocked calls through (the re-check is not a refusal in disguise)', async () => {
    const f = await started();
    const raw = await holdAccount(f.accountId);
    const call = svc.selectMarket(f.accountId, { marketCode: f.market });
    await waitUntilBlocked();
    await raw.commit();
    expect(regOf(await call).marketCode).toBe(f.market);
    const raw2 = await holdAccount(f.accountId);
    const call2 = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!] });
    await waitUntilBlocked();
    await raw2.commit();
    expect(regOf(await call2).serviceTypeCodes).toEqual([f.offer.types[0]!]);
  });

  it('the policy of the first read governs the re-check: a contact the policy does not require is not required under the lock either', async () => {
    setPolicy({ requireVerifiedPhone: false });
    const f = await started();
    const raw = await holdAccount(f.accountId);
    const call = svc.selectMarket(f.accountId, { marketCode: f.market });
    await waitUntilBlocked();
    await dropPhone(f.accountId);
    await raw.commit();
    expect(regOf(await call).marketCode).toBe(f.market);
  });

  it('a stale revision wins over a lost contact: selectMarket answers STALE_REGISTRATION (the in-transaction revision check comes before the in-transaction contact check)', async () => {
    const f = await started();
    await svc.selectMarket(f.accountId, { marketCode: f.market }); // revision 2
    const other = await mkOffer(await mkMarket('ACTIVE'), 1);
    const h = await providerHash(f.accountId);
    const raw = await holdAccount(f.accountId);
    const call = svc.selectMarket(f.accountId, { marketCode: other.market, expectedRevision: 1 });
    await waitUntilBlocked();
    await dropEmail(f.accountId);
    await raw.commit();
    await expectError(call, 'STALE_REGISTRATION', 'STALE_REGISTRATION');
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]).toMatchObject({ market_code: f.market, revision: 2 });
  });

  it('a stale revision wins over a lost contact: replaceServiceTypes answers STALE_REGISTRATION', async () => {
    const f = await started();
    await svc.selectMarket(f.accountId, { marketCode: f.market }); // revision 2
    const h = await providerHash(f.accountId);
    const raw = await holdAccount(f.accountId);
    const call = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!], expectedRevision: 1 });
    await waitUntilBlocked();
    await dropPhone(f.accountId);
    await raw.commit();
    await expectError(call, 'STALE_REGISTRATION', 'STALE_REGISTRATION');
    expect(await providerHash(f.accountId)).toBe(h);
    expect(await selection(f.registrationId)).toEqual([]);
  });

  it('with a current revision and a lost contact the contact is what is refused (the revision check does not hide it)', async () => {
    const f = await started();
    await svc.selectMarket(f.accountId, { marketCode: f.market }); // revision 2
    const raw = await holdAccount(f.accountId);
    const call = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!], expectedRevision: 2 });
    await waitUntilBlocked();
    await dropPhone(f.accountId);
    await raw.commit();
    await expectError(call, 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
  });
});

// ====================================================================== 5d. the prerequisites of later checkpoints are read before the transaction
describe('submitRegistration: the prerequisite facts of later checkpoints are read before the transaction and its locks', () => {
  const recording = (statuses: Partial<Record<'verification' | 'subscription' | 'profile' | 'gigs', PrerequisiteState['status']>> = {}) => {
    const seen: { port: string; inTransaction: boolean }[] = [];
    const read = (port: 'verification' | 'subscription' | 'profile' | 'gigs') => async (): Promise<PrerequisiteState> => {
      seen.push({ port, inTransaction: iso.database.inTransaction });
      return { status: statuses[port] ?? 'NOT_AVAILABLE' } as PrerequisiteState;
    };
    const port: PrerequisitePort = { verification: read('verification'), subscription: read('subscription'), profile: read('profile'), gigs: read('gigs') };
    return { seen, port };
  };

  it('each of the four ports is read exactly once and never inside a database transaction', async () => {
    const f = await ready();
    const { seen, port } = recording();
    const done = await mkService({ prerequisites: port }).submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(done.changed).toBe(true);
    expect(seen.map((x) => x.port).sort()).toEqual(['gigs', 'profile', 'subscription', 'verification']);
    expect(seen.filter((x) => x.inTransaction)).toEqual([]);
  });

  it('they are read before the account lock is requested: while the submit waits for the account row, all four reads are already done', async () => {
    const f = await ready();
    const { seen, port } = recording({ verification: 'COMPLETE', subscription: 'IN_PROGRESS', profile: 'BLOCKED', gigs: 'NOT_STARTED' });
    const raw = await rawTx();
    await raw.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [f.accountId]);
    const call = mkService({ prerequisites: port }).submitRegistration(f.accountId, { expectedRevision: f.revision });
    await waitUntilBlocked();
    expect(seen.map((x) => x.port).sort()).toEqual(['gigs', 'profile', 'subscription', 'verification']);
    expect(seen.every((x) => !x.inTransaction)).toBe(true);
    await raw.commit();
    const done = await call;
    expect(done.changed).toBe(true);
    // the facts read before the transaction are the ones the result is evaluated with
    expect(done.requirements.steps.slice(5).map((s) => [s.step, s.status])).toEqual([
      ['VERIFICATION', 'COMPLETE'],
      ['SUBSCRIPTION', 'IN_PROGRESS'],
      ['PROFILE', 'BLOCKED'],
      ['GIGS', 'NOT_STARTED'],
    ]);
    expect(seen).toHaveLength(4);
  });

  it('a repeat submit on a COMPLETED registration reads them once more, outside the transaction as well', async () => {
    const f = await ready();
    const { seen, port } = recording();
    const s2 = mkService({ prerequisites: port });
    await s2.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const again = await s2.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(again.changed).toBe(false);
    expect(seen).toHaveLength(8);
    expect(seen.filter((x) => x.inTransaction)).toEqual([]);
  });
});

describe('an account that is not ACTIVE cannot change its registration', () => {
  it('a suspended account cannot choose a market, change its services, submit or cancel; nothing is written', async () => {
    const f = await ready({ count: 1 });
    await setAccountStatus(f.accountId, 'SUSPENDED');
    const h = await providerHash(f.accountId);
    const other = await mkOffer(await mkMarket('ACTIVE'), 1);
    await expectError(svc.selectMarket(f.accountId, { marketCode: other.market }), 'ACCOUNT_NOT_ACTIVE');
    await expectError(svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[1]!] }), 'ACCOUNT_NOT_ACTIVE');
    await expectError(svc.submitRegistration(f.accountId, { expectedRevision: f.revision }), 'ACCOUNT_NOT_ACTIVE');
    await expectError(svc.cancelRegistration(f.accountId), 'ACCOUNT_NOT_ACTIVE');
    expect(await providerHash(f.accountId)).toBe(h);
    // reading stays possible
    expect((await svc.getRegistration(f.accountId)).registration!.status).toBe('IN_PROGRESS');
    // and the account can continue once it is ACTIVE again
    await setAccountStatus(f.accountId, 'ACTIVE');
    expect((await svc.submitRegistration(f.accountId, { expectedRevision: f.revision })).changed).toBe(true);
  });
});

// ====================================================================== 6. cancel
describe('cancelRegistration', () => {
  it('cancels an IN_PROGRESS registration: CANCELLED, audit without any reason, cancelled event; the PENDING role, the customer side and the consent history are untouched', async () => {
    const f = await ready();
    const customer = await customerHash(f.accountId);
    const roleBefore = await roleRow(f.accountId);
    const identityBefore = await identityAudits(f.accountId);
    const grants = accounts.grants.length;
    const r = await runWithCorrelation('cid-cancel', () => svc.cancelRegistration(f.accountId));
    expect(r.changed).toBe(true);
    expect(regOf(r.state)).toMatchObject({ status: 'CANCELLED', attempt: 1, marketCode: f.market, serviceTypeCodes: f.offer.types.slice(0, 2) });
    expect(regOf(r.state).cancelledAt).not.toBeNull();
    expect(r.state.providerRole).toBe('PENDING');
    const row = (await regs(f.accountId))[0]!;
    expect(row).toMatchObject({ status: 'CANCELLED', completed_at: null, revision: f.revision, market_code: f.market });
    expect(row.cancelled_at).toBeInstanceOf(Date);
    expect(await selection(f.registrationId)).toEqual(f.offer.types.slice(0, 2));
    expect(await roleRow(f.accountId)).toEqual(roleBefore);
    expect(await identityAudits(f.accountId)).toEqual(identityBefore);
    expect(accounts.grants.length).toBe(grants);
    expect(await customerHash(f.accountId)).toBe(customer);
    const trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({
      action: 'PROVIDER_REGISTRATION_CANCELLED',
      actor: `account:${f.accountId}`,
      reason: null,
      correlation_id: 'cid-cancel',
      changes: { status: ['IN_PROGRESS', 'CANCELLED'] },
    });
    const events = await providerEvents(f.accountId);
    expect(events.at(-1)).toEqual({
      event_type: PROVIDER_EVENTS.registrationCancelled,
      event_version: 1,
      aggregate_type: 'provider_registration',
      aggregate_id: f.registrationId,
      actor_type: 'user',
      actor_id: `account:${f.accountId}`,
      payload_json: { accountId: f.accountId, providerRegistrationId: f.registrationId, attempt: 1 },
      correlation_id: 'cid-cancel',
    });
  });

  it('cancel takes no input: a free-text reason is refused (VALIDATION_FAILED) before anything is written, so it can never reach the immutable audit trail; the audit reason stays NULL', async () => {
    const f = await started();
    const h = await providerHash(f.accountId);
    const outbox = (await providerEvents(f.accountId)).length;
    for (const input of [{ reason: 'I changed my mind' }, { reason: '' }, { reason: null }, { note: 'x' }, 'because', null]) {
      const e = await expectError(svc.cancelRegistration(f.accountId, input), 'VALIDATION_FAILED', 'INVALID_REQUEST');
      expect(surface(e)).not.toContain('changed my mind');
      expect(surface(e)).not.toContain('because');
    }
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await providerEvents(f.accountId)).length).toBe(outbox);
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
    // an empty input (and no input) cancels, and the audit row has no reason
    await svc.cancelRegistration(f.accountId, {});
    const trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({ action: 'PROVIDER_REGISTRATION_CANCELLED', reason: null });
    expect(trail.every((a) => a.reason === null)).toBe(true);
    // the refusal is also decided before the registration is looked at: a cancelled one answers the same
    await expectError(svc.cancelRegistration(f.accountId, { reason: 'again' }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
  });

  it('is idempotent on a cancelled latest attempt: changed=false, the same view, nothing written', async () => {
    const f = await started();
    const first = await svc.cancelRegistration(f.accountId);
    const hash = await providerHash(f.accountId);
    const again = await svc.cancelRegistration(f.accountId, {});
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(first.state);
    expect(await providerHash(f.accountId)).toBe(hash);
  });

  it('a registration that was never started is REGISTRATION_NOT_FOUND; a COMPLETED one cannot be cancelled here and stays as it is', async () => {
    const none = await mkAccount();
    await expectError(svc.cancelRegistration(none), 'REGISTRATION_NOT_FOUND');
    const f = await ready();
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    const hash = await providerHash(f.accountId);
    await expectError(svc.cancelRegistration(f.accountId), 'REGISTRATION_NOT_IN_PROGRESS', 'REGISTRATION_NOT_IN_PROGRESS'); // decided by the service, not by the frozen-row guard (REGISTRATION_FROZEN)
    expect(await providerHash(f.accountId)).toBe(hash);
    expect((await roleRow(f.accountId))!.status).toBe('ACTIVE');
  });

  it('a restart creates attempt 2 with empty selections and no market, keeps the old attempt intact, and does not request the role again', async () => {
    const f = await ready({ count: 2 });
    await svc.cancelRegistration(f.accountId);
    const old = (await regs(f.accountId))[0]!;
    const oldSel = await selection(f.registrationId);
    const grants = accounts.grants.length;
    const r = await runWithCorrelation('cid-restart', () => svc.startRegistration(f.accountId));
    expect(r.created).toBe(true);
    expect(regOf(r.state)).toMatchObject({ attempt: 2, status: 'IN_PROGRESS', revision: 1, marketCode: null, serviceTypeCodes: [] });
    expect(regOf(r.state).providerRegistrationId).not.toBe(f.registrationId);
    expect(r.state.providerRole).toBe('PENDING');
    expect(accounts.grants.length).toBe(grants);
    const rows = await regs(f.accountId);
    expect(rows.map((x) => [x.attempt_number, x.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'IN_PROGRESS'],
    ]);
    expect(rows[0]).toEqual(old);
    expect(await selection(f.registrationId)).toEqual(oldSel);
    expect(await selection(regOf(r.state).providerRegistrationId)).toEqual([]);
    const trail = await audits(f.accountId);
    expect(trail.at(-1)).toMatchObject({
      action: 'PROVIDER_REGISTRATION_STARTED',
      provider_registration_id: regOf(r.state).providerRegistrationId,
      changes: { attempt: [null, 2], providerRole: ['PENDING', 'PENDING'] },
    });
    expect((await providerEvents(f.accountId)).at(-1)!.payload_json).toMatchObject({ attempt: 2 });
    // the new attempt runs the whole flow again, and a later cancel cancels attempt 2 only
    await svc.selectMarket(f.accountId, { marketCode: f.market });
    await svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[2]!] });
    await svc.cancelRegistration(f.accountId);
    expect((await regs(f.accountId)).map((x) => [x.attempt_number, x.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'CANCELLED'],
    ]);
    expect((await svc.startRegistration(f.accountId)).state.registration!.attempt).toBe(3);
  });

  it('a cancel that fails after the update (the event insert) restores the registration', async () => {
    const f = await ready();
    await failInsert(
      'integration.outbox_events',
      `NEW.event_type = '${PROVIDER_EVENTS.registrationCancelled}' AND NEW.payload_json->>'accountId' = '${f.accountId}'`,
    );
    const h = await providerHash(f.accountId);
    await err(svc.cancelRegistration(f.accountId));
    expect(await providerHash(f.accountId)).toBe(h);
    expect((await regs(f.accountId))[0]!.status).toBe('IN_PROGRESS');
  });
});

// ====================================================================== 7. consistency of an account's rows (used after every concurrent scenario)
interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}
const settle = async (ps: Promise<unknown>[]): Promise<Outcome[]> =>
  (await Promise.allSettled(ps)).map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
const codesOf = (os: Outcome[]): string[] =>
  os.map((o) => (o.ok ? 'ok' : o.error instanceof ProviderError ? o.error.code : `RAW:${String((o.error as Error)?.message)}`));
/** No call may leak a concurrency artefact: a deadlock, a serialization failure or a unique violation is never an acceptable answer. */
const expectNoLeak = (os: Outcome[]): void => {
  for (const o of os) {
    if (o.ok) continue;
    expect(o.error, String((o.error as Error)?.message)).toBeInstanceOf(ProviderError);
    const e = o.error as ProviderError;
    expect(e.details.reason, `${e.code} ${JSON.stringify(e.details)}`).not.toBe('CONCURRENT_UPDATE');
    expect(['CONFLICT', 'UNAVAILABLE']).not.toContain(e.code);
  }
};

/** The invariants every account's provider rows must satisfy, whatever interleaving produced them. */
async function expectConsistent(accountId: string): Promise<void> {
  const rows = await regs(accountId);
  expect(rows.map((r) => r.attempt_number)).toEqual(rows.map((_, i) => i + 1)); // contiguous from 1
  expect(rows.filter((r) => r.status !== 'CANCELLED').length).toBeLessThanOrEqual(1); // at most one live attempt
  const trail = await audits(accountId);
  const events = await providerEvents(accountId);
  for (const r of rows) {
    const mine = trail.filter((a) => a.provider_registration_id === r.provider_registration_id);
    const count = (action: string) => mine.filter((a) => a.action === action).length;
    expect(mine[0]?.action, `attempt ${r.attempt_number}`).toBe('PROVIDER_REGISTRATION_STARTED');
    expect(count('PROVIDER_REGISTRATION_STARTED')).toBe(1);
    expect(count('PROVIDER_REGISTRATION_COMPLETED')).toBe(r.status === 'COMPLETED' ? 1 : 0);
    expect(count('PROVIDER_REGISTRATION_CANCELLED')).toBe(r.status === 'CANCELLED' ? 1 : 0);
    expect(r.revision, `attempt ${r.attempt_number}`).toBe(1 + count('PROVIDER_MARKET_SELECTED') + count('PROVIDER_SERVICES_UPDATED'));
    const ev = (t: string) => events.filter((e) => e.event_type === t && e.aggregate_id === r.provider_registration_id);
    expect(ev(PROVIDER_EVENTS.registrationStarted)).toHaveLength(1);
    expect(ev(PROVIDER_EVENTS.registrationCompleted)).toHaveLength(r.status === 'COMPLETED' ? 1 : 0);
    expect(ev(PROVIDER_EVENTS.registrationCancelled)).toHaveLength(r.status === 'CANCELLED' ? 1 : 0);
    if (r.status === 'COMPLETED') {
      const payload = ev(PROVIDER_EVENTS.registrationCompleted)[0]!.payload_json;
      expect(payload.marketCode).toBe(r.market_code);
      expect(payload.serviceTypeCodes).toEqual(await selection(r.provider_registration_id));
      expect(payload.attempt).toBe(r.attempt_number);
    }
    // the chain of service audits: each change starts from the count the previous one ended with
    let count0 = 0;
    for (const a of mine.filter((x) => x.action === 'PROVIDER_SERVICES_UPDATED')) {
      const c = a.changes!.count as number[];
      expect(c[0]).toBe(count0);
      count0 = c[1]!;
    }
    if (r.status !== 'CANCELLED' || mine.some((x) => x.action === 'PROVIDER_SERVICES_UPDATED'))
      expect((await selection(r.provider_registration_id)).length).toBe(count0);
  }
  expect(events.filter((e) => e.event_type === PROVIDER_EVENTS.registrationStarted)).toHaveLength(rows.length);
  const role = await roleRow(accountId);
  expect(role, 'a registration exists, so the role was requested').toBeDefined();
  expect(role!.status).toBe(rows.some((r) => r.status === 'COMPLETED') ? 'ACTIVE' : 'PENDING');
  const ident = (await identityAudits(accountId)).filter((a) => a.action !== 'ROLE_GRANTED' || true).map((a) => a.action);
  expect(ident.filter((a) => a === 'ROLE_GRANTED')).toHaveLength(1);
  expect(ident.filter((a) => a === 'ROLE_ACTIVATED')).toHaveLength(rows.some((r) => r.status === 'COMPLETED') ? 1 : 0);
}

// ====================================================================== 8. concurrency
describe('concurrency (real transactions)', () => {
  it('30 simultaneous starts of one account give exactly one registration, one role request, one audit row and one event (6 rounds, no deadlock)', async () => {
    for (let round = 0; round < 6; round++) {
      const accountId = await mkAccount();
      const grants = accounts.grants.length;
      const os = await settle(Array.from({ length: 30 }, () => svc.startRegistration(accountId)));
      expect(codesOf(os), `round ${round}`).toEqual(Array(30).fill('ok'));
      const results = os.map((o) => o.value as Awaited<ReturnType<typeof svc.startRegistration>>);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.state.registration!.providerRegistrationId)).size).toBe(1);
      expect(new Set(results.map((r) => r.state.providerRole))).toEqual(new Set(['PENDING']));
      expect(await regs(accountId)).toHaveLength(1);
      expect(accounts.grants.length - grants).toBe(1);
      expect((await audits(accountId)).map((a) => a.action)).toEqual(['PROVIDER_REGISTRATION_STARTED']);
      expect(await providerEvents(accountId)).toHaveLength(1);
      expect((await identityAudits(accountId)).map((a) => a.action)).toEqual(['ROLE_GRANTED']);
      await expectConsistent(accountId);
    }
  });

  it('30 simultaneous starts after a cancellation give exactly one new attempt', async () => {
    const f = await started();
    await svc.cancelRegistration(f.accountId);
    const os = await settle(Array.from({ length: 30 }, () => svc.startRegistration(f.accountId)));
    expect(codesOf(os)).toEqual(Array(30).fill('ok'));
    expect(os.filter((o) => (o.value as { created: boolean }).created)).toHaveLength(1);
    expect((await regs(f.accountId)).map((r) => [r.attempt_number, r.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'IN_PROGRESS'],
    ]);
    await expectConsistent(f.accountId);
  });

  it('start against cancel, from both an untouched account and one with a cancelled attempt: either order, never an inconsistent state', async () => {
    for (let round = 0; round < 8; round++) {
      const fresh = await mkAccount();
      const start = svc.startRegistration(fresh);
      const cancel = svc.cancelRegistration(fresh);
      const os = await settle(round % 2 === 0 ? [start, cancel] : [cancel, start]);
      expectNoLeak(os);
      const [s, c] = round % 2 === 0 ? os : [os[1]!, os[0]!];
      expect(s!.ok).toBe(true);
      if (!c!.ok) expect((c!.error as ProviderError).code).toBe('REGISTRATION_NOT_FOUND');
      const rows = await regs(fresh);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(c!.ok ? 'CANCELLED' : 'IN_PROGRESS');
      await expectConsistent(fresh);

      const again = await started();
      await svc.cancelRegistration(again.accountId);
      const os2 = await settle(
        round % 2 === 0
          ? [svc.startRegistration(again.accountId), svc.cancelRegistration(again.accountId)]
          : [svc.cancelRegistration(again.accountId), svc.startRegistration(again.accountId)],
      );
      expectNoLeak(os2);
      expect(os2.every((o) => o.ok)).toBe(true);
      const statuses = (await regs(again.accountId)).map((r) => r.status);
      expect([
        ['CANCELLED', 'IN_PROGRESS'],
        ['CANCELLED', 'CANCELLED'],
      ]).toContainEqual(statuses);
      await expectConsistent(again.accountId);
    }
  });

  it('submit against a services replace: either the submit completes the old selection and the replace is refused, or the replace wins and the submit is stale; the completed event always matches the rows (8 rounds)', async () => {
    for (let round = 0; round < 8; round++) {
      const f = await ready({ count: 1, types: 3 });
      const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
      const replace = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[1]!, f.offer.types[2]!] });
      const os = await settle(round % 2 === 0 ? [submit, replace] : [replace, submit]);
      expectNoLeak(os);
      const [s, r] = round % 2 === 0 ? os : [os[1]!, os[0]!];
      const row = (await regs(f.accountId))[0]!;
      if (s!.ok) {
        expect(row.status).toBe('COMPLETED');
        expect(r!.ok).toBe(false);
        expect((r!.error as ProviderError).code).toBe('REGISTRATION_NOT_IN_PROGRESS');
        expect(await selection(f.registrationId)).toEqual([f.offer.types[0]]);
      } else {
        expect((s!.error as ProviderError).code).toBe('STALE_REGISTRATION');
        expect(r!.ok).toBe(true);
        expect(row.status).toBe('IN_PROGRESS');
        expect(await selection(f.registrationId)).toEqual([f.offer.types[1], f.offer.types[2]]);
      }
      await expectConsistent(f.accountId);
    }
  });

  it('two simultaneous replaces that name the same revision: exactly one wins, the other is STALE_REGISTRATION (8 rounds)', async () => {
    for (let round = 0; round < 8; round++) {
      const f = await started({ types: 4 });
      const s = await svc.selectMarket(f.accountId, { marketCode: f.market });
      const rev = regOf(s).revision;
      const setA = [f.offer.types[0]!, f.offer.types[1]!];
      const setB = [f.offer.types[2]!, f.offer.types[3]!];
      const os = await settle([
        svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: setA, expectedRevision: rev }),
        svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: setB, expectedRevision: rev }),
      ]);
      expectNoLeak(os);
      expect(codesOf(os).sort()).toEqual(['STALE_REGISTRATION', 'ok']);
      const winner = os[0]!.ok ? setA : setB;
      expect(await selection(f.registrationId)).toEqual(sortC(winner));
      expect((await regs(f.accountId))[0]!.revision).toBe(rev + 1);
      await expectConsistent(f.accountId);
    }
  });

  it('two simultaneous replaces without a revision are serialized: both succeed, the audit chain is unbroken and the last one decides', async () => {
    for (let round = 0; round < 6; round++) {
      const f = await started({ types: 4 });
      await svc.selectMarket(f.accountId, { marketCode: f.market });
      const setA = [f.offer.types[0]!, f.offer.types[1]!];
      const setB = [f.offer.types[2]!];
      const os = await settle([
        svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: setA }),
        svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: setB }),
      ]);
      expectNoLeak(os);
      expect(codesOf(os)).toEqual(['ok', 'ok']);
      const final = await selection(f.registrationId);
      expect([sortC(setA), sortC(setB)]).toContainEqual(final);
      expect((await regs(f.accountId))[0]!.revision).toBe(4);
      await expectConsistent(f.accountId);
    }
  });

  it('10 simultaneous submits complete once: one change, nine repeats, one audit row, one event, one role activation (4 rounds)', async () => {
    for (let round = 0; round < 4; round++) {
      const f = await ready({ count: 2 });
      const grants = accounts.grants.length;
      const os = await settle(Array.from({ length: 10 }, () => svc.submitRegistration(f.accountId, { expectedRevision: f.revision })));
      expectNoLeak(os);
      expect(codesOf(os)).toEqual(Array(10).fill('ok'));
      expect(os.filter((o) => (o.value as { changed: boolean }).changed)).toHaveLength(1);
      expect(accounts.grants.length - grants).toBe(1);
      expect((await audits(f.accountId)).filter((a) => a.action === 'PROVIDER_REGISTRATION_COMPLETED')).toHaveLength(1);
      expect(await identityEvents(f.accountId)).toHaveLength(1);
      await expectConsistent(f.accountId);
    }
  });

  it('submit against a market change: the submit completes the market it saw, or the change wins and the submit is stale; never a mix (8 rounds)', async () => {
    for (let round = 0; round < 8; round++) {
      const f = await ready({ count: 1 });
      const other = await mkOffer(await mkMarket('ACTIVE'), 1);
      const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
      const change = svc.selectMarket(f.accountId, { marketCode: other.market });
      const os = await settle(round % 2 === 0 ? [submit, change] : [change, submit]);
      expectNoLeak(os);
      const [s, c] = round % 2 === 0 ? os : [os[1]!, os[0]!];
      const row = (await regs(f.accountId))[0]!;
      if (s!.ok) {
        expect(row).toMatchObject({ status: 'COMPLETED', market_code: f.market });
        expect((c!.error as ProviderError).code).toBe('REGISTRATION_NOT_IN_PROGRESS');
      } else {
        expect((s!.error as ProviderError).code).toBe('STALE_REGISTRATION');
        expect(c!.ok).toBe(true);
        expect(row).toMatchObject({ status: 'IN_PROGRESS', market_code: other.market });
      }
      await expectConsistent(f.accountId);
    }
  });

  it('submit against cancel: exactly one of COMPLETED / CANCELLED, the role follows the winner (8 rounds)', async () => {
    for (let round = 0; round < 8; round++) {
      const f = await ready({ count: 1 });
      const submit = svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
      const cancel = svc.cancelRegistration(f.accountId);
      const os = await settle(round % 2 === 0 ? [submit, cancel] : [cancel, submit]);
      expectNoLeak(os);
      const [s, c] = round % 2 === 0 ? os : [os[1]!, os[0]!];
      expect(s!.ok !== c!.ok).toBe(true);
      const row = (await regs(f.accountId))[0]!;
      if (s!.ok) {
        expect(row.status).toBe('COMPLETED');
        expect((c!.error as ProviderError).code).toBe('REGISTRATION_NOT_IN_PROGRESS');
        expect((await roleRow(f.accountId))!.status).toBe('ACTIVE');
      } else {
        expect(row.status).toBe('CANCELLED');
        expect((s!.error as ProviderError).code).toBe('REGISTRATION_NOT_FOUND');
        expect((await roleRow(f.accountId))!.status).toBe('PENDING');
      }
      await expectConsistent(f.accountId);
    }
  });

  it('a restart, a cancel and a second restart racing after a cancellation: the first attempt is never touched again, the others are consistent (6 rounds)', async () => {
    for (let round = 0; round < 6; round++) {
      const f = await started();
      await svc.cancelRegistration(f.accountId);
      const first = (await regs(f.accountId))[0]!;
      const os = await settle([svc.startRegistration(f.accountId), svc.cancelRegistration(f.accountId), svc.startRegistration(f.accountId)]);
      expectNoLeak(os);
      expect(os.every((o) => o.ok)).toBe(true);
      const rows = await regs(f.accountId);
      expect(rows[0]).toEqual(first);
      // the cancel hit the new attempt (then a second restart made a third) or found nothing to do (idempotent on attempt 1)
      expect([2, 3]).toContain(rows.length);
      await expectConsistent(f.accountId);
    }
  });

  it('a retirement of a selected service type that is still uncommitted holds a concurrent services replace back, which then fails closed (no deadlock)', async () => {
    const f = await started({ types: 3 });
    await svc.selectMarket(f.accountId, { marketCode: f.market });
    const raw = await rawTx();
    await raw.query("UPDATE catalog.service_types SET status = 'RETIRED' WHERE code = $1", [f.offer.types[1]!]);
    const call = svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: [f.offer.types[0]!, f.offer.types[1]!] });
    await waitUntilBlocked();
    await raw.commit();
    await expectError(call, 'SERVICE_TYPE_NOT_ELIGIBLE', 'SERVICE_TYPE_RETIRED');
    await expectConsistent(f.accountId);
  });

  it('a storm of mixed operations on one account settles (no deadlock, no leaked conflict) and leaves consistent rows (5 rounds of 40 operations)', async () => {
    for (let round = 0; round < 5; round++) {
      const f = await started({ types: 4 });
      const other = await mkOffer(await mkMarket('ACTIVE'), 2);
      const ops: (() => Promise<unknown>)[] = [];
      for (let i = 0; i < 40; i++) {
        const k = (i * 7 + round * 3) % 8;
        ops.push(
          k === 0
            ? () => svc.startRegistration(f.accountId)
            : k === 1
              ? () => svc.cancelRegistration(f.accountId)
              : k === 2
                ? () => svc.selectMarket(f.accountId, { marketCode: i % 2 ? f.market : other.market })
                : k === 3
                  ? () => svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: f.offer.types.slice(0, 1 + (i % 3)) })
                  : k === 4
                    ? () => svc.submitRegistration(f.accountId, { expectedRevision: 1 + (i % 4) })
                    : k === 5
                      ? () => svc.getRequirements(f.accountId)
                      : k === 6
                        ? () => svc.getRegistration(f.accountId)
                        : () => svc.startRegistration(f.accountId),
        );
      }
      const os = await settle(ops.map((op) => op()));
      expectNoLeak(os);
      for (const o of os.filter((x) => !x.ok))
        expect([
          'REGISTRATION_NOT_FOUND',
          'REGISTRATION_NOT_IN_PROGRESS',
          'STALE_REGISTRATION',
          'SERVICE_TYPE_NOT_ELIGIBLE',
          'REGISTRATION_INCOMPLETE',
          'MARKET_REQUIRED',
          'SERVICE_TYPE_NOT_ELIGIBLE',
          'MARKET_NOT_ELIGIBLE',
        ]).toContain((o.error as ProviderError).code);
      await expectConsistent(f.accountId);
    }
  }, 120_000);

  it('many accounts at once do not block each other (20 accounts x full flow in parallel)', async () => {
    const offer = await mkOffer(await mkMarket('ACTIVE'), 3);
    const flows = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const accountId = await mkAccount();
        await svc.startRegistration(accountId);
        await svc.selectMarket(accountId, { marketCode: offer.market });
        const st = await svc.replaceServiceTypes(accountId, { serviceTypeCodes: offer.types.slice(0, 2) });
        const done = await svc.submitRegistration(accountId, { expectedRevision: regOf(st).revision });
        return { accountId, done };
      }),
    );
    for (const { accountId, done } of flows) {
      expect(done.changed).toBe(true);
      await expectConsistent(accountId);
    }
  }, 60_000);
});

// ====================================================================== 9. owner isolation
describe('owner isolation: an operation for one account never reads or writes the rows of another', () => {
  it('a full life cycle of account A leaves every provider and customer row of account B byte for byte as it was', async () => {
    const shared = await mkOffer(await mkMarket('ACTIVE'), 4);
    const b = await ready({ market: shared, count: 2 });
    const done = await ready({ market: shared, count: 2 });
    await svc.submitRegistration(done.accountId, { expectedRevision: done.revision });
    const hashes = async () => [
      await providerHash(b.accountId),
      await customerHash(b.accountId),
      await providerHash(done.accountId),
      await customerHash(done.accountId),
    ];
    const before = await hashes();

    const a = await mkAccount();
    await svc.startRegistration(a);
    await svc.selectMarket(a, { marketCode: shared.market });
    await svc.replaceServiceTypes(a, { serviceTypeCodes: [shared.types[2]!, shared.types[3]!] });
    await svc.replaceServiceTypes(a, { serviceTypeCodes: [shared.types[0]!] });
    await svc.getRequirements(a);
    await svc.getRegistration(a);
    const ra = (await svc.getRegistration(a)).registration!;
    expect(ra.serviceTypeCodes).toEqual([shared.types[0]]);
    expect([b.registrationId, done.registrationId]).not.toContain(ra.providerRegistrationId);
    await svc.submitRegistration(a, { expectedRevision: ra.revision });
    await expectError(svc.cancelRegistration(a), 'REGISTRATION_NOT_IN_PROGRESS');
    const a2 = await mkAccount();
    await svc.startRegistration(a2);
    await svc.cancelRegistration(a2);
    await svc.startRegistration(a2);
    await svc.selectMarket(a2, { marketCode: shared.market });
    await svc.cancelRegistration(a2);
    expect(await hashes()).toEqual(before);
    // and B still answers with its own rows
    expect((await svc.getRegistration(b.accountId)).registration).toMatchObject({
      providerRegistrationId: b.registrationId,
      status: 'IN_PROGRESS',
      serviceTypeCodes: shared.types.slice(0, 2),
    });
    expect((await svc.getRegistration(done.accountId)).registration).toMatchObject({ providerRegistrationId: done.registrationId, status: 'COMPLETED' });
  });

  it('an account without a registration never sees, changes or cancels the registration of another', async () => {
    const shared = await mkOffer(await mkMarket('ACTIVE'), 2);
    const other = await ready({ market: shared, count: 1 });
    const c = await mkAccount();
    const before = await providerHash(other.accountId);
    expect(await svc.getRegistration(c)).toEqual({ providerRole: 'NONE', registration: null });
    expect((await svc.getRequirements(c)).registration).toBeNull();
    await expectError(svc.selectMarket(c, { marketCode: shared.market }), 'REGISTRATION_NOT_FOUND');
    await expectError(svc.replaceServiceTypes(c, { serviceTypeCodes: [shared.types[0]!] }), 'REGISTRATION_NOT_FOUND');
    await expectError(svc.submitRegistration(c, { expectedRevision: other.revision }), 'REGISTRATION_NOT_FOUND');
    await expectError(svc.cancelRegistration(c), 'REGISTRATION_NOT_FOUND');
    expect(await providerHash(other.accountId)).toBe(before);
    expect(await regs(c)).toEqual([]);
  });

  it('two accounts choosing the same market and the same service types each keep their own selection, audit and events', async () => {
    const shared = await mkOffer(await mkMarket('ACTIVE'), 3);
    const a = await ready({ market: shared, count: 2 });
    const b = await ready({ market: shared, count: 2 });
    await svc.replaceServiceTypes(b.accountId, { serviceTypeCodes: [shared.types[2]!] });
    expect(await selection(a.registrationId)).toEqual(shared.types.slice(0, 2));
    expect(await selection(b.registrationId)).toEqual([shared.types[2]]);
    expect((await audits(a.accountId)).filter((x) => x.action === 'PROVIDER_SERVICES_UPDATED')).toHaveLength(1);
    expect((await audits(b.accountId)).filter((x) => x.action === 'PROVIDER_SERVICES_UPDATED')).toHaveLength(2);
    await svc.submitRegistration(a.accountId, { expectedRevision: a.revision });
    expect((await regs(b.accountId))[0]!.status).toBe('IN_PROGRESS');
    expect((await roleRow(b.accountId))!.status).toBe('PENDING');
    await expectConsistent(a.accountId);
    await expectConsistent(b.accountId);
  });

  it('the account id of the call decides everything: the consent, the account facts and the role grant are all asked for that account only', async () => {
    const f = await ready();
    const other = await mkAccount();
    const c0 = consent.calls.length;
    const g0 = accounts.grants.length;
    await svc.submitRegistration(f.accountId, { expectedRevision: f.revision });
    expect(consent.calls.slice(c0).map((c) => c.accountId)).toEqual([f.accountId]);
    expect(accounts.grants.slice(g0).map((g) => g.accountId)).toEqual([f.accountId]);
    expect(await roleRow(other)).toBeUndefined();
  });
});

// ====================================================================== 10. the service inside a caller's transaction
describe('the service joins the transaction of its caller', () => {
  it('start, market, services and cancel inside a caller transaction are visible to it, invisible outside, and vanish when the caller rolls back', async () => {
    const accountId = await mkAccount();
    const offer = await mkOffer(await mkMarket('ACTIVE'), 2);
    const stop = new Error('rollback on purpose');
    const t0 = transactionsOpened;
    const failure = await rejection(
      iso.database.transaction(async (trx) => {
        await svc.startRegistration(accountId);
        await svc.selectMarket(accountId, { marketCode: offer.market });
        const st = await svc.replaceServiceTypes(accountId, { serviceTypeCodes: offer.types });
        expect(regOf(st).revision).toBe(3);
        expect((await svc.getRegistration(accountId)).registration!.serviceTypeCodes).toEqual(offer.types);
        const inside = (await sql<Row>`SELECT count(*)::int AS n FROM provider.registrations WHERE account_id = ${accountId}`.execute(trx)).rows[0]!.n;
        expect(inside).toBe(1);
        expect(await regs(accountId)).toEqual([]); // another session sees nothing yet
        expect(await roleRow(accountId)).toBeUndefined();
        await svc.cancelRegistration(accountId);
        throw stop;
      }),
    );
    expect(failure).toBe(stop);
    expect(transactionsOpened - t0).toBe(1);
    expect(await regs(accountId)).toEqual([]);
    expect(await roleRow(accountId)).toBeUndefined();
    expect(await audits(accountId)).toEqual([]);
    expect(await providerEvents(accountId)).toEqual([]);
    expect(await identityAudits(accountId)).toEqual([]);
  });

  it("commits atomically with the caller's own write, and rolls back with it", async () => {
    const accountId = await mkAccount();
    const marker = (kind: string) =>
      q<{ n: number }>(`SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'bananagig.test.marker.v1' AND aggregate_id = $1`, [
        kind,
      ]).then((r) => r[0]!.n);
    const writeMarker = (trx: Parameters<Parameters<Database['transaction']>[0]>[0], kind: string) =>
      insertOutboxEvent(trx, { aggregateType: 'test', aggregateId: kind, eventType: 'bananagig.test.marker.v1', correlationId: 'marker', payload: {} });
    const stop = new Error('no');
    await rejection(
      iso.database.transaction(async (trx) => {
        await writeMarker(trx, `${accountId}-rolled`);
        await svc.startRegistration(accountId);
        throw stop;
      }),
    );
    expect(await marker(`${accountId}-rolled`)).toBe(0);
    expect(await regs(accountId)).toEqual([]);
    await iso.database.transaction(async (trx) => {
      await writeMarker(trx, `${accountId}-kept`);
      await svc.startRegistration(accountId);
    });
    expect(await marker(`${accountId}-kept`)).toBe(1);
    expect(await regs(accountId)).toHaveLength(1);
    await expectConsistent(accountId);
  });

  it('opens no transaction of its own inside a caller transaction, and exactly one outside', async () => {
    const accountId = await mkAccount();
    const offer = await mkOffer(await mkMarket('ACTIVE'), 2);
    const inside = await counting(() => iso.database.transaction(async () => svc.startRegistration(accountId)));
    expect(inside.tx).toBe(1);
    const outside = await counting(() => svc.selectMarket(accountId, { marketCode: offer.market }));
    expect(outside.tx).toBe(1);
  });

  it('a submit inside a caller transaction cannot run: the consent snapshot cannot nest, and nothing is completed', async () => {
    const f = await ready();
    const h = await providerHash(f.accountId);
    const e = await err(iso.database.transaction(async () => svc.submitRegistration(f.accountId, { expectedRevision: f.revision })));
    expect(e).toBeInstanceOf(TransactionOptionError);
    expect(await providerHash(f.accountId)).toBe(h);
  });
});

// ====================================================================== 11. query counts
describe('query counts (statements issued by the service; the ports are faked and counted separately)', () => {
  it('getRegistration: one statement with the facts supplied, one more PORT statement without them', async () => {
    const f = await ready();
    const facts = await accounts.facts(f.accountId);
    const supplied = await counting(() => svc.getRegistration(f.accountId, { facts }));
    expect(supplied.svc).toHaveLength(1);
    expect(supplied.port).toHaveLength(0);
    expect(supplied.tx).toBe(0);
    const asked = await counting(() => svc.getRegistration(f.accountId));
    expect(asked.svc).toHaveLength(1);
    expect(asked.port).toHaveLength(1);
    expect(asked.tx).toBe(0);
    expect(asked.result).toEqual(supplied.result);
  });

  it('getRegistration for an account without a registration is still one statement', async () => {
    const a = await mkAccount();
    const facts = await accounts.facts(a);
    const r = await counting(() => svc.getRegistration(a, { facts }));
    expect(r.svc).toHaveLength(1);
  });

  it('getRequirements with a market chosen: one statement of the service, one account read (skipped when the facts are supplied), one policy read, one consent evaluation, one market lookup, one catalogue read', async () => {
    const f = await ready();
    const facts = await accounts.facts(f.accountId);
    const marks = () => ({
      consent: consent.calls.length,
      markets: markets.lookups.length,
      catalog: catalog.asked.length,
      facts: accounts.factsCalls,
      policy: policyProvider.reads,
    });
    const delta = (a: ReturnType<typeof marks>, b: ReturnType<typeof marks>) =>
      Object.fromEntries(Object.keys(a).map((k) => [k, b[k as keyof typeof b] - a[k as keyof typeof a]]));

    let m0 = marks();
    const supplied = await counting(() => svc.getRequirements(f.accountId, { facts }));
    expect(delta(m0, marks())).toEqual({ consent: 1, markets: 1, catalog: 1, facts: 0, policy: 1 });
    expect(supplied.svc).toHaveLength(1);
    expect(supplied.port).toHaveLength(2); // the market lookup and the catalogue read (the consent fake issues none)
    expect(supplied.tx).toBe(1); // the consent snapshot of the port; the service opens none

    m0 = marks();
    const asked = await counting(() => svc.getRequirements(f.accountId));
    expect(delta(m0, marks())).toEqual({ consent: 1, markets: 1, catalog: 1, facts: 1, policy: 1 });
    expect(asked.svc).toHaveLength(1);
    expect(asked.port).toHaveLength(3);
    expect(asked.tx).toBe(1);
    expect(asked.result).toEqual(supplied.result);
  });

  it('getRequirements without a market and without a provider role asks neither the market, the catalogue nor the consent', async () => {
    const a = await mkAccount();
    const m0 = { consent: consent.calls.length, markets: markets.lookups.length, catalog: catalog.asked.length };
    const r = await counting(() => svc.getRequirements(a));
    expect(consent.calls.length - m0.consent).toBe(0);
    expect(markets.lookups.length - m0.markets).toBe(0);
    expect(catalog.asked.length - m0.catalog).toBe(0);
    expect(r.svc).toHaveLength(1);
    const f = await started();
    const m1 = { consent: consent.calls.length, markets: markets.lookups.length, catalog: catalog.asked.length };
    await svc.getRequirements(f.accountId);
    expect(consent.calls.length - m1.consent).toBe(1);
    expect(markets.lookups.length - m1.markets).toBe(0);
    expect(catalog.asked.length - m1.catalog).toBe(0);
  });

  it('the statement count of a write does not grow with the number of selected service types', async () => {
    const f = await started({ types: 8 });
    await svc.selectMarket(f.accountId, { marketCode: f.market });
    const small = await counting(() => svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: f.offer.types.slice(0, 1) }));
    const big = await counting(() => svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: f.offer.types }));
    const shrink = await counting(() => svc.replaceServiceTypes(f.accountId, { serviceTypeCodes: f.offer.types.slice(0, 2) }));
    expect(Math.abs(big.svc.length - small.svc.length)).toBeLessThanOrEqual(1);
    expect(shrink.svc.length).toBeLessThanOrEqual(small.svc.length + 1);
    const req1 = await counting(() => svc.getRequirements(f.accountId));
    const f2 = await ready({ types: 8, count: 8 });
    const req8 = await counting(() => svc.getRequirements(f2.accountId));
    expect(req8.svc.length).toBe(req1.svc.length);
  });

  it('PINNED statement counts of each operation (transaction control excluded; the ports are counted apart, and so is the consent snapshot)', async () => {
    const accountId = await mkAccount();
    const offer = await mkOffer(await mkMarket('ACTIVE'), 3);
    const run = async <T>(fn: () => Promise<T>) => {
      const c0 = consent.calls.length;
      const r = await counting(fn);
      return { ...r, serviceTx: r.tx - (consent.calls.length - c0) };
    };
    const start = await run(() => svc.startRegistration(accountId));
    const resume = await run(() => svc.startRegistration(accountId));
    const market = await run(() => svc.selectMarket(accountId, { marketCode: offer.market }));
    const sameMarket = await run(() => svc.selectMarket(accountId, { marketCode: offer.market }));
    const replace = await run(() => svc.replaceServiceTypes(accountId, { serviceTypeCodes: offer.types.slice(0, 2) }));
    const sameSet = await run(() => svc.replaceServiceTypes(accountId, { serviceTypeCodes: offer.types.slice(0, 2) }));
    const rev = regOf(replace.result).revision;
    const submit = await run(() => svc.submitRegistration(accountId, { expectedRevision: rev }));
    const again = await run(() => svc.submitRegistration(accountId, { expectedRevision: rev }));
    const cancelAccount = (await started()).accountId;
    const cancel = await run(() => svc.cancelRegistration(cancelAccount));
    const cancelAgain = await run(() => svc.cancelRegistration(cancelAccount));
    const pinned = {
      start: start.svc.length,
      resume: resume.svc.length,
      market: market.svc.length,
      sameMarket: sameMarket.svc.length,
      replace: replace.svc.length,
      sameSet: sameSet.svc.length,
      submit: submit.svc.length,
      again: again.svc.length,
      cancel: cancel.svc.length,
      cancelAgain: cancelAgain.svc.length,
      serviceTransactions: [start, resume, market, sameMarket, replace, sameSet, submit, again, cancel, cancelAgain].map((x) => x.serviceTx),
    };
    expect(pinned).toEqual({
      start: 7,
      resume: 3,
      market: 7,
      sameMarket: 4,
      replace: 7,
      sameSet: 3,
      submit: 9,
      again: 4,
      cancel: 7,
      cancelAgain: 3,
      serviceTransactions: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
  });
});

// ====================================================================== 12. privacy, logs, outages
describe('privacy and outages', () => {
  it('audit changes and event payloads hold only identifiers, codes, statuses and counts: no contact, no name, no text of the caller', async () => {
    const f = await ready({ count: 2 });
    // a free-text reason is refused, so it is never stored anywhere
    await expectError(svc.cancelRegistration(f.accountId, { reason: 'private reason text' }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    await svc.cancelRegistration(f.accountId);
    const done = await ready();
    await svc.submitRegistration(done.accountId, { expectedRevision: done.revision });
    const allowed = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|account:[0-9a-f-]{36}|[A-Z][A-Z_]*|[a-z][a-z0-9_-]*)$/;
    const walk = (v: unknown, where: string): void => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
      if (typeof v === 'string') return void expect(v, where).toMatch(allowed);
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
      for (const [k, x] of Object.entries(v as object)) walk(x, `${where}.${k}`);
    };
    for (const id of [f.accountId, done.accountId]) {
      for (const a of await audits(id)) {
        if (a.changes) walk(a.changes, `audit ${a.action}`);
        expect(a.actor).toBe(`account:${id}`);
      }
      for (const e of await providerEvents(id)) {
        walk(e.payload_json, `event ${e.event_type}`);
        expect(JSON.stringify(e.payload_json)).not.toMatch(/@|\+1555|canary|example\.test|private reason/);
      }
    }
    // no free text of a caller is persisted: the audit `reason` of every provider audit row is NULL and the refused text is nowhere in the audit trail or the outbox
    const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM provider.audit_events WHERE reason IS NOT NULL`);
    expect(rows[0]!.n).toBe(0);
    const stored = await q<{ n: number }>(
      `SELECT (SELECT count(*) FROM provider.audit_events a WHERE a::text LIKE '%private reason%')::int + (SELECT count(*) FROM integration.outbox_events e WHERE e::text LIKE '%private reason%')::int AS n`,
    );
    expect(stored[0]!.n).toBe(0);
  });

  it('nothing was written to the log by the whole run so far: no contact, no token, no account id, no reason text', async () => {
    const text = logSink.lines.join('\n');
    expect(logSink.lines).toEqual([]);
    expect(text).not.toMatch(/canary|example\.test|\+1555|private reason/);
  });

  it('a database outage is UNAVAILABLE with a fixed message, logged once, and the log line carries no account id, contact or SQL', async () => {
    const dead = createDatabase('postgres://nobody:nopass@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 400, poolMax: 2 } });
    try {
      const deadSvc = mkService({ database: dead });
      const accountId = await mkAccount();
      const facts = await accounts.facts(accountId);
      logSink.lines.length = 0;
      const e = await expectError(deadSvc.getRegistration(accountId, { facts }), 'UNAVAILABLE');
      expect(e.message).toBe('the provider registration is unavailable');
      expect(e.details).toEqual({});
      const s = await expectError(deadSvc.startRegistration(accountId), 'UNAVAILABLE');
      expect(surface(s)).not.toMatch(/127\.0\.0\.1|nobody|ECONN/);
      expect(logSink.lines.length).toBeGreaterThanOrEqual(2);
      for (const line of logSink.lines) {
        const l = JSON.parse(line);
        expect(l).toMatchObject({ level: 'error', message: 'provider registration database unavailable' });
        expect(line).not.toContain(accountId);
        expect(line).not.toMatch(/canary|example\.test|SELECT|INSERT|nopass/i);
      }
    } finally {
      logSink.lines.length = 0;
      await dead.close().catch(() => undefined);
    }
  });
});
