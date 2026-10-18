import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GIG_ERROR_CODES,
  GIG_EVENTS,
  GIG_ISSUE_REASONS,
  GIG_STATUSES,
  GIG_VERSION_STATUSES,
  PROVIDER_GIG_POLICY_KEYS,
  ProviderGigPolicy,
  gigErrorKey,
  gigIssueKey,
  gigStatusKey,
  gigVersionStatusKey,
  isGigStatusTransitionAllowed,
  isGigVersionStatusTransitionAllowed,
} from '../../contracts/src/gig';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0020 (CAT-003, provider Gigs) adds four tables to the `provider` schema: provider.gigs (the identity of a Gig), provider.gig_versions (immutable versions bound to the EXACT
// catalog.gig_template_versions row), provider.gig_version_field_values (one typed value per version and template field) and provider.gig_audit_events (immutable audit), with four row
// guards (SQLSTATE 23000, DETAIL provider_rule:<KEY>), one cross-table content function, one deferred commit-time invariant and the TRUNCATE refusals, plus two seeds through the real
// workflows: five Gig policy parameters (configuration) and 107 managed copy entries (content). No Gig is seeded.
// These tests drive the REAL tables with raw SQL on an isolated database: the exact shape, the seeds (resolved through the contract), every CHECK, every guard rule on the exact failing
// statement, the status matrices against the contract, the one-draft / one-published rule, contiguous numbers, frozen published versions, typed field values, the price currency and
// duration guards, audit immutability, and the interleavings that matter under real concurrency (lock waiters polled in pg_stat_activity, then simultaneous races). The catalogue rows
// the Gigs stand on are created with session_replication_role = replica (the catalogue guards and its publication workflow are covered by the CAT-001/002 model tests); every provider
// row is created with the guards ON. The service is covered in packages/provider and the API in apps/api.
let iso: IsolatedDatabase;
let pool: pg.Pool;
let racePool: pg.Pool;
let seq = 0;
let laOc: string; // the seeded market la-oc (currency USD)
let eurMarket: string; // a market whose currency is EUR
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  laOc = ((await pool.query("SELECT market_id FROM geography.markets WHERE code = 'la-oc'")).rows[0] as { market_id: string }).market_id;
  await replica(async (c) => {
    await c.query(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, status) VALUES ('EUR', '978', 2, 'Euro', 'ACTIVE')",
    );
    const m = await c.query(
      `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT 'gig-eur', 'gig-eur', country_id, 'PLANNED', 'en-US', 'EUR', default_time_zone_id, now() FROM geography.markets WHERE code = 'la-oc' RETURNING market_id`,
    );
    eurMarket = (m.rows[0] as { market_id: string }).market_id;
  });
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await iso?.drop();
});

// ---------------------------------------------------------------- helpers
type Db = pg.Pool | pg.PoolClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], from: Db = pool): Promise<T[]> =>
  (await from.query(sql, params)).rows as T[];
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
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** The statement is refused by a guard with exactly this rule key (SQLSTATE 23000, DETAIL provider_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `provider_rule:${key}` });
};
/** The statement is refused by a named constraint with the SQLSTATE of its kind (check 23514, foreign key 23503, unique 23505). */
const expectConstraint = async (p: Promise<unknown>, constraint: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, constraint: e.constraint }).toEqual({
    code: constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505',
    constraint,
  });
};
const outcomeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  if (!e) return 'ACCEPTED';
  return e.detail?.startsWith('provider_rule:') ? e.detail.slice('provider_rule:'.length) : (e.constraint ?? e.code ?? 'ERROR');
};
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
/** A transaction with the user triggers and foreign-key triggers of every table off (the catalogue and geography fixtures; CHECK constraints still apply). */
async function replica<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query('SET LOCAL session_replication_role = replica');
    return fn(c);
  });
}
/** Runs the prep statements and then `text` in a transaction that is ALWAYS rolled back. */
async function isolated(prep: string[], text: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const p of prep) await c.query(p);
    await c.query(text, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const waitersOn = async (from: pg.Pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      )
    ).rows[0] as {
      n: number;
    }
  ).n;
async function lockWaiters(atLeast: number, from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
type Racer = { text: string; params?: unknown[] } | ((c: pg.PoolClient) => Promise<unknown>);
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
/** The holder runs `hold` and stays open; the racer starts on another connection; the test waits until the racer is blocked on a lock; only then the holder commits. */
async function holdThenRace(hold: (c: pg.PoolClient) => Promise<unknown>, race: Racer): Promise<PgFailure | undefined> {
  const tx = await openTx();
  let racer: Promise<unknown> = Promise.resolve();
  try {
    await hold(tx);
    racer = rejection(runRacer(racePool, race));
    await lockWaiters(1);
  } finally {
    await finish(tx, 'COMMIT');
  }
  return (await racer) as PgFailure | undefined;
}
const both = (a: Racer, b: Racer) =>
  Promise.all([rejection(runRacer(racePool, a)), rejection(runRacer(racePool, b))]) as Promise<[PgFailure | undefined, PgFailure | undefined]>;
const winners = (r: (PgFailure | undefined)[]): number => r.filter((x) => x === undefined).length;
const notDeadlock = (e: PgFailure | undefined) => expect(String(e?.code ?? ''), 'a deadlock or a serialization failure is a defect').not.toMatch(/^40/);

// ---------------------------------------------------------------- fixtures: accounts and registrations (guards ON)
const historyRow = (c: Db, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
async function makeAccount(): Promise<string> {
  return inTx(async (c) => {
    const id = ((await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0] as { account_id: string }).account_id;
    await historyRow(c, id, null, 'ACTIVE');
    return id;
  });
}
async function suspend(accountId: string): Promise<void> {
  await inTx(async (c) => {
    await c.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
    await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [accountId]);
    await historyRow(c, accountId, 'ACTIVE', 'SUSPENDED');
  });
}

// ---------------------------------------------------------------- fixtures: the catalogue (guards OFF through replication role replica; CHECK constraints still apply)
let categoryId: string;
interface Fields {
  text: string; // PROVIDER_CONFIGURABLE TEXT
  longText: string; // PROVIDER_REQUIRED LONG_TEXT
  int: string; // INTEGER
  dec: string; // DECIMAL
  bool: string; // BOOLEAN
  enum: string; // ENUM with options wax / ceramic
  dur: string; // DURATION
  fixedText: string; // PLATFORM_FIXED TEXT
  fixedInt: string; // PLATFORM_FIXED INTEGER
  money: string; // MONEY (unsupported)
  media: string; // MEDIA (unsupported)
}
interface Tpl {
  tplId: string;
  tvId: string;
  stId: string;
  code: string;
  f: Fields;
}
interface TplOpts {
  status?: string;
  stStatus?: string;
  min?: number | null;
  max?: number | null;
  suggested?: number | null;
  fixed?: boolean;
  withVariants?: boolean;
}
async function makeCategory(): Promise<string> {
  return replica(async (c) => {
    const r = await c.query("INSERT INTO catalog.categories (code, status) VALUES ($1, 'ACTIVE') RETURNING category_id", [`gc_${++seq}`]);
    return (r.rows[0] as { category_id: string }).category_id;
  });
}
/** A service type, a template with ONE ACTIVE version (and its fields) bound to it. */
async function makeTpl(o: TplOpts = {}): Promise<Tpl> {
  categoryId ??= await makeCategory();
  const code = `gt_${++seq}`;
  return replica(async (c) => {
    const st = (
      await c.query('INSERT INTO catalog.service_types (category_id, code, status) VALUES ($1, $2, $3) RETURNING service_type_id', [
        categoryId,
        `gst_${seq}`,
        o.stStatus ?? 'ACTIVE',
      ])
    ).rows[0] as {
      service_type_id: string;
    };
    const tpl = (
      await c.query('INSERT INTO catalog.gig_templates (service_type_id, code, status) VALUES ($1, $2, $3) RETURNING gig_template_id', [
        st.service_type_id,
        code,
        o.status ?? 'ACTIVE',
      ])
    ).rows[0] as {
      gig_template_id: string;
    };
    const tv = await addVersion(c, tpl.gig_template_id, 1, 'ACTIVE', o);
    return { tplId: tpl.gig_template_id, tvId: tv.id, stId: st.service_type_id, code, f: await addFields(c, tv.id, code) };
  });
}
async function addVersion(c: Db, tplId: string, n: number, status: string, o: TplOpts = {}): Promise<{ id: string }> {
  const r = await c.query(
    `INSERT INTO catalog.gig_template_versions (gig_template_id, version_number, status, min_duration_minutes, max_duration_minutes, suggested_duration_minutes, pricing_fixed, pricing_fixed_with_variants, published_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $3 = 'DRAFT' THEN NULL ELSE now() END, CASE WHEN $3 IN ('SUPERSEDED', 'RETIRED') THEN now() END) RETURNING gig_template_version_id`,
    [tplId, n, status, o.min ?? null, o.max ?? null, o.suggested ?? null, o.fixed ?? true, o.withVariants ?? false],
  );
  return { id: (r.rows[0] as { gig_template_version_id: string }).gig_template_version_id };
}
let fieldSeq = 0;
async function addField(
  c: Db,
  tvId: string,
  code: string,
  spec: { type: string; behavior?: string; order: number; defaultNumber?: number; defaultText?: boolean; minLength?: number; maxLength?: number },
): Promise<string> {
  const key = `f${++fieldSeq}`;
  const r = await c.query(
    `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, default_content_key, default_number, min_length, max_length)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING gig_template_field_id`,
    [
      tvId,
      key,
      spec.type,
      spec.behavior ?? 'PROVIDER_CONFIGURABLE',
      spec.order,
      `catalog.gig_template.${code}.field.${key}.label`,
      spec.defaultText ? `catalog.gig_template.${code}.field.${key}.default` : null,
      spec.defaultNumber ?? null,
      spec.minLength ?? null,
      spec.maxLength ?? null,
    ],
  );
  return (r.rows[0] as { gig_template_field_id: string }).gig_template_field_id;
}
async function addFields(c: Db, tvId: string, code: string): Promise<Fields> {
  const f = {
    text: await addField(c, tvId, code, { type: 'TEXT', order: 1 }),
    longText: await addField(c, tvId, code, { type: 'LONG_TEXT', behavior: 'PROVIDER_REQUIRED', order: 2 }),
    int: await addField(c, tvId, code, { type: 'INTEGER', order: 3 }),
    dec: await addField(c, tvId, code, { type: 'DECIMAL', order: 4 }),
    bool: await addField(c, tvId, code, { type: 'BOOLEAN', order: 5 }),
    enum: await addField(c, tvId, code, { type: 'ENUM', order: 6 }),
    dur: await addField(c, tvId, code, { type: 'DURATION', order: 7 }),
    fixedText: await addField(c, tvId, code, { type: 'TEXT', behavior: 'PLATFORM_FIXED', order: 8, defaultText: true }),
    fixedInt: await addField(c, tvId, code, { type: 'INTEGER', behavior: 'PLATFORM_FIXED', order: 9, defaultNumber: 3 }),
    money: await addField(c, tvId, code, { type: 'MONEY', order: 10 }),
    media: await addField(c, tvId, code, { type: 'MEDIA', order: 11 }),
  };
  await c.query(
    `INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, is_default, display_order)
     VALUES ($1, 'wax', 'x.wax', true, 1), ($1, 'ceramic', 'x.ceramic', false, 2)`,
    [f.enum],
  );
  return f;
}
/** Catalogue status changes the catalogue guards would route through their own workflows (here the model under test is the Gig, so the rows are set directly). */
const setCatalog = (table: 'service_types' | 'gig_templates' | 'gig_template_versions', idColumn: string, id: string, status: string, extra = '') =>
  replica((c) => c.query(`UPDATE catalog.${table} SET status = $2${extra} WHERE ${idColumn} = $1`, [id, status]));
const setSt = (id: string, status: string) => setCatalog('service_types', 'service_type_id', id, status);
const setTpl = (id: string, status: string) => setCatalog('gig_templates', 'gig_template_id', id, status);
const setTv = (id: string, status: string) =>
  setCatalog('gig_template_versions', 'gig_template_version_id', id, status, ", closed_at = CASE WHEN $2 IN ('SUPERSEDED', 'RETIRED') THEN now() END");

// ---------------------------------------------------------------- fixtures: providers, Gigs, versions (guards ON)
interface Provider {
  account: string;
  reg: string;
  market: string;
}
/** An ACTIVE account with a COMPLETED registration in `market` that selected the given service types. */
async function makeProvider(stIds: string[], market: string = laOc): Promise<Provider> {
  const account = await makeAccount();
  const reg = await inTx(async (c) => {
    const id = (
      (await c.query('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1) RETURNING provider_registration_id', [account]))
        .rows[0] as { provider_registration_id: string }
    ).provider_registration_id;
    await c.query('UPDATE provider.registrations SET market_id = $2, revision = revision + 1 WHERE provider_registration_id = $1', [id, market]);
    for (const st of stIds)
      await c.query('INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) VALUES ($1, $2)', [id, st]);
    await c.query("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [id]);
    return id;
  });
  return { account, reg, market };
}
interface G {
  p: Provider;
  t: Tpl;
  gigId: string;
  v1: string;
}
const insertGig = (c: Db, account: string, tplId: string, clientRequestId: string | null = null) =>
  c.query('INSERT INTO provider.gigs (account_id, gig_template_id, client_request_id) VALUES ($1, $2, $3) RETURNING gig_id', [account, tplId, clientRequestId]);
/** A Gig and its first DRAFT version in one transaction (what the service does; a Gig row alone is refused at commit). */
const createGig = (account: string, t: { tplId: string; tvId: string }, clientRequestId: string | null = null): Promise<{ gigId: string; v1: string }> =>
  inTx(async (c) => {
    const gigId = ((await insertGig(c, account, t.tplId, clientRequestId)).rows[0] as { gig_id: string }).gig_id;
    const v1 = ((await insertVersion(c, gigId, 1, t.tvId)).rows[0] as { gig_version_id: string }).gig_version_id;
    return { gigId, v1 };
  });
/** A Gig row WITHOUT a version, for the tests of the version guard: written with the triggers off (replica role), because the guards and the commit-time check would refuse it. */
const bareGig = (account: string, tplId: string): Promise<string> =>
  replica(async (c) => ((await insertGig(c, account, tplId)).rows[0] as { gig_id: string }).gig_id);
const insertVersion = (c: Db, gigId: string, n: number, tvId: string) =>
  c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, $2, $3) RETURNING gig_version_id', [gigId, n, tvId]);
/** A provider, a template and a Gig with its first DRAFT version (the service does the same in one transaction). */
async function makeGig(o: { tpl?: TplOpts } = {}): Promise<G> {
  const t = await makeTpl(o.tpl);
  const p = await makeProvider([t.stId]);
  return gigFor(p, t);
}
async function gigFor(p: Provider, t: Tpl): Promise<G> {
  return inTx(async (c) => {
    const gigId = ((await insertGig(c, p.account, t.tplId)).rows[0] as { gig_id: string }).gig_id;
    const v1 = ((await insertVersion(c, gigId, 1, t.tvId)).rows[0] as { gig_version_id: string }).gig_version_id;
    return { p, t, gigId, v1 };
  });
}
interface Ver {
  gig_version_id: string;
  gig_id: string;
  version_number: number;
  gig_template_version_id: string;
  status: string;
  revision: number;
  title: string | null;
  short_pitch: string | null;
  description: string | null;
  price_amount_minor: string | null;
  price_currency: string | null;
  duration_minutes: number | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  superseded_at: Date | null;
  retired_at: Date | null;
}
const ver = async (id: string, from: Db = pool): Promise<Ver> =>
  (await q<Ver>('SELECT * FROM provider.gig_versions WHERE gig_version_id = $1', [id], from))[0]!;
const gigRow = async (id: string, from: Db = pool) =>
  (await q<{ status: string; retired_at: Date | null; updated_at: Date; created_at: Date }>('SELECT * FROM provider.gigs WHERE gig_id = $1', [id], from))[0]!;
/** Writes the required copy and (optionally) a price and a duration into the DRAFT, one revision up. */
const fillDraft = (id: string, extra: { price?: number; currency?: string; duration?: number } = {}, from: Db = pool) =>
  from.query(
    `UPDATE provider.gig_versions SET title = 'Full detail', short_pitch = 'A careful clean', description = 'We clean the car inside and out.', revision = revision + 1,
            price_amount_minor = $2, price_currency = $3, duration_minutes = $4 WHERE gig_version_id = $1`,
    [id, extra.price ?? null, extra.price === undefined ? null : (extra.currency ?? 'USD'), extra.duration ?? null],
  );
/** Publishes the DRAFT of a Gig that has no published version yet (the service does the same in one transaction): the version first, then the Gig becomes ACTIVE. */
async function publishFirst(g: { gigId: string }, vId: string, from: Db = pool): Promise<void> {
  await from.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [vId]);
  await from.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]);
}
/** A Gig with a filled, PUBLISHED version 1 (and an ACTIVE Gig). */
async function publishedGig(o: { tpl?: TplOpts } = {}): Promise<G> {
  const g = await makeGig(o);
  await inTx(async (c) => {
    await fillDraft(g.v1, {}, c);
    await publishFirst(g, g.v1, c);
  });
  return g;
}
/** Starts draft n+1 on a Gig, supersedes the published version and publishes the new one, in one transaction (the order the one-PUBLISHED index and the guards require). */
async function nextVersion(g: G, publish = true): Promise<string> {
  return inTx(async (c) => {
    const cur = (
      await q<{ version_number: number; gig_version_id: string; gig_template_version_id: string }>(
        'SELECT * FROM provider.gig_versions WHERE gig_id = $1 ORDER BY version_number DESC LIMIT 1',
        [g.gigId],
        c,
      )
    )[0]!;
    const id = ((await insertVersion(c, g.gigId, cur.version_number + 1, cur.gig_template_version_id)).rows[0] as { gig_version_id: string }).gig_version_id;
    if (publish) {
      await fillDraft(id, {}, c);
      await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_id = $1 AND status = 'PUBLISHED'", [g.gigId]);
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [id]);
    }
    return id;
  });
}
/** Retires a Gig and its open versions in one transaction (the Gig first, then its versions). */
async function retire(gigId: string): Promise<void> {
  await inTx(async (c) => {
    await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [gigId]);
    await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [gigId]);
  });
}
const setValue = (vId: string, fieldId: string, col: string, value: unknown, from: Db = pool) =>
  from.query(`INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, ${col}) VALUES ($1, $2, $3)`, [vId, fieldId, value]);
const audit = (
  g: { gigId: string; p: Provider },
  action = 'GIG_CREATED',
  o: { versionId?: string | null; changes?: unknown; account?: string; actor?: string } = {},
  from: Db = pool,
) =>
  from.query(
    'INSERT INTO provider.gig_audit_events (actor, account_id, gig_id, gig_version_id, action, changes, correlation_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
    [
      o.actor ?? `account:${g.p.account}`,
      o.account ?? g.p.account,
      g.gigId,
      o.versionId ?? null,
      action,
      o.changes === undefined ? null : JSON.stringify(o.changes),
      'test-correlation',
    ],
  );

// ====================================================================== A. shape of the schema
type ColumnShape = [name: string, type: string, nullable: boolean, hasDefault: boolean];
const columnsOf = async (table: string): Promise<ColumnShape[]> =>
  (
    await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    )
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default !== null]);
const TS = 'timestamp with time zone';
const COLUMNS: Record<string, ColumnShape[]> = {
  gigs: [
    ['gig_id', 'uuid', false, true],
    ['account_id', 'uuid', false, false],
    ['gig_template_id', 'uuid', false, false],
    ['status', 'text', false, true],
    ['client_request_id', 'uuid', true, false],
    ['created_at', TS, false, true],
    ['updated_at', TS, false, true],
    ['retired_at', TS, true, false],
  ],
  gig_versions: [
    ['gig_version_id', 'uuid', false, true],
    ['gig_id', 'uuid', false, false],
    ['version_number', 'integer', false, false],
    ['gig_template_version_id', 'uuid', false, false],
    ['status', 'text', false, true],
    ['revision', 'integer', false, true],
    ['title', 'text', true, false],
    ['short_pitch', 'text', true, false],
    ['description', 'text', true, false],
    ['price_amount_minor', 'bigint', true, false],
    ['price_currency', 'character', true, false],
    ['duration_minutes', 'integer', true, false],
    ['created_at', TS, false, true],
    ['updated_at', TS, false, true],
    ['published_at', TS, true, false],
    ['superseded_at', TS, true, false],
    ['retired_at', TS, true, false],
  ],
  gig_version_field_values: [
    ['gig_version_id', 'uuid', false, false],
    ['gig_template_field_id', 'uuid', false, false],
    ['text_value', 'text', true, false],
    ['integer_value', 'bigint', true, false],
    ['decimal_value', 'numeric', true, false],
    ['boolean_value', 'boolean', true, false],
    ['option_code', 'text', true, false],
    ['duration_minutes', 'integer', true, false],
    ['created_at', TS, false, true],
    ['updated_at', TS, false, true],
  ],
  gig_audit_events: [
    ['audit_event_id', 'uuid', false, true],
    ['occurred_at', TS, false, true],
    ['actor', 'text', false, false],
    ['account_id', 'uuid', false, false],
    ['gig_id', 'uuid', false, false],
    ['gig_version_id', 'uuid', true, false],
    ['action', 'text', false, false],
    ['changes', 'jsonb', true, false],
    ['correlation_id', 'text', false, false],
  ],
};
const CONSTRAINTS: Record<string, string[]> = {
  gigs: ['ck_gigs__lifecycle', 'ck_gigs__status', 'fk_gigs__account_id', 'fk_gigs__gig_template_id', 'pk_gigs'],
  gig_versions: [
    'ck_gig_versions__description',
    'ck_gig_versions__duration',
    'ck_gig_versions__lifecycle',
    'ck_gig_versions__number',
    'ck_gig_versions__price',
    'ck_gig_versions__published_content',
    'ck_gig_versions__revision',
    'ck_gig_versions__short_pitch',
    'ck_gig_versions__status',
    'ck_gig_versions__title',
    'fk_gig_versions__gig_id',
    'fk_gig_versions__gig_template_version_id',
    'fk_gig_versions__price_currency',
    'pk_gig_versions',
    'uq_gig_versions__number',
  ],
  gig_version_field_values: [
    'ck_gig_version_field_values__decimal',
    'ck_gig_version_field_values__duration',
    'ck_gig_version_field_values__one_value',
    'ck_gig_version_field_values__text',
    'fk_gig_version_field_values__field_id',
    'fk_gig_version_field_values__option',
    'fk_gig_version_field_values__version_id',
    'pk_gig_version_field_values',
  ],
  gig_audit_events: [
    'ck_gig_audit_events__action',
    'ck_gig_audit_events__actor',
    'ck_gig_audit_events__changes_object',
    'fk_gig_audit_events__account_id',
    'fk_gig_audit_events__gig_id',
    'fk_gig_audit_events__gig_version_id',
    'pk_gig_audit_events',
  ],
};
const FK_TARGETS: Record<string, string> = {
  fk_gigs__account_id: 'identity.accounts',
  fk_gigs__gig_template_id: 'catalog.gig_templates',
  fk_gig_versions__gig_id: 'provider.gigs',
  fk_gig_versions__gig_template_version_id: 'catalog.gig_template_versions',
  fk_gig_versions__price_currency: 'geography.currencies',
  fk_gig_version_field_values__version_id: 'provider.gig_versions',
  fk_gig_version_field_values__field_id: 'catalog.gig_template_fields',
  fk_gig_version_field_values__option: 'catalog.gig_template_field_options',
  fk_gig_audit_events__account_id: 'identity.accounts',
  fk_gig_audit_events__gig_id: 'provider.gigs',
  fk_gig_audit_events__gig_version_id: 'provider.gig_versions',
};
const INDEXES: Record<string, string[]> = {
  gigs: ['idx_gigs__account_status', 'pk_gigs', 'uq_gigs__client_request'],
  gig_versions: ['pk_gig_versions', 'uq_gig_versions__draft', 'uq_gig_versions__number', 'uq_gig_versions__published'],
  gig_version_field_values: ['idx_gig_version_field_values__field_option', 'pk_gig_version_field_values'],
  gig_audit_events: ['idx_gig_audit_events__gig', 'pk_gig_audit_events'],
};
const TRIGGERS: Record<string, string[]> = {
  gigs: ['trg_gigs__guard', 'trg_gigs__has_version', 'trg_gigs__no_truncate', 'trg_gigs__state_consistent'],
  gig_versions: ['trg_gig_versions__guard', 'trg_gig_versions__no_truncate', 'trg_gig_versions__state_consistent'],
  gig_version_field_values: ['trg_gig_version_field_values__guard', 'trg_gig_version_field_values__no_truncate'],
  gig_audit_events: ['trg_gig_audit_events__guard', 'trg_gig_audit_events__immutable', 'trg_gig_audit_events__no_truncate'],
};
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const NEW_TABLES = Object.keys(COLUMNS);

describe('A. shape of the schema', () => {
  it.each(Object.entries(COLUMNS))('has exactly the documented columns, types, nullability and defaults on %s', async (table, expected) => {
    expect(await columnsOf(table)).toEqual(expected);
  });

  it.each(Object.entries(CONSTRAINTS))('has exactly the documented constraints on %s (by name)', async (table, names) => {
    const rows = await q<{ conname: string; convalidated: boolean; condeferrable: boolean }>(
      "SELECT conname, convalidated, condeferrable FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 't'",
      [`provider.${table}`],
    );
    expect(rows.map((r) => r.conname).sort(byName)).toEqual([...names].sort(byName));
    expect(rows.every((r) => r.convalidated && !r.condeferrable)).toBe(true);
  });

  it('declares every foreign key of the Gig tables ON DELETE RESTRICT, ON UPDATE NO ACTION, MATCH SIMPLE, with the documented target', async () => {
    const fks = await q<{ conname: string; target: string; confdeltype: string; confupdtype: string; confmatchtype: string }>(
      `SELECT conname, confrelid::regclass::text AS target, confdeltype, confupdtype, confmatchtype FROM pg_constraint
        WHERE contype = 'f' AND conrelid = ANY (ARRAY['provider.gigs', 'provider.gig_versions', 'provider.gig_version_field_values', 'provider.gig_audit_events']::regclass[])`,
    );
    expect(Object.fromEntries(fks.map((r) => [r.conname, r.target]))).toEqual(FK_TARGETS);
    expect(fks.map((r) => [r.confdeltype, r.confupdtype, r.confmatchtype])).toEqual(fks.map(() => ['r', 'a', 's']));
  });

  it.each(Object.entries(INDEXES))('has exactly the documented indexes on %s and no other', async (table, names) => {
    const rows = await q<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'provider' AND tablename = $1", [table]);
    expect(rows.map((r) => r.indexname).sort(byName)).toEqual([...names].sort(byName));
  });

  it('defines the two partial unique indexes (one DRAFT and one PUBLISHED per Gig) and the partial idempotency key exactly', async () => {
    const defs = Object.fromEntries(
      (
        await q<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'provider' AND indexdef ~ ' WHERE ' AND tablename LIKE 'gig%'",
        )
      ).map((r) => [r.indexname, r.indexdef]),
    );
    expect(defs).toEqual({
      uq_gig_versions__draft: "CREATE UNIQUE INDEX uq_gig_versions__draft ON provider.gig_versions USING btree (gig_id) WHERE (status = 'DRAFT'::text)",
      uq_gig_versions__published:
        "CREATE UNIQUE INDEX uq_gig_versions__published ON provider.gig_versions USING btree (gig_id) WHERE (status = 'PUBLISHED'::text)",
      uq_gigs__client_request:
        'CREATE UNIQUE INDEX uq_gigs__client_request ON provider.gigs USING btree (account_id, client_request_id) WHERE (client_request_id IS NOT NULL)',
    });
  });

  it('documents the foreign keys WITHOUT a supporting index exactly (never-deleted targets, no filtered query on the referencing column)', async () => {
    const rows = await q<{ conname: string }>(
      `SELECT conname FROM pg_constraint c WHERE contype = 'f' AND conrelid = ANY (ARRAY['provider.gigs', 'provider.gig_versions', 'provider.gig_version_field_values', 'provider.gig_audit_events']::regclass[])
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])`,
    );
    expect(rows.map((r) => r.conname).sort(byName)).toEqual([
      'fk_gig_audit_events__account_id',
      'fk_gig_audit_events__gig_version_id',
      'fk_gig_versions__gig_template_version_id',
      'fk_gig_versions__price_currency',
      'fk_gigs__gig_template_id',
    ]);
  });

  it.each(Object.entries(TRIGGERS))('wires the triggers of %s exactly (by name), all enabled', async (table, names) => {
    const rows = await q<{ tgname: string; tgenabled: string }>('SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal', [
      `provider.${table}`,
    ]);
    expect(rows.map((r) => r.tgname).sort(byName)).toEqual([...names].sort(byName));
    expect(rows.every((r) => r.tgenabled === 'O')).toBe(true);
  });

  it('wires the deferred commit-time invariants as three DEFERRABLE INITIALLY DEFERRED constraint triggers and nothing else is a constraint trigger in the schema', async () => {
    const rows = await q<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
      "SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgconstraint <> 0 AND tgrelid::regclass::text LIKE 'provider.%' AND NOT tgisinternal",
    );
    expect(rows.sort((a, b) => byName(a.tgname, b.tgname))).toEqual([
      { tgname: 'trg_gig_versions__state_consistent', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'trg_gigs__has_version', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'trg_gigs__state_consistent', tgdeferrable: true, tginitdeferred: true },
    ]);
  });

  it('keeps every Gig guard function and the content function in the provider schema, commented, and every Gig table commented (table and function comments are documentation)', async () => {
    const fns = await q<{ proname: string; comment: string | null }>(
      "SELECT p.proname, obj_description(p.oid, 'pg_proc') AS comment FROM pg_proc p WHERE pronamespace = 'provider'::regnamespace AND proname ~ '(gig)'",
    );
    expect(fns.map((f) => f.proname).sort(byName)).toEqual([
      'assert_gig_has_version',
      'assert_gig_state_consistent',
      'check_gig_version_children', // 0021 (CAT-004), asserted in gig-options-media-model.itest.ts
      'check_gig_version_content',
      'guard_gig_audit_events',
      'guard_gig_version_field_values',
      'guard_gig_version_media', // 0021
      'guard_gig_version_options', // 0021
      'guard_gig_versions',
      'guard_gigs',
    ]);
    expect(fns.every((f) => (f.comment ?? '').length > 80)).toBe(true);
    for (const t of NEW_TABLES)
      expect((await q<{ c: string | null }>("SELECT obj_description($1::regclass, 'pg_class') AS c", [`provider.${t}`]))[0]!.c).toMatch(/^.{200,}/s);
  });

  it('has no generated or identity column in the Gig tables (identifiers come from gen_random_uuid(), numbers from the guard)', async () => {
    expect(
      await q(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'provider'::regnamespace AND c.relname = ANY ($1) AND a.attnum > 0 AND NOT a.attisdropped AND (a.attgenerated <> '' OR a.attidentity <> '')`,
        [NEW_TABLES],
      ),
    ).toEqual([]);
  });

  it('stores no market, no service type, no current-version pointer and no JSON blob of content on the Gig tables (the challenged duplications)', async () => {
    const cols = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = ANY ($1)",
      [NEW_TABLES],
    );
    expect(cols.filter((c) => /market|service_type|current|published_version|latest/.test(c.column_name))).toEqual([]);
    expect(cols.filter((c) => c.data_type === 'jsonb').map((c) => `${c.table_name}.${c.column_name}`)).toEqual(['gig_audit_events.changes']);
  });
});

// ====================================================================== B. seeds
describe('B. seeds (configuration and content, through the real workflows)', () => {
  const SEEDED = [
    [PROVIDER_GIG_POLICY_KEYS.maxActive, 25, 1, 500],
    [PROVIDER_GIG_POLICY_KEYS.maxDrafts, 10, 1, 500],
    [PROVIDER_GIG_POLICY_KEYS.titleMaxLength, 100, 1, 200],
    [PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength, 1000, 1, 2000],
    [PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength, 5000, 1, 20000],
  ] as const;

  it('seeds the five Gig policy parameters as typed integers at PLATFORM scope with the documented bounds and the active value', async () => {
    const rows = await q<{
      key: string;
      data_type: string;
      validation_rules: { min: number; max: number };
      approval_policy: string;
      criticality: string;
      is_required: boolean;
      value: unknown;
      state: string;
    }>(
      `SELECT p.key, p.data_type, p.validation_rules, p.approval_policy, p.criticality, p.is_required, vv.value, cr.state
         FROM configuration.parameters p
         JOIN configuration.parameter_values pv ON pv.parameter_id = p.parameter_id AND pv.scope_type = 'PLATFORM'
         JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
         JOIN configuration.change_requests cr ON cr.value_version_id = vv.version_id
        WHERE p.key = ANY ($1) ORDER BY p.key COLLATE "C"`, // the five parameters of 0020; the fifteen of 0021 are asserted in gig-options-media-model.itest.ts
      [SEEDED.map((s) => s[0])],
    );
    expect(rows.map((r) => r.key)).toEqual(SEEDED.map((s) => s[0]).sort(byName));
    for (const [key, value, min, max] of SEEDED) {
      const r = rows.find((x) => x.key === key)!;
      expect(r).toMatchObject({
        data_type: 'INTEGER',
        validation_rules: { min, max },
        approval_policy: 'SECOND_APPROVER',
        criticality: 'STANDARD',
        is_required: true,
        state: 'ACTIVE',
        value,
      });
    }
  });

  it('seeds values that parse as the contract policy and respect its structural ceilings (the database CHECKs repeat them)', async () => {
    const v = Object.fromEntries(SEEDED.map(([k, value]) => [k, value]));
    expect(
      ProviderGigPolicy.parse({
        maxActive: v[PROVIDER_GIG_POLICY_KEYS.maxActive],
        maxDrafts: v[PROVIDER_GIG_POLICY_KEYS.maxDrafts],
        titleMaxLength: v[PROVIDER_GIG_POLICY_KEYS.titleMaxLength],
        shortPitchMaxLength: v[PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength],
        descriptionMaxLength: v[PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength],
      }),
    ).toBeDefined();
  });

  it('wrote the configuration audit trail of every seeded parameter exactly as the workflow does (created, drafted, submitted, approved, published, activated)', async () => {
    const rows = await q<{ key: string; actions: string[] }>(
      `SELECT p.key, array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM configuration.parameters p JOIN configuration.audit_events a ON a.parameter_id = p.parameter_id
        WHERE p.key LIKE 'provider.gig.%' AND a.correlation_id = 'seed-0020' GROUP BY 1`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows)
      expect([...new Set(r.actions)].sort()).toEqual([
        'CHANGE_ACTIVATED',
        'CHANGE_APPROVED',
        'CHANGE_DRAFTED',
        'CHANGE_PUBLISHED',
        'CHANGE_SUBMITTED',
        'PARAMETER_CREATED',
      ]);
  });

  const UI_KEYS = [
    'page.title',
    'page.intro',
    'menu.heading',
    'menu.empty',
    'menu.not_eligible',
    'menu.draft_limit',
    'menu.not_live_note',
    'menu.limits_heading',
    'menu.limit_active',
    'menu.limit_drafts',
    'menu.open',
    'menu.current_version',
    'menu.draft_version',
    'menu.no_published',
    'menu.price',
    'menu.duration',
    'create.heading',
    'create.template',
    'create.submit',
    'create.none_available',
    'editor.heading',
    'editor.title',
    'editor.title_hint',
    'editor.short_pitch',
    'editor.short_pitch_hint',
    'editor.description',
    'editor.description_hint',
    'editor.price',
    'editor.price_hint',
    'editor.currency',
    'editor.duration',
    'editor.duration_hint',
    'editor.fields_heading',
    'editor.fixed_heading',
    'editor.fixed_note',
    'editor.unsupported_note',
    'editor.required',
    'editor.optional',
    'editor.save',
    'editor.publish',
    'editor.retire',
    'editor.retire_note',
    'editor.new_draft',
    'editor.back',
    'editor.issues_heading',
    'editor.history_heading',
    'editor.version',
    'editor.template',
    'editor.template_version',
    'editor.published_at',
    'editor.not_editable',
    'editor.draft_heading',
    'editor.current_heading',
    'editor.yes',
    'editor.no',
    'editor.select_empty',
    'notice.created',
    'notice.saved',
    'notice.published',
    'notice.draft_created',
    'notice.retired',
  ].map((k) => `provider.gig.${k}`);
  const CONTRACT_KEYS = [
    ...GIG_STATUSES.map(gigStatusKey),
    ...GIG_VERSION_STATUSES.map(gigVersionStatusKey),
    ...GIG_ERROR_CODES.slice(0, 15).map(gigErrorKey),
    ...GIG_ISSUE_REASONS.slice(0, 24).map(gigIssueKey),
  ];

  // the copy of migration 0020 only (its content seed is tagged with the correlation id seed-0020); the 72 entries of 0021 are asserted in gig-options-media-model.itest.ts
  const SEED_0020 = "e.entry_id IN (SELECT entry_id FROM content.audit_events WHERE correlation_id = 'seed-0020' AND action = 'ENTRY_CREATED')";
  it('seeds one content entry per contract enumeration value of CAT-003 (3 statuses, 4 version statuses, the first 15 errors, the first 24 issues) and per UI key of the shared list, and nothing else', async () => {
    // CAT-004 appended 4 error codes and 19 issue reasons to the contract (19 and 43 in all): they are the entries of migration 0021
    expect([GIG_STATUSES.length, GIG_VERSION_STATUSES.length, GIG_ERROR_CODES.length, GIG_ISSUE_REASONS.length]).toEqual([3, 4, 19, 43]);
    expect(UI_KEYS).toHaveLength(61);
    const keys = (await q<{ key: string }>(`SELECT key FROM content.entries e WHERE key LIKE 'provider.gig.%' AND ${SEED_0020}`)).map((r) => r.key);
    expect([...keys].sort(byName)).toEqual([...CONTRACT_KEYS, ...UI_KEYS].sort(byName));
    expect(keys).toHaveLength(107);
  });

  it('publishes every seeded entry as an active en-US PLATFORM version, as plain platform copy with no variables, no legal type and no personal data', async () => {
    const rows = await q<{
      key: string;
      content_type: string;
      is_active: boolean;
      locale: string;
      scope_type: string;
      status: string;
      body: string;
      n: number;
    }>(
      `SELECT e.key, e.content_type, e.is_active, v.locale, v.scope_type, v.status, v.body, count(*) OVER (PARTITION BY e.key)::int AS n
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'provider.gig.%' AND ${SEED_0020}`,
    );
    expect(rows).toHaveLength(107);
    for (const r of rows) {
      expect({ active: r.is_active, locale: r.locale, scope: r.scope_type, status: r.status, n: r.n }).toEqual({
        active: true,
        locale: 'en-US',
        scope: 'PLATFORM',
        status: 'PUBLISHED',
        n: 1,
      });
      expect(['UI_LABEL', 'PLAIN_TEXT']).toContain(r.content_type);
      expect(r.body.trim().length).toBeGreaterThan(1);
      expect(r.body).not.toMatch(/[{}<>]|@|\$\{/);
    }
  });

  it('keeps the mandatory not-live note: publishing a Gig does not make a provider live', async () => {
    const body = (
      await q<{ body: string }>("SELECT v.body FROM content.entries e JOIN content.versions v USING (entry_id) WHERE e.key = 'provider.gig.menu.not_live_note'")
    )[0]!.body;
    expect(body).toBe('Publishing a Gig does not put you live or make it bookable. Going live is a separate step.');
  });

  it('seeds no Gig, version, value or audit row (a freshly migrated database has all four tables empty)', async () => {
    const fresh = await createIsolatedDatabase();
    const c = createTestPool(fresh.url, 2);
    try {
      for (const t of NEW_TABLES) expect(await count(`provider.${t}`, 'true', [], c)).toBe(0);
    } finally {
      await c.end();
      await fresh.drop();
    }
  }, 120_000);

  it('keeps the contract status matrices identical to the database guards (every cell checked below in C and D)', () => {
    const gig = GIG_STATUSES.flatMap((a) => GIG_STATUSES.filter((b) => isGigStatusTransitionAllowed(a, b)).map((b) => `${a}>${b}`));
    expect(gig).toEqual(['DRAFT>ACTIVE', 'DRAFT>RETIRED', 'ACTIVE>RETIRED']);
    const version = GIG_VERSION_STATUSES.flatMap((a) => GIG_VERSION_STATUSES.filter((b) => isGigVersionStatusTransitionAllowed(a, b)).map((b) => `${a}>${b}`));
    expect(version).toEqual(['DRAFT>PUBLISHED', 'DRAFT>RETIRED', 'PUBLISHED>SUPERSEDED', 'PUBLISHED>RETIRED']);
    expect(Object.values(GIG_EVENTS)).toHaveLength(3);
  });
});

// ====================================================================== C. provider.gigs
describe('C. provider.gigs', () => {
  it('creates a DRAFT Gig for an ACTIVE provider from an ACTIVE template and keeps owner, template and creation time', async () => {
    const g = await makeGig();
    const row = await gigRow(g.gigId);
    expect(row.status).toBe('DRAFT');
    expect(row.retired_at).toBeNull();
    expect(
      (
        await q<{ account_id: string; gig_template_id: string; client_request_id: string | null }>('SELECT * FROM provider.gigs WHERE gig_id = $1', [g.gigId])
      )[0],
    ).toMatchObject({
      account_id: g.p.account,
      gig_template_id: g.t.tplId,
      client_request_id: null,
    });
  });

  it('allows several Gigs per account and per template (PR-03.05)', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    await gigFor(p, t);
    await gigFor(p, t);
    expect(await count('provider.gigs', 'account_id = $1 AND gig_template_id = $2', [p.account, t.tplId])).toBe(2);
  });

  it.each([
    ['an account that is not ACTIVE', 'ACCOUNT_NOT_ACTIVE'],
    ['a template that is not ACTIVE', 'TEMPLATE_NOT_ACTIVE'],
    ['a service type that is not ACTIVE', 'SERVICE_TYPE_NOT_ACTIVE'],
  ])('refuses a Gig for %s', async (_label, key) => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    if (key === 'ACCOUNT_NOT_ACTIVE') await suspend(p.account);
    if (key === 'TEMPLATE_NOT_ACTIVE') await setTpl(t.tplId, 'INACTIVE');
    if (key === 'SERVICE_TYPE_NOT_ACTIVE') await setSt(t.stId, 'INACTIVE');
    await expectRule(insertGig(pool, p.account, t.tplId), key);
    expect(await count('provider.gigs', 'account_id = $1', [p.account])).toBe(0);
  });

  it.each(['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'])('refuses a Gig from a template in status %s unless it is ACTIVE', async (status) => {
    const t = await makeTpl({ status });
    const p = await makeProvider([t.stId]);
    expect(await outcomeOf(createGig(p.account, t))).toBe(status === 'ACTIVE' ? 'ACCEPTED' : 'TEMPLATE_NOT_ACTIVE');
  });

  it('refuses a Gig without a COMPLETED registration (none, in progress, cancelled)', async () => {
    const t = await makeTpl();
    const none = await makeAccount();
    await expectRule(insertGig(pool, none, t.tplId), 'REGISTRATION_NOT_COMPLETED');
    const inProgress = await makeAccount();
    await run('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1)', [inProgress]);
    await expectRule(insertGig(pool, inProgress, t.tplId), 'REGISTRATION_NOT_COMPLETED');
    const cancelled = await makeAccount();
    await run('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1)', [cancelled]);
    await run("UPDATE provider.registrations SET status = 'CANCELLED' WHERE account_id = $1", [cancelled]);
    await expectRule(insertGig(pool, cancelled, t.tplId), 'REGISTRATION_NOT_COMPLETED');
  });

  it('refuses a Gig whose service type the registration did not select, and accepts the selected one', async () => {
    const mine = await makeTpl();
    const other = await makeTpl();
    const p = await makeProvider([mine.stId]);
    await expectRule(insertGig(pool, p.account, other.tplId), 'SERVICE_NOT_SELECTED');
    await createGig(p.account, mine);
  });

  it('refuses to start anything but a DRAFT without a retirement time', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    await expectRule(
      pool.query("INSERT INTO provider.gigs (account_id, gig_template_id, status) VALUES ($1, $2, 'ACTIVE')", [p.account, t.tplId]),
      'MUST_START_DRAFT',
    );
    await expectRule(
      pool.query("INSERT INTO provider.gigs (account_id, gig_template_id, status, retired_at) VALUES ($1, $2, 'RETIRED', now())", [p.account, t.tplId]),
      'MUST_START_DRAFT',
    );
    await expectRule(
      pool.query('INSERT INTO provider.gigs (account_id, gig_template_id, retired_at) VALUES ($1, $2, now())', [p.account, t.tplId]),
      'MUST_START_DRAFT',
    );
  });

  it('enforces the table CHECKs on the status and lifecycle (the guard maintains retired_at, so the triggers are off here)', async () => {
    const g = await makeGig();
    const off = ['ALTER TABLE provider.gigs DISABLE TRIGGER USER'];
    await expectConstraint(isolated(off, "UPDATE provider.gigs SET status = 'LIVE' WHERE gig_id = $1", [g.gigId]), 'ck_gigs__status');
    await expectConstraint(isolated(off, "UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]), 'ck_gigs__lifecycle');
    await expectConstraint(isolated(off, 'UPDATE provider.gigs SET retired_at = now() WHERE gig_id = $1', [g.gigId]), 'ck_gigs__lifecycle');
  });

  it('answers a repeated client request id with a unique violation, per account, and allows the same token for another account and any number of NULLs', async () => {
    const t = await makeTpl();
    const a = await makeProvider([t.stId]);
    const b = await makeProvider([t.stId]);
    const token = randomUUID();
    await createGig(a.account, t, token);
    await expectConstraint(createGig(a.account, t, token), 'uq_gigs__client_request');
    await createGig(b.account, t, token);
    await createGig(a.account, t, null);
    await createGig(a.account, t, null);
    await createGig(a.account, t, randomUUID());
  });

  it.each(['gig_id', 'account_id', 'gig_template_id', 'client_request_id', 'created_at'])('keeps %s immutable', async (column) => {
    const g = await makeGig();
    const otherAccount = await makeAccount();
    const otherTemplate = await makeTpl();
    const value: Record<string, [string, unknown]> = {
      gig_id: ['$2::uuid', randomUUID()],
      account_id: ['$2::uuid', otherAccount],
      gig_template_id: ['$2::uuid', otherTemplate.tplId],
      client_request_id: ['$2::uuid', randomUUID()],
      created_at: ["now() - interval '1 day' + $2::int * interval '0 second'", 0],
    };
    await expectRule(
      pool.query(`UPDATE provider.gigs SET ${column} = ${value[column]![0]} WHERE gig_id = $1`, [g.gigId, value[column]![1]]),
      'IMMUTABLE_IDENTITY',
    );
  });

  it('matches the Gig status matrix of the contract cell by cell (the guard, the contract and the documentation agree)', async () => {
    for (const from of GIG_STATUSES) {
      for (const to of GIG_STATUSES) {
        const g = await makeGig();
        if (from !== 'DRAFT') {
          await inTx(async (c) => {
            await fillDraft(g.v1, {}, c);
            await publishFirst(g, g.v1, c);
          });
        }
        if (from === 'RETIRED') await retire(g.gigId);
        const cell = `${from}>${to}`;
        if (from === 'RETIRED') {
          expect(await outcomeOf(pool.query('UPDATE provider.gigs SET status = $2 WHERE gig_id = $1', [g.gigId, to])), cell).toBe('GIG_RETIRED');
        } else if (from === to) {
          expect(await outcomeOf(pool.query('UPDATE provider.gigs SET status = $2 WHERE gig_id = $1', [g.gigId, to])), cell).toBe('ACCEPTED');
        } else if (!isGigStatusTransitionAllowed(from, to)) {
          expect(await outcomeOf(pool.query('UPDATE provider.gigs SET status = $2 WHERE gig_id = $1', [g.gigId, to])), cell).toBe('STATUS_TRANSITION');
        } else if (to === 'RETIRED') {
          // a lone UPDATE leaves open versions behind, which the deferred check refuses at commit; the retirement as the service does it is accepted
          expect(await outcomeOf(pool.query('UPDATE provider.gigs SET status = $2 WHERE gig_id = $1', [g.gigId, to])), cell).toBe('RETIRED_GIG_OPEN_VERSION');
          expect(await outcomeOf(retire(g.gigId)), cell).toBe('ACCEPTED');
        } else {
          expect(await outcomeOf(pool.query('UPDATE provider.gigs SET status = $2 WHERE gig_id = $1', [g.gigId, to])), cell).toBe('NO_PUBLISHED_VERSION');
        }
      }
    }
  });

  it('makes a Gig ACTIVE only with a PUBLISHED version, and keeps it DRAFT after a refusal', async () => {
    const g = await makeGig();
    await expectRule(pool.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]), 'NO_PUBLISHED_VERSION');
    await fillDraft(g.v1);
    await expectRule(pool.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]), 'NO_PUBLISHED_VERSION'); // a filled DRAFT is not published
    await inTx((c) => publishFirst(g, g.v1, c));
    expect((await gigRow(g.gigId)).status).toBe('ACTIVE');
  });

  it('sets retired_at at retirement, ignores a client retired_at, and freezes the retired Gig', async () => {
    const g = await publishedGig();
    await retire(g.gigId);
    const row = await gigRow(g.gigId);
    expect(row.status).toBe('RETIRED');
    expect(row.retired_at).not.toBeNull();
    await expectRule(pool.query('UPDATE provider.gigs SET updated_at = now() WHERE gig_id = $1', [g.gigId]), 'GIG_RETIRED');
    await expectRule(pool.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]), 'GIG_RETIRED');
    await expectRule(pool.query("UPDATE provider.gigs SET status = 'DRAFT' WHERE gig_id = $1", [g.gigId]), 'GIG_RETIRED'); // no reactivation
  });

  it('maintains updated_at on every change and never lets a client write retired_at on a live Gig', async () => {
    const g = await makeGig();
    const before = (await gigRow(g.gigId)).updated_at;
    await sleep(5);
    await run('UPDATE provider.gigs SET retired_at = now() WHERE gig_id = $1', [g.gigId]); // ignored by the guard (the lifecycle CHECK would otherwise fail)
    const row = await gigRow(g.gigId);
    expect(row.retired_at).toBeNull();
    expect(row.updated_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it('refuses at COMMIT a Gig without a version (the service creates both in one transaction): direct SQL only', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    await expectRule(insertGig(pool, p.account, t.tplId), 'GIG_WITHOUT_VERSION'); // a lone INSERT commits on its own and is refused
    expect(await count('provider.gigs', 'account_id = $1', [p.account])).toBe(0);
    await createGig(p.account, t); // the Gig and its first version in one transaction
    expect(await count('provider.gigs', 'account_id = $1', [p.account])).toBe(1);
    const c = await openTx();
    await insertGig(c, p.account, t.tplId);
    await expectRule(c.query('SET CONSTRAINTS ALL IMMEDIATE'), 'GIG_WITHOUT_VERSION');
    await c.query('ROLLBACK');
    c.release();
  });

  it('never deletes or truncates a Gig', async () => {
    const g = await makeGig();
    await expectRule(pool.query('DELETE FROM provider.gigs WHERE gig_id = $1', [g.gigId]), 'NO_DELETE');
    await expectRule(pool.query('TRUNCATE provider.gigs CASCADE'), 'ROW_IMMUTABLE');
    expect(await count('provider.gigs', 'gig_id = $1', [g.gigId])).toBe(1);
  });
});

// ====================================================================== D. provider.gig_versions
describe('D. provider.gig_versions', () => {
  it('starts a Gig with version 1 as a DRAFT at revision 1 bound to the ACTIVE template version, with no lifecycle timestamps', async () => {
    const g = await makeGig();
    const v = await ver(g.v1);
    expect(v).toMatchObject({
      gig_id: g.gigId,
      version_number: 1,
      gig_template_version_id: g.t.tvId,
      status: 'DRAFT',
      revision: 1,
      title: null,
      price_amount_minor: null,
      price_currency: null,
    });
    expect([v.published_at, v.superseded_at, v.retired_at]).toEqual([null, null, null]);
  });

  it('refuses explicit non-DRAFT starts with NEW_NOT_DRAFT', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    const gigId = await bareGig(p.account, t.tplId);
    for (const extra of [
      "status, published_at) VALUES ($1, 1, $2, 'PUBLISHED', now())",
      "status, retired_at) VALUES ($1, 1, $2, 'RETIRED', now())",
      'revision) VALUES ($1, 1, $2, 2)',
      "status) VALUES ($1, 1, $2, 'SUPERSEDED')",
    ]) {
      await expectRule(
        pool.query(`INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id, ${extra}`, [gigId, t.tvId]),
        'NEW_NOT_DRAFT',
      );
    }
  });

  it('keeps version numbers contiguous: 1 first, then the highest plus one', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    const gigId = await bareGig(p.account, t.tplId);
    await expectRule(insertVersion(pool, gigId, 2, t.tvId), 'VERSION_NUMBER');
    await expectRule(insertVersion(pool, gigId, 0, t.tvId), 'VERSION_NUMBER');
    await insertVersion(pool, gigId, 1, t.tvId);
    await expectRule(insertVersion(pool, gigId, 1, t.tvId), 'VERSION_NUMBER'); // the unique key is only reached by a race (see G)
    await expectRule(insertVersion(pool, gigId, 3, t.tvId), 'VERSION_NUMBER');
  });

  it('allows at most one DRAFT and at most one PUBLISHED version per Gig, and any number of SUPERSEDED and RETIRED ones', async () => {
    const g = await publishedGig();
    const v2 = await nextVersion(g, false); // a draft next to the published v1
    await expectConstraint(insertVersion(pool, g.gigId, 3, g.t.tvId), 'uq_gig_versions__draft');
    // a second PUBLISHED version cannot appear: the old one is superseded first
    await fillDraft(v2);
    await expectConstraint(pool.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [v2]), 'uq_gig_versions__published');
    await inTx(async (c) => {
      await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]);
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [v2]);
    });
    for (let i = 0; i < 3; i++) await nextVersion(g);
    expect(await count('provider.gig_versions', "gig_id = $1 AND status = 'SUPERSEDED'", [g.gigId])).toBe(4); // v1 .. v4; v5 is PUBLISHED
    expect(await count('provider.gig_versions', "gig_id = $1 AND status = 'PUBLISHED'", [g.gigId])).toBe(1);
  });

  it.each([
    ['a SUPERSEDED template version', 'TEMPLATE_VERSION_NOT_ACTIVE', (t: Tpl) => setTv(t.tvId, 'SUPERSEDED')],
    ['a RETIRED template version', 'TEMPLATE_VERSION_NOT_ACTIVE', (t: Tpl) => setTv(t.tvId, 'RETIRED')],
    ['an INACTIVE template', 'TEMPLATE_NOT_ACTIVE', (t: Tpl) => setTpl(t.tplId, 'INACTIVE')],
    ['an INACTIVE service type', 'SERVICE_TYPE_NOT_ACTIVE', (t: Tpl) => setSt(t.stId, 'INACTIVE')],
  ])('binds version 1 only to the ACTIVE template version of an ACTIVE template under an ACTIVE service type: refuses %s', async (_what, key, arrange) => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    const gigId = await bareGig(p.account, t.tplId);
    await arrange(t);
    await expectRule(insertVersion(pool, gigId, 1, t.tvId), key);
  });

  it('refuses a template version of another template (TEMPLATE_VERSION_MISMATCH)', async () => {
    const t = await makeTpl();
    const other = await makeTpl();
    const p = await makeProvider([t.stId]);
    const gigId = await bareGig(p.account, t.tplId);
    await expectRule(insertVersion(pool, gigId, 1, other.tvId), 'TEMPLATE_VERSION_MISMATCH');
  });

  it('binds every later version to the SAME template version as the previous one, even when the template has a newer version or was retired (owner decision, no auto-migration)', async () => {
    const g = await publishedGig();
    const newer = await replica(async (c) => {
      await c.query("UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED', closed_at = now() WHERE gig_template_version_id = $1", [g.t.tvId]);
      return addVersion(c, g.t.tplId, 2, 'ACTIVE');
    });
    await expectRule(insertVersion(pool, g.gigId, 2, newer.id), 'TEMPLATE_VERSION_MISMATCH'); // not the previous version's
    const v2 = ((await insertVersion(pool, g.gigId, 2, g.t.tvId)).rows[0] as { gig_version_id: string }).gig_version_id; // the SUPERSEDED original is fine
    expect((await ver(v2)).gig_template_version_id).toBe(g.t.tvId);
    await setTpl(g.t.tplId, 'RETIRED'); // the template identity retired: still readable and a draft that exists stays
    expect((await ver(v2)).status).toBe('DRAFT');
  });

  it('refuses a next draft on a RETIRED template version, and a draft on a RETIRED Gig', async () => {
    const g = await publishedGig();
    await setTv(g.t.tvId, 'RETIRED');
    await expectRule(insertVersion(pool, g.gigId, 2, g.t.tvId), 'TEMPLATE_VERSION_RETIRED');
    const h = await publishedGig();
    await retire(h.gigId);
    await expectRule(insertVersion(pool, h.gigId, 2, h.t.tvId), 'GIG_RETIRED');
  });

  it('checks the text columns: non-blank when present and within the structural ceilings (200 / 2000 / 20000 code points)', async () => {
    const g = await makeGig();
    const set = (col: string, v: string | null) =>
      pool.query(`UPDATE provider.gig_versions SET ${col} = $2, revision = revision + 1 WHERE gig_version_id = $1`, [g.v1, v]);
    for (const [col, max] of [
      ['title', 200],
      ['short_pitch', 2000],
      ['description', 20000],
    ] as const) {
      await set(col, 'x'.repeat(max));
      await expectConstraint(set(col, 'x'.repeat(max + 1)), `ck_gig_versions__${col}`);
      await expectConstraint(set(col, '   '), `ck_gig_versions__${col}`);
      await expectConstraint(set(col, ''), `ck_gig_versions__${col}`);
      await set(col, '😀'.repeat(col === 'title' ? 200 : 10)); // code points, not UTF-16 units or bytes
    }
    await expectConstraint(set('title', '😀'.repeat(201)), 'ck_gig_versions__title');
  });

  it('keeps a price and its currency together, non-negative, in minor units of the provider market currency, only where the template allows a price', async () => {
    const g = await makeGig();
    const set = (amount: number | string | null, cur: string | null, vId = g.v1) =>
      pool.query('UPDATE provider.gig_versions SET price_amount_minor = $2, price_currency = $3, revision = revision + 1 WHERE gig_version_id = $1', [
        vId,
        amount,
        cur,
      ]);
    await set(12500, 'USD');
    await set(0, 'USD'); // zero is a valid DRAFT value (publication needs more than zero)
    await set('9223372036854775807', 'USD'); // bigint ceiling
    await set(null, null);
    await expectConstraint(set(-1, 'USD'), 'ck_gig_versions__price');
    await expectConstraint(set(null, 'USD'), 'ck_gig_versions__price');
    const off = ['ALTER TABLE provider.gig_versions DISABLE TRIGGER USER']; // the guard answers first; the CHECK and the foreign key are reached with it off
    const setOff = (amount: number | null, cur: string | null) =>
      isolated(off, 'UPDATE provider.gig_versions SET price_amount_minor = $2, price_currency = $3 WHERE gig_version_id = $1', [g.v1, amount, cur]);
    await expectConstraint(setOff(1000, null), 'ck_gig_versions__price');
    await expectConstraint(setOff(100, 'XXX'), 'fk_gig_versions__price_currency');
    await expectRule(set(1000, null), 'PRICE_CURRENCY');
    await expectRule(set(100, 'EUR'), 'PRICE_CURRENCY'); // the provider's market is USD
    const eur = await makeTpl();
    const pe = await makeProvider([eur.stId], eurMarket);
    const ge = await gigFor(pe, eur);
    await set(100, 'EUR', ge.v1);
    await expectRule(set(100, 'USD', ge.v1), 'PRICE_CURRENCY');
  });

  it('allows a price only when the bound template version allows FIXED or FIXED_WITH_VARIANTS (defence in depth: the template CHECK forbids neither, so it is simulated)', async () => {
    const g = await makeGig({ tpl: { fixed: false, withVariants: true } });
    await run('UPDATE provider.gig_versions SET price_amount_minor = 100, price_currency = $2, revision = revision + 1 WHERE gig_version_id = $1', [
      g.v1,
      'USD',
    ]); // variants-only template: allowed
    const h = await makeGig();
    await expectRule(
      isolated(
        [
          'ALTER TABLE catalog.gig_template_versions DISABLE TRIGGER USER',
          'ALTER TABLE catalog.gig_template_versions DROP CONSTRAINT ck_gig_template_versions__pricing',
          `UPDATE catalog.gig_template_versions SET pricing_fixed = false, pricing_fixed_with_variants = false WHERE gig_template_version_id = '${h.t.tvId}'`,
        ],
        "UPDATE provider.gig_versions SET price_amount_minor = 100, price_currency = 'USD', revision = revision + 1 WHERE gig_version_id = $1",
        [h.v1],
      ),
      'PRICE_NOT_PERMITTED',
    );
  });

  it('allows a duration only when the template version has duration guidance, within its min and max, and any 1..100000 value when only a suggestion exists', async () => {
    const none = await makeGig();
    const bounded = await makeGig({ tpl: { min: 30, max: 120, suggested: 60 } });
    const onlyMin = await makeGig({ tpl: { min: 30 } });
    const onlyMax = await makeGig({ tpl: { max: 120 } });
    const suggested = await makeGig({ tpl: { suggested: 90 } });
    const set = (g: G, d: number | null) =>
      pool.query('UPDATE provider.gig_versions SET duration_minutes = $2, revision = revision + 1 WHERE gig_version_id = $1', [g.v1, d]);
    await expectRule(set(none, 60), 'DURATION_NOT_PERMITTED');
    await set(none, null);
    await set(bounded, 30);
    await set(bounded, 120);
    await expectRule(set(bounded, 29), 'DURATION_RANGE');
    await expectRule(set(bounded, 121), 'DURATION_RANGE');
    await set(onlyMin, 30);
    await set(onlyMin, 100000);
    await expectRule(set(onlyMin, 29), 'DURATION_RANGE');
    await set(onlyMax, 1);
    await expectRule(set(onlyMax, 121), 'DURATION_RANGE');
    await set(suggested, 1);
    await set(suggested, 500);
    await set(suggested, 100000);
    await expectConstraint(set(suggested, 0), 'ck_gig_versions__duration');
    await expectConstraint(set(suggested, 100001), 'ck_gig_versions__duration');
  });

  it('raises the revision by exactly one on a content change, and only grows or keeps it when the content is unchanged', async () => {
    const g = await makeGig();
    await expectRule(pool.query("UPDATE provider.gig_versions SET title = 'a' WHERE gig_version_id = $1", [g.v1]), 'REVISION');
    await expectRule(pool.query("UPDATE provider.gig_versions SET title = 'a', revision = revision + 2 WHERE gig_version_id = $1", [g.v1]), 'REVISION');
    await expectRule(pool.query("UPDATE provider.gig_versions SET title = 'a', revision = revision - 1 WHERE gig_version_id = $1", [g.v1]), 'REVISION');
    await run("UPDATE provider.gig_versions SET title = 'a', revision = revision + 1 WHERE gig_version_id = $1", [g.v1]);
    expect((await ver(g.v1)).revision).toBe(2);
    await run('UPDATE provider.gig_versions SET revision = revision + 1 WHERE gig_version_id = $1', [g.v1]); // a save that only changed field values
    await run('UPDATE provider.gig_versions SET revision = revision WHERE gig_version_id = $1', [g.v1]);
    await expectRule(pool.query('UPDATE provider.gig_versions SET revision = revision + 2 WHERE gig_version_id = $1', [g.v1]), 'REVISION');
    await expectRule(pool.query('UPDATE provider.gig_versions SET revision = revision - 1 WHERE gig_version_id = $1', [g.v1]), 'REVISION');
    expect((await ver(g.v1)).revision).toBe(3);
  });

  it.each([
    ['gig_version_id', 'gen_random_uuid()'],
    ['gig_id', 'gen_random_uuid()'],
    ['version_number', 'version_number + 1'],
    ['gig_template_version_id', 'gen_random_uuid()'],
    ['created_at', "now() - interval '1 day'"],
  ])('keeps %s immutable', async (column, expr) => {
    const g = await publishedGig();
    await nextVersion(g, false);
    for (const id of [g.v1])
      await expectRule(pool.query(`UPDATE provider.gig_versions SET ${column} = ${expr} WHERE gig_version_id = $1`, [id]), 'IMMUTABLE_IDENTITY');
  });

  it('refuses client-written lifecycle timestamps on a DRAFT (the guard maintains them)', async () => {
    const g = await makeGig();
    for (const col of ['published_at', 'superseded_at', 'retired_at'])
      await expectRule(pool.query(`UPDATE provider.gig_versions SET ${col} = now() WHERE gig_version_id = $1`, [g.v1]), 'STATUS_TRANSITION');
  });

  it('matches the version status matrix of the contract cell by cell', async () => {
    const reach = async (status: string): Promise<{ g: G; id: string }> => {
      const g = await publishedGig();
      if (status === 'PUBLISHED') return { g, id: g.v1 };
      if (status === 'SUPERSEDED') {
        await nextVersion(g);
        return { g, id: g.v1 };
      }
      if (status === 'RETIRED') {
        await retire(g.gigId);
        return { g, id: g.v1 };
      }
      const d = await makeGig();
      return { g: d, id: d.v1 };
    };
    for (const from of GIG_VERSION_STATUSES) {
      for (const to of GIG_VERSION_STATUSES) {
        if (from === to) continue;
        const { g, id } = await reach(from);
        if (from === 'DRAFT') await fillDraft(id);
        if (from === 'PUBLISHED' && to === 'SUPERSEDED') await nextVersion(g, false); // a newer draft must exist
        const update =
          to === 'PUBLISHED' && from === 'DRAFT'
            ? inTx((c) => publishFirst(g, id, c))
            : pool.query('UPDATE provider.gig_versions SET status = $2 WHERE gig_version_id = $1', [id, to]);
        const outcome = await outcomeOf(update);
        if (isGigVersionStatusTransitionAllowed(from, to)) {
          // RETIRED additionally needs the Gig retired first; a lone supersession leaves the ACTIVE Gig without a PUBLISHED version, which the commit-time check refuses
          const expected = to === 'RETIRED' ? 'GIG_NOT_RETIRED' : to === 'SUPERSEDED' ? 'ACTIVE_GIG_NO_PUBLISHED_VERSION' : 'ACCEPTED';
          expect(outcome, `${from}>${to}`).toBe(expected);
        } else expect(outcome, `${from}>${to}`).toBe('STATUS_TRANSITION');
      }
    }
  });

  it('publishes a complete DRAFT: sets published_at, freezes the content, and keeps the number, revision and template version', async () => {
    const g = await makeGig();
    await fillDraft(g.v1, { price: 4500, duration: undefined });
    const before = await ver(g.v1);
    await inTx((c) => publishFirst(g, g.v1, c));
    const v = await ver(g.v1);
    expect(v.status).toBe('PUBLISHED');
    expect(v.published_at).not.toBeNull();
    expect([v.superseded_at, v.retired_at]).toEqual([null, null]);
    expect({ rev: v.revision, n: v.version_number, tv: v.gig_template_version_id, title: v.title, price: v.price_amount_minor }).toEqual({
      rev: before.revision,
      n: 1,
      tv: g.t.tvId,
      title: 'Full detail',
      price: '4500',
    });
  });

  it('refuses to publish an incomplete DRAFT (title, short pitch, description) and a zero price, leaving the DRAFT untouched', async () => {
    for (const set of ['title = NULL', 'short_pitch = NULL', 'description = NULL']) {
      const g = await makeGig();
      await fillDraft(g.v1);
      await run(`UPDATE provider.gig_versions SET ${set}, revision = revision + 1 WHERE gig_version_id = $1`, [g.v1]);
      await expectConstraint(
        pool.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [g.v1]),
        'ck_gig_versions__published_content',
      );
      expect((await ver(g.v1)).status).toBe('DRAFT');
    }
    const g = await makeGig();
    await fillDraft(g.v1, { price: 0 });
    await expectConstraint(
      pool.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [g.v1]),
      'ck_gig_versions__published_content',
    );
  });

  it('refuses a change in the statement that publishes, supersedes or retires a version', async () => {
    const g = await makeGig();
    await fillDraft(g.v1);
    await expectRule(pool.query("UPDATE provider.gig_versions SET status = 'PUBLISHED', title = 'other' WHERE gig_version_id = $1", [g.v1]), 'VERSION_FROZEN');
    await expectRule(
      pool.query("UPDATE provider.gig_versions SET status = 'PUBLISHED', revision = revision + 1 WHERE gig_version_id = $1", [g.v1]),
      'VERSION_FROZEN',
    );
  });

  it('publishes only against a Gig that is not RETIRED and a template version, template and service type that are not RETIRED (SUPERSEDED and INACTIVE are fine)', async () => {
    const PUBLISH = "UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1";
    const attempt = async (arrange: (g: G) => Promise<unknown>): Promise<string> => {
      const g = await makeGig();
      await fillDraft(g.v1);
      await arrange(g);
      return outcomeOf(inTx((c) => publishFirst(g, g.v1, c)));
    };
    expect(await attempt(async () => undefined)).toBe('ACCEPTED');
    expect(await attempt((g) => setTv(g.t.tvId, 'RETIRED'))).toBe('TEMPLATE_VERSION_RETIRED');
    expect(await attempt((g) => setTv(g.t.tvId, 'SUPERSEDED'))).toBe('ACCEPTED'); // a newer template version does not stop the Gig
    expect(await attempt((g) => setTpl(g.t.tplId, 'RETIRED'))).toBe('TEMPLATE_RETIRED');
    expect(await attempt((g) => setTpl(g.t.tplId, 'INACTIVE'))).toBe('ACCEPTED');
    expect(await attempt((g) => setSt(g.t.stId, 'RETIRED'))).toBe('SERVICE_TYPE_RETIRED');
    expect(await attempt((g) => setSt(g.t.stId, 'INACTIVE'))).toBe('ACCEPTED');
    // a retired Gig: the retirement and the publication in one transaction (a lone retirement of a Gig with an open draft is refused at commit)
    const g = await makeGig();
    await fillDraft(g.v1);
    expect(
      await outcomeOf(
        inTx(async (c) => {
          await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
          await c.query(PUBLISH, [g.v1]);
        }),
      ),
    ).toBe('GIG_RETIRED');
  });

  it('freezes a PUBLISHED, SUPERSEDED or RETIRED version: any content or lifecycle change is refused, a no-op update changes nothing', async () => {
    const pub = await publishedGig();
    const sup = await publishedGig();
    await nextVersion(sup);
    const ret = await publishedGig();
    await retire(ret.gigId);
    for (const id of [pub.v1, sup.v1, ret.v1]) {
      const before = await ver(id);
      for (const set of [
        "title = 'changed'",
        'revision = revision + 1',
        "description = 'x'",
        "price_amount_minor = 1, price_currency = 'USD'",
        'duration_minutes = 5',
        'published_at = now()',
        'superseded_at = now()',
        'retired_at = now()',
      ]) {
        await expectRule(pool.query(`UPDATE provider.gig_versions SET ${set} WHERE gig_version_id = $1`, [id]), 'VERSION_FROZEN');
      }
      await run('UPDATE provider.gig_versions SET updated_at = now() WHERE gig_version_id = $1', [id]);
      expect(await ver(id)).toEqual(before);
    }
  });

  it('supersedes a PUBLISHED version only while a newer draft exists, and sets superseded_at and the new published_at to the same transaction time', async () => {
    const g = await publishedGig();
    await expectRule(pool.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]), 'NO_NEWER_VERSION');
    const v2 = await nextVersion(g);
    const [a, b] = [await ver(g.v1), await ver(v2)];
    expect(a.status).toBe('SUPERSEDED');
    expect(b.status).toBe('PUBLISHED');
    expect(a.superseded_at!.getTime()).toBe(b.published_at!.getTime());
    expect(a.retired_at).toBeNull();
    expect(a.published_at).not.toBeNull();
  });

  it('keeps version 1 intact when version 2 is published (same content, same bound template version)', async () => {
    const g = await publishedGig();
    const before = await ver(g.v1);
    await nextVersion(g);
    const after = await ver(g.v1);
    expect({ ...after, status: before.status, superseded_at: null, updated_at: before.updated_at }).toEqual({ ...before, superseded_at: null });
  });

  it('retires a version only after its Gig is RETIRED, and retires DRAFT and PUBLISHED versions together with it, keeping SUPERSEDED ones', async () => {
    const g = await publishedGig();
    const v2 = await nextVersion(g); // v1 SUPERSEDED, v2 PUBLISHED
    const v3 = await nextVersion(g, false); // a DRAFT
    await expectRule(pool.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_version_id = $1", [v2]), 'GIG_NOT_RETIRED');
    await retire(g.gigId);
    expect((await ver(g.v1)).status).toBe('SUPERSEDED');
    expect([(await ver(v2)).status, (await ver(v3)).status]).toEqual(['RETIRED', 'RETIRED']);
    const r = await ver(v2);
    expect(r.retired_at).not.toBeNull();
    expect(r.superseded_at).toBeNull();
    expect(r.published_at).not.toBeNull(); // the history of a retired published version keeps when it was published
    expect((await ver(v3)).published_at).toBeNull();
  });

  it('checks the lifecycle CHECK of every status (the guard maintains the timestamps, so the triggers are off here)', async () => {
    const g = await makeGig();
    const off = ['ALTER TABLE provider.gig_versions DISABLE TRIGGER USER'];
    const bad = [
      "status = 'PUBLISHED'",
      "status = 'PUBLISHED', published_at = now(), retired_at = now()",
      "status = 'SUPERSEDED', published_at = now()",
      "status = 'RETIRED'",
      "status = 'RETIRED', retired_at = now(), superseded_at = now()",
      'published_at = now()',
    ];
    for (const set of bad)
      await expectConstraint(isolated(off, `UPDATE provider.gig_versions SET ${set} WHERE gig_version_id = $1`, [g.v1]), 'ck_gig_versions__lifecycle');
    await expectConstraint(
      isolated(
        [...off, 'ALTER TABLE provider.gig_versions DROP CONSTRAINT ck_gig_versions__lifecycle'],
        "UPDATE provider.gig_versions SET status = 'ARCHIVED' WHERE gig_version_id = $1",
        [g.v1],
      ),
      'ck_gig_versions__status',
    );
    await expectConstraint(isolated(off, 'UPDATE provider.gig_versions SET version_number = 0 WHERE gig_version_id = $1', [g.v1]), 'ck_gig_versions__number');
    await expectConstraint(isolated(off, 'UPDATE provider.gig_versions SET revision = 0 WHERE gig_version_id = $1', [g.v1]), 'ck_gig_versions__revision');
  });

  it('checks at COMMIT that a Gig and its versions agree: RETIRED keeps no open version, ACTIVE has a PUBLISHED version, DRAFT has none (the deferred invariant)', async () => {
    const commitOutcome = async (body: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
      const c = await openTx();
      const name = (e: PgFailure) => e.detail?.replace('provider_rule:', '') ?? e.code ?? 'ERROR';
      try {
        const early = (await rejection(body(c))) as PgFailure | undefined;
        if (early) return name(early);
        const e = (await rejection(c.query('COMMIT'))) as PgFailure | undefined;
        return e ? name(e) : 'COMMITTED';
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    const g = await publishedGig();
    expect(await commitOutcome((c) => c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]))).toBe('RETIRED_GIG_OPEN_VERSION'); // versions left open
    expect((await gigRow(g.gigId)).status).toBe('ACTIVE'); // rolled back
    expect(await commitOutcome((c) => c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]))).toBe(
      'NO_NEWER_VERSION',
    );
    await nextVersion(g, false); // a newer DRAFT: superseding the published version alone now leaves the ACTIVE Gig without one
    expect(await commitOutcome((c) => c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_version_id = $1", [g.v1]))).toBe(
      'ACTIVE_GIG_NO_PUBLISHED_VERSION',
    );
    const d = await makeGig();
    await fillDraft(d.v1);
    expect(await commitOutcome((c) => c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [d.v1]))).toBe(
      'DRAFT_GIG_PUBLISHED_VERSION',
    ); // published, Gig not activated
    expect(await commitOutcome((c) => publishFirst(d, d.v1, c))).toBe('COMMITTED');
    await retire(g.gigId); // the Gig first, then its versions
    expect((await gigRow(g.gigId)).status).toBe('RETIRED');
    // the check can be made immediate on request (SET CONSTRAINTS)
    const h = await makeGig();
    const c2 = await openTx();
    await c2.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [h.gigId]);
    const e2 = (await rejection(c2.query('SET CONSTRAINTS ALL IMMEDIATE'))) as PgFailure | undefined;
    await c2.query('ROLLBACK');
    c2.release();
    expect(e2?.detail).toBe('provider_rule:RETIRED_GIG_OPEN_VERSION');
  });

  it('never deletes or truncates a version', async () => {
    const g = await makeGig();
    await expectRule(pool.query('DELETE FROM provider.gig_versions WHERE gig_version_id = $1', [g.v1]), 'NO_DELETE');
    await expectRule(pool.query('TRUNCATE provider.gig_versions CASCADE'), 'ROW_IMMUTABLE');
    expect(await count('provider.gig_versions', 'gig_version_id = $1', [g.v1])).toBe(1);
  });

  it('reports a missing Gig or template version through the foreign keys, not through a guard', async () => {
    const g = await publishedGig(); // no open draft, so the unique draft index does not answer first
    await expectConstraint(insertVersion(pool, randomUUID(), 1, g.t.tvId), 'fk_gig_versions__gig_id');
    await expectConstraint(insertVersion(pool, g.gigId, 2, randomUUID()), 'fk_gig_versions__gig_template_version_id');
  });
});

// ====================================================================== E. provider.gig_version_field_values
describe('E. provider.gig_version_field_values', () => {
  it('stores one value per supported type in its own typed column, exactly one column populated', async () => {
    const g = await makeGig();
    const f = g.t.f;
    await setValue(g.v1, f.text, 'text_value', 'ceramic coat');
    await setValue(g.v1, f.longText, 'text_value', 'line one\nline two');
    await setValue(g.v1, f.int, 'integer_value', 42);
    await setValue(g.v1, f.dec, 'decimal_value', '12.345678');
    await setValue(g.v1, f.bool, 'boolean_value', false);
    await setValue(g.v1, f.enum, 'option_code', 'wax');
    await setValue(g.v1, f.dur, 'duration_minutes', 90);
    const rows = await q<Record<string, unknown>>('SELECT * FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]);
    expect(rows).toHaveLength(7);
    for (const r of rows)
      expect([r.text_value, r.integer_value, r.decimal_value, r.boolean_value, r.option_code, r.duration_minutes].filter((x) => x !== null)).toHaveLength(1);
    expect(rows.find((r) => r.gig_template_field_id === f.dec)!.decimal_value).toBe('12.345678');
    expect(rows.find((r) => r.gig_template_field_id === f.bool)!.boolean_value).toBe(false); // false is a value, not unset
  });

  it('serves both foreign keys into the catalogue (the field, and the field with its option) with one index, so a rewrite of a DRAFT template version does not scan the values table', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      for (const [sql, params] of [
        ['SELECT 1 FROM ONLY provider.gig_version_field_values WHERE gig_template_field_id = $1 FOR KEY SHARE', [randomUUID()]],
        ['SELECT 1 FROM ONLY provider.gig_version_field_values WHERE gig_template_field_id = $1 AND option_code = $2 FOR KEY SHARE', [randomUUID(), 'wax']],
      ] as const) {
        const plan = JSON.stringify((await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, [...params])).rows[0]);
        expect(plan, sql).toContain('idx_gig_version_field_values__field_option');
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('refuses a second value for the same field (primary key)', async () => {
    const g = await makeGig();
    await setValue(g.v1, g.t.f.text, 'text_value', 'a');
    await expectConstraint(setValue(g.v1, g.t.f.text, 'text_value', 'b'), 'pk_gig_version_field_values');
  });

  it('refuses a column that does not match the field type (FIELD_TYPE_MISMATCH), for every type and every wrong column', async () => {
    const g = await makeGig();
    const columns: Record<string, unknown> = {
      text_value: 'x',
      integer_value: 1,
      decimal_value: '1.5',
      boolean_value: true,
      option_code: 'wax',
      duration_minutes: 5,
    };
    const right: Record<keyof Fields, string> = {
      text: 'text_value',
      longText: 'text_value',
      int: 'integer_value',
      dec: 'decimal_value',
      bool: 'boolean_value',
      enum: 'option_code',
      dur: 'duration_minutes',
    } as never;
    for (const [name, ok] of Object.entries(right)) {
      for (const [col, v] of Object.entries(columns)) {
        const fieldId = g.t.f[name as keyof Fields];
        const outcome = await outcomeOf(setValue(g.v1, fieldId, col, v));
        expect(outcome, `${name} <- ${col}`).toBe(col === ok ? 'ACCEPTED' : 'FIELD_TYPE_MISMATCH');
        if (outcome === 'ACCEPTED')
          await run('DELETE FROM provider.gig_version_field_values WHERE gig_version_id = $1 AND gig_template_field_id = $2', [g.v1, fieldId]);
      }
    }
  });

  it('requires an ENUM value to be an option of THAT field (composite foreign key), and a non-ENUM value to carry no option', async () => {
    const g = await makeGig();
    await expectConstraint(setValue(g.v1, g.t.f.enum, 'option_code', 'sealant'), 'fk_gig_version_field_values__option');
    await expectConstraint(setValue(g.v1, g.t.f.enum, 'option_code', 'WAX'), 'fk_gig_version_field_values__option');
    const other = await makeTpl(); // an option code that exists on ANOTHER enum field does not help
    await replica((c) =>
      c.query(
        "INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, display_order) VALUES ($1, 'sealant', 'x.s', 3)",
        [other.f.enum],
      ),
    );
    await expectConstraint(setValue(g.v1, g.t.f.enum, 'option_code', 'sealant'), 'fk_gig_version_field_values__option');
    await expectRule(setValue(g.v1, g.t.f.int, 'option_code', 'wax'), 'FIELD_TYPE_MISMATCH');
    await setValue(g.v1, g.t.f.enum, 'option_code', 'ceramic');
  });

  it('refuses a value for a PLATFORM_FIXED field (never copied), an unsupported field type, and a field of another template version', async () => {
    const g = await makeGig();
    const f = g.t.f;
    await expectRule(setValue(g.v1, f.fixedText, 'text_value', 'override'), 'FIELD_FIXED');
    await expectRule(setValue(g.v1, f.fixedInt, 'integer_value', 9), 'FIELD_FIXED');
    await expectRule(setValue(g.v1, f.money, 'integer_value', 100), 'FIELD_TYPE_UNSUPPORTED');
    await expectRule(setValue(g.v1, f.media, 'text_value', 'photo'), 'FIELD_TYPE_UNSUPPORTED');
    const other = await makeTpl();
    await expectRule(setValue(g.v1, other.f.text, 'text_value', 'x'), 'FIELD_NOT_IN_TEMPLATE_VERSION');
    expect(await count('provider.gig_version_field_values', 'gig_version_id = $1', [g.v1])).toBe(0);
  });

  it('checks the value columns: exactly one, non-blank text up to 20000 code points, finite decimals, durations 1..100000', async () => {
    const g = await makeGig();
    const f = g.t.f;
    await expectRule(
      pool.query('INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id) VALUES ($1, $2)', [g.v1, f.text]),
      'FIELD_TYPE_MISMATCH',
    );
    await expectConstraint(
      isolated(
        ['ALTER TABLE provider.gig_version_field_values DISABLE TRIGGER USER'],
        'INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id) VALUES ($1, $2)',
        [g.v1, f.text],
      ),
      'ck_gig_version_field_values__one_value',
    );
    await expectConstraint(
      pool.query("INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, text_value, integer_value) VALUES ($1, $2, 'a', 1)", [
        g.v1,
        f.text,
      ]),
      'ck_gig_version_field_values__one_value',
    );
    await expectConstraint(setValue(g.v1, f.text, 'text_value', '  '), 'ck_gig_version_field_values__text');
    await expectConstraint(setValue(g.v1, f.text, 'text_value', ''), 'ck_gig_version_field_values__text');
    await expectConstraint(setValue(g.v1, f.longText, 'text_value', 'x'.repeat(20001)), 'ck_gig_version_field_values__text');
    await setValue(g.v1, f.longText, 'text_value', 'x'.repeat(20000));
    for (const bad of ['NaN', 'Infinity', '-Infinity'])
      await expectConstraint(setValue(g.v1, f.dec, 'decimal_value', bad), 'ck_gig_version_field_values__decimal');
    await expectConstraint(setValue(g.v1, f.dur, 'duration_minutes', 0), 'ck_gig_version_field_values__duration');
    await expectConstraint(setValue(g.v1, f.dur, 'duration_minutes', 100001), 'ck_gig_version_field_values__duration');
    await setValue(g.v1, f.int, 'integer_value', '9223372036854775807');
  });

  it('does not check the bounds of the template field in the database (the service does): an integer outside min_number is accepted here', async () => {
    const g = await makeGig();
    await replica((c) => c.query('UPDATE catalog.gig_template_fields SET min_number = 10, max_number = 20 WHERE gig_template_field_id = $1', [g.t.f.int]));
    await setValue(g.v1, g.t.f.int, 'integer_value', 5000);
  });

  it('changes (insert, update, delete) only while the version is a DRAFT; a published, superseded or retired version keeps its values', async () => {
    const g = await makeGig();
    await setValue(g.v1, g.t.f.text, 'text_value', 'a');
    await setValue(g.v1, g.t.f.int, 'integer_value', 1);
    await run("UPDATE provider.gig_version_field_values SET text_value = 'b' WHERE gig_version_id = $1 AND gig_template_field_id = $2", [g.v1, g.t.f.text]); // update while DRAFT
    await run('DELETE FROM provider.gig_version_field_values WHERE gig_version_id = $1 AND gig_template_field_id = $2', [g.v1, g.t.f.int]); // draft replace
    await fillDraft(g.v1);
    await inTx((c) => publishFirst(g, g.v1, c));
    await expectRule(setValue(g.v1, g.t.f.dec, 'decimal_value', '1.5'), 'VERSION_FROZEN');
    await expectRule(pool.query("UPDATE provider.gig_version_field_values SET text_value = 'c' WHERE gig_version_id = $1", [g.v1]), 'VERSION_FROZEN');
    await expectRule(pool.query('DELETE FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]), 'VERSION_FROZEN');
    await nextVersion(g); // v1 SUPERSEDED
    await expectRule(pool.query('DELETE FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]), 'VERSION_FROZEN');
    expect((await q<{ text_value: string }>('SELECT text_value FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]))[0]!.text_value).toBe(
      'b',
    );
    const r = await publishedGig();
    await retire(r.gigId);
    await expectRule(setValue(r.v1, r.t.f.text, 'text_value', 'x'), 'VERSION_FROZEN');
  });

  it('keeps version, field and creation time of a value immutable and maintains updated_at', async () => {
    const g = await makeGig();
    const h = await gigFor(await makeProvider([g.t.stId]), g.t);
    await setValue(g.v1, g.t.f.text, 'text_value', 'a');
    await expectRule(
      pool.query('UPDATE provider.gig_version_field_values SET gig_template_field_id = $2 WHERE gig_version_id = $1', [g.v1, g.t.f.longText]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      pool.query('UPDATE provider.gig_version_field_values SET gig_version_id = $2 WHERE gig_version_id = $1', [g.v1, h.v1]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      pool.query("UPDATE provider.gig_version_field_values SET created_at = now() - interval '1 day' WHERE gig_version_id = $1", [g.v1]),
      'IMMUTABLE_IDENTITY',
    );
    const before = (await q<{ updated_at: Date }>('SELECT updated_at FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]))[0]!.updated_at;
    await sleep(5);
    await run("UPDATE provider.gig_version_field_values SET text_value = 'z' WHERE gig_version_id = $1", [g.v1]);
    expect(
      (await q<{ updated_at: Date }>('SELECT updated_at FROM provider.gig_version_field_values WHERE gig_version_id = $1', [g.v1]))[0]!.updated_at.getTime(),
    ).toBeGreaterThan(before.getTime());
    // an update cannot turn the value into a column of another type
    await expectRule(
      pool.query('UPDATE provider.gig_version_field_values SET text_value = NULL, integer_value = 3 WHERE gig_version_id = $1', [g.v1]),
      'FIELD_TYPE_MISMATCH',
    );
  });

  it('reports a missing version or field through the foreign keys and never truncates', async () => {
    const g = await makeGig();
    await expectConstraint(setValue(randomUUID(), g.t.f.text, 'text_value', 'x'), 'fk_gig_version_field_values__version_id');
    await expectConstraint(setValue(g.v1, randomUUID(), 'text_value', 'x'), 'fk_gig_version_field_values__field_id');
    await expectRule(pool.query('TRUNCATE provider.gig_version_field_values'), 'ROW_IMMUTABLE');
  });
});

// ====================================================================== F. provider.gig_audit_events
describe('F. provider.gig_audit_events', () => {
  it('appends an audit row for every documented action, with ids and names only', async () => {
    const g = await publishedGig();
    for (const action of ['GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_RETIRED']) {
      await audit(g, action, { versionId: g.v1, changes: { changedFields: ['title', 'price'], fieldValueCount: 3, revision: 4, versionNumber: 1 } });
    }
    await audit(g, 'GIG_CREATED'); // no version, no changes
    expect(await count('provider.gig_audit_events', 'gig_id = $1', [g.gigId])).toBe(7);
  });

  it('refuses an unknown action, a non-object diff and a blank or oversize actor', async () => {
    const g = await makeGig();
    await expectConstraint(audit(g, 'GIG_DELETED'), 'ck_gig_audit_events__action');
    await expectConstraint(audit(g, 'GIG_CREATED', { changes: ['a'] }), 'ck_gig_audit_events__changes_object');
    await expectConstraint(audit(g, 'GIG_CREATED', { changes: 'text' }), 'ck_gig_audit_events__changes_object');
    await expectConstraint(audit(g, 'GIG_CREATED', { actor: '  ' }), 'ck_gig_audit_events__actor');
    await expectConstraint(audit(g, 'GIG_CREATED', { actor: 'a'.repeat(201) }), 'ck_gig_audit_events__actor');
    await audit(g, 'GIG_CREATED', { actor: 'system:test' });
  });

  it('refuses an audit row whose account does not own the Gig or whose version belongs to another Gig (AUDIT_MISMATCH)', async () => {
    const g = await makeGig();
    const h = await makeGig();
    await expectRule(audit(g, 'GIG_CREATED', { account: h.p.account }), 'AUDIT_MISMATCH');
    await expectRule(audit(g, 'GIG_DRAFT_CREATED', { versionId: h.v1 }), 'AUDIT_MISMATCH');
    await audit(g, 'GIG_DRAFT_CREATED', { versionId: g.v1 });
  });

  it('reports a missing account, Gig or version through the foreign keys', async () => {
    const g = await makeGig();
    await expectRule(audit(g, 'GIG_CREATED', { account: randomUUID() }), 'AUDIT_MISMATCH'); // a real Gig owned by someone else
    await expectConstraint(
      isolated(
        ['ALTER TABLE provider.gig_audit_events DISABLE TRIGGER USER'],
        "INSERT INTO provider.gig_audit_events (actor, account_id, gig_id, action, correlation_id) VALUES ('x', $1, $2, 'GIG_CREATED', 'c')",
        [randomUUID(), g.gigId],
      ),
      'fk_gig_audit_events__account_id',
    );
    await expectConstraint(audit({ gigId: randomUUID(), p: g.p }, 'GIG_CREATED'), 'fk_gig_audit_events__gig_id');
    await expectConstraint(audit(g, 'GIG_CREATED', { versionId: randomUUID() }), 'fk_gig_audit_events__gig_version_id');
  });

  it('is immutable: no UPDATE, no DELETE, no TRUNCATE', async () => {
    const g = await makeGig();
    await audit(g, 'GIG_CREATED');
    await expectRule(pool.query("UPDATE provider.gig_audit_events SET actor = 'someone' WHERE gig_id = $1", [g.gigId]), 'ROW_IMMUTABLE');
    await expectRule(pool.query('DELETE FROM provider.gig_audit_events WHERE gig_id = $1', [g.gigId]), 'ROW_IMMUTABLE');
    await expectRule(pool.query('TRUNCATE provider.gig_audit_events'), 'ROW_IMMUTABLE');
    expect(await count('provider.gig_audit_events', 'gig_id = $1', [g.gigId])).toBe(1);
  });

  it('reads the history of one Gig in time order', async () => {
    const g = await makeGig();
    await audit(g, 'GIG_CREATED');
    await audit(g, 'GIG_DRAFT_UPDATED', { versionId: g.v1 });
    const rows = await q<{ action: string }>('SELECT action FROM provider.gig_audit_events WHERE gig_id = $1 ORDER BY occurred_at, audit_event_id', [g.gigId]);
    expect(rows.map((r) => r.action)).toEqual(['GIG_CREATED', 'GIG_DRAFT_UPDATED']);
  });
});

// ====================================================================== G. concurrency (real interleavings; lock waiters polled, no sleeps)
describe('G. concurrency', () => {
  it('serializes a field-value write behind a concurrent publication: the write waits, then sees a PUBLISHED version and is refused', async () => {
    const g = await makeGig();
    await fillDraft(g.v1);
    const e = await holdThenRace((c) => publishFirst(g, g.v1, c), {
      text: 'INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, text_value) VALUES ($1, $2, $3)',
      params: [g.v1, g.t.f.text, 'late'],
    });
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:VERSION_FROZEN' });
    expect(await count('provider.gig_version_field_values', 'gig_version_id = $1', [g.v1])).toBe(0);
  });

  it('serializes a publication behind a concurrent field-value write: the publication waits for the writer and then succeeds with the value stored', async () => {
    const g = await makeGig();
    await fillDraft(g.v1);
    const e = await holdThenRace(
      (c) =>
        c.query('INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, text_value) VALUES ($1, $2, $3)', [
          g.v1,
          g.t.f.text,
          'first',
        ]),
      (c) => publishFirst(g, g.v1, c),
    );
    expect(e).toBeUndefined();
    expect((await ver(g.v1)).status).toBe('PUBLISHED');
    expect(await count('provider.gig_version_field_values', 'gig_version_id = $1', [g.v1])).toBe(1);
  });

  it('refuses a publication that waited for the retirement of its template (the template row is read FOR SHARE)', async () => {
    const g = await makeGig();
    await fillDraft(g.v1);
    const e = await holdThenRace(
      async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE catalog.gig_templates SET status = 'RETIRED' WHERE gig_template_id = $1", [g.t.tplId]);
      },
      (c) => publishFirst(g, g.v1, c),
    );
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:TEMPLATE_RETIRED' });
    expect((await ver(g.v1)).status).toBe('DRAFT');
  });

  it('refuses a publication that waited for the retirement of its service type', async () => {
    const g = await makeGig();
    await fillDraft(g.v1);
    const e = await holdThenRace(
      async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE catalog.service_types SET status = 'RETIRED' WHERE service_type_id = $1", [g.t.stId]);
      },
      (c) => publishFirst(g, g.v1, c),
    );
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:SERVICE_TYPE_RETIRED' });
  });

  it('refuses a Gig creation that waited for the deactivation of its service type', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    const e = await holdThenRace(
      async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE catalog.service_types SET status = 'INACTIVE' WHERE service_type_id = $1", [t.stId]);
      },
      { text: 'INSERT INTO provider.gigs (account_id, gig_template_id) VALUES ($1, $2)', params: [p.account, t.tplId] },
    );
    expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'provider_rule:SERVICE_TYPE_NOT_ACTIVE' });
    expect(await count('provider.gigs', 'account_id = $1', [p.account])).toBe(0);
  });

  it('refuses a draft update that waited for the retirement of its Gig (the Gig row is read FOR SHARE)', async () => {
    const g = await makeGig();
    const e = await holdThenRace(
      async (c) => {
        await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
        await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [g.gigId]);
      },
      { text: "UPDATE provider.gig_versions SET title = 'late', revision = revision + 1 WHERE gig_version_id = $1", params: [g.v1] },
    );
    expect(e).toBeDefined();
    expect(['GIG_RETIRED', 'VERSION_FROZEN']).toContain(e!.detail?.replace('provider_rule:', ''));
    expect((await ver(g.v1)).title).toBeNull();
  });

  it.each([
    ['a publication', async (g: G, c: pg.PoolClient): Promise<void> => publishFirst(g, g.v1, c), false],
    ['a next draft', async (g: G, c: pg.PoolClient): Promise<void> => void (await insertVersion(c, g.gigId, 2, g.t.tvId)), true],
    ['a first version', async (g: G, c: pg.PoolClient): Promise<void> => void (await insertVersion(c, g.gigId, 1, g.t.tvId)), 'bare'],
  ] as const)(
    'takes the catalogue locks in the catalogue order (template, then version), so %s and a catalogue transaction that locks the template and then its version do not deadlock',
    async (_what, work, setup) => {
      // The catalogue service locks a template FOR UPDATE and then its version FOR UPDATE. A guard that locked the version FOR SHARE first and the template second would deadlock with it.
      let g: G;
      if (setup === 'bare') {
        const t = await makeTpl();
        const p = await makeProvider([t.stId]);
        g = { p, t, gigId: await bareGig(p.account, t.tplId), v1: '' };
      } else if (setup) {
        g = await publishedGig();
      } else {
        g = await makeGig();
        await fillDraft(g.v1);
      }
      const catalogue = await openTx();
      await catalogue.query('SELECT 1 FROM catalog.gig_templates WHERE gig_template_id = $1 FOR UPDATE', [g.t.tplId]);
      const racer = rejection(runRacer(racePool, (c) => work(g, c)));
      await lockWaiters(1); // the guard waits for the TEMPLATE, holding nothing of the version yet
      await catalogue.query('SELECT 1 FROM catalog.gig_template_versions WHERE gig_template_version_id = $1 FOR UPDATE', [g.t.tvId]); // would deadlock with the old order
      await finish(catalogue, 'COMMIT');
      const e = (await racer) as PgFailure | undefined;
      notDeadlock(e);
      expect(e).toBeUndefined();
    },
  );

  it('lets exactly one of two simultaneous creations with the same client request id win, and never deadlocks', async () => {
    const t = await makeTpl();
    const p = await makeProvider([t.stId]);
    for (let round = 0; round < 5; round++) {
      const key = randomUUID();
      const create = async (c: pg.PoolClient) => {
        const gigId = ((await insertGig(c, p.account, t.tplId, key)).rows[0] as { gig_id: string }).gig_id;
        await insertVersion(c, gigId, 1, t.tvId);
      };
      const r = await both(create, create);
      expect(winners(r)).toBe(1);
      for (const e of r) {
        notDeadlock(e);
        if (e) expect(e.constraint).toBe('uq_gigs__client_request');
      }
    }
  });

  it('lets exactly one of two simultaneous next drafts win (one DRAFT per Gig, contiguous numbers) and never deadlocks', async () => {
    const g = await publishedGig();
    for (let round = 0; round < 3; round++) {
      const next = (await q<{ n: number }>('SELECT max(version_number) + 1 AS n FROM provider.gig_versions WHERE gig_id = $1', [g.gigId]))[0]!.n;
      const draft = {
        text: 'INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, $2, $3)',
        params: [g.gigId, next, g.t.tvId],
      };
      const r = await both(draft, draft);
      expect(winners(r)).toBe(1);
      for (const e of r) {
        notDeadlock(e);
        if (e) expect(['uq_gig_versions__draft', 'uq_gig_versions__number', 'provider_rule:VERSION_NUMBER']).toContain(e.constraint ?? e.detail);
      }
      // publish the draft that won (supersede first), so the next round starts from a published Gig again
      await inTx(async (c) => {
        const d = (
          await q<{ gig_version_id: string }>("SELECT gig_version_id FROM provider.gig_versions WHERE gig_id = $1 AND status = 'DRAFT'", [g.gigId], c)
        )[0]!.gig_version_id;
        await fillDraft(d, {}, c);
        await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_id = $1 AND status = 'PUBLISHED'", [g.gigId]);
        await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [d]);
      });
    }
    expect(await count('provider.gig_versions', "gig_id = $1 AND status = 'PUBLISHED'", [g.gigId])).toBe(1);
  });

  it('lets exactly one of two simultaneous publications of the same draft win and leaves exactly one PUBLISHED version', async () => {
    for (let round = 0; round < 3; round++) {
      const g = await makeGig();
      await fillDraft(g.v1);
      const publish = async (c: pg.PoolClient) => {
        const r = await c.query(
          "UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1 AND status = 'DRAFT' RETURNING gig_version_id",
          [g.v1],
        );
        if (r.rowCount !== 1) throw Object.assign(new Error('lost'), { code: 'LOST' });
        await c.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [g.gigId]);
      };
      const r = await both(publish, publish);
      expect(winners(r)).toBe(1);
      for (const e of r) notDeadlock(e);
      expect(await count('provider.gig_versions', "gig_id = $1 AND status = 'PUBLISHED'", [g.gigId])).toBe(1);
    }
  });

  it('keeps the invariants under many interleaved publish, supersede and retire sequences: one PUBLISHED and one DRAFT at most per Gig, contiguous numbers, no open version in a retired Gig', async () => {
    const gigs: G[] = [];
    for (let i = 0; i < 4; i++) gigs.push(await publishedGig());
    await Promise.all(
      gigs.map(async (g, i) => {
        for (let k = 0; k < 3; k++) await rejection(nextVersion(g, true));
        if (i % 2 === 0) await retire(g.gigId);
      }),
    );
    expect(await q("SELECT gig_id FROM provider.gig_versions WHERE status = 'PUBLISHED' GROUP BY 1 HAVING count(*) > 1")).toEqual([]);
    expect(await q("SELECT gig_id FROM provider.gig_versions WHERE status = 'DRAFT' GROUP BY 1 HAVING count(*) > 1")).toEqual([]);
    expect(
      await q(
        'SELECT gig_id, min(version_number), max(version_number), count(*) FROM provider.gig_versions GROUP BY 1 HAVING min(version_number) <> 1 OR max(version_number) <> count(*)',
      ),
    ).toEqual([]);
    expect(
      await q(
        "SELECT g.gig_id FROM provider.gigs g JOIN provider.gig_versions v USING (gig_id) WHERE g.status = 'RETIRED' AND v.status IN ('DRAFT', 'PUBLISHED')",
      ),
    ).toEqual([]);
    expect(
      await q(
        "SELECT g.gig_id FROM provider.gigs g WHERE g.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM provider.gig_versions v WHERE v.gig_id = g.gig_id AND v.status = 'PUBLISHED')",
      ),
    ).toEqual([]);
  });
});
