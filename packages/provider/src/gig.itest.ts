// Integration tests of ProviderGigService (CAT-003) over a real, freshly migrated PostgreSQL database (migration 0020 with its guard triggers and seeds).
//
// Everything is asserted against the rows the database holds (gigs, versions, field values, Gig audit events, the outbox), never against the service's own return value alone.
// Domain packages never import each other, so the ports the service needs are FAKES that live here:
//  - AccountPort: reads the real identity rows (the same semantics as the identity service's facts); it joins the service's transaction like the real one.
//  - GigTemplatePort: reads the real catalogue rows with plain SQL and, like the real port over the catalogue service, opens its own REPEATABLE READ snapshot, which cannot nest:
//    a service that called it inside a transaction would fail with TransactionOptionError, so every test proves the external reads happen BEFORE the transaction.
//  - GigPolicyProvider: a static policy the test changes.
// Catalogue fixtures (categories, service types, Gig Templates with fields, options and requirements, versions, market availability) are built with plain SQL through the same
// guards the catalogue service uses. Statements issued by the ports are counted separately from the statements of the service (an AsyncLocalStorage marks the port scope).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIG_EVENTS, type GigDetailDto, type GigIssueDto, type ProviderGigPolicy } from '@bananagig/contracts';
import { sql, TransactionOptionError, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  GigError,
  ProviderError,
  ProviderGigService,
  StaticGigPolicyProvider,
  gigsPrerequisite,
  type AccountFacts,
  type AccountPort,
  type GigTemplateFieldFacts,
  type GigTemplateOffer,
  type GigTemplatePort,
  type GigTemplateStructure,
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
// provider-written text: every one of these must NEVER reach an audit row, an event, a log line or an error
const CANARY_TITLE = 'Zebra Canary Title';
const CANARY_PITCH = 'Zebra canary pitch';
const CANARY_DESC = 'Zebra canary description with detail';
const CANARY_TEXT = 'zebra canary field text';
const CANARIES = [CANARY_TITLE, CANARY_PITCH, CANARY_DESC, CANARY_TEXT, 'Zebra', 'canary'];

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const portScope = new AsyncLocalStorage<true>();
const svcStatements: string[] = [];
const portStatements: string[] = [];
const DEFAULT_POLICY: ProviderGigPolicy = { maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 };
const policyProvider = new StaticGigPolicyProvider({ ...DEFAULT_POLICY });
const setPolicy = (over: Partial<ProviderGigPolicy>): void => {
  policyProvider.value = { ...DEFAULT_POLICY, ...over };
};
/** Everything a port was asked while a test ran, and whether it was asked inside a transaction. */
const portCalls: { port: string; inTransaction: boolean }[] = [];

class FakeAccounts implements AccountPort {
  constructor(private readonly database: Database) {}
  /** Lets a test fail, or change the world, on a given call (1-based per test, `inTransaction` tells where the service is). */
  hook: ((n: number, inTransaction: boolean) => Promise<void>) | undefined;
  calls = 0;
  async facts(accountId: string): Promise<AccountFacts> {
    portCalls.push({ port: 'accounts.facts', inTransaction: this.database.inTransaction });
    await this.hook?.(++this.calls, this.database.inTransaction);
    return portScope.run(true, async () => {
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
  }
  async grantRole(): Promise<{ changed: boolean; status: string }> {
    throw new Error('the Gig service never grants roles');
  }
}

class FakeTemplates implements GigTemplatePort {
  /** A template whose structure the port must report differently from the database (a port that lies). */
  overrides = new Map<string, (s: GigTemplateStructure) => GigTemplateStructure>();
  constructor(private readonly database: Database) {}

  /** Like the real port: its own repeatable-read snapshot, which cannot nest inside another transaction. */
  private snapshot<T>(port: string, fn: () => Promise<T>): Promise<T> {
    portCalls.push({ port, inTransaction: this.database.inTransaction });
    return portScope.run(true, () => this.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true }));
  }
  private async structure(versionId: string): Promise<GigTemplateStructure | null> {
    const db = this.database.db;
    const v = (
      await sql<Row>`SELECT v.*, t.gig_template_id AS template_id, t.code, t.status AS template_status, t.name_content_key, t.description_content_key, t.instructions_content_key,
             st.code AS service_type_code, st.status AS service_type_status, c.code AS category_code
        FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
        JOIN catalog.service_types st ON st.service_type_id = t.service_type_id JOIN catalog.categories c ON c.category_id = st.category_id
       WHERE v.gig_template_version_id = ${versionId}`.execute(db)
    ).rows[0];
    if (!v) return null;
    const fields = (await sql<Row>`SELECT * FROM catalog.gig_template_fields WHERE gig_template_version_id = ${versionId} ORDER BY display_order`.execute(db))
      .rows;
    const options = fields.length
      ? (
          await sql<Row>`SELECT * FROM catalog.gig_template_field_options WHERE gig_template_field_id = ANY(${fields.map((f) => f.gig_template_field_id as string)}::uuid[]) ORDER BY display_order`.execute(
            db,
          )
        ).rows
      : [];
    const reqs = (
      await sql<Row>`SELECT requirement_type, reference_code FROM catalog.gig_template_requirements WHERE gig_template_version_id = ${versionId} ORDER BY requirement_type, reference_code NULLS FIRST`.execute(
        db,
      )
    ).rows;
    const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
    const out: GigTemplateStructure = {
      gigTemplateId: v.template_id as string,
      gigTemplateCode: v.code as string,
      templateStatus: v.template_status as string,
      serviceTypeCode: v.service_type_code as string,
      serviceTypeStatus: v.service_type_status as string,
      categoryCode: v.category_code as string,
      nameContentKey: v.name_content_key as string,
      descriptionContentKey: (v.description_content_key as string | null) ?? null,
      instructionsContentKey: (v.instructions_content_key as string | null) ?? null,
      gigTemplateVersionId: versionId,
      versionNumber: Number(v.version_number),
      versionStatus: v.status as GigTemplateStructure['versionStatus'],
      duration: { minMinutes: num(v.min_duration_minutes), maxMinutes: num(v.max_duration_minutes), suggestedMinutes: num(v.suggested_duration_minutes) },
      pricing: { fixed: v.pricing_fixed === true, fixedWithVariants: v.pricing_fixed_with_variants === true },
      fields: fields.map((f): GigTemplateFieldFacts => {
        const mine = options.filter((o) => o.gig_template_field_id === f.gig_template_field_id);
        return {
          gigTemplateFieldId: f.gig_template_field_id as string,
          fieldKey: f.field_key as string,
          fieldType: f.field_type as string,
          section: f.section as string,
          behavior: f.behavior as GigTemplateFieldFacts['behavior'],
          customerVisible: f.customer_visible === true,
          displayOrder: Number(f.display_order),
          labelContentKey: f.label_content_key as string,
          helpContentKey: (f.help_content_key as string | null) ?? null,
          defaultContentKey: (f.default_content_key as string | null) ?? null,
          defaultNumber: num(f.default_number),
          defaultBoolean: f.default_boolean === null ? null : f.default_boolean === true,
          defaultOption: (mine.find((o) => o.is_default === true)?.option_code as string | undefined) ?? null,
          minLength: num(f.min_length),
          maxLength: num(f.max_length),
          minNumber: num(f.min_number),
          maxNumber: num(f.max_number),
          options: mine.map((o) => ({
            optionCode: o.option_code as string,
            displayOrder: Number(o.display_order),
            isDefault: o.is_default === true,
            labelContentKey: o.label_content_key as string,
          })),
        };
      }),
      requirements: reqs.map((r) => ({ requirementType: r.requirement_type as string, referenceCode: (r.reference_code as string | null) ?? null })),
    };
    const o = this.overrides.get(out.gigTemplateCode);
    return o ? o(out) : out;
  }
  async exactVersion(id: string): Promise<GigTemplateStructure | null> {
    return this.snapshot('templates.exactVersion', () => this.structure(id));
  }
  async byCode(code: string): Promise<GigTemplateStructure | null> {
    return this.snapshot('templates.byCode', async () => {
      const v = (
        await sql<Row>`SELECT v.gig_template_version_id FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
         WHERE t.code = ${code} AND v.status <> 'DRAFT' ORDER BY (v.status = 'ACTIVE') DESC, v.version_number DESC LIMIT 1`.execute(this.database.db)
      ).rows[0];
      return v ? this.structure(v.gig_template_version_id as string) : null;
    });
  }
  async enabledInMarket(marketCode: string, gigTemplateId: string): Promise<boolean> {
    return this.snapshot('templates.enabledInMarket', async () => {
      const r = (
        await sql<Row>`SELECT mgt.enabled FROM catalog.market_gig_templates mgt JOIN geography.markets m ON m.market_id = mgt.market_id
         WHERE m.code = ${marketCode} AND mgt.gig_template_id = ${gigTemplateId}`.execute(this.database.db)
      ).rows[0];
      return r?.enabled === true;
    });
  }
  async forCreate(marketCode: string, code: string): Promise<GigTemplateStructure | null> {
    return this.snapshot('templates.forCreate', async () => {
      const v = (
        await sql<Row>`SELECT v.gig_template_version_id FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
          JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
          JOIN catalog.market_gig_templates mgt ON mgt.gig_template_id = t.gig_template_id JOIN geography.markets m ON m.market_id = mgt.market_id
         WHERE t.code = ${code} AND v.status = 'ACTIVE' AND t.status = 'ACTIVE' AND st.status = 'ACTIVE' AND mgt.enabled AND m.code = ${marketCode}`.execute(
          this.database.db,
        )
      ).rows[0];
      return v ? this.structure(v.gig_template_version_id as string) : null;
    });
  }
  async offered(marketCode: string, serviceTypeCodes: readonly string[]): Promise<readonly GigTemplateOffer[]> {
    return this.snapshot('templates.offered', async () =>
      (
        await sql<Row>`SELECT t.code, st.code AS service_type_code, c.code AS category_code, t.name_content_key, t.description_content_key, v.version_number
          FROM catalog.market_gig_templates mgt JOIN geography.markets m ON m.market_id = mgt.market_id JOIN catalog.gig_templates t ON t.gig_template_id = mgt.gig_template_id
          JOIN catalog.service_types st ON st.service_type_id = t.service_type_id JOIN catalog.categories c ON c.category_id = st.category_id
          JOIN catalog.gig_template_versions v ON v.gig_template_id = t.gig_template_id AND v.status = 'ACTIVE'
         WHERE m.code = ${marketCode} AND mgt.enabled AND t.status = 'ACTIVE' AND st.status = 'ACTIVE' AND st.code = ANY(${[...serviceTypeCodes]}::text[])
         ORDER BY mgt.display_order, t.code COLLATE "C"`.execute(this.database.db)
      ).rows.map((r) => ({
        gigTemplateCode: r.code as string,
        serviceTypeCode: r.service_type_code as string,
        categoryCode: r.category_code as string,
        nameContentKey: r.name_content_key as string,
        descriptionContentKey: (r.description_content_key as string | null) ?? null,
        versionNumber: Number(r.version_number),
      })),
    );
  }
}

let accounts: FakeAccounts;
let templates: FakeTemplates;
let svc: ProviderGigService;

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      overrides: { poolMax: 40, connectionTimeoutMs: 30_000 },
      onQuery: (e) => (portScope.getStore() ? portStatements : svcStatements).push(e.sql),
    },
  });
  pool = createTestPool(iso.url, 10);
  accounts = new FakeAccounts(iso.database);
  templates = new FakeTemplates(iso.database);
  svc = new ProviderGigService({ database: iso.database, accounts, templates, policy: policyProvider });
});
beforeEach(() => {
  setPolicy({});
  policyProvider.failure = undefined;
  policyProvider.reads = 0;
  templates.overrides.clear();
  accounts.hook = undefined;
  accounts.calls = 0;
  portCalls.length = 0;
});
afterEach(async () => {
  for (const rollback of openRaw) await rollback().catch(() => undefined);
  openRaw.clear();
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Row>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const one = async <T = Row>(text: string, params: unknown[] = []): Promise<T> => (await q<T>(text, params))[0]!;

// ---------------------------------------------------------------- raw sessions and waiting
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
async function withoutTriggers<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}

// ---------------------------------------------------------------- builders: accounts and the catalogue chain
let seq = 0;
const nextSeq = (): number => ++seq;
async function mkAccount(): Promise<string> {
  const n = nextSeq();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'ACTIVE', 'test', 'test')",
      [id],
    );
    await c.query(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
       SELECT $1, role_id, 'ACTIVE', now(), 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code = 'CUSTOMER'`,
      [id],
    );
    await c.query(`UPDATE identity.accounts SET primary_role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER') WHERE account_id = $1`, [id]);
    await c.query("INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, 'Ada', 'Tester')", [id]);
    await c.query(
      `INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())`,
      [id, `gig.itest.${n}@example.test`],
    );
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
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
async function setProviderRole(accountId: string, status: 'PENDING' | 'ACTIVE' | 'INACTIVE'): Promise<void> {
  const exists = (
    await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 AND r.code = 'PROVIDER'`,
      [accountId],
    )
  ).n;
  if (!exists)
    await q(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
       SELECT $1, role_id, $2, CASE WHEN $2 = 'ACTIVE' THEN now() END, 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code = 'PROVIDER'`,
      [accountId, status === 'INACTIVE' ? 'ACTIVE' : status],
    );
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

async function putContent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'PLAIN_TEXT', 'CONTENT', 'gig integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gig-itest' FROM unnest($1::text[]) AS k ON CONFLICT (key) DO NOTHING`,
    [keys],
  );
  await q(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
     SELECT e.entry_id, 'en-US', 'PLATFORM', NULL, 1, 'copy ' || e.key, 'DRAFT', 'NONE', now(), 'gig itest', 'gig-itest' FROM content.entries e
      WHERE e.key = ANY($1) AND NOT EXISTS (SELECT 1 FROM content.versions v WHERE v.entry_id = e.entry_id)`,
    [keys],
  );
  await q(
    `UPDATE content.versions v SET status = 'APPROVED', updated_at = now() FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = ANY($1) AND v.status = 'DRAFT'`,
    [keys],
  );
  await q(
    `UPDATE content.versions v SET status = 'PUBLISHED', updated_at = now() FROM content.entries e WHERE e.entry_id = v.entry_id AND e.key = ANY($1) AND v.status = 'APPROVED'`,
    [keys],
  );
}

async function mkMarket(currency?: string): Promise<string> {
  const c = `devtest-gm${nextSeq()}`;
  await q(
    `WITH m AS (
       INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $1, 'Test market', country_id, 'PLANNED', default_locale, COALESCE($2, currency_code), default_time_zone_id, now() - interval '1 day' FROM geography.markets WHERE code = 'la-oc'
       RETURNING market_id, country_id, default_locale)
     INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM m`,
    [c, currency ?? null],
  );
  await q("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = $1", [c]);
  return c;
}
const marketCurrency = async (market: string): Promise<string> =>
  (await one<{ c: string }>('SELECT currency_code::text AS c FROM geography.markets WHERE code = $1', [market])).c.trim();
/** A currency that is not the currency of the base test market. */
const otherCurrency = async (): Promise<string> => {
  await q(
    "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, symbol, status) VALUES ('EUR', '978', 2, 'Euro', '€', 'ACTIVE') ON CONFLICT DO NOTHING",
  );
  return 'EUR';
};

interface Offer {
  market: string;
  category: string;
  types: string[];
}
async function mkOffer(market: string, n = 2): Promise<Offer> {
  const stem = `gt${nextSeq()}`;
  const category = `${stem}_cat`;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'gig integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gig-itest' FROM unnest($1::text[]) AS k`,
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

// ---- Gig Templates
interface TplField {
  key: string;
  type: string;
  behavior?: 'PLATFORM_FIXED' | 'PROVIDER_CONFIGURABLE' | 'PROVIDER_REQUIRED';
  minLength?: number;
  maxLength?: number;
  minNumber?: number;
  maxNumber?: number;
  options?: string[];
  defaultOption?: string;
  withDefaultText?: boolean;
  minItems?: number;
}
interface TplSpec {
  fields?: TplField[];
  /** [min, max, suggested]; null = no duration guidance at all. */
  duration?: [number | null, number | null, number | null] | null;
  pricing?: { fixed?: boolean; variants?: boolean };
  requirements?: { type: string; ref?: string }[];
}
/** The standard template: required text, optional enum / decimal / boolean / duration / long text, a fixed long text, a required integer and an optional unsupported MEDIA field. */
const stdSpec = (): TplSpec => ({
  duration: [60, 240, 120],
  pricing: { fixed: true },
  fields: [
    { key: 'notes', type: 'TEXT', behavior: 'PROVIDER_REQUIRED', minLength: 3, maxLength: 50 },
    { key: 'finish', type: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE', options: ['wax', 'sealant', 'ceramic'], defaultOption: 'wax' },
    { key: 'vehicles', type: 'INTEGER', behavior: 'PROVIDER_REQUIRED', minNumber: 1, maxNumber: 4 },
    { key: 'weight', type: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0.5, maxNumber: 10 },
    { key: 'express', type: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE' },
    { key: 'extra_time', type: 'DURATION', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 15, maxNumber: 60 },
    { key: 'details', type: 'LONG_TEXT', behavior: 'PROVIDER_CONFIGURABLE', maxLength: 200 },
    { key: 'intro', type: 'LONG_TEXT', behavior: 'PLATFORM_FIXED', withDefaultText: true },
    { key: 'photos', type: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE' },
  ],
  requirements: [{ type: 'SKILL', ref: 'wax_application' }, { type: 'LICENSE' }],
});
const stem = (code: string): string => `catalog.gig_template.${code}`;
interface Tpl {
  code: string;
  templateId: string;
  versionId: string;
  serviceType: string;
}
async function addVersion(code: string, spec: TplSpec): Promise<string> {
  const keys: string[] = [];
  for (const f of spec.fields ?? []) {
    keys.push(`${stem(code)}.field.${f.key}.label`);
    if (f.withDefaultText) keys.push(`${stem(code)}.field.${f.key}.default`);
    for (const o of f.options ?? []) keys.push(`${stem(code)}.field.${f.key}.option.${o}.label`);
  }
  await putContent(keys);
  const t = await one<{ gig_template_id: string; n: number }>(
    'SELECT t.gig_template_id, COALESCE((SELECT max(version_number) FROM catalog.gig_template_versions v WHERE v.gig_template_id = t.gig_template_id), 0)::int + 1 AS n FROM catalog.gig_templates t WHERE t.code = $1',
    [code],
  );
  const versionId = (
    await one<{ gig_template_version_id: string }>(
      'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, $2) RETURNING gig_template_version_id',
      [t.gig_template_id, t.n],
    )
  ).gig_template_version_id;
  const d = spec.duration === undefined ? ([60, 240, 120] as const) : (spec.duration ?? ([null, null, null] as const));
  await q(
    `UPDATE catalog.gig_template_versions SET min_duration_minutes = $2, max_duration_minutes = $3, suggested_duration_minutes = $4, pricing_fixed = $5, pricing_fixed_with_variants = $6 WHERE gig_template_version_id = $1`,
    [versionId, d[0], d[1], d[2], spec.pricing?.fixed ?? true, spec.pricing?.variants ?? false],
  );
  let order = 0;
  for (const f of spec.fields ?? []) {
    order++;
    const label = `${stem(code)}.field.${f.key}.label`;
    const fieldId = (
      await one<{ gig_template_field_id: string }>(
        `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, default_content_key, min_length, max_length, min_number, max_number, min_items)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING gig_template_field_id`,
        [
          versionId,
          f.key,
          f.type,
          f.behavior ?? 'PROVIDER_CONFIGURABLE',
          order,
          label,
          f.withDefaultText ? `${stem(code)}.field.${f.key}.default` : null,
          f.minLength ?? null,
          f.maxLength ?? null,
          f.minNumber ?? null,
          f.maxNumber ?? null,
          f.minItems ?? null,
        ],
      )
    ).gig_template_field_id;
    let o = 0;
    for (const opt of f.options ?? []) {
      o++;
      await q(
        'INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, is_default, display_order) VALUES ($1, $2, $3, $4, $5)',
        [fieldId, opt, `${stem(code)}.field.${f.key}.option.${opt}.label`, f.defaultOption === opt, o],
      );
    }
  }
  for (const r of spec.requirements ?? [])
    await q('INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type, reference_code) VALUES ($1, $2, $3)', [
      versionId,
      r.type,
      r.ref ?? null,
    ]);
  await q("UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1", [versionId]);
  return versionId;
}
/** An ACTIVE template with a published ACTIVE version 1, enabled in the market. */
async function mkTemplate(offer: Offer, spec: TplSpec = stdSpec(), o: { typeIndex?: number; enable?: boolean } = {}): Promise<Tpl> {
  const code = `devtest_gtpl${nextSeq()}`;
  const serviceType = offer.types[o.typeIndex ?? 0]!;
  await putContent([`${stem(code)}.name`]);
  const templateId = (
    await one<{ gig_template_id: string }>(
      'INSERT INTO catalog.gig_templates (service_type_id, code) SELECT service_type_id, $2 FROM catalog.service_types WHERE code = $1 RETURNING gig_template_id',
      [serviceType, code],
    )
  ).gig_template_id;
  await q("UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE gig_template_id = $1", [templateId]);
  const versionId = await addVersion(code, spec);
  if (o.enable !== false)
    await q(
      `INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order)
       SELECT m.market_id, $2, true, COALESCE((SELECT max(display_order) FROM catalog.market_gig_templates x WHERE x.market_id = m.market_id), 0) + 10 FROM geography.markets m WHERE m.code = $1`,
      [offer.market, templateId],
    );
  return { code, templateId, versionId, serviceType };
}
const setTemplateStatus = (code: string, status: string) => q('UPDATE catalog.gig_templates SET status = $2 WHERE code = $1', [code, status]);
const setServiceTypeStatus = (code: string, status: string) => q('UPDATE catalog.service_types SET status = $2 WHERE code = $1', [code, status]);
const setAvailability = (market: string, templateId: string, enabled: boolean) =>
  q(
    'UPDATE catalog.market_gig_templates SET enabled = $3 WHERE market_id = (SELECT market_id FROM geography.markets WHERE code = $1) AND gig_template_id = $2',
    [market, templateId, enabled],
  );

interface Provider {
  accountId: string;
  offer: Offer;
  market: string;
  currency: string;
  tpl: Tpl;
}
/** An ACTIVE account holding an ACTIVE PROVIDER role and a COMPLETED registration in the offer's market with the offer's service types selected, built by plain SQL. */
async function mkRegistered(offer: Offer, selected: string[] = offer.types): Promise<string> {
  const accountId = await mkAccount();
  await setProviderRole(accountId, 'ACTIVE');
  const regId = (
    await one<{ provider_registration_id: string }>(
      'INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1) RETURNING provider_registration_id',
      [accountId],
    )
  ).provider_registration_id;
  await q('UPDATE provider.registrations SET market_id = (SELECT market_id FROM geography.markets WHERE code = $2) WHERE provider_registration_id = $1', [
    regId,
    offer.market,
  ]);
  for (const t of selected)
    await q(
      'INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) SELECT $1, service_type_id FROM catalog.service_types WHERE code = $2',
      [regId, t],
    );
  await q("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [regId]);
  return accountId;
}
/** A market, an offer, a template and a registered provider: everything a Gig needs. */
async function mkProvider(o: { currency?: string; spec?: TplSpec; types?: number } = {}): Promise<Provider> {
  const market = await mkMarket(o.currency);
  const offer = await mkOffer(market, o.types ?? 2);
  const tpl = await mkTemplate(offer, o.spec);
  const accountId = await mkRegistered(offer);
  return { accountId, offer, market, currency: await marketCurrency(market), tpl };
}
/** A second provider in the same market with the same template (the other account of an IDOR test). */
const mkNeighbour = async (p: Provider): Promise<string> => mkRegistered(p.offer);

// ---------------------------------------------------------------- observation
const err = async (p: Promise<unknown>): Promise<GigError | undefined> => (await rejection(p)) as GigError | undefined;
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<GigError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(GigError);
  expect(e!.code, JSON.stringify(e!.details)).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(e!.details.reason).toBe(reasonWanted);
  return e!;
};
const surface = (e: GigError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const isTxControl = (s: string): boolean => /^(start transaction|begin|commit|rollback)/i.test(s);
const counting = async <T>(fn: () => Promise<T>): Promise<{ result: T; svc: string[]; port: string[] }> => {
  const s0 = svcStatements.length;
  const p0 = portStatements.length;
  const result = await fn();
  return { result, svc: svcStatements.slice(s0).filter((x) => !isTxControl(x)), port: portStatements.slice(p0).filter((x) => !isTxControl(x)) };
};

interface GigRowDb {
  gig_id: string;
  account_id: string;
  gig_template_id: string;
  status: string;
  client_request_id: string | null;
  retired_at: Date | null;
}
const gigRows = (accountId: string) => q<GigRowDb>('SELECT * FROM provider.gigs WHERE account_id = $1 ORDER BY created_at, gig_id', [accountId]);
interface VerRowDb {
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
  published_at: Date | null;
  superseded_at: Date | null;
  retired_at: Date | null;
}
const verRows = (gigId: string) => q<VerRowDb>('SELECT * FROM provider.gig_versions WHERE gig_id = $1 ORDER BY version_number', [gigId]);
const verStatuses = async (gigId: string) => (await verRows(gigId)).map((v) => [v.version_number, v.status]);
const valueRows = (versionId: string) =>
  q<Row>(
    `SELECT f.field_key, v.text_value, v.integer_value, v.decimal_value, v.boolean_value, v.option_code, v.duration_minutes
       FROM provider.gig_version_field_values v JOIN catalog.gig_template_fields f USING (gig_template_field_id) WHERE v.gig_version_id = $1 ORDER BY f.field_key`,
    [versionId],
  );
interface AuditRowDb {
  action: string;
  actor: string;
  account_id: string;
  gig_id: string;
  gig_version_id: string | null;
  changes: Record<string, unknown> | null;
  correlation_id: string;
}
const gigAudits = (gigId: string) =>
  q<AuditRowDb>(
    'SELECT action, actor, account_id, gig_id, gig_version_id, changes, correlation_id FROM provider.gig_audit_events WHERE gig_id = $1 ORDER BY occurred_at, audit_event_id',
    [gigId],
  );
interface EventRowDb {
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: Record<string, unknown>;
  correlation_id: string;
}
const gigEvents = (gigId: string, type?: string) =>
  q<EventRowDb>(
    `SELECT event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, payload_json, correlation_id FROM integration.outbox_events
      WHERE event_type LIKE 'bananagig.provider.gig-%' AND aggregate_id = $1 AND ($2::text IS NULL OR event_type = $2) ORDER BY created_at, outbox_event_id`,
    [gigId, type ?? null],
  );
/** Every Gig-domain row of one account plus its events, as one hash: equal before and after means nothing was written. */
const gigHash = async (accountId: string): Promise<string> =>
  (
    await one<{ h: string }>(
      `SELECT md5(concat_ws('|',
        (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.gig_id), '[]') FROM provider.gigs g WHERE g.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.gig_version_id), '[]') FROM provider.gig_versions v JOIN provider.gigs g USING (gig_id) WHERE g.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.gig_version_id, f.gig_template_field_id), '[]') FROM provider.gig_version_field_values f JOIN provider.gig_versions v USING (gig_version_id) JOIN provider.gigs g USING (gig_id) WHERE g.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.audit_event_id), '[]') FROM provider.gig_audit_events a WHERE a.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'created_at' ORDER BY e.outbox_event_id), '[]') FROM integration.outbox_events e WHERE e.payload_json->>'accountId' = ($1::uuid)::text AND e.event_type LIKE 'bananagig.provider.gig-%')::text)) AS h`,
      [accountId],
    )
  ).h;
const totals = async () => ({
  gigs: (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.gigs')).n,
  versions: (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.gig_versions')).n,
  audits: (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.gig_audit_events')).n,
  events: (await one<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'")).n,
});

// ---------------------------------------------------------------- scenario helpers
const editable = (over: Record<string, unknown> = {}) => ({
  title: 'Full Detail',
  shortPitch: 'We make it shine',
  description: 'A careful hand wash and wax.',
  priceAmountMinor: 12_500,
  durationMinutes: 120,
  fieldValues: [
    { fieldKey: 'notes', value: 'bring water' },
    { fieldKey: 'vehicles', value: 2 },
  ],
  ...over,
});
const save = (accountId: string, gigId: string, revision: number, over: Record<string, unknown> = {}) =>
  svc.updateDraft(accountId, gigId, { expectedRevision: revision, ...editable(), ...over });
const create = async (p: Provider, clientRequestId?: string): Promise<{ created: boolean; detail: GigDetailDto }> =>
  svc.createGig(p.accountId, { gigTemplateCode: p.tpl.code, ...(clientRequestId ? { clientRequestId } : {}) });
const gigIdOf = (d: GigDetailDto): string => d.gig.gigId;
/** A Gig with a complete draft (revision known) ready to publish. */
async function complete(p: Provider, over: Record<string, unknown> = {}): Promise<{ gigId: string; revision: number }> {
  const gigId = gigIdOf((await create(p)).detail);
  const d = await save(p.accountId, gigId, 1, over);
  return { gigId, revision: d.draftVersion!.revision };
}
/** A published Gig (version 1). */
async function published(p: Provider, over: Record<string, unknown> = {}): Promise<string> {
  const { gigId, revision } = await complete(p, over);
  await svc.publish(p.accountId, gigId, { expectedRevision: revision });
  return gigId;
}
const issuesOf = (e: GigError): GigIssueDto[] => (e.details.issues ?? []) as GigIssueDto[];
const issueKeys = (e: GigError): string[] => issuesOf(e).map((i) => `${i.target}${i.fieldKey ? `:${i.fieldKey}` : ''}:${i.reason}`);

// ====================================================================== 0. the harness
describe('the test harness', () => {
  it('migration 0020 is applied, the five Gig policy parameters are seeded, and no Gig exists', async () => {
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM configuration.parameters WHERE key LIKE 'provider.gig.%'")).n).toBe(5);
    expect(await totals()).toEqual({ gigs: 0, versions: 0, audits: 0, events: 0 });
  });

  it('a registered provider and a template can be built and the fake ports read them', async () => {
    const p = await mkProvider();
    const facts = await accounts.facts(p.accountId);
    expect(facts.memberships).toContainEqual({ code: 'PROVIDER', status: 'ACTIVE' });
    const s = (await templates.forCreate(p.market, p.tpl.code))!;
    expect(s).toMatchObject({ gigTemplateCode: p.tpl.code, versionStatus: 'ACTIVE', templateStatus: 'ACTIVE', serviceTypeStatus: 'ACTIVE', versionNumber: 1 });
    expect(s.fields.map((f) => f.fieldKey)).toEqual(['notes', 'finish', 'vehicles', 'weight', 'express', 'extra_time', 'details', 'intro', 'photos']);
    expect(s.duration).toEqual({ minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 });
    expect(await templates.forCreate(await mkMarket(), p.tpl.code)).toBeNull();
    expect((await templates.offered(p.market, p.offer.types)).map((o) => o.gigTemplateCode)).toEqual([p.tpl.code]);
  });
});

// ====================================================================== 1. create
describe('createGig', () => {
  it('creates the Gig and its first DRAFT version bound to the EXACT ACTIVE template version, with the audit rows and the created event, in one transaction', async () => {
    const p = await mkProvider();
    const r = await runWithCorrelation('cid-create-1', () => create(p));
    expect(r.created).toBe(true);
    const gigId = gigIdOf(r.detail);
    const gigs = await gigRows(p.accountId);
    expect(gigs).toHaveLength(1);
    expect(gigs[0]).toMatchObject({
      gig_id: gigId,
      account_id: p.accountId,
      gig_template_id: p.tpl.templateId,
      status: 'DRAFT',
      client_request_id: null,
      retired_at: null,
    });
    const vs = await verRows(gigId);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({
      version_number: 1,
      gig_template_version_id: p.tpl.versionId,
      status: 'DRAFT',
      revision: 1,
      title: null,
      short_pitch: null,
      description: null,
      price_amount_minor: null,
      price_currency: null,
      duration_minutes: null,
      published_at: null,
    });
    expect(await valueRows(vs[0]!.gig_version_id)).toEqual([]);

    const audits = await gigAudits(gigId);
    expect(audits.map((a) => a.action)).toEqual(['GIG_CREATED', 'GIG_DRAFT_CREATED']);
    for (const a of audits)
      expect(a).toMatchObject({ actor: `account:${p.accountId}`, account_id: p.accountId, gig_id: gigId, correlation_id: 'cid-create-1' });
    expect(audits[1]!.gig_version_id).toBe(vs[0]!.gig_version_id);
    const events = await gigEvents(gigId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: GIG_EVENTS.gigCreated,
      event_version: 1,
      aggregate_type: 'provider-gig',
      aggregate_id: gigId,
      actor_type: 'user',
      actor_id: `account:${p.accountId}`,
      correlation_id: 'cid-create-1',
      payload_json: { accountId: p.accountId, gigId, gigVersionId: vs[0]!.gig_version_id, gigTemplateVersionId: p.tpl.versionId },
    });
  });

  it('answers with the detail: no published version, the draft with fields from the exact template version, constraints from the policy, not publishable', async () => {
    const p = await mkProvider();
    const { detail } = await create(p);
    expect(detail.gig).toMatchObject({
      status: 'DRAFT',
      gigTemplateCode: p.tpl.code,
      serviceTypeCode: p.tpl.serviceType,
      retiredAt: null,
      statusKey: 'provider.gig.status.draft',
    });
    expect(detail.currentVersion).toBeNull();
    const d = detail.draftVersion!;
    expect(d).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      revision: 1,
      publishable: false,
      gigTemplateVersionNumber: 1,
      title: null,
      price: null,
      durationMinutes: null,
      fieldValues: [],
    });
    expect(d.template).toMatchObject({
      gigTemplateCode: p.tpl.code,
      gigTemplateVersionId: p.tpl.versionId,
      versionStatus: 'ACTIVE',
      templateStatus: 'ACTIVE',
      serviceTypeCode: p.tpl.serviceType,
    });
    expect(d.template.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
    ]);
    expect(d.constraints).toEqual({
      title: { maxLength: 100 },
      shortPitch: { maxLength: 1000 },
      description: { maxLength: 5000 },
      price: { permitted: true, required: true, currency: p.currency },
      duration: { permitted: true, required: true, minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
    });
    expect(d.fields.map((f) => [f.fieldKey, f.supported, f.required, f.fixed])).toEqual([
      ['notes', true, true, false],
      ['finish', true, false, false],
      ['vehicles', true, true, false],
      ['weight', true, false, false],
      ['express', true, false, false],
      ['extra_time', true, false, false],
      ['details', true, false, false],
      ['intro', true, false, true],
      ['photos', false, false, false],
    ]);
    expect(d.issues.map((i) => `${i.target}:${i.reason}`)).toEqual([
      'title:TITLE_REQUIRED',
      'shortPitch:SHORT_PITCH_REQUIRED',
      'description:DESCRIPTION_REQUIRED',
      'price:PRICE_REQUIRED',
      'duration:DURATION_REQUIRED',
      'field:FIELD_REQUIRED',
      'field:FIELD_REQUIRED',
    ]);
    expect(detail.versions).toHaveLength(1);
  });

  it('is idempotent for a repeated clientRequestId: the same Gig, created:false, no second Gig, version, audit row or event', async () => {
    const p = await mkProvider();
    const id = randomUUID();
    const first = await create(p, id);
    const before = await totals();
    const again = await create(p, id);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(gigIdOf(again.detail)).toBe(gigIdOf(first.detail));
    expect(await totals()).toEqual(before);
    expect((await gigRows(p.accountId))[0]!.client_request_id).toBe(id);
    // a replay keeps working after the template is retired (the first answer is still the answer)
    await setTemplateStatus(p.tpl.code, 'RETIRED');
    expect((await create(p, id)).created).toBe(false);
  });

  it('a repeated clientRequestId for another template is a CONFLICT and writes nothing; the token is per account', async () => {
    const p = await mkProvider();
    const other = await mkTemplate(p.offer);
    const id = randomUUID();
    await create(p, id);
    const before = await totals();
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: other.code, clientRequestId: id }), 'CONFLICT', 'CLIENT_REQUEST_ID_REUSED');
    expect(await totals()).toEqual(before);
    const neighbour = await mkNeighbour(p);
    const mine = await svc.createGig(neighbour, { gigTemplateCode: p.tpl.code, clientRequestId: id });
    expect(mine.created).toBe(true);
    expect(await gigRows(neighbour)).toHaveLength(1);
  });

  it('several Gigs per account and per template are allowed', async () => {
    const p = await mkProvider();
    const a = await create(p);
    const b = await create(p);
    expect(gigIdOf(a.detail)).not.toBe(gigIdOf(b.detail));
    expect(await gigRows(p.accountId)).toHaveLength(2);
  });

  it('the provider must be eligible: no registration, a registration in progress, a PENDING or INACTIVE role, a service type that was not selected', async () => {
    const p = await mkProvider();
    const before = await totals();
    const noReg = await mkAccount();
    await setProviderRole(noReg, 'ACTIVE');
    await expectError(svc.createGig(noReg, { gigTemplateCode: p.tpl.code }), 'PROVIDER_NOT_ELIGIBLE', 'REGISTRATION_NOT_COMPLETED');
    const inProgress = await mkAccount();
    await setProviderRole(inProgress, 'PENDING');
    await q('INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1)', [inProgress]);
    await expectError(svc.createGig(inProgress, { gigTemplateCode: p.tpl.code }), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const customerOnly = await mkAccount();
    await expectError(svc.createGig(customerOnly, { gigTemplateCode: p.tpl.code }), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const inactive = await mkRegistered(p.offer);
    await setProviderRole(inactive, 'INACTIVE');
    await expectError(svc.createGig(inactive, { gigTemplateCode: p.tpl.code }), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const partial = await mkRegistered(p.offer, [p.offer.types[1]!]);
    await expectError(svc.createGig(partial, { gigTemplateCode: p.tpl.code }), 'PROVIDER_NOT_ELIGIBLE', 'SERVICE_NOT_SELECTED');
    expect(await totals()).toEqual(before);
  });

  it('a suspended account is ACCOUNT_NOT_ACTIVE', async () => {
    const p = await mkProvider();
    await setAccountStatus(p.accountId, 'SUSPENDED');
    await expectError(create(p), 'ACCOUNT_NOT_ACTIVE');
    expect(await gigRows(p.accountId)).toEqual([]);
  });

  it('an unknown template is GIG_TEMPLATE_NOT_FOUND; a template that cannot be used says why', async () => {
    const p = await mkProvider();
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: 'devtest_nope' }), 'GIG_TEMPLATE_NOT_FOUND');
    const retired = await mkTemplate(p.offer);
    await setTemplateStatus(retired.code, 'RETIRED');
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: retired.code }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_RETIRED');
    const inactive = await mkTemplate(p.offer);
    await setTemplateStatus(inactive.code, 'INACTIVE');
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: inactive.code }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_INACTIVE');
    const notInMarket = await mkTemplate(p.offer, stdSpec(), { enable: false });
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: notInMarket.code }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_NOT_IN_MARKET');
    const disabled = await mkTemplate(p.offer);
    await setAvailability(p.market, disabled.templateId, false);
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: disabled.code }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_NOT_IN_MARKET');
    expect(await gigRows(p.accountId)).toEqual([]);
  });

  it('a service type that is not ACTIVE blocks the creation (SERVICE_TYPE_NOT_ACTIVE) and an unselected service type is PROVIDER_NOT_ELIGIBLE', async () => {
    const p = await mkProvider();
    const second = await mkTemplate(p.offer, stdSpec(), { typeIndex: 1 });
    await setServiceTypeStatus(second.serviceType, 'INACTIVE');
    await expectError(svc.createGig(p.accountId, { gigTemplateCode: second.code }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'SERVICE_TYPE_NOT_ACTIVE');
    await setServiceTypeStatus(second.serviceType, 'ACTIVE');
    const narrow = await mkRegistered(p.offer, [p.offer.types[0]!]);
    await expectError(svc.createGig(narrow, { gigTemplateCode: second.code }), 'PROVIDER_NOT_ELIGIBLE', 'SERVICE_NOT_SELECTED');
  });

  it('a template whose ACTIVE version is gone (the port says RETIRED / SUPERSEDED) is NO_ACTIVE_VERSION', async () => {
    const p = await mkProvider();
    templates.overrides.set(p.tpl.code, (s) => ({ ...s, versionStatus: 'RETIRED' }));
    await expectError(create(p), 'GIG_TEMPLATE_NOT_AVAILABLE', 'NO_ACTIVE_VERSION');
  });

  it('the draft cap (configuration) is enforced at creation, counted across the account', async () => {
    const p = await mkProvider();
    setPolicy({ maxDrafts: 2 });
    await create(p);
    await create(p);
    const e = await expectError(create(p), 'LIMIT_REACHED', 'DRAFT_LIMIT_REACHED');
    expect(e.details.limit).toBe(2);
    expect(await gigRows(p.accountId)).toHaveLength(2);
    // another account has its own allowance
    const other = await mkNeighbour(p);
    expect((await svc.createGig(other, { gigTemplateCode: p.tpl.code })).created).toBe(true);
  });

  it('the policy is read once per call, fails closed (UNAVAILABLE) and nothing is written when it is unreadable', async () => {
    const p = await mkProvider();
    policyProvider.failure = new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });
    const before = await totals();
    await expectError(create(p), 'UNAVAILABLE', 'POLICY_INVALID');
    expect(await totals()).toEqual(before);
  });

  it('every external read happens OUTSIDE the transaction (the template port opens its own snapshot and would fail inside one)', async () => {
    const p = await mkProvider();
    await create(p);
    const outside = portCalls.filter((c) => c.port.startsWith('templates.'));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((c) => !c.inTransaction)).toBe(true);
    // the account facts are read before the transaction and again under the account lock (inside it)
    expect(portCalls.filter((c) => c.port === 'accounts.facts').map((c) => c.inTransaction)).toEqual([false, true]);
    // proof the fake would object: a snapshot inside a transaction cannot nest
    const nested = await rejection(iso.database.transaction(async () => templates.exactVersion(p.tpl.versionId)));
    expect(nested).toBeInstanceOf(TransactionOptionError);
  });
});

// ====================================================================== 2. the templates a provider can start from
describe('listGigTemplates', () => {
  it('lists the ACTIVE templates of the provider market restricted to the service types of the completed registration', async () => {
    const p = await mkProvider();
    const second = await mkTemplate(p.offer, stdSpec(), { typeIndex: 1 });
    const all = await svc.listGigTemplates(p.accountId);
    expect(all.marketCode).toBe(p.market);
    expect(all.templates.map((t) => t.gigTemplateCode).sort()).toEqual([p.tpl.code, second.code].sort());
    expect(all.templates[0]).toMatchObject({ gigTemplateVersionNumber: 1, nameContentKey: expect.stringContaining('catalog.gig_template.') });
    const narrow = await mkRegistered(p.offer, [p.offer.types[1]!]);
    expect((await svc.listGigTemplates(narrow)).templates.map((t) => t.gigTemplateCode)).toEqual([second.code]);
  });

  it('is empty (not an error) for an account that is not an eligible provider, and hides retired, paused and disabled templates', async () => {
    const p = await mkProvider();
    const customer = await mkAccount();
    expect(await svc.listGigTemplates(customer)).toEqual({ marketCode: null, templates: [] });
    const t = await mkTemplate(p.offer);
    await setTemplateStatus(t.code, 'INACTIVE');
    const t2 = await mkTemplate(p.offer);
    await setAvailability(p.market, t2.templateId, false);
    const t3 = await mkTemplate(p.offer);
    await setTemplateStatus(t3.code, 'RETIRED');
    expect((await svc.listGigTemplates(p.accountId)).templates.map((x) => x.gigTemplateCode)).toEqual([p.tpl.code]);
  });
});

// ====================================================================== 3. update draft
describe('updateDraft', () => {
  it('stores copy, price, duration and every field type in its typed column, bumps the revision, audits names and counts only', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const d = await runWithCorrelation('cid-save', () =>
      save(p.accountId, gigId, 1, {
        title: `  ${CANARY_TITLE}  `,
        shortPitch: CANARY_PITCH,
        description: `${CANARY_DESC}\r\nsecond line`,
        fieldValues: [
          { fieldKey: 'notes', value: `  ${CANARY_TEXT} ` },
          { fieldKey: 'finish', value: 'sealant' },
          { fieldKey: 'vehicles', value: 3 },
          { fieldKey: 'weight', value: '2.50' },
          { fieldKey: 'express', value: false },
          { fieldKey: 'extra_time', value: 30 },
          { fieldKey: 'details', value: 'line one\nline two' },
        ],
      }),
    );
    const v = d.draftVersion!;
    expect(v.revision).toBe(2);
    expect(v).toMatchObject({
      title: CANARY_TITLE,
      shortPitch: CANARY_PITCH,
      description: `${CANARY_DESC}\nsecond line`,
      durationMinutes: 120,
      price: { amountMinor: 12_500, currency: p.currency },
      publishable: true,
      issues: [],
    });
    const row = (await verRows(gigId))[0]!;
    expect(row).toMatchObject({ revision: 2, title: CANARY_TITLE, price_amount_minor: '12500', price_currency: p.currency, duration_minutes: 120 });
    const values = await valueRows(row.gig_version_id);
    expect(values.map((r) => r.field_key)).toEqual(['details', 'express', 'extra_time', 'finish', 'notes', 'vehicles', 'weight']);
    const by = Object.fromEntries(values.map((r) => [r.field_key as string, r]));
    expect(by.notes).toMatchObject({
      text_value: CANARY_TEXT,
      integer_value: null,
      decimal_value: null,
      boolean_value: null,
      option_code: null,
      duration_minutes: null,
    });
    expect(by.details).toMatchObject({ text_value: 'line one\nline two' });
    expect(by.finish).toMatchObject({ option_code: 'sealant', text_value: null });
    expect(by.vehicles).toMatchObject({ integer_value: '3', text_value: null });
    expect(by.weight).toMatchObject({ decimal_value: '2.5' });
    expect(by.express).toMatchObject({ boolean_value: false });
    expect(by.extra_time).toMatchObject({ duration_minutes: 30 });
    expect(v.fieldValues).toEqual([
      { fieldKey: 'notes', value: CANARY_TEXT },
      { fieldKey: 'finish', value: 'sealant' },
      { fieldKey: 'vehicles', value: 3 },
      { fieldKey: 'weight', value: '2.5' },
      { fieldKey: 'express', value: false },
      { fieldKey: 'extra_time', value: 30 },
      { fieldKey: 'details', value: 'line one\nline two' },
    ]);
    const audit = (await gigAudits(gigId)).find((a) => a.action === 'GIG_DRAFT_UPDATED')!;
    expect(audit).toMatchObject({ actor: `account:${p.accountId}`, gig_version_id: row.gig_version_id, correlation_id: 'cid-save' });
    expect(audit.changes).toEqual({
      changedFields: ['title', 'shortPitch', 'description', 'price', 'duration'],
      changedFieldKeys: ['details', 'express', 'extra_time', 'finish', 'notes', 'vehicles', 'weight'],
      fieldValueCount: 7,
      revision: [1, 2],
      versionNumber: 1,
    });
    expect(JSON.stringify(audit)).not.toMatch(/Zebra|canary|12500|12_500|sealant/i);
    // a draft save writes no event
    expect((await gigEvents(gigId)).map((e) => e.event_type)).toEqual([GIG_EVENTS.gigCreated]);
  });

  it('REPLACES the content: an omitted or null value is cleared, a text normalises, an identical save changes nothing (no revision, no audit)', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    await save(p.accountId, gigId, 1, {
      fieldValues: [
        { fieldKey: 'notes', value: 'abc' },
        { fieldKey: 'finish', value: 'wax' },
        { fieldKey: 'vehicles', value: 1 },
      ],
    });
    const before = await totals();
    const same = await save(p.accountId, gigId, 2, {
      fieldValues: [
        { fieldKey: 'vehicles', value: 1 },
        { fieldKey: 'finish', value: 'wax' },
        { fieldKey: 'notes', value: '  abc  ' },
      ],
    });
    expect(same.draftVersion!.revision).toBe(2);
    expect(await totals()).toEqual(before);
    const cleared = await save(p.accountId, gigId, 2, {
      title: null,
      shortPitch: '   ',
      priceAmountMinor: null,
      durationMinutes: null,
      fieldValues: [
        { fieldKey: 'notes', value: 'abc' },
        { fieldKey: 'finish', value: null },
      ],
    });
    const v = cleared.draftVersion!;
    expect(v).toMatchObject({ revision: 3, title: null, shortPitch: null, description: 'A careful hand wash and wax.', price: null, durationMinutes: null });
    expect(v.fieldValues).toEqual([{ fieldKey: 'notes', value: 'abc' }]);
    const row = (await verRows(gigId))[0]!;
    expect(row).toMatchObject({ price_amount_minor: null, price_currency: null, duration_minutes: null, title: null });
    expect((await valueRows(row.gig_version_id)).map((r) => r.field_key)).toEqual(['notes']);
    const audit = (await gigAudits(gigId)).filter((a) => a.action === 'GIG_DRAFT_UPDATED').at(-1)!;
    expect(audit.changes).toMatchObject({
      changedFields: ['title', 'shortPitch', 'price', 'duration'],
      changedFieldKeys: ['finish', 'vehicles'],
      fieldValueCount: 1,
      revision: [2, 3],
    });
  });

  it('a draft may be saved incomplete (everything empty is accepted)', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const d = await svc.updateDraft(p.accountId, gigId, {
      expectedRevision: 1,
      title: null,
      shortPitch: null,
      description: null,
      priceAmountMinor: null,
      durationMinutes: null,
      fieldValues: [],
    });
    expect(d.draftVersion).toMatchObject({ revision: 1, publishable: false });
  });

  it('validates EAGERLY per type against the EXACT template version and reports every issue; nothing is written', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const before = await gigHash(p.accountId);
    const e = await expectError(
      save(p.accountId, gigId, 1, {
        title: 'x'.repeat(101),
        fieldValues: [
          { fieldKey: 'notes', value: 'ab' }, // too short (min 3)
          { fieldKey: 'finish', value: 'ceramic_pro' }, // unknown option
          { fieldKey: 'vehicles', value: 5 }, // above max 4
          { fieldKey: 'weight', value: '0.1' }, // below min 0.5
          { fieldKey: 'express', value: 'yes' }, // not a boolean
          { fieldKey: 'extra_time', value: 5 }, // below field min 15
          { fieldKey: 'details', value: 'z'.repeat(201) }, // above max 200
        ],
      }),
      'VALIDATION_FAILED',
      'DRAFT_INVALID',
    );
    expect(issueKeys(e)).toEqual([
      'title:TITLE_TOO_LONG',
      'field:notes:FIELD_TOO_SHORT',
      'field:finish:FIELD_OPTION_UNKNOWN',
      'field:vehicles:FIELD_VALUE_OUT_OF_RANGE',
      'field:weight:FIELD_VALUE_OUT_OF_RANGE',
      'field:express:FIELD_VALUE_INVALID',
      'field:extra_time:FIELD_VALUE_OUT_OF_RANGE',
      'field:details:FIELD_TOO_LONG',
    ]);
    expect(await gigHash(p.accountId)).toBe(before);
  });

  it('an ENUM option is validated against the option codes of the template version of THIS Gig, not of the newest version', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    // template version 2 renames the options; the Gig keeps version 1
    const spec = stdSpec();
    spec.fields![1] = { key: 'finish', type: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE', options: ['polish', 'buff'], defaultOption: 'polish' };
    await addVersion(p.tpl.code, spec);
    await save(p.accountId, gigId, 1, { fieldValues: [{ fieldKey: 'finish', value: 'ceramic' }] });
    const e = await expectError(save(p.accountId, gigId, 2, { fieldValues: [{ fieldKey: 'finish', value: 'polish' }] }), 'VALIDATION_FAILED');
    expect(issueKeys(e)).toEqual(['field:finish:FIELD_OPTION_UNKNOWN']);
  });

  it('a PLATFORM_FIXED field, an unknown key and an unsupported type are refused and never stored', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const e = await expectError(
      save(p.accountId, gigId, 1, {
        fieldValues: [
          { fieldKey: 'intro', value: 'override' },
          { fieldKey: 'photos', value: 'x' },
          { fieldKey: 'ghost', value: 'x' },
        ],
      }),
      'VALIDATION_FAILED',
    );
    expect(issueKeys(e)).toEqual(['field:intro:FIELD_NOT_PROVIDER_EDITABLE', 'field:photos:FIELD_TYPE_NOT_SUPPORTED', 'field:ghost:FIELD_UNKNOWN']);
    expect(
      (await q('SELECT 1 FROM provider.gig_version_field_values v JOIN provider.gig_versions x USING (gig_version_id) WHERE x.gig_id = $1', [gigId])).length,
    ).toBe(0);
    // PLATFORM_FIXED values are never copied: the editor resolves them from the template version
    const d = (await save(p.accountId, gigId, 1)).draftVersion!;
    expect(d.fieldValues.map((f) => f.fieldKey)).not.toContain('intro');
    expect(d.fields.find((f) => f.fieldKey === 'intro')).toMatchObject({
      fixed: true,
      behavior: 'PLATFORM_FIXED',
      defaultContentKey: expect.stringContaining('.default'),
    });
  });

  it("the price is permitted only when the template allows FIXED or FIXED_WITH_VARIANTS; the currency is the provider market currency, never the client's", async () => {
    const eur = await otherCurrency();
    const p = await mkProvider({ currency: eur });
    expect(p.currency).toBe(eur);
    const gigId = gigIdOf((await create(p)).detail);
    const d = await save(p.accountId, gigId, 1);
    expect(d.draftVersion!.price).toEqual({ amountMinor: 12_500, currency: eur });
    expect((await verRows(gigId))[0]!.price_currency).toBe(eur);
    // a client-supplied currency is not part of the contract
    await expectError(svc.updateDraft(p.accountId, gigId, { expectedRevision: 2, ...editable(), currency: 'JPY' }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    // zero is allowed in a draft
    expect((await save(p.accountId, gigId, 2, { priceAmountMinor: 0 })).draftVersion!.price).toEqual({ amountMinor: 0, currency: eur });
    // a template version that allows no price (the catalogue forbids it today; the port is made to say so) refuses a price
    const noPrice = await mkProvider();
    const g2 = gigIdOf((await create(noPrice)).detail);
    templates.overrides.set(noPrice.tpl.code, (s) => ({ ...s, pricing: { fixed: false, fixedWithVariants: false } }));
    const e = await expectError(save(noPrice.accountId, g2, 1), 'VALIDATION_FAILED');
    expect(issueKeys(e)).toEqual(['price:PRICE_NOT_PERMITTED']);
    const ok = await save(noPrice.accountId, g2, 1, { priceAmountMinor: null });
    expect(ok.draftVersion!.constraints.price).toEqual({ permitted: false, required: false, currency: null });
    // FIXED_WITH_VARIANTS also permits a base price
    templates.overrides.clear();
    const variants = await mkProvider({ spec: { ...stdSpec(), pricing: { fixed: false, variants: true } } });
    expect((await save(variants.accountId, gigIdOf((await create(variants)).detail), 1)).draftVersion!.price).not.toBeNull();
  });

  it('the duration is permitted only with duration guidance and must lie within min and max; with only a suggestion any value is accepted', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    expect(issueKeys(await expectError(save(p.accountId, gigId, 1, { durationMinutes: 59 }), 'VALIDATION_FAILED'))).toEqual(['duration:DURATION_OUT_OF_RANGE']);
    expect(issueKeys(await expectError(save(p.accountId, gigId, 1, { durationMinutes: 241 }), 'VALIDATION_FAILED'))).toEqual([
      'duration:DURATION_OUT_OF_RANGE',
    ]);
    expect((await save(p.accountId, gigId, 1, { durationMinutes: 60 })).draftVersion!.durationMinutes).toBe(60);
    const none = await mkProvider({ spec: { ...stdSpec(), duration: null } });
    const g2 = gigIdOf((await create(none)).detail);
    expect(issueKeys(await expectError(save(none.accountId, g2, 1, { durationMinutes: 30 }), 'VALIDATION_FAILED'))).toEqual([
      'duration:DURATION_NOT_PERMITTED',
    ]);
    expect((await save(none.accountId, g2, 1, { durationMinutes: null })).draftVersion!.constraints.duration).toMatchObject({
      permitted: false,
      required: false,
    });
    const suggested = await mkProvider({ spec: { ...stdSpec(), duration: [null, null, 90] } });
    const g3 = gigIdOf((await create(suggested)).detail);
    expect((await save(suggested.accountId, g3, 1, { durationMinutes: 5 })).draftVersion!.durationMinutes).toBe(5);
    expect((await save(suggested.accountId, g3, 2, { durationMinutes: 100_000 })).draftVersion!.durationMinutes).toBe(100_000);
    expect((await save(suggested.accountId, g3, 3)).draftVersion!.constraints.duration).toEqual({
      permitted: true,
      required: true,
      minMinutes: null,
      maxMinutes: null,
      suggestedMinutes: 90,
    });
  });

  it('plain text only: markup and control characters are refused with the target, never the text', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const e = await expectError(
      save(p.accountId, gigId, 1, { title: `<b>${CANARY_TITLE}</b>`, shortPitch: `${CANARY_PITCH}\u0000`, description: `<script>${CANARY_DESC}</script>` }),
      'VALIDATION_FAILED',
    );
    expect(issueKeys(e)).toEqual(['title:HTML_NOT_ALLOWED', 'shortPitch:FORBIDDEN_CHARACTER', 'description:HTML_NOT_ALLOWED']);
    expect(surface(e)).not.toMatch(/Zebra|canary/i);
  });

  it('a stale revision is STALE_DRAFT and writes nothing', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    await save(p.accountId, gigId, 1);
    const before = await gigHash(p.accountId);
    await expectError(save(p.accountId, gigId, 1, { title: 'Other' }), 'STALE_DRAFT');
    await expectError(save(p.accountId, gigId, 7, { title: 'Other' }), 'STALE_DRAFT');
    expect(await gigHash(p.accountId)).toBe(before);
  });

  it('GIG_RETIRED for a retired Gig, NO_DRAFT for a published Gig without a draft', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    await expectError(save(p.accountId, gigId, 1), 'NO_DRAFT');
    await svc.retire(p.accountId, gigId, {});
    await expectError(save(p.accountId, gigId, 1), 'GIG_RETIRED');
  });

  it('reads the exact template version of the draft even when the template has a newer version', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const spec = stdSpec();
    spec.fields!.push({ key: 'extra', type: 'TEXT', behavior: 'PROVIDER_REQUIRED' });
    await addVersion(p.tpl.code, spec);
    const d = await save(p.accountId, gigId, 1);
    expect(d.draftVersion!.fields.map((f) => f.fieldKey)).not.toContain('extra');
    expect(d.draftVersion!.template).toMatchObject({ gigTemplateVersionNumber: 1, versionStatus: 'SUPERSEDED', gigTemplateVersionId: p.tpl.versionId });
    expect(issueKeys(await expectError(save(p.accountId, gigId, 2, { fieldValues: [{ fieldKey: 'extra', value: 'x' }] }), 'VALIDATION_FAILED'))).toEqual([
      'field:extra:FIELD_UNKNOWN',
    ]);
  });
});

// ====================================================================== 4. publish
describe('publish', () => {
  it('publishes a complete draft: version PUBLISHED, Gig ACTIVE, content frozen, audit row and published event', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    const d = await runWithCorrelation('cid-publish', () => svc.publish(p.accountId, gigId, { expectedRevision: revision }));
    expect(d.gig.status).toBe('ACTIVE');
    expect(d.draftVersion).toBeNull();
    expect(d.currentVersion).toMatchObject({
      versionNumber: 1,
      status: 'PUBLISHED',
      publishable: null,
      issues: [],
      title: 'Full Detail',
      price: { amountMinor: 12_500, currency: p.currency },
    });
    expect(d.currentVersion!.publishedAt).not.toBeNull();
    const rows = await verRows(gigId);
    expect(rows[0]).toMatchObject({ status: 'PUBLISHED', revision, gig_template_version_id: p.tpl.versionId });
    expect(rows[0]!.published_at).not.toBeNull();
    expect((await gigRows(p.accountId))[0]!.status).toBe('ACTIVE');
    const audits = await gigAudits(gigId);
    expect(audits.map((a) => a.action)).toEqual(['GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED']);
    expect(audits[3]!.changes).toMatchObject({
      status: ['DRAFT', 'PUBLISHED'],
      versionNumber: 1,
      revision,
      gigStatus: ['DRAFT', 'ACTIVE'],
      supersededVersion: null,
    });
    const ev = await gigEvents(gigId, GIG_EVENTS.gigVersionPublished);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      aggregate_type: 'provider-gig',
      correlation_id: 'cid-publish',
      payload_json: {
        accountId: p.accountId,
        gigId,
        gigVersionId: rows[0]!.gig_version_id,
        versionNumber: 1,
        gigTemplateVersionId: p.tpl.versionId,
        supersededGigVersionId: null,
      },
    });
    // the published content is frozen in the database
    await expect(q("UPDATE provider.gig_versions SET title = 'hack', revision = revision + 1 WHERE gig_id = $1", [gigId])).rejects.toMatchObject({
      code: '23000',
    });
  });

  it('an incomplete draft is PUBLISH_BLOCKED with identifier-only issues, nothing changes', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const d = await save(p.accountId, gigId, 1, {
      title: null,
      priceAmountMinor: 0,
      durationMinutes: null,
      fieldValues: [{ fieldKey: 'notes', value: 'abc' }],
    });
    const before = await gigHash(p.accountId);
    const e = await expectError(svc.publish(p.accountId, gigId, { expectedRevision: d.draftVersion!.revision }), 'PUBLISH_BLOCKED');
    expect(issueKeys(e)).toEqual(['title:TITLE_REQUIRED', 'price:PRICE_NOT_POSITIVE', 'duration:DURATION_REQUIRED', 'field:vehicles:FIELD_REQUIRED']);
    for (const i of issuesOf(e))
      expect(Object.keys(i).sort()).toEqual(i.fieldKey ? ['fieldKey', 'messageKey', 'reason', 'target'] : ['messageKey', 'reason', 'target']);
    expect(await gigHash(p.accountId)).toBe(before);
    expect(d.draftVersion!.issues.map((i) => i.reason)).toEqual(['TITLE_REQUIRED', 'PRICE_NOT_POSITIVE', 'DURATION_REQUIRED', 'FIELD_REQUIRED']);
  });

  it('a required field of an unsupported type blocks publishing (FIELD_TYPE_NOT_SUPPORTED); an optional unsupported field does not', async () => {
    const spec = stdSpec();
    spec.fields!.push({ key: 'licence_scan', type: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1 });
    const blocked = await mkProvider({ spec });
    const { gigId, revision } = await complete(blocked);
    const e = await expectError(svc.publish(blocked.accountId, gigId, { expectedRevision: revision }), 'PUBLISH_BLOCKED');
    expect(issueKeys(e)).toEqual(['field:licence_scan:FIELD_TYPE_NOT_SUPPORTED']);
    // the standard template has an optional MEDIA field and publishes fine
    const p = await mkProvider();
    const ok = await complete(p);
    expect((await svc.publish(p.accountId, ok.gigId, { expectedRevision: ok.revision })).gig.status).toBe('ACTIVE');
  });

  it('the price is required (and above zero) only when the template allows one, the duration only when the template has guidance', async () => {
    const free = await mkProvider({ spec: { ...stdSpec(), duration: null } });
    templates.overrides.set(free.tpl.code, (s) => ({ ...s, pricing: { fixed: false, fixedWithVariants: false } }));
    const { gigId, revision } = await complete(free, { priceAmountMinor: null, durationMinutes: null });
    expect((await svc.publish(free.accountId, gigId, { expectedRevision: revision })).gig.status).toBe('ACTIVE');
    templates.overrides.clear();
    const p = await mkProvider();
    const g = gigIdOf((await create(p)).detail);
    const d = await save(p.accountId, g, 1, { priceAmountMinor: null, durationMinutes: null });
    expect(issueKeys(await expectError(svc.publish(p.accountId, g, { expectedRevision: d.draftVersion!.revision }), 'PUBLISH_BLOCKED'))).toEqual([
      'price:PRICE_REQUIRED',
      'duration:DURATION_REQUIRED',
    ]);
  });

  it('the configured text limits apply at publish too (a limit lowered after the save blocks)', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    setPolicy({ titleMaxLength: 5 });
    expect(issueKeys(await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'PUBLISH_BLOCKED'))).toEqual(['title:TITLE_TOO_LONG']);
  });

  it('a stale revision is STALE_DRAFT; a published Gig without a draft is NO_DRAFT; a retired Gig is GIG_RETIRED', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision - 1 }), 'STALE_DRAFT');
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision + 1 }), 'STALE_DRAFT');
    expect(await verStatuses(gigId)).toEqual([[1, 'DRAFT']]);
    await svc.publish(p.accountId, gigId, { expectedRevision: revision });
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'NO_DRAFT');
    await svc.retire(p.accountId, gigId, {});
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'GIG_RETIRED');
  });

  it('publishing the next version supersedes the previous one atomically; version 1 is preserved and readable; the template version never moves', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const v1 = (await verRows(gigId))[0]!;
    // the template gets a newer version meanwhile: the Gig keeps the version it was built from
    const spec = stdSpec();
    spec.duration = [30, 300, 60];
    await addVersion(p.tpl.code, spec);
    const next = await svc.createNextDraft(p.accountId, gigId, {});
    expect(next.draftVersion).toMatchObject({ versionNumber: 2, revision: 1, status: 'DRAFT', title: 'Full Detail', gigTemplateVersionNumber: 1 });
    expect(next.currentVersion!.versionNumber).toBe(1);
    const saved = await save(p.accountId, gigId, 1, { title: 'Full Detail Plus', priceAmountMinor: 15_000 });
    const d = await runWithCorrelation('cid-v2', () => svc.publish(p.accountId, gigId, { expectedRevision: saved.draftVersion!.revision }));
    expect(d.currentVersion).toMatchObject({
      versionNumber: 2,
      status: 'PUBLISHED',
      title: 'Full Detail Plus',
      price: { amountMinor: 15_000 },
      gigTemplateVersionNumber: 1,
    });
    expect(d.draftVersion).toBeNull();
    expect(await verStatuses(gigId)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PUBLISHED'],
    ]);
    const rows = await verRows(gigId);
    expect(rows[1]!.gig_template_version_id).toBe(p.tpl.versionId);
    // version 1 is unchanged except for its supersession
    expect(rows[0]).toMatchObject({ title: 'Full Detail', price_amount_minor: '12500', revision: v1.revision, published_at: v1.published_at });
    expect(rows[0]!.superseded_at).not.toBeNull();
    expect((await valueRows(rows[0]!.gig_version_id)).length).toBe(2);
    // both versions are readable, v1 with its own content and the template link it was built from
    const read1 = await svc.getGigVersion(p.accountId, gigId, 1);
    expect(read1).toMatchObject({ status: 'SUPERSEDED', title: 'Full Detail', price: { amountMinor: 12_500 }, publishable: null, issues: [] });
    expect(read1.template).toMatchObject({ gigTemplateVersionId: p.tpl.versionId, versionStatus: 'SUPERSEDED' });
    expect((await svc.getGigVersion(p.accountId, gigId, 2)).status).toBe('PUBLISHED');
    expect(d.versions.map((v) => [v.versionNumber, v.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'SUPERSEDED'],
    ]);
    const audits = (await gigAudits(gigId)).map((a) => a.action);
    expect(audits.slice(-2)).toEqual(['GIG_VERSION_SUPERSEDED', 'GIG_VERSION_PUBLISHED']);
    const ev = (await gigEvents(gigId, GIG_EVENTS.gigVersionPublished)).at(-1)!;
    expect(ev.payload_json).toMatchObject({ versionNumber: 2, supersededGigVersionId: v1.gig_version_id, gigTemplateVersionId: p.tpl.versionId });
    expect(ev.correlation_id).toBe('cid-v2');
    // the Gig is not demoted and a new Gig from the same template binds the NEWEST template version
    const fresh = await create(p);
    expect(fresh.detail.draftVersion!.template.gigTemplateVersionNumber).toBe(2);
  });

  it('a SUPERSEDED template version still publishes; an INACTIVE template, a disabled market and a withdrawn template do not', async () => {
    const p = await mkProvider();
    const a = await complete(p);
    await addVersion(p.tpl.code, stdSpec()); // v1 becomes SUPERSEDED
    expect((await svc.publish(p.accountId, a.gigId, { expectedRevision: a.revision })).gig.status).toBe('ACTIVE');
    const b = await complete(p);
    await setTemplateStatus(p.tpl.code, 'INACTIVE');
    await expectError(svc.publish(p.accountId, b.gigId, { expectedRevision: b.revision }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_INACTIVE');
    await setTemplateStatus(p.tpl.code, 'ACTIVE');
    await setAvailability(p.market, p.tpl.templateId, false);
    await expectError(svc.publish(p.accountId, b.gigId, { expectedRevision: b.revision }), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_NOT_IN_MARKET');
    await setAvailability(p.market, p.tpl.templateId, true);
    expect((await svc.publish(p.accountId, b.gigId, { expectedRevision: b.revision })).gig.status).toBe('ACTIVE');
  });

  it('a RETIRED template (and so its retired version) blocks the publish with the template issue; the draft stays editable data', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    await setTemplateStatus(p.tpl.code, 'RETIRED');
    const e = await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'PUBLISH_BLOCKED');
    expect(issueKeys(e)).toContain('template:TEMPLATE_VERSION_RETIRED');
    const d = await svc.getGig(p.accountId, gigId);
    expect(d.draftVersion).toMatchObject({ publishable: false });
    expect(d.draftVersion!.template).toMatchObject({ templateStatus: 'RETIRED', versionStatus: 'RETIRED' });
  });

  it('the provider must still be eligible at publish', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    await setProviderRole(p.accountId, 'INACTIVE');
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    await setProviderRole(p.accountId, 'ACTIVE');
    await setAccountStatus(p.accountId, 'SUSPENDED');
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'ACCOUNT_NOT_ACTIVE');
    expect(await verStatuses(gigId)).toEqual([[1, 'DRAFT']]);
  });

  it('the active-Gig cap (configuration) is checked at the FIRST publication of a Gig only', async () => {
    const p = await mkProvider();
    setPolicy({ maxActive: 1 });
    const a = await complete(p);
    const b = await complete(p);
    await svc.publish(p.accountId, a.gigId, { expectedRevision: a.revision });
    const e = await expectError(svc.publish(p.accountId, b.gigId, { expectedRevision: b.revision }), 'LIMIT_REACHED', 'ACTIVE_LIMIT_REACHED');
    expect(e.details.limit).toBe(1);
    expect(await verStatuses(b.gigId)).toEqual([[1, 'DRAFT']]);
    // a new version of an ACTIVE Gig is not a new active Gig
    const next = await svc.createNextDraft(p.accountId, a.gigId, {});
    expect((await svc.publish(p.accountId, a.gigId, { expectedRevision: next.draftVersion!.revision })).currentVersion!.versionNumber).toBe(2);
    // retiring frees the slot
    await svc.retire(p.accountId, a.gigId, {});
    expect((await svc.publish(p.accountId, b.gigId, { expectedRevision: b.revision })).gig.status).toBe('ACTIVE');
  });

  it('publishing makes the provider neither live nor bookable: only Gig rows change', async () => {
    const p = await mkProvider();
    const regBefore = await one<{ h: string }>(
      'SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY attempt_number)::text) AS h FROM provider.registrations r WHERE account_id = $1',
      [p.accountId],
    );
    const roleBefore = await one<{ h: string }>(
      'SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY role_id)::text) AS h FROM identity.account_roles m WHERE account_id = $1',
      [p.accountId],
    );
    await published(p);
    expect(
      await one('SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY attempt_number)::text) AS h FROM provider.registrations r WHERE account_id = $1', [p.accountId]),
    ).toEqual(regBefore);
    expect(
      await one('SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY role_id)::text) AS h FROM identity.account_roles m WHERE account_id = $1', [p.accountId]),
    ).toEqual(roleBefore);
    expect((await svc.getGigReadinessFacts(p.accountId)).goLive).toEqual({ evaluated: false, eligible: false });
  });
});

// ====================================================================== 5. next draft
describe('createNextDraft', () => {
  it('copies the published content and field values into a new DRAFT on the SAME template version; audit, no event', async () => {
    const p = await mkProvider();
    const gigId = await published(p, {
      fieldValues: [
        { fieldKey: 'notes', value: 'abc' },
        { fieldKey: 'vehicles', value: 2 },
        { fieldKey: 'finish', value: 'ceramic' },
      ],
    });
    const eventsBefore = (await gigEvents(gigId)).length;
    const d = await runWithCorrelation('cid-next', () => svc.createNextDraft(p.accountId, gigId, {}));
    expect(d.draftVersion).toMatchObject({
      versionNumber: 2,
      revision: 1,
      status: 'DRAFT',
      title: 'Full Detail',
      price: { amountMinor: 12_500, currency: p.currency },
      durationMinutes: 120,
      publishable: true,
    });
    expect(d.draftVersion!.fieldValues).toEqual([
      { fieldKey: 'notes', value: 'abc' },
      { fieldKey: 'finish', value: 'ceramic' },
      { fieldKey: 'vehicles', value: 2 },
    ]);
    expect(d.currentVersion!.versionNumber).toBe(1);
    const rows = await verRows(gigId);
    expect(rows.map((r) => r.gig_template_version_id)).toEqual([p.tpl.versionId, p.tpl.versionId]);
    expect((await valueRows(rows[1]!.gig_version_id)).length).toBe(3);
    const audit = (await gigAudits(gigId)).at(-1)!;
    expect(audit).toMatchObject({ action: 'GIG_DRAFT_CREATED', gig_version_id: rows[1]!.gig_version_id, correlation_id: 'cid-next' });
    expect(audit.changes).toEqual({ versionNumber: 2, revision: 1, copiedFromVersion: 1, fieldValueCount: 3, priceCopied: true });
    expect((await gigEvents(gigId)).length).toBe(eventsBefore);
    // editing the copy does not touch version 1
    await save(p.accountId, gigId, 1, { title: 'Changed' });
    expect((await verRows(gigId))[0]!.title).toBe('Full Detail');
  });

  it('DRAFT_EXISTS when a draft is open, NO_DRAFT-like refusal when nothing is published, GIG_RETIRED when retired', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    await svc.createNextDraft(p.accountId, gigId, {});
    await expectError(svc.createNextDraft(p.accountId, gigId, {}), 'DRAFT_EXISTS');
    const fresh = gigIdOf((await create(p)).detail);
    await expectError(svc.createNextDraft(p.accountId, fresh, {}), 'DRAFT_EXISTS');
    await svc.retire(p.accountId, gigId, {});
    await expectError(svc.createNextDraft(p.accountId, gigId, {}), 'GIG_RETIRED');
  });

  it('the draft cap applies to next drafts too', async () => {
    const p = await mkProvider();
    const a = await published(p);
    setPolicy({ maxDrafts: 1 });
    const b = gigIdOf((await create(p)).detail);
    expect(b).toBeTruthy();
    await expectError(svc.createNextDraft(p.accountId, a, {}), 'LIMIT_REACHED', 'DRAFT_LIMIT_REACHED');
    expect(await verStatuses(a)).toEqual([[1, 'PUBLISHED']]);
  });

  it('a retired template version cannot start a new draft (GIG_TEMPLATE_NOT_AVAILABLE) but the Gig stays readable', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    await setTemplateStatus(p.tpl.code, 'RETIRED');
    await expectError(svc.createNextDraft(p.accountId, gigId, {}), 'GIG_TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_RETIRED');
    const d = await svc.getGig(p.accountId, gigId);
    expect(d.currentVersion).toMatchObject({ status: 'PUBLISHED', title: 'Full Detail' });
    expect(d.currentVersion!.template).toMatchObject({ templateStatus: 'RETIRED', versionStatus: 'RETIRED' });
    expect(d.currentVersion!.fields.length).toBe(9);
  });
});

// ====================================================================== 6. retire
describe('retire', () => {
  it('retires the Gig and its open versions, keeps the history and the superseded versions, audits and emits the event; nothing is deleted', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const next = await svc.createNextDraft(p.accountId, gigId, {});
    const saved = await save(p.accountId, gigId, next.draftVersion!.revision, { title: 'Version two' });
    await svc.publish(p.accountId, gigId, { expectedRevision: saved.draftVersion!.revision });
    await svc.createNextDraft(p.accountId, gigId, {});
    expect(await verStatuses(gigId)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PUBLISHED'],
      [3, 'DRAFT'],
    ]);
    const d = await runWithCorrelation('cid-retire', () => svc.retire(p.accountId, gigId, {}));
    expect(d.gig).toMatchObject({ status: 'RETIRED', statusKey: 'provider.gig.status.retired' });
    expect(d.gig.retiredAt).not.toBeNull();
    expect(d.currentVersion).toBeNull();
    expect(d.draftVersion).toBeNull();
    expect(d.versions.map((v) => [v.versionNumber, v.status])).toEqual([
      [3, 'RETIRED'],
      [2, 'RETIRED'],
      [1, 'SUPERSEDED'],
    ]);
    expect(await verStatuses(gigId)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'RETIRED'],
      [3, 'RETIRED'],
    ]);
    const audit = (await gigAudits(gigId)).at(-1)!;
    expect(audit).toMatchObject({ action: 'GIG_RETIRED', gig_version_id: null, correlation_id: 'cid-retire' });
    expect(audit.changes).toEqual({ status: ['ACTIVE', 'RETIRED'], versionsRetired: 2, retiredVersions: [2, 3] });
    const ev = await gigEvents(gigId, GIG_EVENTS.gigRetired);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload_json).toEqual({ accountId: p.accountId, gigId });
    // the history is readable in every state
    expect((await svc.getGigVersion(p.accountId, gigId, 1)).status).toBe('SUPERSEDED');
    expect((await svc.getGigVersion(p.accountId, gigId, 2)).status).toBe('RETIRED');
    expect((await svc.getGigVersion(p.accountId, gigId, 3)).status).toBe('RETIRED');
    expect((await svc.getGigVersion(p.accountId, gigId, 2)).title).toBe('Version two');
    expect(await svc.getCurrentPublishedGigVersion(p.accountId, gigId)).toBeNull();
  });

  it('is idempotent: a second retire changes nothing; a never-published Gig can be retired', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    await svc.retire(p.accountId, gigId, {});
    const before = await totals();
    const again = await svc.retire(p.accountId, gigId, {});
    expect(again.gig.status).toBe('RETIRED');
    expect(await totals()).toEqual(before);
    expect(await verStatuses(gigId)).toEqual([[1, 'RETIRED']]);
  });

  it('reactivation is impossible: every mutation of a retired Gig is refused, in the service and in the database', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    await svc.retire(p.accountId, gigId, {});
    await expectError(svc.createNextDraft(p.accountId, gigId, {}), 'GIG_RETIRED');
    await expectError(save(p.accountId, gigId, 1), 'GIG_RETIRED');
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: 1 }), 'GIG_RETIRED');
    await expect(q("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [gigId])).rejects.toMatchObject({ code: '23000' });
    await expect(q("UPDATE provider.gigs SET status = 'DRAFT' WHERE gig_id = $1", [gigId])).rejects.toMatchObject({ code: '23000' });
    await expect(q("UPDATE provider.gig_versions SET status = 'DRAFT' WHERE gig_id = $1", [gigId])).rejects.toMatchObject({ code: '23000' });
    await expect(q('DELETE FROM provider.gigs WHERE gig_id = $1', [gigId])).rejects.toMatchObject({ code: '23000' });
    expect((await gigRows(p.accountId))[0]!.status).toBe('RETIRED');
    // the provider who wants the offer again creates a NEW Gig from the same template
    const again = await create(p);
    expect(gigIdOf(again.detail)).not.toBe(gigId);
  });

  it('a retired Gig frees the draft capacity of its open draft', async () => {
    const p = await mkProvider();
    setPolicy({ maxDrafts: 1 });
    const gigId = gigIdOf((await create(p)).detail);
    await expectError(create(p), 'LIMIT_REACHED');
    await svc.retire(p.accountId, gigId, {});
    expect((await create(p)).created).toBe(true);
  });
});

// ====================================================================== 7. reads
describe('reads', () => {
  it('getGig: the owner reads in every state (draft, active, retired), with the fields from the exact template version', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    expect((await svc.getGig(p.accountId, gigId)).gig.status).toBe('DRAFT');
    const { revision } = { revision: 1 };
    await save(p.accountId, gigId, revision);
    await svc.publish(p.accountId, gigId, { expectedRevision: 2 });
    const active = await svc.getGig(p.accountId, gigId);
    expect(active.gig.status).toBe('ACTIVE');
    expect(active.currentVersion!.fields.map((f) => f.fieldKey)).toHaveLength(9);
    await svc.retire(p.accountId, gigId, {});
    await setServiceTypeStatus(p.tpl.serviceType, 'INACTIVE');
    const retired = await svc.getGig(p.accountId, gigId);
    expect(retired.gig.status).toBe('RETIRED');
    expect(retired.versions).toHaveLength(1);
    await setServiceTypeStatus(p.tpl.serviceType, 'ACTIVE');
  });

  it('getGigVersion: an unknown version is GIG_VERSION_NOT_FOUND, an unknown Gig GIG_NOT_FOUND', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    await expectError(svc.getGigVersion(p.accountId, gigId, 2), 'GIG_VERSION_NOT_FOUND');
    await expectError(svc.getGigVersion(p.accountId, gigId, 0), 'GIG_VERSION_NOT_FOUND');
    await expectError(svc.getGigVersion(p.accountId, randomUUID(), 1), 'GIG_NOT_FOUND');
    expect((await svc.getGigVersion(p.accountId, gigId, 1)).status).toBe('DRAFT');
  });

  it('getCurrentPublishedGigVersion and getGigTemplateLink', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    expect(await svc.getCurrentPublishedGigVersion(p.accountId, gigId)).toBeNull();
    expect(await svc.getGigTemplateLink(p.accountId, gigId)).toMatchObject({ gigTemplateCode: p.tpl.code, gigTemplateVersionId: p.tpl.versionId });
    await save(p.accountId, gigId, 1);
    await svc.publish(p.accountId, gigId, { expectedRevision: 2 });
    expect((await svc.getCurrentPublishedGigVersion(p.accountId, gigId))!.versionNumber).toBe(1);
    const link = await svc.getGigTemplateLink(p.accountId, gigId, 1);
    expect(link).toMatchObject({
      gigTemplateVersionNumber: 1,
      versionStatus: 'ACTIVE',
      requirements: [
        { requirementType: 'LICENSE', referenceCode: null },
        { requirementType: 'SKILL', referenceCode: 'wax_application' },
      ],
    });
    await expectError(svc.getGigTemplateLink(p.accountId, gigId, 9), 'GIG_VERSION_NOT_FOUND');
    await svc.retire(p.accountId, gigId, {});
    expect((await svc.getGigTemplateLink(p.accountId, gigId)).gigTemplateVersionId).toBe(p.tpl.versionId);
  });

  it('a template version the port no longer knows is UNAVAILABLE (never a half-built answer)', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const spy = vi.spyOn(templates, 'exactVersion').mockResolvedValue(null);
    try {
      await expectError(svc.getGig(p.accountId, gigId), 'UNAVAILABLE', 'TEMPLATE_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
  });
});

// ====================================================================== 8. GigMenu
describe('listProviderGigs (GigMenu)', () => {
  it('lists every Gig of the account (every state) with its current version, draft and version count, plus readiness, limits and canCreate', async () => {
    const p = await mkProvider();
    const empty = await svc.listProviderGigs(p.accountId);
    expect(empty).toEqual({
      gigs: [],
      readiness: { hasPublishedGig: false, publishedGigCount: 0, draftVersionCount: 0, goLive: { evaluated: false, eligible: false } },
      limits: { maxActive: 25, maxDrafts: 10, activeCount: 0, draftCount: 0 },
      canCreate: true,
      cannotCreateReason: null,
    });
    const g1 = await published(p);
    await svc.createNextDraft(p.accountId, g1, {});
    const g2 = gigIdOf((await create(p)).detail);
    const g3 = await published(p);
    await svc.retire(p.accountId, g3, {});
    const menu = await svc.listProviderGigs(p.accountId);
    expect(menu.gigs).toHaveLength(3);
    const byId = new Map(menu.gigs.map((g) => [g.gig.gigId, g]));
    expect(byId.get(g1)).toMatchObject({
      gig: { status: 'ACTIVE' },
      currentVersion: { versionNumber: 1, title: 'Full Detail', price: { amountMinor: 12_500, currency: p.currency }, durationMinutes: 120 },
      draftVersion: { versionNumber: 2, revision: 1 },
      versionCount: 2,
    });
    expect(byId.get(g2)).toMatchObject({
      gig: { status: 'DRAFT' },
      currentVersion: null,
      draftVersion: { versionNumber: 1, revision: 1, title: null },
      versionCount: 1,
    });
    expect(byId.get(g3)).toMatchObject({ gig: { status: 'RETIRED' }, currentVersion: null, draftVersion: null, versionCount: 1 });
    expect(menu.readiness).toEqual({ hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 2, goLive: { evaluated: false, eligible: false } });
    expect(menu.limits).toEqual({ maxActive: 25, maxDrafts: 10, activeCount: 1, draftCount: 2 });
    expect(menu.canCreate).toBe(true);
  });

  it('canCreate is false (with the reason) for an ineligible account and at the draft cap', async () => {
    const p = await mkProvider();
    const customer = await mkAccount();
    expect(await svc.listProviderGigs(customer)).toMatchObject({ gigs: [], canCreate: false, cannotCreateReason: 'PROVIDER_NOT_ELIGIBLE' });
    setPolicy({ maxDrafts: 1 });
    await create(p);
    expect(await svc.listProviderGigs(p.accountId)).toMatchObject({ canCreate: false, cannotCreateReason: 'DRAFT_LIMIT_REACHED' });
  });

  it('issues a constant number of statements however many Gigs there are (no N+1), and uses no template port', async () => {
    const p = await mkProvider();
    await published(p);
    const small = await counting(() => svc.listProviderGigs(p.accountId));
    for (let i = 0; i < 6; i++) {
      const g = await published(p);
      await svc.createNextDraft(p.accountId, g, {});
    }
    const big = await counting(() => svc.listProviderGigs(p.accountId));
    expect(small.result.gigs).toHaveLength(1);
    expect(big.result.gigs).toHaveLength(7);
    expect(big.svc.length).toBe(small.svc.length);
    expect(big.svc.length).toBeLessThanOrEqual(5);
    expect(big.port.length).toBe(small.port.length);
    expect(portCalls.filter((c) => c.port.startsWith('templates.') && c.inTransaction)).toEqual([]);
    const lastTemplateCalls = portCalls.length;
    await svc.listProviderGigs(p.accountId);
    expect(portCalls.slice(lastTemplateCalls).filter((c) => c.port.startsWith('templates.'))).toEqual([]);
  });

  it('only the Gigs of the caller are listed', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    await create(p);
    expect((await svc.listProviderGigs(other)).gigs).toEqual([]);
    const theirs = await svc.createGig(other, { gigTemplateCode: p.tpl.code });
    const mine = await svc.listProviderGigs(p.accountId);
    expect(mine.gigs.map((g) => g.gig.gigId)).not.toContain(gigIdOf(theirs.detail));
  });
});

// ====================================================================== 9. readiness and the onboarding step
describe('readiness facts and gigsPrerequisite', () => {
  it('counts published Gigs and open drafts for the account; never says live or eligible', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const step = gigsPrerequisite(svc);
    expect(await svc.getGigReadinessFacts(p.accountId)).toEqual({
      hasPublishedGig: false,
      publishedGigCount: 0,
      draftVersionCount: 0,
      goLive: { evaluated: false, eligible: false },
    });
    expect(await step(p.accountId)).toEqual({ status: 'NOT_STARTED' });
    const g = gigIdOf((await create(p)).detail);
    expect(await step(p.accountId)).toEqual({ status: 'IN_PROGRESS' });
    await save(p.accountId, g, 1);
    await svc.publish(p.accountId, g, { expectedRevision: 2 });
    expect(await svc.getGigReadinessFacts(p.accountId)).toMatchObject({ hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 0 });
    expect(await step(p.accountId)).toEqual({ status: 'COMPLETE' });
    await svc.createNextDraft(p.accountId, g, {});
    expect(await svc.getGigReadinessFacts(p.accountId)).toMatchObject({ hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 1 });
    expect(await step(other)).toEqual({ status: 'NOT_STARTED' });
    await svc.retire(p.accountId, g, {});
    expect(await svc.getGigReadinessFacts(p.accountId)).toMatchObject({ hasPublishedGig: false, publishedGigCount: 0, draftVersionCount: 0 });
    expect(await step(p.accountId)).toEqual({ status: 'NOT_STARTED' });
  });

  it('is one statement', async () => {
    const p = await mkProvider();
    const r = await counting(() => svc.getGigReadinessFacts(p.accountId));
    expect(r.svc).toHaveLength(1);
    expect(r.port).toEqual([]);
  });
});

// ====================================================================== 10. ownership (IDOR)
describe('owner isolation: another account gets GIG_NOT_FOUND from every method and changes nothing', () => {
  it('every read and mutation by a second provider is indistinguishable from an unknown Gig', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const draft = await svc.createNextDraft(p.accountId, gigId, {});
    const intruder = await mkNeighbour(p);
    await svc.createGig(intruder, { gigTemplateCode: p.tpl.code }); // the intruder has Gigs of their own
    const ghost = randomUUID();
    const hashBefore = await gigHash(p.accountId);
    const totalsBefore = await totals();
    const calls: [string, (id: string) => Promise<unknown>][] = [
      ['getGig', (id) => svc.getGig(intruder, id)],
      ['getGigVersion', (id) => svc.getGigVersion(intruder, id, 1)],
      ['getGigVersion(2)', (id) => svc.getGigVersion(intruder, id, 2)],
      ['getCurrentPublishedGigVersion', (id) => svc.getCurrentPublishedGigVersion(intruder, id)],
      ['getGigTemplateLink', (id) => svc.getGigTemplateLink(intruder, id)],
      ['createNextDraft', (id) => svc.createNextDraft(intruder, id, {})],
      ['updateDraft', (id) => save(intruder, id, draft.draftVersion!.revision)],
      ['publish', (id) => svc.publish(intruder, id, { expectedRevision: draft.draftVersion!.revision })],
      ['retire', (id) => svc.retire(intruder, id, {})],
    ];
    for (const [name, call] of calls) {
      const theirs = await err(call(gigId));
      const unknown = await err(call(ghost));
      expect(theirs, name).toBeInstanceOf(GigError);
      expect(theirs!.code, name).toBe('GIG_NOT_FOUND');
      expect(surface(theirs!), name).toBe(surface(unknown!));
    }
    expect(await gigHash(p.accountId)).toBe(hashBefore);
    // the intruder's own writes (their Gig) are the only difference in the totals
    expect(await totals()).toEqual(totalsBefore);
    expect((await svc.listProviderGigs(intruder)).gigs.map((g) => g.gig.gigId)).not.toContain(gigId);
    // the owner is unaffected
    expect((await svc.getGig(p.accountId, gigId)).gig.status).toBe('ACTIVE');
  });

  it('a client-supplied owner or status is not part of any request', async () => {
    const p = await mkProvider();
    const intruder = await mkNeighbour(p);
    await expectError(svc.createGig(intruder, { gigTemplateCode: p.tpl.code, accountId: p.accountId }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    const gigId = gigIdOf((await create(p)).detail);
    await expectError(svc.updateDraft(intruder, gigId, { expectedRevision: 1, ...editable(), accountId: p.accountId }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    expect(await gigRows(intruder)).toEqual([]);
  });
});

// ====================================================================== 11. concurrency
describe('concurrency (real transactions)', () => {
  it('double create with the same clientRequestId produces one Gig; both callers get it', async () => {
    const p = await mkProvider();
    const id = randomUUID();
    const rs = await Promise.all([create(p, id), create(p, id), create(p, id)]);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rs.map((r) => gigIdOf(r.detail))).size).toBe(1);
    expect(await gigRows(p.accountId)).toHaveLength(1);
    expect(await gigEvents(gigIdOf(rs[0]!.detail), GIG_EVENTS.gigCreated)).toHaveLength(1);
  });

  it('concurrent creates cannot exceed the draft cap', async () => {
    const p = await mkProvider();
    setPolicy({ maxDrafts: 2 });
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => create(p)));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of rs.filter((x) => x.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as GigError).code).toBe('LIMIT_REACHED');
    expect(await gigRows(p.accountId)).toHaveLength(2);
  });

  it('simultaneous draft updates with the same revision: exactly one wins, the others are STALE_DRAFT, the revision grows by one', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => save(p.accountId, gigId, 1, { title: `Title ${i}` })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs.filter((x) => x.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as GigError).code).toBe('STALE_DRAFT');
    const row = (await verRows(gigId))[0]!;
    expect(row.revision).toBe(2);
    expect((await gigAudits(gigId)).filter((a) => a.action === 'GIG_DRAFT_UPDATED')).toHaveLength(1);
  });

  it('publish racing an update: either the update wins and the publish is STALE_DRAFT, or the publish wins and the update finds no draft; never both', async () => {
    for (let round = 0; round < 4; round++) {
      const p = await mkProvider();
      const { gigId, revision } = await complete(p);
      const [pub, upd] = await Promise.allSettled([
        svc.publish(p.accountId, gigId, { expectedRevision: revision }),
        save(p.accountId, gigId, revision, { title: 'Late edit' }),
      ]);
      const statuses = await verStatuses(gigId);
      if (pub.status === 'fulfilled') {
        expect(upd.status).toBe('rejected');
        expect(['NO_DRAFT', 'STALE_DRAFT']).toContain(((upd as PromiseRejectedResult).reason as GigError).code);
        expect(statuses).toEqual([[1, 'PUBLISHED']]);
        expect((await verRows(gigId))[0]!.title).toBe('Full Detail');
      } else {
        expect(((pub as PromiseRejectedResult).reason as GigError).code).toBe('STALE_DRAFT');
        expect(upd.status).toBe('fulfilled');
        expect(statuses).toEqual([[1, 'DRAFT']]);
        expect((await verRows(gigId))[0]!.title).toBe('Late edit');
      }
      expect((await q('SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status = $2', [gigId, 'PUBLISHED'])).length).toBeLessThanOrEqual(1);
    }
  });

  it('double publish of the same revision: exactly one PUBLISHED version, the other call is STALE_DRAFT or NO_DRAFT', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => svc.publish(p.accountId, gigId, { expectedRevision: revision })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs.filter((x) => x.status === 'rejected'))
      expect(['STALE_DRAFT', 'NO_DRAFT']).toContain(((r as PromiseRejectedResult).reason as GigError).code);
    expect(await verStatuses(gigId)).toEqual([[1, 'PUBLISHED']]);
    expect(await gigEvents(gigId, GIG_EVENTS.gigVersionPublished)).toHaveLength(1);
    expect((await gigAudits(gigId)).filter((a) => a.action === 'GIG_VERSION_PUBLISHED')).toHaveLength(1);
  });

  it('a double publish of version 2 never supersedes twice or leaves two published versions', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const d = await svc.createNextDraft(p.accountId, gigId, {});
    const revision = d.draftVersion!.revision;
    const rs = await Promise.allSettled([
      svc.publish(p.accountId, gigId, { expectedRevision: revision }),
      svc.publish(p.accountId, gigId, { expectedRevision: revision }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await verStatuses(gigId)).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PUBLISHED'],
    ]);
    expect((await gigAudits(gigId)).filter((a) => a.action === 'GIG_VERSION_SUPERSEDED')).toHaveLength(1);
  });

  it('two simultaneous next drafts create one: the other is DRAFT_EXISTS', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const rs = await Promise.allSettled([
      svc.createNextDraft(p.accountId, gigId, {}),
      svc.createNextDraft(p.accountId, gigId, {}),
      svc.createNextDraft(p.accountId, gigId, {}),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs.filter((x) => x.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as GigError).code).toBe('DRAFT_EXISTS');
    expect(await verStatuses(gigId)).toEqual([
      [1, 'PUBLISHED'],
      [2, 'DRAFT'],
    ]);
  });

  it('retire racing a publish: either order leaves a consistent Gig (a retired Gig keeps no draft or published version)', async () => {
    for (let round = 0; round < 4; round++) {
      const p = await mkProvider();
      const { gigId, revision } = await complete(p);
      const [pub, ret] = await Promise.allSettled([svc.publish(p.accountId, gigId, { expectedRevision: revision }), svc.retire(p.accountId, gigId, {})]);
      expect(ret.status).toBe('fulfilled');
      if (pub.status === 'rejected') expect(['GIG_RETIRED', 'NO_DRAFT']).toContain(((pub as PromiseRejectedResult).reason as GigError).code);
      expect((await gigRows(p.accountId))[0]!.status).toBe('RETIRED');
      expect((await q("SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [gigId])).length).toBe(0);
    }
  });

  it('two simultaneous retires retire once', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    await Promise.all([svc.retire(p.accountId, gigId, {}), svc.retire(p.accountId, gigId, {}), svc.retire(p.accountId, gigId, {})]);
    expect((await gigAudits(gigId)).filter((a) => a.action === 'GIG_RETIRED')).toHaveLength(1);
    expect(await gigEvents(gigId, GIG_EVENTS.gigRetired)).toHaveLength(1);
  });

  it('the template retired while a publish is in flight: the guard (FOR SHARE) serialises and the publish is PUBLISH_BLOCKED', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    const raw = await rawTx();
    await raw.query("UPDATE catalog.gig_templates SET status = 'RETIRED' WHERE code = $1", [p.tpl.code]);
    const pending = err(svc.publish(p.accountId, gigId, { expectedRevision: revision }));
    await waitUntilBlocked();
    await raw.commit();
    const e = (await pending)!;
    expect(e).toBeInstanceOf(GigError);
    expect(e.code).toBe('PUBLISH_BLOCKED');
    expect(issueKeys(e)).toEqual(['template:TEMPLATE_VERSION_RETIRED']);
    expect(await verStatuses(gigId)).toEqual([[1, 'DRAFT']]);
    expect((await gigRows(p.accountId))[0]!.status).toBe('DRAFT');
  });

  it('the service type made unavailable while a Gig is being created: the guard serialises and the creation is refused, nothing is written', async () => {
    const p = await mkProvider();
    const raw = await rawTx();
    await raw.query("UPDATE catalog.service_types SET status = 'INACTIVE' WHERE code = $1", [p.tpl.serviceType]);
    const pending = err(create(p));
    await waitUntilBlocked();
    await raw.commit();
    const e = (await pending)!;
    expect(e).toBeInstanceOf(GigError);
    expect(e.code).toBe('GIG_TEMPLATE_NOT_AVAILABLE');
    expect(e.details.reason).toBe('SERVICE_TYPE_NOT_ACTIVE');
    expect(await gigRows(p.accountId)).toEqual([]);
    expect(await totals()).toMatchObject({ gigs: expect.any(Number) });
    await setServiceTypeStatus(p.tpl.serviceType, 'ACTIVE');
  });

  it('the service type retired while a publish is in flight: PUBLISH_BLOCKED', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    // retiring a service type is a catalogue decision; it is crafted here without the catalogue's own preconditions
    const raw = await rawTx();
    await raw.query('ALTER TABLE catalog.service_types DISABLE TRIGGER USER');
    await raw.query("UPDATE catalog.service_types SET status = 'RETIRED' WHERE code = $1", [p.tpl.serviceType]);
    const pending = err(svc.publish(p.accountId, gigId, { expectedRevision: revision }));
    await waitUntilBlocked();
    await raw.query('ALTER TABLE catalog.service_types ENABLE TRIGGER USER');
    await raw.commit();
    const e = (await pending)!;
    expect(e).toBeInstanceOf(GigError);
    expect(e.code).toBe('PUBLISH_BLOCKED');
    expect(await verStatuses(gigId)).toEqual([[1, 'DRAFT']]);
    await withoutTriggers(['catalog.service_types'], () => setServiceTypeStatus(p.tpl.serviceType, 'ACTIVE'));
  });

  it('no call ever leaks a concurrency artefact (deadlock, serialisation failure, unique violation) as an answer', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const results = await Promise.allSettled([
      svc.createNextDraft(p.accountId, gigId, {}),
      svc.createNextDraft(p.accountId, gigId, {}),
      svc.retire(p.accountId, gigId, {}),
      create(p),
      create(p),
      svc.listProviderGigs(p.accountId),
      svc.getGig(p.accountId, gigId),
    ]);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      const e = (r as PromiseRejectedResult).reason as GigError;
      expect(e).toBeInstanceOf(GigError);
      expect(JSON.stringify(e.details)).not.toMatch(/CONCURRENT_UPDATE|deadlock|40P01|23505/);
    }
  });
});

// ====================================================================== 12. what the audit, events, logs and errors may hold
describe('provider text never leaks', () => {
  it('no audit row, event, log line or error carries the title, pitch, description or text values', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const d = await save(p.accountId, gigId, 1, {
      title: CANARY_TITLE,
      shortPitch: CANARY_PITCH,
      description: CANARY_DESC,
      fieldValues: [
        { fieldKey: 'notes', value: CANARY_TEXT },
        { fieldKey: 'vehicles', value: 1 },
        { fieldKey: 'details', value: CANARY_TEXT },
      ],
    });
    await svc.publish(p.accountId, gigId, { expectedRevision: d.draftVersion!.revision });
    await svc.createNextDraft(p.accountId, gigId, {});
    await save(p.accountId, gigId, 1, {
      title: `${CANARY_TITLE} 2`,
      shortPitch: CANARY_PITCH,
      description: CANARY_DESC,
      fieldValues: [
        { fieldKey: 'notes', value: CANARY_TEXT },
        { fieldKey: 'vehicles', value: 1 },
      ],
    });
    await svc.publish(p.accountId, gigId, { expectedRevision: 2 });
    await svc.createNextDraft(p.accountId, gigId, {});
    await svc.retire(p.accountId, gigId, {});
    // refused saves carry the canary in the input: the errors and logs must not echo it
    const g2 = gigIdOf((await create(p)).detail);
    const errors = [
      await err(
        save(p.accountId, g2, 1, {
          title: `<b>${CANARY_TITLE}</b>`,
          shortPitch: `${CANARY_PITCH}\u0000`,
          fieldValues: [
            { fieldKey: 'notes', value: 'a' },
            { fieldKey: 'finish', value: CANARY_TEXT },
          ],
        }),
      ),
      await err(save(p.accountId, g2, 1, { title: CANARY_TITLE.repeat(40) })),
      await err(svc.publish(p.accountId, g2, { expectedRevision: 1 })),
      await err(svc.getGig(p.accountId, CANARY_TEXT)),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(GigError);
      for (const c of CANARIES) expect(surface(e!).toLowerCase(), c).not.toContain(c.toLowerCase());
    }
    const trail = JSON.stringify(await q('SELECT * FROM provider.gig_audit_events'));
    const outbox = JSON.stringify(await q("SELECT * FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'"));
    expect(trail.length).toBeGreaterThan(500);
    expect(outbox.length).toBeGreaterThan(300);
    const logs = logSink.lines.join('\n');
    for (const c of CANARIES) {
      expect(trail.toLowerCase(), `audit ${c}`).not.toContain(c.toLowerCase());
      expect(outbox.toLowerCase(), `outbox ${c}`).not.toContain(c.toLowerCase());
      expect(logs.toLowerCase(), `logs ${c}`).not.toContain(c.toLowerCase());
    }
    // the audit trail holds identifiers, names and counts only: no price amount either
    expect(trail).not.toMatch(/12500|12_500/);
  });

  it('every audit row has the documented shape and an owner that matches the Gig; every event is one of the three documented types with identifier-only payloads', async () => {
    const rows = await q<Row>('SELECT a.*, g.account_id AS owner FROM provider.gig_audit_events a JOIN provider.gigs g USING (gig_id)');
    expect(rows.length).toBeGreaterThan(20);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_RETIRED'])
      expect(actions.has(a), a).toBe(true);
    for (const r of rows) {
      expect(r.account_id).toBe(r.owner);
      expect(String(r.actor)).toBe(`account:${r.account_id}`);
      expect(String(r.correlation_id).length).toBeGreaterThan(0);
    }
    const events = await q<EventRowDb>(
      `SELECT event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, payload_json, correlation_id FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'`,
    );
    const keySets: Record<string, string[]> = {
      [GIG_EVENTS.gigCreated]: ['accountId', 'gigId', 'gigTemplateVersionId', 'gigVersionId'],
      [GIG_EVENTS.gigVersionPublished]: ['accountId', 'gigId', 'gigTemplateVersionId', 'gigVersionId', 'supersededGigVersionId', 'versionNumber'],
      [GIG_EVENTS.gigRetired]: ['accountId', 'gigId'],
    };
    expect(new Set(events.map((e) => e.event_type))).toEqual(new Set(Object.keys(keySets)));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const e of events) {
      expect(Object.keys(e.payload_json).sort(), e.event_type).toEqual(keySets[e.event_type]);
      for (const [k, v] of Object.entries(e.payload_json)) if (typeof v === 'string') expect(v, k).toMatch(uuid);
      expect(e).toMatchObject({ event_version: 1, aggregate_type: 'provider-gig', actor_type: 'user' });
    }
  });

  it('an outage line, when there is one, carries no Gig data', async () => {
    for (const line of logSink.lines) {
      const o = JSON.parse(line) as { message: string };
      expect(o.message).toBe('provider gig database unavailable');
    }
  });
});

describe('shape: the Gig tables hold only Gig state', () => {
  it('no contact, consent, verification, subscription, payment, profile, location, variant, add-on, media or search column exists, and the market and the service type are not stored on the Gig', async () => {
    const cols = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'provider' AND table_name LIKE 'gig%' ORDER BY table_name, ordinal_position`,
    );
    expect([...new Set(cols.map((c) => c.table_name))].sort()).toEqual(['gig_audit_events', 'gig_version_field_values', 'gig_versions', 'gigs']);
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`).join(' ')).not.toMatch(
      /email|phone|consent|verif|subscri|payment|document|first_name|last_name|address|token|secret|legal|profile|market|service_type|variant|addon|add_on|media|radius|area|capacity|search|rank|live|bookable|credit|discount/,
    );
    const gigCols = cols.filter((c) => c.table_name === 'gigs').map((c) => c.column_name);
    expect(gigCols.sort()).toEqual(['account_id', 'client_request_id', 'created_at', 'gig_id', 'gig_template_id', 'retired_at', 'status', 'updated_at']);
  });
});

// ====================================================================== 12b. robustness found in review
describe('the market currency changes under stored prices (geography.markets.currency_code is mutable)', () => {
  const changeCurrency = async (market: string, to: string) => q('UPDATE geography.markets SET currency_code = $2 WHERE code = $1', [market, to]);

  it('the next draft does not carry a price in the old currency: the price is left empty (PRICE_REQUIRED), v1 keeps its price, no raw guard error', async () => {
    const eur = await otherCurrency();
    const p = await mkProvider();
    const gigId = await published(p);
    await changeCurrency(p.market, eur);
    const d = await svc.createNextDraft(p.accountId, gigId, {});
    expect(d.draftVersion).toMatchObject({ versionNumber: 2, price: null, title: 'Full Detail', durationMinutes: 120, publishable: false });
    expect(d.draftVersion!.issues.map((i) => `${i.target}:${i.reason}`)).toEqual(['price:PRICE_REQUIRED']);
    expect(d.draftVersion!.constraints.price.currency).toBe(eur);
    const rows = await verRows(gigId);
    expect(rows[1]).toMatchObject({ price_amount_minor: null, price_currency: null });
    expect(rows[0]).toMatchObject({ price_amount_minor: '12500', price_currency: p.currency });
    expect((await gigAudits(gigId)).at(-1)!.changes).toMatchObject({ priceCopied: false });
    // entering the price again derives the NEW currency and the version publishes
    const saved = await save(p.accountId, gigId, 1);
    expect(saved.draftVersion!.price).toEqual({ amountMinor: 12_500, currency: eur });
    expect((await svc.publish(p.accountId, gigId, { expectedRevision: saved.draftVersion!.revision })).currentVersion).toMatchObject({
      versionNumber: 2,
      price: { currency: eur },
    });
  });

  it('the next draft still carries the price when the currency did not change', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const d = await svc.createNextDraft(p.accountId, gigId, {});
    expect(d.draftVersion!.price).toEqual({ amountMinor: 12_500, currency: p.currency });
    expect((await gigAudits(gigId)).at(-1)!.changes).toMatchObject({ priceCopied: true });
  });

  it('re-saving the same amount re-derives the currency (the change is detected, the revision grows); a draft with a stale currency is not publishable and says PRICE_REQUIRED', async () => {
    const eur = await otherCurrency();
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    await changeCurrency(p.market, eur);
    const view = (await svc.getGig(p.accountId, gigId)).draftVersion!;
    expect(view).toMatchObject({ publishable: false, price: { amountMinor: 12_500, currency: p.currency } });
    expect(view.issues.map((i) => `${i.target}:${i.reason}`)).toEqual(['price:PRICE_REQUIRED']);
    const before = await gigHash(p.accountId);
    const e = await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'PUBLISH_BLOCKED');
    expect(issueKeys(e)).toEqual(['price:PRICE_REQUIRED']);
    expect(await gigHash(p.accountId)).toBe(before);
    const saved = await save(p.accountId, gigId, revision);
    expect(saved.draftVersion).toMatchObject({ revision: revision + 1, price: { amountMinor: 12_500, currency: eur }, publishable: true });
    expect((await verRows(gigId))[0]!.price_currency).toBe(eur);
    expect((await gigAudits(gigId)).at(-1)!.changes).toMatchObject({ changedFields: ['price'], revision: [revision, revision + 1] });
    // and saving it once more changes nothing
    const again = await save(p.accountId, gigId, revision + 1);
    expect(again.draftVersion!.revision).toBe(revision + 1);
    expect((await svc.publish(p.accountId, gigId, { expectedRevision: revision + 1 })).gig.status).toBe('ACTIVE');
  });

  it('a currency change that lands between the publish checks and the commit is a typed PUBLISH_BLOCKED (reason PRICE_CURRENCY), never a raw guard error; nothing is written', async () => {
    const eur = await otherCurrency();
    const p = await mkProvider();
    const { gigId, revision } = await complete(p);
    accounts.hook = async (_n, inTransaction) => {
      if (inTransaction) await changeCurrency(p.market, eur);
    };
    const before = await gigHash(p.accountId);
    const e = await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'PUBLISH_BLOCKED', 'PRICE_CURRENCY');
    expect(issueKeys(e)).toEqual(['price:PRICE_REQUIRED']);
    expect(surface(e)).not.toMatch(/SELECT|INSERT|guard|provider_rule|gig_versions|23000/i);
    expect(await gigHash(p.accountId)).toBe(before);
  });
});

describe('errors of the account port are translated inside the service', () => {
  const failWith = (e: Error) => {
    accounts.hook = async () => {
      throw e;
    };
  };
  it('UNAVAILABLE, a retryable CONFLICT and ACCOUNT_NOT_ACTIVE of the identity port become the Gig errors, on every call that reads the facts, with nothing written', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const d = await svc.createNextDraft(p.accountId, gigId, {});
    const before = await gigHash(p.accountId);
    const calls: [string, () => Promise<unknown>][] = [
      ['createGig', () => create(p)],
      ['publish', () => svc.publish(p.accountId, gigId, { expectedRevision: d.draftVersion!.revision })],
      ['listProviderGigs', () => svc.listProviderGigs(p.accountId)],
      ['listGigTemplates', () => svc.listGigTemplates(p.accountId)],
    ];
    for (const [name, call] of calls) {
      failWith(new ProviderError('UNAVAILABLE', 'LEAK identity down'));
      const unavailable = await err(call());
      expect(unavailable, name).toBeInstanceOf(GigError);
      expect(unavailable!.code, name).toBe('UNAVAILABLE');
      expect(surface(unavailable!)).not.toContain('LEAK');
      failWith(new ProviderError('CONFLICT', 'LEAK busy', { reason: 'CONCURRENT_UPDATE', retryable: true }));
      const conflict = await err(call());
      expect(conflict, name).toBeInstanceOf(GigError);
      expect(conflict).toMatchObject({ code: 'CONFLICT', details: { retryable: true } });
      failWith(new ProviderError('ACCOUNT_NOT_ACTIVE', 'LEAK inactive'));
      const inactive = await err(call());
      expect(inactive, name).toBeInstanceOf(GigError);
      expect(inactive!.code, name).toBe('ACCOUNT_NOT_ACTIVE');
      expect(surface(inactive!)).not.toContain('LEAK');
    }
    expect(await gigHash(p.accountId)).toBe(before);
  });

  it('the same failure INSIDE the transaction (the facts re-read under the account lock) is translated and rolls everything back', async () => {
    const p = await mkProvider();
    const before = await totals();
    accounts.hook = async (_n, inTransaction) => {
      if (inTransaction) throw new ProviderError('UNAVAILABLE', 'LEAK');
    };
    await expectError(create(p), 'UNAVAILABLE');
    expect(await totals()).toEqual(before);
    const { gigId, revision } = await (async () => {
      accounts.hook = undefined;
      return complete(p);
    })();
    accounts.hook = async (_n, inTransaction) => {
      if (inTransaction) throw new ProviderError('CONFLICT', 'LEAK', { retryable: true });
    };
    await expectError(svc.publish(p.accountId, gigId, { expectedRevision: revision }), 'CONFLICT');
    expect(await verStatuses(gigId)).toEqual([[1, 'DRAFT']]);
  });

  it('an error that is not a ProviderError passes through unchanged', async () => {
    const p = await mkProvider();
    accounts.hook = async () => {
      throw new RangeError('bug');
    };
    const e = await rejection(create(p));
    expect(e).toBeInstanceOf(RangeError);
  });
});

describe('a template port failure AFTER the commit cannot turn a committed change into an error', () => {
  /** The port answers the first call (the pre-transaction read) and fails every later one. */
  const failAfterFirst = () => {
    const original = templates.exactVersion.bind(templates);
    let n = 0;
    return vi.spyOn(templates, 'exactVersion').mockImplementation(async (id) => {
      if (++n === 1) return original(id);
      throw new GigError('UNAVAILABLE', 'template domain down');
    });
  };
  it('createGig, updateDraft, publish, createNextDraft and retire commit AND answer from the structures read before the transaction', async () => {
    const p = await mkProvider();
    // createGig reads the template through forCreate only
    const downAlways = vi.spyOn(templates, 'exactVersion').mockRejectedValue(new GigError('UNAVAILABLE', 'template domain down'));
    const created = await create(p);
    downAlways.mockRestore();
    const gigId = gigIdOf(created.detail);
    expect(created.detail.draftVersion!.fields).toHaveLength(9);
    let spy = failAfterFirst();
    const saved = await save(p.accountId, gigId, 1);
    spy.mockRestore();
    expect(saved.draftVersion!.revision).toBe(2);
    spy = failAfterFirst();
    const pub = await svc.publish(p.accountId, gigId, { expectedRevision: 2 });
    spy.mockRestore();
    expect(pub.gig.status).toBe('ACTIVE');
    spy = failAfterFirst();
    const next = await svc.createNextDraft(p.accountId, gigId, {});
    spy.mockRestore();
    expect(next.draftVersion!.versionNumber).toBe(2);
    spy = failAfterFirst();
    const retired = await svc.retire(p.accountId, gigId, {});
    spy.mockRestore();
    expect(retired.gig.status).toBe('RETIRED');
  });

  it('retire needs no template read for its answer (a retired Gig has no open version): it succeeds with the port down, and a repeat answers without writing', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const spy = vi.spyOn(templates, 'exactVersion').mockRejectedValue(new GigError('UNAVAILABLE', 'template domain down'));
    try {
      expect((await svc.retire(p.accountId, gigId, {})).gig.status).toBe('RETIRED');
      const before = await totals();
      expect((await svc.retire(p.accountId, gigId, {})).gig.status).toBe('RETIRED');
      expect(await totals()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    expect((await gigRows(p.accountId))[0]!.status).toBe('RETIRED');
  });
});

describe('hostile text is bounded in time', () => {
  it('a description built to make a backtracking tag matcher explode is answered within 250 ms (it is refused or accepted, never slow)', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const hostile = `a<${' '.repeat(79_990)}1`;
    expect(hostile.length).toBeLessThanOrEqual(80_000);
    // the configured maximum is far below this: the answer is a typed validation failure, and the point is that it is fast
    const t0 = performance.now();
    const e = await expectError(save(p.accountId, gigId, 1, { description: hostile }), 'VALIDATION_FAILED');
    expect(performance.now() - t0).toBeLessThan(250);
    expect(issueKeys(e)).toEqual(['description:DESCRIPTION_TOO_LONG']);
    // the same shape within the limit is accepted as text (no tag opens) and is just as fast
    setPolicy({ descriptionMaxLength: 20_000 });
    const t1 = performance.now();
    const ok = await save(p.accountId, gigId, 1, { description: `a<${' '.repeat(15_000)}1` });
    expect(performance.now() - t1).toBeLessThan(250);
    expect(ok.draftVersion!.description).toBe(`a<${' '.repeat(15_000)}1`);
  });
  it('text with nothing visible is not stored: it clears the field, and invisible characters are refused', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    const d = await save(p.accountId, gigId, 1, { title: '   \t  ', description: '\n\n  ' });
    expect(d.draftVersion).toMatchObject({ title: null, description: null });
    const e = await expectError(save(p.accountId, gigId, d.draftVersion!.revision, { title: 'Wash​', shortPitch: 'ㅤ' }), 'VALIDATION_FAILED');
    expect(issueKeys(e)).toEqual(['title:FORBIDDEN_CHARACTER', 'shortPitch:FORBIDDEN_CHARACTER']);
  });
  it('a price above the ceiling of the contract is refused before anything is read', async () => {
    const p = await mkProvider();
    const gigId = gigIdOf((await create(p)).detail);
    await expectError(save(p.accountId, gigId, 1, { priceAmountMinor: 1_000_000_000_001 }), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    expect((await save(p.accountId, gigId, 1, { priceAmountMinor: 1_000_000_000_000 })).draftVersion!.price!.amountMinor).toBe(1_000_000_000_000);
  });
});

// ====================================================================== 13. atomicity
describe('atomicity: the change, its audit row and its event commit together or not at all', () => {
  it('a failing audit insert rolls back the Gig, the version and the event of a creation', async () => {
    const p = await mkProvider();
    await q(
      `CREATE FUNCTION public.gig_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`,
    );
    await q(
      `CREATE TRIGGER trg_gig_test_fail BEFORE INSERT ON provider.gig_audit_events FOR EACH ROW WHEN (NEW.action = 'GIG_DRAFT_CREATED') EXECUTE FUNCTION public.gig_test_fail()`,
    );
    try {
      const before = await totals();
      const e = await rejection(create(p));
      expect(e).toBeDefined();
      expect(e).not.toBeInstanceOf(GigError);
      expect(await totals()).toEqual(before);
      expect(await gigRows(p.accountId)).toEqual([]);
    } finally {
      await q('DROP TRIGGER trg_gig_test_fail ON provider.gig_audit_events');
      await q('DROP FUNCTION public.gig_test_fail()');
    }
  });

  it('a failing publish event rolls back the supersession and the publication', async () => {
    const p = await mkProvider();
    const gigId = await published(p);
    const d = await svc.createNextDraft(p.accountId, gigId, {});
    await q(
      `CREATE FUNCTION public.gig_test_fail2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END $$`,
    );
    await q(
      `CREATE TRIGGER trg_gig_test_fail2 BEFORE INSERT ON integration.outbox_events FOR EACH ROW WHEN (NEW.event_type = '${GIG_EVENTS.gigVersionPublished}') EXECUTE FUNCTION public.gig_test_fail2()`,
    );
    try {
      const before = await gigHash(p.accountId);
      await rejection(svc.publish(p.accountId, gigId, { expectedRevision: d.draftVersion!.revision }));
      expect(await gigHash(p.accountId)).toBe(before);
      expect(await verStatuses(gigId)).toEqual([
        [1, 'PUBLISHED'],
        [2, 'DRAFT'],
      ]);
    } finally {
      await q('DROP TRIGGER trg_gig_test_fail2 ON integration.outbox_events');
      await q('DROP FUNCTION public.gig_test_fail2()');
    }
  });
});
