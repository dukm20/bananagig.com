// Service integration tests of TrustService (TRUST-001) over a real, freshly migrated PostgreSQL database (migration 0019 with its guard triggers and seeds).
//
// Written by an author who did not write the service. Everything is asserted against the rows the database holds (cases, requirement instances, documents, reviews, external
// references, the trust audit trail, the outbox), never against the service's own return value alone. Domain packages never import each other, so the ports the service needs are
// fakes that live here: a ProviderContextPort the test controls per account, a spying private object store (MemoryObjectStore plays the uploader with `put`), a scripted scanner
// and a spying external verification provider. The seeded policy values are the ones migration 0019 writes to configuration.
// "Worlds": every test builds its own market, service types and account, and (through the service's own admin API) the rules that make the market require insurance, a licence
// or a background check, so tests never share state even though the policy tables are global.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRUST_EVENTS, TRUST_POLICY_KEYS, type TrustDocumentPolicy } from '@bananagig/contracts';
import { type Database } from '@bananagig/database';
import { MemoryObjectStore, ObjectStoreError, type PrivateObjectStore } from '@bananagig/platform';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  DisabledEvidenceScanner,
  EICAR_TEST_STRING,
  FakeEvidenceScanner,
  FakeVerificationProvider,
  StaticTrustPolicyProvider,
  TrustError,
  TrustService,
  deriveStatus,
  parseTrustPolicy,
  type DocumentView,
  type EvidenceScanner,
  type ExternalVerificationRequest,
  type ProviderContext,
  type ProviderContextPort,
  type ScanInput,
  type ScanResult,
  type VerificationProvider,
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
const PHONE_CANARY = '+15550004321';
const NAME_CANARY = 'Zelda';

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const statements: string[] = [];
let transactionsOpened = 0;
const K = TRUST_POLICY_KEYS;
/** The values migration 0019 seeds into configuration. */
const SEEDED = {
  [K.maxSizeBytes]: 10_485_760,
  [K.allowedMimeTypes]: ['application/pdf', 'image/jpeg', 'image/png'],
  [K.maxDocumentsPerRequirement]: 5,
  [K.uploadUrlTtlSeconds]: 300,
  [K.downloadUrlTtlSeconds]: 60,
  [K.requireCleanScan]: true,
};
const POLICY: TrustDocumentPolicy = parseTrustPolicy(SEEDED);

class FakeContext implements ProviderContextPort {
  private readonly map = new Map<string, ProviderContext | null>();
  calls = 0;
  set(accountId: string, ctx: ProviderContext | null): void {
    this.map.set(accountId, ctx);
  }
  get(accountId: string): ProviderContext {
    return this.map.get(accountId)!;
  }
  async context(accountId: string): Promise<ProviderContext | null> {
    this.calls++;
    return this.map.has(accountId) ? this.map.get(accountId)! : null;
  }
}
const ctxPort = new FakeContext();

/** The memory store plus a record of every call and of the calls made while a transaction was open. */
class SpyStore extends MemoryObjectStore {
  calls: string[] = [];
  inTx: string[] = [];
  private note(op: string): void {
    this.calls.push(op);
    if (iso.database.inTransaction) this.inTx.push(op);
  }
  override async head(key: string) {
    this.note('head');
    return super.head(key);
  }
  override async read(key: string, maxBytes: number) {
    this.note('read');
    return super.read(key, maxBytes);
  }
  override async delete(key: string) {
    this.note('delete');
    return super.delete(key);
  }
  /** Runs just before a download link is created (to observe what is committed at that moment). */
  beforeDownload: (() => Promise<void>) | undefined;
  failDownload = false;
  override async createDownloadUrl(r: Parameters<MemoryObjectStore['createDownloadUrl']>[0]) {
    this.note('createDownloadUrl');
    if (this.beforeDownload) await this.beforeDownload();
    if (this.failDownload) throw new Error('store down');
    return super.createDownloadUrl(r);
  }
  count(op: string): number {
    return this.calls.filter((c) => c === op).length;
  }
}
const store = new SpyStore();

/** A store whose versioned read, promote and deletes can be intercepted: the races and failures of the upload-key promotion are played here. */
class RaceStore extends SpyStore {
  /** Runs after the versioned read of the UPLOAD object returned its bytes and version (the uploader replays its PUT now). */
  afterRead: ((key: string) => void) | undefined;
  beforeCopy: ((from: string, to: string) => void) | undefined;
  afterCopy: ((from: string, to: string) => void) | undefined;
  readError: Error | undefined;
  copyError: Error | undefined;
  /** Makes the object disappear between the HEAD and the versioned read. */
  vanishOnRead = false;
  failDeleteOf: ((key: string) => boolean) | undefined;
  override async readVersioned(key: string, maxBytes: number) {
    if (this.readError) throw this.readError;
    if (this.vanishOnRead) this.objects.delete(key);
    const r = await super.readVersioned(key, maxBytes);
    this.afterRead?.(key);
    return r;
  }
  override async copyIfVersion(from: string, to: string, version: string) {
    if (this.copyError) throw this.copyError;
    this.beforeCopy?.(from, to);
    await super.copyIfVersion(from, to, version);
    this.afterCopy?.(from, to);
  }
  override async delete(key: string) {
    if (this.failDeleteOf?.(key)) throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    return super.delete(key);
  }
}

class ScriptedScanner implements EvidenceScanner {
  mode: 'fake' | 'error' | 'throw' = 'fake';
  calls = 0;
  inTx = 0;
  private readonly fake = new FakeEvidenceScanner();
  async scan(i: ScanInput): Promise<ScanResult> {
    this.calls++;
    if (iso.database.inTransaction) this.inTx++;
    if (this.mode === 'throw') throw new Error('scanner down');
    if (this.mode === 'error') return { status: 'ERROR' };
    return this.fake.scan(i);
  }
}
const scanner = new ScriptedScanner();

class SpyVerification extends FakeVerificationProvider {
  requests: ExternalVerificationRequest[] = [];
  cancelled: string[] = [];
  created: string[] = [];
  inTx = 0;
  override async create(r: ExternalVerificationRequest) {
    if (iso.database.inTransaction) this.inTx++;
    this.requests.push(r);
    const out = await super.create(r);
    this.created.push(out.externalId);
    return out;
  }
  override async status(externalId: string) {
    if (iso.database.inTransaction) this.inTx++;
    return super.status(externalId);
  }
  override async cancel(externalId: string) {
    this.cancelled.push(externalId);
    return super.cancel(externalId);
  }
}
const ext = new SpyVerification();

interface Mk {
  store?: PrivateObjectStore;
  policy?: Partial<TrustDocumentPolicy>;
  scanner?: EvidenceScanner | null;
  external?: VerificationProvider | null;
  now?: () => Date;
}
const mk = (o: Mk = {}): TrustService => {
  const deps: ConstructorParameters<typeof TrustService>[0] = {
    database: iso.database as Database,
    context: ctxPort,
    policy: new StaticTrustPolicyProvider({ ...POLICY, ...o.policy }),
    store: o.store ?? store,
  };
  if (o.scanner !== null) deps.scanner = o.scanner ?? scanner;
  if (o.external !== null) deps.external = o.external ?? ext;
  if (o.now) deps.now = o.now;
  return new TrustService(deps);
};
let svc: TrustService;
let svcLenient: TrustService; // requireCleanScan = false
let svcFuture: TrustService; // its clock is 10 minutes ahead
let svcDefaults: TrustService; // no scanner and no external provider: the fail-closed production defaults
let svcMax2: TrustService; // 2 documents per requirement, 120 s upload links, 30 s download links

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      overrides: { poolMax: 40, connectionTimeoutMs: 30_000 },
      onQuery: (e) => statements.push(e.sql),
      onTransaction: () => {
        transactionsOpened++;
      },
    },
  });
  pool = createTestPool(iso.url, 10);
  svc = mk();
  svcLenient = mk({ policy: { requireCleanScan: false } });
  svcFuture = mk({ now: () => new Date(Date.now() + 10 * 60_000) });
  svcDefaults = mk({ scanner: null, external: null });
  as = asyncify(svc);
  asLenient = asyncify(svcLenient);
  svcMax2 = mk({ policy: { maxDocumentsPerRequirement: 2, uploadUrlTtlSeconds: 120, downloadUrlTtlSeconds: 30 } });
  // the three optional requirement definitions are seeded INACTIVE; the tests switch them on per market through rules
  for (const code of ['background_check', 'professional_license', 'liability_insurance']) await svc.setRequirementStatus('root', code, { status: 'ACTIVE' });
});
afterEach(async () => {
  scanner.mode = 'fake';
  store.beforeDownload = undefined;
  store.failDownload = false;
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
const failAudit = (action: string) => failInsert('trust.audit_events', `NEW.action = '${action}'`);
const failEvent = (eventType: string) => failInsert('integration.outbox_events', `NEW.event_type = '${eventType}'`);
/** Runs `fn` with the user triggers of the given tables disabled (a crafted state the guards would refuse), always restoring them. */
async function withoutTriggers<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}

// ---------------------------------------------------------------- builders
let seq = 0;
const nextSeq = (): number => ++seq;
/** An ACTIVE account with a verified email and phone and a core profile, by plain SQL, as the identity domain leaves them. */
async function mkAccount(status: 'ACTIVE' | 'PENDING' = 'ACTIVE'): Promise<string> {
  const n = nextSeq();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status])).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, $2, 'test', 'test')",
      [id, status],
    );
    await c.query("INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, $2, 'Tester')", [id, NAME_CANARY]);
    await c.query(
      `INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())`,
      [id, `${EMAIL_CANARY}.${n}@example.test`],
    );
    const phone = (
      await c.query(
        `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED') RETURNING phone_contact_id`,
        [id, `${PHONE_CANARY}${String(n).padStart(3, '0')}`],
      )
    ).rows[0].phone_contact_id as string;
    await c.query(`UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE phone_contact_id = $1`, [phone]);
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
    await c.query(`UPDATE identity.accounts SET status = $2, updated_at = now() WHERE account_id = $1`, [accountId, to]);
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
/** An ACTIVE market whose window is in force, copied from a seeded one. */
async function mkMarket(): Promise<string> {
  const c = `devtest-t${nextSeq()}`;
  await q(
    `WITH m AS (
       INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from, effective_to)
       SELECT $1, 'Test market', country_id, 'PLANNED', default_locale, currency_code, default_time_zone_id, now() - interval '1 day', NULL FROM geography.markets WHERE code = 'la-oc'
       RETURNING market_id, country_id, default_locale)
     INSERT INTO geography.market_locales (market_id, country_id, locale) SELECT market_id, country_id, default_locale FROM m`,
    [c],
  );
  await q("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = $1", [c]);
  return c;
}
/** A category, ACTIVE and enabled in the market, with `n` ACTIVE service types enabled there. */
async function mkOffer(market: string, n = 2, slot = 1): Promise<string[]> {
  const stemOrder = nextSeq();
  const stem = `tt${stemOrder}`;
  const category = `${stem}_cat`;
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'trust integration test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'trust-itest' FROM unnest($1::text[]) AS k`,
    [[`catalog.category.${category}.name`, ...Array.from({ length: n }, (_, i) => `catalog.service_type.${stem}_t${i}.name`)]],
  );
  await q('INSERT INTO catalog.categories (code) VALUES ($1)', [category]);
  await q("UPDATE catalog.categories SET status = 'ACTIVE' WHERE code = $1", [category]);
  await q(
    `INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) SELECT m.market_id, c.category_id, true, $3 FROM geography.markets m, catalog.categories c WHERE m.code = $1 AND c.code = $2`,
    [market, category, slot * 10],
  );
  const types: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = `${stem}_t${i}`;
    types.push(t);
    await q('INSERT INTO catalog.service_types (category_id, code) SELECT category_id, $2 FROM catalog.categories WHERE code = $1', [category, t]);
    await q("UPDATE catalog.service_types SET status = 'ACTIVE' WHERE code = $1", [t]);
    await q(
      `INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) SELECT m.market_id, s.service_type_id, true, $3 FROM geography.markets m, catalog.service_types s WHERE m.code = $1 AND s.code = $2`,
      [market, t, slot * 100 + i],
    );
  }
  return types;
}

/** The reviewer entry points validate their input synchronously (before returning a promise): wrap them so `expectError` sees a rejection either way. */
const asyncify = (s: TrustService) => ({
  approveRequirement: async (...a: Parameters<TrustService['approveRequirement']>) => s.approveRequirement(...a),
  rejectRequirement: async (...a: Parameters<TrustService['rejectRequirement']>) => s.rejectRequirement(...a),
  requestAction: async (...a: Parameters<TrustService['requestAction']>) => s.requestAction(...a),
  startReview: async (...a: Parameters<TrustService['startReview']>) => s.startReview(...a),
});
let as: ReturnType<typeof asyncify>;
let asLenient: ReturnType<typeof asyncify>;
const ROOT = 'root-admin';
const REV1 = 'rev-one';
const REV2 = 'rev-two';
const rule = (market: string | null, code: string, serviceType: string | null = null, enabled = true) =>
  svc.setRequirementRule(ROOT, { requirementCode: code, marketCode: market, serviceTypeCode: serviceType, enabled });

interface World {
  accountId: string;
  market: string;
  /** The service types the provider selected. */
  types: string[];
  /** A service type the market offers that the provider did not select. */
  other: string;
  ctx: ProviderContext;
}
/** A fresh market, offer and ACTIVE account whose market requires `req` (besides the global identity requirement). */
async function mkWorld(o: { req?: readonly string[] } = {}): Promise<World> {
  const market = await mkMarket();
  const types = await mkOffer(market, 2);
  const other = (await mkOffer(market, 1, 2))[0]!;
  const accountId = await mkAccount();
  const ctx: ProviderContext = { accountActive: true, contactsVerified: true, registrationLive: true, marketCode: market, serviceTypeCodes: types };
  ctxPort.set(accountId, ctx);
  for (const code of o.req ?? []) await rule(market, code);
  return { accountId, market, types, other, ctx };
}
/** A world whose case is already opened. */
async function opened(req: readonly string[] = [], s: TrustService = svc): Promise<World & { caseId: string }> {
  const w = await mkWorld({ req });
  await s.openVerification(w.accountId);
  return { ...w, caseId: (await liveCase(w.accountId))!.verification_case_id };
}

// ---------------------------------------------------------------- evidence fixtures (SYNTHETIC: a few bytes with a real signature)
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const pdf = (tag = ''): Buffer => Buffer.from(`%PDF-1.4\n% synthetic evidence ${tag} ${randomUUID()}\n%%EOF\n`);
const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic ${randomUUID()}`)]);
const png = (): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic ${randomUUID()}`)]);
const DOC_TYPE: Record<string, string> = {
  identity_verification: 'passport',
  liability_insurance: 'insurance_certificate',
  professional_license: 'professional_license',
};

// ---------------------------------------------------------------- reads of the database
interface CaseDb {
  verification_case_id: string;
  account_id: string;
  case_number: number;
  status: string;
  revision: number;
  submitted_at: Date | null;
  decided_at: Date | null;
  cancelled_at: Date | null;
}
interface InstDb {
  case_requirement_id: string;
  verification_case_id: string;
  code: string;
  cycle: number;
  status: string;
  round: number;
  revision: number;
  approved_at: Date | null;
  expires_at: Date | null;
  superseded_at: Date | null;
  submitted_at: Date | null;
}
interface DocDb {
  verification_document_id: string;
  case_requirement_id: string;
  object_key: string;
  mime_type: string;
  size_bytes: string;
  sha256: string | null;
  status: string;
  scan_status: string;
  round: number | null;
  upload_expires_at: Date;
  finalized_at: Date | null;
  scanned_at: Date | null;
  submitted_at: Date | null;
  withdrawn_at: Date | null;
}
interface ReviewDb {
  decision: string;
  round: number;
  reason_code: string | null;
  reviewer: string;
  expires_at: Date | null;
  correlation_id: string;
}
interface AuditDb {
  action: string;
  actor: string;
  changes: Record<string, unknown> | null;
  reason_code: string | null;
  case_requirement_id: string | null;
  correlation_id: string;
}
interface EventDb {
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: Record<string, unknown>;
  correlation_id: string;
}
const liveCase = async (accountId: string) =>
  (await q<CaseDb>(`SELECT * FROM trust.verification_cases WHERE account_id = $1 AND status <> 'CANCELLED'`, [accountId]))[0];
const casesOf = (accountId: string) => q<CaseDb>('SELECT * FROM trust.verification_cases WHERE account_id = $1 ORDER BY case_number', [accountId]);
const instancesOf = (caseId: string, withHistory = false) =>
  q<InstDb>(
    `SELECT cr.*, d.code FROM trust.case_requirements cr JOIN trust.requirement_definitions d USING (requirement_definition_id)
      WHERE cr.verification_case_id = $1 ${withHistory ? '' : 'AND cr.superseded_at IS NULL'} ORDER BY d.code COLLATE "C", cr.cycle`,
    [caseId],
  );
async function inst(w: { accountId: string }, code: string): Promise<InstDb> {
  const c = (await liveCase(w.accountId))!;
  const r = (await instancesOf(c.verification_case_id)).find((i) => i.code === code);
  if (!r) throw new Error(`no current instance of ${code}`);
  return r;
}
const docsOf = (requirementId: string) =>
  q<DocDb>('SELECT * FROM trust.documents WHERE case_requirement_id = $1 ORDER BY created_at, verification_document_id', [requirementId]);
const docRow = async (id: string) => (await q<DocDb>('SELECT * FROM trust.documents WHERE verification_document_id = $1', [id]))[0]!;
const reviewsOf = (requirementId: string) =>
  q<ReviewDb>(
    'SELECT decision, round, reason_code, reviewer, expires_at, correlation_id FROM trust.reviews WHERE case_requirement_id = $1 ORDER BY reviewed_at, review_id',
    [requirementId],
  );
const auditsOf = (caseId: string) =>
  q<AuditDb>(
    'SELECT action, actor, changes, reason_code, case_requirement_id, correlation_id FROM trust.audit_events WHERE verification_case_id = $1 ORDER BY occurred_at, audit_event_id',
    [caseId],
  );
const actionsOf = async (caseId: string): Promise<string[]> => (await auditsOf(caseId)).map((a) => a.action);
const eventsOf = (caseId: string) =>
  q<EventDb>(
    `SELECT event_type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, correlation_id FROM integration.outbox_events
      WHERE event_type LIKE 'bananagig.trust.%' AND aggregate_id = $1 ORDER BY created_at, outbox_event_id`,
    [caseId],
  );
const eventTypesOf = async (caseId: string): Promise<string[]> => (await eventsOf(caseId)).map((e) => e.event_type).sort();
const countOf = <T>(list: readonly T[], x: T): number => list.filter((y) => y === x).length;
const keyOf = async (documentId: string): Promise<string> => (await docRow(documentId)).object_key;
/** Where the PRESIGNED PUT writes: the provider's bytes arrive under `trust/upload/...`, never under the final `trust/evidence/...` key the database holds. */
const uploadKeyOf = (objectKey: string): string => objectKey.replace(/^trust\/evidence\//, 'trust/upload/');
/** Plays the uploader: the PUT to the presigned URL of the document. */
const putUpload = async (documentId: string, bytes: Buffer, contentType: string | undefined = 'application/pdf'): Promise<void> => {
  store.put(uploadKeyOf(await keyOf(documentId)), bytes, contentType);
};
/** Everything that changes when an operation does anything, for "a refusal leaves no trace" assertions. */
async function footprint(caseId: string) {
  const c = await one<CaseDb>('SELECT * FROM trust.verification_cases WHERE verification_case_id = $1', [caseId]);
  const insts = await instancesOf(caseId, true);
  const docs = await q<DocDb>(
    `SELECT doc.* FROM trust.documents doc JOIN trust.case_requirements cr USING (case_requirement_id) WHERE cr.verification_case_id = $1 ORDER BY doc.verification_document_id`,
    [caseId],
  );
  const reviews = await q<Row>(
    `SELECT v.review_id FROM trust.reviews v JOIN trust.case_requirements cr USING (case_requirement_id) WHERE cr.verification_case_id = $1 ORDER BY v.review_id`,
    [caseId],
  );
  const external = await q<Row>(
    `SELECT e.external_verification_id, e.status FROM trust.external_verifications e JOIN trust.case_requirements cr USING (case_requirement_id) WHERE cr.verification_case_id = $1 ORDER BY 1`,
    [caseId],
  );
  return {
    caseStatus: c.status,
    revision: c.revision,
    submittedAt: c.submitted_at,
    instances: insts.map((i) => [i.case_requirement_id, i.status, i.round, i.revision, i.superseded_at]),
    docs: docs.map((d) => [d.verification_document_id, d.status, d.scan_status, d.round, d.sha256]),
    reviews: reviews.map((r) => r.review_id),
    external: external.map((r) => [r.external_verification_id, r.status]),
    audits: await actionsOf(caseId),
    events: await eventTypesOf(caseId),
  };
}

/** The stored case status is exactly what the pure function derives from the stored instances, and the case timestamps agree with it. */
async function checkCase(caseId: string): Promise<void> {
  const c = await one<CaseDb>('SELECT * FROM trust.verification_cases WHERE verification_case_id = $1', [caseId]);
  if (c.status === 'CANCELLED') return;
  const live = await instancesOf(caseId);
  const stored = live.map((i) => i.status as never);
  // the stored status follows the EFFECTIVE statuses at the time of the last change (an ended approval counts as EXPIRED before the sweep records it); it may lag until the next change
  const effective = live.map((i) => (i.status === 'APPROVED' && i.expires_at !== null && i.expires_at.getTime() <= Date.now() ? 'EXPIRED' : i.status) as never);
  const wanted = new Set([deriveStatus(c.submitted_at !== null, stored), deriveStatus(c.submitted_at !== null, effective)]);
  expect(wanted.has(c.status as never), `stored case status ${c.status} vs derived from ${live.map((i) => `${i.code}=${i.status}`).join(',')}`).toBe(true);
  if (c.status === 'OPEN') expect(c.submitted_at).toBeNull();
  else expect(c.submitted_at).not.toBeNull();
  if (c.status === 'APPROVED') expect(c.decided_at).not.toBeNull();
  for (const i of live) {
    // a submitted document is frozen in a round that exists; a decided requirement has a review of its round
    for (const d of await docsOf(i.case_requirement_id)) {
      if (d.status === 'SUBMITTED') expect(d.round! >= 1 && d.round! <= i.round).toBe(true);
      else expect(d.round).toBeNull();
    }
    if (['APPROVED', 'REJECTED', 'ACTION_REQUIRED'].includes(i.status)) {
      const decisions = (await reviewsOf(i.case_requirement_id)).filter((r) => r.round === i.round && r.decision !== 'STARTED');
      expect(decisions.length, `${i.code} ${i.status} round ${i.round}`).toBe(1);
      expect(decisions[0]!.decision).toBe(i.status);
    }
  }
}

// ---------------------------------------------------------------- observation
const thrown: string[] = [];
const surface = (e: unknown): string =>
  e instanceof TrustError
    ? JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details })
    : JSON.stringify({ name: (e as Error)?.name, message: (e as Error)?.message });
const err = async (p: Promise<unknown>): Promise<unknown> => {
  const e = await rejection(p);
  if (e !== undefined) thrown.push(surface(e));
  return e;
};
const expectError = async (p: Promise<unknown>, codeWanted: string, reasonWanted?: string): Promise<TrustError> => {
  const e = await err(p);
  expect(e, `expected ${codeWanted}`).toBeInstanceOf(TrustError);
  const te = e as TrustError;
  expect(te.code, JSON.stringify(te.details)).toBe(codeWanted);
  if (reasonWanted !== undefined) expect(te.details.reason).toBe(reasonWanted);
  return te;
};
/** What may never reach a provider (or the audit trail, events, logs and errors): object keys, URLs, hashes, bytes, personal data. */
function leaks(value: unknown, opts: { allowUrls?: boolean; allowHash?: boolean } = {}): string[] {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const out: string[] = [];
  if (/trust\/evidence|trust%2Fevidence|object_key|objectKey/.test(s)) out.push('object key');
  if (!opts.allowUrls && /memory:\/\//.test(s)) out.push('url');
  if (!opts.allowHash && (/[0-9a-f]{64}/.test(s) || /"sha256":"/.test(s))) out.push('hash');
  if (/%PDF|synthetic evidence|EICAR/.test(s)) out.push('bytes');
  if (s.includes(EMAIL_CANARY) || s.includes(PHONE_CANARY) || s.includes(NAME_CANARY)) out.push('personal data');
  return out;
}
const expectNoLeak = (value: unknown, opts?: { allowUrls?: boolean; allowHash?: boolean }): void => {
  expect(leaks(value, opts)).toEqual([]);
};
const isTxControl = (s: string): boolean => /^(start transaction|begin|commit|rollback)/i.test(s);
const counting = async <T>(fn: () => Promise<T>): Promise<{ result: T; stmts: string[]; tx: number }> => {
  const s0 = statements.length;
  const t0 = transactionsOpened;
  const result = await fn();
  return { result, stmts: statements.slice(s0).filter((x) => !isTxControl(x)), tx: transactionsOpened - t0 };
};
const within = (d: Date | string, around: number, marginMs: number): boolean => Math.abs(new Date(d).getTime() - around) <= marginMs;

// ---------------------------------------------------------------- flow helpers
interface Attached {
  documentId: string;
  key: string;
  bytes: Buffer;
  doc: DocumentView;
}
/** Authorizes an upload, plays the uploader (a PUT of the bytes to the authorized key) and finalizes. */
async function attach(
  w: { accountId: string },
  code: string,
  o: { service?: TrustService; bytes?: Buffer; mime?: string; contentType?: string | undefined; type?: string; sha256?: string } = {},
): Promise<Attached> {
  const s = o.service ?? svc;
  const mime = o.mime ?? 'application/pdf';
  const bytes = o.bytes ?? (mime === 'image/png' ? png() : mime === 'image/jpeg' ? jpeg() : pdf(code));
  const auth = await s.requestUpload(w.accountId, {
    requirementCode: code,
    documentTypeCode: o.type ?? DOC_TYPE[code]!,
    mimeType: mime,
    sizeBytes: bytes.byteLength,
  });
  const documentId = auth.document.verificationDocumentId;
  const key = await keyOf(documentId);
  store.put(uploadKeyOf(key), bytes, 'contentType' in o ? o.contentType : mime);
  const doc = await s.finalizeDocument(w.accountId, documentId, o.sha256 ? { sha256: o.sha256 } : {});
  return { documentId, key, bytes, doc };
}
/** Authorizes an upload and uploads the bytes but does not finalize. */
async function uploaded(
  w: { accountId: string },
  code: string,
  o: { service?: TrustService; bytes?: Buffer; mime?: string; contentType?: string | undefined; sizeBytes?: number } = {},
) {
  const s = o.service ?? svc;
  const mime = o.mime ?? 'application/pdf';
  const bytes = o.bytes ?? pdf(code);
  const auth = await s.requestUpload(w.accountId, {
    requirementCode: code,
    documentTypeCode: DOC_TYPE[code]!,
    mimeType: mime,
    sizeBytes: o.sizeBytes ?? bytes.byteLength,
  });
  const documentId = auth.document.verificationDocumentId;
  const key = await keyOf(documentId);
  store.put(uploadKeyOf(key), bytes, 'contentType' in o ? o.contentType : mime);
  return { documentId, key, uploadKey: uploadKeyOf(key), bytes, auth };
}
async function revisionOf(w: { accountId: string }): Promise<number> {
  return (await svc.getVerification(w.accountId)).case!.revision;
}
async function submit(w: { accountId: string }, s: TrustService = svc) {
  return s.submitVerification(w.accountId, { expectedRevision: await revisionOf(w) });
}
/** Attaches a clean document to every listed requirement and submits. */
async function submitAll(w: { accountId: string }, codes: readonly string[], s: TrustService = svc) {
  for (const code of codes) await attach(w, code, { service: s });
  return submit(w, s);
}
async function startReview(w: { accountId: string }, code: string, reviewer = REV1, round?: number, s: TrustService = svc) {
  const i = await inst(w, code);
  return s.startReview(reviewer, i.case_requirement_id, { round: round ?? i.round });
}
async function approve(
  w: { accountId: string },
  code: string,
  o: { reviewer?: string; round?: number; expiresAt?: string | Date | null; service?: TrustService } = {},
) {
  const i = await inst(w, code);
  const body: Record<string, unknown> = { round: o.round ?? i.round };
  if (o.expiresAt) body.expiresAt = o.expiresAt instanceof Date ? o.expiresAt.toISOString() : o.expiresAt;
  else if (i.code !== 'identity_verification' && o.expiresAt !== null) body.expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
  return (o.service ?? svc).approveRequirement(o.reviewer ?? REV1, i.case_requirement_id, body);
}
async function reject(w: { accountId: string }, code: string, reasonCode = 'DOCUMENT_UNREADABLE', o: { reviewer?: string; round?: number } = {}) {
  const i = await inst(w, code);
  return svc.rejectRequirement(o.reviewer ?? REV1, i.case_requirement_id, { round: o.round ?? i.round, reasonCode });
}
async function requestAction(w: { accountId: string }, code: string, reasonCode = 'REQUIRES_RESUBMISSION', o: { reviewer?: string; round?: number } = {}) {
  const i = await inst(w, code);
  return svc.requestAction(o.reviewer ?? REV1, i.case_requirement_id, { round: o.round ?? i.round, reasonCode });
}
const inDays = (n: number): Date => new Date(Date.now() + n * 86_400_000);
const caseStatusOf = async (accountId: string): Promise<string> => (await liveCase(accountId))!.status;
const reqStatus = async (w: { accountId: string }, code: string): Promise<string> => (await inst(w, code)).status;

// ================================================================ tests

describe('openVerification', () => {
  it('creates the case from policy: contiguous number, OPEN, one NOT_STARTED instance per required definition, audit and event exact', async () => {
    const w = await mkWorld({ req: ['liability_insurance'] });
    const r = await svc.openVerification(w.accountId);
    expect(r.created).toBe(true);
    expect(r.view.prerequisiteMet).toBe(true);
    expect(r.view.overall).toMatchObject({ status: 'OPEN', requiredCount: 2, approvedCount: 0, verificationComplete: false, missing: [] });
    const c = (await liveCase(w.accountId))!;
    expect(c).toMatchObject({ case_number: 1, status: 'OPEN', revision: 1, submitted_at: null, decided_at: null, cancelled_at: null });
    const insts = await instancesOf(c.verification_case_id);
    expect(insts.map((i) => [i.code, i.cycle, i.status, i.round, i.revision, i.superseded_at])).toEqual([
      ['identity_verification', 1, 'NOT_STARTED', 0, 1, null],
      ['liability_insurance', 1, 'NOT_STARTED', 0, 1, null],
    ]);
    const audits = await auditsOf(c.verification_case_id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'VERIFICATION_CASE_OPENED',
      actor: `account:${w.accountId}`,
      changes: { caseNumber: 1, requirements: ['identity_verification', 'liability_insurance'] },
    });
    const events = await eventsOf(c.verification_case_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: TRUST_EVENTS.caseOpened,
      aggregate_type: 'verification_case',
      aggregate_id: c.verification_case_id,
      actor_type: 'user',
      actor_id: `account:${w.accountId}`,
      payload_json: { accountId: w.accountId, verificationCaseId: c.verification_case_id, caseNumber: 1, status: 'OPEN' },
    });
    expect(Object.keys(events[0]!.payload_json).sort()).toEqual(['accountId', 'caseNumber', 'status', 'verificationCaseId']);
    expect(events[0]!.correlation_id).toBe(audits[0]!.correlation_id);
    await checkCase(c.verification_case_id);
  });

  it('is idempotent: a repeat creates nothing, writes no audit or event and does not bump the revision', async () => {
    const w = await opened(['liability_insurance']);
    const before = await footprint(w.caseId);
    const r = await svc.openVerification(w.accountId);
    expect(r.created).toBe(false);
    expect(await footprint(w.caseId)).toEqual(before);
    expect(await casesOf(w.accountId)).toHaveLength(1);
  });

  it('derives the requirements from market and selected service types, enabled rules and ACTIVE definitions only', async () => {
    const w = await mkWorld();
    const other = await mkWorld();
    await rule(w.market, 'liability_insurance'); // all service types of this market
    await rule(w.market, 'professional_license', w.types[1]!); // a type the provider selected
    await rule(w.market, 'background_check', w.other); // a type the provider did NOT select
    await rule(null, 'liability_insurance', null, false); // disabled rule elsewhere does not matter
    const view = await svc.getVerification(w.accountId);
    expect(view.requirements.map((r) => r.requirementCode)).toEqual(
      ['background_check', 'identity_verification', 'liability_insurance', 'professional_license'].filter((c) => c !== 'background_check'),
    );
    // another market is not asked for the insurance
    expect((await svc.getVerification(other.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification']);
    // a disabled market rule stops requiring it
    await rule(w.market, 'liability_insurance', null, false);
    expect((await svc.getVerification(w.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification', 'professional_license']);
    // an INACTIVE definition is required nowhere, whatever its rules say
    expect((await svc.setRequirementStatus(ROOT, 'professional_license', { status: 'INACTIVE' })).changed).toBe(true);
    try {
      expect((await svc.getVerification(w.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification']);
    } finally {
      await svc.setRequirementStatus(ROOT, 'professional_license', { status: 'ACTIVE' });
    }
    expect((await svc.getVerification(w.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification', 'professional_license']);
  });

  it('creates no case when policy requires nothing (the view says NOT_REQUIRED and is complete); the case appears once something is required', async () => {
    const w = await mkWorld();
    await rule(null, 'identity_verification', null, false);
    try {
      const r = await svc.openVerification(w.accountId);
      expect(r.created).toBe(false);
      expect(r.view.case).toBeNull();
      expect(r.view.overall).toMatchObject({ status: 'NOT_REQUIRED', verificationComplete: true, requiredCount: 0 });
      expect(await casesOf(w.accountId)).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM trust.audit_events a JOIN trust.verification_cases c USING (verification_case_id) WHERE c.account_id = $1', [w.accountId]),
      ).toHaveLength(0);
    } finally {
      await rule(null, 'identity_verification', null, true);
    }
    expect((await svc.openVerification(w.accountId)).created).toBe(true);
  });

  it('refuses without the prerequisites, writes nothing, and says which one is missing', async () => {
    const w = await mkWorld();
    const set = (over: Partial<ProviderContext>) => ctxPort.set(w.accountId, { ...w.ctx, ...over });
    set({ accountActive: false });
    await expectError(svc.openVerification(w.accountId), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_ACTIVE');
    set({ accountActive: false, registrationLive: false });
    await expectError(svc.openVerification(w.accountId), 'ACCOUNT_NOT_ACTIVE'); // inactive wins
    set({ accountActive: true, registrationLive: false });
    await expectError(svc.openVerification(w.accountId), 'PREREQUISITE_NOT_MET', 'REGISTRATION_REQUIRED');
    set({ registrationLive: true, contactsVerified: false });
    await expectError(svc.openVerification(w.accountId), 'PREREQUISITE_NOT_MET', 'CONTACT_NOT_VERIFIED');
    ctxPort.set(w.accountId, null);
    await expectError(svc.openVerification(w.accountId), 'ACCOUNT_NOT_ACTIVE');
    expect(await casesOf(w.accountId)).toHaveLength(0);
    // the overview still answers, and says the prerequisites are not met
    set({ registrationLive: false });
    ctxPort.set(w.accountId, { ...w.ctx, registrationLive: false });
    expect((await svc.getVerification(w.accountId)).prerequisiteMet).toBe(false);
    // a context that lies: the DATABASE decides whether the account is active
    ctxPort.set(w.accountId, w.ctx);
    const pending = await mkAccount('PENDING');
    ctxPort.set(pending, { ...w.ctx });
    await expectError(svc.openVerification(pending), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_ACTIVE');
    expect(await casesOf(pending)).toHaveLength(0);
    const ghost = randomUUID();
    ctxPort.set(ghost, { ...w.ctx });
    await expectError(svc.openVerification(ghost), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_FOUND');
  });

  it('is atomic: a failing audit or outbox insert rolls back the case and its instances, and the retry gets case number 1', async () => {
    const w = await mkWorld({ req: ['liability_insurance'] });
    await failAudit('VERIFICATION_CASE_OPENED');
    expect(String(((await err(svc.openVerification(w.accountId))) as Error).message)).toContain('crafted failure');
    expect(await casesOf(w.accountId)).toHaveLength(0);
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    await failEvent(TRUST_EVENTS.caseOpened);
    expect(String(((await err(svc.openVerification(w.accountId))) as Error).message)).toContain('crafted failure');
    expect(await casesOf(w.accountId)).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM trust.audit_events a WHERE a.changes->>'caseNumber' = '1' AND a.occurred_at > now() - interval '1 minute' AND a.actor = $1`, [
        `account:${w.accountId}`,
      ]),
    ).toHaveLength(0);
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    const r = await svc.openVerification(w.accountId);
    expect(r.created).toBe(true);
    expect((await liveCase(w.accountId))!.case_number).toBe(1);
  });

  it('serializes concurrent opens: exactly one case, one audit row, one event', async () => {
    for (let round = 0; round < 3; round++) {
      const w = await mkWorld({ req: ['liability_insurance'] });
      const results = await Promise.all(Array.from({ length: 6 }, () => svc.openVerification(w.accountId)));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const cases = await casesOf(w.accountId);
      expect(cases).toHaveLength(1);
      expect(await actionsOf(cases[0]!.verification_case_id)).toEqual(['VERIFICATION_CASE_OPENED']);
      expect(await eventTypesOf(cases[0]!.verification_case_id)).toEqual([TRUST_EVENTS.caseOpened]);
      expect(await instancesOf(cases[0]!.verification_case_id, true)).toHaveLength(2);
    }
  });

  it('keeps one account from touching another: each provider has her own case and her own view', async () => {
    const a = await opened();
    const b = await opened();
    expect(a.caseId).not.toBe(b.caseId);
    expect((await svc.getVerification(a.accountId)).case!.verificationCaseId).toBe(a.caseId);
    expect((await svc.getVerification(b.accountId)).case!.verificationCaseId).toBe(b.caseId);
  });
});

describe('sync on policy change', () => {
  it('adds new requirements, retires removed ones (NOT_REQUIRED, same row) and brings them back, each time audited once', async () => {
    const w = await opened(['liability_insurance']);
    const base = await footprint(w.caseId);
    await rule(w.market, 'professional_license');
    await svc.openVerification(w.accountId);
    let insts = await instancesOf(w.caseId);
    expect(insts.map((i) => [i.code, i.status])).toEqual([
      ['identity_verification', 'NOT_STARTED'],
      ['liability_insurance', 'NOT_STARTED'],
      ['professional_license', 'NOT_STARTED'],
    ]);
    expect((await one<CaseDb>('SELECT * FROM trust.verification_cases WHERE verification_case_id = $1', [w.caseId])).revision).toBe(base.revision + 1);
    let audits = await auditsOf(w.caseId);
    expect(audits.at(-1)).toMatchObject({
      action: 'VERIFICATION_REQUIREMENTS_SYNCED',
      actor: `account:${w.accountId}`,
      changes: { added: ['professional_license'], retired: [] },
    });
    // retire the insurance
    const insuranceId = insts.find((i) => i.code === 'liability_insurance')!.case_requirement_id;
    await rule(w.market, 'liability_insurance', null, false);
    await svc.openVerification(w.accountId);
    insts = await instancesOf(w.caseId);
    expect(insts.find((i) => i.code === 'liability_insurance')).toMatchObject({ status: 'NOT_REQUIRED', case_requirement_id: insuranceId });
    audits = await auditsOf(w.caseId);
    expect(audits.at(-1)).toMatchObject({ action: 'VERIFICATION_REQUIREMENTS_SYNCED', changes: { added: [], retired: ['liability_insurance'] } });
    // a retired requirement is not asked for: no uploads, not in the view, the case status ignores it
    await expectError(attach(w, 'liability_insurance'), 'REQUIREMENT_NOT_APPLICABLE');
    expect((await svc.getVerification(w.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification', 'professional_license']);
    // switching the rule on again revives the SAME row
    await rule(w.market, 'liability_insurance', null, true);
    await svc.openVerification(w.accountId);
    insts = await instancesOf(w.caseId, true);
    expect(insts.filter((i) => i.code === 'liability_insurance')).toHaveLength(1);
    expect(insts.find((i) => i.code === 'liability_insurance')).toMatchObject({ status: 'NOT_STARTED', case_requirement_id: insuranceId });
    // a repeat with nothing changed writes nothing
    const steady = await footprint(w.caseId);
    await svc.openVerification(w.accountId);
    expect(await footprint(w.caseId)).toEqual(steady);
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_REQUIREMENTS_SYNCED')).toBe(3);
    await checkCase(w.caseId);
  });

  it('keeps approved history when policy stops requiring it: still APPROVED, visible but not counted, not attachable', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    await approve(w, 'liability_insurance');
    await rule(w.market, 'liability_insurance', null, false);
    await svc.openVerification(w.accountId);
    expect(await reqStatus(w, 'liability_insurance')).toBe('APPROVED');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_REQUIREMENTS_SYNCED')).toBe(0);
    const view = await svc.getVerification(w.accountId);
    expect(view.overall.requiredCount).toBe(1);
    const hist = view.requirements.find((r) => r.requirementCode === 'liability_insurance')!;
    expect(hist).toMatchObject({ status: 'APPROVED', canAttachEvidence: false, canReverify: false });
    // approving the remaining requirement completes the case: the historic one does not block
    await approve(w, 'identity_verification');
    expect(await caseStatusOf(w.accountId)).toBe('APPROVED');
    await checkCase(w.caseId);
  });

  it('a requirement that appears after the first submission turns the case into ACTION_REQUIRED, and recomputes the stored status', async () => {
    const w = await opened();
    await submitAll(w, ['identity_verification']);
    expect(await caseStatusOf(w.accountId)).toBe('IN_REVIEW');
    await rule(w.market, 'professional_license');
    const missing = await svc.getVerification(w.accountId);
    expect(missing.overall.missing).toEqual(['professional_license']); // derived before the case holds it
    await svc.openVerification(w.accountId);
    expect(await caseStatusOf(w.accountId)).toBe('ACTION_REQUIRED');
    expect((await svc.getVerification(w.accountId)).overall.actionRequired).toEqual(['professional_license']);
    await checkCase(w.caseId);
  });
});

describe('requestUpload', () => {
  it('records an UPLOAD_PENDING document and a presigned PUT with the policy lifetime; key, hash and URL stay out of the document and the audit trail', async () => {
    const w = await opened();
    const rev0 = (await liveCase(w.accountId))!.revision;
    const issued0 = store.issued.length;
    const auth = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'drivers_license',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });
    expect(auth.document).toMatchObject({
      documentTypeCode: 'drivers_license',
      status: 'UPLOAD_PENDING',
      scanStatus: 'PENDING',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
      round: null,
      sha256: null,
      submittedAt: null,
    });
    const row = await docRow(auth.document.verificationDocumentId);
    expect(row.object_key).toBe(`trust/evidence/${w.caseId}/${row.verification_document_id}`);
    expect(row).toMatchObject({ status: 'UPLOAD_PENDING', scan_status: 'PENDING', sha256: null, size_bytes: '2048', mime_type: 'image/jpeg', round: null });
    // the presigned PUT is for the UPLOAD key, never for the final key the database holds (a replayed PUT cannot reach the final object)
    expect(row.object_key.startsWith('trust/evidence/')).toBe(true);
    expect(store.issued.slice(issued0)).toEqual([{ kind: 'upload', key: `trust/upload/${w.caseId}/${row.verification_document_id}`, ttlSeconds: 300 }]);
    expect(store.issued.slice(issued0).some((x) => x.key === row.object_key)).toBe(false);
    expect(auth.upload.headers).toEqual({ 'content-type': 'image/jpeg', 'content-length': '2048' });
    expect(within(auth.upload.expiresAt, Date.now() + 300_000, 15_000)).toBe(true);
    expect(within(row.upload_expires_at, Date.now() + 300_000, 15_000)).toBe(true);
    const audits = await auditsOf(w.caseId);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
      actor: `account:${w.accountId}`,
      changes: { verificationDocumentId: row.verification_document_id, documentType: 'drivers_license', sizeBytes: 2048, mimeType: 'image/jpeg' },
    });
    expect(Object.keys(audits[1]!.changes!).sort()).toEqual(['documentType', 'mimeType', 'sizeBytes', 'verificationDocumentId']);
    expect(audits[1]!.case_requirement_id).toBe((await inst(w, 'identity_verification')).case_requirement_id);
    expect(await eventTypesOf(w.caseId)).toEqual([TRUST_EVENTS.caseOpened]); // no event for a draft
    expect((await liveCase(w.accountId))!.revision).toBe(rev0);
    expectNoLeak(auth.document);
    expectNoLeak(audits.map((a) => a.changes));
    // only the one-time upload authorization carries the (encoded) key: and it is bound to exactly this object
    expect(auth.upload.url).toBe(`memory://upload/${encodeURIComponent(uploadKeyOf(row.object_key))}`);
    expect(auth.upload.url).not.toContain(encodeURIComponent(row.object_key));
  });

  it('takes the link lifetime from policy', async () => {
    const w = await opened([], svcMax2);
    const issued0 = store.issued.length;
    const auth = await svcMax2.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: 5000,
    });
    expect(store.issued.slice(issued0)[0]).toMatchObject({ kind: 'upload', ttlSeconds: 120 });
    expect(within(auth.upload.expiresAt, Date.now() + 120_000, 15_000)).toBe(true);
    expect(within((await docRow(auth.document.verificationDocumentId)).upload_expires_at, Date.now() + 120_000, 15_000)).toBe(true);
  });

  it('refuses every invalid request and leaves no trace (mime, size, strict body, document type, requirement, state)', async () => {
    const w = await opened(['liability_insurance']);
    const base = { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 5000 };
    const before = await footprint(w.caseId);
    const issued0 = store.issued.length;
    await expectError(svc.requestUpload(w.accountId, { ...base, mimeType: 'text/html' }), 'MIME_NOT_ALLOWED');
    await expectError(svc.requestUpload(w.accountId, { ...base, mimeType: 'image/gif' }), 'MIME_NOT_ALLOWED');
    const big = await expectError(svc.requestUpload(w.accountId, { ...base, sizeBytes: POLICY.maxSizeBytes + 1 }), 'FILE_TOO_LARGE');
    expect(big.details.max).toBe(POLICY.maxSizeBytes);
    await expectError(svc.requestUpload(w.accountId, { ...base, sizeBytes: 0 }), 'VALIDATION_FAILED');
    await expectError(svc.requestUpload(w.accountId, { ...base, sizeBytes: 1.5 }), 'VALIDATION_FAILED');
    await expectError(svc.requestUpload(w.accountId, { ...base, extra: 1 }), 'VALIDATION_FAILED');
    await expectError(svc.requestUpload(w.accountId, { ...base, requirementCode: 'Bad Code' }), 'VALIDATION_FAILED');
    await expectError(svc.requestUpload(w.accountId, { ...base, accountId: w.accountId }), 'VALIDATION_FAILED');
    await expectError(svc.requestUpload(w.accountId, { ...base, documentTypeCode: 'insurance_certificate' }), 'DOCUMENT_TYPE_NOT_ACCEPTED'); // another requirement type
    await expectError(svc.requestUpload(w.accountId, { ...base, documentTypeCode: 'no_such_type' }), 'DOCUMENT_TYPE_NOT_ACCEPTED');
    await expectError(svc.requestUpload(w.accountId, { ...base, requirementCode: 'liability_insurance' }), 'DOCUMENT_TYPE_NOT_ACCEPTED'); // passport is not insurance evidence
    await expectError(
      svc.requestUpload(w.accountId, { ...base, requirementCode: 'professional_license', documentTypeCode: 'professional_license' }),
      'REQUIREMENT_NOT_APPLICABLE',
    );
    await expectError(svc.requestUpload(w.accountId, { ...base, requirementCode: 'no_such_requirement' }), 'REQUIREMENT_NOT_APPLICABLE');
    expect(await footprint(w.caseId)).toEqual(before);
    expect(store.issued.length).toBe(issued0);
    // the exact maximum size is accepted
    const ok = await svc.requestUpload(w.accountId, { ...base, sizeBytes: POLICY.maxSizeBytes });
    expect(ok.document.sizeBytes).toBe(POLICY.maxSizeBytes);
  });

  it('refuses without a case (NOT_FOUND), for another account state, and once the requirement is not waiting for evidence', async () => {
    const w = await mkWorld({ req: ['background_check'] });
    const req = { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 5000 };
    await expectError(svc.requestUpload(w.accountId, req), 'NOT_FOUND', 'NO_CASE');
    await svc.openVerification(w.accountId);
    // an externally evidenced requirement takes no documents
    await expectError(svc.requestUpload(w.accountId, { ...req, requirementCode: 'background_check', documentTypeCode: 'passport' }), 'EVIDENCE_NOT_ACCEPTED');
    // PENDING and APPROVED requirements take none either
    await attach(w, 'identity_verification');
    await svc.startExternalVerification(w.accountId, 'background_check');
    await submit(w);
    await expectError(svc.requestUpload(w.accountId, req), 'EVIDENCE_NOT_ACCEPTED');
    await approve(w, 'identity_verification');
    await expectError(svc.requestUpload(w.accountId, req), 'EVIDENCE_NOT_ACCEPTED');
    // the account is the database's to judge
    await setAccountStatus(w.accountId, 'SUSPENDED');
    await expectError(svc.requestUpload(w.accountId, req), 'ACCOUNT_NOT_ACTIVE');
  });

  it('caps the documents per requirement by policy: ATTACHED and live pending uploads count, withdrawn ones free a slot', async () => {
    const w = await opened([], svcMax2);
    const a = await attach(w, 'identity_verification', { service: svcMax2 });
    await uploaded(w, 'identity_verification', { service: svcMax2 }); // pending, not finalized: still counts
    const e = await expectError(uploaded(w, 'identity_verification', { service: svcMax2 }), 'TOO_MANY_DOCUMENTS');
    expect(e.details.max).toBe(2);
    expect(await docsOf((await inst(w, 'identity_verification')).case_requirement_id)).toHaveLength(2);
    await svcMax2.withdrawDocument(w.accountId, a.documentId);
    await uploaded(w, 'identity_verification', { service: svcMax2 });
    await expectError(uploaded(w, 'identity_verification', { service: svcMax2 }), 'TOO_MANY_DOCUMENTS');
    // the default policy allows 5
    const x = await opened();
    for (let i = 0; i < 5; i++) await uploaded(x, 'identity_verification');
    await expectError(uploaded(x, 'identity_verification'), 'TOO_MANY_DOCUMENTS');
  });

  it('fails closed when the policy is missing or invalid', async () => {
    const bad = new TrustService({
      database: iso.database as Database,
      context: ctxPort,
      store,
      policy: { documents: async () => parseTrustPolicy({ ...SEEDED, [K.requireCleanScan]: undefined }) },
    });
    const w = await opened();
    await expectError(
      bad.requestUpload(w.accountId, { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 5000 }),
      'UNAVAILABLE',
      'POLICY_INVALID',
    );
    expect(() => parseTrustPolicy({ ...SEEDED, [K.maxSizeBytes]: 10 })).toThrow(TrustError);
    expect(() => parseTrustPolicy({ ...SEEDED, [K.allowedMimeTypes]: [] })).toThrow(TrustError);
  });
});

describe('finalizeDocument', () => {
  it('verifies the stored object, computes the SHA-256 on the server, scans, and attaches: row, audit and revision exact', async () => {
    const w = await opened();
    const rev0 = (await liveCase(w.accountId))!.revision;
    const bytes = pdf('happy');
    const calls0 = scanner.calls;
    const a = await attach(w, 'identity_verification', { bytes });
    expect(a.doc).toMatchObject({ status: 'ATTACHED', scanStatus: 'CLEAN', sha256: null, round: null, sizeBytes: bytes.byteLength });
    const row = await docRow(a.documentId);
    expect(row).toMatchObject({ status: 'ATTACHED', scan_status: 'CLEAN', sha256: sha(bytes), round: null });
    expect(row.finalized_at).not.toBeNull();
    expect(row.scanned_at).not.toBeNull();
    expect(scanner.calls - calls0).toBe(1);
    expect(store.objects.get(a.key)!.bytes.equals(bytes)).toBe(true);
    const audits = await auditsOf(w.caseId);
    expect(audits.at(-1)).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_SUBMITTED',
      actor: `account:${w.accountId}`,
      changes: { verificationDocumentId: a.documentId, scanStatus: 'CLEAN', sizeBytes: bytes.byteLength },
    });
    expect(Object.keys(audits.at(-1)!.changes!).sort()).toEqual(['scanStatus', 'sizeBytes', 'verificationDocumentId']);
    expect((await liveCase(w.accountId))!.revision).toBe(rev0 + 1);
    expect(await eventTypesOf(w.caseId)).toEqual([TRUST_EVENTS.caseOpened]);
    expectNoLeak(a.doc);
    expectNoLeak(audits.map((x) => x.changes));
    // what the provider lists / sees never carries the hash or the key
    expectNoLeak(await svc.listDocuments(w.accountId));
    expectNoLeak(await svc.getVerification(w.accountId));
    // I/O only outside transactions
    expect(scanner.inTx).toBe(0);
    expect(store.inTx).toEqual([]);
    await checkCase(w.caseId);
  });

  it('accepts a matching client SHA-256, JPEG and PNG, and a content type with parameters or upper case', async () => {
    const w = await opened();
    const b = pdf('client-sha');
    await attach(w, 'identity_verification', { bytes: b, sha256: sha(b) });
    await attach(w, 'identity_verification', { mime: 'image/jpeg' });
    await attach(w, 'identity_verification', { mime: 'image/png', contentType: 'Image/PNG' });
    await attach(w, 'identity_verification', { contentType: 'application/pdf; charset=binary' });
    const docs = await docsOf((await inst(w, 'identity_verification')).case_requirement_id);
    expect(docs.map((d) => d.status)).toEqual(['ATTACHED', 'ATTACHED', 'ATTACHED', 'ATTACHED']);
    expect(docs.map((d) => d.mime_type)).toEqual(['application/pdf', 'image/jpeg', 'image/png', 'application/pdf']);
  });

  it('refuses a missing object (retryable), then succeeds once the file is there', async () => {
    const w = await opened();
    const auth = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    const id = auth.document.verificationDocumentId;
    const before = await footprint(w.caseId);
    await expectError(svc.finalizeDocument(w.accountId, id), 'OBJECT_MISSING', 'OBJECT_MISSING');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await docRow(id)).status).toBe('UPLOAD_PENDING');
    const bytes = pdf('late');
    const sized = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    });
    await putUpload(sized.document.verificationDocumentId, bytes, 'application/pdf');
    expect((await svc.finalizeDocument(w.accountId, sized.document.verificationDocumentId)).status).toBe('ATTACHED');
  });

  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(60, ' '));
  const small = pdf('size');
  const mismatchCases: { name: string; reason: string; mime?: string; bytes: Buffer; sizeBytes?: number; contentType?: string | undefined }[] = [
    {
      name: 'a size different from the authorized one',
      reason: 'SIZE_MISMATCH',
      bytes: Buffer.concat([small, Buffer.from('extra')]),
      sizeBytes: small.byteLength,
    },
    { name: 'a smaller object than authorized', reason: 'SIZE_MISMATCH', bytes: small, sizeBytes: small.byteLength + 7 },
    { name: 'a different content type', reason: 'CONTENT_TYPE_MISMATCH', bytes: pdf('ct'), contentType: 'image/png' },
    { name: 'no content type', reason: 'CONTENT_TYPE_MISMATCH', bytes: pdf('noct'), contentType: undefined },
    { name: 'HTML bytes declared as a PDF (signature spoof)', reason: 'SIGNATURE_MISMATCH', bytes: html },
    { name: 'a PNG body declared as JPEG', reason: 'SIGNATURE_MISMATCH', bytes: png(), mime: 'image/jpeg' },
    { name: 'a truncated signature (%PDF without the dash)', reason: 'SIGNATURE_MISMATCH', bytes: Buffer.from('%PDFx synthetic body') },
  ];
  for (const m of mismatchCases) {
    it(`abandons the document, deletes the object and audits only the reason code for ${m.name}`, async () => {
      const w = await opened();
      const o: Parameters<typeof uploaded>[2] = { bytes: m.bytes };
      if (m.mime) o.mime = m.mime;
      if (m.sizeBytes) o.sizeBytes = m.sizeBytes;
      if ('contentType' in m) o.contentType = m.contentType;
      const { documentId: id, key } = await uploaded(w, 'identity_verification', o);
      const scans0 = scanner.calls;
      const e = await expectError(svc.finalizeDocument(w.accountId, id), 'OBJECT_MISMATCH', m.reason);
      expectNoLeak(surface(e));
      const row = await docRow(id);
      expect(row).toMatchObject({ status: 'ABANDONED', sha256: null, round: null });
      expect(store.objects.has(key)).toBe(false);
      expect(scanner.calls).toBe(scans0); // nothing is scanned that already failed the checks
      const audits = await auditsOf(w.caseId);
      expect(audits.at(-1)).toMatchObject({
        action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
        actor: `account:${w.accountId}`,
        changes: { verificationDocumentId: id, reason: m.reason },
      });
      expect(Object.keys(audits.at(-1)!.changes!).sort()).toEqual(['reason', 'verificationDocumentId']);
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(0);
      // a finished refusal is final: repeating it cannot attach anything
      await expectError(svc.finalizeDocument(w.accountId, id), 'INVALID_STATE', 'DOCUMENT_NOT_PENDING');
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED')).toBe(1);
      await checkCase(w.caseId);
    });
  }

  it('refuses a client hash that is not the server hash (HASH_MISMATCH), and a malformed hash', async () => {
    const w = await opened();
    const b = pdf('hash');
    const { documentId, key } = await uploaded(w, 'identity_verification', { bytes: b });
    await expectError(svc.finalizeDocument(w.accountId, documentId, { sha256: 'A'.repeat(64) }), 'VALIDATION_FAILED');
    await expectError(svc.finalizeDocument(w.accountId, documentId, { sha256: 'ab' }), 'VALIDATION_FAILED');
    await expectError(svc.finalizeDocument(w.accountId, documentId, { other: 1 }), 'VALIDATION_FAILED');
    expect((await docRow(documentId)).status).toBe('UPLOAD_PENDING');
    const e = await expectError(
      svc.finalizeDocument(w.accountId, documentId, { sha256: sha(Buffer.from('another file')) }),
      'OBJECT_MISMATCH',
      'HASH_MISMATCH',
    );
    expectNoLeak(surface(e));
    expect(await docRow(documentId)).toMatchObject({ status: 'ABANDONED', sha256: null });
    expect(store.objects.has(key)).toBe(false);
  });

  it('marks an infected file (EICAR) INFECTED + ABANDONED, deletes the object and never lets it be attached', async () => {
    const w = await opened();
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR_TEST_STRING, 'latin1'), Buffer.from('\n%%EOF\n')]);
    const { documentId, key } = await uploaded(w, 'identity_verification', { bytes });
    const e = await expectError(svc.finalizeDocument(w.accountId, documentId), 'SCAN_INFECTED', 'SCAN_INFECTED');
    expectNoLeak(surface(e));
    expect(await docRow(documentId)).toMatchObject({ status: 'ABANDONED', scan_status: 'INFECTED', sha256: null });
    expect(store.objects.has(key)).toBe(false);
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
      changes: { verificationDocumentId: documentId, reason: 'SCAN_INFECTED' },
    });
    await expectError(svc.finalizeDocument(w.accountId, documentId), 'INVALID_STATE');
    // even a lenient policy cannot attach an infected file
    const { documentId: id2 } = await uploaded(w, 'identity_verification', { bytes, service: svcLenient });
    await expectError(svcLenient.finalizeDocument(w.accountId, id2), 'SCAN_INFECTED');
    expect((await docRow(id2)).status).toBe('ABANDONED');
  });

  it('with clean scans required, a scanner ERROR (or a crash) leaves the document UPLOAD_PENDING and retryable', async () => {
    const w = await opened();
    for (const mode of ['error', 'throw'] as const) {
      scanner.mode = mode;
      const { documentId, key, uploadKey } = await uploaded(w, 'identity_verification');
      const before = await footprint(w.caseId);
      await expectError(svc.finalizeDocument(w.accountId, documentId), 'SCAN_UNAVAILABLE', 'SCAN_UNAVAILABLE');
      expect(await footprint(w.caseId)).toEqual(before);
      expect(await docRow(documentId)).toMatchObject({ status: 'UPLOAD_PENDING', scan_status: 'PENDING', sha256: null });
      expect(store.objects.has(uploadKey)).toBe(true); // still retryable: the upload is kept, nothing was promoted
      expect(store.objects.has(key)).toBe(false);
      scanner.mode = 'fake';
      expect(await svc.finalizeDocument(w.accountId, documentId)).toMatchObject({ status: 'ATTACHED', scanStatus: 'CLEAN' });
    }
    // the production defaults (DisabledEvidenceScanner) fail closed the same way
    const { documentId } = await uploaded(w, 'identity_verification');
    await expectError(svcDefaults.finalizeDocument(w.accountId, documentId), 'SCAN_UNAVAILABLE');
    expect((await docRow(documentId)).status).toBe('UPLOAD_PENDING');
    await expect(new DisabledEvidenceScanner().scan()).resolves.toEqual({ status: 'ERROR' });
  });

  it('with clean scans NOT required, a scanner ERROR attaches the document with scan ERROR (recorded in row and audit)', async () => {
    const w = await opened([], svcLenient);
    scanner.mode = 'error';
    const a = await attach(w, 'identity_verification', { service: svcLenient });
    expect(a.doc).toMatchObject({ status: 'ATTACHED', scanStatus: 'ERROR' });
    expect(await docRow(a.documentId)).toMatchObject({ status: 'ATTACHED', scan_status: 'ERROR', sha256: sha(a.bytes) });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({ action: 'VERIFICATION_DOCUMENT_SUBMITTED', changes: { scanStatus: 'ERROR' } });
  });

  it('abandons an upload whose authorization expired (UPLOAD_EXPIRED), deletes the object and never touches the store first', async () => {
    const w = await opened([], svcFuture);
    const { documentId, key } = await uploaded(w, 'identity_verification');
    const heads = store.count('head');
    await expectError(svcFuture.finalizeDocument(w.accountId, documentId), 'UPLOAD_EXPIRED', 'UPLOAD_EXPIRED');
    expect(store.count('head')).toBe(heads);
    expect(await docRow(documentId)).toMatchObject({ status: 'ABANDONED', sha256: null });
    expect(store.objects.has(key)).toBe(false);
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({ action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED', changes: { reason: 'UPLOAD_EXPIRED' } });
    // within its lifetime the same document would have been fine
    const ok = await uploaded(w, 'identity_verification');
    expect((await svc.finalizeDocument(w.accountId, ok.documentId)).status).toBe('ATTACHED');
  });

  it('is idempotent: repeating returns the same document, with no new audit, revision change or scan', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    const before = await footprint(w.caseId);
    const scans = scanner.calls;
    const heads = store.count('head');
    const again = await svc.finalizeDocument(w.accountId, a.documentId);
    expect(again).toEqual(a.doc);
    expect(await footprint(w.caseId)).toEqual(before);
    expect(scanner.calls).toBe(scans);
    expect(store.count('head')).toBe(heads);
    await submit(w);
    expect(await svc.finalizeDocument(w.accountId, a.documentId)).toMatchObject({ status: 'SUBMITTED', sha256: null });
  });

  it("treats another account's (or an unknown) document as NOT_FOUND and leaves it untouched", async () => {
    const a = await opened();
    const b = await opened();
    const { documentId, uploadKey } = await uploaded(a, 'identity_verification');
    const before = await footprint(a.caseId);
    const e = await expectError(svc.finalizeDocument(b.accountId, documentId), 'NOT_FOUND');
    expect(e.message).toBe((await expectError(svc.finalizeDocument(b.accountId, randomUUID()), 'NOT_FOUND')).message); // indistinguishable
    await expectError(svc.withdrawDocument(b.accountId, documentId), 'NOT_FOUND');
    expect(await footprint(a.caseId)).toEqual(before);
    expect(store.objects.has(uploadKey)).toBe(true);
    expect(await svc.listDocuments(b.accountId)).toEqual([]);
    expect((await svc.listDocuments(a.accountId)).map((d) => d.verificationDocumentId)).toEqual([documentId]);
  });

  it('refuses to attach to a requirement that moved on or to a cancelled case, keeping the document pending', async () => {
    const w = await opened();
    const late = await uploaded(w, 'identity_verification'); // authorized, not yet finalized
    await attach(w, 'identity_verification');
    await submit(w);
    await expectError(svc.finalizeDocument(w.accountId, late.documentId), 'INVALID_STATE', 'DOCUMENT_REQUIREMENT_STATE');
    expect((await docRow(late.documentId)).status).toBe('UPLOAD_PENDING');
    const x = await opened();
    const pending = await uploaded(x, 'identity_verification');
    await svc.cancelVerification(x.accountId);
    await expectError(svc.finalizeDocument(x.accountId, pending.documentId), 'INVALID_STATE');
    expect((await docRow(pending.documentId)).status).toBe('UPLOAD_PENDING');
  });

  it('is atomic: a failing audit insert leaves the document UPLOAD_PENDING with no hash and no revision bump', async () => {
    const w = await opened();
    const { documentId, bytes, key, uploadKey } = await uploaded(w, 'identity_verification');
    const before = await footprint(w.caseId);
    await failAudit('VERIFICATION_DOCUMENT_SUBMITTED');
    expect(String(((await err(svc.finalizeDocument(w.accountId, documentId))) as Error).message)).toContain('crafted failure');
    expect(await footprint(w.caseId)).toEqual(before);
    expect(store.objects.has(key)).toBe(false); // the promoted copy is not left behind for a document that did not attach
    expect(store.objects.has(uploadKey)).toBe(true); // the upload object stays: the provider does not have to send the file again
    expect((await docRow(documentId)).status).toBe('UPLOAD_PENDING');
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    // the retry promotes the same upload object again, with no new PUT
    expect((await svc.finalizeDocument(w.accountId, documentId)).status).toBe('ATTACHED');
    expect(store.objects.get(key)!.bytes.equals(bytes)).toBe(true);
    expect(store.objects.has(uploadKey)).toBe(false);
    expect(await docRow(documentId)).toMatchObject({ status: 'ATTACHED', sha256: sha(bytes) });
  });
});

describe('withdrawDocument', () => {
  it('withdraws a draft: WITHDRAWN, object deleted, audited and idempotent', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    const rev0 = (await liveCase(w.accountId))!.revision;
    const out = await svc.withdrawDocument(w.accountId, a.documentId);
    expect(out).toMatchObject({ status: 'WITHDRAWN', sha256: null });
    expect(await docRow(a.documentId)).toMatchObject({ status: 'WITHDRAWN', round: null, sha256: sha(a.bytes) });
    expect((await docRow(a.documentId)).withdrawn_at).not.toBeNull();
    expect(store.objects.has(a.key)).toBe(false);
    expect((await liveCase(w.accountId))!.revision).toBe(rev0 + 1);
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_REPLACED',
      actor: `account:${w.accountId}`,
      changes: { verificationDocumentId: a.documentId },
    });
    const before = await footprint(w.caseId);
    expect(await svc.withdrawDocument(w.accountId, a.documentId)).toMatchObject({ status: 'WITHDRAWN' });
    expect(await footprint(w.caseId)).toEqual(before);
  });

  it('abandons a pending upload and deletes whatever was uploaded', async () => {
    const w = await opened();
    const { documentId, key } = await uploaded(w, 'identity_verification');
    expect(await svc.withdrawDocument(w.accountId, documentId)).toMatchObject({ status: 'ABANDONED' });
    expect(store.objects.has(key)).toBe(false);
    await expectError(svc.finalizeDocument(w.accountId, documentId), 'INVALID_STATE');
  });

  it('refuses a submitted document, which is history: nothing changes and the object stays', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    await submit(w);
    const before = await footprint(w.caseId);
    await expectError(svc.withdrawDocument(w.accountId, a.documentId), 'INVALID_STATE', 'DOCUMENT_SUBMITTED');
    expect(await footprint(w.caseId)).toEqual(before);
    expect(store.objects.has(a.key)).toBe(true);
    expect((await docRow(a.documentId)).status).toBe('SUBMITTED');
  });

  it('is atomic: a failing audit insert keeps the document ATTACHED and the object', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    const before = await footprint(w.caseId);
    await failAudit('VERIFICATION_DOCUMENT_REPLACED');
    await err(svc.withdrawDocument(w.accountId, a.documentId));
    expect(await footprint(w.caseId)).toEqual(before);
    expect(store.objects.has(a.key)).toBe(true);
  });
});

/** The stored case status and the stored status of every current requirement, in one object, after checking the derivation invariant. */
async function states(w: { accountId: string }): Promise<Record<string, string>> {
  const c = (await liveCase(w.accountId))!;
  await checkCase(c.verification_case_id);
  const out: Record<string, string> = { case: c.status };
  for (const i of await instancesOf(c.verification_case_id)) out[i.code] = i.status;
  return out;
}

describe('submitVerification', () => {
  it('needs a clean draft for every requirement that waits for the provider: SUBMISSION_INCOMPLETE names the codes and changes nothing', async () => {
    const w = await opened(['liability_insurance', 'professional_license']);
    await expectError(submit(w), 'SUBMISSION_INCOMPLETE').then((e) =>
      expect(e.details.codes).toEqual(['identity_verification', 'liability_insurance', 'professional_license']),
    );
    await attach(w, 'identity_verification');
    const before = await footprint(w.caseId);
    const e = await expectError(submit(w), 'SUBMISSION_INCOMPLETE', 'SUBMISSION_INCOMPLETE');
    expect(e.details.codes).toEqual(['liability_insurance', 'professional_license']);
    expect(await footprint(w.caseId)).toEqual(before);
    expect(await states(w)).toEqual({
      case: 'OPEN',
      identity_verification: 'NOT_STARTED',
      liability_insurance: 'NOT_STARTED',
      professional_license: 'NOT_STARTED',
    });
    // an unfinalized upload and a withdrawn draft are not drafts
    await uploaded(w, 'liability_insurance');
    const w2 = await attach(w, 'professional_license');
    await svc.withdrawDocument(w.accountId, w2.documentId);
    expect((await expectError(submit(w), 'SUBMISSION_INCOMPLETE')).details.codes).toEqual(['liability_insurance', 'professional_license']);
  });

  it('moves every waiting requirement to PENDING in round 1, freezes the drafts as SUBMITTED, derives IN_REVIEW, and audits and publishes exactly once', async () => {
    const w = await opened(['liability_insurance']);
    const d1 = await attach(w, 'identity_verification');
    const d2 = await attach(w, 'liability_insurance');
    const d3 = await attach(w, 'liability_insurance', { mime: 'image/png' });
    const withdrawn = await attach(w, 'liability_insurance');
    await svc.withdrawDocument(w.accountId, withdrawn.documentId);
    const revBefore = await revisionOf(w);
    const r = await submit(w);
    expect(r.changed).toBe(true);
    expect(r.view.case).toMatchObject({ status: 'IN_REVIEW', revision: revBefore + 1 });
    expect(r.view.overall.status).toBe('IN_REVIEW');
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'PENDING', liability_insurance: 'PENDING' });
    const c = (await liveCase(w.accountId))!;
    expect(c.submitted_at).not.toBeNull();
    expect(c.revision).toBe(revBefore + 1);
    for (const i of await instancesOf(w.caseId)) {
      expect(i.round).toBe(1);
      expect(i.submitted_at).not.toBeNull();
    }
    const rows = await Promise.all([d1, d2, d3, withdrawn].map((d) => docRow(d.documentId)));
    expect(rows.map((d) => [d.status, d.round])).toEqual([
      ['SUBMITTED', 1],
      ['SUBMITTED', 1],
      ['SUBMITTED', 1],
      ['WITHDRAWN', null],
    ]);
    expect(rows[0]!.submitted_at).not.toBeNull();
    const audits = await auditsOf(w.caseId);
    expect(audits.at(-1)).toMatchObject({
      action: 'VERIFICATION_SUBMITTED',
      actor: `account:${w.accountId}`,
      changes: { requirements: ['identity_verification', 'liability_insurance'], status: ['OPEN', 'IN_REVIEW'], documents: 3 },
    });
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_SUBMITTED')).toBe(1);
    const events = (await eventsOf(w.caseId)).filter((e) => e.event_type === TRUST_EVENTS.submitted);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'user',
      actor_id: `account:${w.accountId}`,
      payload_json: { accountId: w.accountId, verificationCaseId: w.caseId, caseNumber: 1, status: 'IN_REVIEW' },
    });
    expect(events[0]!.correlation_id).toBe(audits.at(-1)!.correlation_id);
    // the submitted evidence is history: it cannot be withdrawn, replaced or added to
    await expectError(svc.withdrawDocument(w.accountId, d1.documentId), 'INVALID_STATE');
    await expectError(attach(w, 'identity_verification'), 'EVIDENCE_NOT_ACCEPTED');
  });

  it('is an idempotent no-op once everything is submitted, even with a stale revision: no audit, no event, no revision change', async () => {
    const w = await opened();
    await submitAll(w, ['identity_verification']);
    const before = await footprint(w.caseId);
    for (const expectedRevision of [1, before.revision, 999]) {
      const r = await svc.submitVerification(w.accountId, { expectedRevision });
      expect(r.changed).toBe(false);
    }
    expect(await footprint(w.caseId)).toEqual(before);
  });

  it('refuses a stale revision (STALE_CASE) when there is something to submit, and a fresh read then succeeds', async () => {
    const w = await opened();
    await attach(w, 'identity_verification');
    const rev = await revisionOf(w);
    const before = await footprint(w.caseId);
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: rev - 1 }), 'STALE_CASE', 'STALE_CASE');
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: rev + 1 }), 'STALE_CASE');
    expect(await footprint(w.caseId)).toEqual(before);
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: 0 }), 'VALIDATION_FAILED');
    await expectError(svc.submitVerification(w.accountId, {}), 'VALIDATION_FAILED');
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: rev, accountId: w.accountId }), 'VALIDATION_FAILED');
    expect((await svc.submitVerification(w.accountId, { expectedRevision: rev })).changed).toBe(true);
  });

  it('with clean scans required a draft that is not CLEAN does not count; with them off it does', async () => {
    const w = await opened([], svcLenient);
    scanner.mode = 'error';
    await attach(w, 'identity_verification', { service: svcLenient });
    scanner.mode = 'fake';
    const before = await footprint(w.caseId);
    await expectError(submit(w, svc), 'SUBMISSION_INCOMPLETE').then((e) => expect(e.details.codes).toEqual(['identity_verification']));
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await submit(w, svcLenient)).changed).toBe(true);
    expect((await docsOf((await inst(w, 'identity_verification')).case_requirement_id))[0]).toMatchObject({
      status: 'SUBMITTED',
      scan_status: 'ERROR',
      round: 1,
    });
  });

  it('needs the prerequisites and a case; a cancelled case is no case', async () => {
    const w = await mkWorld();
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: 1 }), 'NOT_FOUND', 'NO_CASE');
    await svc.openVerification(w.accountId);
    ctxPort.set(w.accountId, { ...w.ctx, contactsVerified: false });
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: 1 }), 'PREREQUISITE_NOT_MET');
    ctxPort.set(w.accountId, w.ctx);
    await svc.cancelVerification(w.accountId);
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: 1 }), 'NOT_FOUND', 'NO_CASE');
  });

  it('asks for a requirement that policy added since the case was opened, without persisting it when the submission is incomplete', async () => {
    const w = await opened();
    await submitAll(w, ['identity_verification']);
    await rule(w.market, 'professional_license');
    const before = await footprint(w.caseId);
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: before.revision }), 'SUBMISSION_INCOMPLETE').then((e) =>
      expect(e.details.codes).toEqual(['professional_license']),
    );
    expect(await footprint(w.caseId)).toEqual(before); // the sync inside the refused transaction rolled back
    await svc.openVerification(w.accountId);
    await attach(w, 'professional_license');
    await submit(w);
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'PENDING', professional_license: 'PENDING' });
    expect((await inst(w, 'identity_verification')).round).toBe(1); // already submitted: untouched
  });

  it('cannot submit documents for a requirement evidenced externally', async () => {
    const w = await opened(['background_check']);
    await attach(w, 'identity_verification');
    await expectError(submit(w), 'SUBMISSION_INCOMPLETE').then((e) => expect(e.details.codes).toEqual(['background_check']));
  });

  it('is atomic: a failing outbox insert leaves requirements NOT_STARTED, drafts ATTACHED and the revision unchanged', async () => {
    const w = await opened();
    await attach(w, 'identity_verification');
    const before = await footprint(w.caseId);
    const rev = await revisionOf(w);
    await failEvent(TRUST_EVENTS.submitted);
    expect(String(((await err(svc.submitVerification(w.accountId, { expectedRevision: rev }))) as Error).message)).toContain('crafted failure');
    expect(await footprint(w.caseId)).toEqual(before);
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    expect((await submit(w)).changed).toBe(true);
  });
});

describe('review (startReview, approve, reject, requestAction)', () => {
  const ready = async (req: readonly string[] = []) => {
    const w = await opened(req);
    await submitAll(w, ['identity_verification', ...req]);
    return w;
  };

  it('runs the whole happy path with exact history: audits, events, reviews and case status after every step; "completed" is published exactly once', async () => {
    const w = await ready(['liability_insurance']);
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'PENDING', liability_insurance: 'PENDING' });
    const idv = await inst(w, 'identity_verification');
    const started = await svc.startReview(REV1, idv.case_requirement_id, { round: 1 });
    expect(started).toMatchObject({ changed: true, caseStatus: 'IN_REVIEW' });
    expect(started.requirement).toMatchObject({ requirementCode: 'identity_verification', status: 'IN_REVIEW', round: 1 });
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'IN_REVIEW', liability_insurance: 'PENDING' });
    const a1 = await approve(w, 'identity_verification');
    expect(a1).toMatchObject({ changed: true, caseStatus: 'IN_REVIEW' });
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'APPROVED', liability_insurance: 'PENDING' });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(0);
    const a2 = await approve(w, 'liability_insurance', { reviewer: REV2 });
    expect(a2).toMatchObject({ changed: true, caseStatus: 'APPROVED' });
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    const c = (await liveCase(w.accountId))!;
    expect(c.decided_at).not.toBeNull();
    // approved directly from PENDING is allowed; the history has no STARTED row for it
    expect((await reviewsOf((await inst(w, 'liability_insurance')).case_requirement_id)).map((r) => [r.decision, r.reviewer])).toEqual([
      ['APPROVED', `admin:${REV2}`],
    ]);
    expect((await reviewsOf(idv.case_requirement_id)).map((r) => [r.decision, r.round, r.reviewer, r.reason_code, r.expires_at])).toEqual([
      ['STARTED', 1, `admin:${REV1}`, null, null],
      ['APPROVED', 1, `admin:${REV1}`, null, null],
    ]);
    expect(await actionsOf(w.caseId)).toEqual([
      'VERIFICATION_CASE_OPENED',
      'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
      'VERIFICATION_DOCUMENT_SUBMITTED',
      'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
      'VERIFICATION_DOCUMENT_SUBMITTED',
      'VERIFICATION_SUBMITTED',
      'VERIFICATION_REVIEW_STARTED',
      'VERIFICATION_APPROVED',
      'VERIFICATION_APPROVED',
    ]);
    const types = await eventTypesOf(w.caseId);
    expect(types).toEqual(
      [TRUST_EVENTS.requirementApproved, TRUST_EVENTS.requirementApproved, TRUST_EVENTS.caseOpened, TRUST_EVENTS.completed, TRUST_EVENTS.submitted].sort(),
    );
    // payloads: identifiers and safe status only
    const events = await eventsOf(w.caseId);
    const approved = events.filter((e) => e.event_type === TRUST_EVENTS.requirementApproved);
    expect(approved.map((e) => e.payload_json.requirementCode).sort()).toEqual(['identity_verification', 'liability_insurance']);
    for (const e of approved) {
      expect(Object.keys(e.payload_json).sort()).toEqual([
        'accountId',
        'caseNumber',
        'caseRequirementId',
        'reasonCode',
        'requirementCode',
        'requirementStatus',
        'requirementType',
        'status',
        'verificationCaseId',
      ]);
      expect(e).toMatchObject({ actor_type: 'system', payload_json: { requirementStatus: 'APPROVED', reasonCode: null, accountId: w.accountId } });
    }
    expect(approved.find((e) => e.payload_json.requirementCode === 'identity_verification')!.payload_json).toMatchObject({
      status: 'IN_REVIEW',
      requirementType: 'IDENTITY',
    });
    expect(approved.find((e) => e.payload_json.requirementCode === 'liability_insurance')!.payload_json).toMatchObject({
      status: 'APPROVED',
      requirementType: 'INSURANCE',
    });
    const done = events.find((e) => e.event_type === TRUST_EVENTS.completed)!;
    expect(done).toMatchObject({
      actor_id: `admin:${REV2}`,
      payload_json: { accountId: w.accountId, verificationCaseId: w.caseId, caseNumber: 1, status: 'APPROVED' },
    });
    expect(Object.keys(done.payload_json).sort()).toEqual(['accountId', 'caseNumber', 'status', 'verificationCaseId']);
    // audits: reviewer identity, requirement, round and case transition
    const audits = await auditsOf(w.caseId);
    const approvals = audits.filter((a) => a.action === 'VERIFICATION_APPROVED');
    expect(approvals.map((a) => a.changes!.requirement).sort()).toEqual(['identity_verification', 'liability_insurance']);
    expect(approvals.find((a) => a.changes!.requirement === 'liability_insurance')).toMatchObject({
      actor: `admin:${REV2}`,
      reason_code: null,
      changes: { round: 1, caseStatus: ['IN_REVIEW', 'APPROVED'] },
    });
    expect(audits.find((a) => a.action === 'VERIFICATION_REVIEW_STARTED')).toMatchObject({
      actor: `admin:${REV1}`,
      changes: { requirement: 'identity_verification', round: 1 },
    });
    // the provider's view: complete, but NOT live
    const view = await svc.getVerification(w.accountId);
    expect(view.overall).toMatchObject({ status: 'APPROVED', verificationComplete: true, approvedCount: 2, actionRequired: [], expired: [] });
    expect(JSON.stringify(view)).not.toContain('goLive');
  });

  it('startReview is idempotent per round, refuses a stale round, and refuses what is not waiting', async () => {
    const w = await ready();
    const i = await inst(w, 'identity_verification');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 2 }), 'STALE_ROUND');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 0 }), 'VALIDATION_FAILED');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 1, x: 1 }), 'VALIDATION_FAILED');
    await expectError(as.startReview('bad subject!', i.case_requirement_id, { round: 1 }), 'VALIDATION_FAILED', 'REVIEWER_INVALID');
    await expectError(as.startReview(REV1, randomUUID(), { round: 1 }), 'NOT_FOUND');
    expect(await reviewsOf(i.case_requirement_id)).toHaveLength(0);
    expect((await svc.startReview(REV1, i.case_requirement_id, { round: 1 })).changed).toBe(true);
    const before = await footprint(w.caseId);
    expect((await svc.startReview(REV2, i.case_requirement_id, { round: 1 })).changed).toBe(false);
    expect(await footprint(w.caseId)).toEqual(before);
    expect(await reviewsOf(i.case_requirement_id)).toHaveLength(1);
    await approve(w, 'identity_verification');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 1 }), 'ALREADY_DECIDED', 'NOT_PENDING');
    // a requirement that was never submitted (round 0) is not startable
    const x = await opened();
    const xi = await inst(x, 'identity_verification');
    await expectError(as.startReview(REV1, xi.case_requirement_id, { round: 1 }), 'STALE_ROUND');
  });

  it('approve: same decision is idempotent (changed:false, nothing written), another decision or reason on the same round is ALREADY_DECIDED', async () => {
    const w = await ready();
    await approve(w, 'identity_verification');
    const before = await footprint(w.caseId);
    const again = await approve(w, 'identity_verification', { reviewer: REV2 });
    expect(again).toMatchObject({ changed: false, caseStatus: 'APPROVED' });
    expect(await footprint(w.caseId)).toEqual(before);
    await expectError(reject(w, 'identity_verification'), 'ALREADY_DECIDED', 'ALREADY_DECIDED');
    await expectError(requestAction(w, 'identity_verification'), 'ALREADY_DECIDED');
    expect(await footprint(w.caseId)).toEqual(before);
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
    // reject / requestAction: same decision AND same reason is a no-op, another reason is ALREADY_DECIDED
    const x = await ready();
    await reject(x, 'identity_verification', 'DOCUMENT_UNREADABLE');
    const bx = await footprint(x.caseId);
    expect((await reject(x, 'identity_verification', 'DOCUMENT_UNREADABLE', { reviewer: REV2 })).changed).toBe(false);
    await expectError(reject(x, 'identity_verification', 'NAME_MISMATCH'), 'ALREADY_DECIDED');
    await expectError(approve(x, 'identity_verification'), 'ALREADY_DECIDED');
    await expectError(requestAction(x, 'identity_verification', 'DOCUMENT_UNREADABLE'), 'ALREADY_DECIDED');
    expect(await footprint(x.caseId)).toEqual(bx);
  });

  it('approve needs a valid end date when the definition says approvals expire, and bounds any end date', async () => {
    const w = await ready(['liability_insurance']);
    const ins = await inst(w, 'liability_insurance');
    const before = await footprint(w.caseId);
    const body = (expiresAt?: string) => ({ round: 1, ...(expiresAt ? { expiresAt } : {}) });
    await expectError(as.approveRequirement(REV1, ins.case_requirement_id, body()), 'VALIDATION_FAILED', 'EXPIRY_REQUIRED');
    await expectError(
      as.approveRequirement(REV1, ins.case_requirement_id, body(new Date(Date.now() - 1000).toISOString())),
      'VALIDATION_FAILED',
      'EXPIRY_INVALID',
    );
    await expectError(as.approveRequirement(REV1, ins.case_requirement_id, body(inDays(3661).toISOString())), 'VALIDATION_FAILED', 'EXPIRY_INVALID');
    await expectError(as.approveRequirement(REV1, ins.case_requirement_id, body('tomorrow')), 'VALIDATION_FAILED', 'INVALID_REQUEST');
    await expectError(as.approveRequirement(REV1, ins.case_requirement_id, { ...body(), extra: 1 }), 'VALIDATION_FAILED');
    expect(await footprint(w.caseId)).toEqual(before);
    const when = new Date(Math.floor(inDays(3600).getTime() / 1000) * 1000);
    await svc.approveRequirement(REV1, ins.case_requirement_id, body(when.toISOString()));
    const row = await inst(w, 'liability_insurance');
    expect(row.status).toBe('APPROVED');
    expect(row.expires_at!.getTime()).toBe(when.getTime());
    expect(row.approved_at).not.toBeNull();
    expect((await reviewsOf(ins.case_requirement_id)).at(-1)).toMatchObject({ decision: 'APPROVED', expires_at: when });
    expect((await auditsOf(w.caseId)).find((a) => a.action === 'VERIFICATION_APPROVED')!.changes).toMatchObject({ expiresAt: when.toISOString() });
    // a requirement without expiry may still be given one
    const id = await inst(w, 'identity_verification');
    const soon = new Date(Date.now() + 5 * 86_400_000);
    await svc.approveRequirement(REV1, id.case_requirement_id, { round: 1, expiresAt: soon.toISOString() });
    expect((await inst(w, 'identity_verification')).expires_at!.getTime()).toBe(soon.getTime());
  });

  it('reject and requestAction record a structured reason: requirement state, case ACTION_REQUIRED, reason in audit, review and event; the provider sees the reason', async () => {
    const w = await ready(['liability_insurance']);
    const r = await reject(w, 'identity_verification', 'NAME_MISMATCH');
    expect(r).toMatchObject({ changed: true, caseStatus: 'ACTION_REQUIRED' }); // a rejected requirement makes the provider owe something, whatever else is pending
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', identity_verification: 'REJECTED', liability_insurance: 'PENDING' });
    const q2 = await requestAction(w, 'liability_insurance', 'REQUIRES_RESUBMISSION', { reviewer: REV2 });
    expect(q2).toMatchObject({ changed: true, caseStatus: 'ACTION_REQUIRED' });
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', identity_verification: 'REJECTED', liability_insurance: 'ACTION_REQUIRED' });
    const audits = await auditsOf(w.caseId);
    expect(audits.find((a) => a.action === 'VERIFICATION_REJECTED')).toMatchObject({
      actor: `admin:${REV1}`,
      reason_code: 'NAME_MISMATCH',
      changes: { requirement: 'identity_verification', round: 1, caseStatus: ['IN_REVIEW', 'ACTION_REQUIRED'] },
    });
    expect(audits.find((a) => a.action === 'VERIFICATION_ACTION_REQUIRED')).toMatchObject({
      actor: `admin:${REV2}`,
      reason_code: 'REQUIRES_RESUBMISSION',
      changes: { caseStatus: ['ACTION_REQUIRED', 'ACTION_REQUIRED'] },
    });
    const events = await eventsOf(w.caseId);
    expect(events.find((e) => e.event_type === TRUST_EVENTS.requirementRejected)!.payload_json).toMatchObject({
      requirementStatus: 'REJECTED',
      reasonCode: 'NAME_MISMATCH',
      requirementCode: 'identity_verification',
      status: 'ACTION_REQUIRED',
    });
    expect(events.find((e) => e.event_type === TRUST_EVENTS.actionRequired)!.payload_json).toMatchObject({
      requirementStatus: 'ACTION_REQUIRED',
      reasonCode: 'REQUIRES_RESUBMISSION',
      status: 'ACTION_REQUIRED',
    });
    expect(events.some((e) => e.event_type === TRUST_EVENTS.completed)).toBe(false);
    const view = await svc.getVerification(w.accountId);
    expect(view.overall).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['identity_verification', 'liability_insurance'] });
    expect(view.requirements.map((x) => [x.requirementCode, x.status, x.reasonCode, x.canAttachEvidence])).toEqual([
      ['identity_verification', 'REJECTED', 'NAME_MISMATCH', true],
      ['liability_insurance', 'ACTION_REQUIRED', 'REQUIRES_RESUBMISSION', true],
    ]);
    expect(events.every((e) => leaks(e.payload_json).length === 0)).toBe(true);
  });

  it('validates the reason: unknown, not applicable to the decision, malformed or missing; nothing is written', async () => {
    const w = await ready();
    const i = await inst(w, 'identity_verification');
    const before = await footprint(w.caseId);
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'NO_SUCH_REASON' }), 'REASON_INVALID');
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' }), 'REASON_INVALID'); // action-required only
    await expectError(as.requestAction(REV1, i.case_requirement_id, { round: 1, reasonCode: 'LICENSE_INVALID' }), 'REASON_INVALID'); // reject only
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'document_unreadable' }), 'VALIDATION_FAILED');
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1 }), 'VALIDATION_FAILED');
    await expectError(as.requestAction(REV1, i.case_requirement_id, { round: 1, reasonCode: '' }), 'VALIDATION_FAILED');
    expect(await footprint(w.caseId)).toEqual(before);
    await svc.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'LICENSE_INVALID' });
    expect((await inst(w, 'identity_verification')).status).toBe('REJECTED');
  });

  it('refuses a decision on a stale round after the provider resubmitted, and a decision with no evidence or with unsafe evidence', async () => {
    const w = await ready();
    await reject(w, 'identity_verification');
    const i = await inst(w, 'identity_verification');
    await attach(w, 'identity_verification');
    await submit(w);
    await expectError(as.approveRequirement(REV1, i.case_requirement_id, { round: 1 }), 'STALE_ROUND', 'STALE_ROUND');
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'NAME_MISMATCH' }), 'STALE_ROUND');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 1 }), 'STALE_ROUND');
    expect((await inst(w, 'identity_verification')).status).toBe('PENDING');
    // unsafe evidence: a document that became INFECTED after the upload is not decidable, and not even with clean scans off
    await q(`UPDATE trust.documents SET scan_status = 'INFECTED' WHERE case_requirement_id = $1 AND round = 2`, [i.case_requirement_id]);
    const before = await footprint(w.caseId);
    await expectError(as.approveRequirement(REV1, i.case_requirement_id, { round: 2 }), 'SCAN_UNAVAILABLE', 'SCAN_NOT_CLEAN');
    await expectError(asLenient.approveRequirement(REV1, i.case_requirement_id, { round: 2 }), 'SCAN_INFECTED', 'SCAN_INFECTED');
    expect(await footprint(w.caseId)).toEqual(before);
    // no submitted evidence at all (a crafted state): nothing to decide on
    const x = await ready();
    const xi = await inst(x, 'identity_verification');
    await withoutTriggers(['trust.documents'], () =>
      q(`UPDATE trust.documents SET status = 'WITHDRAWN', round = NULL, submitted_at = NULL, withdrawn_at = now() WHERE case_requirement_id = $1`, [
        xi.case_requirement_id,
      ]),
    );
    await expectError(as.approveRequirement(REV1, xi.case_requirement_id, { round: 1 }), 'INVALID_STATE', 'NO_EVIDENCE');
    await expectError(as.rejectRequirement(REV1, xi.case_requirement_id, { round: 1, reasonCode: 'NAME_MISMATCH' }), 'INVALID_STATE', 'NO_EVIDENCE');
  });

  it('a scan that is not clean blocks the decision when clean scans are required, and is accepted with them off', async () => {
    const w = await opened([], svcLenient);
    scanner.mode = 'error';
    await attach(w, 'identity_verification', { service: svcLenient });
    scanner.mode = 'fake';
    await submit(w, svcLenient);
    const i = await inst(w, 'identity_verification');
    const before = await footprint(w.caseId);
    await expectError(as.approveRequirement(REV1, i.case_requirement_id, { round: 1 }), 'SCAN_UNAVAILABLE', 'SCAN_NOT_CLEAN');
    await expectError(as.rejectRequirement(REV1, i.case_requirement_id, { round: 1, reasonCode: 'NAME_MISMATCH' }), 'SCAN_UNAVAILABLE');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await svcLenient.approveRequirement(REV1, i.case_requirement_id, { round: 1 })).changed).toBe(true);
  });

  it('refuses decisions on a cancelled case', async () => {
    const w = await ready();
    const i = await inst(w, 'identity_verification');
    await svc.cancelVerification(w.accountId);
    await expectError(as.approveRequirement(REV1, i.case_requirement_id, { round: 1 }), 'INVALID_STATE', 'CASE_FROZEN');
    await expectError(as.startReview(REV1, i.case_requirement_id, { round: 1 }), 'INVALID_STATE', 'CASE_FROZEN');
    expect(await reviewsOf(i.case_requirement_id)).toHaveLength(0);
  });

  it('is atomic: a failing event or audit insert rolls the decision back entirely', async () => {
    for (const fail of [() => failEvent(TRUST_EVENTS.requirementApproved), () => failAudit('VERIFICATION_APPROVED')]) {
      const w = await ready();
      await svc.startReview(REV1, (await inst(w, 'identity_verification')).case_requirement_id, { round: 1 });
      const before = await footprint(w.caseId);
      await fail();
      expect(String(((await err(approve(w, 'identity_verification'))) as Error).message)).toContain('crafted failure');
      expect(await footprint(w.caseId)).toEqual(before);
      expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'IN_REVIEW' });
      await Promise.all(triggersToDrop.splice(0).map((d) => d()));
      expect((await approve(w, 'identity_verification')).caseStatus).toBe('APPROVED');
    }
  });
});

describe('resubmission after ACTION_REQUIRED / REJECTED', () => {
  it('keeps the whole history: round-1 documents stay SUBMITTED in round 1, round-1 reviews stay, round 2 gets new documents and its own decision', async () => {
    const w = await opened(['liability_insurance']);
    const old = [await attach(w, 'identity_verification'), await attach(w, 'liability_insurance')];
    await submit(w);
    await reject(w, 'identity_verification', 'DOCUMENT_UNREADABLE');
    await requestAction(w, 'liability_insurance', 'REQUIRES_RESUBMISSION');
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', identity_verification: 'REJECTED', liability_insurance: 'ACTION_REQUIRED' });
    // both wait for the provider: each needs a new clean draft
    await attach(w, 'identity_verification');
    await expectError(submit(w), 'SUBMISSION_INCOMPLETE').then((e) => expect(e.details.codes).toEqual(['liability_insurance']));
    await attach(w, 'liability_insurance');
    const r = await submit(w);
    expect(r.changed).toBe(true);
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'PENDING', liability_insurance: 'PENDING' });
    const idv = await inst(w, 'identity_verification');
    expect(idv.round).toBe(2);
    const docs = await docsOf(idv.case_requirement_id);
    expect(docs.map((d) => [d.status, d.round])).toEqual([
      ['SUBMITTED', 1],
      ['SUBMITTED', 2],
    ]);
    expect(docs[0]!.verification_document_id).toBe(old[0]!.documentId);
    expect((await reviewsOf(idv.case_requirement_id)).map((v) => [v.decision, v.round, v.reason_code])).toEqual([['REJECTED', 1, 'DOCUMENT_UNREADABLE']]);
    expect((await reviewsOf((await inst(w, 'liability_insurance')).case_requirement_id)).map((v) => [v.decision, v.round])).toEqual([['ACTION_REQUIRED', 1]]);
    // the provider no longer sees the old reason while the new round is pending
    const view = await svc.getVerification(w.accountId);
    expect(view.requirements.map((x) => [x.status, x.reasonCode, x.round])).toEqual([
      ['PENDING', null, 2],
      ['PENDING', null, 2],
    ]);
    // round 1 decisions are stale now; round 2 gets its own decision
    await expectError(approve(w, 'identity_verification', { round: 1 }), 'STALE_ROUND');
    await approve(w, 'identity_verification', { round: 2 });
    await approve(w, 'liability_insurance', { round: 2 });
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    expect((await reviewsOf(idv.case_requirement_id)).map((v) => [v.decision, v.round])).toEqual([
      ['REJECTED', 1],
      ['APPROVED', 2],
    ]);
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_SUBMITTED')).toBe(2);
    // the admin view shows both rounds
    const detail = await svc.getCase(w.caseId);
    const dIdv = detail.requirements.find((x) => x.requirementCode === 'identity_verification')!;
    expect(dIdv.documents.map((d) => d.round)).toEqual([1, 2]);
    expect(dIdv.reviews.map((v) => v.round)).toEqual([1, 2]);
  });

  it('keeps an approved requirement approved while another is resubmitted', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    await approve(w, 'identity_verification');
    await reject(w, 'liability_insurance', 'INSURANCE_EXPIRED');
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', identity_verification: 'APPROVED', liability_insurance: 'REJECTED' });
    await attach(w, 'liability_insurance');
    await submit(w);
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'APPROVED', liability_insurance: 'PENDING' });
    expect((await inst(w, 'identity_verification')).round).toBe(1);
    await approve(w, 'liability_insurance', { round: 2 });
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
  });
});

const sleepUntil = (t: number): Promise<void> => sleep(Math.max(0, t - Date.now()));

describe('expiry (derived from the timestamp; recorded by the sweep) and re-verification', () => {
  it('reads EXPIRED the moment the approval ends while the stored status is still APPROVED; the sweep records it once with audit and event; reverify opens cycle 2 and keeps cycle 1', async () => {
    await svc.recordExpiries(500); // flush approvals other tests left behind, so the counts below are this test's
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1800;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await approve(w, 'identity_verification');
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
    let view = await svc.getVerification(w.accountId);
    expect(view.overall).toMatchObject({ status: 'APPROVED', verificationComplete: true, expired: [] });
    expect(await svc.recordExpiries()).toBe(0);

    await sleepUntil(endsAt + 150);
    view = await svc.getVerification(w.accountId);
    expect(view.overall).toMatchObject({ status: 'EXPIRED', verificationComplete: false, expired: ['liability_insurance'], approvedCount: 1 });
    expect(view.requirements.find((r) => r.requirementCode === 'liability_insurance')).toMatchObject({
      status: 'EXPIRED',
      canReverify: true,
      canAttachEvidence: false,
      cycle: 1,
    });
    // derived, not yet recorded: the stored rows and the trail are unchanged
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_EXPIRED')).toBe(0);
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.expired)).toBe(0);
    // an ended approval takes no new documents, and there is nothing to submit
    await expectError(attach(w, 'liability_insurance'), 'EVIDENCE_NOT_ACCEPTED');
    expect((await submit(w)).changed).toBe(false);

    const revBefore = (await liveCase(w.accountId))!.revision;
    expect(await svc.recordExpiries()).toBe(1);
    expect(await svc.recordExpiries()).toBe(0);
    expect(await states(w)).toEqual({ case: 'EXPIRED', identity_verification: 'APPROVED', liability_insurance: 'EXPIRED' });
    expect((await liveCase(w.accountId))!.revision).toBe(revBefore + 1);
    const exp = (await auditsOf(w.caseId)).filter((a) => a.action === 'VERIFICATION_EXPIRED');
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ actor: 'system:expiry', changes: { requirement: 'liability_insurance', caseStatus: ['APPROVED', 'EXPIRED'] } });
    const expEv = (await eventsOf(w.caseId)).filter((e) => e.event_type === TRUST_EVENTS.expired);
    expect(expEv).toHaveLength(1);
    expect(expEv[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'system:expiry',
      payload_json: { requirementCode: 'liability_insurance', requirementStatus: 'EXPIRED', status: 'EXPIRED', reasonCode: null },
    });

    const cycle1 = await inst(w, 'liability_insurance');
    // the reviewer cannot touch a requirement whose cycle gets replaced... first the provider re-verifies
    const view2 = await svc.reverifyRequirement(w.accountId, 'liability_insurance');
    const all = await instancesOf(w.caseId, true);
    const ins = all.filter((i) => i.code === 'liability_insurance');
    expect(ins.map((i) => [i.cycle, i.status, i.round, i.superseded_at !== null])).toEqual([
      [1, 'EXPIRED', 1, true],
      [2, 'NOT_STARTED', 0, false],
    ]);
    expect(ins[0]!.approved_at).not.toBeNull();
    expect(ins[0]!.expires_at!.getTime()).toBe(cycle1.expires_at!.getTime());
    expect((await reviewsOf(ins[0]!.case_requirement_id)).map((v) => v.decision)).toEqual(['APPROVED']);
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', identity_verification: 'APPROVED', liability_insurance: 'NOT_STARTED' });
    expect(view2.requirements.find((r) => r.requirementCode === 'liability_insurance')).toMatchObject({
      status: 'NOT_STARTED',
      cycle: 2,
      round: 0,
      canAttachEvidence: true,
      canReverify: false,
    });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_REVERIFICATION_REQUESTED',
      actor: `account:${w.accountId}`,
      changes: { requirement: 'liability_insurance', cycle: [1, 2], status: ['EXPIRED', 'ACTION_REQUIRED'] },
    });
    expect(await svc.recordExpiries()).toBe(0); // the superseded cycle is not swept again
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_EXPIRED')).toBe(1);
    // the old cycle's reviewers cannot act on it
    await expectError(as.approveRequirement(REV1, ins[0]!.case_requirement_id, { round: 1 }), 'INVALID_STATE', 'SUPERSEDED_FROZEN');
    await expectError(reverifyAgain(w), 'NOT_REVERIFIABLE', 'NOT_EXPIRED');

    // cycle 2 evidence: round numbering starts again, cycle 1's documents stay with cycle 1
    const d2 = await attach(w, 'liability_insurance');
    await submit(w);
    const cur = await inst(w, 'liability_insurance');
    expect(cur).toMatchObject({ cycle: 2, round: 1, status: 'PENDING' });
    expect((await docsOf(cur.case_requirement_id)).map((d) => d.verification_document_id)).toEqual([d2.documentId]);
    expect((await docsOf(ins[0]!.case_requirement_id)).map((d) => [d.status, d.round])).toEqual([['SUBMITTED', 1]]);
    await approve(w, 'liability_insurance', { round: 1 });
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(2); // once per transition into APPROVED
    // the reviewers' view keeps both cycles
    const detail = await svc.getCase(w.caseId);
    const cycles = detail.requirements.filter((r) => r.requirementCode === 'liability_insurance');
    expect(cycles.map((r) => [r.cycle, r.superseded, r.status])).toEqual([
      [1, true, 'EXPIRED'],
      [2, false, 'APPROVED'],
    ]);
    expect(cycles[0]!.reviews.map((r) => r.decision)).toEqual(['APPROVED']);
    expect(detail.case.requirementCount).toBe(2);
    await checkCase(w.caseId);
  });

  const reverifyAgain = (w: { accountId: string }) => svc.reverifyRequirement(w.accountId, 'liability_insurance');

  it('reverify records an unrecorded expiry itself, in the same transaction (audit + event as the provider); the sweep then finds nothing', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1600;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await sleepUntil(endsAt + 150);
    await svc.reverifyRequirement(w.accountId, 'liability_insurance');
    const audits = await auditsOf(w.caseId);
    expect(audits.slice(-2).map((a) => [a.action, a.actor])).toEqual([
      ['VERIFICATION_EXPIRED', `account:${w.accountId}`],
      ['VERIFICATION_REVERIFICATION_REQUESTED', `account:${w.accountId}`],
    ]);
    const expEv = (await eventsOf(w.caseId)).filter((e) => e.event_type === TRUST_EVENTS.expired);
    expect(expEv).toHaveLength(1);
    expect(expEv[0]).toMatchObject({ actor_type: 'user', payload_json: { requirementStatus: 'EXPIRED', requirementCode: 'liability_insurance' } });
    expect(await svc.recordExpiries()).toBe(0);
    expect((await instancesOf(w.caseId, true)).filter((i) => i.code === 'liability_insurance').map((i) => [i.cycle, i.status])).toEqual([
      [1, 'EXPIRED'],
      [2, 'NOT_STARTED'],
    ]);
    await checkCase(w.caseId);
  });

  it('refuses re-verification unless the requirement is expired and still required (NOT_REVERIFIABLE), leaving no trace', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    await approve(w, 'liability_insurance');
    const before = await footprint(w.caseId);
    await expectError(svc.reverifyRequirement(w.accountId, 'liability_insurance'), 'NOT_REVERIFIABLE', 'NOT_EXPIRED'); // approved, running
    await expectError(svc.reverifyRequirement(w.accountId, 'identity_verification'), 'NOT_REVERIFIABLE'); // pending
    await expectError(svc.reverifyRequirement(w.accountId, 'professional_license'), 'NOT_REVERIFIABLE'); // not in the case
    await expectError(svc.reverifyRequirement(w.accountId, 'Not A Code'), 'NOT_REVERIFIABLE');
    expect(await footprint(w.caseId)).toEqual(before);
    const x = await mkWorld();
    await expectError(svc.reverifyRequirement(x.accountId, 'identity_verification'), 'NOT_FOUND', 'NO_CASE');
    ctxPort.set(w.accountId, { ...w.ctx, registrationLive: false });
    await expectError(svc.reverifyRequirement(w.accountId, 'liability_insurance'), 'PREREQUISITE_NOT_MET');
    ctxPort.set(w.accountId, w.ctx);
  });

  it('does not re-verify a requirement policy no longer asks for', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1500;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await rule(w.market, 'liability_insurance', null, false);
    await sleepUntil(endsAt + 150);
    const before = await footprint(w.caseId);
    await expectError(svc.reverifyRequirement(w.accountId, 'liability_insurance'), 'NOT_REVERIFIABLE');
    expect(await footprint(w.caseId)).toEqual(before);
    await svc.recordExpiries(); // keep the table clean for the next test
  });

  it('the sweep is atomic: a failing event insert records nothing, and the next sweep records it', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1500;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await sleepUntil(endsAt + 150);
    const before = await footprint(w.caseId);
    await failEvent(TRUST_EVENTS.expired);
    await err(svc.recordExpiries());
    expect(await footprint(w.caseId)).toEqual(before);
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    expect(await svc.recordExpiries()).toBe(1);
    expect((await inst(w, 'liability_insurance')).status).toBe('EXPIRED');
  });
});

/** An external provider that behaves as scripted. */
class ScriptedExternal implements VerificationProvider {
  readonly name = 'fake';
  mode: 'ok' | 'throw' = 'ok';
  async create(): Promise<{ externalId: string; status: 'CREATED' | 'PENDING' }> {
    if (this.mode === 'throw') throw new Error('vendor down with secret-token');
    return { externalId: `scripted-${randomUUID()}`, status: 'CREATED' };
  }
  async status(): Promise<never> {
    throw new Error('vendor down with secret-token');
  }
  async cancel(): Promise<void> {}
  async evidenceSummary(): Promise<never> {
    throw new Error('vendor down');
  }
}
const extRow = async (requirementId: string) =>
  q<{ round: number; adapter: string; external_id: string; status: string; last_checked_at: Date | null }>(
    'SELECT round, adapter, external_id, status, last_checked_at FROM trust.external_verifications WHERE case_requirement_id = $1 ORDER BY round',
    [requirementId],
  );

describe('external verification', () => {
  it('start: PENDING in a new round with a reference; the adapter gets only an opaque reference and the requirement type; audited and published once; idempotent', async () => {
    const w = await opened(['background_check']);
    const bg = await inst(w, 'background_check');
    const created0 = ext.requests.length;
    const txCalls = ext.inTx;
    const r = await svc.startExternalVerification(w.accountId, 'background_check');
    expect(r).toMatchObject({ requirementCode: 'background_check', adapter: 'fake', status: 'PENDING' });
    expect(within(r.lastCheckedAt!, Date.now(), 15_000)).toBe(true);
    expect(ext.requests.slice(created0)).toEqual([{ reference: bg.case_requirement_id, requirementType: 'BACKGROUND_CHECK' }]);
    expect(ext.inTx).toBe(txCalls); // the adapter is never called inside a transaction
    const after = await inst(w, 'background_check');
    expect(after).toMatchObject({ status: 'PENDING', round: 1 });
    const rows = await extRow(bg.case_requirement_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, adapter: 'fake', status: 'PENDING' });
    expect(rows[0]!.external_id).toBe(ext.created.at(-1));
    expect(rows[0]!.last_checked_at).not.toBeNull();
    const audits = await auditsOf(w.caseId);
    expect(audits.at(-1)).toMatchObject({
      action: 'VERIFICATION_EXTERNAL_STARTED',
      actor: `account:${w.accountId}`,
      changes: { requirement: 'background_check', adapter: 'fake', round: 1 },
    });
    // the case is submitted by the first evidence of any kind; identity still owes documents
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', background_check: 'PENDING', identity_verification: 'NOT_STARTED' });
    const sub = (await eventsOf(w.caseId)).filter((e) => e.event_type === TRUST_EVENTS.submitted);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.payload_json).toMatchObject({ status: 'ACTION_REQUIRED' });
    expectNoLeak(audits.map((a) => a.changes));
    // idempotent: the same reference, nothing more
    const before = await footprint(w.caseId);
    const again = await svc.startExternalVerification(w.accountId, 'background_check');
    expect(again).toMatchObject({ adapter: 'fake', status: 'PENDING' });
    expect(ext.requests.length).toBe(created0 + 1);
    expect(await footprint(w.caseId)).toEqual(before);
  });

  it('refuses what is not externally evidenced or not applicable, and a disabled provider (EXTERNAL_UNAVAILABLE) without any state change', async () => {
    const w = await opened(['background_check']);
    const before = await footprint(w.caseId);
    await expectError(svc.startExternalVerification(w.accountId, 'identity_verification'), 'EVIDENCE_NOT_ACCEPTED');
    await expectError(svc.startExternalVerification(w.accountId, 'professional_license'), 'REQUIREMENT_NOT_APPLICABLE');
    await expectError(svcDefaults.startExternalVerification(w.accountId, 'background_check'), 'EXTERNAL_UNAVAILABLE');
    const bad = new ScriptedExternal();
    bad.mode = 'throw';
    const logs0 = logSink.lines.length;
    const e = await expectError(mk({ external: bad }).startExternalVerification(w.accountId, 'background_check'), 'EXTERNAL_UNAVAILABLE');
    expect(surface(e)).not.toContain('secret-token');
    expect(logSink.lines.slice(logs0).join('\n')).not.toContain('secret-token');
    expect(await footprint(w.caseId)).toEqual(before);
    expect(await extRow((await inst(w, 'background_check')).case_requirement_id)).toHaveLength(0);
    const x = await mkWorld({ req: ['background_check'] });
    await expectError(svc.startExternalVerification(x.accountId, 'background_check'), 'NOT_FOUND', 'NO_CASE');
  });

  it('cancels the vendor verification when the local transaction fails, and keeps the local state untouched', async () => {
    const w = await opened(['background_check']);
    const before = await footprint(w.caseId);
    await failAudit('VERIFICATION_EXTERNAL_STARTED');
    const cancelled0 = ext.cancelled.length;
    await err(svc.startExternalVerification(w.accountId, 'background_check'));
    expect(await footprint(w.caseId)).toEqual(before);
    expect(ext.cancelled.length).toBe(cancelled0 + 1);
    expect(ext.cancelled.at(-1)).toBe(ext.created.at(-1));
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    expect((await svc.startExternalVerification(w.accountId, 'background_check')).status).toBe('PENDING');
  });

  it('refresh: the first poll is still PENDING (recorded, audited), an APPROVED outcome with an end date approves as external:fake with review, audit and events', async () => {
    const w = await opened(['background_check']);
    await attach(w, 'identity_verification');
    await svc.startExternalVerification(w.accountId, 'background_check');
    await submit(w);
    const bg = await inst(w, 'background_check');
    const id = await inst(w, 'identity_verification');
    const r1 = await svc.refreshExternalVerification(w.accountId, 'background_check');
    expect(r1).toMatchObject({ requirementCode: 'background_check', adapter: 'fake', status: 'PENDING' });
    expect(r1.lastCheckedAt).not.toBeNull();
    expect((await inst(w, 'background_check')).status).toBe('PENDING');
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_EXTERNAL_UPDATED',
      actor: 'external:fake',
      changes: { requirement: 'background_check', externalStatus: 'PENDING' },
    });
    const validUntil = new Date(Math.floor(inDays(365).getTime() / 1000) * 1000);
    const externalId = (await extRow(bg.case_requirement_id))[0]!.external_id;
    ext.setOutcome(externalId, 'APPROVED', validUntil);
    const txCalls = ext.inTx;
    const r2 = await svc.refreshExternalVerification(w.accountId, 'background_check');
    expect(r2.status).toBe('APPROVED');
    expect(ext.inTx).toBe(txCalls);
    expect(await states(w)).toEqual({ case: 'IN_REVIEW', background_check: 'APPROVED', identity_verification: 'PENDING' });
    const done = await inst(w, 'background_check');
    expect(done.expires_at!.getTime()).toBe(validUntil.getTime());
    expect((await reviewsOf(bg.case_requirement_id)).map((v) => [v.decision, v.round, v.reviewer, v.reason_code, v.expires_at?.getTime()])).toEqual([
      ['APPROVED', 1, 'external:fake', null, validUntil.getTime()],
    ]);
    expect((await extRow(bg.case_requirement_id))[0]).toMatchObject({ status: 'APPROVED' });
    const audits = await auditsOf(w.caseId);
    expect(audits.filter((a) => a.action === 'VERIFICATION_APPROVED')).toHaveLength(1);
    expect(audits.find((a) => a.action === 'VERIFICATION_APPROVED')).toMatchObject({
      actor: 'external:fake',
      changes: { requirement: 'background_check', round: 1, caseStatus: ['IN_REVIEW', 'IN_REVIEW'] },
    });
    const approved = (await eventsOf(w.caseId)).filter((e) => e.event_type === TRUST_EVENTS.requirementApproved);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'external:fake',
      payload_json: { requirementCode: 'background_check', requirementType: 'BACKGROUND_CHECK', requirementStatus: 'APPROVED' },
    });
    // a repeat decides nothing again; the staff approve the documents and the case completes exactly once
    const before = (await auditsOf(w.caseId)).filter((a) => a.action === 'VERIFICATION_APPROVED').length;
    await svc.refreshExternalVerification(w.accountId, 'background_check');
    expect((await auditsOf(w.caseId)).filter((a) => a.action === 'VERIFICATION_APPROVED')).toHaveLength(before);
    expect((await reviewsOf(bg.case_requirement_id)).filter((v) => v.decision !== 'STARTED')).toHaveLength(1);
    await approve(w, 'identity_verification');
    expect(await states(w)).toEqual({ case: 'APPROVED', background_check: 'APPROVED', identity_verification: 'APPROVED' });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
    void id;
  });

  it('an approval WITHOUT an end date where one is required goes to IN_REVIEW for staff, who complete it with a date', async () => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    const bg = await inst(w, 'background_check');
    await svc.refreshExternalVerification(w.accountId, 'background_check'); // first poll: PENDING
    const r = await svc.refreshExternalVerification(w.accountId, 'background_check'); // later poll: APPROVED, no end date
    expect(r.status).toBe('APPROVED');
    expect((await inst(w, 'background_check')).status).toBe('IN_REVIEW');
    expect(await reviewsOf(bg.case_requirement_id)).toHaveLength(0);
    expect((await extRow(bg.case_requirement_id))[0]!.status).toBe('APPROVED');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_APPROVED')).toBe(0);
    await expectError(as.approveRequirement(REV1, bg.case_requirement_id, { round: 1 }), 'VALIDATION_FAILED', 'EXPIRY_REQUIRED');
    const done = await svc.approveRequirement(REV1, bg.case_requirement_id, { round: 1, expiresAt: inDays(200).toISOString() });
    expect(done.requirement).toMatchObject({ status: 'APPROVED', external: { adapter: 'fake', status: 'APPROVED' } });
    expect((await reviewsOf(bg.case_requirement_id)).map((v) => [v.decision, v.reviewer])).toEqual([['APPROVED', `admin:${REV1}`]]);
    await svc.refreshExternalVerification(w.accountId, 'background_check');
    expect((await inst(w, 'background_check')).status).toBe('APPROVED');
    expect(await reviewsOf(bg.case_requirement_id)).toHaveLength(1);
    await checkCase(w.caseId);
  });

  it('a REJECTED outcome refuses the requirement as external:fake with OTHER_REVIEW_REQUIRED', async () => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    const bg = await inst(w, 'background_check');
    ext.setOutcome((await extRow(bg.case_requirement_id))[0]!.external_id, 'REJECTED');
    expect((await svc.refreshExternalVerification(w.accountId, 'background_check')).status).toBe('REJECTED');
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', background_check: 'REJECTED', identity_verification: 'NOT_STARTED' });
    expect((await reviewsOf(bg.case_requirement_id)).map((v) => [v.decision, v.reviewer, v.reason_code])).toEqual([
      ['REJECTED', 'external:fake', 'OTHER_REVIEW_REQUIRED'],
    ]);
    const audit = (await auditsOf(w.caseId)).find((a) => a.action === 'VERIFICATION_REJECTED')!;
    expect(audit).toMatchObject({ actor: 'external:fake', reason_code: 'OTHER_REVIEW_REQUIRED' });
    expect((await eventsOf(w.caseId)).find((e) => e.event_type === TRUST_EVENTS.requirementRejected)!.payload_json).toMatchObject({
      reasonCode: 'OTHER_REVIEW_REQUIRED',
      requirementStatus: 'REJECTED',
    });
    expect((await svc.getVerification(w.accountId)).requirements.find((r) => r.requirementCode === 'background_check')).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'OTHER_REVIEW_REQUIRED',
      canAttachEvidence: false,
    });
  });

  it('after a rejection or a reviewer request the provider can start a new external verification in the next round', async () => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    const bg = await inst(w, 'background_check');
    ext.setOutcome((await extRow(bg.case_requirement_id))[0]!.external_id, 'REJECTED');
    await svc.refreshExternalVerification(w.accountId, 'background_check');
    const created0 = ext.requests.length;
    const restarted = await svc.startExternalVerification(w.accountId, 'background_check');
    expect(restarted.status).toBe('PENDING');
    expect(ext.requests.length).toBe(created0 + 1); // a NEW verification was requested
    expect(await inst(w, 'background_check')).toMatchObject({ status: 'PENDING', round: 2 });
    const refs = await extRow(bg.case_requirement_id);
    expect(refs.map((r) => [r.round, r.status])).toEqual([
      [1, 'REJECTED'],
      [2, 'PENDING'],
    ]);
    expect(refs[1]!.external_id).not.toBe(refs[0]!.external_id); // a second adapter reference
    expect(refs[1]!.external_id).toBe(ext.created.at(-1));
    // a reviewer asking for action on a pending external verification lets the provider start over too
    await svc.requestAction(REV1, bg.case_requirement_id, { round: 2, reasonCode: 'REQUIRES_RESUBMISSION' });
    await svc.startExternalVerification(w.accountId, 'background_check');
    expect((await inst(w, 'background_check')).round).toBe(3);
    expect((await extRow(bg.case_requirement_id)).map((r) => r.round)).toEqual([1, 2, 3]);
    // while the round is under way a repeat is idempotent
    const n = ext.requests.length;
    await svc.startExternalVerification(w.accountId, 'background_check');
    expect(ext.requests.length).toBe(n);
  });

  it('refresh refuses without a started verification, with a different adapter, and when the vendor fails; nothing changes', async () => {
    const w = await opened(['background_check']);
    await expectError(svc.refreshExternalVerification(w.accountId, 'background_check'), 'NOT_FOUND', 'NO_EXTERNAL');
    await expectError(svc.refreshExternalVerification(w.accountId, 'professional_license'), 'REQUIREMENT_NOT_APPLICABLE');
    await svc.startExternalVerification(w.accountId, 'background_check');
    const before = await footprint(w.caseId);
    await expectError(svcDefaults.refreshExternalVerification(w.accountId, 'background_check'), 'EXTERNAL_UNAVAILABLE'); // the disabled adapter cannot refresh a 'fake' reference
    const bad = new ScriptedExternal();
    const e = await expectError(mk({ external: bad }).refreshExternalVerification(w.accountId, 'background_check'), 'EXTERNAL_UNAVAILABLE');
    expect(surface(e)).not.toContain('secret-token');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await inst(w, 'background_check')).status).toBe('PENDING');
  });
});

describe('downloadDocument', () => {
  it('audits the access BEFORE the link exists, returns a short link with the policy lifetime, and the audit carries only identifiers', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    await submit(w);
    const seen: number[] = [];
    store.beforeDownload = async () => {
      seen.push(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED'));
    };
    const issued0 = store.issued.length;
    const link = await svc.downloadDocument(REV1, a.documentId);
    expect(seen).toEqual([1]); // the access row was already committed when the link was created
    expect(link.url).toBe(`memory://download/${encodeURIComponent(a.key)}`);
    expect(within(link.expiresAt, Date.now() + 60_000, 15_000)).toBe(true);
    expect(store.issued.slice(issued0)).toEqual([{ kind: 'download', key: a.key, ttlSeconds: 60 }]);
    const acc = (await auditsOf(w.caseId)).filter((x) => x.action === 'VERIFICATION_DOCUMENT_ACCESSED');
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({
      actor: `admin:${REV1}`,
      changes: { verificationDocumentId: a.documentId },
      case_requirement_id: (await inst(w, 'identity_verification')).case_requirement_id,
    });
    expect(Object.keys(acc[0]!.changes!)).toEqual(['verificationDocumentId']);
    expectNoLeak(acc[0]!.changes);
    expect(store.inTx).toEqual([]);
    // every access is a row of its own, by whoever made it; the lifetime follows policy
    await svcMax2.downloadDocument(REV2, a.documentId);
    expect(store.issued.at(-1)).toMatchObject({ kind: 'download', ttlSeconds: 30 });
    expect((await auditsOf(w.caseId)).filter((x) => x.action === 'VERIFICATION_DOCUMENT_ACCESSED').map((x) => x.actor)).toEqual([
      `admin:${REV1}`,
      `admin:${REV2}`,
    ]);
  });

  it('gives no link when the audit write fails, and an audited attempt when the store fails', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    await submit(w);
    const issued0 = store.issued.length;
    await failAudit('VERIFICATION_DOCUMENT_ACCESSED');
    await err(svc.downloadDocument(REV1, a.documentId));
    expect(store.issued.length).toBe(issued0);
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(0);
    await Promise.all(triggersToDrop.splice(0).map((d) => d()));
    store.failDownload = true;
    await expectError(svc.downloadDocument(REV1, a.documentId), 'UNAVAILABLE');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(1);
  });

  it('refuses unknown, pending, withdrawn and abandoned documents and anything not CLEAN, without an audit row; a submitted document can be viewed', async () => {
    const w = await opened([], svcLenient);
    const draft = await attach(w, 'identity_verification');
    const pending = await uploaded(w, 'identity_verification');
    const withdrawn = await attach(w, 'identity_verification');
    await svc.withdrawDocument(w.accountId, withdrawn.documentId);
    scanner.mode = 'error';
    const unscanned = await attach(w, 'identity_verification', { service: svcLenient });
    scanner.mode = 'fake';
    await submit(w, svcLenient);
    expect((await svc.downloadDocument(REV1, draft.documentId)).url).toContain('memory://download/');
    const before = countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED');
    await expectError(svc.downloadDocument(REV1, randomUUID()), 'NOT_FOUND');
    await expectError(svc.downloadDocument(REV1, pending.documentId), 'INVALID_STATE', 'DOCUMENT_NOT_AVAILABLE');
    await expectError(svc.downloadDocument(REV1, withdrawn.documentId), 'INVALID_STATE', 'DOCUMENT_NOT_AVAILABLE');
    await expectError(svc.downloadDocument(REV1, unscanned.documentId), 'SCAN_UNAVAILABLE', 'SCAN_NOT_CLEAN');
    await q(`UPDATE trust.documents SET scan_status = 'INFECTED' WHERE verification_document_id = $1`, [draft.documentId]);
    await expectError(svc.downloadDocument(REV1, draft.documentId), 'SCAN_INFECTED');
    await expectError(svcLenient.downloadDocument(REV1, draft.documentId), 'SCAN_INFECTED');
    expect((await svcLenient.downloadDocument(REV1, unscanned.documentId)).url).toContain('memory://download/'); // clean scans off
    await expectError(svc.downloadDocument('bad subject', draft.documentId), 'VALIDATION_FAILED', 'REVIEWER_INVALID');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(before + 1);
  });
});

describe('staff reads, policy administration and cancel', () => {
  it('listCases returns the queue without keys, links or personal data; filters by status, clamps the limit, oldest submission first', async () => {
    const a = await opened();
    await submitAll(a, ['identity_verification']);
    await sleep(15);
    const b = await opened();
    await submitAll(b, ['identity_verification']);
    const c = await opened(); // OPEN, never submitted
    const inReview = await svc.listCases({ status: 'IN_REVIEW', limit: 100 });
    expect(inReview.every((x) => x.status === 'IN_REVIEW')).toBe(true);
    const ia = inReview.findIndex((x) => x.verificationCaseId === a.caseId);
    const ib = inReview.findIndex((x) => x.verificationCaseId === b.caseId);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ia).toBeLessThan(ib); // a was submitted earlier: the queue is oldest first
    const sb = inReview[ib]!;
    expect(sb).toMatchObject({ accountId: b.accountId, caseNumber: 1, requirementCount: 1, awaitingReviewCount: 1 });
    expect(Object.keys(sb).sort()).toEqual([
      'accountId',
      'awaitingReviewCount',
      'caseNumber',
      'requirementCount',
      'status',
      'submittedAt',
      'updatedAt',
      'verificationCaseId',
    ]);
    expectNoLeak(inReview);
    const open = await svc.listCases({ status: 'OPEN', limit: 100 });
    expect(open.find((x) => x.verificationCaseId === c.caseId)).toMatchObject({ submittedAt: null, awaitingReviewCount: 0, requirementCount: 1 });
    expect((await svc.listCases({ limit: 1 })).length).toBe(1);
    expect((await svc.listCases({ limit: 0 })).length).toBe(1);
    expect((await svc.listCases({ limit: 10_000 })).length).toBeLessThanOrEqual(100);
    await startReview(b, 'identity_verification');
    await approve(b, 'identity_verification');
    expect((await svc.listCases({ status: 'APPROVED', limit: 100 })).find((x) => x.verificationCaseId === b.caseId)).toMatchObject({ awaitingReviewCount: 0 });
  });

  it('getCase shows every cycle, round, review, document metadata with the reviewer hash, external reference; no key, no link, no personal data; NOT_FOUND for an unknown case', async () => {
    const w = await opened(['background_check']);
    const d = await attach(w, 'identity_verification');
    await svc.startExternalVerification(w.accountId, 'background_check');
    await submit(w);
    await startReview(w, 'identity_verification');
    const detail = await svc.getCase(w.caseId);
    expect(detail.case).toMatchObject({
      verificationCaseId: w.caseId,
      accountId: w.accountId,
      caseNumber: 1,
      status: 'IN_REVIEW',
      requirementCount: 2,
      awaitingReviewCount: 2,
      decidedAt: null,
    });
    expect(detail.requirements.map((r) => [r.requirementCode, r.status, r.round, r.superseded])).toEqual([
      ['background_check', 'PENDING', 1, false],
      ['identity_verification', 'IN_REVIEW', 1, false],
    ]);
    const idv = detail.requirements.find((r) => r.requirementCode === 'identity_verification')!;
    expect(idv.documents).toHaveLength(1);
    expect(idv.documents[0]).toMatchObject({ verificationDocumentId: d.documentId, status: 'SUBMITTED', scanStatus: 'CLEAN', round: 1, sha256: sha(d.bytes) });
    expect(idv.reviews.map((r) => [r.decision, r.reviewer])).toEqual([['STARTED', `admin:${REV1}`]]);
    expect(detail.requirements.find((r) => r.requirementCode === 'background_check')!.external).toMatchObject({ adapter: 'fake', status: 'PENDING' });
    expectNoLeak(detail, { allowHash: true });
    expect(JSON.stringify(detail)).not.toContain(a(d.key));
    await expectError(svc.getCase(randomUUID()), 'NOT_FOUND');
    function a(k: string) {
      return k;
    }
  });

  it('getPolicy lists the seeded definitions, document types and rules', async () => {
    const p = await svc.getPolicy();
    expect(p.requirements.map((r) => r.code)).toEqual(['background_check', 'identity_verification', 'liability_insurance', 'professional_license']);
    expect(p.requirements.find((r) => r.code === 'background_check')).toMatchObject({
      requirementType: 'BACKGROUND_CHECK',
      evidenceKind: 'EXTERNAL',
      expiryRequired: true,
    });
    expect(p.requirements.find((r) => r.code === 'identity_verification')).toMatchObject({ evidenceKind: 'DOCUMENT', expiryRequired: false, status: 'ACTIVE' });
    expect(p.documentTypes.map((d) => d.code)).toEqual([
      'business_license',
      'certification',
      'drivers_license',
      'insurance_certificate',
      'passport',
      'professional_license',
      'state_id',
    ]);
    expect(p.rules.find((r) => r.requirementCode === 'identity_verification' && r.marketCode === null)).toEqual({
      requirementCode: 'identity_verification',
      marketCode: null,
      serviceTypeCode: null,
      enabled: true,
    });
  });

  it('setRequirementStatus: audited transition, idempotent repeat, validated transitions and input', async () => {
    const defId = (
      await one<{ requirement_definition_id: string }>(
        "SELECT requirement_definition_id FROM trust.requirement_definitions WHERE code = 'certification_probe' OR code = 'professional_license'",
      )
    ).requirement_definition_id;
    const trail = () =>
      q<AuditDb>(
        'SELECT action, actor, changes, reason_code, case_requirement_id, correlation_id FROM trust.audit_events WHERE requirement_definition_id = $1 ORDER BY occurred_at',
        [defId],
      );
    const n0 = (await trail()).length;
    expect(await svc.setRequirementStatus('admin-sub', 'professional_license', { status: 'INACTIVE' })).toEqual({
      code: 'professional_license',
      status: 'INACTIVE',
      changed: true,
    });
    try {
      expect((await trail()).slice(n0)).toHaveLength(1);
      expect((await trail()).at(-1)).toMatchObject({
        action: 'TRUST_REQUIREMENT_STATUS_CHANGED',
        actor: 'admin:admin-sub',
        changes: { requirement: 'professional_license', status: ['ACTIVE', 'INACTIVE'] },
        case_requirement_id: null,
      });
      expect(await svc.setRequirementStatus('admin-sub', 'professional_license', { status: 'INACTIVE' })).toMatchObject({ changed: false });
      expect((await trail()).length).toBe(n0 + 1);
      expect(await one<{ status: string }>("SELECT status FROM trust.requirement_definitions WHERE code = 'professional_license'")).toEqual({
        status: 'INACTIVE',
      });
    } finally {
      expect((await svc.setRequirementStatus('admin-sub', 'professional_license', { status: 'ACTIVE' })).changed).toBe(true);
    }
    await expectError(svc.setRequirementStatus('admin-sub', 'no_such_code', { status: 'ACTIVE' }), 'NOT_FOUND');
    await expectError(svc.setRequirementStatus('admin-sub', 'professional_license', { status: 'BOGUS' }), 'VALIDATION_FAILED');
    await expectError(svc.setRequirementStatus('admin-sub', 'professional_license', { status: 'ACTIVE', extra: 1 }), 'VALIDATION_FAILED');
    await expectError(svc.setRequirementStatus('bad subject!', 'professional_license', { status: 'INACTIVE' }), 'VALIDATION_FAILED', 'REVIEWER_INVALID');
    expect((await trail()).length).toBe(n0 + 2);
  });

  it('setRequirementRule: upsert, audited once per change, idempotent, one row per scope; unknown targets are validation errors', async () => {
    const w = await mkWorld();
    const defId = (
      await one<{ requirement_definition_id: string }>("SELECT requirement_definition_id FROM trust.requirement_definitions WHERE code = 'liability_insurance'")
    ).requirement_definition_id;
    const trail = () =>
      q<AuditDb>(
        "SELECT action, actor, changes, reason_code, case_requirement_id, correlation_id FROM trust.audit_events WHERE requirement_definition_id = $1 AND action = 'TRUST_RULE_CHANGED' AND changes->>'market' = $2 ORDER BY occurred_at",
        [defId, w.market],
      );
    expect(await rule(w.market, 'liability_insurance', w.types[0]!)).toMatchObject({
      enabled: true,
      changed: true,
      marketCode: w.market,
      serviceTypeCode: w.types[0],
    });
    expect(await rule(w.market, 'liability_insurance', w.types[0]!)).toMatchObject({ changed: false });
    expect((await trail()).map((a) => a.changes)).toEqual([{ requirement: 'liability_insurance', market: w.market, serviceType: w.types[0], enabled: true }]);
    expect((await trail())[0]!.actor).toBe(`admin:${ROOT}`);
    expect(await rule(w.market, 'liability_insurance', w.types[0]!, false)).toMatchObject({ enabled: false, changed: true });
    expect(await rule(w.market, 'liability_insurance', w.types[0]!, false)).toMatchObject({ changed: false });
    expect(await rule(w.market, 'liability_insurance', w.types[0]!, true)).toMatchObject({ changed: true });
    expect((await trail()).map((a) => (a.changes as Record<string, unknown>).enabled)).toEqual([true, false, true]);
    expect(await q('SELECT 1 FROM trust.requirement_rules r JOIN geography.markets m USING (market_id) WHERE m.code = $1', [w.market])).toHaveLength(1);
    // a different scope is a different rule
    await rule(w.market, 'liability_insurance', null);
    expect(await q('SELECT 1 FROM trust.requirement_rules r JOIN geography.markets m USING (market_id) WHERE m.code = $1', [w.market])).toHaveLength(2);
    await expectError(svc.setRequirementRule(ROOT, { requirementCode: 'nope', marketCode: null, serviceTypeCode: null, enabled: true }), 'NOT_FOUND');
    await expectError(
      svc.setRequirementRule(ROOT, { requirementCode: 'liability_insurance', marketCode: 'devtest-missing', serviceTypeCode: null, enabled: true }),
      'VALIDATION_FAILED',
      'UNKNOWN_MARKET',
    );
    await expectError(
      svc.setRequirementRule(ROOT, { requirementCode: 'liability_insurance', marketCode: null, serviceTypeCode: 'missing_type', enabled: true }),
      'VALIDATION_FAILED',
      'UNKNOWN_SERVICE_TYPE',
    );
    await expectError(svc.setRequirementRule(ROOT, { requirementCode: 'liability_insurance', marketCode: null, enabled: true }), 'VALIDATION_FAILED');
    expect((await trail()).length).toBe(4);
  });
});

describe('cancelVerification', () => {
  it('cancels an open, in-review or action-required case: CANCELLED, audited, frozen; a new case is the next number and history stays', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    const rev = (await liveCase(w.accountId))!.revision;
    const r = await svc.cancelVerification(w.accountId);
    expect(r.changed).toBe(true);
    expect(r.view.case).toBeNull();
    expect(r.view.overall.status).toBe('NOT_STARTED');
    const c1 = (await casesOf(w.accountId))[0]!;
    expect(c1).toMatchObject({ status: 'CANCELLED', revision: rev + 1 });
    expect(c1.cancelled_at).not.toBeNull();
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_CASE_CANCELLED',
      actor: `account:${w.accountId}`,
      changes: { status: ['OPEN', 'CANCELLED'] },
    });
    // idempotent
    const before = await footprint(w.caseId);
    expect((await svc.cancelVerification(w.accountId)).changed).toBe(false);
    expect(await footprint(w.caseId)).toEqual(before);
    // frozen: nothing can change the old case
    await expectError(svc.submitVerification(w.accountId, { expectedRevision: 1 }), 'NOT_FOUND', 'NO_CASE');
    expect(await svc.listDocuments(w.accountId)).toEqual([]);
    // next case: number 2, fresh instances, the old rows untouched
    const again = await svc.openVerification(w.accountId);
    expect(again.created).toBe(true);
    const cases = await casesOf(w.accountId);
    expect(cases.map((c) => [c.case_number, c.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'OPEN'],
    ]);
    expect((await docRow(a.documentId)).status).toBe('ATTACHED'); // history stays as it was
    expect((await instancesOf(cases[1]!.verification_case_id)).map((i) => i.status)).toEqual(['NOT_STARTED']);
    // cancel after submission (IN_REVIEW and ACTION_REQUIRED)
    const x = await opened();
    await submitAll(x, ['identity_verification']);
    expect((await svc.cancelVerification(x.accountId)).changed).toBe(true);
    expect((await auditsOf(x.caseId)).at(-1)!.changes).toMatchObject({ status: ['IN_REVIEW', 'CANCELLED'] });
    const y = await opened();
    await submitAll(y, ['identity_verification']);
    await reject(y, 'identity_verification');
    expect((await svc.cancelVerification(y.accountId)).changed).toBe(true);
    expect((await auditsOf(y.caseId)).at(-1)!.changes).toMatchObject({ status: ['ACTION_REQUIRED', 'CANCELLED'] });
  });

  it('refuses an approved case; refuses with no case at all; follows the account state', async () => {
    const w = await opened();
    await submitAll(w, ['identity_verification']);
    await approve(w, 'identity_verification');
    const before = await footprint(w.caseId);
    await expectError(svc.cancelVerification(w.accountId), 'INVALID_STATE', 'HAS_APPROVALS');
    expect(await footprint(w.caseId)).toEqual(before);
    const x = await mkWorld();
    await expectError(svc.cancelVerification(x.accountId), 'NOT_FOUND');
    ctxPort.set(x.accountId, null);
    await expectError(svc.cancelVerification(x.accountId), 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_FOUND');
    const y = await opened();
    await setAccountStatus(y.accountId, 'SUSPENDED');
    await expectError(svc.cancelVerification(y.accountId), 'ACCOUNT_NOT_ACTIVE');
    expect((await liveCase(y.accountId))!.status).toBe('OPEN');
  });

  it('is atomic: a failing audit insert leaves the case live', async () => {
    const w = await opened();
    const before = await footprint(w.caseId);
    await failAudit('VERIFICATION_CASE_CANCELLED');
    await err(svc.cancelVerification(w.accountId));
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await liveCase(w.accountId))!.status).toBe('OPEN');
  });
});

// ================================================================ concurrency (real transactions, real locks)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settle = async (ps: Promise<unknown>[]): Promise<any[]> => Promise.allSettled(ps);
const codeOf = (r: PromiseSettledResult<unknown>): string => (r.status === 'rejected' ? ((r.reason as TrustError).code ?? 'RAW') : 'OK');
/** Counts of the review/audit/event rows of a case, which must agree with each other whatever interleaving produced them. */
async function consistency(caseId: string): Promise<void> {
  const reviews = await q<{ decision: string; n: number }>(
    `SELECT v.decision, count(*)::int AS n FROM trust.reviews v JOIN trust.case_requirements cr USING (case_requirement_id) WHERE cr.verification_case_id = $1 GROUP BY 1`,
    [caseId],
  );
  const n = (d: string) => reviews.find((r) => r.decision === d)?.n ?? 0;
  const actions = await actionsOf(caseId);
  const events = await eventTypesOf(caseId);
  expect(countOf(actions, 'VERIFICATION_APPROVED')).toBe(n('APPROVED'));
  expect(countOf(actions, 'VERIFICATION_REJECTED')).toBe(n('REJECTED'));
  expect(countOf(actions, 'VERIFICATION_ACTION_REQUIRED')).toBe(n('ACTION_REQUIRED'));
  expect(countOf(actions, 'VERIFICATION_REVIEW_STARTED')).toBe(n('STARTED'));
  expect(countOf(events, TRUST_EVENTS.requirementApproved)).toBe(n('APPROVED'));
  expect(countOf(events, TRUST_EVENTS.requirementRejected)).toBe(n('REJECTED'));
  expect(countOf(events, TRUST_EVENTS.actionRequired)).toBe(n('ACTION_REQUIRED'));
  const docs = await q<{ authorized: number; finalized: number }>(
    `SELECT count(*)::int AS authorized, count(doc.finalized_at)::int AS finalized FROM trust.documents doc JOIN trust.case_requirements cr USING (case_requirement_id) WHERE cr.verification_case_id = $1`,
    [caseId],
  );
  expect(countOf(actions, 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED')).toBe(docs[0]!.authorized);
  expect(countOf(actions, 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(docs[0]!.finalized);
  await checkCase(caseId);
}

describe('concurrency', () => {
  it('double finalize: every caller gets the attached document, one audit row, one revision bump', async () => {
    for (let round = 0; round < 4; round++) {
      const w = await opened();
      const { documentId } = await uploaded(w, 'identity_verification');
      const rev0 = (await liveCase(w.accountId))!.revision;
      const rs = await settle(Array.from({ length: 4 }, () => svc.finalizeDocument(w.accountId, documentId)));
      expect(rs.map(codeOf)).toEqual(['OK', 'OK', 'OK', 'OK']);
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(1);
      expect((await liveCase(w.accountId))!.revision).toBe(rev0 + 1);
      expect((await docRow(documentId)).status).toBe('ATTACHED');
    }
  });

  it('withdraw vs finalize: one consistent outcome either way, the object is gone, audit and revision agree', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const w = await opened();
      const { documentId, key } = await uploaded(w, 'identity_verification');
      const rev0 = (await liveCase(w.accountId))!.revision;
      const [f, wd] = await settle([svc.finalizeDocument(w.accountId, documentId), svc.withdrawDocument(w.accountId, documentId)]);
      expect(codeOf(wd)).toBe('OK');
      expect(['OK', 'INVALID_STATE', 'OBJECT_MISSING']).toContain(codeOf(f));
      const row = await docRow(documentId);
      const actions = await actionsOf(w.caseId);
      expect(countOf(actions, 'VERIFICATION_DOCUMENT_REPLACED')).toBe(1);
      if (row.status === 'WITHDRAWN') {
        expect(row.sha256).not.toBeNull();
        expect(countOf(actions, 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(1);
        expect(codeOf(f)).toBe('OK');
      } else {
        expect(row.status).toBe('ABANDONED');
        expect(row.sha256).toBeNull();
        expect(countOf(actions, 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(0);
        expect(codeOf(f)).not.toBe('OK');
      }
      outcomes.add(row.status);
      expect(store.objects.has(key)).toBe(false);
      expect((await liveCase(w.accountId))!.revision).toBe(rev0 + countOf(actions, 'VERIFICATION_DOCUMENT_SUBMITTED') + 1);
      await consistency(w.caseId);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });

  it('submit vs withdraw: the draft is either submitted (and then frozen) or withdrawn (and the submit refused); never both', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const w = await opened();
      const a = await attach(w, 'identity_verification');
      const rev = await revisionOf(w);
      const [s, wd] = await settle([svc.submitVerification(w.accountId, { expectedRevision: rev }), svc.withdrawDocument(w.accountId, a.documentId)]);
      const doc = await docRow(a.documentId);
      const i = await inst(w, 'identity_verification');
      if (codeOf(s) === 'OK') {
        expect(doc).toMatchObject({ status: 'SUBMITTED', round: 1 });
        expect(i.status).toBe('PENDING');
        expect(codeOf(wd)).toBe('INVALID_STATE');
        expect(store.objects.has(a.key)).toBe(true);
      } else {
        expect(['STALE_CASE', 'SUBMISSION_INCOMPLETE']).toContain(codeOf(s));
        expect(codeOf(wd)).toBe('OK');
        expect(doc.status).toBe('WITHDRAWN');
        expect(i).toMatchObject({ status: 'NOT_STARTED', round: 0 });
        expect(store.objects.has(a.key)).toBe(false);
      }
      seen.add(codeOf(s));
      await consistency(w.caseId);
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  it('submit vs a reviewer starting review of another requirement: both apply in either order (a stale revision is retried); the stored status stays derived', async () => {
    for (let round = 0; round < 6; round++) {
      const w = await opened();
      await submitAll(w, ['identity_verification']);
      await rule(w.market, 'liability_insurance');
      await svc.openVerification(w.accountId);
      await attach(w, 'liability_insurance');
      const rev = await revisionOf(w);
      const idv = await inst(w, 'identity_verification');
      const [s, r] = await settle([
        svc.submitVerification(w.accountId, { expectedRevision: rev }),
        svc.startReview(REV1, idv.case_requirement_id, { round: 1 }),
      ]);
      expect(codeOf(r)).toBe('OK');
      if (codeOf(s) !== 'OK') {
        expect(codeOf(s)).toBe('STALE_CASE');
        expect((await svc.submitVerification(w.accountId, { expectedRevision: await revisionOf(w) })).changed).toBe(true);
      }
      expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'IN_REVIEW', liability_insurance: 'PENDING' });
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_SUBMITTED')).toBe(2);
      await consistency(w.caseId);
    }
  });

  it('approve vs reject on the same round: exactly one wins, the loser is ALREADY_DECIDED, one review, one audit row, one event', async () => {
    const winners = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const w = await opened();
      await submitAll(w, ['identity_verification']);
      const i = await inst(w, 'identity_verification');
      const [a, b] = await settle([
        svc.approveRequirement(REV1, i.case_requirement_id, { round: 1 }),
        svc.rejectRequirement(REV2, i.case_requirement_id, { round: 1, reasonCode: 'NAME_MISMATCH' }),
      ]);
      expect([codeOf(a), codeOf(b)].sort()).toEqual(['ALREADY_DECIDED', 'OK']);
      const terminal = (await reviewsOf(i.case_requirement_id)).filter((v) => v.decision !== 'STARTED');
      expect(terminal).toHaveLength(1);
      const approved = codeOf(a) === 'OK';
      winners.add(approved ? 'approve' : 'reject');
      expect(terminal[0]!.decision).toBe(approved ? 'APPROVED' : 'REJECTED');
      expect((await inst(w, 'identity_verification')).status).toBe(approved ? 'APPROVED' : 'REJECTED');
      const types = await eventTypesOf(w.caseId);
      expect(countOf(types, TRUST_EVENTS.requirementApproved)).toBe(approved ? 1 : 0);
      expect(countOf(types, TRUST_EVENTS.requirementRejected)).toBe(approved ? 0 : 1);
      expect(countOf(types, TRUST_EVENTS.completed)).toBe(approved ? 1 : 0);
      expect(await caseStatusOf(w.accountId)).toBe(approved ? 'APPROVED' : 'ACTION_REQUIRED');
      await consistency(w.caseId);
    }
    expect(winners.size).toBeGreaterThanOrEqual(1);
  });

  it('two reviewers: the same decision applies once (the other sees changed:false); two starts record one STARTED review; "completed" is published once', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await opened();
      await submitAll(w, ['identity_verification']);
      const i = await inst(w, 'identity_verification');
      const starts = await settle([svc.startReview(REV1, i.case_requirement_id, { round: 1 }), svc.startReview(REV2, i.case_requirement_id, { round: 1 })]);
      expect(starts.map(codeOf)).toEqual(['OK', 'OK']);
      expect(starts.map((r) => (r as PromiseFulfilledResult<{ changed: boolean }>).value.changed).sort()).toEqual([false, true]);
      const ds = await settle([
        svc.approveRequirement(REV1, i.case_requirement_id, { round: 1 }),
        svc.approveRequirement(REV2, i.case_requirement_id, { round: 1 }),
        svc.approveRequirement('rev-three', i.case_requirement_id, { round: 1 }),
      ]);
      expect(ds.map(codeOf)).toEqual(['OK', 'OK', 'OK']);
      expect(ds.map((r) => (r as PromiseFulfilledResult<{ changed: boolean }>).value.changed).filter(Boolean)).toHaveLength(1);
      expect((await reviewsOf(i.case_requirement_id)).map((v) => v.decision)).toEqual(['STARTED', 'APPROVED']);
      expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
      await consistency(w.caseId);
    }
  });

  it('approve vs the expiry sweep vs a second sweep: each expiry is recorded exactly once, the approval applies, the case ends EXPIRED', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1500;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await sleepUntil(endsAt + 150);
    const idv = await inst(w, 'identity_verification');
    const rs = await settle([
      svc.approveRequirement(REV1, idv.case_requirement_id, { round: 1 }),
      svc.recordExpiries(),
      svc.recordExpiries(),
      svc.recordExpiries(),
    ]);
    expect(rs.map(codeOf)).toEqual(['OK', 'OK', 'OK', 'OK']);
    const swept = rs.slice(1).map((r) => (r as PromiseFulfilledResult<number>).value);
    expect(swept.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await states(w)).toEqual({ case: 'EXPIRED', identity_verification: 'APPROVED', liability_insurance: 'EXPIRED' });
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_EXPIRED')).toBe(1);
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.expired)).toBe(1);
    // whether the case was momentarily APPROVED as a whole (approval applied before the sweep) depends on the order; it is never published twice
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBeLessThanOrEqual(1);
    await consistency(w.caseId);
  });

  // the stored case status follows the EFFECTIVE requirement statuses: an approval whose end has passed counts as ended even before the sweep records it
  it('does not publish "completed" (nor store APPROVED) when approving the last requirement while another approval has already ended', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1500;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await sleepUntil(endsAt + 150);
    await approve(w, 'identity_verification');
    expect((await svc.getVerification(w.accountId)).overall.status).toBe('EXPIRED');
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(0);
    expect(await caseStatusOf(w.accountId)).not.toBe('APPROVED');
    await svc.recordExpiries();
  });

  it('mirror: approving the last requirement while every other approval is still running stores APPROVED and publishes "completed" exactly once', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    await approve(w, 'liability_insurance', { expiresAt: inDays(1) });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(0);
    await approve(w, 'identity_verification');
    expect(await states(w)).toEqual({ case: 'APPROVED', identity_verification: 'APPROVED', liability_insurance: 'APPROVED' });
    expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.completed)).toBe(1);
    expect((await svc.getVerification(w.accountId)).overall.status).toBe('APPROVED');
  });

  it('expiry sweep vs reverify: exactly one VERIFICATION_EXPIRED whichever wins; cycle 2 exists afterwards', async () => {
    for (let round = 0; round < 3; round++) {
      await svc.recordExpiries(500);
      const w = await opened(['liability_insurance']);
      await submitAll(w, ['identity_verification', 'liability_insurance']);
      const endsAt = Date.now() + 1500;
      await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
      await sleepUntil(endsAt + 150);
      const rs = await settle([svc.recordExpiries(), svc.reverifyRequirement(w.accountId, 'liability_insurance'), svc.recordExpiries()]);
      expect(rs.map(codeOf)).toEqual(['OK', 'OK', 'OK']);
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_EXPIRED')).toBe(1);
      expect(countOf(await eventTypesOf(w.caseId), TRUST_EVENTS.expired)).toBe(1);
      expect((await instancesOf(w.caseId, true)).filter((i) => i.code === 'liability_insurance').map((i) => [i.cycle, i.status])).toEqual([
        [1, 'EXPIRED'],
        [2, 'NOT_STARTED'],
      ]);
      await consistency(w.caseId);
    }
  });

  it('a policy change while a provider submits: the submit either includes the new requirement (and is refused as incomplete, nothing persisted) or runs before it; the end state is the same', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const w = await opened();
      await attach(w, 'identity_verification');
      const rev = await revisionOf(w);
      const [s, p] = await settle([svc.submitVerification(w.accountId, { expectedRevision: rev }), rule(w.market, 'liability_insurance')]);
      expect(codeOf(p)).toBe('OK');
      seen.add(codeOf(s));
      if (codeOf(s) === 'OK') expect((await inst(w, 'identity_verification')).status).toBe('PENDING');
      else {
        expect(codeOf(s)).toBe('SUBMISSION_INCOMPLETE');
        expect((s as PromiseRejectedResult).reason.details.codes).toEqual(['liability_insurance']);
        expect((await inst(w, 'identity_verification')).status).toBe('NOT_STARTED');
        expect((await instancesOf(w.caseId, true)).map((i) => i.code)).toEqual(['identity_verification']); // the refused sync left nothing
      }
      // converge: open (sync), attach what is missing, submit what is waiting
      await svc.openVerification(w.accountId);
      await attach(w, 'liability_insurance');
      if (codeOf(s) !== 'OK') await attach(w, 'identity_verification').catch(() => undefined);
      const again = await svc.getVerification(w.accountId);
      if (again.requirements.some((r) => r.canAttachEvidence && r.documents.every((d) => d.status !== 'ATTACHED'))) await attach(w, 'identity_verification');
      await submit(w);
      expect(await states(w)).toEqual({ case: 'IN_REVIEW', identity_verification: 'PENDING', liability_insurance: 'PENDING' });
      await consistency(w.caseId);
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  it('a held case lock makes the provider operation wait, not fail, and it completes after the lock is released', async () => {
    const w = await opened();
    await attach(w, 'identity_verification');
    const tx = await rawTx();
    await tx.query('SELECT 1 FROM trust.verification_cases WHERE verification_case_id = $1 FOR UPDATE', [w.caseId]);
    const rev = await revisionOf(w);
    const pending = svc.submitVerification(w.accountId, { expectedRevision: rev });
    await waitUntilBlocked(1);
    let settled = false;
    void pending.finally(() => (settled = true));
    await sleep(150);
    expect(settled).toBe(false);
    await tx.commit();
    expect((await pending).changed).toBe(true);
  });

  it('lock order: every provider operation queues on the ACCOUNT row first (and completes once it is free); reviewer operations never touch it', async () => {
    const holdAccount = async (accountId: string) => {
      const tx = await rawTx();
      await tx.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
      return tx;
    };
    const heldOp = async (accountId: string, run: () => Promise<unknown>): Promise<unknown> => {
      const tx = await holdAccount(accountId);
      let settled = false;
      const p = run().finally(() => (settled = true));
      await waitUntilBlocked(1);
      await sleep(100);
      expect(settled, 'the operation must wait for the account lock').toBe(false);
      await tx.commit();
      return p;
    };
    const w = await mkWorld();
    await heldOp(w.accountId, () => svc.openVerification(w.accountId));
    const c = (await liveCase(w.accountId))!;
    const up = await uploaded(w, 'identity_verification');
    await heldOp(w.accountId, () => svc.finalizeDocument(w.accountId, up.documentId));
    await heldOp(w.accountId, () =>
      svc.requestUpload(w.accountId, { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 2000 }),
    );
    const extra = await attach(w, 'identity_verification');
    await heldOp(w.accountId, () => svc.withdrawDocument(w.accountId, extra.documentId));
    const rev = await revisionOf(w);
    await heldOp(w.accountId, () => svc.submitVerification(w.accountId, { expectedRevision: rev }));
    // reviewers (case lock only) are not held up by the account row
    const tx = await holdAccount(w.accountId);
    const i = await inst(w, 'identity_verification');
    const outcome = await Promise.race([
      svc.approveRequirement(REV1, i.case_requirement_id, { round: 1 }).then(() => 'done'),
      sleep(3000).then(() => 'timeout'),
    ]);
    expect(outcome).toBe('done');
    await tx.commit();
    await heldOp(w.accountId, () => svc.cancelVerification(w.accountId).catch((e: unknown) => e)); // approved: refused, but only after the account lock
    expect(c.verification_case_id).toBe((await liveCase(w.accountId))!.verification_case_id);
    // the external flow takes the account lock for its write as well
    const x = await opened(['background_check']);
    await heldOp(x.accountId, () => svc.startExternalVerification(x.accountId, 'background_check'));
    await heldOp(x.accountId, () => svc.refreshExternalVerification(x.accountId, 'background_check'));
  });

  it('mixed storm over several accounts: no deadlock, no CONFLICT, only domain refusals, and every case ends consistent', async () => {
    const worlds: (World & { caseId: string })[] = [];
    for (let i = 0; i < 5; i++) worlds.push(await opened(['liability_insurance', 'professional_license']));
    const deadlocks0 = Number((await one<{ d: string }>('SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()')).d);
    const errors: string[] = [];
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const codes = ['identity_verification', 'liability_insurance', 'professional_license'];
    const guarded = async (label: string, f: () => Promise<unknown>): Promise<void> => {
      try {
        await f();
      } catch (e) {
        if (e instanceof TrustError && !['CONFLICT', 'UNAVAILABLE'].includes(e.code)) return;
        errors.push(`${label}: ${surface(e)}`);
      }
    };
    const pick = async (w: World, status?: string) => {
      const c = await liveCase(w.accountId);
      if (!c) return undefined;
      const rows = (await instancesOf(c.verification_case_id)).filter((i) => (status ? i.status === status : true));
      return rows[rnd(rows.length || 1)];
    };
    const ops: ((w: World & { caseId: string }) => Promise<void>)[] = [
      (w) => guarded('open', () => svc.openVerification(w.accountId)),
      (w) => guarded('attach', () => attach(w, codes[rnd(3)]!)),
      (w) => guarded('upload', () => uploaded(w, codes[rnd(3)]!)),
      (w) => guarded('submit', async () => svc.submitVerification(w.accountId, { expectedRevision: await revisionOf(w) })),
      (w) =>
        guarded('withdraw', async () => {
          const docs = await svc.listDocuments(w.accountId);
          const d = docs[rnd(docs.length || 1)];
          if (d) await svc.withdrawDocument(w.accountId, d.verificationDocumentId);
        }),
      (w) =>
        guarded('finalize', async () => {
          const docs = (await svc.listDocuments(w.accountId)).filter((d) => d.status === 'UPLOAD_PENDING');
          if (docs[0]) await svc.finalizeDocument(w.accountId, docs[0].verificationDocumentId);
        }),
      (w) =>
        guarded('review', async () => {
          const i = (await pick(w))!;
          if (!i) return;
          const round = i.round || 1;
          const r = rnd(4);
          if (r === 0) await svc.startReview(REV1, i.case_requirement_id, { round });
          else if (r === 1) await svc.approveRequirement(REV2, i.case_requirement_id, { round, expiresAt: inDays(30).toISOString() });
          else if (r === 2) await svc.rejectRequirement(REV1, i.case_requirement_id, { round, reasonCode: 'DOCUMENT_UNREADABLE' });
          else await svc.requestAction(REV2, i.case_requirement_id, { round, reasonCode: 'REQUIRES_RESUBMISSION' });
        }),
      (w) =>
        guarded('download', async () => {
          const docs = await svc.listDocuments(w.accountId);
          if (docs[0]) await svc.downloadDocument(REV1, docs[rnd(docs.length)]!.verificationDocumentId);
        }),
      (w) =>
        guarded('reads', async () => {
          await svc.getVerification(w.accountId);
          await svc.getCase(w.caseId);
          await svc.listCases({ limit: 5 });
        }),
      (w) => guarded('policy', () => rule(w.market, 'professional_license', null, rnd(2) === 0)),
      () => guarded('sweep', () => svc.recordExpiries(10)),
      (w) =>
        guarded('cancel', async () => {
          if (rnd(6) === 0) await svc.cancelVerification(w.accountId);
        }),
    ];
    for (let round = 0; round < 12; round++) {
      const batch: Promise<void>[] = [];
      for (const w of worlds) for (let k = 0; k < 6; k++) batch.push(ops[rnd(ops.length)]!(w));
      await Promise.all(batch);
    }
    expect(errors).toEqual([]);
    expect(logSink.lines.filter((l) => /deadlock/i.test(l))).toEqual([]);
    await q('SELECT pg_stat_force_next_flush()');
    expect(Number((await one<{ d: string }>('SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()')).d)).toBe(deadlocks0);
    for (const w of worlds) {
      expect((await q('SELECT 1 FROM trust.verification_cases WHERE account_id = $1 AND status <> $2', [w.accountId, 'CANCELLED'])).length).toBeLessThanOrEqual(
        1,
      );
      for (const c of await casesOf(w.accountId)) await consistency(c.verification_case_id);
    }
  });
});

// ================================================================ pins: statements per read, independent of the number of requirements and documents
describe('query counts (no N+1)', () => {
  it('getVerification issues the same number of statements for 1, 2 and 4 requirements and any number of documents, and never opens a transaction', async () => {
    const a = await opened();
    await attach(a, 'identity_verification');
    const b = await opened(['liability_insurance']);
    for (const c of ['identity_verification', 'liability_insurance']) await attach(b, c);
    const c4 = await opened(['liability_insurance', 'professional_license', 'background_check']);
    for (const c of ['identity_verification', 'liability_insurance', 'professional_license']) {
      await attach(c4, c);
      await attach(c4, c);
      await attach(c4, c);
    }
    await svc.startExternalVerification(c4.accountId, 'background_check');
    const counts: number[] = [];
    for (const w of [a, b, c4]) {
      const m = await counting(() => svc.getVerification(w.accountId));
      expect(m.tx).toBe(0);
      expect(m.stmts.every((x) => /^select/i.test(x))).toBe(true);
      counts.push(m.stmts.length);
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(5); // required definitions, live case, document types, current instances, documents
    expect((await svc.getVerification(c4.accountId)).requirements).toHaveLength(4);
    // no case yet: three reads (required, case, document types)
    const none = await mkWorld();
    expect((await counting(() => svc.getVerification(none.accountId))).stmts.length).toBe(3);
    // the document list and the staff read model are constant too
    const l = [await counting(() => svc.listDocuments(a.accountId)), await counting(() => svc.listDocuments(c4.accountId))];
    expect(l.map((x) => x.stmts.length)).toEqual([2, 2]);
    const g = [await counting(() => svc.getCase(a.caseId)), await counting(() => svc.getCase(c4.caseId))];
    expect(g.map((x) => x.stmts.length)).toEqual([5, 5]);
    expect(g[1]!.result.requirements).toHaveLength(4);
  });

  it('opening an existing case is a constant number of statements regardless of its size', async () => {
    const a = await opened();
    const c4 = await opened(['liability_insurance', 'professional_license', 'background_check']);
    const ca = await counting(() => svc.openVerification(a.accountId));
    const cb = await counting(() => svc.openVerification(c4.accountId));
    expect(ca.stmts.length).toBe(cb.stmts.length);
    expect(ca.tx).toBe(1);
    expect(cb.tx).toBe(1);
  });
});

// ================================================================ privacy: nothing sensitive in the trail, the events, the errors or the logs
describe('privacy and log scans', () => {
  it('no key, URL, hash, byte or personal datum in any audit row, outbox payload, thrown error, or log line; no bytes in the database', async () => {
    const audits = await q<Row>('SELECT changes, actor, reason_code FROM trust.audit_events');
    expect(audits.length).toBeGreaterThan(200);
    // the queue is bounded whatever the caller asks for (there are more than 100 cases by now)
    expect(Number((await one<{ n: string }>('SELECT count(*)::text AS n FROM trust.verification_cases')).n)).toBeGreaterThan(100);
    expect((await svc.listCases({ limit: 10_000 })).length).toBe(100);
    expect(leaks(audits)).toEqual([]);
    const events = await q<Row>(`SELECT payload_json, actor_id, aggregate_type FROM integration.outbox_events WHERE event_type LIKE 'bananagig.trust.%'`);
    expect(events.length).toBeGreaterThan(100);
    expect(leaks(events)).toEqual([]);
    expect(thrown.length).toBeGreaterThan(100);
    expect(leaks(thrown.filter((t) => !t.includes('crafted failure')))).toEqual([]);
    expect(logSink.lines.length).toBeGreaterThanOrEqual(0);
    expect(leaks(logSink.lines)).toEqual([]);
    // the database holds metadata only
    expect(await q(`SELECT 1 FROM trust.documents d WHERE d::text LIKE '%PDF-1%' OR d::text LIKE '%synthetic%' LIMIT 1`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM trust.audit_events d WHERE d::text LIKE '%memory://%' OR d::text LIKE '%trust/evidence%' LIMIT 1`)).toHaveLength(0);
    // every stored hash is the hash of bytes that really were uploaded (the server computed it): the stored value is a 64-char hex
    expect(await q(`SELECT 1 FROM trust.documents WHERE sha256 IS NOT NULL AND sha256 !~ '^[0-9a-f]{64}$'`)).toHaveLength(0);
    // the actor of a provider action is the account, of a reviewer an admin identity, of the sweep the system
    const actors = await q<{ actor: string }>('SELECT DISTINCT actor FROM trust.audit_events');
    for (const { actor } of actors) expect(actor).toMatch(/^(account:[0-9a-f-]{36}|admin:[A-Za-z0-9._:@-]+|external:fake|system:expiry)$/);
  });

  it('no provider-facing return carries a hash, a key or a URL except the one-time upload authorization', async () => {
    const w = await opened(['liability_insurance']);
    const returns: unknown[] = [];
    const auth = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: 2000,
    });
    returns.push(auth.document);
    const b = pdf('ret');
    const up = await uploaded(w, 'liability_insurance', { bytes: b });
    returns.push(await svc.finalizeDocument(w.accountId, up.documentId));
    returns.push(await svc.listDocuments(w.accountId), await svc.getVerification(w.accountId));
    returns.push(await attach(w, 'identity_verification').then((x) => x.doc));
    returns.push((await submit(w)).view, (await svc.cancelVerification(w.accountId)).view);
    returns.push((await svc.openVerification(w.accountId)).view);
    expectNoLeak(returns);
    expect(JSON.stringify(returns)).not.toContain(sha(b));
    expect(auth.upload.url).toContain('memory://upload/'); // the one thing allowed to carry the key
  });
});

// ================================================================ review hardening (upload key + promote, lazy cleanup, reviewer rules, expiry clocks, external dates)
describe('upload key separation and promote (the presigned PUT can never change what the reviewers read)', () => {
  /** Authorizes an upload on `s` and plays the uploader on `st` (the PUT lands under the UPLOAD key). */
  async function authorizeOn(s: TrustService, st: MemoryObjectStore, w: { accountId: string }, o: { bytes?: Buffer; mime?: string } = {}) {
    const mime = o.mime ?? 'application/pdf';
    const bytes = o.bytes ?? (mime === 'image/png' ? png() : mime === 'image/jpeg' ? jpeg() : pdf('race'));
    const auth = await s.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: mime,
      sizeBytes: bytes.byteLength,
    });
    const documentId = auth.document.verificationDocumentId;
    const key = await keyOf(documentId);
    st.put(uploadKeyOf(key), bytes, mime);
    return { documentId, key, uploadKey: uploadKeyOf(key), bytes };
  }
  const race = () => {
    const rs = new RaceStore();
    return { rs, s: mk({ store: rs }) };
  };

  it('the upload lands under trust/upload; finalize promotes the exact verified bytes (and content type) to the final key and removes the upload object', async () => {
    const w = await opened();
    for (const mime of ['application/pdf', 'image/jpeg', 'image/png']) {
      const u = await uploaded(w, 'identity_verification', { mime, bytes: mime === 'image/png' ? png() : mime === 'image/jpeg' ? jpeg() : pdf('promote') });
      expect(u.uploadKey).toBe(`trust/upload/${w.caseId}/${u.documentId}`);
      expect(u.key).toBe(`trust/evidence/${w.caseId}/${u.documentId}`);
      expect(store.objects.has(u.uploadKey)).toBe(true);
      expect(store.objects.has(u.key)).toBe(false); // nothing is at the final key before the server promotes it
      await svc.finalizeDocument(w.accountId, u.documentId);
      expect(store.objects.has(u.uploadKey)).toBe(false);
      const final = store.objects.get(u.key)!;
      expect(final.bytes.equals(u.bytes)).toBe(true);
      expect(final.contentType).toBe(mime);
      expect(await docRow(u.documentId)).toMatchObject({ status: 'ATTACHED', sha256: sha(u.bytes) });
    }
  });

  it('a PUT replayed after finalize (ATTACHED, then SUBMITTED) never changes the final object nor the stored hash, and the reviewer link points at the final key', async () => {
    const w = await opened();
    const a = await attach(w, 'identity_verification');
    const finalBytes = Buffer.from(store.objects.get(a.key)!.bytes);
    const row0 = await docRow(a.documentId);
    store.put(uploadKeyOf(a.key), pdf('replayed-1'), 'application/pdf'); // the one-time URL is still valid: the uploader writes again
    expect(store.objects.get(a.key)!.bytes.equals(finalBytes)).toBe(true);
    // finalize is idempotent and never reads the upload key again
    const heads = store.count('head');
    await svc.finalizeDocument(w.accountId, a.documentId);
    expect(store.count('head')).toBe(heads);
    expect((await docRow(a.documentId)).sha256).toBe(row0.sha256);
    await submit(w);
    store.put(uploadKeyOf(a.key), pdf('replayed-2'), 'application/pdf');
    await svc.finalizeDocument(w.accountId, a.documentId);
    expect(store.objects.get(a.key)!.bytes.equals(finalBytes)).toBe(true);
    expect(await docRow(a.documentId)).toMatchObject({ status: 'SUBMITTED', sha256: sha(finalBytes), object_key: a.key });
    const issued0 = store.issued.length;
    await svc.downloadDocument(REV1, a.documentId);
    expect(store.issued.slice(issued0)).toEqual([{ kind: 'download', key: a.key, ttlSeconds: 60 }]);
    expect(a.key.startsWith('trust/evidence/')).toBe(true);
  });

  it('changing the upload object between the versioned read and the copy abandons the document (OBJECT_MISMATCH / OBJECT_CHANGED) and removes both keys', async () => {
    const { rs, s } = race();
    const w = await opened([], s);
    const u = await authorizeOn(s, rs, w);
    rs.afterRead = (key) => rs.put(key, pdf('swapped-after-read'), 'application/pdf');
    await expectError(s.finalizeDocument(w.accountId, u.documentId), 'OBJECT_MISMATCH', 'OBJECT_CHANGED');
    expect(await docRow(u.documentId)).toMatchObject({ status: 'ABANDONED', sha256: null });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
      changes: { verificationDocumentId: u.documentId, reason: 'OBJECT_CHANGED' },
    });
    expect(rs.objects.has(u.key)).toBe(false);
    expect(rs.objects.has(u.uploadKey)).toBe(false);
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_SUBMITTED')).toBe(0);
  });

  it('replacing the upload object right before the copy is refused the same way', async () => {
    const { rs, s } = race();
    const w = await opened([], s);
    const u = await authorizeOn(s, rs, w);
    rs.beforeCopy = (from) => rs.put(from, pdf('swapped-before-copy'), 'application/pdf');
    await expectError(s.finalizeDocument(w.accountId, u.documentId), 'OBJECT_MISMATCH', 'OBJECT_CHANGED');
    expect((await docRow(u.documentId)).status).toBe('ABANDONED');
    expect(rs.objects.has(u.key)).toBe(false);
    expect(rs.objects.has(u.uploadKey)).toBe(false);
  });

  it('what landed at the final key is checked against the hashed bytes: a different or a vanished object abandons the document', async () => {
    const { rs, s } = race();
    const w = await opened([], s);
    const tampered = await authorizeOn(s, rs, w);
    rs.afterCopy = (_from, to) => rs.put(to, Buffer.from(tampered.bytes).fill(0x41, 12), 'application/pdf'); // same length, different bytes
    await expectError(s.finalizeDocument(w.accountId, tampered.documentId), 'OBJECT_MISMATCH', 'OBJECT_CHANGED');
    expect((await docRow(tampered.documentId)).status).toBe('ABANDONED');
    expect(rs.objects.has(tampered.key)).toBe(false); // the tampered final object is removed with the abandon
    expect(rs.objects.has(tampered.uploadKey)).toBe(false);
    const vanished = await authorizeOn(s, rs, w);
    rs.afterCopy = (_from, to) => void rs.objects.delete(to);
    await expectError(s.finalizeDocument(w.accountId, vanished.documentId), 'OBJECT_MISMATCH', 'OBJECT_CHANGED');
    expect((await docRow(vanished.documentId)).status).toBe('ABANDONED');
    // control: with no interference the same service attaches
    rs.afterCopy = undefined;
    const ok = await authorizeOn(s, rs, w);
    expect((await s.finalizeDocument(w.accountId, ok.documentId)).status).toBe('ATTACHED');
  });

  it('store errors map: CHANGED -> OBJECT_CHANGED, TOO_LARGE -> SIZE_MISMATCH (both abandon); UNAVAILABLE and unknown errors -> UNAVAILABLE and the document stays retryable', async () => {
    const { rs, s } = race();
    const w = await opened([], s);
    for (const [code, reason] of [
      ['CHANGED', 'OBJECT_CHANGED'],
      ['TOO_LARGE', 'SIZE_MISMATCH'],
    ] as const) {
      const u = await authorizeOn(s, rs, w);
      rs.readError = new ObjectStoreError(code, 'x');
      await expectError(s.finalizeDocument(w.accountId, u.documentId), 'OBJECT_MISMATCH', reason);
      expect((await docRow(u.documentId)).status).toBe('ABANDONED');
      rs.readError = undefined;
    }
    const logs0 = logSink.lines.length;
    for (const [where, e] of [
      ['readError', new ObjectStoreError('UNAVAILABLE', 'secret store detail trust/upload/x')],
      ['readError', new Error('boom trust/upload/x')],
      ['copyError', new ObjectStoreError('UNAVAILABLE', 'secret store detail')],
      ['copyError', new Error('boom')],
    ] as const) {
      const u = await authorizeOn(s, rs, w);
      const before = await footprint(w.caseId);
      rs[where] = e;
      const te = await expectError(s.finalizeDocument(w.accountId, u.documentId), 'UNAVAILABLE');
      expect(surface(te)).not.toContain('secret store detail');
      expect(surface(te)).not.toContain('trust/');
      expect(await footprint(w.caseId)).toEqual(before);
      expect((await docRow(u.documentId)).status).toBe('UPLOAD_PENDING');
      expect(rs.objects.has(u.key)).toBe(false);
      rs[where] = undefined;
      expect((await s.finalizeDocument(w.accountId, u.documentId)).status).toBe('ATTACHED'); // retryable: the upload object was kept
    }
    expect(logSink.lines.slice(logs0).join('\n')).not.toContain('trust/');
    // an object that vanishes between the HEAD and the versioned read is a missing file (retryable), not a mismatch
    const gone = await authorizeOn(s, rs, w);
    rs.vanishOnRead = true;
    await expectError(s.finalizeDocument(w.accountId, gone.documentId), 'OBJECT_MISSING', 'OBJECT_MISSING');
    expect((await docRow(gone.documentId)).status).toBe('UPLOAD_PENDING');
    rs.vanishOnRead = false;
  });

  it('a failing delete of the upload object after the promotion does not fail the finalize and logs no key', async () => {
    const { rs, s } = race();
    const w = await opened([], s);
    const u = await authorizeOn(s, rs, w);
    rs.failDeleteOf = (key) => key === u.uploadKey;
    const logs0 = logSink.lines.length;
    expect((await s.finalizeDocument(w.accountId, u.documentId)).status).toBe('ATTACHED');
    expect(rs.objects.has(u.key)).toBe(true);
    const lines = logSink.lines.slice(logs0).join('\n');
    expect(lines).toContain('could not delete an upload evidence object');
    expect(lines).not.toContain('trust/');
    expect(lines).not.toContain(u.documentId);
  });

  it('withdraw and abandon remove BOTH keys, also an object a replayed PUT left at the upload key', async () => {
    const w = await opened();
    // withdraw of a pending upload
    const pending = await uploaded(w, 'identity_verification');
    await svc.withdrawDocument(w.accountId, pending.documentId);
    expect((await docRow(pending.documentId)).status).toBe('ABANDONED');
    expect(store.objects.has(pending.uploadKey)).toBe(false);
    expect(store.objects.has(pending.key)).toBe(false);
    // withdraw of an attached draft after the PUT was replayed
    const a = await attach(w, 'identity_verification');
    store.put(uploadKeyOf(a.key), pdf('replayed'), 'application/pdf');
    await svc.withdrawDocument(w.accountId, a.documentId);
    expect(store.objects.has(a.key)).toBe(false);
    expect(store.objects.has(uploadKeyOf(a.key))).toBe(false);
    // abandon (signature mismatch) with a stray object at the final key
    const bad = await uploaded(w, 'identity_verification', { bytes: Buffer.from('<html>not a pdf</html>') });
    store.put(bad.key, Buffer.from('stray'), 'application/pdf');
    await expectError(svc.finalizeDocument(w.accountId, bad.documentId), 'OBJECT_MISMATCH', 'SIGNATURE_MISMATCH');
    expect(store.objects.has(bad.key)).toBe(false);
    expect(store.objects.has(bad.uploadKey)).toBe(false);
  });

  it('the upload URL is presigned for the upload key only, never for the final key', async () => {
    const w = await opened();
    const issued0 = store.issued.length;
    const auth = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    const key = await keyOf(auth.document.verificationDocumentId);
    const mine = store.issued.slice(issued0);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.key).toBe(uploadKeyOf(key));
    expect(mine[0]!.key).not.toBe(key);
    expect(mine.some((x) => x.key.startsWith('trust/evidence/'))).toBe(false);
    expect(auth.upload.url).toBe(`memory://upload/${encodeURIComponent(uploadKeyOf(key))}`);
  });
});

describe('lazy cleanup of expired uploads, and the policy re-check at finalize', () => {
  /** The authorization ended (the store's clock is not the database's: the end of the window is moved by hand). */
  const expire = async (documentId: string): Promise<void> => {
    await withoutTriggers(['trust.documents'], async () => {
      await q("UPDATE trust.documents SET upload_expires_at = now() - interval '1 minute' WHERE verification_document_id = $1", [documentId]);
    });
  };

  it('requestUpload closes the expired UPLOAD_PENDING authorizations of the case (ABANDONED + audit UPLOAD_EXPIRED) and deletes their objects after the commit; other cases and live uploads are untouched', async () => {
    const w = await opened();
    const other = await opened();
    const expired1 = await uploaded(w, 'identity_verification');
    const expired2 = await uploaded(w, 'identity_verification');
    store.put(expired1.key, Buffer.from('stray'), 'application/pdf');
    const live = await uploaded(w, 'identity_verification');
    const foreign = await uploaded(other, 'identity_verification');
    for (const d of [expired1, expired2, foreign]) await expire(d.documentId);
    const del0 = store.count('delete');
    store.inTx.length = 0;
    const audits0 = (await auditsOf(w.caseId)).length;
    const fresh = await svc.requestUpload(w.accountId, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'passport',
      mimeType: 'application/pdf',
      sizeBytes: 50,
    });
    expect(await docRow(expired1.documentId)).toMatchObject({ status: 'ABANDONED', sha256: null });
    expect(await docRow(expired2.documentId)).toMatchObject({ status: 'ABANDONED' });
    expect((await docRow(live.documentId)).status).toBe('UPLOAD_PENDING');
    expect((await docRow(fresh.document.verificationDocumentId)).status).toBe('UPLOAD_PENDING');
    expect((await docRow(foreign.documentId)).status).toBe('UPLOAD_PENDING'); // another case: not this request's business
    const audits = (await auditsOf(w.caseId)).slice(audits0);
    expect(audits.map((a) => a.action)).toEqual([
      'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
      'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
      'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
    ]);
    const refused = audits.filter((a) => a.action === 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED');
    expect(refused.map((a) => (a.changes as { verificationDocumentId: string }).verificationDocumentId).sort()).toEqual(
      [expired1.documentId, expired2.documentId].sort(),
    );
    for (const a of refused) {
      expect(Object.keys(a.changes!).sort()).toEqual(['reason', 'verificationDocumentId']);
      expect(a.changes).toMatchObject({ reason: 'UPLOAD_EXPIRED' });
      expect(a.actor).toBe(`account:${w.accountId}`);
      expect(a.case_requirement_id).toBe((await inst(w, 'identity_verification')).case_requirement_id);
    }
    expectNoLeak(audits.map((a) => a.changes));
    // both keys of each closed document are gone; the live ones stay; the deletes ran outside any transaction
    for (const e of [expired1, expired2]) {
      expect(store.objects.has(e.uploadKey)).toBe(false);
      expect(store.objects.has(e.key)).toBe(false);
    }
    expect(store.objects.has(live.uploadKey)).toBe(true);
    expect(store.objects.has(foreign.uploadKey)).toBe(true);
    expect(store.count('delete') - del0).toBe(4);
    expect(store.inTx).toEqual([]);
    await checkCase(w.caseId);
  });

  it('a request refused after the cleanup (too many documents) rolls the cleanup back: the expired authorizations stay and their objects are not deleted', async () => {
    const w = await opened();
    await attach(w, 'identity_verification');
    await attach(w, 'identity_verification');
    const expired = await uploaded(w, 'identity_verification');
    await expire(expired.documentId);
    const before = await footprint(w.caseId);
    const del0 = store.count('delete');
    await expectError(
      svcMax2.requestUpload(w.accountId, {
        requirementCode: 'identity_verification',
        documentTypeCode: 'passport',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      }),
      'TOO_MANY_DOCUMENTS',
    );
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await docRow(expired.documentId)).status).toBe('UPLOAD_PENDING');
    expect(store.objects.has(expired.uploadKey)).toBe(true);
    expect(store.count('delete')).toBe(del0);
  });

  it('finalize re-checks the MIME allow-list against the CURRENT policy: a type no longer allowed abandons the document before any object is read', async () => {
    const w = await opened();
    const u = await uploaded(w, 'identity_verification', { mime: 'image/png', bytes: png() });
    const pdfOnly = mk({ policy: { allowedMimeTypes: ['application/pdf'] } });
    const heads = store.count('head');
    const reads = store.count('read');
    await expectError(pdfOnly.finalizeDocument(w.accountId, u.documentId), 'MIME_NOT_ALLOWED', 'MIME_NOT_ALLOWED');
    expect(await docRow(u.documentId)).toMatchObject({ status: 'ABANDONED', sha256: null });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
      changes: { verificationDocumentId: u.documentId, reason: 'MIME_NOT_ALLOWED' },
    });
    expect(store.count('head')).toBe(heads);
    expect(store.count('read')).toBe(reads);
    expect(store.objects.has(u.uploadKey)).toBe(false);
    expect(store.objects.has(u.key)).toBe(false);
    // control: a type that is still allowed finalizes under the same narrowed policy
    const ok = await uploaded(w, 'identity_verification');
    expect((await pdfOnly.finalizeDocument(w.accountId, ok.documentId)).status).toBe('ATTACHED');
  });
});

describe('reviewer rules: download, decision replays, external approval', () => {
  it('downloadDocument serves only SUBMITTED documents of a case that is not cancelled: a draft is INVALID_STATE DOCUMENT_NOT_AVAILABLE, with no audit row and no link', async () => {
    const w = await opened();
    const d = await attach(w, 'identity_verification');
    const issued0 = store.issued.length;
    await expectError(svc.downloadDocument(REV1, d.documentId), 'INVALID_STATE', 'DOCUMENT_NOT_AVAILABLE');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(0);
    expect(store.issued.length).toBe(issued0);
    await submit(w);
    expect((await svc.downloadDocument(REV1, d.documentId)).url).toContain('memory://download/');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(1);
    // the case is withdrawn: its submitted documents are no longer served
    await svc.cancelVerification(w.accountId);
    const issued1 = store.issued.length;
    await expectError(svc.downloadDocument(REV1, d.documentId), 'INVALID_STATE', 'DOCUMENT_NOT_AVAILABLE');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_DOCUMENT_ACCESSED')).toBe(1);
    expect(store.issued.length).toBe(issued1);
  });

  it('replaying an APPROVE: the same or an omitted end date is a no-op (changed:false); a DIFFERENT end date, or a date where none was recorded, is ALREADY_DECIDED', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const li = await inst(w, 'liability_insurance');
    const id = await inst(w, 'identity_verification');
    const end = new Date(Math.floor(inDays(90).getTime() / 1000) * 1000);
    expect((await svc.approveRequirement(REV1, li.case_requirement_id, { round: 1, expiresAt: end.toISOString() })).changed).toBe(true);
    expect((await svc.approveRequirement(REV1, id.case_requirement_id, { round: 1 })).changed).toBe(true);
    const before = await footprint(w.caseId);
    expect((await svc.approveRequirement(REV2, li.case_requirement_id, { round: 1, expiresAt: end.toISOString() })).changed).toBe(false);
    expect((await svc.approveRequirement(REV1, li.case_requirement_id, { round: 1 })).changed).toBe(false);
    expect((await svc.approveRequirement(REV1, id.case_requirement_id, { round: 1 })).changed).toBe(false);
    expect(await footprint(w.caseId)).toEqual(before);
    await expectError(
      svc.approveRequirement(REV1, li.case_requirement_id, { round: 1, expiresAt: new Date(end.getTime() + 86_400_000).toISOString() }),
      'ALREADY_DECIDED',
      'ALREADY_DECIDED',
    );
    await expectError(
      svc.approveRequirement(REV1, li.case_requirement_id, { round: 1, expiresAt: new Date(end.getTime() - 86_400_000).toISOString() }),
      'ALREADY_DECIDED',
    );
    await expectError(svc.approveRequirement(REV1, id.case_requirement_id, { round: 1, expiresAt: inDays(30).toISOString() }), 'ALREADY_DECIDED');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await reviewsOf(li.case_requirement_id)).filter((r) => r.decision === 'APPROVED')).toHaveLength(1);
    expect((await inst(w, 'liability_insurance')).expires_at!.getTime()).toBe(end.getTime());
  });

  it('approving an EXTERNAL requirement needs the external reference of that round to be APPROVED; reject and request-action on it are unchanged', async () => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    const bg = await inst(w, 'background_check');
    const approveBody = { round: 1, expiresAt: inDays(200).toISOString() };
    const before = await footprint(w.caseId);
    await expectError(as.approveRequirement(REV1, bg.case_requirement_id, approveBody), 'INVALID_STATE', 'EXTERNAL_NOT_APPROVED'); // PENDING reference
    expect(await footprint(w.caseId)).toEqual(before);
    await startReview(w, 'background_check');
    const inReview = await footprint(w.caseId);
    await expectError(as.approveRequirement(REV1, bg.case_requirement_id, approveBody), 'INVALID_STATE', 'EXTERNAL_NOT_APPROVED'); // IN_REVIEW does not change that
    expect(await footprint(w.caseId)).toEqual(inReview);
    expect((await reviewsOf(bg.case_requirement_id)).filter((r) => r.decision === 'APPROVED')).toHaveLength(0);
    // the provider's own APPROVED (without a usable end date) leaves the completion to staff, who can now approve
    const externalId = (await extRow(bg.case_requirement_id))[0]!.external_id;
    ext.setOutcome(externalId, 'APPROVED', null);
    await svc.refreshExternalVerification(w.accountId, 'background_check');
    expect((await svc.approveRequirement(REV1, bg.case_requirement_id, approveBody)).requirement.status).toBe('APPROVED');
    // reject / request-action do not need the vendor's approval
    const r = await opened(['background_check']);
    await svc.startExternalVerification(r.accountId, 'background_check');
    const rb = await inst(r, 'background_check');
    expect((await svc.rejectRequirement(REV1, rb.case_requirement_id, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' })).requirement.status).toBe('REJECTED');
    const a = await opened(['background_check']);
    await svc.startExternalVerification(a.accountId, 'background_check');
    const ab = await inst(a, 'background_check');
    expect((await svc.requestAction(REV1, ab.case_requirement_id, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' })).requirement.status).toBe(
      'ACTION_REQUIRED',
    );
  });
});

describe('policy sync, cancel and the expiry sweep', () => {
  it('sync supersedes an EXPIRED instance of a definition policy no longer requires, so it cannot keep the case EXPIRED', async () => {
    await svc.recordExpiries(500);
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 1500;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    await approve(w, 'identity_verification');
    await sleepUntil(endsAt + 150);
    expect(await svc.recordExpiries()).toBe(1);
    expect(await caseStatusOf(w.accountId)).toBe('EXPIRED');
    await rule(w.market, 'liability_insurance', null, false);
    await svc.openVerification(w.accountId);
    const rows = (await instancesOf(w.caseId, true)).filter((i) => i.code === 'liability_insurance');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'EXPIRED', cycle: 1 }); // history stays
    expect(rows[0]!.superseded_at).not.toBeNull();
    expect((await instancesOf(w.caseId)).map((i) => i.code)).toEqual(['identity_verification']);
    expect(await caseStatusOf(w.accountId)).toBe('APPROVED');
    expect((await svc.getVerification(w.accountId)).overall).toMatchObject({ status: 'APPROVED', expired: [] });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_REQUIREMENTS_SYNCED',
      changes: { added: [], retired: ['liability_insurance'] },
    });
    await expectError(svc.reverifyRequirement(w.accountId, 'liability_insurance'), 'NOT_REVERIFIABLE');
    expect(await svc.recordExpiries()).toBe(0);
    await checkCase(w.caseId);
  });

  it('cancelVerification is refused while any current instance is APPROVED (HAS_APPROVALS), also in an ACTION_REQUIRED case, and leaves no trace', async () => {
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    await approve(w, 'identity_verification');
    await reject(w, 'liability_insurance');
    expect(await caseStatusOf(w.accountId)).toBe('ACTION_REQUIRED');
    const before = await footprint(w.caseId);
    await expectError(svc.cancelVerification(w.accountId), 'INVALID_STATE', 'HAS_APPROVALS');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await liveCase(w.accountId))!.status).toBe('ACTION_REQUIRED');
    expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_CASE_CANCELLED')).toBe(0);
  });

  it('the sweep ignores instances of CANCELLED cases, and many of them cannot starve a live one (limit)', async () => {
    await svc.recordExpiries(500);
    const cancelled: { caseId: string; reqId: string }[] = [];
    for (let n = 0; n < 3; n++) {
      const c = await opened();
      await submitAll(c, ['identity_verification']);
      await approve(c, 'identity_verification', { expiresAt: inDays(30) });
      const reqId = (await inst(c, 'identity_verification')).case_requirement_id;
      await withoutTriggers(['trust.case_requirements', 'trust.verification_cases'], async () => {
        await q(
          "UPDATE trust.case_requirements SET approved_at = now() - interval '9 days', expires_at = now() - interval '3 days' WHERE case_requirement_id = $1",
          [reqId],
        );
        await q("UPDATE trust.verification_cases SET status = 'CANCELLED', cancelled_at = now() WHERE verification_case_id = $1", [c.caseId]);
      });
      cancelled.push({ caseId: c.caseId, reqId });
    }
    const live = await opened();
    await submitAll(live, ['identity_verification']);
    await approve(live, 'identity_verification', { expiresAt: inDays(30) });
    const liveReq = (await inst(live, 'identity_verification')).case_requirement_id;
    await withoutTriggers(['trust.case_requirements'], async () => {
      await q(
        "UPDATE trust.case_requirements SET approved_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE case_requirement_id = $1",
        [liveReq],
      );
    });
    expect(await svc.recordExpiries(2)).toBe(1); // the two oldest expiries belong to cancelled cases; the live one is still reached
    expect((await inst(live, 'identity_verification')).status).toBe('EXPIRED');
    for (const c of cancelled) {
      expect((await one<{ status: string }>('SELECT status FROM trust.case_requirements WHERE case_requirement_id = $1', [c.reqId])).status).toBe('APPROVED');
      expect(countOf(await actionsOf(c.caseId), 'VERIFICATION_EXPIRED')).toBe(0);
    }
    expect(await svc.recordExpiries(500)).toBe(0);
  });

  it('reverify decides on the DATABASE clock: an application clock ahead of it cannot expire an approval early (NOT_REVERIFIABLE, no trace); once the database agrees it works', async () => {
    await svc.recordExpiries(500);
    const ahead = mk({ now: () => new Date(Date.now() + 3_600_000) });
    const w = await opened(['liability_insurance']);
    await submitAll(w, ['identity_verification', 'liability_insurance']);
    const endsAt = Date.now() + 3000;
    await approve(w, 'liability_insurance', { expiresAt: new Date(endsAt) });
    // the ahead clock already READS it as ended (derived), the database does not
    expect((await ahead.getVerification(w.accountId)).requirements.find((r) => r.requirementCode === 'liability_insurance')).toMatchObject({
      status: 'EXPIRED',
    });
    const before = await footprint(w.caseId);
    await expectError(ahead.reverifyRequirement(w.accountId, 'liability_insurance'), 'NOT_REVERIFIABLE', 'NOT_EXPIRED');
    expect(await footprint(w.caseId)).toEqual(before);
    expect((await inst(w, 'liability_insurance')).status).toBe('APPROVED');
    await sleepUntil(endsAt + 200);
    await ahead.reverifyRequirement(w.accountId, 'liability_insurance');
    expect((await instancesOf(w.caseId, true)).filter((i) => i.code === 'liability_insurance').map((i) => [i.cycle, i.status])).toEqual([
      [1, 'EXPIRED'],
      [2, 'NOT_STARTED'],
    ]);
  });
});

describe('external verification: the end date the provider reports', () => {
  const refreshWith = async (validUntil: Date | null) => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    const bg = await inst(w, 'background_check');
    ext.setOutcome((await extRow(bg.case_requirement_id))[0]!.external_id, 'APPROVED', validUntil);
    const out = await svc.refreshExternalVerification(w.accountId, 'background_check');
    return { w, bg, out };
  };
  const day = 86_400_000;

  it.each([
    ['one hour ahead', () => new Date(Date.now() + 3_600_000)],
    ['30 days ahead', () => new Date(Date.now() + 30 * day)],
    ['3659 days ahead (inside the bound)', () => new Date(Date.now() + 3659 * day)],
  ])('a reported end date %s is used: the requirement is APPROVED by external:fake with that expiry', async (_n, mkDate) => {
    const validUntil = mkDate();
    const { w, bg, out } = await refreshWith(validUntil);
    expect(out.status).toBe('APPROVED');
    const cur = await inst(w, 'background_check');
    expect(cur.status).toBe('APPROVED');
    expect(cur.expires_at!.getTime()).toBe(validUntil.getTime());
    expect((await reviewsOf(bg.case_requirement_id)).map((v) => [v.decision, v.reviewer])).toEqual([['APPROVED', 'external:fake']]);
  });

  it.each([
    ['in the past', () => new Date(Date.now() - day)],
    ['beyond 3660 days', () => new Date(Date.now() + 3661 * day)],
    ['not a date (invalid)', () => new Date('not-a-date')],
  ])(
    'a reported end date %s is not used: an expiry-required approval goes to IN_REVIEW for staff, with the external reference APPROVED and no review or approval audit row',
    async (_n, mkDate) => {
      const { w, bg, out } = await refreshWith(mkDate());
      expect(out.status).toBe('APPROVED'); // the vendor's answer is recorded as it is
      expect(await inst(w, 'background_check')).toMatchObject({ status: 'IN_REVIEW', expires_at: null });
      expect((await extRow(bg.case_requirement_id))[0]!.status).toBe('APPROVED');
      expect(await reviewsOf(bg.case_requirement_id)).toHaveLength(0);
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_APPROVED')).toBe(0);
      expect(countOf(await actionsOf(w.caseId), 'VERIFICATION_EXTERNAL_UPDATED')).toBe(1);
      // staff complete it with a real date
      expect((await svc.approveRequirement(REV1, bg.case_requirement_id, { round: 1, expiresAt: inDays(100).toISOString() })).requirement.status).toBe(
        'APPROVED',
      );
      await checkCase(w.caseId);
    },
  );

  it('when the definition does NOT require an expiry, no date approves without one, but an unusable reported date still goes to staff (it is never silently dropped)', async () => {
    const flip = (required: boolean) =>
      withoutTriggers(['trust.requirement_definitions'], async () => {
        await q('UPDATE trust.requirement_definitions SET expiry_required = $1 WHERE code = $2', [required, 'background_check']);
      });
    await flip(false);
    try {
      const none = await refreshWith(null);
      expect(await inst(none.w, 'background_check')).toMatchObject({ status: 'APPROVED', expires_at: null });
      const stale = await refreshWith(new Date(Date.now() - day));
      expect(await inst(stale.w, 'background_check')).toMatchObject({ status: 'IN_REVIEW', expires_at: null });
      expect(await reviewsOf(stale.bg.case_requirement_id)).toHaveLength(0);
      const good = await refreshWith(new Date(Date.now() + 10 * day));
      expect((await inst(good.w, 'background_check')).status).toBe('APPROVED');
      expect((await inst(good.w, 'background_check')).expires_at).not.toBeNull();
    } finally {
      await flip(true);
    }
  });
});

describe('staff queue order', () => {
  it('listCases is the work queue in the order of the reviewers index: oldest submission first, never-submitted cases last, then by id', async () => {
    const a = await opened();
    await submitAll(a, ['identity_verification']);
    await sleep(15);
    const b = await opened();
    await submitAll(b, ['identity_verification']);
    const c = await opened(); // OPEN: no submission
    const listed = await svc.listCases({ limit: 100 });
    const expected = (
      await q<{ verification_case_id: string }>(
        'SELECT verification_case_id FROM trust.verification_cases ORDER BY submitted_at NULLS LAST, verification_case_id LIMIT 100',
      )
    ).map((r) => r.verification_case_id);
    expect(listed.map((x) => x.verificationCaseId)).toEqual(expected);
    const times = listed.map((x) => (x.submittedAt === null ? Infinity : new Date(x.submittedAt).getTime()));
    expect(times).toEqual([...times].sort((x, y) => x - y)); // ascending, nulls (Infinity) at the end
    const inReview = (await svc.listCases({ status: 'IN_REVIEW', limit: 100 })).map((x) => x.verificationCaseId);
    expect(inReview.indexOf(a.caseId)).toBeGreaterThanOrEqual(0);
    expect(inReview.indexOf(a.caseId)).toBeLessThan(inReview.indexOf(b.caseId));
    const open = (await svc.listCases({ status: 'OPEN', limit: 100 })).map((x) => x.verificationCaseId);
    expect(open).toContain(c.caseId);
  });
});

// ================================================================ policy retirement (last: RETIRED is terminal)
describe('policy administration: retirement', () => {
  it('a RETIRED definition is terminal, cannot be required again, and cases stop asking for it on the next sync', async () => {
    const w = await opened(['background_check']);
    await svc.startExternalVerification(w.accountId, 'background_check');
    expect(await states(w)).toMatchObject({ background_check: 'PENDING' });
    expect(await svc.setRequirementStatus(ROOT, 'background_check', { status: 'RETIRED' })).toEqual({
      code: 'background_check',
      status: 'RETIRED',
      changed: true,
    });
    expect((await svc.setRequirementStatus(ROOT, 'background_check', { status: 'RETIRED' })).changed).toBe(false);
    await expectError(svc.setRequirementStatus(ROOT, 'background_check', { status: 'ACTIVE' }), 'INVALID_STATE', 'STATUS_TRANSITION');
    await expectError(svc.setRequirementStatus(ROOT, 'background_check', { status: 'INACTIVE' }), 'INVALID_STATE', 'STATUS_TRANSITION');
    await expectError(rule(null, 'background_check', null, true), 'CONFLICT', 'RULE_DEFINITION_RETIRED');
    expect((await svc.getVerification(w.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification']);
    await svc.openVerification(w.accountId);
    expect(await states(w)).toEqual({ case: 'ACTION_REQUIRED', background_check: 'NOT_REQUIRED', identity_verification: 'NOT_STARTED' });
    expect((await auditsOf(w.caseId)).at(-1)).toMatchObject({
      action: 'VERIFICATION_REQUIREMENTS_SYNCED',
      changes: { added: [], retired: ['background_check'] },
    });
    // switching a rule OFF for a retired definition is still allowed (it only reduces what is required)
    expect((await rule(w.market, 'background_check', null, false)).enabled).toBe(false);
    // a new case is never asked for it
    const x = await mkWorld();
    expect((await svc.getVerification(x.accountId)).requirements.map((r) => r.requirementCode)).toEqual(['identity_verification']);
  });
});
