// Integration tests of the Gig media (CAT-004) over a real, freshly migrated PostgreSQL database (migration 0021 with its guard triggers) and the in-memory private object store.
//
// The media operations run through ProviderGigService (which delegates to GigMediaService on its own DraftMutator primitive), so these tests exercise the real lock order, revision
// checks, audit trail and DTO assembly. Everything is asserted against the rows the database holds and the objects the store holds, never against a return value alone.
// Domain packages never import each other: the ports the Gig service needs are FAKES defined here (identity facts and catalogue structure read with plain SQL, like gig.itest.ts).
//
// What must never appear in an audit row, an outbox event, a log line or an error: object keys, upload/download URLs, hashes, asset ids and alt text (checked by `assertNoLeaks`).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GigDetailDto, ProviderGigMediaPolicy, ProviderGigPolicy } from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { MemoryObjectStore, ObjectStoreError } from '@bananagig/platform';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  DEFAULT_GIG_MEDIA_POLICY,
  GigError,
  type GigMediaCleanupResult,
  closePendingMediaOfDraft,
  deleteMediaObjects,
  ProviderGigService,
  StaticGigPolicyProvider,
  type AccountFacts,
  type AccountPort,
  type GigMediaScanner,
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
const CANARY_ALT = 'Zebra canary alt text';

// ---------------------------------------------------------------- images (headers only: the service reads the header, it never decodes)
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** A PNG whose IHDR claims w x h; padded to `size` bytes when given. */
function png(w: number, h: number, size = 0, salt = 0): Buffer {
  const head = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32be(w),
    ...u32be(h),
    8,
    2,
    0,
    0,
    0,
    ...u32be(0),
    ...u32be(0),
    0x49,
    0x45,
    0x4e,
    0x44,
    ...u32be(salt),
  ]);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length, 7)]) : head;
}
function jpeg(w: number, h: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    0x00,
    0x02,
    0xff,
    0xd9,
  ]);
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const DEFAULT_POLICY: ProviderGigPolicy = { maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 };
const policyProvider = new StaticGigPolicyProvider({ ...DEFAULT_POLICY });
const setMedia = (over: Partial<ProviderGigMediaPolicy>): void => {
  policyProvider.mediaValue = { ...DEFAULT_GIG_MEDIA_POLICY, ...over };
};

/** A store whose behaviour a test can bend (outages, an object that changes while it is being read). */
class TestStore extends MemoryObjectStore {
  failHead = false;
  /** Fails every deletion (an outage of the store while objects are being removed). */
  failDelete = false;
  /** Fails signing an upload URL. */
  failSign: Error | undefined;
  /** Runs before a head: lets a test make a competing call happen between this call's start and its read. */
  beforeHead: ((key: string) => Promise<void>) | undefined;
  /** Called after a head returned; lets a test replace the object between the head and the read. */
  afterHead: ((key: string) => void) | undefined;
  /** Called after readVersioned returned; lets a test replace the object between the read and the promotion. */
  afterRead: ((key: string) => void) | undefined;
  /** After a promotion copy, replaces the bytes that landed at the destination (a store that corrupts a copy). */
  corruptCopy = false;
  readonly deleted: string[] = [];
  override async copyIfVersion(fromKey: string, toKey: string, version: string) {
    await super.copyIfVersion(fromKey, toKey, version);
    if (this.corruptCopy) {
      const landed = this.objects.get(toKey)!;
      this.put(
        toKey,
        Buffer.concat([landed.bytes.subarray(0, landed.bytes.length - 1), Buffer.from([landed.bytes[landed.bytes.length - 1]! ^ 0xff])]),
        landed.contentType,
      );
    }
  }
  override async head(key: string) {
    await this.beforeHead?.(key);
    if (this.failHead) throw new Error('store down');
    const info = await super.head(key);
    this.afterHead?.(key);
    return info;
  }
  override async createUploadUrl(r: Parameters<MemoryObjectStore['createUploadUrl']>[0]) {
    if (this.failSign) throw this.failSign;
    return super.createUploadUrl(r);
  }
  override async readVersioned(key: string, max: number) {
    const r = await super.readVersioned(key, max);
    this.afterRead?.(key);
    return r;
  }
  override async delete(key: string) {
    if (this.failDelete) throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    this.deleted.push(key);
    return super.delete(key);
  }
}
const store = new TestStore();
const scanner: GigMediaScanner & { next: 'CLEAN' | 'INFECTED' | 'ERROR' | 'THROW'; scans: number } = {
  next: 'CLEAN',
  scans: 0,
  async scan() {
    scanner.scans++;
    if (scanner.next === 'THROW') throw new Error('scanner crashed');
    return { status: scanner.next };
  },
};

class FakeAccounts implements AccountPort {
  constructor(private readonly database: Database) {}
  async facts(accountId: string): Promise<AccountFacts> {
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
  }
  async grantRole(): Promise<{ changed: boolean; status: string }> {
    throw new Error('the Gig service never grants roles');
  }
}

class FakeTemplates implements GigTemplatePort {
  constructor(private readonly database: Database) {}
  /** Like the real port: its own repeatable-read snapshot, which cannot nest inside another transaction (so a service that called it inside one would fail). */
  private snapshot<T>(fn: () => Promise<T>): Promise<T> {
    return this.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true });
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
    const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
    return {
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
      addOnsAllowed: v.pricing_add_ons === true,
      fields: fields.map((f): GigTemplateFieldFacts => ({
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
        defaultOption: null,
        minLength: num(f.min_length),
        maxLength: num(f.max_length),
        minNumber: num(f.min_number),
        maxNumber: num(f.max_number),
        minItems: num(f.min_items),
        maxItems: num(f.max_items),
        options: [],
      })),
      requirements: [],
    };
  }
  async exactVersion(id: string) {
    return this.snapshot(() => this.structure(id));
  }
  async byCode(code: string) {
    return this.snapshot(async () => {
      const v = (
        await sql<Row>`SELECT v.gig_template_version_id FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
         WHERE t.code = ${code} AND v.status <> 'DRAFT' ORDER BY (v.status = 'ACTIVE') DESC, v.version_number DESC LIMIT 1`.execute(this.database.db)
      ).rows[0];
      return v ? this.structure(v.gig_template_version_id as string) : null;
    });
  }
  async enabledInMarket(marketCode: string, gigTemplateId: string) {
    return this.snapshot(async () => {
      const r = (
        await sql<Row>`SELECT mgt.enabled FROM catalog.market_gig_templates mgt JOIN geography.markets m ON m.market_id = mgt.market_id
         WHERE m.code = ${marketCode} AND mgt.gig_template_id = ${gigTemplateId}`.execute(this.database.db)
      ).rows[0];
      return r?.enabled === true;
    });
  }
  async forCreate(marketCode: string, code: string) {
    return this.snapshot(async () => {
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
  async offered(): Promise<readonly GigTemplateOffer[]> {
    return [];
  }
}

const statements: string[] = [];
let svc: ProviderGigService;
/** The clean-up with its full result (the Gig service's declared return type predates the reconciliation counts). */
const sweep = (o: { limit: number }): Promise<GigMediaCleanupResult> => svc.cleanupMedia(o) as Promise<GigMediaCleanupResult>;

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { overrides: { poolMax: 40, connectionTimeoutMs: 30_000 }, onQuery: (e) => statements.push(e.sql) } });
  pool = createTestPool(iso.url, 10);
  svc = new ProviderGigService({
    database: iso.database,
    accounts: new FakeAccounts(iso.database),
    templates: new FakeTemplates(iso.database),
    policy: policyProvider,
    store,
    scanner,
  });
});
beforeEach(() => {
  policyProvider.failure = undefined;
  policyProvider.mediaValue = { ...DEFAULT_GIG_MEDIA_POLICY };
  store.failHead = false;
  store.failDelete = false;
  store.failSign = undefined;
  store.beforeHead = undefined;
  store.afterRead = undefined;
  store.afterHead = undefined;
  store.corruptCopy = false;
  store.deleted.length = 0;
  store.issued.length = 0;
  scanner.next = 'CLEAN';
  scanner.scans = 0;
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

/** The authorization window is immutable (a guard): a test that needs an authorization in the past switches the guard off for that one statement. */
async function expireAsset(finalKey: string): Promise<void> {
  await q('ALTER TABLE provider.media_assets DISABLE TRIGGER USER');
  try {
    await q(`UPDATE provider.media_assets SET upload_expires_at = created_at + interval '1 millisecond' WHERE object_key = $1`, [finalKey]);
  } finally {
    await q('ALTER TABLE provider.media_assets ENABLE TRIGGER USER');
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
       SELECT $1, role_id, 'ACTIVE', now(), 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code IN ('CUSTOMER', 'PROVIDER')`,
      [id],
    );
    await c.query(`UPDATE identity.accounts SET primary_role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER') WHERE account_id = $1`, [id]);
    await c.query("INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, 'Ada', 'Tester')", [id]);
    await c.query(
      `INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())`,
      [id, `gig.media.itest.${n}@example.test`],
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

async function putContent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'PLAIN_TEXT', 'CONTENT', 'gig media itest copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gig-media-itest' FROM unnest($1::text[]) AS k ON CONFLICT (key) DO NOTHING`,
    [keys],
  );
  await q(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
     SELECT e.entry_id, 'en-US', 'PLATFORM', NULL, 1, 'copy ' || e.key, 'DRAFT', 'NONE', now(), 'gig media itest', 'gig-media-itest' FROM content.entries e
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
  const c = `devtest-gmed${nextSeq()}`;
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
}
async function mkOffer(market: string): Promise<Offer> {
  const stem = `gm${nextSeq()}`;
  const category = `${stem}_cat`;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'gig media itest copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'gig-media-itest' FROM unnest($1::text[]) AS k`,
    [[`catalog.category.${category}.name`, `catalog.service_type.${stem}_t0.name`]],
  );
  await q('INSERT INTO catalog.categories (code) VALUES ($1)', [category]);
  await q("UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = $1", [category]);
  await q(
    `INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) SELECT m.market_id, c.category_id, true, 10 FROM geography.markets m, catalog.categories c WHERE m.code = $1 AND c.code = $2`,
    [market, category],
  );
  const t = `${stem}_t0`;
  await q('INSERT INTO catalog.service_types (category_id, code) SELECT category_id, $2 FROM catalog.categories WHERE code = $1', [category, t]);
  await q("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [t]);
  await q(
    `INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) SELECT m.market_id, s.service_type_id, true, 10 FROM geography.markets m, catalog.service_types s WHERE m.code = $1 AND s.code = $2`,
    [market, t],
  );
  return { market, types: [t] };
}

interface MediaFieldSpec {
  key: string;
  behavior?: 'PROVIDER_CONFIGURABLE' | 'PROVIDER_REQUIRED' | 'PLATFORM_FIXED';
  min?: number;
  max?: number;
}
/** A template whose ACTIVE version has the required text field `notes` and the given MEDIA fields. */
async function mkTemplate(offer: Offer, media: MediaFieldSpec[]): Promise<{ code: string; versionId: string }> {
  const code = `devtest_gmed${nextSeq()}`;
  const stem = `catalog.gig_template.${code}`;
  await putContent([`${stem}.name`, `${stem}.field.notes.label`, ...media.map((m) => `${stem}.field.${m.key}.label`)]);
  const templateId = (
    await one<{ gig_template_id: string }>(
      'INSERT INTO catalog.gig_templates (service_type_id, code) SELECT service_type_id, $2 FROM catalog.service_types WHERE code = $1 RETURNING gig_template_id',
      [offer.types[0], code],
    )
  ).gig_template_id;
  await q("UPDATE catalog.gig_templates SET status = 'ACTIVE' WHERE gig_template_id = $1", [templateId]);
  const versionId = (
    await one<{ gig_template_version_id: string }>(
      'INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES ($1, 1) RETURNING gig_template_version_id',
      [templateId],
    )
  ).gig_template_version_id;
  await q(
    `UPDATE catalog.gig_template_versions SET min_duration_minutes = 60, max_duration_minutes = 240, suggested_duration_minutes = 120, pricing_fixed = true WHERE gig_template_version_id = $1`,
    [versionId],
  );
  await q(
    `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, min_length, max_length)
     VALUES ($1, 'notes', 'TEXT', 'PROVIDER_REQUIRED', 1, $2, 3, 50)`,
    [versionId, `${stem}.field.notes.label`],
  );
  let order = 1;
  for (const m of media)
    await q(
      `INSERT INTO catalog.gig_template_fields (gig_template_version_id, field_key, field_type, behavior, display_order, label_content_key, min_items, max_items)
       VALUES ($1, $2, 'MEDIA', $3, $4, $5, $6, $7)`,
      [versionId, m.key, m.behavior ?? 'PROVIDER_CONFIGURABLE', ++order, `${stem}.field.${m.key}.label`, m.min ?? null, m.max ?? null],
    );
  await q("UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = $1", [versionId]);
  await q(
    `INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) SELECT m.market_id, $2, true, 10 FROM geography.markets m WHERE m.code = $1`,
    [offer.market, templateId],
  );
  return { code, versionId };
}

async function mkRegistered(offer: Offer): Promise<string> {
  const accountId = await mkAccount();
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
  await q(
    'INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) SELECT $1, service_type_id FROM catalog.service_types WHERE code = $2',
    [regId, offer.types[0]],
  );
  await q("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [regId]);
  return accountId;
}

interface Provider {
  accountId: string;
  offer: Offer;
  code: string;
}
/** A registered provider and a template with photos: `photos` (required, 1..3), `gallery` (optional, up to 2) and `banned` (no photos). */
async function mkProvider(
  media: MediaFieldSpec[] = [
    { key: 'photos', behavior: 'PROVIDER_REQUIRED', min: 1, max: 3 },
    { key: 'gallery', max: 2 },
    { key: 'banned', max: 0 },
  ],
): Promise<Provider> {
  const offer = await mkOffer(await mkMarket());
  const t = await mkTemplate(offer, media);
  return { accountId: await mkRegistered(offer), offer, code: t.code };
}
/** A second provider in the same market and template (the other account of an IDOR test). */
const mkNeighbour = async (p: Provider): Promise<string> => mkRegistered(p.offer);

// ---------------------------------------------------------------- scenario helpers
const editable = (over: Record<string, unknown> = {}) => ({
  title: 'Full Detail',
  shortPitch: 'We make it shine',
  description: 'A careful hand wash and wax.',
  priceAmountMinor: 12_500,
  durationMinutes: 120,
  fieldValues: [{ fieldKey: 'notes', value: 'bring water' }],
  ...over,
});
/** A Gig with a draft at revision 1. */
async function mkGig(p: Provider): Promise<{ gigId: string; revision: number }> {
  const d = (await svc.createGig(p.accountId, { gigTemplateCode: p.code })).detail;
  return { gigId: d.gig.gigId, revision: d.draftVersion!.revision };
}
interface Authorized {
  mediaId: string;
  revision: number;
  uploadKey: string;
  finalKey: string;
  url: string;
  detail: GigDetailDto;
}
/** Authorizes an upload (fieldKey `photos` by default) and returns what the test needs, including the keys read from the database (never from the API). */
async function authorize(p: Provider, gigId: string, revision: number, over: Record<string, unknown> = {}): Promise<Authorized> {
  const r = await svc.requestMediaUpload(p.accountId, gigId, {
    expectedRevision: revision,
    fieldKey: 'photos',
    mimeType: 'image/png',
    sizeBytes: 5000,
    altText: null,
    ...over,
  });
  const mediaId = r.upload.media.mediaId;
  const finalKey = (
    await one<{ object_key: string }>(
      `SELECT a.object_key FROM provider.gig_version_media m JOIN provider.media_assets a USING (media_asset_id) WHERE m.gig_version_media_id = $1`,
      [mediaId],
    )
  ).object_key;
  return { mediaId, revision: r.upload.revision, uploadKey: `${finalKey}.upload`, finalKey, url: r.upload.upload.url, detail: r.detail };
}
/** Plays the browser: puts the bytes on the upload key with the authorized content type. */
const browser = (a: Authorized, bytes: Buffer, mime = 'image/png'): void => store.put(a.uploadKey, bytes, mime);
/** authorize + upload + finalize one good photo; returns the revision after. */
async function addPhoto(
  p: Provider,
  gigId: string,
  revision: number,
  over: { fieldKey?: string; bytes?: Buffer; altText?: string | null } = {},
): Promise<Authorized & { revision: number }> {
  const bytes = over.bytes ?? png(800, 600, 5000, nextSeq());
  const a = await authorize(p, gigId, revision, { fieldKey: over.fieldKey ?? 'photos', sizeBytes: bytes.length, altText: over.altText ?? null });
  browser(a, bytes);
  const d = await svc.finalizeMedia(p.accountId, gigId, a.mediaId, { expectedRevision: a.revision });
  return { ...a, revision: d.draftVersion!.revision };
}
const draftRevision = async (gigId: string): Promise<number> =>
  Number((await one<{ revision: number }>(`SELECT revision FROM provider.gig_versions WHERE gig_id = $1 AND status = 'DRAFT'`, [gigId])).revision);
const err = async (p: Promise<unknown>): Promise<GigError | undefined> => (await rejection(p)) as GigError | undefined;
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<GigError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(GigError);
  expect(e!.code, JSON.stringify(e!.details)).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(e!.details.reason).toBe(reasonWanted);
  return e!;
};

interface AssetDb {
  media_asset_id: string;
  account_id: string;
  status: string;
  object_key: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  width: number | null;
  height: number | null;
  scan_status: string;
  ready_at: Date | null;
}
const assetOf = (mediaId: string) =>
  one<AssetDb>(`SELECT a.* FROM provider.gig_version_media m JOIN provider.media_assets a USING (media_asset_id) WHERE m.gig_version_media_id = $1`, [mediaId]);
const attachments = (versionId: string) => q<Row>('SELECT * FROM provider.gig_version_media WHERE gig_version_id = $1 ORDER BY display_order', [versionId]);
const draftId = async (gigId: string): Promise<string> =>
  (await one<{ gig_version_id: string }>(`SELECT gig_version_id FROM provider.gig_versions WHERE gig_id = $1 AND status = 'DRAFT'`, [gigId])).gig_version_id;
const versionId = async (gigId: string, n: number): Promise<string> =>
  (await one<{ gig_version_id: string }>('SELECT gig_version_id FROM provider.gig_versions WHERE gig_id = $1 AND version_number = $2', [gigId, n]))
    .gig_version_id;
const audits = (gigId: string, action?: string) =>
  q<{ action: string; actor: string; changes: Record<string, unknown> | null; gig_version_id: string | null }>(
    `SELECT action, actor, changes, gig_version_id FROM provider.gig_audit_events WHERE gig_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY occurred_at, audit_event_id`,
    [gigId, action ?? null],
  );
const outbox = (gigId: string) =>
  q<Row>(`SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, outbox_event_id`, [gigId]);
const mediaOf = (d: GigDetailDto) => d.draftVersion!.media;

/** Nothing secret may reach an audit row, an event, a log line or an error: object keys, URLs, hashes, asset ids and alt text. */
async function assertNoLeaks(gigId: string, extra: string[] = []): Promise<void> {
  const assetIds = (
    await q<{ media_asset_id: string }>(
      `SELECT DISTINCT a.media_asset_id FROM provider.media_assets a JOIN provider.gig_version_media m USING (media_asset_id) JOIN provider.gig_versions v USING (gig_version_id) WHERE v.gig_id = $1`,
      [gigId],
    )
  ).map((r) => r.media_asset_id);
  const hashes = (
    await q<{ sha256: string }>(
      `SELECT DISTINCT a.sha256 FROM provider.media_assets a JOIN provider.gig_version_media m USING (media_asset_id) JOIN provider.gig_versions v USING (gig_version_id) WHERE v.gig_id = $1 AND a.sha256 IS NOT NULL`,
      [gigId],
    )
  ).map((r) => r.sha256);
  const surfaces = JSON.stringify([await audits(gigId), await outbox(gigId)]) + logSink.lines.join('\n');
  for (const needle of ['provider/gig-media', 'memory://', '.upload', CANARY_ALT, 'Zebra', 'canary', ...assetIds, ...hashes, ...extra])
    expect(surfaces, needle).not.toContain(needle);
}

// ====================================================================== 1. authorize
describe('requestMediaUpload', () => {
  it('authorizes one upload: an UPLOAD_PENDING asset on a final key, an UPLOADING attachment last in the draft, a presigned PUT to a SEPARATE upload key, revision +1, an audit row without secrets', async () => {
    const p = await mkProvider();
    const { gigId, revision } = await mkGig(p);
    const r = await svc.requestMediaUpload(p.accountId, gigId, {
      expectedRevision: revision,
      fieldKey: 'photos',
      mimeType: 'image/png',
      sizeBytes: 5000,
      altText: `  ${CANARY_ALT}  `,
    });
    expect(r.upload.revision).toBe(revision + 1);
    expect(r.upload.maxSizeBytes).toBe(DEFAULT_GIG_MEDIA_POLICY.maxFileSizeBytes);
    expect(r.upload.media).toMatchObject({
      fieldKey: 'photos',
      displayOrder: 1,
      status: 'UPLOADING',
      mimeType: 'image/png',
      sizeBytes: 5000,
      width: null,
      height: null,
      altText: CANARY_ALT,
    });
    expect(r.upload.upload.headers).toEqual({ 'content-type': 'image/png', 'content-length': '5000' });
    expect(new Date(r.upload.upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(r.detail.draftVersion!.revision).toBe(revision + 1);
    expect(mediaOf(r.detail)).toEqual([r.upload.media]);

    const asset = await assetOf(r.upload.media.mediaId);
    expect(asset).toMatchObject({
      account_id: p.accountId,
      status: 'UPLOAD_PENDING',
      mime_type: 'image/png',
      sha256: null,
      width: null,
      scan_status: 'PENDING',
    });
    expect(Number(asset.size_bytes)).toBe(5000);
    expect(asset.object_key).toMatch(/^provider\/gig-media\/[0-9a-f-]{36}$/);
    // the browser uploads to a key nothing reads the final bytes from; the final key itself is never handed out
    expect(store.issued).toEqual([{ kind: 'upload', key: `${asset.object_key}.upload`, ttlSeconds: DEFAULT_GIG_MEDIA_POLICY.uploadTtlSeconds }]);
    expect(r.upload.upload.url).toContain(encodeURIComponent(`${asset.object_key}.upload`));
    expect(JSON.stringify(r.detail)).not.toContain(asset.object_key);
    expect(JSON.stringify(r.detail)).not.toContain('memory://');
    expect(await attachments(await draftId(gigId))).toHaveLength(1);
    expect(await draftRevision(gigId)).toBe(revision + 1);

    const rows = await audits(gigId, 'GIG_MEDIA_UPLOAD_AUTHORIZED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(`account:${p.accountId}`);
    expect(rows[0]!.changes).toEqual({ mediaId: r.upload.media.mediaId, versionNumber: 1, mediaCount: 1, revision: [revision, revision + 1] });
    await assertNoLeaks(gigId);
  });

  it('places each new upload last, in the draft order of the version', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    const b = await authorize(p, g.gigId, a.revision, { fieldKey: 'gallery' });
    expect(mediaOf(b.detail).map((m) => [m.mediaId, m.displayOrder, m.fieldKey])).toEqual([
      [a.mediaId, 1, 'photos'],
      [b.mediaId, 2, 'gallery'],
    ]);
  });

  it('refuses a type outside the configuration and a size above the maximum, creating nothing', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const before = (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.media_assets')).n;
    for (const mimeType of ['image/heic', 'image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream'])
      await expectError(
        svc.requestMediaUpload(p.accountId, g.gigId, { expectedRevision: g.revision, fieldKey: 'photos', mimeType, sizeBytes: 5000, altText: null }),
        'MEDIA_REFUSED',
        'MIME_NOT_ALLOWED',
      );
    await expectError(
      svc.requestMediaUpload(p.accountId, g.gigId, {
        expectedRevision: g.revision,
        fieldKey: 'photos',
        mimeType: 'image/png',
        sizeBytes: DEFAULT_GIG_MEDIA_POLICY.maxFileSizeBytes + 1,
        altText: null,
      }),
      'MEDIA_REFUSED',
      'FILE_TOO_LARGE',
    );
    setMedia({ allowedMimeTypes: ['image/jpeg'] });
    await expectError(
      svc.requestMediaUpload(p.accountId, g.gigId, { expectedRevision: g.revision, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5000, altText: null }),
      'MEDIA_REFUSED',
      'MIME_NOT_ALLOWED',
    );
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.media_assets')).n).toBe(before);
    expect(await draftRevision(g.gigId)).toBe(g.revision);
  });

  it('applies the template rules: unknown field, prohibited field (max 0), per-field maximum, and the configured total', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const issue = (e: GigError) => (e.details.issues as { reason: string; fieldKey?: string }[]).map((i) => [i.reason, i.fieldKey]);
    expect(issue(await expectError(authorize(p, g.gigId, g.revision, { fieldKey: 'ghost' }), 'VALIDATION_FAILED'))).toEqual([['MEDIA_FIELD_UNKNOWN', 'ghost']]);
    expect(issue(await expectError(authorize(p, g.gigId, g.revision, { fieldKey: 'notes' }), 'VALIDATION_FAILED'))).toEqual([['MEDIA_FIELD_UNKNOWN', 'notes']]);
    expect(issue(await expectError(authorize(p, g.gigId, g.revision, { fieldKey: 'banned' }), 'VALIDATION_FAILED'))).toEqual([
      ['MEDIA_NOT_PERMITTED', 'banned'],
    ]);
    let rev = g.revision;
    for (let i = 0; i < 2; i++) rev = (await authorize(p, g.gigId, rev, { fieldKey: 'gallery' })).revision;
    expect(issue(await expectError(authorize(p, g.gigId, rev, { fieldKey: 'gallery' }), 'VALIDATION_FAILED'))).toEqual([['MEDIA_TOO_MANY', 'gallery']]);
    // pending uploads count toward the caps: the total is 2 now
    setMedia({ maxItems: 2 });
    expect(issue(await expectError(authorize(p, g.gigId, rev, { fieldKey: 'photos' }), 'VALIDATION_FAILED'))).toEqual([['MEDIA_TOTAL_EXCEEDED', undefined]]);
    setMedia({ maxItems: 0 });
    await expectError(authorize(p, (await mkGig(p)).gigId, 1, { fieldKey: 'photos' }), 'VALIDATION_FAILED');
    expect((await attachments(await draftId(g.gigId))).length).toBe(2);
  });

  it('a template version without any MEDIA field takes no photos', async () => {
    const p = await mkProvider([]);
    const g = await mkGig(p);
    const e = await expectError(authorize(p, g.gigId, g.revision), 'VALIDATION_FAILED');
    expect((e.details.issues as { reason: string }[])[0]!.reason).toBe('MEDIA_FIELD_UNKNOWN');
  });

  it('refuses a bad alt text without creating anything: too long, markup, control characters', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    for (const altText of ['x'.repeat(DEFAULT_GIG_MEDIA_POLICY.altTextMaxLength + 1), '<script>zebra</script>', 'zebra\u0000nul']) {
      const e = await expectError(authorize(p, g.gigId, g.revision, { altText }), 'VALIDATION_FAILED');
      expect(JSON.stringify(e.details)).not.toContain('zebra');
    }
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
  });

  it('refuses a stale revision, a foreign Gig, a Gig without a draft and a retired Gig', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    await expectError(authorize(p, g.gigId, g.revision + 1), 'STALE_DRAFT');
    await expectError(
      svc.requestMediaUpload(other, g.gigId, { expectedRevision: g.revision, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5000, altText: null }),
      'GIG_NOT_FOUND',
    );
    await expectError(
      svc.requestMediaUpload(p.accountId, randomUUID(), { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5000, altText: null }),
      'GIG_NOT_FOUND',
    );
    const done = await addPhoto(p, g.gigId, g.revision);
    await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: done.revision, ...editable() });
    await svc.publish(p.accountId, g.gigId, { expectedRevision: await draftRevision(g.gigId) });
    await expectError(authorize(p, g.gigId, 1), 'NO_DRAFT');
    const g2 = await mkGig(p);
    await svc.retire(p.accountId, g2.gigId, {});
    await expectError(authorize(p, g2.gigId, g2.revision), 'GIG_RETIRED');
  });

  it('fails closed when the media policy is unavailable', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    policyProvider.failure = new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });
    await expectError(authorize(p, g.gigId, g.revision), 'UNAVAILABLE');
    policyProvider.failure = undefined;
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
  });

  it('closes expired never-finalized authorizations of the draft first (attachment removed, asset ABANDONED, both objects deleted AFTER the commit, REASON-only audit)', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    setMedia({ uploadTtlSeconds: 30 });
    const old = await authorize(p, g.gigId, g.revision, { fieldKey: 'gallery' });
    browser(old, png(800, 600, 5000));
    store.put(old.finalKey, png(800, 600, 5000), 'image/png');
    await expireAsset(old.finalKey);
    // the gallery holds two photos: with the expired one still counted the third would be refused
    const second = await authorize(p, g.gigId, old.revision, { fieldKey: 'gallery' });
    const third = await authorize(p, g.gigId, second.revision, { fieldKey: 'gallery' });
    expect(mediaOf(third.detail).map((m) => m.mediaId)).toEqual([second.mediaId, third.mediaId]);
    expect((await attachments(await draftId(g.gigId))).map((x) => x.gig_version_media_id)).not.toContain(old.mediaId);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [old.finalKey])).status).toBe('ABANDONED');
    expect(store.objects.has(old.uploadKey)).toBe(false);
    expect(store.objects.has(old.finalKey)).toBe(false);
    const refused = await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED');
    expect(refused.map((a) => a.changes)).toEqual([{ mediaId: old.mediaId, versionNumber: 1, reason: 'UPLOAD_EXPIRED' }]);
    await assertNoLeaks(g.gigId);
  });

  it('a failed authorization rolls back everything, including the closure of expired ones, and deletes no object', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const old = await authorize(p, g.gigId, g.revision, { fieldKey: 'gallery' });
    store.put(old.uploadKey, png(800, 600, 5000), 'image/png');
    await expireAsset(old.finalKey);
    store.deleted.length = 0;
    await expectError(authorize(p, g.gigId, old.revision, { fieldKey: 'banned' }), 'VALIDATION_FAILED');
    // refused before the transaction: the expired one is untouched and its object is still there
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [old.finalKey])).status).toBe('UPLOAD_PENDING');
    expect(store.objects.has(old.uploadKey)).toBe(true);
    expect(store.deleted).toEqual([]);
  });
});

// ====================================================================== 2. finalize
describe('finalizeMedia', () => {
  it('verifies and promotes: size, type, signature, header dimensions, SHA-256, a clean scan, then READY with the final bytes in place and the upload key gone', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(1024, 768, 6000, 1);
    const a = await authorize(p, g.gigId, g.revision, { sizeBytes: bytes.length, sha256: sha(bytes) });
    browser(a, bytes);
    const detail = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision, sha256: sha(bytes) });
    expect(detail.draftVersion!.revision).toBe(a.revision + 1);
    expect(mediaOf(detail)).toEqual([
      {
        mediaId: a.mediaId,
        fieldKey: 'photos',
        displayOrder: 1,
        status: 'READY',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        width: 1024,
        height: 768,
        altText: null,
      },
    ]);
    const asset = await assetOf(a.mediaId);
    expect(asset).toMatchObject({ status: 'READY', sha256: sha(bytes), width: 1024, height: 768, scan_status: 'CLEAN' });
    expect(asset.ready_at).toBeInstanceOf(Date);
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(scanner.scans).toBe(1);
    const rows = await audits(g.gigId, 'GIG_MEDIA_ATTACHED');
    expect(rows.map((r) => r.changes)).toEqual([{ mediaId: a.mediaId, versionNumber: 1, scanStatus: 'CLEAN', revision: [a.revision, a.revision + 1] }]);
    await assertNoLeaks(g.gigId);
  });

  it('is idempotent: a second finalize answers with the detail, writes nothing and does not touch the revision', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const before = { audits: (await audits(g.gigId)).length, rev: await draftRevision(g.gigId), scans: scanner.scans };
    // the retry carries the revision it had before the first call: it must still succeed
    const again = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision - 1 });
    expect(mediaOf(again)[0]).toMatchObject({ mediaId: a.mediaId, status: 'READY' });
    expect({ audits: (await audits(g.gigId)).length, rev: await draftRevision(g.gigId), scans: scanner.scans }).toEqual(before);
  });

  it('a client hash that matches is accepted; one that does not abandons the upload and deletes the objects, with a reason code in the audit', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 2);
    const a = await authorize(p, g.gigId, g.revision, { sizeBytes: bytes.length });
    browser(a, bytes);
    await expectError(
      svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision, sha256: sha(Buffer.from('other')) }),
      'MEDIA_REFUSED',
      'HASH_MISMATCH',
    );
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(store.objects.has(a.finalKey)).toBe(false);
    expect((await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED')).map((r) => r.changes)).toEqual([
      { mediaId: a.mediaId, versionNumber: 1, reason: 'HASH_MISMATCH' },
    ]);
    expect(await draftRevision(g.gigId)).toBe(a.revision + 1);
    await assertNoLeaks(g.gigId);
  });

  const refusals: [string, (a: Authorized, bytes: Buffer) => void, string][] = [
    ['a wrong content type on the stored object', (a, b) => browser(a, b, 'image/jpeg'), 'CONTENT_TYPE_MISMATCH'],
    [
      'a wrong signature (a JPEG declared as PNG)',
      (a) => browser(a, Buffer.concat([jpeg(800, 600), Buffer.alloc(5000 - jpeg(800, 600).length, 1)])),
      'SIGNATURE_MISMATCH',
    ],
    [
      'HTML declared as PNG',
      (a) =>
        browser(
          a,
          Buffer.concat([Buffer.from('<html><script>alert(1)</script></html>'), Buffer.alloc(5000 - '<html><script>alert(1)</script></html>'.length, 32)]),
        ),
      'SIGNATURE_MISMATCH',
    ],
    ['an object larger than authorized', (a, b) => browser(a, Buffer.concat([b, Buffer.alloc(1000)])), 'SIZE_MISMATCH'],
    ['an object smaller than authorized', (a) => browser(a, png(800, 600, 4000)), 'SIZE_MISMATCH'],
    [
      'a signature with no readable header',
      (a) => browser(a, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4992, 3)])),
      'IMAGE_INVALID',
    ],
    ['a tiny image (below the minimum edge)', (a) => browser(a, png(100, 100, 5000)), 'IMAGE_TOO_SMALL'],
    ['an edge above the maximum', (a) => browser(a, png(20_000, 300, 5000)), 'IMAGE_TOO_LARGE'],
    ['a decompression bomb: a 5 KB file claiming 12000 x 12000 pixels', (a) => browser(a, png(12_000, 12_000, 5000)), 'IMAGE_TOO_LARGE'],
    ['a decompression bomb claiming the maximum 31-bit size', (a) => browser(a, png(2_147_483_647, 2_147_483_647, 5000)), 'IMAGE_TOO_LARGE'],
  ];
  it.each(refusals)('refuses %s (reason %s) and cleans up', async (_what, upload, reason) => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000);
    const a = await authorize(p, g.gigId, g.revision, { sizeBytes: 5000 });
    upload(a, bytes);
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', reason);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    expect((await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED')).map((r) => (r.changes as { reason: string }).reason)).toEqual([reason]);
    expect(scanner.scans).toBe(0);
    await assertNoLeaks(g.gigId);
  });

  it('a pixel count above the maximum with every edge in range is refused as well', async () => {
    setMedia({ maxPixels: 1_000_000 });
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(2000, 2000, 5000));
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'IMAGE_TOO_LARGE');
  });

  it('a missing object is not a refusal: the upload stays pending and the call can be repeated once the file arrived', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'OBJECT_MISSING');
    expect((await assetOf(a.mediaId)).status).toBe('UPLOAD_PENDING');
    expect(await draftRevision(g.gigId)).toBe(a.revision);
    browser(a, png(800, 600, 5000));
    const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(d)[0]!.status).toBe('READY');
  });

  it('an infected file is abandoned (scan verdict INFECTED kept) and its objects deleted', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    scanner.next = 'INFECTED';
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'SCAN_INFECTED');
    expect(await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).toMatchObject({
      status: 'ABANDONED',
      scan_status: 'INFECTED',
    });
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
  });

  it.each(['ERROR', 'THROW'] as const)(
    'with clean scans required a scanner that says %s keeps the upload pending (nothing promoted) and the call is repeatable',
    async (verdict) => {
      const p = await mkProvider();
      const g = await mkGig(p);
      const a = await authorize(p, g.gigId, g.revision);
      browser(a, png(800, 600, 5000));
      scanner.next = verdict;
      for (let i = 0; i < 2; i++) {
        const e = await expectError(
          svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
          'MEDIA_SCAN_UNAVAILABLE',
          'SCAN_UNAVAILABLE',
        );
        expect(e.details.retryable).toBe(true);
      }
      expect((await assetOf(a.mediaId)).status).toBe('UPLOAD_PENDING');
      expect(store.objects.has(a.uploadKey)).toBe(true);
      expect(store.objects.has(a.finalKey)).toBe(false);
      expect(await draftRevision(g.gigId)).toBe(a.revision);
      scanner.next = 'CLEAN';
      const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
      expect(mediaOf(d)[0]!.status).toBe('READY');
    },
  );

  it('without the clean-scan requirement a scanner ERROR is accepted and recorded as ERROR; publishing then needs a clean verdict once the requirement is on', async () => {
    setMedia({ requireCleanScan: false });
    const p = await mkProvider();
    const g = await mkGig(p);
    scanner.next = 'ERROR';
    const a = await addPhoto(p, g.gigId, g.revision);
    expect((await assetOf(a.mediaId)).scan_status).toBe('ERROR');
    expect((await audits(g.gigId, 'GIG_MEDIA_ATTACHED'))[0]!.changes).toMatchObject({ scanStatus: 'ERROR' });
    const ok = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: a.revision, ...editable() });
    expect(ok.draftVersion!.publishable).toBe(true);
    setMedia({ requireCleanScan: true });
    const blocked = await svc.getGig(p.accountId, g.gigId);
    expect(blocked.draftVersion!.publishable).toBe(false);
    expect(blocked.draftVersion!.issues.map((i) => i.reason)).toContain('MEDIA_NOT_READY');
  });

  it('a changed upload object (replaced between the read and the promotion) is refused as OBJECT_CHANGED and nothing is promoted', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    store.afterRead = (key) => {
      if (key === a.uploadKey) store.put(a.uploadKey, png(900, 900, 5000), 'image/png');
    };
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'OBJECT_CHANGED');
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
  });

  it('a replayed presigned PUT after finalize cannot change the final asset: nothing reads the upload key again', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 5);
    const a = await addPhoto(p, g.gigId, g.revision, { bytes });
    const evil = png(800, 600, 5000, 6);
    store.put(a.uploadKey, evil, 'image/png'); // the still-valid presigned URL used again
    await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect((await assetOf(a.mediaId)).sha256).toBe(sha(bytes));
    const url = await svc.previewMedia(p.accountId, g.gigId, null, a.mediaId);
    expect(decodeURIComponent(url.url)).toContain(a.finalKey);
    expect(decodeURIComponent(url.url)).not.toContain('.upload');
  });

  it('expired authorization: MEDIA_EXPIRED, the upload is closed and the objects deleted', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    await expireAsset(a.finalKey);
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_EXPIRED', 'UPLOAD_EXPIRED');
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED')).map((r) => (r.changes as { reason: string }).reason)).toEqual(['UPLOAD_EXPIRED']);
  });

  it('the policy may change between authorization and finalize: a type or size that is no longer allowed is refused', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    setMedia({ allowedMimeTypes: ['image/jpeg'] });
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'MIME_NOT_ALLOWED');
    setMedia({});
    const b = await authorize({ ...p }, g.gigId, await draftRevision(g.gigId));
    setMedia({ allowedMimeTypes: ['image/png'], maxFileSizeBytes: 1000 });
    browser(b, png(800, 600, 5000));
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, b.mediaId, { expectedRevision: b.revision }), 'MEDIA_REFUSED', 'FILE_TOO_LARGE');
  });

  it('an object store outage is UNAVAILABLE, leaves the upload pending and logs the error name only', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    store.failHead = true;
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'UNAVAILABLE', 'MEDIA_STORE_UNAVAILABLE');
    store.failHead = false;
    expect((await assetOf(a.mediaId)).status).toBe('UPLOAD_PENDING');
    expect(logSink.lines.some((l) => l.includes('gig media object store unavailable'))).toBe(true);
    await assertNoLeaks(g.gigId);
  });

  it('refuses a stale revision before reading the object, and another account cannot finalize (or learn about) the upload', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    const og = await svc.createGig(other, { gigTemplateCode: p.code });
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision + 5 }), 'STALE_DRAFT');
    // the other account: with my Gig id, with its own Gig id and my media id, and with a random id
    await expectError(svc.finalizeMedia(other, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'GIG_NOT_FOUND');
    await expectError(svc.finalizeMedia(other, og.detail.gig.gigId, a.mediaId, { expectedRevision: 1 }), 'MEDIA_NOT_FOUND');
    await expectError(svc.finalizeMedia(other, og.detail.gig.gigId, randomUUID(), { expectedRevision: 1 }), 'MEDIA_NOT_FOUND');
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, 'not-a-uuid', { expectedRevision: a.revision }), 'MEDIA_NOT_FOUND');
    expect((await assetOf(a.mediaId)).status).toBe('UPLOAD_PENDING');
    expect(scanner.scans).toBe(0);
  });

  it('two simultaneous finalizations of one upload end with ONE READY asset, one attached audit row and intact final bytes', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 9);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, bytes);
    const results = await Promise.allSettled([
      svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
      svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
    ]);
    // either both succeed, or the loser reports a retryable conflict and a retry succeeds
    for (const r of results) if (r.status === 'rejected') expect(['STALE_DRAFT', 'CONFLICT']).toContain((r.reason as GigError).code);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const again = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(again)[0]!.status).toBe('READY');
    expect((await audits(g.gigId, 'GIG_MEDIA_ATTACHED')).length).toBe(1);
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect((await assetOf(a.mediaId)).sha256).toBe(sha(bytes));
  });
});

// ====================================================================== 3. alt text, order, detach
describe('alt text, order and detach (draft only)', () => {
  it('updates the alt text (normalised), clears it with null, ignores a no-op, bumps the revision once per change and audits without the text', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    let rev = a.revision;
    const d1 = await svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: rev, altText: `  ${CANARY_ALT}   with   spaces ` });
    expect(mediaOf(d1)[0]!.altText).toBe(`${CANARY_ALT} with spaces`);
    expect(d1.draftVersion!.revision).toBe(rev + 1);
    rev += 1;
    const same = await svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: rev, altText: `${CANARY_ALT} with spaces` });
    expect(same.draftVersion!.revision).toBe(rev);
    const blank = await svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: rev, altText: '   ' });
    expect(mediaOf(blank)[0]!.altText).toBeNull();
    expect(blank.draftVersion!.revision).toBe(rev + 1);
    const rows = await audits(g.gigId, 'GIG_MEDIA_UPDATED');
    expect(rows.map((r) => r.changes)).toEqual([
      { mediaId: a.mediaId, versionNumber: 1, altTextSet: true, revision: [rev - 1, rev] },
      { mediaId: a.mediaId, versionNumber: 1, altTextSet: false, revision: [rev, rev + 1] },
    ]);
    await assertNoLeaks(g.gigId);
  });

  it('refuses alt text above the configured length, markup and control characters; a stale revision; an unknown or foreign media id', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const issue = async (altText: string) =>
      (
        (await expectError(svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision, altText }), 'VALIDATION_FAILED')).details
          .issues as { reason: string; itemKey?: string }[]
      )[0]!;
    expect(await issue('y'.repeat(DEFAULT_GIG_MEDIA_POLICY.altTextMaxLength + 1))).toMatchObject({ reason: 'MEDIA_ALT_TOO_LONG', itemKey: a.mediaId });
    expect((await issue('<img src=x onerror=alert(1)>')).reason).toBe('HTML_NOT_ALLOWED');
    expect((await issue('a‮b')).reason).toBe('FORBIDDEN_CHARACTER');
    await expectError(svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision + 1, altText: 'x' }), 'STALE_DRAFT');
    await expectError(svc.updateMedia(p.accountId, g.gigId, randomUUID(), { expectedRevision: a.revision, altText: 'x' }), 'MEDIA_NOT_FOUND');
    await expectError(svc.updateMedia(other, g.gigId, a.mediaId, { expectedRevision: a.revision, altText: 'x' }), 'GIG_NOT_FOUND');
    const og = (await svc.createGig(other, { gigTemplateCode: p.code })).detail;
    await expectError(svc.updateMedia(other, og.gig.gigId, a.mediaId, { expectedRevision: 1, altText: 'x' }), 'MEDIA_NOT_FOUND');
    expect(mediaOf(await svc.getGig(p.accountId, g.gigId))[0]!.altText).toBeNull();
  });

  it('reorders the WHOLE list: numbers 1..n, one revision bump, counts-only audit; a no-op changes nothing; a wrong set is MEDIA_ORDER_INVALID', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const b = await addPhoto(p, g.gigId, a.revision, { fieldKey: 'gallery' });
    const c = await addPhoto(p, g.gigId, b.revision);
    const ids = [a.mediaId, b.mediaId, c.mediaId];
    const noop = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: c.revision, mediaIds: ids });
    expect(noop.draftVersion!.revision).toBe(c.revision);
    const d = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: c.revision, mediaIds: [c.mediaId, a.mediaId, b.mediaId] });
    expect(mediaOf(d).map((m) => [m.mediaId, m.displayOrder])).toEqual([
      [c.mediaId, 1],
      [a.mediaId, 2],
      [b.mediaId, 3],
    ]);
    expect(d.draftVersion!.revision).toBe(c.revision + 1);
    expect((await audits(g.gigId, 'GIG_MEDIA_REORDERED')).map((r) => r.changes)).toEqual([
      { versionNumber: 1, mediaCount: 3, revision: [c.revision, c.revision + 1] },
    ]);
    const rev = c.revision + 1;
    const og = (await svc.createGig(other, { gigTemplateCode: p.code })).detail.gig.gigId;
    const foreign = (await authorize({ ...p, accountId: other }, og, 1)).mediaId;
    for (const bad of [[a.mediaId, b.mediaId], [...ids, randomUUID()], [a.mediaId, b.mediaId, foreign], [], [a.mediaId, a.mediaId, b.mediaId]])
      await expectError(svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: rev, mediaIds: bad }), 'VALIDATION_FAILED');
    const e = await expectError(svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: rev, mediaIds: [a.mediaId, b.mediaId] }), 'VALIDATION_FAILED');
    expect((e.details.issues as { reason: string }[])[0]!.reason).toBe('MEDIA_ORDER_INVALID');
    await expectError(svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: rev + 1, mediaIds: ids }), 'STALE_DRAFT');
    expect(await draftRevision(g.gigId)).toBe(rev);
  });

  it('detaches a READY photo: the attachment goes, the asset and its bytes STAY (a published version may reference them), the revision rises once', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    await expectError(svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision - 1 }), 'STALE_DRAFT');
    expect(mediaOf(await svc.getGig(p.accountId, g.gigId))).toHaveLength(1);
    const d = await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(d)).toEqual([]);
    expect(d.draftVersion!.revision).toBe(a.revision + 1);
    expect(await attachments(await draftId(g.gigId))).toHaveLength(0);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
    expect(store.objects.has(a.finalKey)).toBe(true);
    expect((await audits(g.gigId, 'GIG_MEDIA_DETACHED')).map((r) => r.changes)).toEqual([
      { mediaId: a.mediaId, versionNumber: 1, abandoned: false, revision: [a.revision, a.revision + 1] },
    ]);
    await expectError(svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision + 1 }), 'MEDIA_NOT_FOUND');
    await assertNoLeaks(g.gigId);
  });

  it('detaching an UPLOADING photo abandons the upload: asset ABANDONED, both objects deleted, the place is free again', async () => {
    const p = await mkProvider([{ key: 'photos', max: 1 }]);
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    await expectError(authorize(p, g.gigId, a.revision), 'VALIDATION_FAILED');
    const d = await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(d)).toEqual([]);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await audits(g.gigId, 'GIG_MEDIA_DETACHED')).map((r) => r.changes)).toEqual([
      { mediaId: a.mediaId, versionNumber: 1, abandoned: true, revision: [a.revision, a.revision + 1] },
    ]);
    const b = await authorize(p, g.gigId, d.draftVersion!.revision);
    expect(mediaOf(b.detail)).toHaveLength(1);
  });

  it('another provider cannot detach, reorder, edit or see my photo', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    await expectError(svc.detachMedia(other, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'GIG_NOT_FOUND');
    await expectError(svc.reorderMedia(other, g.gigId, { expectedRevision: a.revision, mediaIds: [a.mediaId] }), 'GIG_NOT_FOUND');
    await expectError(svc.previewMedia(other, g.gigId, null, a.mediaId), 'GIG_NOT_FOUND');
    await expectError(svc.previewMedia(other, g.gigId, 1, a.mediaId), 'GIG_NOT_FOUND');
    const og = (await svc.createGig(other, { gigTemplateCode: p.code })).detail.gig.gigId;
    await expectError(svc.previewMedia(other, og, null, a.mediaId), 'MEDIA_NOT_FOUND');
    await expectError(svc.detachMedia(other, og, a.mediaId, { expectedRevision: 1 }), 'MEDIA_NOT_FOUND');
    expect(mediaOf(await svc.getGig(p.accountId, g.gigId))).toHaveLength(1);
  });
});

// ====================================================================== 4. publish, frozen versions, reuse
describe('versions: publish, frozen children, the next draft re-attaches the same asset', () => {
  async function publishedWithPhoto(p: Provider) {
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision, { altText: 'front of the car' });
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: a.revision, ...editable() });
    const pub = await svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision });
    return { ...g, a, pub };
  }

  it('publish needs the required photo, READY and finished: it is blocked without one and while one is still uploading', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: g.revision, ...editable() });
    const e = await expectError(svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision }), 'PUBLISH_BLOCKED');
    expect((e.details.issues as { reason: string; fieldKey?: string }[]).map((i) => [i.reason, i.fieldKey])).toContainEqual(['MEDIA_REQUIRED', 'photos']);
    const pending = await authorize(p, g.gigId, saved.draftVersion!.revision);
    const e2 = await expectError(svc.publish(p.accountId, g.gigId, { expectedRevision: pending.revision }), 'PUBLISH_BLOCKED');
    const reasons = (e2.details.issues as { reason: string; itemKey?: string }[]).map((i) => i.reason);
    expect(reasons).toContain('MEDIA_NOT_READY');
    expect(reasons).toContain('MEDIA_REQUIRED');
    browser(pending, png(800, 600, 5000));
    const fin = await svc.finalizeMedia(p.accountId, g.gigId, pending.mediaId, { expectedRevision: pending.revision });
    expect(fin.draftVersion!.publishable).toBe(true);
  });

  it("a published version's photos are frozen by the database and the draft operations cannot reach them", async () => {
    const p = await mkProvider();
    const { gigId, a, pub } = await publishedWithPhoto(p);
    expect(pub.currentVersion!.media.map((m) => [m.mediaId, m.status, m.altText])).toEqual([[a.mediaId, 'READY', 'front of the car']]);
    await expectError(svc.detachMedia(p.accountId, gigId, a.mediaId, { expectedRevision: 1 }), 'NO_DRAFT');
    await expectError(
      svc.requestMediaUpload(p.accountId, gigId, { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5000, altText: null }),
      'NO_DRAFT',
    );
    for (const stmt of [
      `UPDATE provider.gig_version_media SET alt_text = 'x' WHERE gig_version_media_id = $1`,
      `DELETE FROM provider.gig_version_media WHERE gig_version_media_id = $1`,
      `UPDATE provider.gig_version_media SET display_order = 9 WHERE gig_version_media_id = $1`,
    ])
      await expect(q(stmt, [a.mediaId])).rejects.toMatchObject({ detail: 'provider_rule:VERSION_FROZEN' });
    // the asset behind it cannot be abandoned or deleted while referenced
    const assetId = (await assetOf(a.mediaId)).media_asset_id;
    await expect(q(`UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1`, [assetId])).rejects.toMatchObject({
      detail: 'provider_rule:ASSET_REFERENCED',
    });
    const ev = (await outbox(gigId)).find((r) => r.event_type === 'bananagig.provider.gig-version-published.v1');
    expect(ev!.payload_json).toMatchObject({ mediaCount: 1 });
  });

  it('the next draft re-attaches the SAME READY asset (no binary copy) with the same field, order and alt text; v1 is untouched by v2 edits', async () => {
    const p = await mkProvider();
    const { gigId, a } = await publishedWithPhoto(p);
    const objectsBefore = store.objects.size;
    const next = await svc.createNextDraft(p.accountId, gigId, {});
    expect(store.objects.size).toBe(objectsBefore);
    const v2 = next.draftVersion!;
    expect(v2.media).toHaveLength(1);
    expect(v2.media[0]).toMatchObject({ fieldKey: 'photos', displayOrder: 1, status: 'READY', altText: 'front of the car', width: 800, height: 600 });
    expect(v2.media[0]!.mediaId).not.toBe(a.mediaId);
    const v1Att = (await attachments(await versionId(gigId, 1)))[0]!;
    const v2Att = (await attachments(await versionId(gigId, 2)))[0]!;
    expect(v2Att.media_asset_id).toBe(v1Att.media_asset_id);
    expect(v2Att.gig_version_media_id).not.toBe(v1Att.gig_version_media_id);

    // editing v2 (alt text, adding, detaching) never touches v1
    const alt = await svc.updateMedia(p.accountId, gigId, v2.media[0]!.mediaId, { expectedRevision: v2.revision, altText: 'changed' });
    const more = await addPhoto(p, gigId, alt.draftVersion!.revision, { fieldKey: 'gallery' });
    const det = await svc.detachMedia(p.accountId, gigId, v2.media[0]!.mediaId, { expectedRevision: more.revision });
    expect(mediaOf(det).map((m) => m.fieldKey)).toEqual(['gallery']);
    expect((await attachments(await versionId(gigId, 1))).map((r) => [r.gig_version_media_id, r.alt_text])).toEqual([[a.mediaId, 'front of the car']]);
    expect((await svc.getGigVersion(p.accountId, gigId, 1)).media.map((m) => [m.mediaId, m.status])).toEqual([[a.mediaId, 'READY']]);
    // detaching the photo from v2 did not delete the asset v1 references
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
    expect(store.objects.has(a.finalKey)).toBe(true);
    await assertNoLeaks(gigId);
  });

  it('an unfinished upload of the draft is not copied into the next draft', async () => {
    const p = await mkProvider();
    const { gigId } = await publishedWithPhoto(p);
    const v2 = (await svc.createNextDraft(p.accountId, gigId, {})).draftVersion!;
    const pending = await authorize(p, gigId, v2.revision, { fieldKey: 'gallery' });
    // publish v2 is blocked while it is pending; retire the draft's pending by detaching, then the v2 is clean
    await svc.detachMedia(p.accountId, gigId, pending.mediaId, { expectedRevision: pending.revision });
    const saved = await svc.getGig(p.accountId, gigId);
    expect(saved.draftVersion!.media).toHaveLength(1);
  });
});

// ====================================================================== 5. preview
describe('previewMedia', () => {
  it('gives the owner a short-lived inline GET target of a READY photo of the draft and of a published version; never to another account; never for an unfinished upload', async () => {
    const p = await mkProvider();
    const other = await mkNeighbour(p);
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    store.issued.length = 0;
    const r = await svc.previewMedia(p.accountId, g.gigId, null, a.mediaId);
    expect(r.url.startsWith('memory://download/')).toBe(true);
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(store.issued).toEqual([{ kind: 'download', key: a.finalKey, ttlSeconds: DEFAULT_GIG_MEDIA_POLICY.downloadTtlSeconds, disposition: 'inline' }]);
    // a published version
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: a.revision, ...editable() });
    await svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision });
    expect((await svc.previewMedia(p.accountId, g.gigId, 1, a.mediaId)).url).toContain('memory://download/');
    await expectError(svc.previewMedia(p.accountId, g.gigId, null, a.mediaId), 'NO_DRAFT');
    await expectError(svc.previewMedia(p.accountId, g.gigId, 7, a.mediaId), 'GIG_VERSION_NOT_FOUND');
    // other accounts: indistinguishable from a Gig that does not exist
    await expectError(svc.previewMedia(other, g.gigId, 1, a.mediaId), 'GIG_NOT_FOUND');
    // an attachment of another version is not found under this version
    const v2 = (await svc.createNextDraft(p.accountId, g.gigId, {})).draftVersion!;
    const pending = await authorize(p, g.gigId, v2.revision, { fieldKey: 'gallery' });
    await expectError(svc.previewMedia(p.accountId, g.gigId, null, pending.mediaId), 'MEDIA_NOT_FOUND');
    await expectError(svc.previewMedia(p.accountId, g.gigId, 1, pending.mediaId), 'MEDIA_NOT_FOUND');
    await assertNoLeaks(g.gigId);
  });

  it('hides a photo accepted without a clean verdict once clean scans are required, and fails closed on a policy outage', async () => {
    setMedia({ requireCleanScan: false });
    const p = await mkProvider();
    const g = await mkGig(p);
    scanner.next = 'ERROR';
    const a = await addPhoto(p, g.gigId, g.revision);
    expect((await svc.previewMedia(p.accountId, g.gigId, null, a.mediaId)).url).toContain('memory://');
    setMedia({ requireCleanScan: true });
    await expectError(svc.previewMedia(p.accountId, g.gigId, null, a.mediaId), 'MEDIA_NOT_FOUND');
    policyProvider.failure = new GigError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' });
    await expectError(svc.previewMedia(p.accountId, g.gigId, null, a.mediaId), 'UNAVAILABLE');
  });
});

// ====================================================================== 6. clean-up
describe('cleanupMedia (reference-aware)', () => {
  const expire = expireAsset;

  it('abandons expired never-finalized uploads: attachment out of the draft (revision +1), asset ABANDONED, both objects deleted, a system audit row with a reason code', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    store.put(a.finalKey, png(800, 600, 5000), 'image/png');
    const live = await authorize(p, g.gigId, a.revision, { fieldKey: 'gallery' });
    await expire(a.finalKey);
    const r = await sweep({ limit: 100 });
    expect(r.abandoned).toBeGreaterThanOrEqual(1);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect((await attachments(await draftId(g.gigId))).map((x) => x.gig_version_media_id)).toEqual([live.mediaId]);
    expect(await draftRevision(g.gigId)).toBe(live.revision + 1);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(store.objects.has(a.finalKey)).toBe(false);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [live.finalKey])).status).toBe('UPLOAD_PENDING');
    const rows = await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED');
    expect(rows.map((x) => [x.actor, x.changes])).toEqual([['system:gig-media-cleanup', { mediaId: a.mediaId, versionNumber: 1, reason: 'UPLOAD_EXPIRED' }]]);
    // a second run has nothing left to do
    expect((await sweep({ limit: 100 })).abandoned).toBe(0);
    expect(logSink.lines.join('\n')).not.toContain('provider/gig-media');
    await assertNoLeaks(g.gigId);
  });

  it('honours the batch limit', async () => {
    await sweep({ limit: 1000 }); // leftovers of other tests are not expired: nothing to clear, the counts below are relative
    const p = await mkProvider([{ key: 'gallery', max: 5 }]);
    const g = await mkGig(p);
    let rev = g.revision;
    const keys: string[] = [];
    // (a new authorization closes the expired ones of its draft, so all three are authorized first and expire together)
    for (let i = 0; i < 3; i++) {
      const a = await authorize(p, g.gigId, rev, { fieldKey: 'gallery' });
      rev = a.revision;
      keys.push(a.finalKey);
    }
    for (const k of keys) await expire(k);
    expect((await sweep({ limit: 2 })).abandoned).toBe(2);
    expect((await sweep({ limit: 2 })).abandoned).toBe(1);
  });

  it('deletes a READY asset that NO attachment references only after the grace period; the bytes go, the row becomes DELETED', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    const before = await sweep({ limit: 100 }); // within the 24 h grace
    expect(before.deleted).toBe(0);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
    expect(store.objects.has(a.finalKey)).toBe(true);
    setMedia({ orphanGraceSeconds: 0 });
    const after = await sweep({ limit: 100 });
    expect(after.deleted).toBeGreaterThanOrEqual(1);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('DELETED');
    expect(store.objects.has(a.finalKey)).toBe(false);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    await assertNoLeaks(g.gigId);
  });

  it('NEVER deletes the bytes of an asset any attachment references, in any version state, even with a zero grace period', async () => {
    setMedia({ orphanGraceSeconds: 0 });
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const draftOnly = await sweep({ limit: 100 });
    expect(draftOnly.deleted).toBe(0);
    expect(store.objects.has(a.finalKey)).toBe(true);
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: a.revision, ...editable() });
    await svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision });
    // v2 draft detaches the photo: v1 (published) still references the asset
    const v2 = (await svc.createNextDraft(p.accountId, g.gigId, {})).draftVersion!;
    await svc.detachMedia(p.accountId, g.gigId, v2.media[0]!.mediaId, { expectedRevision: v2.revision });
    await sweep({ limit: 100 });
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
    expect(store.objects.has(a.finalKey)).toBe(true);
    // v1 superseded by a v2 that does not carry the photo: v1 still references it
    await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: v2.revision + 1, ...editable({ title: 'Two' }) });
    // (the required photo is gone from v2, so v2 cannot be published; a retired Gig keeps every version frozen)
    await svc.retire(p.accountId, g.gigId, {});
    await sweep({ limit: 100 });
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
    expect(store.objects.has(a.finalKey)).toBe(true);
  });

  it('attach and sweep cannot race: an asset someone holds a share lock on (an attach in flight) is skipped, and swept on the next run once it is really unreferenced', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    setMedia({ orphanGraceSeconds: 0 });
    const asset = await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey]);
    const attacher = await rawTx();
    await attacher.query('SELECT 1 FROM provider.media_assets WHERE media_asset_id = $1 FOR SHARE', [asset.media_asset_id]);
    const skipped = await sweep({ limit: 100 });
    expect(skipped.deleted).toBe(0);
    expect(store.objects.has(a.finalKey)).toBe(true);
    await attacher.rollback();
    expect((await sweep({ limit: 100 })).deleted).toBe(1);
    expect(store.objects.has(a.finalKey)).toBe(false);
  });

  it('a sweep running while the next draft is being started never deletes the asset the draft re-attaches', async () => {
    setMedia({ orphanGraceSeconds: 0 });
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: a.revision, ...editable() });
    await svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision });
    for (let i = 0; i < 3; i++) {
      const [, next] = await Promise.all([sweep({ limit: 100 }), svc.createNextDraft(p.accountId, g.gigId, {}).catch((e) => e)]);
      expect(next instanceof GigError ? next.code : 'ok').toBe(i === 0 ? 'ok' : 'DRAFT_EXISTS');
      expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('READY');
      expect(store.objects.has(a.finalKey)).toBe(true);
    }
  });

  it('a Gig retired with a photo in flight: retire closes the pending upload (asset ABANDONED, attachment gone, GIG_RETIRED audit); its objects go after the commit and the clean-up records the removal once the authorization has ended, also removing a PUT that recreated the upload object', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    store.put(a.finalKey, png(800, 600, 5000), 'image/png');
    await svc.retire(p.accountId, g.gigId, {});
    const asset = await one<AssetDb & { objects_removed_at: Date | null }>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey]);
    expect(asset.status).toBe('ABANDONED');
    expect(await attachments(await versionId(g.gigId, 1))).toHaveLength(0);
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    expect((await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED')).map((r) => r.changes)).toEqual([
      { mediaId: a.mediaId, versionNumber: 1, reason: 'GIG_RETIRED' },
    ]);
    // the PUT authorization is still valid: the removal is not yet confirmed, a replayed PUT could recreate the upload object
    expect(asset.objects_removed_at).toBeNull();
    browser(a, png(800, 600, 5000, 77));
    await expire(a.finalKey);
    const r = await sweep({ limit: 100 });
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]))
        .objects_removed_at,
    ).toBeInstanceOf(Date);
    expect((await sweep({ limit: 100 })).reconciled).toBe(0);
    await assertNoLeaks(g.gigId);
  });

  it('a pending photo left on a RETIRED version by an older retire (attachment frozen) is abandoned by the clean-up; the attachment stays as history and the objects go', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    store.put(a.finalKey, png(800, 600, 5000), 'image/png');
    browser(a, png(800, 600, 5000));
    // the state an older retire left behind: the version and the Gig are RETIRED while the unfinished upload is still attached
    await q('ALTER TABLE provider.gig_versions DISABLE TRIGGER USER');
    await q('ALTER TABLE provider.gigs DISABLE TRIGGER USER');
    try {
      await q(`UPDATE provider.gig_versions SET status = 'RETIRED', retired_at = now() WHERE gig_id = $1`, [g.gigId]);
      await q(`UPDATE provider.gigs SET status = 'RETIRED', retired_at = now() WHERE gig_id = $1`, [g.gigId]);
    } finally {
      await q('ALTER TABLE provider.gig_versions ENABLE TRIGGER USER');
      await q('ALTER TABLE provider.gigs ENABLE TRIGGER USER');
    }
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('UPLOAD_PENDING');
    const r = await sweep({ limit: 100 });
    expect(r.abandoned).toBeGreaterThanOrEqual(1);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect(await attachments(await versionId(g.gigId, 1))).toHaveLength(1);
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    const rows = await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED');
    expect(rows.map((x) => [x.actor, x.changes])).toEqual([['system:gig-media-cleanup', { mediaId: a.mediaId, versionNumber: 1, reason: 'GIG_RETIRED' }]]);
    // nothing left to do, and the sweep does not loop on it
    expect((await sweep({ limit: 100 })).abandoned).toBe(0);
  });

  it('a store outage while removing objects leaves the removal unconfirmed (objects_removed_at NULL, objects still there); a healthy second sweep deletes them and records it, a third finds nothing', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    store.put(a.finalKey, png(800, 600, 5000), 'image/png');
    browser(a, png(800, 600, 5000));
    await expire(a.finalKey);
    store.failDelete = true;
    const r1 = await sweep({ limit: 100 });
    expect(r1.abandoned).toBeGreaterThanOrEqual(1);
    const mid = await one<{ status: string; objects_removed_at: Date | null }>(
      'SELECT status, objects_removed_at FROM provider.media_assets WHERE object_key = $1',
      [a.finalKey],
    );
    expect(mid).toMatchObject({ status: 'ABANDONED', objects_removed_at: null });
    expect(store.objects.has(a.finalKey)).toBe(true);
    expect(store.objects.has(a.uploadKey)).toBe(true);
    const warnings = logSink.lines.filter((l) => l.includes('could not delete a gig photo object'));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('UNAVAILABLE');
    expect(logSink.lines.join('\n')).not.toContain('provider/gig-media');
    store.failDelete = false;
    const r2 = await sweep({ limit: 100 });
    expect(r2.reconciled).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(a.finalKey)).toBe(false);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]))
        .objects_removed_at,
    ).toBeInstanceOf(Date);
    expect((await sweep({ limit: 100 })).reconciled).toBe(0);
  });

  it('an orphan READY asset whose objects could not be deleted is retried by the next sweep (DELETED, objects_removed_at NULL until confirmed)', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    setMedia({ orphanGraceSeconds: 0 });
    await expire(a.finalKey);
    store.failDelete = true;
    expect((await sweep({ limit: 100 })).deleted).toBeGreaterThanOrEqual(1);
    expect(await one('SELECT status, objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).toMatchObject({
      status: 'DELETED',
      objects_removed_at: null,
    });
    expect(store.objects.has(a.finalKey)).toBe(true);
    store.failDelete = false;
    await sweep({ limit: 100 });
    expect(store.objects.has(a.finalKey)).toBe(false);
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]))
        .objects_removed_at,
    ).toBeInstanceOf(Date);
  });

  it('a PUT replayed after finalize recreates the upload object; the clean-up removes it once the authorization has ended (the final object is never touched) and records it', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 31);
    const a = await addPhoto(p, g.gigId, g.revision, { bytes });
    const before = await one<{ upload_key_removed_at: Date | null }>('SELECT upload_key_removed_at FROM provider.media_assets WHERE object_key = $1', [
      a.finalKey,
    ]);
    expect(before.upload_key_removed_at).toBeNull(); // the authorization is still valid: not confirmed yet
    store.put(a.uploadKey, png(800, 600, 5000, 32), 'image/png'); // the replay
    // while the authorization is valid the sweep leaves it
    expect((await sweep({ limit: 100 })).reconciled).toBe(0);
    expect(store.objects.has(a.uploadKey)).toBe(true);
    await expire(a.finalKey);
    const r = await sweep({ limit: 100 });
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect((await assetOf(a.mediaId)).status).toBe('READY');
    expect(
      (await one<{ upload_key_removed_at: Date | null }>('SELECT upload_key_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]))
        .upload_key_removed_at,
    ).toBeInstanceOf(Date);
    expect((await sweep({ limit: 100 })).reconciled).toBe(0);
    await assertNoLeaks(g.gigId);
  });

  it('detaching or refusing an upload deletes its objects after the commit, and the removal is recorded only after the authorization has ended (a valid PUT URL could recreate the object)', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    await svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(store.objects.has(a.uploadKey)).toBe(false);
    const row = () => one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]);
    expect((await row()).objects_removed_at).toBeNull();
    browser(a, png(800, 600, 5000, 5)); // the replay
    await sweep({ limit: 100 }); // still within the authorization: deleted again, not confirmed
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await row()).objects_removed_at).toBeNull();
    await expire(a.finalKey);
    await sweep({ limit: 100 });
    expect((await row()).objects_removed_at).toBeInstanceOf(Date);
    // an expired authorization closed at the next authorization is confirmed at once
    const b = await authorize(p, g.gigId, await draftRevision(g.gigId), { fieldKey: 'gallery' });
    await expire(b.finalKey);
    await authorize(p, g.gigId, await draftRevision(g.gigId), { fieldKey: 'gallery' });
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [b.finalKey]))
        .objects_removed_at,
    ).toBeInstanceOf(Date);
  });

  it('authorizations, finalizations and sweeps running together never deadlock: every call ends in success or a stale-revision answer, never a conflict', async () => {
    setMedia({ orphanGraceSeconds: 0 });
    const p = await mkProvider([{ key: 'gallery', max: 20 }]);
    const g = await mkGig(p);
    const outcomes: string[] = [];
    for (let round = 0; round < 4; round++) {
      const rev = await draftRevision(g.gigId);
      const old = await authorize(p, g.gigId, rev, { fieldKey: 'gallery' });
      await expire(old.finalKey);
      const fresh = await authorize(p, g.gigId, await draftRevision(g.gigId), { fieldKey: 'gallery' });
      browser(fresh, png(800, 600, 5000, round));
      const settled = await Promise.allSettled([
        sweep({ limit: 50 }),
        sweep({ limit: 50 }),
        svc.finalizeMedia(p.accountId, g.gigId, fresh.mediaId, { expectedRevision: fresh.revision }),
        svc.requestMediaUpload(p.accountId, g.gigId, {
          expectedRevision: fresh.revision,
          fieldKey: 'gallery',
          mimeType: 'image/png',
          sizeBytes: 5000,
          altText: null,
        }),
      ]);
      for (const r of settled) outcomes.push(r.status === 'fulfilled' ? 'ok' : (r.reason as GigError).code);
    }
    expect(outcomes.filter((o) => o !== 'ok' && o !== 'STALE_DRAFT')).toEqual([]);
    expect(logSink.lines.filter((l) => l.includes('clean-up step failed'))).toEqual([]);
  });

  it('a busy provider (account row locked) is skipped, not waited for', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    await expire(a.finalKey);
    const holder = await rawTx();
    await holder.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [p.accountId]);
    const t0 = Date.now();
    const r = await sweep({ limit: 100 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('UPLOAD_PENDING');
    await holder.rollback();
    expect(r.abandoned).toBe(0);
    await sleep(1);
    expect((await sweep({ limit: 100 })).abandoned).toBeGreaterThanOrEqual(1);
  });
});

// ====================================================================== 7. fix wave 1: races, clocks, store failures, one-statement reorder, retire primitives
describe('hardening', () => {
  it('the loser of a double finalize (the winner finished and deleted the upload object while it was looking) gets the detail of the READY photo, never MEDIA_REFUSED, and nothing is abandoned', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 41);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, bytes);
    store.beforeHead = async (key) => {
      if (key !== a.uploadKey) return;
      store.beforeHead = undefined;
      await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }); // the winner
    };
    const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(d)).toEqual([expect.objectContaining({ mediaId: a.mediaId, status: 'READY' })]);
    expect((await audits(g.gigId, 'GIG_MEDIA_UPLOAD_REFUSED')).length).toBe(0);
    expect((await audits(g.gigId, 'GIG_MEDIA_ATTACHED')).length).toBe(1);
    expect((await assetOf(a.mediaId)).status).toBe('READY');
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
  });

  it("a loser whose own copy overwrote the winner's final object with different bytes is reported by a counts-only warning (the integrity window is accepted debt)", async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000, 51));
    // between the loser's last look at the asset and its commit the winner finishes; the final object then holds other bytes than the winner recorded
    let armed = true;
    const original = store.read.bind(store);
    store.read = async (key, max) => {
      const r = await original(key, max);
      if (armed && key === a.finalKey) {
        armed = false;
        await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }); // the winner commits READY with ITS bytes
        store.put(a.finalKey, png(800, 600, 5000, 52), 'image/png'); // and a replayed PUT promoted by another finalization replaces the final object
      }
      return r;
    };
    try {
      const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
      expect(mediaOf(d)[0]!.status).toBe('READY');
    } finally {
      store.read = original;
    }
    expect(logSink.lines.some((l) => l.includes('differs from its recorded hash') && l.includes('"mismatches":1'))).toBe(true);
    expect(logSink.lines.join('\n')).not.toContain('provider/gig-media');
  });

  it('a store failure while signing the upload URL is the typed UNAVAILABLE (MEDIA_STORE_UNAVAILABLE), happens before any transaction and writes nothing', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const assetsBefore = (await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.media_assets')).n;
    for (const failure of [new Error('boom'), new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable'), new TypeError('x')]) {
      store.failSign = failure;
      const e = await expectError(authorize(p, g.gigId, g.revision), 'UNAVAILABLE', 'MEDIA_STORE_UNAVAILABLE');
      expect(JSON.stringify(e.details) + e.message).not.toContain('boom');
    }
    store.failSign = undefined;
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM provider.media_assets')).n).toBe(assetsBefore);
    expect(await draftRevision(g.gigId)).toBe(g.revision);
    expect(logSink.lines.join('\n')).not.toContain('boom');
  });

  describe('time is the database clock', () => {
    const skewed = (offsetMs: number) => {
      const own = new TestStore(() => new Date(Date.now() + offsetMs));
      const service = new ProviderGigService({
        database: iso.database,
        accounts: new FakeAccounts(iso.database),
        templates: new FakeTemplates(iso.database),
        policy: policyProvider,
        store: own,
        scanner,
      });
      return { own, service };
    };
    const authorizeVia = async (service: ProviderGigService, p: Provider, gigId: string, revision: number) => {
      const r = await service.requestMediaUpload(p.accountId, gigId, {
        expectedRevision: revision,
        fieldKey: 'photos',
        mimeType: 'image/png',
        sizeBytes: 5000,
        altText: null,
      });
      const finalKey = (
        await one<{ object_key: string }>(
          `SELECT a.object_key FROM provider.gig_version_media m JOIN provider.media_assets a USING (media_asset_id) WHERE m.gig_version_media_id = $1`,
          [r.upload.media.mediaId],
        )
      ).object_key;
      return { r, finalKey, uploadKey: `${finalKey}.upload` };
    };
    const windowOk = async (finalKey: string) =>
      (
        await one<{ ok: boolean }>(
          `SELECT upload_expires_at BETWEEN now() + make_interval(secs => $2 - 20) AND now() + make_interval(secs => $2 + 20) AS ok FROM provider.media_assets WHERE object_key = $1`,
          [finalKey, DEFAULT_GIG_MEDIA_POLICY.uploadTtlSeconds],
        )
      ).ok;

    it('an object store whose clock is a day BEHIND does not make a fresh authorization look expired', async () => {
      const { own, service } = skewed(-86_400_000);
      const p = await mkProvider();
      const g = await mkGig(p);
      const a = await authorizeVia(service, p, g.gigId, g.revision);
      expect(new Date(a.r.upload.upload.expiresAt).getTime()).toBeLessThan(Date.now()); // the store's own (wrong) idea
      expect(await windowOk(a.finalKey)).toBe(true); // the authorization window is the database's
      own.put(a.uploadKey, png(800, 600, 5000, 61), 'image/png');
      const d = await service.finalizeMedia(p.accountId, g.gigId, a.r.upload.media.mediaId, { expectedRevision: a.r.upload.revision });
      expect(mediaOf(d)[0]!.status).toBe('READY');
    });

    it('an object store whose clock is a day AHEAD does not keep an expired authorization alive', async () => {
      const { own, service } = skewed(86_400_000);
      const p = await mkProvider();
      const g = await mkGig(p);
      const a = await authorizeVia(service, p, g.gigId, g.revision);
      expect(await windowOk(a.finalKey)).toBe(true);
      own.put(a.uploadKey, png(800, 600, 5000, 62), 'image/png');
      await expireAsset(a.finalKey); // the database clock says it ended
      await expectError(service.finalizeMedia(p.accountId, g.gigId, a.r.upload.media.mediaId, { expectedRevision: a.r.upload.revision }), 'MEDIA_EXPIRED');
    });
  });

  it('reorder is ONE statement on the attachments (no parked rows), swaps and reversals included', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const b = await addPhoto(p, g.gigId, a.revision);
    const c = await addPhoto(p, g.gigId, b.revision);
    const mark = statements.length;
    const d = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: c.revision, mediaIds: [c.mediaId, b.mediaId, a.mediaId] });
    expect(mediaOf(d).map((m) => [m.mediaId, m.displayOrder])).toEqual([
      [c.mediaId, 1],
      [b.mediaId, 2],
      [a.mediaId, 3],
    ]);
    const updates = statements.slice(mark).filter((s) => /update\s+provider\.gig_version_media/i.test(s));
    expect(updates).toHaveLength(1);
    expect(
      (
        await q<{ n: number }>(
          `SELECT max(display_order)::int AS n FROM provider.gig_version_media m JOIN provider.gig_versions v USING (gig_version_id) WHERE v.gig_id = $1`,
          [g.gigId],
        )
      )[0]!.n,
    ).toBe(3);
    const swapped = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: d.draftVersion!.revision, mediaIds: [b.mediaId, c.mediaId, a.mediaId] });
    expect(mediaOf(swapped).map((m) => m.mediaId)).toEqual([b.mediaId, c.mediaId, a.mediaId]);
  });

  it("closePendingMediaOfDraft (the retire primitive) closes only the unfinished uploads of the draft inside the caller's transaction and returns the keys; deleteMediaObjects is idempotent, best effort and marks nothing", async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const ready = await addPhoto(p, g.gigId, g.revision);
    const x = await authorize(p, g.gigId, ready.revision, { fieldKey: 'gallery' });
    const y = await authorize(p, g.gigId, x.revision, { fieldKey: 'gallery' });
    browser(x, png(800, 600, 5000));
    const versionIdOfDraft = await draftId(g.gigId);
    let keys: string[] = [];
    await iso.database.transaction(async (trx) => {
      keys = await closePendingMediaOfDraft(trx, { accountId: p.accountId, gigId: g.gigId, versionId: versionIdOfDraft, cid: 'cid-retire-1' });
    });
    expect([...keys].sort()).toEqual([x.finalKey, x.uploadKey, y.finalKey, y.uploadKey].sort());
    expect((await attachments(versionIdOfDraft)).map((r) => r.gig_version_media_id)).toEqual([ready.mediaId]);
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [x.finalKey])).status).toBe('ABANDONED');
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [y.finalKey])).status).toBe('ABANDONED');
    expect((await assetOf(ready.mediaId)).status).toBe('READY');
    const refused = await q<{ changes: Record<string, unknown>; correlation_id: string }>(
      `SELECT changes, correlation_id FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_MEDIA_UPLOAD_REFUSED' ORDER BY audit_event_id`,
      [g.gigId],
    );
    const byMedia = (l: { mediaId: string }, r: { mediaId: string }) => l.mediaId.localeCompare(r.mediaId);
    expect(refused.map((r) => r.changes as { mediaId: string }).sort(byMedia)).toEqual(
      [
        { mediaId: x.mediaId, versionNumber: 1, reason: 'GIG_RETIRED' },
        { mediaId: y.mediaId, versionNumber: 1, reason: 'GIG_RETIRED' },
      ].sort(byMedia),
    );
    expect(refused.map((r) => r.correlation_id)).toEqual(['cid-retire-1', 'cid-retire-1']);
    // nothing is deleted by the primitive itself; the caller does it after the commit
    expect(store.objects.has(x.uploadKey)).toBe(true);
    expect(await deleteMediaObjects(store, keys)).toBe(true);
    expect(await deleteMediaObjects(store, keys)).toBe(true); // idempotent
    expect(store.objects.has(x.uploadKey)).toBe(false);
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [x.finalKey]))
        .objects_removed_at,
    ).toBeNull();
    // a failing store is reported, never thrown, with counts only
    logSink.lines.length = 0;
    store.failDelete = true;
    expect(await deleteMediaObjects(store, keys)).toBe(false);
    expect(logSink.lines.join('\n')).not.toContain('provider/gig-media');
    expect(logSink.lines.some((l) => l.includes('"failed":4') && l.includes('"total":4'))).toBe(true);
    // nothing pending: nothing returned
    store.failDelete = false;
    await iso.database.transaction(async (trx) => {
      expect(await closePendingMediaOfDraft(trx, { accountId: p.accountId, gigId: g.gigId, versionId: versionIdOfDraft, cid: 'cid-retire-2' })).toEqual([]);
    });
  });

  it('the reconciliation after a retire: the sweep records the removal of the objects the retire deleted without marking', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    await svc.retire(p.accountId, g.gigId, {});
    await expireAsset(a.finalKey);
    expect((await sweep({ limit: 100 })).reconciled).toBeGreaterThanOrEqual(1);
    expect(
      (await one<{ objects_removed_at: Date | null }>('SELECT objects_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]))
        .objects_removed_at,
    ).toBeInstanceOf(Date);
  });
});

// ====================================================================== CAT-004 test-hardening additions (found by mutation testing)
// Each case below fails on a specific mutant of gig-media.ts / gig-media-model.ts that the suite above let survive (boundaries, promotion integrity, ownership, revisions, markers).
describe('mutation-testing additions: boundaries, promotion integrity, ownership, revisions and markers', () => {
  const finalizeWith = async (policy: Partial<ProviderGigMediaPolicy>, w: number, h: number) => {
    setMedia(policy);
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(w, h, 5000));
    return { p, g, a, run: () => svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }) };
  };

  it.each([
    ['exactly the minimum edge on both sides', {}, 200, 200],
    ['exactly the maximum edge (and a pixel count inside the maximum)', { maxEdgePixels: 3000 }, 3000, 3000],
    ['exactly the maximum pixel count', { maxPixels: 640_000 }, 800, 800],
  ] as const)('accepts the boundary value: %s', async (_what, policy, w, h) => {
    const t = await finalizeWith(policy, w, h);
    const d = await t.run();
    expect(mediaOf(d)[0]).toMatchObject({ status: 'READY', width: w, height: h });
  });

  it.each([
    ['the width is one pixel under the minimum', {}, 199, 800, 'IMAGE_TOO_SMALL'],
    ['the HEIGHT is one pixel under the minimum while the width is fine', {}, 800, 199, 'IMAGE_TOO_SMALL'],
    ['the width is one pixel over the maximum edge', { maxEdgePixels: 3000 }, 3001, 300, 'IMAGE_TOO_LARGE'],
    ['the HEIGHT is one pixel over the maximum edge while the width is fine', { maxEdgePixels: 3000 }, 300, 3001, 'IMAGE_TOO_LARGE'],
    ['one pixel more than the maximum pixel count', { maxPixels: 640_000 }, 800, 801, 'IMAGE_TOO_LARGE'],
  ] as const)('refuses just outside the boundary: %s', async (_what, policy, w, h, reason) => {
    const t = await finalizeWith(policy, w, h);
    await expectError(t.run(), 'MEDIA_REFUSED', reason);
    expect((await assetOf(t.a.mediaId).catch(() => undefined)) ?? null).toBeNull(); // the attachment left the draft
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [t.a.finalKey])).status).toBe('ABANDONED');
  });

  it('authorizes a file of exactly the configured maximum size and refuses one byte more', async () => {
    setMedia({ maxFileSizeBytes: 5000 });
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision, { sizeBytes: 5000 });
    expect((await assetOf(a.mediaId)).size_bytes).toBe('5000');
    await expectError(
      svc.requestMediaUpload(p.accountId, g.gigId, { expectedRevision: a.revision, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5001, altText: null }),
      'MEDIA_REFUSED',
      'FILE_TOO_LARGE',
    );
  });

  it('re-reads what landed at the final key: a store that corrupts the promotion copy gets OBJECT_CHANGED, nothing becomes READY and no object stays', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000, 91));
    store.corruptCopy = true;
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'OBJECT_CHANGED');
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    await assertNoLeaks(g.gigId);
  });

  it('maps a store CHANGED or TOO_LARGE while reading the upload object to OBJECT_CHANGED / SIZE_MISMATCH refusals (not an outage)', async () => {
    for (const [code, reason] of [
      ['CHANGED', 'OBJECT_CHANGED'],
      ['TOO_LARGE', 'SIZE_MISMATCH'],
    ] as const) {
      const p = await mkProvider();
      const g = await mkGig(p);
      const a = await authorize(p, g.gigId, g.revision);
      browser(a, png(800, 600, 5000));
      store.afterRead = () => {
        throw new ObjectStoreError(code, 'simulated');
      };
      await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', reason);
      store.afterRead = undefined;
      expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    }
  });

  it('an object swapped for a SMALLER one between the head and the read is a SIZE_MISMATCH (the size is checked on the bytes that were read, not only on the head)', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision, { sizeBytes: 5000 });
    browser(a, png(800, 600, 5000, 95));
    store.afterHead = (key) => {
      if (key === a.uploadKey) store.put(a.uploadKey, png(800, 600, 3000, 96), 'image/png');
    };
    await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'MEDIA_REFUSED', 'SIZE_MISMATCH');
    expect((await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey])).status).toBe('ABANDONED');
    expect([...store.objects.keys()].filter((k) => k.startsWith(a.finalKey))).toEqual([]);
    expect(scanner.scans).toBe(0);
  });

  it('a finalization or an authorization racing the retire of the Gig ends typed and consistent: no unfinished upload stays attached to a retired version, no untyped failure', async () => {
    const p = await mkProvider();
    const allowed = ['STALE_DRAFT', 'GIG_RETIRED', 'NO_DRAFT', 'MEDIA_NOT_FOUND', 'MEDIA_REFUSED', 'ACCOUNT_NOT_ACTIVE'];
    for (let i = 0; i < 6; i++) {
      const g = await mkGig(p);
      const a = await authorize(p, g.gigId, g.revision);
      browser(a, png(800, 600, 5000, 200 + i));
      const results = await Promise.allSettled([
        svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
        svc.requestMediaUpload(p.accountId, g.gigId, {
          expectedRevision: a.revision,
          fieldKey: 'gallery',
          mimeType: 'image/png',
          sizeBytes: 5000,
          altText: null,
        }),
        svc.retire(p.accountId, g.gigId, {}),
      ]);
      for (const r of results)
        if (r.status === 'rejected') {
          expect(r.reason, String(r.reason)).toBeInstanceOf(GigError);
          expect(allowed, JSON.stringify((r.reason as GigError).details)).toContain((r.reason as GigError).code);
        }
      expect(results[2]!.status, 'retire always succeeds').toBe('fulfilled');
      const stuck = await q(
        `SELECT a.media_asset_id FROM provider.media_assets a JOIN provider.gig_version_media m USING (media_asset_id) JOIN provider.gig_versions v USING (gig_version_id)
          WHERE v.gig_id = $1 AND a.status = 'UPLOAD_PENDING'`,
        [g.gigId],
      );
      expect(stuck, 'an unfinished upload attached to a version of the retired Gig').toEqual([]);
    }
  });

  it('records the removal of the upload object only after it was really deleted (finalize and the sweep), both with a store that fails every deletion', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const bytes = png(800, 600, 5000, 92);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, bytes);
    store.failDelete = true;
    const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision });
    expect(mediaOf(d)[0]!.status).toBe('READY');
    const marker = () =>
      one<{ upload_key_removed_at: Date | null }>('SELECT upload_key_removed_at FROM provider.media_assets WHERE object_key = $1', [a.finalKey]);
    expect(store.objects.has(a.uploadKey)).toBe(true);
    expect((await marker()).upload_key_removed_at).toBeNull();
    await expireAsset(a.finalKey);
    await sweep({ limit: 100 }); // still failing: the object stays and so does the NULL marker
    expect(store.objects.has(a.uploadKey)).toBe(true);
    expect((await marker()).upload_key_removed_at).toBeNull();
    store.failDelete = false;
    await sweep({ limit: 100 });
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await marker()).upload_key_removed_at).toBeInstanceOf(Date);
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true);
  });

  it('a media id of a PUBLISHED version or of another Gig of the same account is "not found" for finalize, detach, alt text and preview, and nothing of it changes', async () => {
    const p = await mkProvider();
    const g1 = await mkGig(p);
    const a1 = await addPhoto(p, g1.gigId, g1.revision);
    const saved = await svc.updateDraft(p.accountId, g1.gigId, { expectedRevision: a1.revision, ...editable() });
    await svc.publish(p.accountId, g1.gigId, { expectedRevision: saved.draftVersion!.revision });
    const next = (await svc.createNextDraft(p.accountId, g1.gigId, {})).draftVersion!;
    // v1's attachment id, asked through the v2 draft routes
    const v1Media = (
      await q<{ gig_version_media_id: string }>('SELECT gig_version_media_id FROM provider.gig_version_media WHERE gig_version_id = $1', [
        await versionId(g1.gigId, 1),
      ])
    )[0]!.gig_version_media_id;
    await expectError(svc.finalizeMedia(p.accountId, g1.gigId, v1Media, { expectedRevision: next.revision }), 'MEDIA_NOT_FOUND');
    await expectError(svc.updateMedia(p.accountId, g1.gigId, v1Media, { expectedRevision: next.revision, altText: 'x' }), 'MEDIA_NOT_FOUND');
    await expectError(svc.detachMedia(p.accountId, g1.gigId, v1Media, { expectedRevision: next.revision }), 'MEDIA_NOT_FOUND');
    expect((await attachments(await versionId(g1.gigId, 1))).length).toBe(1);
    expect(await draftRevision(g1.gigId)).toBe(next.revision);

    // an unfinished upload of ANOTHER Gig of the same account
    const g2 = await mkGig(p);
    const a2 = await authorize(p, g2.gigId, g2.revision);
    browser(a2, png(800, 600, 5000, 93));
    const scans = scanner.scans;
    await expectError(svc.finalizeMedia(p.accountId, g1.gigId, a2.mediaId, { expectedRevision: next.revision }), 'MEDIA_NOT_FOUND');
    await expectError(svc.detachMedia(p.accountId, g1.gigId, a2.mediaId, { expectedRevision: next.revision }), 'MEDIA_NOT_FOUND');
    await expectError(svc.updateMedia(p.accountId, g1.gigId, a2.mediaId, { expectedRevision: next.revision, altText: 'x' }), 'MEDIA_NOT_FOUND');
    await expectError(svc.previewMedia(p.accountId, g1.gigId, null, a2.mediaId), 'MEDIA_NOT_FOUND');
    expect(scanner.scans).toBe(scans); // nothing of the other Gig was even read
    expect((await assetOf(a2.mediaId)).status).toBe('UPLOAD_PENDING');
    expect(store.objects.has(a2.uploadKey)).toBe(true);
    expect(await draftRevision(g2.gigId)).toBe(a2.revision);
  });

  it('a revision that moves while the bytes are being scanned is STALE_DRAFT (not a success): the asset stays pending and the same call succeeds with the new revision', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000, 94));
    const original = scanner.scan;
    scanner.scan = async (...args: Parameters<typeof original>) => {
      scanner.scan = original;
      // a second authorization of the same draft moves the revision under the finalization
      await svc.requestMediaUpload(p.accountId, g.gigId, {
        expectedRevision: a.revision,
        fieldKey: 'gallery',
        mimeType: 'image/png',
        sizeBytes: 5000,
        altText: null,
      });
      return original.apply(scanner, args);
    };
    try {
      await expectError(svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }), 'STALE_DRAFT');
    } finally {
      scanner.scan = original;
    }
    expect((await assetOf(a.mediaId)).status).toBe('UPLOAD_PENDING');
    const d = await svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision + 1 });
    expect(mediaOf(d).find((m) => m.mediaId === a.mediaId)!.status).toBe('READY');
  });

  it('detaching an UNFINISHED upload raises the revision by exactly 1 and audits it; reordering renumbers a list with a gap (and a no-op on a gapless list does not)', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const pending = await authorize(p, g.gigId, g.revision);
    const detached = await svc.detachMedia(p.accountId, g.gigId, pending.mediaId, { expectedRevision: pending.revision });
    expect(detached.draftVersion!.revision).toBe(pending.revision + 1);
    expect((await audits(g.gigId, 'GIG_MEDIA_DETACHED')).map((r) => r.changes)).toEqual([
      { mediaId: pending.mediaId, versionNumber: 1, abandoned: true, revision: [pending.revision, pending.revision + 1] },
    ]);
    const a = await addPhoto(p, g.gigId, detached.draftVersion!.revision);
    const b = await addPhoto(p, g.gigId, a.revision);
    const c = await addPhoto(p, g.gigId, b.revision);
    const gap = await svc.detachMedia(p.accountId, g.gigId, b.mediaId, { expectedRevision: c.revision });
    expect(mediaOf(gap).map((m) => m.displayOrder)).toEqual([1, 3]); // the survivors keep their places: a gap
    const renumbered = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: gap.draftVersion!.revision, mediaIds: [a.mediaId, c.mediaId] });
    expect(mediaOf(renumbered).map((m) => m.displayOrder)).toEqual([1, 2]);
    expect(renumbered.draftVersion!.revision).toBe(gap.draftVersion!.revision + 1);
    const again = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: renumbered.draftVersion!.revision, mediaIds: [a.mediaId, c.mediaId] });
    expect(again.draftVersion!.revision).toBe(renumbered.draftVersion!.revision);
  });

  it('the next draft keeps the (reordered) photo order of the published version, with gaps closed up', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision, { altText: 'a' });
    const b = await addPhoto(p, g.gigId, a.revision, { fieldKey: 'gallery', altText: 'b' });
    const c = await addPhoto(p, g.gigId, b.revision, { altText: 'c' });
    const dropped = await svc.detachMedia(p.accountId, g.gigId, b.mediaId, { expectedRevision: c.revision }); // orders 1, 3
    const reordered = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: dropped.draftVersion!.revision, mediaIds: [c.mediaId, a.mediaId] });
    const extra = await addPhoto(p, g.gigId, reordered.draftVersion!.revision, { fieldKey: 'gallery', altText: 'd' });
    const order2 = await svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: extra.revision, mediaIds: [extra.mediaId, c.mediaId, a.mediaId] });
    const saved = await svc.updateDraft(p.accountId, g.gigId, { expectedRevision: order2.draftVersion!.revision, ...editable() });
    await svc.publish(p.accountId, g.gigId, { expectedRevision: saved.draftVersion!.revision });
    const v2 = (await svc.createNextDraft(p.accountId, g.gigId, {})).draftVersion!;
    expect(v2.media.map((m) => [m.displayOrder, m.altText])).toEqual([
      [1, 'd'],
      [2, 'c'],
      [3, 'a'],
    ]);
  });

  it('never gives a preview of an unfinished upload, even when clean scans are not required', async () => {
    setMedia({ requireCleanScan: false });
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await authorize(p, g.gigId, g.revision);
    browser(a, png(800, 600, 5000));
    store.put(a.finalKey, png(800, 600, 5000), 'image/png');
    await expectError(svc.previewMedia(p.accountId, g.gigId, null, a.mediaId), 'MEDIA_NOT_FOUND');
    expect(store.issued.filter((i) => i.kind === 'download')).toEqual([]);
  });

  it('the sweep clamps its batch limit: a huge limit does not break the statements and a zero limit still does one unit of work per pass', async () => {
    await sweep({ limit: 1000 });
    const p = await mkProvider([{ key: 'gallery', max: 5 }]);
    const g = await mkGig(p);
    let rev = g.revision;
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await authorize(p, g.gigId, rev, { fieldKey: 'gallery' });
      rev = a.revision;
      keys.push(a.finalKey);
    }
    for (const k of keys) await expireAsset(k);
    expect((await sweep({ limit: 0 })).abandoned).toBe(1);
    expect((await sweep({ limit: 5_000_000_000 })).abandoned).toBe(1);
  });

  it('a finalization racing a detach of the same upload ends in exactly one winner and a consistent state (never a READY asset without its attachment, never a crash)', async () => {
    const p = await mkProvider();
    for (let i = 0; i < 6; i++) {
      const g = await mkGig(p);
      const a = await authorize(p, g.gigId, g.revision);
      browser(a, png(800, 600, 5000, 100 + i));
      const [fin, det] = await Promise.allSettled([
        svc.finalizeMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
        svc.detachMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: a.revision }),
      ]);
      for (const r of [fin, det])
        if (r.status === 'rejected') {
          expect(r.reason, String(r.reason)).toBeInstanceOf(GigError);
          expect(['STALE_DRAFT', 'MEDIA_NOT_FOUND', 'MEDIA_REFUSED']).toContain((r.reason as GigError).code);
        }
      const asset = await one<AssetDb>('SELECT * FROM provider.media_assets WHERE object_key = $1', [a.finalKey]);
      const attached = (await attachments(await draftId(g.gigId))).length;
      if (asset.status === 'READY') expect(attached, 'a READY asset keeps its attachment').toBe(1);
      else {
        expect(asset.status).toBe('ABANDONED');
        expect(attached).toBe(0);
      }
      if (det.status === 'fulfilled') expect(asset.status).toBe('ABANDONED');
      expect(fin.status === 'fulfilled' && det.status === 'fulfilled', 'both cannot win').toBe(false);
    }
  });

  it('two edits at the same revision (alt text and reorder) end in one success and one STALE_DRAFT; the revision rises by exactly 1', async () => {
    const p = await mkProvider();
    const g = await mkGig(p);
    const a = await addPhoto(p, g.gigId, g.revision);
    const b = await addPhoto(p, g.gigId, a.revision);
    const [x, y] = await Promise.allSettled([
      svc.updateMedia(p.accountId, g.gigId, a.mediaId, { expectedRevision: b.revision, altText: 'first' }),
      svc.reorderMedia(p.accountId, g.gigId, { expectedRevision: b.revision, mediaIds: [b.mediaId, a.mediaId] }),
    ]);
    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected']);
    const lost = (x.status === 'rejected' ? x : y) as PromiseRejectedResult;
    expect((lost.reason as GigError).code).toBe('STALE_DRAFT');
    expect(await draftRevision(g.gigId)).toBe(b.revision + 1);
  });
});
