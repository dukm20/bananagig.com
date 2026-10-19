// Integration tests of ProviderProfileService (PRO-002) over a real, freshly migrated PostgreSQL database (migration 0024 with its guards and seeds).
//
// Everything is asserted against the rows the database holds (profiles, audit events, the outbox), never against the service's own return value alone. Domain packages never import
// each other, so the ports the service needs are FAKES that live here and read the real rows of the owning schemas with plain SQL:
//  - AccountPort / AccountNamePort: the identity rows of the account.
//  - TrustSummaryPort: a controllable list of (requirement type, expiry) per account; a badge exists only while its approval has not expired at the moment of the call.
//  - GigServiceNamePort: the catalogue rows behind an EXACT template version, in one batch (the calls are counted).
//  - MarketPort: the real market row, with an override map for the statuses a test needs.
// Every statement a port issues is counted separately from the statements of the service (an AsyncLocalStorage marks the port scope), so the statement budget of the public read is
// pinned exactly.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROFILE_EVENTS,
  PreviewProviderProfileDto,
  PublicProviderProfileDto,
  TRUST_REQUIREMENT_TYPES,
  type ProviderProfilePolicy,
  type TrustRequirementType,
} from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  DEFAULT_PROFILE_POLICY,
  ProfileError,
  ProviderProfileService,
  StaticProfilePolicyProvider,
  profilePrerequisite,
  type AccountFacts,
  type AccountNamePort,
  type AccountPort,
  type GigServiceNamePort,
  type MarketFacts,
  type MarketPort,
  type MarketplaceEligibilityPort,
  type ProfileMutationContext,
  type TrustSummaryPort,
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
const CANARY_NAME = 'Zebra Canary Wash';
const CANARY_BIO = 'Zebra canary bio with some detail';
const CANARIES = ['Zebra', 'canary', 'Canary'];

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const portScope = new AsyncLocalStorage<true>();
const svcStatements: string[] = [];
const portStatements: string[] = [];
const policyProvider = new StaticProfilePolicyProvider({ ...DEFAULT_PROFILE_POLICY });
const setPolicy = (over: Partial<ProviderProfilePolicy>): void => {
  policyProvider.value = { ...DEFAULT_PROFILE_POLICY, ...over };
};
/** Everything a port was asked while a test ran, and whether it was asked inside a transaction. */
const portCalls: { port: string; inTransaction: boolean; args?: unknown }[] = [];
const FAR_FUTURE = new Date('2999-01-01T00:00:00Z');

class FakeAccounts implements AccountPort {
  constructor(private readonly database: Database) {}
  async facts(accountId: string): Promise<AccountFacts> {
    portCalls.push({ port: 'accounts.facts', inTransaction: this.database.inTransaction });
    return portScope.run(true, async () => {
      const r = (
        await sql<Row>`SELECT a.status,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('code', ro.code, 'status', m.status) ORDER BY ro.code)
                        FROM identity.account_roles m JOIN identity.roles ro ON ro.role_id = m.role_id WHERE m.account_id = a.account_id), '[]'::jsonb) AS memberships
          FROM identity.accounts a WHERE a.account_id = ${accountId}`.execute(this.database.db)
      ).rows[0];
      if (!r) throw new Error('the account does not exist');
      return { accountId, status: r.status as string, memberships: r.memberships as AccountFacts['memberships'], emailVerified: true, phoneVerified: true };
    });
  }
  async grantRole(): Promise<{ changed: boolean; status: string }> {
    throw new Error('the profile service never grants roles');
  }
}
class FakeNames implements AccountNamePort {
  /** `null` = the account has no name; absent = read the real row. */
  overrides = new Map<string, { firstName: string; lastName: string } | null>();
  failure: Error | undefined;
  constructor(private readonly database: Database) {}
  async names(accountId: string) {
    portCalls.push({ port: 'names', inTransaction: this.database.inTransaction });
    if (this.failure) throw this.failure;
    if (this.overrides.has(accountId)) return this.overrides.get(accountId)!;
    return portScope.run(true, async () => {
      const r = (await sql<Row>`SELECT first_name, last_name FROM identity.account_profiles WHERE account_id = ${accountId}`.execute(this.database.db)).rows[0];
      return r ? { firstName: r.first_name as string, lastName: r.last_name as string } : null;
    });
  }
}
class FakeTrust implements TrustSummaryPort {
  /** accountId -> approved requirement types with their expiry (null = no expiry). */
  approvals = new Map<string, { type: TrustRequirementType; expiresAt: Date | null }[]>();
  failure: Error | undefined;
  /** The type codes returned regardless of the allow-list (a port that lies). */
  extra: TrustRequirementType[] = [];
  constructor(private readonly database: Database) {}
  async publicBadgeTypes(accountId: string, allowedTypes: readonly TrustRequirementType[]): Promise<readonly TrustRequirementType[]> {
    portCalls.push({ port: 'trust', inTransaction: this.database.inTransaction, args: { accountId, allowedTypes: [...allowedTypes] } });
    if (this.failure) throw this.failure;
    const now = Date.now();
    const live = (this.approvals.get(accountId) ?? [])
      .filter((a) => allowedTypes.includes(a.type) && (a.expiresAt === null || a.expiresAt.getTime() > now))
      .map((a) => a.type);
    return [...new Set([...live, ...this.extra])];
  }
}
class FakeServices implements GigServiceNamePort {
  batches: string[][] = [];
  failure: Error | undefined;
  constructor(private readonly database: Database) {}
  async forTemplateVersions(ids: readonly string[]) {
    portCalls.push({ port: 'services', inTransaction: this.database.inTransaction });
    this.batches.push([...ids]);
    if (this.failure) throw this.failure;
    return portScope.run(true, async () => {
      const rows = (
        await sql<Row>`SELECT tv.gig_template_version_id, st.code FROM catalog.gig_template_versions tv JOIN catalog.gig_templates t ON t.gig_template_id = tv.gig_template_id
          JOIN catalog.service_types st ON st.service_type_id = t.service_type_id WHERE tv.gig_template_version_id = ANY(${[...ids]}::uuid[])`.execute(
          this.database.db,
        )
      ).rows;
      return new Map(
        rows.map((r) => [
          r.gig_template_version_id as string,
          { serviceTypeCode: r.code as string, nameContentKey: `catalog.service_type.${r.code as string}.name` },
        ]),
      );
    });
  }
}
class FakeMarkets implements MarketPort {
  overrides = new Map<string, MarketFacts | null>();
  failure: Error | undefined;
  constructor(private readonly database: Database) {}
  async lookup(code: string): Promise<MarketFacts | null> {
    portCalls.push({ port: 'markets', inTransaction: this.database.inTransaction });
    if (this.failure) throw this.failure;
    if (this.overrides.has(code)) return this.overrides.get(code)!;
    return portScope.run(true, async () => {
      const r = (
        await sql<Row>`SELECT code, status, (effective_from <= now() AND (effective_to IS NULL OR effective_to > now())) AS in_effect FROM geography.markets WHERE code = ${code}`.execute(
          this.database.db,
        )
      ).rows[0];
      return r ? { code: r.code as string, status: r.status as string, inEffect: r.in_effect === true } : null;
    });
  }
}
class FakeEligibility implements MarketplaceEligibilityPort {
  answers = new Map<string, boolean>();
  asked: string[] = [];
  async isEligible(accountId: string): Promise<boolean> {
    this.asked.push(accountId);
    return this.answers.get(accountId) ?? false;
  }
}

let accounts: FakeAccounts;
let names: FakeNames;
let trust: FakeTrust;
let services: FakeServices;
let markets: FakeMarkets;
let eligibility: FakeEligibility;
let svc: ProviderProfileService;
let svcWithEligibility: ProviderProfileService;

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      overrides: { poolMax: 40, connectionTimeoutMs: 30_000 },
      onQuery: (e) => (portScope.getStore() ? portStatements : svcStatements).push(e.sql),
    },
  });
  pool = createTestPool(iso.url, 10);
  accounts = new FakeAccounts(iso.database);
  names = new FakeNames(iso.database);
  trust = new FakeTrust(iso.database);
  services = new FakeServices(iso.database);
  markets = new FakeMarkets(iso.database);
  eligibility = new FakeEligibility();
  const common = { db: iso.database, accounts, names, markets, trust, services, policy: policyProvider };
  svc = new ProviderProfileService(common);
  svcWithEligibility = new ProviderProfileService({ ...common, eligibility });
});
beforeEach(() => {
  setPolicy({});
  policyProvider.failure = undefined;
  policyProvider.reads = 0;
  names.overrides.clear();
  names.failure = undefined;
  trust.approvals.clear();
  trust.failure = undefined;
  trust.extra = [];
  services.batches.length = 0;
  services.failure = undefined;
  markets.overrides.clear();
  markets.failure = undefined;
  eligibility.answers.clear();
  eligibility.asked.length = 0;
  portCalls.length = 0;
  logSink.lines.length = 0;
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

// ---------------------------------------------------------------- raw sessions
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
async function withoutTriggers<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}

// ---------------------------------------------------------------- builders: accounts, markets, the catalogue chain, Gigs
let seq = 0;
const nextSeq = (): number => ++seq;
async function mkAccount(o: { names?: boolean; first?: string; last?: string } = {}): Promise<string> {
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
    if (o.names !== false)
      await c.query('INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, $2, $3)', [
        id,
        o.first ?? 'Ada',
        o.last ?? 'Tester',
      ]);
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
async function setProviderRole(accountId: string, status: 'ACTIVE' | 'INACTIVE'): Promise<void> {
  const exists = (
    await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 AND r.code = 'PROVIDER'`,
      [accountId],
    )
  ).n;
  if (!exists)
    await q(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
       SELECT $1, role_id, 'ACTIVE', now(), 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code = 'PROVIDER'`,
      [accountId],
    );
  if (status === 'INACTIVE')
    await q(
      `UPDATE identity.account_roles SET status = 'INACTIVE', deactivated_at = now() WHERE account_id = $1 AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
      [accountId],
    );
}
async function putContent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'PLAIN_TEXT', 'CONTENT', 'profile integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'profile-itest' FROM unnest($1::text[]) AS k ON CONFLICT (key) DO NOTHING`,
    [keys],
  );
  await q(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
     SELECT e.entry_id, 'en-US', 'PLATFORM', NULL, 1, 'copy ' || e.key, 'DRAFT', 'NONE', now(), 'profile itest', 'profile-itest' FROM content.entries e
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
async function mkMarket(): Promise<string> {
  const c = `devtest-pm${nextSeq()}`;
  await q(
    `WITH m AS (
       INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $1, 'Test market', country_id, 'PLANNED', default_locale, currency_code, default_time_zone_id, now() - interval '1 day' FROM geography.markets WHERE code = 'la-oc'
       RETURNING market_id, country_id, default_locale)
     INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM m`,
    [c],
  );
  await q("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = $1", [c]);
  return c;
}
interface Offer {
  market: string;
  types: string[];
  tvIds: string[];
  tplIds: string[];
  mediaFields: string[];
}
/** A category, `n` ACTIVE service types in the market and one ACTIVE template per type (fixed price, variants and add-ons permitted, one optional MEDIA field). */
async function mkOffer(market: string, n = 2): Promise<Offer> {
  const stem = `pt${nextSeq()}`;
  const category = `${stem}_cat`;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'profile integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'profile-itest' FROM unnest($1::text[]) AS k`,
    [[`catalog.category.${category}.name`, ...Array.from({ length: n }, (_, i) => `catalog.service_type.${stem}_t${i}.name`)]],
  );
  await q('INSERT INTO catalog.categories (code) VALUES ($1)', [category]);
  await q("UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = $1", [category]);
  await q(
    `INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) SELECT m.market_id, c.category_id, true, 10 FROM geography.markets m, catalog.categories c WHERE m.code = $1 AND c.code = $2`,
    [market, category],
  );
  const offer: Offer = { market, types: [], tvIds: [], tplIds: [], mediaFields: [] };
  for (let i = 0; i < n; i++) {
    const t = `${stem}_t${i}`;
    offer.types.push(t);
    await q('INSERT INTO catalog.service_types (category_id, code) SELECT category_id, $2 FROM catalog.categories WHERE code = $1', [category, t]);
    await q("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [t]);
    await q(
      `INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) SELECT m.market_id, s.service_type_id, true, $3 FROM geography.markets m, catalog.service_types s WHERE m.code = $1 AND s.code = $2`,
      [market, t, (i + 1) * 10],
    );
    const code = `devtest_ptpl${nextSeq()}`;
    await putContent([`catalog.gig_template.${code}.name`, `catalog.gig_template.${code}.field.photos.label`]);
    const tplId = (
      await one<{ gig_template_id: string }>(
        'INSERT INTO catalog.gig_templates (service_type_id, code) SELECT service_type_id, $2 FROM catalog.service_types WHERE code = $1 RETURNING gig_template_id',
        [t, code],
      )
    ).gig_template_id;
    await q("UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE gig_template_id = $1", [tplId]);
    const tvId = (
      await one<{ gig_template_version_id: string }>(
        'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1) RETURNING gig_template_version_id',
        [tplId],
      )
    ).gig_template_version_id;
    await q(
      'UPDATE catalog.gig_template_versions SET min_duration_minutes = 30, max_duration_minutes = 240, suggested_duration_minutes = 60, pricing_fixed = true, pricing_fixed_with_variants = true, pricing_add_ons = true WHERE gig_template_version_id = $1',
      [tvId],
    );
    offer.mediaFields.push(
      (
        await one<{ gig_template_field_id: string }>(
          `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key)
           VALUES ($1, 'photos', 'MEDIA', 'PROVIDER_CONFIGURABLE', 1, $2) RETURNING gig_template_field_id`,
          [tvId, `catalog.gig_template.${code}.field.photos.label`],
        )
      ).gig_template_field_id,
    );
    await q("UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1", [tvId]);
    await q(
      `INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order)
       SELECT m.market_id, $2, true, $3 FROM geography.markets m WHERE m.code = $1`,
      [market, tplId, (i + 1) * 10],
    );
    offer.tvIds.push(tvId);
    offer.tplIds.push(tplId);
  }
  return offer;
}
/** An ACTIVE account holding an ACTIVE PROVIDER role and a COMPLETED registration in the offer's market with the offer's service types selected. */
async function mkProvider(offer: Offer, o: { names?: boolean; first?: string; last?: string } = {}): Promise<string> {
  const accountId = await mkAccount(o);
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
  for (const t of offer.types)
    await q(
      'INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) SELECT $1, service_type_id FROM catalog.service_types WHERE code = $2',
      [regId, t],
    );
  await q("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [regId]);
  return accountId;
}
let sharedOffer: Offer | undefined;
/** One shared market and offer for most tests (a new provider account each time). */
const offerOf = async (): Promise<Offer> => (sharedOffer ??= await mkOffer(await mkMarket(), 3));
const mkReg = async (o: { names?: boolean; first?: string; last?: string } = {}): Promise<string> => mkProvider(await offerOf(), o);

interface GigFixture {
  gigId: string;
  versionId: string;
  tvId: string;
}
let keySeq = 0;
/** A Gig of the account built by plain SQL through the real guards: a DRAFT version filled with the given content and, when `publish`, published (the Gig becomes ACTIVE). */
async function mkGig(
  accountId: string,
  o: {
    template?: number;
    title?: string;
    price?: number | null;
    duration?: number | null;
    variants?: number;
    addOns?: number;
    photos?: number;
    publish?: boolean;
  } = {},
): Promise<GigFixture> {
  const offer = await offerOf();
  const t = o.template ?? 0;
  const tvId = offer.tvIds[t]!;
  const tplId = offer.tplIds[t]!;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const gigId = (await c.query('INSERT INTO provider.gigs (account_id, gig_template_id) VALUES ($1, $2) RETURNING gig_id', [accountId, tplId])).rows[0]
      .gig_id as string;
    const versionId = (
      await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 1, $2) RETURNING gig_version_id', [
        gigId,
        tvId,
      ])
    ).rows[0].gig_version_id as string;
    await c.query(
      `UPDATE provider.gig_versions SET title = $2, short_pitch = 'A pitch', description = 'A description', revision = revision + 1,
              price_amount_minor = $3, price_currency = $4, duration_minutes = $5 WHERE gig_version_id = $1`,
      [
        versionId,
        o.title ?? 'Full Detail',
        o.price === undefined ? 12_500 : o.price,
        o.price === null ? null : 'USD',
        o.duration === undefined ? 90 : o.duration,
      ],
    );
    for (let i = 0; i < (o.variants ?? 0); i++)
      await c.query(
        'INSERT INTO provider.gig_version_variants (gig_version_id, item_key, name, price_delta_minor, duration_delta_minutes, display_order) VALUES ($1, $2, $3, 500, 15, $4)',
        [versionId, `opt_${(++keySeq).toString(16).padStart(12, '0')}`, `Variant ${i}`, i + 1],
      );
    for (let i = 0; i < (o.addOns ?? 0); i++)
      await c.query(
        'INSERT INTO provider.gig_version_add_ons (gig_version_id, item_key, name, price_delta_minor, duration_delta_minutes, display_order) VALUES ($1, $2, $3, 500, 15, $4)',
        [versionId, `opt_${(++keySeq).toString(16).padStart(12, '0')}`, `Add-on ${i}`, i + 1],
      );
    for (let i = 0; i < (o.photos ?? 0); i++) {
      const assetId = randomUUID();
      await c.query(
        "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, $4, 1000, now() + interval '1 hour')",
        [assetId, accountId, `provider/gig-media/${assetId}`, 'image/png'],
      );
      await c.query(
        "UPDATE provider.media_assets SET status = 'READY', sha256 = repeat('a', 64), width = 800, height = 600, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1",
        [assetId],
      );
      await c.query('INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, $4)', [
        versionId,
        assetId,
        offer.mediaFields[t],
        i + 1,
      ]);
    }
    if (o.publish !== false) {
      await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [versionId]);
      await c.query("UPDATE provider.gigs SET status = 'ACTIVE' WHERE gig_id = $1", [gigId]);
    }
    await c.query('COMMIT');
    return { gigId, versionId, tvId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const retireGig = async (gigId: string): Promise<void> => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [gigId]);
    await c.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status IN ('DRAFT', 'PUBLISHED')", [gigId]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};
/** Publishes the next version of a Gig (the previous published version is SUPERSEDED in the same transaction). */
async function publishNext(g: GigFixture, title: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (
      await c.query('INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id) VALUES ($1, 2, $2) RETURNING gig_version_id', [
        g.gigId,
        g.tvId,
      ])
    ).rows[0].gig_version_id as string;
    await c.query(
      "UPDATE provider.gig_versions SET title = $2, short_pitch = 'Next pitch', description = 'Next description', price_amount_minor = 20000, price_currency = 'USD', revision = revision + 1 WHERE gig_version_id = $1",
      [id, title],
    );
    await c.query("UPDATE provider.gig_versions SET status = 'SUPERSEDED' WHERE gig_id = $1 AND status = 'PUBLISHED'", [g.gigId]);
    await c.query("UPDATE provider.gig_versions SET status = 'PUBLISHED' WHERE gig_version_id = $1", [id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A READY PROFILE_PHOTO asset of the account (the photo service of PRO-002 produces the same row; the bytes are not needed here). */
async function mkProfileAsset(accountId: string, o: { mime?: string; width?: number; height?: number; ready?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at, purpose)
     VALUES ($1, $2, $3, $4, 1000, now() + interval '1 hour', 'PROFILE_PHOTO')`,
    [id, accountId, `provider/gig-media/${id}`, o.mime ?? 'image/jpeg'],
  );
  if (o.ready !== false)
    await q(
      "UPDATE provider.media_assets SET status = 'READY', sha256 = repeat('b', 64), width = $2, height = $3, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1",
      [id, o.width ?? 640, o.height ?? 480],
    );
  return id;
}
/** The photo service's way of recording a READY photo through the mutation primitive (the revision is raised in the same UPDATE, as the contract says). */
const setPhoto = (accountId: string, revision: number, assetId: string | null) =>
  svc.mutateProfile(accountId, revision, async (ctx) => {
    await sql`UPDATE provider.public_profiles SET photo_asset_id = ${assetId}, revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
      ctx.trx,
    );
    return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], value: undefined };
  });

// ---------------------------------------------------------------- observation
const err = async (p: Promise<unknown>): Promise<ProfileError | undefined> => (await rejection(p)) as ProfileError | undefined;
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<ProfileError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(ProfileError);
  expect(e!.code, JSON.stringify(e!.details)).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(e!.details.reason).toBe(reasonWanted);
  return e!;
};
const surface = (e: ProfileError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const isTxControl = (s: string): boolean => /^(start transaction|begin|commit|rollback)/i.test(s);
const counting = async <T>(fn: () => Promise<T>): Promise<{ result: T; svc: string[]; port: string[] }> => {
  const s0 = svcStatements.length;
  const p0 = portStatements.length;
  const result = await fn();
  return { result, svc: svcStatements.slice(s0).filter((x) => !isTxControl(x)), port: portStatements.slice(p0).filter((x) => !isTxControl(x)) };
};

interface ProfileDb {
  public_profile_id: string;
  account_id: string;
  display_name: string | null;
  bio: string | null;
  photo_asset_id: string | null;
  pending_photo_asset_id: string | null;
  visibility_status: string;
  revision: number;
  published_at: Date | null;
}
const profileRows = (accountId: string) => q<ProfileDb>('SELECT * FROM provider.public_profiles WHERE account_id = $1', [accountId]);
const profileOf = async (accountId: string): Promise<ProfileDb> => (await profileRows(accountId))[0]!;
interface AuditRowDb {
  action: string;
  actor: string;
  account_id: string;
  public_profile_id: string;
  changes: Record<string, unknown> | null;
  correlation_id: string;
}
const audits = (accountId: string) =>
  q<AuditRowDb>(
    'SELECT action, actor, account_id, public_profile_id, changes, correlation_id FROM provider.profile_audit_events WHERE account_id = $1 ORDER BY occurred_at, audit_event_id',
    [accountId],
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
const events = (accountId: string, type?: string) =>
  q<EventRowDb>(
    `SELECT event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, payload_json, correlation_id FROM integration.outbox_events
      WHERE event_type LIKE 'bananagig.provider.profile-%' AND payload_json->>'accountId' = $1 AND ($2::text IS NULL OR event_type = $2) ORDER BY created_at, outbox_event_id`,
    [accountId, type ?? null],
  );
/** Every profile-domain row of one account plus its events, as one hash: equal before and after means nothing was written. */
const profileHash = async (accountId: string): Promise<string> =>
  (
    await one<{ h: string }>(
      `SELECT md5(concat_ws('|',
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.public_profile_id), '[]') FROM provider.public_profiles p WHERE p.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.audit_event_id), '[]') FROM provider.profile_audit_events a WHERE a.account_id = $1)::text,
        (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'created_at' ORDER BY e.outbox_event_id), '[]') FROM integration.outbox_events e WHERE e.payload_json->>'accountId' = ($1::uuid)::text AND e.event_type LIKE 'bananagig.provider.profile-%')::text)) AS h`,
      [accountId],
    )
  ).h;
const noCanary = (text: string): void => {
  for (const c of CANARIES) expect(text, `canary ${c} leaked`).not.toContain(c);
};
const allText = async (accountId: string): Promise<string> =>
  JSON.stringify({ audits: await audits(accountId), events: await events(accountId), logs: logSink.lines });

/** A PUBLIC profile with the given name (and bio). */
async function makePublic(accountId: string, o: { displayName?: string | null; bio?: string } = {}): Promise<string> {
  const { state } = await svc.createProfile(accountId);
  let revision = state.profile!.revision;
  if (o.displayName !== undefined || o.bio !== undefined) {
    const s = await svc.updateProfile(accountId, {
      expectedRevision: revision,
      ...(o.displayName !== undefined ? { displayName: o.displayName } : {}),
      ...(o.bio !== undefined ? { bio: o.bio } : {}),
    });
    revision = s.profile!.revision;
  }
  const s = await svc.setVisibility(accountId, { expectedRevision: revision, visibility: 'PUBLIC' });
  return s.profile!.publicProfileId;
}

// ====================================================================== create
describe('createProfile', () => {
  it('creates a PRIVATE profile at revision 1 with exactly one audit row and one event, all in the same transaction', async () => {
    const a = await mkReg();
    const cid = randomUUID();
    const r = await runWithCorrelation(cid, () => svc.createProfile(a));
    expect(r.created).toBe(true);
    const row = await profileOf(a);
    expect(row).toMatchObject({
      account_id: a,
      display_name: null,
      bio: null,
      photo_asset_id: null,
      pending_photo_asset_id: null,
      visibility_status: 'PRIVATE',
      revision: 1,
      published_at: null,
    });
    expect(r.state).toMatchObject({
      exists: true,
      profile: {
        publicProfileId: row.public_profile_id,
        displayName: null,
        publicName: 'Ada T.',
        bio: null,
        photo: null,
        photoPending: false,
        visibility: 'PRIVATE',
        publishedAt: null,
        revision: 1,
      },
    });
    const a1 = await audits(a);
    expect(a1).toEqual([
      {
        action: 'PROVIDER_PUBLIC_PROFILE_CREATED',
        actor: `account:${a}`,
        account_id: a,
        public_profile_id: row.public_profile_id,
        changes: { revision: 1, visibility: 'PRIVATE' },
        correlation_id: cid,
      },
    ]);
    const e1 = await events(a);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({
      event_type: PROFILE_EVENTS.profileUpdated,
      event_version: 1,
      aggregate_type: 'provider-profile',
      aggregate_id: row.public_profile_id,
      actor_type: 'user',
      actor_id: `account:${a}`,
      correlation_id: cid,
      payload_json: { accountId: a, publicProfileId: row.public_profile_id, revision: 1, changedFields: [] },
    });
  });

  it('is idempotent: a repeat returns the same profile, created:false, and writes nothing', async () => {
    const a = await mkReg();
    const first = await svc.createProfile(a);
    const before = await profileHash(a);
    const again = await svc.createProfile(a);
    expect(again.created).toBe(false);
    expect(again.state.profile!.publicProfileId).toBe(first.state.profile!.publicProfileId);
    expect(await profileHash(a)).toBe(before);
    expect(await audits(a)).toHaveLength(1);
    expect(await events(a)).toHaveLength(1);
  });

  it('concurrent creates produce exactly one profile, one audit row and one event', async () => {
    const a = await mkReg();
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.createProfile(a)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.state.profile!.publicProfileId)).size).toBe(1);
    expect(await profileRows(a)).toHaveLength(1);
    expect(await audits(a)).toHaveLength(1);
    expect(await events(a)).toHaveLength(1);
  });

  it('a second profile for the same account cannot exist (unique account)', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const e = (await rejection(pool.query('INSERT INTO provider.public_profiles (account_id) VALUES ($1)', [a]))) as { code?: string; constraint?: string };
    expect(e.code).toBe('23505');
    expect(e.constraint).toBe('uq_public_profiles__account');
  });

  it('requires an ACTIVE account, an ACTIVE PROVIDER role and a COMPLETED registration, and writes nothing otherwise', async () => {
    const customer = await mkAccount();
    await expectError(svc.createProfile(customer), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const roleOnly = await mkAccount();
    await setProviderRole(roleOnly, 'ACTIVE');
    await expectError(svc.createProfile(roleOnly), 'PROVIDER_NOT_ELIGIBLE', 'REGISTRATION_NOT_COMPLETED');
    const inactive = await mkReg();
    await setProviderRole(inactive, 'INACTIVE');
    await expectError(svc.createProfile(inactive), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const suspended = await mkReg();
    await setAccountStatus(suspended, 'SUSPENDED');
    await expectError(svc.createProfile(suspended), 'ACCOUNT_NOT_ACTIVE');
    for (const id of [customer, roleOnly, inactive, suspended]) {
      expect(await profileRows(id)).toHaveLength(0);
      expect(await audits(id)).toHaveLength(0);
      expect(await events(id)).toHaveLength(0);
    }
  });

  it('reads every port before the transaction and the policy once', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    expect(portCalls.length).toBeGreaterThan(0);
    expect(portCalls.filter((c) => c.inTransaction)).toEqual([]);
    expect(policyProvider.reads).toBe(1);
  });
});

// ====================================================================== update (name, bio)
describe('updateProfile', () => {
  it('stores the normalised name and bio, raises the revision once and audits NAMES only', async () => {
    const a = await mkReg();
    const { state } = await svc.createProfile(a);
    const cid = randomUUID();
    const s = await runWithCorrelation(cid, () =>
      svc.updateProfile(a, { expectedRevision: state.profile!.revision, displayName: `  ${CANARY_NAME} \n `, bio: `${CANARY_BIO}\r\nSecond line  ` }),
    );
    const row = await profileOf(a);
    expect(row).toMatchObject({ display_name: CANARY_NAME, bio: `${CANARY_BIO}\nSecond line`, revision: 2, visibility_status: 'PRIVATE' });
    expect(s.profile).toMatchObject({ displayName: CANARY_NAME, publicName: CANARY_NAME, bio: `${CANARY_BIO}\nSecond line`, revision: 2 });
    const rows = await audits(a);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      action: 'PROVIDER_PUBLIC_PROFILE_UPDATED',
      actor: `account:${a}`,
      account_id: a,
      public_profile_id: row.public_profile_id,
      changes: { changedFields: ['displayName', 'bio'], revision: [1, 2] },
      correlation_id: cid,
    });
    const ev = await events(a, PROFILE_EVENTS.profileUpdated);
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({
      correlation_id: cid,
      payload_json: { accountId: a, publicProfileId: row.public_profile_id, revision: 2, changedFields: ['displayName', 'bio'] },
    });
    expect(await events(a, PROFILE_EVENTS.profileVisibilityChanged)).toHaveLength(0);
    noCanary(await allText(a));
  });

  it('a field that is absent stays unchanged; null clears; each effective change raises the revision by exactly one', async () => {
    const a = await mkReg();
    let rev = (await svc.createProfile(a)).state.profile!.revision;
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: 'First', bio: 'Bio' })).profile!.revision;
    expect(rev).toBe(2);
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: 'Second' })).profile!.revision;
    expect(await profileOf(a)).toMatchObject({ display_name: 'Second', bio: 'Bio', revision: 3 });
    rev = (await svc.updateProfile(a, { expectedRevision: rev, bio: null })).profile!.revision;
    expect(await profileOf(a)).toMatchObject({ display_name: 'Second', bio: null, revision: 4 });
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: null })).profile!.revision;
    const s = await svc.getOwnerProfile(a);
    expect(s.profile).toMatchObject({ displayName: null, publicName: 'Ada T.', revision: 5 });
    const changes = (await audits(a)).slice(1).map((r) => r.changes);
    expect(changes).toEqual([
      { changedFields: ['displayName', 'bio'], revision: [1, 2] },
      { changedFields: ['displayName'], revision: [2, 3] },
      { changedFields: ['bio'], revision: [3, 4] },
      { changedFields: ['displayName'], revision: [4, 5] },
    ]);
  });

  it('a no-op (same values after normalisation, or clearing an empty field) writes nothing and keeps the revision', async () => {
    const a = await mkReg();
    let rev = (await svc.createProfile(a)).state.profile!.revision;
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: 'Same Name', bio: 'Same bio' })).profile!.revision;
    const before = await profileHash(a);
    const s1 = await svc.updateProfile(a, { expectedRevision: rev, displayName: '  Same   Name ', bio: 'Same bio\r\n' });
    expect(s1.profile!.revision).toBe(rev);
    await svc.updateProfile(a, { expectedRevision: rev, displayName: 'Same Name' });
    const b = await mkReg();
    const rb = (await svc.createProfile(b)).state.profile!.revision;
    const hb = await profileHash(b);
    await svc.updateProfile(b, { expectedRevision: rb, bio: null, displayName: null });
    expect(await profileHash(b)).toBe(hb);
    expect(await profileHash(a)).toBe(before);
  });

  it('refuses invalid text with identifier-only issues and writes nothing', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    const before = await profileHash(a);
    const e = await expectError(
      svc.updateProfile(a, { expectedRevision: rev, displayName: `${CANARY_NAME} <b>`, bio: '   ' }),
      'VALIDATION_FAILED',
      'PROFILE_INVALID',
    );
    expect(e.details.issues).toEqual([
      { reason: 'DISPLAY_NAME_HTML_NOT_ALLOWED', field: 'displayName' },
      { reason: 'BIO_BLANK', field: 'bio' },
    ]);
    noCanary(surface(e));
    await expectError(svc.updateProfile(a, { expectedRevision: rev, displayName: 'x'.repeat(61) }), 'VALIDATION_FAILED');
    await expectError(svc.updateProfile(a, { expectedRevision: rev, bio: 'x'.repeat(1001) }), 'VALIDATION_FAILED');
    await expectError(svc.updateProfile(a, { expectedRevision: rev, displayName: 'a\u0000b' }), 'VALIDATION_FAILED');
    expect(await profileHash(a)).toBe(before);
    noCanary(await allText(a));
  });

  it('the configured limits apply (a changed policy changes the answer; the stored ceiling is structural)', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    setPolicy({ displayNameMaxLength: 5 });
    const e = await expectError(svc.updateProfile(a, { expectedRevision: rev, displayName: 'Longer' }), 'VALIDATION_FAILED');
    expect(e.details.issues).toEqual([{ reason: 'DISPLAY_NAME_TOO_LONG', field: 'displayName' }]);
    await svc.updateProfile(a, { expectedRevision: rev, displayName: 'Short' });
    setPolicy({ displayNameMaxLength: 100, bioMaxLength: 5000 });
    await svc.updateProfile(a, { expectedRevision: 2, displayName: 'n'.repeat(100), bio: 'b'.repeat(5000) });
    expect(await profileOf(a)).toMatchObject({ revision: 3 });
  });

  it('a stale revision is STALE_PROFILE and writes nothing; no profile is PROFILE_NOT_FOUND', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    await svc.updateProfile(a, { expectedRevision: rev, bio: 'one' });
    const before = await profileHash(a);
    await expectError(svc.updateProfile(a, { expectedRevision: rev, bio: 'two' }), 'STALE_PROFILE');
    await expectError(svc.updateProfile(a, { expectedRevision: 99, bio: 'two' }), 'STALE_PROFILE');
    expect(await profileHash(a)).toBe(before);
    const none = await mkReg();
    await expectError(svc.updateProfile(none, { expectedRevision: 1, bio: 'x' }), 'PROFILE_NOT_FOUND');
    expect(await profileRows(none)).toHaveLength(0);
  });

  it('works while a provider role is inactive (presentation only) but never for a suspended account', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    await setAccountStatus(a, 'SUSPENDED');
    await expectError(svc.updateProfile(a, { expectedRevision: rev, bio: 'x' }), 'ACCOUNT_NOT_ACTIVE');
    expect((await profileOf(a)).revision).toBe(rev);
  });

  it('an edit reads no dependency inside the transaction; only the policy is needed to validate, and its failure fails closed before any write', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    portCalls.length = 0;
    await svc.updateProfile(a, { expectedRevision: rev, bio: 'x' });
    expect(portCalls.filter((c) => c.inTransaction)).toEqual([]);
    const before = await profileHash(a);
    policyProvider.failure = new ProfileError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' });
    await expectError(svc.updateProfile(a, { expectedRevision: rev + 1, bio: 'y' }), 'UNAVAILABLE', 'POLICY_INVALID');
    expect(await profileHash(a)).toBe(before);
  });

  it('a committed edit is never turned into an error by trust or names: the answer degrades instead', async () => {
    const a = await mkReg();
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    trust.failure = new Error('SECRET-TRUST-HOST down');
    names.failure = new Error('SECRET-NAMES down');
    const s = await svc.updateProfile(a, { expectedRevision: rev, bio: 'saved anyway' });
    expect(s.profile).toMatchObject({ bio: 'saved anyway', revision: 2, publicName: null });
    expect(s.readiness).toMatchObject({ trustSummaryAvailable: false, publicNameAvailable: false });
    expect((await profileOf(a)).bio).toBe('saved anyway');
    expect(logSink.lines.join('\n')).not.toContain('SECRET');
  });
});

// ====================================================================== visibility
describe('setVisibility', () => {
  it('PRIVATE -> PUBLIC -> PRIVATE: the revision rises each time, published_at is set and cleared, one audit row and the two events each', async () => {
    const a = await mkReg();
    const created = await svc.createProfile(a);
    const cid = randomUUID();
    const s = await runWithCorrelation(cid, () => svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' }));
    const row = await profileOf(a);
    expect(row).toMatchObject({ visibility_status: 'PUBLIC', revision: 2 });
    expect(row.published_at).not.toBeNull();
    expect(s.profile).toMatchObject({ visibility: 'PUBLIC', revision: 2 });
    expect(s.profile!.publishedAt).not.toBeNull();
    const rows = await audits(a);
    expect(rows[1]).toEqual({
      action: 'PROVIDER_PROFILE_VISIBILITY_CHANGED',
      actor: `account:${a}`,
      account_id: a,
      public_profile_id: created.state.profile!.publicProfileId,
      changes: { changedFields: ['visibility'], visibility: ['PRIVATE', 'PUBLIC'], revision: [1, 2] },
      correlation_id: cid,
    });
    const upd = await events(a, PROFILE_EVENTS.profileUpdated);
    expect(upd[1]!.payload_json).toEqual({ accountId: a, publicProfileId: row.public_profile_id, revision: 2, changedFields: ['visibility'] });
    const vis = await events(a, PROFILE_EVENTS.profileVisibilityChanged);
    expect(vis).toHaveLength(1);
    expect(vis[0]).toMatchObject({
      aggregate_id: row.public_profile_id,
      correlation_id: cid,
      payload_json: { accountId: a, publicProfileId: row.public_profile_id, visibility: 'PUBLIC' },
    });
    const back = await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PRIVATE' });
    expect(back.profile).toMatchObject({ visibility: 'PRIVATE', revision: 3, publishedAt: null });
    expect((await profileOf(a)).published_at).toBeNull();
    expect((await audits(a))[2]!.changes).toEqual({ changedFields: ['visibility'], visibility: ['PUBLIC', 'PRIVATE'], revision: [2, 3] });
    expect((await events(a, PROFILE_EVENTS.profileVisibilityChanged))[1]!.payload_json.visibility).toBe('PRIVATE');
  });

  it('the same visibility is a no-op: no revision, no audit row, no event', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const before = await profileHash(a);
    const s = await svc.setVisibility(a, { expectedRevision: 1, visibility: 'PRIVATE' });
    expect(s.profile!.revision).toBe(1);
    expect(await profileHash(a)).toBe(before);
    await svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' });
    const mid = await profileHash(a);
    await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PUBLIC' });
    expect(await profileHash(a)).toBe(mid);
  });

  it('a stale revision is STALE_PROFILE; a missing profile is PROFILE_NOT_FOUND', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    await expectError(svc.setVisibility(a, { expectedRevision: 5, visibility: 'PUBLIC' }), 'STALE_PROFILE');
    expect((await profileOf(a)).visibility_status).toBe('PRIVATE');
    await expectError(svc.setVisibility(await mkReg(), { expectedRevision: 1, visibility: 'PUBLIC' }), 'PROFILE_NOT_FOUND');
  });

  it('PUBLIC needs a public name (PROFILE_INCOMPLETE with the missing fact), PRIVATE is always allowed', async () => {
    const a = await mkReg({ names: false });
    await svc.createProfile(a);
    const before = await profileHash(a);
    const e = await expectError(svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' }), 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual([{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }]);
    expect(await profileHash(a)).toBe(before);
    await svc.updateProfile(a, { expectedRevision: 1, displayName: 'Named Now' });
    await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PUBLIC' });
    expect((await profileOf(a)).visibility_status).toBe('PUBLIC');
    await svc.setVisibility(a, { expectedRevision: 3, visibility: 'PRIVATE' });
    expect((await profileOf(a)).visibility_status).toBe('PRIVATE');
  });

  it('the bio and the photo are required for PUBLIC only when the configuration says so', async () => {
    setPolicy({ bioRequired: true, photoRequired: true });
    const a = await mkReg();
    await svc.createProfile(a);
    const e = await expectError(svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' }), 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual([
      { reason: 'BIO_REQUIRED', field: 'bio' },
      { reason: 'PHOTO_REQUIRED', field: 'photo' },
    ]);
    await svc.updateProfile(a, { expectedRevision: 1, bio: 'A bio' });
    const e2 = await expectError(svc.setVisibility(a, { expectedRevision: 2, visibility: 'PUBLIC' }), 'PROFILE_INCOMPLETE');
    expect(e2.details.issues).toEqual([{ reason: 'PHOTO_REQUIRED', field: 'photo' }]);
    await setPhoto(a, 2, await mkProfileAsset(a));
    await svc.setVisibility(a, { expectedRevision: 3, visibility: 'PUBLIC' });
    expect((await profileOf(a)).visibility_status).toBe('PUBLIC');
    // with the flags off again the same bare profile can be public
    setPolicy({});
    const b = await mkReg();
    await svc.createProfile(b);
    await svc.setVisibility(b, { expectedRevision: 1, visibility: 'PUBLIC' });
  });

  it('an inactive provider role cannot make a profile PUBLIC but can always make it PRIVATE', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    await setProviderRole(a, 'INACTIVE');
    await expectError(svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' }), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const b = await mkReg();
    await svc.createProfile(b);
    await svc.setVisibility(b, { expectedRevision: 1, visibility: 'PUBLIC' });
    await setProviderRole(b, 'INACTIVE');
    const s = await svc.setVisibility(b, { expectedRevision: 2, visibility: 'PRIVATE' });
    expect(s.profile!.visibility).toBe('PRIVATE');
  });

  it('publishing is a preference: it never evaluates Go-Live and the owner state carries no Go-Live fact', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const s = await svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' });
    expect(JSON.stringify(s)).not.toMatch(/goLive|evaluated|live|bookable/i);
    expect(Object.keys(s.readiness).sort()).toEqual(
      [
        'bioPresent',
        'displayNamePresent',
        'hasPublishedGig',
        'profileComplete',
        'profilePhotoPresent',
        'publicNameAvailable',
        'trustSummaryAvailable',
        'visibility',
      ].sort(),
    );
  });
});

// ====================================================================== owner state, limits and readiness
describe('the owner state and the readiness facts', () => {
  it('exists:false (with readiness and limits) when there is no profile', async () => {
    const a = await mkReg();
    const s = await svc.getOwnerProfile(a);
    expect(s.exists).toBe(false);
    expect(s.profile).toBeNull();
    expect(s.readiness).toEqual({
      displayNamePresent: false,
      publicNameAvailable: true,
      bioPresent: false,
      profilePhotoPresent: false,
      hasPublishedGig: false,
      trustSummaryAvailable: false,
      profileComplete: false,
      visibility: null,
    });
    expect(s.limits).toEqual({
      displayNameMaxLength: 60,
      bioMaxLength: 1000,
      bioRequired: false,
      photoRequired: false,
      photoMaxSizeBytes: 2_097_152,
      photoMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    });
  });

  it('the photo types follow the media policy when one is wired; the size limit follows the profile policy', async () => {
    const restricted = new ProviderProfileService({
      db: iso.database,
      accounts,
      names,
      markets,
      trust,
      services,
      policy: policyProvider,
      mediaPolicy: { media: async () => ({ allowedMimeTypes: ['image/png'] }) as never },
    });
    setPolicy({ photoMaxFileSizeBytes: 12345 });
    const s = await restricted.getOwnerProfile(await mkReg());
    expect(s.limits.photoMimeTypes).toEqual(['image/png']);
    expect(s.limits.photoMaxSizeBytes).toBe(12345);
  });

  it('readiness reflects the name, bio, photo, a published Gig and the trust badges; profileComplete follows the required flags', async () => {
    const a = await mkReg({ names: false });
    expect((await svc.getReadinessFacts(a)).publicNameAvailable).toBe(false);
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    expect(await svc.getReadinessFacts(a)).toMatchObject({
      visibility: 'PRIVATE',
      profileComplete: false,
      publicNameAvailable: false,
      displayNamePresent: false,
    });
    await svc.updateProfile(a, { expectedRevision: rev, displayName: 'Named' });
    expect(await svc.getReadinessFacts(a)).toMatchObject({
      displayNamePresent: true,
      publicNameAvailable: true,
      profileComplete: true,
      bioPresent: false,
      hasPublishedGig: false,
    });
    setPolicy({ bioRequired: true });
    expect((await svc.getReadinessFacts(a)).profileComplete).toBe(false);
    await svc.updateProfile(a, { expectedRevision: 2, bio: 'Bio' });
    expect(await svc.getReadinessFacts(a)).toMatchObject({ bioPresent: true, profileComplete: true });
    setPolicy({ bioRequired: true, photoRequired: true });
    expect(await svc.getReadinessFacts(a)).toMatchObject({ profilePhotoPresent: false, profileComplete: false });
    await setPhoto(a, 3, await mkProfileAsset(a));
    expect(await svc.getReadinessFacts(a)).toMatchObject({ profilePhotoPresent: true, profileComplete: true });
    await mkGig(a, { publish: false });
    expect((await svc.getReadinessFacts(a)).hasPublishedGig).toBe(false);
    await mkGig(a);
    expect((await svc.getReadinessFacts(a)).hasPublishedGig).toBe(true);
    expect((await svc.getReadinessFacts(a)).trustSummaryAvailable).toBe(false);
    trust.approvals.set(a, [{ type: 'IDENTITY', expiresAt: FAR_FUTURE }]);
    expect((await svc.getReadinessFacts(a)).trustSummaryAvailable).toBe(true);
    trust.approvals.set(a, [{ type: 'LICENSE', expiresAt: FAR_FUTURE }]); // not a public type
    expect((await svc.getReadinessFacts(a)).trustSummaryAvailable).toBe(false);
  });

  it('a retired Gig no longer counts as a published Gig', async () => {
    const a = await mkReg();
    const g = await mkGig(a);
    expect((await svc.getReadinessFacts(a)).hasPublishedGig).toBe(true);
    await retireGig(g.gigId);
    expect((await svc.getReadinessFacts(a)).hasPublishedGig).toBe(false);
  });

  it('the onboarding PROFILE step: NOT_STARTED, IN_PROGRESS, COMPLETE', async () => {
    const step = profilePrerequisite(svc);
    const a = await mkReg();
    expect(await step(a)).toEqual({ status: 'NOT_STARTED' });
    setPolicy({ bioRequired: true });
    const rev = (await svc.createProfile(a)).state.profile!.revision;
    expect(await step(a)).toEqual({ status: 'IN_PROGRESS' });
    await svc.updateProfile(a, { expectedRevision: rev, bio: 'Now complete' });
    expect(await step(a)).toEqual({ status: 'COMPLETE' });
    setPolicy({ bioRequired: true, photoRequired: true });
    expect(await step(a)).toEqual({ status: 'IN_PROGRESS' });
  });
});

// ====================================================================== the public read
describe('getPublicProfile: exposure', () => {
  it('unknown, malformed, PRIVATE and public-then-private ids all give the SAME null', async () => {
    const a = await mkReg();
    const { state } = await svc.createProfile(a);
    const id = state.profile!.publicProfileId;
    const answers = [
      await svc.getPublicProfile(randomUUID()),
      await svc.getPublicProfile('not-a-uuid'),
      await svc.getPublicProfile(''),
      await svc.getPublicProfile(id),
    ];
    expect(answers).toEqual([null, null, null, null]);
    await svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' });
    expect(await svc.getPublicProfile(id)).not.toBeNull();
    await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PRIVATE' });
    expect(await svc.getPublicProfile(id)).toBeNull();
  });

  it('a profile is addressed by its public id only: the account id finds nothing', async () => {
    const a = await mkReg();
    await makePublic(a);
    expect(await svc.getPublicProfile(a)).toBeNull();
    expect(await svc.getPublicPhotoTarget(a)).toBeNull();
  });

  it('a PUBLIC profile is served only while the account is ACTIVE, the PROVIDER role is ACTIVE and the registration is COMPLETED', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    expect(await svc.getPublicProfile(id)).not.toBeNull();
    await setAccountStatus(a, 'SUSPENDED');
    expect(await svc.getPublicProfile(id)).toBeNull();
    await setAccountStatus(a, 'ACTIVE');
    expect(await svc.getPublicProfile(id)).not.toBeNull();
    await setProviderRole(a, 'INACTIVE');
    expect(await svc.getPublicProfile(id)).toBeNull();
    const b = await mkReg();
    const idB = await makePublic(b);
    expect(await svc.getPublicProfile(idB)).not.toBeNull();
    await withoutTriggers(['provider.registrations'], () =>
      q("UPDATE provider.registrations SET status = 'CANCELLED', completed_at = NULL, cancelled_at = now() WHERE account_id = $1", [b]),
    );
    expect(await svc.getPublicProfile(idB)).toBeNull();
  });

  it('the marketplace eligibility flag: off = not consulted; on without a port = fail closed; on with a port = its answer', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    expect(await svcWithEligibility.getPublicProfile(id)).not.toBeNull();
    expect(eligibility.asked).toEqual([]);
    setPolicy({ publicRequiresMarketplaceEligibility: true });
    expect(await svc.getPublicProfile(id)).toBeNull();
    expect(await svc.getPublicPhotoTarget(id)).toBeNull();
    expect(await svcWithEligibility.getPublicProfile(id)).toBeNull();
    expect(eligibility.asked).toEqual([a]);
    eligibility.answers.set(a, true);
    expect(await svcWithEligibility.getPublicProfile(id)).not.toBeNull();
    eligibility.answers.set(a, false);
    expect(await svcWithEligibility.getPublicProfile(id)).toBeNull();
    // the same null for an unknown id, and the port is not asked about it
    eligibility.asked.length = 0;
    expect(await svcWithEligibility.getPublicProfile(randomUUID())).toBeNull();
    expect(eligibility.asked).toEqual([]);
    // the owner's preview never needs marketplace eligibility
    expect((await svcWithEligibility.getPreview(a)).preview).toBe(true);
  });

  it('a profile with no display name and no legal name to derive one from is not readable', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    expect(await svc.getPublicProfile(id)).not.toBeNull();
    names.overrides.set(a, null);
    expect(await svc.getPublicProfile(id)).toBeNull();
    expect(await svc.getPublicPhotoTarget(id)).toBeNull();
    const e = await expectError(svc.getPreview(a), 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual([{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }]);
  });

  it('a dependency outage is UNAVAILABLE (never a partial profile) and leaks nothing', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    await mkGig(a);
    trust.failure = new Error('SECRET-TRUST down');
    const e1 = await expectError(svc.getPublicProfile(id), 'UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE');
    trust.failure = undefined;
    services.failure = new Error('SECRET-SERVICES down');
    const e2 = await expectError(svc.getPublicProfile(id), 'UNAVAILABLE');
    services.failure = undefined;
    markets.failure = new Error('SECRET-MARKETS down');
    const e3 = await expectError(svc.getPublicProfile(id), 'UNAVAILABLE');
    markets.failure = undefined;
    policyProvider.failure = new ProfileError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' });
    await expectError(svc.getPublicProfile(id), 'UNAVAILABLE', 'POLICY_INVALID');
    for (const e of [e1, e2, e3]) expect(surface(e)).not.toContain('SECRET');
    expect(logSink.lines.join('\n')).not.toContain('SECRET');
  });
});

describe('getPublicProfile: the projection', () => {
  it('shows the fallback first name and last initial, never the legal name, the account id or any internal fact', async () => {
    const a = await mkReg({ first: 'Jane', last: 'doe-Smith' });
    const id = await makePublic(a);
    const p = (await svc.getPublicProfile(id))!;
    expect(() => PublicProviderProfileDto.parse(p)).not.toThrow();
    expect(p).toMatchObject({
      publicProfileId: id,
      displayName: 'Jane D.',
      bio: null,
      photo: null,
      badges: [],
      gigs: [],
      ratings: { available: false },
      drops: { available: false },
    });
    const json = JSON.stringify(p);
    for (const forbidden of [a, 'doe-Smith', 'Smith', 'accountId', 'account_id', 'objectKey', 'sha256', 'email', 'phone'])
      expect(json).not.toContain(forbidden);
    expect(Object.keys(p).sort()).toEqual(['badges', 'bio', 'displayName', 'drops', 'gigs', 'market', 'photo', 'publicProfileId', 'ratings']);
  });

  it('a provider-entered display name replaces the fallback; the initial is the first code point, uppercased', async () => {
    const a = await mkReg({ first: 'Zoë', last: 'émile' });
    const id = await makePublic(a);
    expect((await svc.getPublicProfile(id))!.displayName).toBe('Zoë É.');
    const b = await mkReg({ first: 'Kim', last: '\u{1F34C}Banana' });
    expect((await svc.getPublicProfile(await makePublic(b)))!.displayName).toBe('Kim \u{1F34C}.');
    const c = await mkReg();
    const p = (await svc.getPublicProfile(await makePublic(c, { displayName: 'Ada Auto Spa', bio: 'Line one\nLine two' })))!;
    expect(p).toMatchObject({ displayName: 'Ada Auto Spa', bio: 'Line one\nLine two' });
    expect(JSON.stringify(p)).not.toContain('Tester');
  });

  it('shows the photo facts only (type and dimensions), never an asset id, key or hash; a pending upload is not shown', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const asset = await mkProfileAsset(a, { mime: 'image/png', width: 321, height: 123 });
    await setPhoto(a, 2, asset);
    const p = (await svc.getPublicProfile(id))!;
    expect(p.photo).toEqual({ mimeType: 'image/png', width: 321, height: 123 });
    const json = JSON.stringify(p);
    expect(json).not.toContain(asset);
    expect(json).not.toContain('provider/gig-media');
    expect(json).not.toMatch(/bbbbbbbb/);
    // an unfinished upload (the pending pointer) is never shown
    const pending = await mkProfileAsset(a, { ready: false });
    await q('UPDATE provider.public_profiles SET pending_photo_asset_id = $2 WHERE account_id = $1', [a, pending]);
    expect((await svc.getPublicProfile(id))!.photo).toEqual({ mimeType: 'image/png', width: 321, height: 123 });
    expect(JSON.stringify(await svc.getPublicProfile(id))).not.toContain(pending);
    expect((await svc.getOwnerProfile(a)).profile!.photoPending).toBe(true);
  });

  it('lists ACTIVE Gigs with a PUBLISHED version only, with counts, price and service name; ordered by publication time', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const draftOnly = await mkGig(a, { publish: false, title: 'Draft only' });
    const g1 = await mkGig(a, { title: 'First Gig', variants: 2, addOns: 3, photos: 2, price: 12_500, duration: 90, template: 0 });
    await sleep(5);
    const g2 = await mkGig(a, { title: 'Second Gig', price: null, duration: null, template: 1 });
    const retired = await mkGig(a, { title: 'Retired Gig' });
    await retireGig(retired.gigId);
    const p = (await svc.getPublicProfile(id))!;
    expect(p.gigs.map((g) => g.title)).toEqual(['First Gig', 'Second Gig']);
    expect(p.gigs[0]).toEqual({
      gigId: g1.gigId,
      title: 'First Gig',
      shortPitch: 'A pitch',
      serviceTypeCode: (await offerOf()).types[0],
      serviceTypeNameContentKey: `catalog.service_type.${(await offerOf()).types[0]}.name`,
      price: { amountMinor: 12_500, currency: 'USD' },
      durationMinutes: 90,
      variantCount: 2,
      addOnCount: 3,
      photoCount: 2,
    });
    expect(p.gigs[1]).toMatchObject({
      gigId: g2.gigId,
      price: null,
      durationMinutes: null,
      variantCount: 0,
      addOnCount: 0,
      photoCount: 0,
      serviceTypeCode: (await offerOf()).types[1],
    });
    expect(p.gigs.map((g) => g.gigId)).not.toContain(draftOnly.gigId);
    expect(p.gigs.map((g) => g.gigId)).not.toContain(retired.gigId);
    // nothing but the documented keys, and no BananaDrop, tier or availability data
    expect(Object.keys(p.gigs[0]!).sort()).toEqual(
      [
        'addOnCount',
        'durationMinutes',
        'gigId',
        'photoCount',
        'price',
        'serviceTypeCode',
        'serviceTypeNameContentKey',
        'shortPitch',
        'title',
        'variantCount',
      ].sort(),
    );
    expect(JSON.stringify(p)).not.toMatch(/description|description|tier|bananaDrop|available":true/i);
  });

  it('a new published version replaces the superseded one; a retired Gig disappears at once; another provider’s Gig never appears', async () => {
    const a = await mkReg();
    const other = await mkReg();
    const id = await makePublic(a);
    await mkGig(other, { title: 'Not mine' });
    const g = await mkGig(a, { title: 'Version One' });
    expect((await svc.getPublicProfile(id))!.gigs.map((x) => x.title)).toEqual(['Version One']);
    await publishNext(g, 'Version Two');
    const gigs = (await svc.getPublicProfile(id))!.gigs;
    expect(gigs.map((x) => x.title)).toEqual(['Version Two']);
    expect(gigs[0]!.price).toEqual({ amountMinor: 20_000, currency: 'USD' });
    await retireGig(g.gigId);
    expect((await svc.getPublicProfile(id))!.gigs).toEqual([]);
  });

  it('counts READY photos only', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const g = await mkGig(a, { photos: 1 });
    const offer = await offerOf();
    // an unfinished upload attached to a published version (only possible with the guards off): it must not be counted
    await withoutTriggers(['provider.gig_version_media', 'provider.media_assets'], async () => {
      const pending = randomUUID();
      await q(
        "INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/png', 1000, now() + interval '1 hour')",
        [pending, a, `provider/gig-media/${pending}`],
      );
      await q('INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES ($1, $2, $3, 9)', [
        g.versionId,
        pending,
        offer.mediaFields[0],
      ]);
    });
    expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM provider.gig_version_media WHERE gig_version_id = $1', [g.versionId])).n)).toBe(2);
    expect((await svc.getPublicProfile(id))!.gigs[0]!.photoCount).toBe(1);
  });

  it('asks the Gig service names port ONCE per read with the distinct template versions, and not at all without Gigs', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    await svc.getPublicProfile(id);
    expect(services.batches).toEqual([]);
    const g1 = await mkGig(a, { template: 0 });
    await mkGig(a, { template: 0 });
    const g3 = await mkGig(a, { template: 2 });
    services.batches.length = 0;
    await svc.getPublicProfile(id);
    expect(services.batches).toHaveLength(1);
    expect([...services.batches[0]!].sort()).toEqual([...new Set([g1.tvId, g3.tvId])].sort());
  });

  it('a Gig whose service type the port cannot name is left out, not shown with an invented label', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    await mkGig(a, { title: 'Known' });
    const mute = new ProviderProfileService({
      db: iso.database,
      accounts,
      names,
      markets,
      trust,
      policy: policyProvider,
      services: { forTemplateVersions: async () => new Map() },
    });
    expect((await mute.getPublicProfile(id))!.gigs).toEqual([]);
  });

  it('badges: only the configured types the trust port reports, in the configured order, once each, type codes only; asked fresh on every read', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    expect((await svc.getPublicProfile(id))!.badges).toEqual([]);
    trust.approvals.set(a, [
      { type: 'INSURANCE', expiresAt: FAR_FUTURE },
      { type: 'IDENTITY', expiresAt: null },
      { type: 'IDENTITY', expiresAt: FAR_FUTURE },
      { type: 'LICENSE', expiresAt: FAR_FUTURE },
    ]);
    portCalls.length = 0;
    const p = (await svc.getPublicProfile(id))!;
    expect(p.badges).toEqual([{ type: 'IDENTITY' }, { type: 'INSURANCE' }]);
    expect(portCalls.filter((c) => c.port === 'trust')).toEqual([
      { port: 'trust', inTransaction: false, args: { accountId: a, allowedTypes: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'] } },
    ]);
    await svc.getPublicProfile(id);
    expect(portCalls.filter((c) => c.port === 'trust')).toHaveLength(2);
    // a port that reports a type outside the allow-list is not believed
    trust.extra = ['LICENSE', 'OTHER_DOCUMENT'];
    expect((await svc.getPublicProfile(id))!.badges.map((b) => b.type)).toEqual(['IDENTITY', 'INSURANCE']);
    // the allow-list is configuration
    trust.extra = [];
    setPolicy({ publicBadgeTypes: ['LICENSE'] });
    expect((await svc.getPublicProfile(id))!.badges).toEqual([{ type: 'LICENSE' }]);
    setPolicy({ publicBadgeTypes: [] });
    portCalls.length = 0;
    expect((await svc.getPublicProfile(id))!.badges).toEqual([]);
    expect(portCalls.filter((c) => c.port === 'trust')).toEqual([]);
    expect(TRUST_REQUIREMENT_TYPES.length).toBe(7);
  });

  it('a badge disappears on the next read after its approval expires (no cache)', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    trust.approvals.set(a, [{ type: 'BACKGROUND_CHECK', expiresAt: new Date(Date.now() + 400) }]);
    expect((await svc.getPublicProfile(id))!.badges).toEqual([{ type: 'BACKGROUND_CHECK' }]);
    await sleep(450);
    expect((await svc.getPublicProfile(id))!.badges).toEqual([]);
  });

  it('the market appears only when the registration market is ACTIVE and in effect', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const offer = await offerOf();
    expect((await svc.getPublicProfile(id))!.market).toEqual({ code: offer.market });
    markets.overrides.set(offer.market, { code: offer.market, status: 'PLANNED', inEffect: true });
    expect((await svc.getPublicProfile(id))!.market).toBeNull();
    markets.overrides.set(offer.market, { code: offer.market, status: 'INACTIVE', inEffect: false });
    expect((await svc.getPublicProfile(id))!.market).toBeNull();
    markets.overrides.set(offer.market, { code: offer.market, status: 'ACTIVE', inEffect: false });
    expect((await svc.getPublicProfile(id))!.market).toBeNull();
    markets.overrides.set(offer.market, null);
    expect((await svc.getPublicProfile(id))!.market).toBeNull();
    markets.overrides.clear();
    expect(Object.keys((await svc.getPublicProfile(id))!.market!)).toEqual(['code']);
  });

  it('ratings and drops are placeholders: nothing is fabricated', async () => {
    const id = await makePublic(await mkReg());
    const p = (await svc.getPublicProfile(id))!;
    expect(p.ratings).toEqual({ available: false });
    expect(p.drops).toEqual({ available: false });
  });

  it('never writes: a read leaves every profile row, audit row and event unchanged', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    await mkGig(a);
    const before = await profileHash(a);
    await svc.getPublicProfile(id);
    await svc.getPublicProfile(randomUUID());
    await svc.getPreview(a);
    await svc.getOwnerProfile(a);
    await svc.getReadinessFacts(a);
    expect(await profileHash(a)).toBe(before);
  });
});

describe('getPublicProfile: the statement budget and consistency', () => {
  it('a public read is ONE service statement whatever the number of Gigs; a hidden or unknown profile is one too; a malformed id is none', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const empty = await counting(() => svc.getPublicProfile(id));
    expect(empty.svc).toHaveLength(1);
    await mkGig(a, { template: 0, variants: 1, addOns: 1, photos: 1 });
    const one1 = await counting(() => svc.getPublicProfile(id));
    expect(one1.result!.gigs).toHaveLength(1);
    for (let i = 0; i < 6; i++) await mkGig(a, { template: i % 3 });
    const many = await counting(() => svc.getPublicProfile(id));
    expect(many.result!.gigs).toHaveLength(7);
    expect(one1.svc).toHaveLength(1);
    expect(many.svc).toHaveLength(1);
    expect(many.svc[0]).toMatch(/provider\.public_profiles/);
    // the statement budget above is the service's own; what a port adapter issues is its own business, so the CALLS per read are pinned instead (these can fail)
    portCalls.length = 0;
    services.batches.length = 0;
    await svc.getPublicProfile(id);
    const callsOf = (port: string) => portCalls.filter((c) => c.port === port).length;
    expect({ trust: callsOf('trust'), services: callsOf('services'), names: callsOf('names'), markets: callsOf('markets') }).toEqual({
      trust: 1,
      services: 1,
      names: 1,
      markets: 1,
    });
    expect(services.batches).toHaveLength(1);
    expect(new Set(services.batches[0]).size).toBe(services.batches[0]!.length);
    expect(services.batches[0]!.length).toBe(3);
    expect(portCalls.every((c) => !c.inTransaction)).toBe(true);
    const priv = await mkReg();
    await svc.createProfile(priv);
    const privateId = (await profileOf(priv)).public_profile_id;
    expect((await counting(() => svc.getPublicProfile(privateId))).svc).toHaveLength(1);
    expect((await counting(() => svc.getPublicProfile(randomUUID()))).svc).toHaveLength(1);
    expect((await counting(() => svc.getPublicProfile('nope'))).svc).toHaveLength(0);
    // a hidden profile calls no dependency at all
    portCalls.length = 0;
    await svc.getPublicProfile(privateId);
    expect(portCalls).toEqual([]);
  });

  it('the preview is the same projection (one statement) and the photo gate is one statement', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    await mkGig(a);
    await setPhoto(a, 2, await mkProfileAsset(a));
    const prev = await counting(() => svc.getPreview(a));
    expect(prev.svc).toHaveLength(1);
    const photo = await counting(() => svc.getPublicPhotoTarget(id));
    expect(photo.svc).toHaveLength(1);
    expect(photo.result).not.toBeNull();
  });

  it('concurrent public reads while a profile row changes see ONE consistent state (proves the single-statement atomicity of the row facts only)', async () => {
    const a = await mkReg();
    const id = await makePublic(a, { displayName: 'State A', bio: 'bio a' });
    const stop = { value: false };
    const flipper = (async () => {
      let toB = true;
      let rev = 3;
      while (!stop.value) {
        const c = await pool.connect();
        try {
          // one UPDATE changes the name and the bio together
          await c.query('UPDATE provider.public_profiles SET display_name = $2, bio = $3, revision = revision + 1 WHERE account_id = $1', [
            a,
            toB ? 'State B' : 'State A',
            toB ? 'bio b' : 'bio a',
          ]);
          rev++;
          toB = !toB;
        } finally {
          c.release();
        }
      }
      return rev;
    })();
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const batch = await Promise.all(Array.from({ length: 8 }, () => svc.getPublicProfile(id)));
      for (const p of batch) {
        expect(p).not.toBeNull();
        seen.add(`${p!.displayName}|${p!.bio}`);
      }
    }
    stop.value = true;
    await flipper;
    for (const s of seen) expect(['State A|bio a', 'State B|bio b']).toContain(s);
  });

  it('an uncommitted Gig retirement is invisible and a committed one is seen whole (single-statement atomicity)', async () => {
    const a = await mkReg();
    const id = await makePublic(a);
    const g = await mkGig(a, { title: 'Soon retired' });
    const tx = await rawTx();
    await tx.query("UPDATE provider.gigs SET status = 'RETIRED' WHERE gig_id = $1", [g.gigId]);
    await tx.query("UPDATE provider.gig_versions SET status = 'RETIRED' WHERE gig_id = $1 AND status = 'PUBLISHED'", [g.gigId]);
    // uncommitted: invisible
    expect((await svc.getPublicProfile(id))!.gigs.map((x) => x.title)).toEqual(['Soon retired']);
    await tx.commit();
    expect((await svc.getPublicProfile(id))!.gigs).toEqual([]);
  });
});

// ====================================================================== the preview
describe('getPreview', () => {
  it('previews a PRIVATE profile with visibility and preview:true; it is not publicly readable', async () => {
    const a = await mkReg();
    const { state } = await svc.createProfile(a);
    await svc.updateProfile(a, { expectedRevision: 1, displayName: 'Preview Co', bio: 'Preview bio' });
    await mkGig(a, { title: 'Preview Gig' });
    const p = await svc.getPreview(a);
    expect(() => PreviewProviderProfileDto.parse(p)).not.toThrow();
    expect(p).toMatchObject({
      preview: true,
      visibility: 'PRIVATE',
      publicProfileId: state.profile!.publicProfileId,
      displayName: 'Preview Co',
      bio: 'Preview bio',
    });
    expect(p.gigs.map((g) => g.title)).toEqual(['Preview Gig']);
    expect(await svc.getPublicProfile(state.profile!.publicProfileId)).toBeNull();
  });

  it('is exactly the public projection plus visibility and preview:true', async () => {
    const a = await mkReg();
    const id = await makePublic(a, { displayName: 'Same Co', bio: 'Same bio' });
    await mkGig(a, { variants: 1, photos: 1 });
    trust.approvals.set(a, [{ type: 'IDENTITY', expiresAt: null }]);
    const pub = (await svc.getPublicProfile(id))!;
    const prev = await svc.getPreview(a);
    const { preview, visibility, ...rest } = prev;
    expect(preview).toBe(true);
    expect(visibility).toBe('PUBLIC');
    expect(rest).toEqual(pub);
  });

  it('PROFILE_NOT_FOUND without a profile; the base eligibility still applies; the account scopes it', async () => {
    const a = await mkReg();
    await expectError(svc.getPreview(a), 'PROFILE_NOT_FOUND');
    await svc.createProfile(a);
    expect((await svc.getPreview(a)).visibility).toBe('PRIVATE');
    await setProviderRole(a, 'INACTIVE');
    await expectError(svc.getPreview(a), 'PROVIDER_NOT_ELIGIBLE', 'ROLE_NOT_ACTIVE');
    const b = await mkReg();
    await svc.createProfile(b);
    await setAccountStatus(b, 'SUSPENDED');
    await expectError(svc.getPreview(b), 'ACCOUNT_NOT_ACTIVE');
  });
});

// ====================================================================== IDOR
describe('ownership', () => {
  it('another account can neither read, preview, edit nor publish a profile; every owner call is scoped by the caller', async () => {
    const a = await mkReg();
    const b = await mkReg();
    const { state } = await svc.createProfile(a);
    await svc.updateProfile(a, { expectedRevision: 1, displayName: 'Owner Only', bio: 'secret' });
    const before = await profileHash(a);
    // B has no profile: every owner call reports the absence of THEIR profile, never A's
    expect((await svc.getOwnerProfile(b)).exists).toBe(false);
    await expectError(svc.getPreview(b), 'PROFILE_NOT_FOUND');
    await expectError(svc.updateProfile(b, { expectedRevision: 2, bio: 'hijack' }), 'PROFILE_NOT_FOUND');
    await expectError(svc.setVisibility(b, { expectedRevision: 2, visibility: 'PUBLIC' }), 'PROFILE_NOT_FOUND');
    await expectError(svc.readProfile(b), 'PROFILE_NOT_FOUND');
    expect(await svc.getOwnerPhotoTarget(b)).toBeNull();
    // the public id is not an account id
    await expectError(svc.updateProfile(state.profile!.publicProfileId, { expectedRevision: 2, bio: 'hijack' }), 'PROFILE_NOT_FOUND');
    expect(await profileHash(a)).toBe(before);
    // with a profile of their own, B's revision and edits never touch A's
    await svc.createProfile(b);
    await svc.updateProfile(b, { expectedRevision: 1, bio: 'mine' });
    expect(await profileHash(a)).toBe(before);
    expect((await svc.getOwnerProfile(b)).profile!.publicProfileId).not.toBe(state.profile!.publicProfileId);
    expect((await svc.getOwnerProfile(b)).profile!.bio).toBe('mine');
  });

  it('the photo target of an owner is their own READY photo only', async () => {
    const a = await mkReg();
    const b = await mkReg();
    await svc.createProfile(a);
    await svc.createProfile(b);
    expect(await svc.getOwnerPhotoTarget(a)).toBeNull();
    const asset = await mkProfileAsset(a);
    await setPhoto(a, 1, asset);
    expect(await svc.getOwnerPhotoTarget(a)).toEqual({ assetId: asset });
    expect(await svc.getOwnerPhotoTarget(b)).toBeNull();
  });
});

// ====================================================================== the photo gate
describe('getPublicPhotoTarget', () => {
  it('is exactly as visible as the profile: PRIVATE, ineligible, unknown and photo-less all give null', async () => {
    const a = await mkReg();
    const { state } = await svc.createProfile(a);
    const id = state.profile!.publicProfileId;
    const asset = await mkProfileAsset(a);
    await setPhoto(a, 1, asset);
    expect(await svc.getPublicPhotoTarget(id)).toBeNull();
    await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PUBLIC' });
    expect(await svc.getPublicPhotoTarget(id)).toEqual({ assetId: asset });
    expect(await svc.getPublicPhotoTarget(randomUUID())).toBeNull();
    await setProviderRole(a, 'INACTIVE');
    expect(await svc.getPublicPhotoTarget(id)).toBeNull();
    const b = await mkReg();
    expect(await svc.getPublicPhotoTarget(await makePublic(b))).toBeNull();
  });
});

// ====================================================================== the mutation primitive
describe('mutateProfile (the primitive the photo service runs on)', () => {
  it('runs inside the account and profile locks, in that order, in one transaction', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    let seen: ProfileMutationContext | undefined;
    const probes: { account: string | undefined; profile: string | undefined } = { account: undefined, profile: undefined };
    await svc.mutateProfile(a, 1, async (ctx) => {
      seen = ctx;
      // other sessions cannot take the account row or the profile row while the primitive holds them
      const acc = await rawTx();
      probes.account = (
        (await rejection(acc.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE NOWAIT', [a]))) as { code?: string } | undefined
      )?.code;
      await acc.rollback();
      const prof = await rawTx();
      probes.profile = (
        (await rejection(prof.query('SELECT 1 FROM provider.public_profiles WHERE account_id = $1 FOR UPDATE NOWAIT', [a]))) as { code?: string } | undefined
      )?.code;
      await prof.rollback();
      return { changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED', changedFields: [], value: undefined };
    });
    expect(probes).toEqual({ account: '55P03', profile: '55P03' });
    expect(seen).toMatchObject({ accountId: a, revision: 1, photoAssetId: null, pendingPhotoAssetId: null });
    expect(seen!.publicProfileId).toBe((await profileOf(a)).public_profile_id);
    expect(typeof seen!.cid).toBe('string');
  });

  it('records a photo change: revision +1, one PROVIDER_PROFILE_PHOTO_CHANGED audit row and one event, no asset reference anywhere', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const asset = await mkProfileAsset(a, { mime: 'image/webp', width: 100, height: 50 });
    const cid = randomUUID();
    const { state } = await runWithCorrelation(cid, () => setPhoto(a, 1, asset));
    expect(state.profile).toMatchObject({ revision: 2, photo: { mimeType: 'image/webp', width: 100, height: 50 }, photoPending: false });
    expect(state.readiness.profilePhotoPresent).toBe(true);
    const rows = await audits(a);
    expect(rows[1]).toMatchObject({ action: 'PROVIDER_PROFILE_PHOTO_CHANGED', changes: { changedFields: ['photo'], revision: [1, 2] }, correlation_id: cid });
    const ev = await events(a, PROFILE_EVENTS.profileUpdated);
    expect(ev[1]!.payload_json).toMatchObject({ revision: 2, changedFields: ['photo'] });
    const everything = await allText(a);
    expect(everything).not.toContain(asset);
    expect(everything).not.toContain('provider/gig-media');
    expect(everything).not.toContain('bbbbbbbb');
    // clearing the photo is a change too
    await setPhoto(a, 2, null);
    expect((await profileOf(a)).photo_asset_id).toBeNull();
    expect((await audits(a))[2]!.action).toBe('PROVIDER_PROFILE_PHOTO_CHANGED');
  });

  it('a stale revision never runs the callback; changed:false writes nothing', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    await svc.updateProfile(a, { expectedRevision: 1, bio: 'x' });
    const before = await profileHash(a);
    const run = vi.fn(async () => ({ changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: [], value: 7 }));
    await expectError(svc.mutateProfile(a, 1, run), 'STALE_PROFILE');
    expect(run).not.toHaveBeenCalled();
    const r = await svc.mutateProfile(a, 2, run);
    expect(r.value).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await profileHash(a)).toBe(before);
    await expectError(svc.mutateProfile(await mkReg(), 1, run), 'PROFILE_NOT_FOUND');
  });

  it('a failing callback rolls everything back; a callback that changes the row without raising the revision exactly once is refused by the guard or the primitive', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const asset = await mkProfileAsset(a);
    const before = await profileHash(a);
    await expectError(
      svc.mutateProfile(a, 1, async (ctx) => {
        await sql`UPDATE provider.public_profiles SET photo_asset_id = ${asset}, revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
          ctx.trx,
        );
        throw new ProfileError('MEDIA_REFUSED', 'later step failed');
      }),
      'MEDIA_REFUSED',
    );
    expect(await profileHash(a)).toBe(before);
    // the guard: a content change without the revision
    await expectError(
      svc.mutateProfile(a, 1, async (ctx) => {
        await sql`UPDATE provider.public_profiles SET photo_asset_id = ${asset} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(ctx.trx);
        return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED', changedFields: ['photo'], value: undefined };
      }),
      'CONFLICT',
      'REVISION',
    );
    // the primitive: claims a change but wrote nothing
    const e = await err(
      svc.mutateProfile(a, 1, async () => ({
        changed: true,
        action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const,
        changedFields: ['photo' as const],
        value: undefined,
      })),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProfileError);
    expect(await profileHash(a)).toBe(before);
  });

  it('refuses field names and audit actions outside the contract (nothing free-form can reach the trail)', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const before = await profileHash(a);
    const bad = await err(
      svc.mutateProfile(a, 1, async (ctx) => {
        await sql`UPDATE provider.public_profiles SET bio = 'x', revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
          ctx.trx,
        );
        return { changed: true, action: 'PROVIDER_PUBLIC_PROFILE_UPDATED' as const, changedFields: ['the bio text itself' as never], value: undefined };
      }),
    );
    expect(bad).toBeInstanceOf(Error);
    expect(await profileHash(a)).toBe(before);
    const bad2 = await err(
      svc.mutateProfile(a, 1, async (ctx) => {
        await sql`UPDATE provider.public_profiles SET bio = 'x', revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
          ctx.trx,
        );
        return { changed: true, action: 'FREE_FORM' as never, changedFields: ['bio' as const], value: undefined };
      }),
    );
    expect(bad2).toBeInstanceOf(Error);
    expect(await profileHash(a)).toBe(before);
  });

  it('the pending upload pointer may change without a revision bump (changed:false) and does not disturb the owner’s revision', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const pending = await mkProfileAsset(a, { ready: false });
    const { state } = await svc.mutateProfile(a, 1, async (ctx) => {
      await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = ${pending} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(ctx.trx);
      return { changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED', changedFields: [], value: undefined };
    });
    expect(state.profile).toMatchObject({ revision: 1, photoPending: true });
    expect(await audits(a)).toHaveLength(1);
    expect(await svc.readProfile(a)).toMatchObject({ revision: 1, pendingPhotoAssetId: pending, photoAssetId: null });
  });
});

// ====================================================================== concurrency
describe('concurrency', () => {
  it('simultaneous edits at the same revision: exactly one wins, the others are STALE_PROFILE, the trail has one row for the winner', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => rejection(svc.updateProfile(a, { expectedRevision: 1, bio: `writer ${i}` }))));
    const losers = results.filter((r) => r !== undefined) as ProfileError[];
    expect(losers).toHaveLength(7);
    for (const e of losers) expect(e).toMatchObject({ code: 'STALE_PROFILE' });
    expect((await profileOf(a)).revision).toBe(2);
    expect((await audits(a)).filter((r) => r.action === 'PROVIDER_PUBLIC_PROFILE_UPDATED')).toHaveLength(1);
    expect(await events(a, PROFILE_EVENTS.profileUpdated)).toHaveLength(2);
  });

  it('a visibility change racing an edit: one wins, the other is stale, and the revision is consistent with the trail', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const [x, y] = await Promise.all([
      rejection(svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' })),
      rejection(svc.updateProfile(a, { expectedRevision: 1, bio: 'race' })),
    ]);
    expect([x, y].filter((r) => r === undefined)).toHaveLength(1);
    const loser = (x ?? y) as ProfileError;
    expect(loser.code).toBe('STALE_PROFILE');
    const row = await profileOf(a);
    expect(row.revision).toBe(2);
    expect((await audits(a)).length).toBe(2);
    expect(row.visibility_status === 'PUBLIC' || row.bio === 'race').toBe(true);
    expect(row.visibility_status === 'PUBLIC' && row.bio === 'race').toBe(false);
  });

  it('a photo replacement through the primitive racing an edit: one wins, the other is stale', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const asset = await mkProfileAsset(a);
    const [x, y] = await Promise.all([rejection(setPhoto(a, 1, asset)), rejection(svc.updateProfile(a, { expectedRevision: 1, displayName: 'Race Co' }))]);
    expect([x, y].filter((r) => r === undefined)).toHaveLength(1);
    expect(((x ?? y) as ProfileError).code).toBe('STALE_PROFILE');
    const row = await profileOf(a);
    expect(row.revision).toBe(2);
    expect((row.photo_asset_id !== null) !== (row.display_name !== null)).toBe(true);
  });

  it('sequential writers each succeed and the revision counts every effective change', async () => {
    const a = await mkReg();
    let rev = (await svc.createProfile(a)).state.profile!.revision;
    for (let i = 0; i < 6; i++) rev = (await svc.updateProfile(a, { expectedRevision: rev, bio: `bio ${i}` })).profile!.revision;
    expect(rev).toBe(7);
    expect((await audits(a)).length).toBe(7);
  });
});

// ====================================================================== atomicity
describe('atomicity', () => {
  it('a failing audit insert rolls the change back: no revision, no event', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const before = await profileHash(a);
    await q('ALTER TABLE provider.profile_audit_events ADD CONSTRAINT ck_test_block CHECK (false) NOT VALID');
    try {
      await expectError(svc.updateProfile(a, { expectedRevision: 1, bio: 'will not stick' }), 'VALIDATION_FAILED');
      await expectError(svc.setVisibility(a, { expectedRevision: 1, visibility: 'PUBLIC' }), 'VALIDATION_FAILED');
    } finally {
      await q('ALTER TABLE provider.profile_audit_events DROP CONSTRAINT ck_test_block');
    }
    expect(await profileHash(a)).toBe(before);
    expect(await profileOf(a)).toMatchObject({ bio: null, revision: 1, visibility_status: 'PRIVATE' });
  });

  it('a failing outbox insert rolls the change and its audit row back', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const before = await profileHash(a);
    await q("ALTER TABLE integration.outbox_events ADD CONSTRAINT ck_test_block_profile CHECK (event_type NOT LIKE 'bananagig.provider.profile-%') NOT VALID");
    try {
      await expectError(svc.updateProfile(a, { expectedRevision: 1, bio: 'will not stick' }), 'VALIDATION_FAILED');
      await expectError(svc.createProfile(await mkReg()), 'VALIDATION_FAILED');
    } finally {
      await q('ALTER TABLE integration.outbox_events DROP CONSTRAINT ck_test_block_profile');
    }
    expect(await profileHash(a)).toBe(before);
    expect((await profileOf(a)).bio).toBeNull();
  });
});

// ====================================================================== provider text never leaves the content columns
describe('provider text', () => {
  it('the display name and the bio reach no audit row, event, log line or error detail across the whole lifecycle', async () => {
    const a = await mkReg();
    let rev = (await svc.createProfile(a)).state.profile!.revision;
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: CANARY_NAME, bio: CANARY_BIO })).profile!.revision;
    rev = (await svc.setVisibility(a, { expectedRevision: rev, visibility: 'PUBLIC' })).profile!.revision;
    await svc.getPublicProfile((await profileOf(a)).public_profile_id);
    await svc.getPreview(a);
    rev = (await svc.updateProfile(a, { expectedRevision: rev, bio: null })).profile!.revision;
    await err(svc.updateProfile(a, { expectedRevision: rev, displayName: `${CANARY_NAME}<b>`, bio: '' }));
    await err(svc.updateProfile(a, { expectedRevision: 1, displayName: CANARY_NAME }));
    await svc.setVisibility(a, { expectedRevision: rev, visibility: 'PRIVATE' });
    noCanary(await allText(a));
    const everyAudit = await q('SELECT changes::text AS c FROM provider.profile_audit_events');
    for (const r of everyAudit) noCanary(String(r.c));
    const everyEvent = await q("SELECT payload_json::text AS p FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.profile-%'");
    for (const r of everyEvent) noCanary(String(r.p));
  });

  it('every audit row and event the lifecycle wrote has only the documented keys', async () => {
    const a = await mkReg();
    let rev = (await svc.createProfile(a)).state.profile!.revision;
    rev = (await svc.updateProfile(a, { expectedRevision: rev, displayName: 'N', bio: 'B' })).profile!.revision;
    await setPhoto(a, rev, await mkProfileAsset(a));
    rev++;
    await svc.setVisibility(a, { expectedRevision: rev, visibility: 'PUBLIC' });
    const allowedAudit = new Set(['changedFields', 'revision', 'visibility']);
    for (const r of await audits(a)) for (const k of Object.keys(r.changes ?? {})) expect(allowedAudit.has(k), `audit key ${k}`).toBe(true);
    for (const e of await events(a, PROFILE_EVENTS.profileUpdated))
      expect(Object.keys(e.payload_json).sort()).toEqual(['accountId', 'changedFields', 'publicProfileId', 'revision']);
    for (const e of await events(a, PROFILE_EVENTS.profileVisibilityChanged))
      expect(Object.keys(e.payload_json).sort()).toEqual(['accountId', 'publicProfileId', 'visibility']);
  });
});

// ====================================================================== unpublishing and removing never depend on unrelated services
describe('hiding never depends on trust, names, the policy or the media policy', () => {
  const failing = [
    ['trust', () => (trust.failure = new Error('SECRET-trust'))],
    ['names', () => (names.failure = new Error('SECRET-names'))],
    ['policy', () => (policyProvider.failure = new Error('SECRET-policy'))],
    [
      'all',
      () => ((trust.failure = new Error('SECRET-trust')), (names.failure = new Error('SECRET-names')), (policyProvider.failure = new Error('SECRET-policy'))),
    ],
  ] as const;
  const withMediaPolicy = (fails: boolean) =>
    new ProviderProfileService({
      db: iso.database,
      accounts,
      names,
      markets,
      trust,
      services,
      policy: policyProvider,
      mediaPolicy: { media: async () => (fails ? Promise.reject(new Error('SECRET-media')) : ({ allowedMimeTypes: ['image/png'] } as never)) },
    });

  it.each(failing)('setVisibility(PRIVATE) succeeds and is committed while %s is failing', async (_n, breakIt) => {
    const a = await mkReg();
    const id = await makePublic(a);
    expect(await svc.getPublicProfile(id)).not.toBeNull();
    breakIt();
    portCalls.length = 0;
    const s = await svc.setVisibility(a, { expectedRevision: 2, visibility: 'PRIVATE' });
    expect(s.profile).toMatchObject({ visibility: 'PRIVATE', revision: 3, publishedAt: null });
    expect(await profileOf(a)).toMatchObject({ visibility_status: 'PRIVATE', revision: 3 });
    expect((await audits(a)).at(-1)!.action).toBe('PROVIDER_PROFILE_VISIBILITY_CHANGED');
    expect(await events(a, PROFILE_EVENTS.profileVisibilityChanged)).toHaveLength(2);
    policyProvider.failure = undefined;
    expect(await svc.getPublicProfile(id)).toBeNull();
    expect(logSink.lines.join('\n')).not.toContain('SECRET');
  });

  it('setVisibility(PRIVATE) succeeds while the media policy fails; PUBLIC (a publishing step) still fails closed', async () => {
    const a = await mkReg();
    await makePublic(a);
    const broken = withMediaPolicy(true);
    const s = await broken.setVisibility(a, { expectedRevision: 2, visibility: 'PRIVATE' });
    expect(s.profile!.visibility).toBe('PRIVATE');
    expect(s.limits.photoMimeTypes).toEqual([]);
    const before = await profileHash(a);
    await expectError(broken.setVisibility(a, { expectedRevision: 3, visibility: 'PUBLIC' }), 'UNAVAILABLE');
    trust.failure = new Error('SECRET-trust');
    await expectError(svc.setVisibility(a, { expectedRevision: 3, visibility: 'PUBLIC' }), 'UNAVAILABLE');
    expect(await profileHash(a)).toBe(before);
  });

  it.each(failing)('removing the photo through the primitive succeeds and is committed while %s is failing', async (_n, breakIt) => {
    const a = await mkReg();
    await svc.createProfile(a);
    await setPhoto(a, 1, await mkProfileAsset(a));
    breakIt();
    const { state } = await setPhoto(a, 2, null);
    expect(state.profile).toMatchObject({ photo: null, revision: 3 });
    expect(await profileOf(a)).toMatchObject({ photo_asset_id: null, revision: 3 });
    expect((await audits(a)).at(-1)!.action).toBe('PROVIDER_PROFILE_PHOTO_CHANGED');
  });

  it('removing the photo succeeds while the media policy fails, and the degraded answer invents no limit', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    await setPhoto(a, 1, await mkProfileAsset(a));
    policyProvider.failure = new Error('SECRET-policy');
    const { state } = await withMediaPolicy(true).mutateProfile(a, 2, async (ctx) => {
      await sql`UPDATE provider.public_profiles SET photo_asset_id = NULL, revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
        ctx.trx,
      );
      return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], value: undefined };
    });
    expect(state.limits).toEqual({
      displayNameMaxLength: 0,
      bioMaxLength: 0,
      bioRequired: false,
      photoRequired: false,
      photoMaxSizeBytes: 0,
      photoMimeTypes: [],
    });
    expect(state.readiness.profileComplete).toBe(false);
    expect((await profileOf(a)).photo_asset_id).toBeNull();
    // a READ of the same state is not degraded: it fails closed
    await expectError(svc.getOwnerProfile(a), 'UNAVAILABLE');
  });
});

// ====================================================================== a PUBLIC profile keeps what it needs to be public
describe('a PUBLIC profile cannot fall below its publishing prerequisites', () => {
  it('clearing the display name is refused when no legal-name fallback exists, and allowed when one does', async () => {
    const noFallback = await mkReg({ names: false });
    await svc.createProfile(noFallback);
    await svc.updateProfile(noFallback, { expectedRevision: 1, displayName: 'Only Name' });
    await svc.setVisibility(noFallback, { expectedRevision: 2, visibility: 'PUBLIC' });
    const before = await profileHash(noFallback);
    const e = await expectError(svc.updateProfile(noFallback, { expectedRevision: 3, displayName: null }), 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual([{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }]);
    expect(await profileHash(noFallback)).toBe(before);
    // make PRIVATE first, then clearing works
    await svc.setVisibility(noFallback, { expectedRevision: 3, visibility: 'PRIVATE' });
    const s = await svc.updateProfile(noFallback, { expectedRevision: 4, displayName: null });
    expect(s.profile!.displayName).toBeNull();
    const withFallback = await mkReg();
    const id = await makePublic(withFallback, { displayName: 'Custom' });
    const s2 = await svc.updateProfile(withFallback, { expectedRevision: 3, displayName: null });
    expect(s2.profile!.publicName).toBe('Ada T.');
    expect((await svc.getPublicProfile(id))!.displayName).toBe('Ada T.');
  });

  it('a names outage blocks clearing the name of a PUBLIC profile only (a PRIVATE one may clear it)', async () => {
    const a = await mkReg();
    await makePublic(a, { displayName: 'Custom' });
    names.failure = new Error('SECRET-names');
    await expectError(svc.updateProfile(a, { expectedRevision: 3, displayName: null }), 'UNAVAILABLE');
    await svc.setVisibility(a, { expectedRevision: 3, visibility: 'PRIVATE' });
    const s = await svc.updateProfile(a, { expectedRevision: 4, displayName: null });
    expect(s.profile!.displayName).toBeNull();
  });

  it('clearing the bio is refused while it is required and the profile is PUBLIC; otherwise allowed', async () => {
    setPolicy({ bioRequired: true });
    const a = await mkReg();
    await makePublic(a, { bio: 'Required bio' });
    const before = await profileHash(a);
    const e = await expectError(svc.updateProfile(a, { expectedRevision: 3, bio: null }), 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual([{ reason: 'BIO_REQUIRED', field: 'bio' }]);
    expect(await profileHash(a)).toBe(before);
    // other edits are not blocked by it
    await svc.updateProfile(a, { expectedRevision: 3, bio: 'Different bio' });
    await svc.setVisibility(a, { expectedRevision: 4, visibility: 'PRIVATE' });
    expect((await svc.updateProfile(a, { expectedRevision: 5, bio: null })).profile!.bio).toBeNull();
    setPolicy({});
    const b = await mkReg();
    await makePublic(b, { bio: 'Optional bio' });
    expect((await svc.updateProfile(b, { expectedRevision: 3, bio: null })).profile!.bio).toBeNull();
  });

  it('a requirement that appears later does not block unrelated edits of a PUBLIC profile', async () => {
    const a = await mkReg();
    await makePublic(a);
    setPolicy({ photoRequired: true, bioRequired: true });
    const s = await svc.updateProfile(a, { expectedRevision: 2, displayName: 'Renamed' });
    expect(s.profile!.displayName).toBe('Renamed');
  });
});

// ====================================================================== events of non-public changes
describe('publicChange:false', () => {
  it('writes the revision and the audit row but NO profile-updated event; the default still emits one', async () => {
    const a = await mkReg();
    await svc.createProfile(a);
    const pending = await mkProfileAsset(a, { ready: false });
    const quiet = await svc.mutateProfile(a, 1, async (ctx) => {
      await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = ${pending}, revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
        ctx.trx,
      );
      return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], publicChange: false, value: undefined };
    });
    expect(quiet.state.profile).toMatchObject({ revision: 2, photoPending: true });
    expect((await audits(a)).at(-1)).toMatchObject({ action: 'PROVIDER_PROFILE_PHOTO_CHANGED', changes: { changedFields: ['photo'], revision: [1, 2] } });
    expect(await events(a, PROFILE_EVENTS.profileUpdated)).toHaveLength(1); // only the creation event
    await svc.mutateProfile(a, 2, async (ctx) => {
      await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = NULL, revision = ${ctx.revision + 1} WHERE public_profile_id = ${ctx.publicProfileId}`.execute(
        ctx.trx,
      );
      return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], publicChange: true, value: undefined };
    });
    expect(await events(a, PROFILE_EVENTS.profileUpdated)).toHaveLength(2);
    await svc.updateProfile(a, { expectedRevision: 3, bio: 'default emits' });
    expect(await events(a, PROFILE_EVENTS.profileUpdated)).toHaveLength(3);
  });
});
