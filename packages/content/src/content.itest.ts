// Integration tests: real PostgreSQL (isolated, migrated database: migration 0006 seeds eight shell entries, so every test uses unique keys and
// never assumes an empty registry) and, where noted, real Valkey (pnpm dev:deps). The real-Valkey test self-skips with a logged reason when
// Valkey is unreachable; the same cache behaviours are also covered with MemoryConfigCache, which always runs.
import { createHash } from 'node:crypto';
import { Redis } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryConfigCache, ValkeyConfigCache } from '@bananagig/configuration';
import { CONTENT_EVENTS, ContentEventPayload } from '@bananagig/contracts';
import { createDatabase, sql } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, deferred, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  ContentError,
  ContentService,
  mapDbError,
  type ContentVersion,
  type CreateEntryInput,
  type MarketDefaultsProvider,
  type ScopeReferenceCheck,
  type ScopeReferenceValidator,
} from './index';

let iso: IsolatedDatabase;
let svc: ContentService;
let seq = 0;
const A = 'author-a';
const B = 'approver-b';
const C = 'approver-c';
const key = (name = 'x') => `devtest.t${++seq}.${name}`;
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as ContentError | undefined)?.code;
const err = async (p: Promise<unknown>) => (await rejection(p)) as ContentError;
const dbCode = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const inMs = (ms: number) => new Date(Date.now() + ms);

const entryReq = (k: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key: k,
  contentType: 'UI_LABEL',
  ownerRole: 'CONTENT',
  description: 'neutral test entry',
  approvalPolicy: 'NONE',
  ...over,
});
interface AuthorOpts {
  locale?: string;
  body?: string;
  scopeType?: 'PLATFORM' | 'COUNTRY' | 'MARKET';
  scopeRef?: string | null;
  from?: Date;
  to?: Date;
  author?: string;
  approver?: string;
}
/** create version -> submit -> (approve). Returns the APPROVED version (not yet published). */
async function authorVersion(s: ContentService, k: string, o: AuthorOpts = {}): Promise<ContentVersion> {
  const author = o.author ?? A;
  const v = await s.createVersion(
    k,
    {
      locale: o.locale ?? 'en-US',
      scopeType: o.scopeType ?? 'PLATFORM',
      scopeRef: o.scopeRef ?? null,
      body: o.body ?? `text ${++seq}`,
      effectiveFrom: o.from?.toISOString(),
      effectiveTo: o.to?.toISOString(),
      reason: 'integration test',
    },
    author,
  );
  const submitted = await s.submit(v.versionId, author);
  return submitted.status === 'IN_REVIEW' ? s.approve(v.versionId, o.approver ?? B) : submitted;
}
/** create version -> submit -> (approve) -> publish. Returns the published (or scheduled) version. */
async function publishNew(s: ContentService, k: string, o: AuthorOpts = {}): Promise<ContentVersion> {
  const v = await authorVersion(s, k, o);
  return s.publish(v.versionId, o.author ?? A);
}
/** A dedicated database for tests that call activateDue() (it acts on ALL due versions) or need exact event counts. */
async function withFreshService(fn: (s: ContentService, d: IsolatedDatabase) => Promise<void>) {
  const fresh = await createIsolatedDatabase();
  try {
    await fn(new ContentService({ database: fresh.database, env: 'test', allowTestKeys: true }), fresh);
  } finally {
    await fresh.drop();
  }
}
const outbox = (type: string, d: IsolatedDatabase = iso) =>
  d.database.query<{ payload_json: Record<string, unknown>; aggregate_type: string; aggregate_id: string; actor_type: string; correlation_id: string }>(
    'SELECT payload_json, aggregate_type, aggregate_id, actor_type, correlation_id FROM integration.outbox_events WHERE event_type = $1 ORDER BY created_at, outbox_event_id',
    [type],
  );
const audit = (entryKey: string, d: IsolatedDatabase = iso) =>
  d.database.query<{
    action: string;
    actor: string;
    locale: string | null;
    version_id: string | null;
    previous_version_id: string | null;
    reason: string | null;
    correlation_id: string;
  }>(
    `SELECT a.action, a.actor, a.locale, a.version_id, a.previous_version_id, a.reason, a.correlation_id FROM content.audit_events a
       JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [entryKey],
  );
const rows = (versionIds: string[], d: IsolatedDatabase = iso) =>
  d.database.query<{ version_id: string; version: number; status: string; effective_from: Date; effective_to: Date | null }>(
    'SELECT version_id, version, status, effective_from, effective_to FROM content.versions WHERE version_id = ANY($1::uuid[]) ORDER BY version',
    [versionIds],
  );
/** Waits until some session of this database is blocked on a lock (a deterministic "the second caller is queued" signal). */
async function waitForBlockedSession(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= 1) return;
    await sleep(50);
  }
  throw new Error('no session ever blocked on a lock');
}
const entryIdOf = async (k: string) => (await q<{ entry_id: string }>('SELECT entry_id FROM content.entries WHERE key = $1', [k]))[0]!.entry_id;
const insertVersionSql = (entryId: string, version: number, over: { locale?: string; status?: string } = {}) =>
  q(
    `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
     VALUES ($1, $2, 'PLATFORM', NULL, $3, 'direct sql', $4, 'NONE', now(), 'direct', 'sql')`,
    [entryId, over.locale ?? 'en-US', version, over.status ?? 'DRAFT'],
  );

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  svc = new ContentService({ database: iso.database, env: 'test', allowTestKeys: true, cacheTtlSeconds: 30 });
});
afterAll(async () => iso.drop());

// ====================================================================== 13. create entry
describe('entries (13)', () => {
  it('has the content schema, the seeded en-US platform default and the seeded shell entries', async () => {
    const tables = (await q<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'content' ORDER BY 1")).map((r) => r.t);
    expect(tables).toEqual(['audit_events', 'entries', 'entry_variables', 'locales', 'snapshot_items', 'snapshots', 'version_approvals', 'versions']);
    expect(await svc.listLocales()).toEqual([
      { locale: 'en-US', displayName: 'English (United States)', language: 'en', script: null, region: 'US', isActive: true, isPlatformDefault: true },
    ]);
    const seeded = (await svc.listEntries()).map((e) => e.key);
    expect(seeded).toEqual(expect.arrayContaining(['brand.name', 'common.action.sign_in', 'session.error.login_failed']));
    expect((await svc.resolve('brand.name', { locale: 'en-US' })).body).toBe('BananaGig'); // seeded copy resolves through the real lifecycle rows
  });

  it('creates an entry with typed variables, defaults, and an ENTRY_CREATED audit row', async () => {
    const k = key('welcome');
    const e = await svc.createEntry(
      entryReq(k, {
        contentType: 'PLAIN_TEXT',
        approvalPolicy: undefined,
        variables: [
          { name: 'name', type: 'PERSON_DISPLAY_NAME', description: 'display name', example: 'Ana Perez', piiClass: 'PERSONAL' },
          { name: 'total', type: 'MONEY', description: 'amount', example: { amount_minor: 1250, currency: 'USD' }, required: false },
        ],
      }),
      A,
    );
    expect(e).toMatchObject({
      key: k,
      contentType: 'PLAIN_TEXT',
      ownerRole: 'CONTENT',
      sensitivity: 'PUBLIC',
      criticality: 'STANDARD',
      approvalPolicy: 'OWNER_APPROVAL',
      fallbackPolicy: 'CHAIN',
      maxScopeType: 'PLATFORM',
      isActive: true,
      createdBy: A,
    });
    expect(e.variables).toEqual([
      { name: 'name', type: 'PERSON_DISPLAY_NAME', required: true, description: 'display name', example: 'Ana Perez', piiClass: 'PERSONAL' },
      { name: 'total', type: 'MONEY', required: false, description: 'amount', example: { amount_minor: 1250, currency: 'USD' }, piiClass: 'NONE' },
    ]);
    expect((await audit(k)).map((r) => [r.action, r.actor])).toEqual([['ENTRY_CREATED', A]]);
    expect((await svc.getEntry(k)).entry).toEqual(e);
    expect((await svc.listEntries({ ownerRole: 'CONTENT', contentType: 'PLAIN_TEXT' })).map((x) => x.key)).toContain(k);
  });

  it('rejects duplicate keys, devtest keys outside dev/test and unknown entries', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    expect(await code(svc.createEntry(entryReq(k), A))).toBe('CONFLICT');
    const prod = new ContentService({ database: db(), env: 'production', allowTestKeys: false });
    expect(await code(prod.createEntry(entryReq(key()), A))).toBe('VALIDATION_FAILED');
    expect(await code(svc.getEntry('devtest.never.created'))).toBe('ENTRY_NOT_FOUND');
    expect(await code(svc.setEntryActive('devtest.never.created', false, 'r', A))).toBe('ENTRY_NOT_FOUND');
  });

  it('deactivating an entry hides it from resolution and blocks new versions; reactivation restores it; no-op changes write nothing', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'visible' });
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('visible');
    expect((await svc.setEntryActive(k, false, 'retired', A)).isActive).toBe(false);
    expect(await code(svc.resolve(k, { locale: 'en-US' }))).toBe('ENTRY_NOT_FOUND');
    expect(await code(svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A))).toBe('INVALID_STATE');
    await svc.setEntryActive(k, false, 'again', A); // no-op
    expect((await svc.setEntryActive(k, true, 'restored', B)).isActive).toBe(true);
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('visible');
    expect((await audit(k)).map((r) => r.action).filter((a) => a.startsWith('ENTRY_'))).toEqual(['ENTRY_CREATED', 'ENTRY_DEACTIVATED', 'ENTRY_ACTIVATED']);
  });

  it('the database keeps entry identity, policy and variables immutable (only is_active changes)', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { variables: [{ name: 'n', type: 'COUNT', description: 'd', example: 1 }] }), A);
    const id = await entryIdOf(k);
    for (const set of [
      "content_type = 'PLAIN_TEXT'",
      "key = 'devtest.renamed.key'",
      "approval_policy = 'OWNER_APPROVAL'",
      "criticality = 'CRITICAL'",
      "sensitivity = 'INTERNAL'",
      "fallback_policy = 'EXACT'",
      "owner_role = 'LEGAL'",
      "max_scope_type = 'MARKET'",
      "description = 'changed'",
    ])
      expect(await dbCode(q(`UPDATE content.entries SET ${set} WHERE entry_id = $1`, [id])), set).toBe('23000');
    expect(await dbCode(q('UPDATE content.entries SET is_active = false WHERE entry_id = $1', [id]))).toBeUndefined();
    expect(await dbCode(q('DELETE FROM content.entries WHERE entry_id = $1', [id]))).toBe('23000');
    expect(await dbCode(q("UPDATE content.entry_variables SET description = 'x' WHERE entry_id = $1", [id]))).toBe('23000');
    expect(await dbCode(q('DELETE FROM content.entry_variables WHERE entry_id = $1', [id]))).toBe('23000');
  });

  it('a required variable cannot be added once the entry has versions (the database says so); an optional one can', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const id = await entryIdOf(k);
    const add = (name: string, required: boolean) =>
      q(
        "INSERT INTO content.entry_variables (entry_id, name, var_type, is_required, description, example_value) VALUES ($1, $2, 'STRING', $3, 'd', '\"x\"'::jsonb)",
        [id, name, required],
      );
    await add('early_required', true); // fine: no versions yet
    await publishNew(svc, k);
    expect(await dbCode(add('late_required', true))).toBe('23000');
    expect(await dbCode(add('late_optional', false))).toBeUndefined();
  });
});

// ====================================================================== 14. create locale version
describe('locales and versions (14)', () => {
  it('registers locales (inactive by default), audits them with no entry, and cannot deactivate the platform default', async () => {
    const cid = `corr-locale-${seq}`;
    await runWithCorrelation(cid, async () => {
      expect(await svc.registerLocale({ locale: 'fr-ca', reason: 'launch Quebec' }, A)).toEqual({
        locale: 'fr-CA',
        displayName: 'French (Canada)',
        language: 'fr',
        script: null,
        region: 'CA',
        isActive: false,
        isPlatformDefault: false,
      });
      expect(await svc.registerLocale({ locale: 'it-IT', active: true, reason: 'launch Italy' }, A)).toMatchObject({ isActive: true });
    });
    expect(await code(svc.registerLocale({ locale: 'fr-CA', reason: 'dup' }, A))).toBe('CONFLICT');
    expect(await code(svc.registerLocale({ locale: 'fr_CA', reason: 'bad' }, A))).toBe('VALIDATION_FAILED');
    expect((await svc.setLocaleActive('fr-CA', true, 'go live', B)).isActive).toBe(true);
    expect((await svc.setLocaleActive('fr-CA', false, 'pause', B)).isActive).toBe(false);
    await svc.setLocaleActive('fr-CA', false, 'no-op', B);
    expect(await code(svc.setLocaleActive('en-US', false, 'no', A))).toBe('VALIDATION_FAILED');
    expect(await code(svc.setLocaleActive('xx-YY', true, 'no', A))).toBe('LOCALE_NOT_FOUND');
    // the database refuses it independently of the service (since GEO-001 the geography guard fires first because en-US is the default of the ACTIVE country US: 23000; before it was the check constraint, 23514)
    expect(await dbCode(q("UPDATE content.locales SET is_active = false WHERE locale = 'en-US'"))).toBe('23000');
    expect(await dbCode(q("DELETE FROM content.locales WHERE locale = 'fr-CA'"))).toBe('23000');
    expect(await dbCode(q("UPDATE content.locales SET locale = 'fr-FR' WHERE locale = 'fr-CA'"))).toBe('23000');
    const la = await q<{ action: string; locale: string; entry_id: string | null; version_id: string | null; actor: string; correlation_id: string }>(
      "SELECT action, locale, entry_id, version_id, actor, correlation_id FROM content.audit_events WHERE locale IN ('fr-CA', 'it-IT') AND action LIKE 'LOCALE\\_%' ORDER BY occurred_at, audit_event_id",
    );
    expect(la.map((r) => [r.action, r.locale])).toEqual([
      ['LOCALE_REGISTERED', 'fr-CA'],
      ['LOCALE_REGISTERED', 'it-IT'],
      ['LOCALE_ACTIVATED', 'it-IT'],
      ['LOCALE_ACTIVATED', 'fr-CA'],
      ['LOCALE_DEACTIVATED', 'fr-CA'],
    ]);
    expect(la.every((r) => r.entry_id === null && r.version_id === null)).toBe(true);
    expect(la.slice(0, 3).every((r) => r.correlation_id === cid && r.actor === A)).toBe(true);
    expect((await svc.listLocales({ activeOnly: true })).map((l) => l.locale)).toEqual(expect.arrayContaining(['en-US', 'it-IT']));
    expect((await svc.listLocales({ activeOnly: true })).map((l) => l.locale)).not.toContain('fr-CA');
  });

  it('creates drafts: numbering per holder, sha-256 of the body, audit, and a locale that must be registered', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
    const v1 = await svc.createVersion(k, { locale: 'en-US', body: 'Hello ünïcode ✓', reason: 'first' }, A);
    expect(v1).toMatchObject({
      entryKey: k,
      locale: 'en-US',
      scopeType: 'PLATFORM',
      scopeRef: null,
      version: 1,
      status: 'DRAFT',
      approvalPolicy: 'NONE',
      createdBy: A,
      reason: 'first',
    });
    expect(v1.bodySha256).toBe(sha('Hello ünïcode ✓'));
    const v2 = await svc.createVersion(k, { locale: 'en-US', body: 'Hello again', reason: 'second' }, A);
    const m1 = await svc.createVersion(k, { locale: 'en-US', scopeType: 'MARKET', scopeRef: 'us-ca', body: 'Hello CA', reason: 'market' }, A);
    expect([v2.version, m1.version]).toEqual([2, 1]); // numbering is per (locale, scope, scope reference)
    expect(await code(svc.createVersion(k, { locale: 'de-DE', body: 'Hallo', reason: 'r' }, A))).toBe('LOCALE_NOT_FOUND');
    expect(await code(svc.createVersion('devtest.nope.nope', { locale: 'en-US', body: 'x', reason: 'r' }, A))).toBe('ENTRY_NOT_FOUND');
    // the locale of a version event is not repeated in the audit row (it is reached through the version); only locale actions store one
    expect((await audit(k)).filter((r) => r.action === 'VERSION_DRAFTED').map((r) => [r.locale, r.reason])).toEqual([
      [null, 'first'],
      [null, 'second'],
      [null, 'market'],
    ]);
    expect((await svc.getEntry(k)).versions.map((v) => [v.scopeType, v.version])).toEqual([
      ['MARKET', 1],
      ['PLATFORM', 1],
      ['PLATFORM', 2],
    ]);
  });

  it('enforces the entry scope limit (service and database) and scope reference rules', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { maxScopeType: 'COUNTRY' }), A);
    expect(await code(svc.createVersion(k, { locale: 'en-US', scopeType: 'MARKET', scopeRef: 'us-ca', body: 'x', reason: 'r' }, A))).toBe('SCOPE_NOT_ALLOWED');
    expect(await code(svc.createVersion(k, { locale: 'en-US', scopeType: 'COUNTRY', body: 'x', reason: 'r' }, A))).toBe('VALIDATION_FAILED');
    expect(await code(svc.createVersion(k, { locale: 'en-US', scopeType: 'PLATFORM', scopeRef: 'US', body: 'x', reason: 'r' }, A))).toBe('VALIDATION_FAILED');
    expect((await svc.createVersion(k, { locale: 'en-US', scopeType: 'COUNTRY', scopeRef: 'US', body: 'x', reason: 'r' }, A)).scopeType).toBe('COUNTRY');
    const id = await entryIdOf(k);
    expect(
      await dbCode(
        q(
          "INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, approval_policy, effective_from, reason, created_by) VALUES ($1, 'en-US', 'MARKET', 'us-ca', 1, 'x', 'NONE', now(), 'r', 'u')",
          [id],
        ),
      ),
    ).toBe('23000');
    // content has no CATEGORY/GIG/... scopes at all
    expect(['23000', '23514']).toContain(
      await dbCode(
        q(
          "INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, approval_policy, effective_from, reason, created_at, created_by) VALUES ($1, 'en-US', 'GIG', 'g1', 1, 'x', 'NONE', now(), 'r', now(), 'u')",
          [id],
        ),
      ),
    );
  });

  it('validates the template against the entry variables and content type before anything is written', async () => {
    const k = key();
    await svc.createEntry(
      entryReq(k, {
        contentType: 'UI_LABEL',
        variables: [
          { name: 'count', type: 'COUNT', description: 'items', example: 2 },
          { name: 'label', type: 'STRING', description: 'text', example: 'x', required: false },
        ],
      }),
      A,
    );
    const attempt = (body: string) => svc.createVersion(k, { locale: 'en-US', body, reason: 'r' }, A);
    expect((await err(attempt('Hello {nope}'))).details).toMatchObject({ reason: 'UNKNOWN_VARIABLE', variable: 'nope' });
    expect((await err(attempt('{label, plural, other {x}}'))).details).toMatchObject({ reason: 'PLURAL_REQUIRES_COUNT' });
    expect((await err(attempt('line one\nline two'))).details).toMatchObject({ reason: 'CONTENT_TYPE_RULE' });
    expect((await err(attempt('Hello {count'))).details).toMatchObject({ reason: 'SYNTAX' });
    expect(await code(attempt('x'.repeat(501)))).toBe('TEMPLATE_ERROR');
    expect(await code(attempt('bad \u0007 control'))).toBe('TEMPLATE_ERROR');
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.versions WHERE entry_id = $1', [await entryIdOf(k)]))[0]!.n)).toBe(0);
    expect((await attempt('{count, plural, one {# item} other {# items}} {label}')).version).toBe(1); // an unreferenced/optional variable is fine
    const md = key();
    await svc.createEntry(entryReq(md, { contentType: 'MARKDOWN' }), A);
    expect((await err(svc.createVersion(md, { locale: 'en-US', body: '[x](javascript:alert(1))', reason: 'r' }, A))).details).toMatchObject({
      reason: 'UNSAFE_LINK',
    });
  });

  it('validates the effective window: not in the past (beyond 5 seconds), end after start', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const make = (extra: { effectiveFrom?: string; effectiveTo?: string }) => svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r', ...extra }, A);
    expect(await code(make({ effectiveFrom: inMs(-60_000).toISOString() }))).toBe('VALIDATION_FAILED');
    expect(await code(make({ effectiveFrom: inMs(60_000).toISOString(), effectiveTo: inMs(30_000).toISOString() }))).toBe('VALIDATION_FAILED');
    expect(await code(make({ effectiveFrom: inMs(60_000).toISOString(), effectiveTo: inMs(60_000).toISOString() }))).toBe('VALIDATION_FAILED');
    expect((await make({ effectiveFrom: inMs(-2_000).toISOString() })).status).toBe('DRAFT'); // within the clock tolerance
    const windowed = await make({ effectiveFrom: inMs(60_000).toISOString(), effectiveTo: inMs(120_000).toISOString() });
    expect(windowed.effectiveTo!.getTime() - windowed.effectiveFrom.getTime()).toBe(60_000);
  });

  it('a registered but inactive locale can be authored and published, but never served; activating it serves it at once', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await svc.registerLocale({ locale: 'pt-BR', reason: 'prep' }, A);
    await publishNew(svc, k, { locale: 'en-US', body: 'english' });
    await publishNew(svc, k, { locale: 'pt-BR', body: 'portugues' });
    expect(await svc.resolve(k, { locale: 'pt-BR' })).toMatchObject({
      resolvedLocale: 'en-US',
      body: 'english',
      fallback: { applied: true, chain: ['en-US'] },
    });
    await svc.setLocaleActive('pt-BR', true, 'go live', A);
    expect(await svc.resolve(k, { locale: 'pt-BR' })).toMatchObject({ resolvedLocale: 'pt-BR', body: 'portugues', fallback: { applied: false } });
  });
});

// ====================================================================== 15. approval workflow
describe('approval workflow (15)', () => {
  it('policy NONE: submit approves automatically (events + audit); only the author may submit or cancel', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'NONE' }), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A);
    expect(await code(svc.submit(d.versionId, B))).toBe('FORBIDDEN_APPROVER');
    expect(await code(svc.cancel(d.versionId, B))).toBe('FORBIDDEN_APPROVER');
    expect((await svc.submit(d.versionId, A)).status).toBe('APPROVED');
    expect(await code(svc.submit(d.versionId, A))).toBe('INVALID_STATE');
    expect((await audit(k)).map((r) => r.action)).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_SUBMITTED', 'VERSION_APPROVED']);
    expect((await outbox(CONTENT_EVENTS.versionApproved)).some((e) => e.aggregate_id === d.versionId)).toBe(true);
  });

  it('OWNER_APPROVAL: submit goes to review, approve makes it APPROVED, decisions are recorded once', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A);
    expect(await code(svc.approve(d.versionId, B))).toBe('INVALID_STATE'); // still a draft
    expect((await svc.submit(d.versionId, A)).status).toBe('IN_REVIEW');
    expect(await code(svc.cancel(d.versionId, B))).toBe('FORBIDDEN_APPROVER');
    expect((await svc.approve(d.versionId, B, 'looks good')).status).toBe('APPROVED');
    expect(await code(svc.approve(d.versionId, C))).toBe('INVALID_STATE');
    expect(await code(svc.reject(d.versionId, C))).toBe('INVALID_STATE');
    const decisions = await q<{ approver: string; decision: string; comment: string | null }>(
      'SELECT approver, decision, comment FROM content.version_approvals WHERE version_id = $1',
      [d.versionId],
    );
    expect(decisions).toEqual([{ approver: B, decision: 'APPROVE', comment: 'looks good' }]);
    expect(await svc.getVersion(d.versionId)).toMatchObject({ status: 'APPROVED' });
  });

  it('reject records the decision; a rejected, cancelled or draft version can never be published', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
    const rej = await svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A);
    await svc.submit(rej.versionId, A);
    expect((await svc.reject(rej.versionId, B, 'wrong tone')).status).toBe('REJECTED');
    const can = await svc.createVersion(k, { locale: 'en-US', body: 'y', reason: 'r' }, A);
    expect((await svc.cancel(can.versionId, A)).status).toBe('CANCELLED');
    const draft = await svc.createVersion(k, { locale: 'en-US', body: 'z', reason: 'r' }, A);
    for (const v of [rej, can, draft]) expect(await code(svc.publish(v.versionId, A))).toBe('INVALID_STATE');
    expect(await code(svc.cancel(rej.versionId, A))).toBe('INVALID_STATE');
    expect((await audit(k)).map((r) => r.action)).toEqual(expect.arrayContaining(['VERSION_REJECTED', 'VERSION_CANCELLED']));
    expect(
      await q("SELECT 1 FROM content.version_approvals WHERE version_id = $1 AND decision = 'REJECT' AND comment = 'wrong tone'", [rej.versionId]),
    ).toHaveLength(1);
  });

  it('an approved version can still be cancelled by its author before publication', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v = await authorVersion(svc, k);
    expect((await svc.cancel(v.versionId, A)).status).toBe('CANCELLED');
    expect(await code(svc.publish(v.versionId, A))).toBe('INVALID_STATE');
  });

  it('double approval: two approvers racing record exactly one decision, and the loser is told the state', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A);
    await svc.submit(d.versionId, A);
    const results = await Promise.all([rejection(svc.approve(d.versionId, B)), rejection(svc.approve(d.versionId, C)), rejection(svc.approve(d.versionId, B))]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    for (const r of results.filter(Boolean)) expect((r as ContentError).code).toBe('INVALID_STATE');
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.version_approvals WHERE version_id = $1', [d.versionId]))[0]!.n)).toBe(1);
    expect((await outbox(CONTENT_EVENTS.versionApproved)).filter((e) => e.aggregate_id === d.versionId)).toHaveLength(1);
  });

  it('the database enforces the lifecycle even for direct SQL', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: 'x', reason: 'r' }, A);
    const set = (status: string, id = d.versionId) => q('UPDATE content.versions SET status = $2 WHERE version_id = $1', [id, status]);
    for (const s of ['APPROVED', 'PUBLISHED', 'SCHEDULED', 'SUPERSEDED', 'REJECTED']) expect(await dbCode(set(s)), `DRAFT -> ${s}`).toBe('23000'); // DRAFT -> APPROVED needs policy NONE
    await svc.submit(d.versionId, A);
    expect(await dbCode(set('APPROVED')), 'IN_REVIEW -> APPROVED without a decision').toBe('23000');
    expect(await dbCode(set('REJECTED')), 'IN_REVIEW -> REJECTED without a decision').toBe('23000');
    expect(await dbCode(set('PUBLISHED'))).toBe('23000');
    // decisions are only accepted while IN_REVIEW, and are immutable
    await svc.approve(d.versionId, B);
    expect(await dbCode(q("INSERT INTO content.version_approvals (version_id, approver, decision) VALUES ($1, 'late', 'APPROVE')", [d.versionId]))).toBe(
      '23000',
    );
    expect(await dbCode(q("UPDATE content.version_approvals SET decision = 'REJECT' WHERE version_id = $1", [d.versionId]))).toBe('23000');
    expect(await dbCode(q('DELETE FROM content.version_approvals WHERE version_id = $1', [d.versionId]))).toBe('23000');
    expect(await dbCode(set('DRAFT'))).toBe('23000');
    expect(await dbCode(set('IN_REVIEW'))).toBe('23000');
  });
});

// ====================================================================== 16/17. publish and resolve
describe('publish and resolve (16, 17)', () => {
  it('full lifecycle: entry -> locale version -> approve -> publish -> resolve, with the exact audit trail and events', async () => {
    const k = key('lifecycle');
    const cid = `corr-lifecycle-${seq}`;
    const final = await runWithCorrelation(cid, async () => {
      await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
      const d = await svc.createVersion(k, { locale: 'en-US', body: 'Welcome to the lifecycle', reason: 'initial copy' }, A);
      await svc.submit(d.versionId, A);
      await svc.approve(d.versionId, B, 'ok');
      return svc.publish(d.versionId, C);
    });
    expect(final).toMatchObject({ status: 'PUBLISHED', version: 1, effectiveTo: null });
    expect(final.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now());
    const r = await svc.resolve(k, { locale: 'en-US' });
    expect(r).toMatchObject({
      key: k,
      body: 'Welcome to the lifecycle',
      bodySha256: sha('Welcome to the lifecycle'),
      versionId: final.versionId,
      version: 1,
      sourceScope: 'PLATFORM',
      scopeRef: null,
      requestedLocale: 'en-US',
      resolvedLocale: 'en-US',
      fallback: { applied: false, chain: ['en-US'] },
      contentType: 'UI_LABEL',
      sensitivity: 'PUBLIC',
      criticality: 'STANDARD',
    });
    const trail = await audit(k);
    expect(trail.map((a) => a.action)).toEqual([
      'ENTRY_CREATED',
      'VERSION_DRAFTED',
      'VERSION_SUBMITTED',
      'VERSION_APPROVED',
      'VERSION_PUBLISHED',
      'VERSION_ACTIVATED',
    ]);
    expect(trail.map((a) => a.actor)).toEqual([A, A, A, B, C, C]);
    expect(trail.every((a) => a.correlation_id === cid)).toBe(true);
    expect(trail.filter((a) => a.action.startsWith('VERSION_')).every((a) => a.version_id === final.versionId && a.locale === null)).toBe(true);
    const published = (await outbox(CONTENT_EVENTS.versionPublished)).filter((e) => e.aggregate_id === final.versionId);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ aggregate_type: 'content_version', actor_type: 'user', correlation_id: cid });
    expect(await code(svc.publish(final.versionId, C))).toBe('INVALID_STATE'); // already published
  });

  it('a new version closes its predecessor at the same instant and supersedes it; versions never overlap', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await publishNew(svc, k, { body: 'one' });
    const v2 = await publishNew(svc, k, { body: 'two' });
    const v3 = await publishNew(svc, k, { body: 'three' });
    const r = await rows([v1.versionId, v2.versionId, v3.versionId]);
    expect(r.map((x) => x.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'PUBLISHED']);
    expect(r[0]!.effective_to?.getTime()).toBe(r[1]!.effective_from.getTime());
    expect(r[1]!.effective_to?.getTime()).toBe(r[2]!.effective_from.getTime());
    expect(r[2]!.effective_to).toBeNull();
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('three');
    const sup = (await audit(k)).filter((a) => a.action === 'VERSION_SUPERSEDED');
    expect(sup.map((a) => a.version_id)).toEqual([v1.versionId, v2.versionId]);
    const pub = (await audit(k)).filter((a) => a.action === 'VERSION_PUBLISHED');
    expect(pub.map((a) => a.previous_version_id)).toEqual([null, v1.versionId, v2.versionId]);
    const events = (await outbox(CONTENT_EVENTS.versionPublished)).filter((e) => [v1, v2, v3].some((v) => v.versionId === e.aggregate_id));
    expect(events.map((e) => e.payload_json.previousVersionId)).toEqual([null, v1.versionId, v2.versionId]);
  });

  it('timeline rules: a stale (lower-numbered) version loses to a published later one; a start in the past starts at publication; explicit ends are respected', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const stale = await authorVersion(svc, k, { body: 'stale' });
    const winner = await authorVersion(svc, k, { body: 'winner' });
    await svc.publish(winner.versionId, A);
    const e = await err(svc.publish(stale.versionId, A));
    expect(e).toMatchObject({ code: 'CONFLICT', details: { latestVersion: 2 } });
    expect((await svc.getVersion(stale.versionId)).status).toBe('APPROVED'); // untouched; it can be cancelled or superseded by a new draft
    // an approved version whose proposed start has passed (slow approval) starts at publication time
    const slow = await authorVersion(svc, k, { body: 'slow', from: inMs(1_000) });
    await sleep(1_300);
    const published = await svc.publish(slow.versionId, A);
    expect(published.effectiveFrom.getTime()).toBeGreaterThan(slow.effectiveFrom.getTime());
    expect(published.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now());
    expect(published.status).toBe('PUBLISHED');
    // an explicit end that is already behind the start is refused
    const ended = await authorVersion(svc, k, { body: 'ended', from: inMs(500), to: inMs(1_500) });
    await sleep(1_700);
    expect(await code(svc.publish(ended.versionId, A))).toBe('CONFLICT');
  });

  it('a head with an explicit end blocks an overlapping successor (service rule) and allows one that starts at or after the end', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const limited = await publishNew(svc, k, { body: 'limited', to: inMs(3_000) });
    expect(limited.effectiveTo).not.toBeNull();
    const overlapping = await authorVersion(svc, k, { body: 'overlapping' });
    expect(await code(svc.publish(overlapping.versionId, A))).toBe('CONFLICT');
    const after = await authorVersion(svc, k, { body: 'after', from: limited.effectiveTo! });
    const sched = await svc.publish(after.versionId, A);
    expect(sched.status).toBe('SCHEDULED');
    expect(sched.effectiveFrom.getTime()).toBe(limited.effectiveTo!.getTime());
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('limited');
    expect((await svc.resolve(k, { locale: 'en-US', at: new Date(limited.effectiveTo!.getTime() + 1) })).body).toBe('after');
  });

  it('resolves the platform value, and market/country overrides only for those contexts, most specific first', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
    await publishNew(svc, k, { body: 'platform' });
    await publishNew(svc, k, { body: 'country US', scopeType: 'COUNTRY', scopeRef: 'US' });
    await publishNew(svc, k, { body: 'market ca', scopeType: 'MARKET', scopeRef: 'us-ca' });
    const body = async (context: { country?: string; market?: string }) => (await svc.resolve(k, { locale: 'en-US', context })).body;
    expect(await body({})).toBe('platform');
    expect(await body({ country: 'US' })).toBe('country US');
    expect(await body({ country: 'CA' })).toBe('platform');
    expect(await body({ market: 'us-ny' })).toBe('platform');
    expect(await body({ market: 'us-ca' })).toBe('market ca');
    expect(await body({ country: 'US', market: 'us-ca' })).toBe('market ca');
    expect(await body({ country: 'US', market: 'us-ny' })).toBe('country US');
    expect(await svc.resolve(k, { locale: 'en-US', context: { market: 'us-ca' } })).toMatchObject({ sourceScope: 'MARKET', scopeRef: 'us-ca' });
  });

  it('renders resolved copy with typed variables (plural, money, escaping) and returns the exact version used', async () => {
    const k = key('basket');
    await svc.createEntry(
      entryReq(k, {
        contentType: 'MARKDOWN',
        variables: [
          { name: 'count', type: 'COUNT', description: 'items', example: 2 },
          { name: 'total', type: 'MONEY', description: 'amount', example: { amount_minor: 1250, currency: 'USD' } },
          { name: 'name', type: 'PERSON_DISPLAY_NAME', description: 'who', example: 'Ana', piiClass: 'PERSONAL', required: false },
        ],
      }),
      A,
    );
    const v = await publishNew(svc, k, { body: '**{name}**: {count, plural, one {# item} other {# items}} for {total}' });
    const r = await svc.resolveRendered([k], {
      locale: 'en-US',
      variables: { [k]: { count: 3, total: { amount_minor: 123456, currency: 'USD' }, name: '<script>alert(1)</script>' } },
    });
    expect(r.items.get(k)).toMatchObject({
      format: 'html',
      value: '<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>: 3 items for $1,234.56</p>',
      versionId: v.versionId,
      resolvedLocale: 'en-US',
      bodySha256: v.bodySha256,
    });
    expect((await svc.render(k, { locale: 'en-US', variables: { count: 1, total: { amount_minor: 5, currency: 'USD' } } })).value).toContain(
      ': 1 item for $0.05',
    ); // optional name omitted
    expect(await code(svc.render(k, { locale: 'en-US', variables: { count: 1 } }))).toBe('TEMPLATE_ERROR'); // missing required total
    expect(await code(svc.render(k, { locale: 'en-US', variables: { count: 1, total: { amount_minor: 5, currency: 'USD' }, other: 1 } }))).toBe(
      'TEMPLATE_ERROR',
    );
  });

  it('INTERNAL entries are hidden like unknown ones when the caller asks for public visibility only', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { sensitivity: 'INTERNAL' }), A);
    await publishNew(svc, k, { body: 'staff only' });
    expect((await svc.resolve(k, { locale: 'en-US' })).sensitivity).toBe('INTERNAL');
    expect(await code(svc.resolve(k, { locale: 'en-US', includeInternal: false }))).toBe('ENTRY_NOT_FOUND');
  });

  it('reports unknown entries and entries without content per key; resolve() throws the typed errors', async () => {
    const empty = key();
    await svc.createEntry(entryReq(empty), A);
    const ok = key();
    await svc.createEntry(entryReq(ok), A);
    await publishNew(svc, ok, { body: 'here' });
    const r = await svc.resolveMany([ok, empty, 'devtest.never.created'], { locale: 'en-US' });
    expect([...r.items.keys()]).toEqual([ok]);
    expect(Object.fromEntries(r.missing)).toEqual({ [empty]: 'NO_CONTENT', 'devtest.never.created': 'ENTRY_NOT_FOUND' });
    expect(await code(svc.resolve(empty, { locale: 'en-US' }))).toBe('NO_CONTENT');
    expect(await code(svc.resolve('devtest.never.created', { locale: 'en-US' }))).toBe('ENTRY_NOT_FOUND');
    expect(await code(svc.resolve(ok, { locale: 'en_US' }))).toBe('VALIDATION_FAILED');
  });
});

// ====================================================================== 18/19. scheduled publication
describe('scheduled publication (18, 19)', () => {
  it('future-scheduled content does not resolve early, and resolves after its instant without any job running', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'current' });
    const from = inMs(1_500);
    const next = await publishNew(svc, k, { body: 'next', from });
    expect(next.status).toBe('SCHEDULED');
    expect(next.effectiveFrom.getTime()).toBe(from.getTime());
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('current');
    expect((await svc.resolve(k, { locale: 'en-US', at: new Date(from.getTime() - 1) })).body).toBe('current');
    expect((await svc.resolve(k, { locale: 'en-US', at: from })).body).toBe('next'); // half-open interval: effective AT its start
    expect((await svc.resolve(k, { locale: 'en-US', at: new Date(from.getTime() + 60_000) })).versionId).toBe(next.versionId);
    await sleep(Math.max(0, from.getTime() - Date.now()) + 150);
    expect(await svc.resolve(k, { locale: 'en-US' })).toMatchObject({ body: 'next', versionId: next.versionId });
    expect((await svc.getVersion(next.versionId)).status).toBe('SCHEDULED'); // the workflow marker lags; resolution never depended on it
    const events = await outbox(CONTENT_EVENTS.versionScheduled);
    expect(events.filter((e) => e.aggregate_id === next.versionId)).toHaveLength(1);
    expect((await outbox(CONTENT_EVENTS.versionPublished)).some((e) => e.aggregate_id === next.versionId)).toBe(false);
  });

  it('activateDue: runs once per version (sequentially and concurrently), supersedes the predecessor, emits exactly one event', () =>
    withFreshService(async (s, fresh) => {
      const k = key();
      await s.createEntry(entryReq(k), A);
      const v1 = await publishNew(s, k, { body: 'one' });
      const v2 = await publishNew(s, k, { body: 'two', from: inMs(1_200) });
      expect(await s.activateDue()).toBe(0); // not due yet
      await sleep(1_400);
      const total = (await Promise.all([s.activateDue(), s.activateDue(), s.activateDue()])).reduce((x, y) => x + y, 0);
      expect(total).toBe(1);
      expect(await s.activateDue()).toBe(0);
      const r = await fresh.database.query<{ version: number; status: string }>(
        'SELECT version, status FROM content.versions WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1) ORDER BY version',
        [k],
      );
      expect(r.map((x) => x.status)).toEqual(['SUPERSEDED', 'PUBLISHED']);
      const events = (await outbox(CONTENT_EVENTS.versionPublished, fresh)).filter((e) => e.aggregate_id === v2.versionId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_type: 'system' });
      expect(events[0]!.payload_json.previousVersionId).toBe(v1.versionId);
      const actions = (await audit(k, fresh)).map((a) => a.action);
      expect(actions.filter((a) => a === 'VERSION_ACTIVATED')).toHaveLength(2); // v1 at its immediate publication, v2 by the job
      expect(actions.filter((a) => a === 'VERSION_SUPERSEDED')).toHaveLength(1);
      const act = (await audit(k, fresh)).filter((a) => a.version_id === v2.versionId && a.action === 'VERSION_ACTIVATED');
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ actor: 'system:content-activation', reason: 'scheduled activation', previous_version_id: v1.versionId });
      expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('two');
    }));

  it('activateDue handles several holders and is skipped for entries another transaction is working on', () =>
    withFreshService(async (s, fresh) => {
      const [k1, k2] = [key('a'), key('b')];
      for (const k of [k1, k2]) {
        await s.createEntry(entryReq(k), A);
        await publishNew(s, k, { body: 'base' });
        await publishNew(s, k, { body: 'later', from: inMs(1_000) });
      }
      await sleep(1_200);
      // hold k1's entry row: its activation is deferred (SKIP LOCKED), k2's is not
      const held = deferred();
      const holding = deferred();
      const blocker = fresh.database.transaction(async (trx) => {
        await sql`SELECT 1 FROM content.entries WHERE key = ${k1} FOR UPDATE`.execute(trx);
        holding.resolve();
        await held.promise;
      });
      await holding.promise;
      expect(await s.activateDue()).toBe(1);
      held.resolve();
      await blocker;
      expect(await s.activateDue()).toBe(1);
      expect(await s.activateDue()).toBe(0);
    }));
});

// ====================================================================== 20. overlap
describe('overlapping publication (20)', () => {
  it('the database exclusion constraint rejects overlapping published periods for one holder', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await publishNew(svc, k, { body: 'one' });
    const second = await authorVersion(svc, k, { body: 'two' }); // APPROVED, not published
    // direct SQL publishes it without closing v1: the periods overlap
    const e = (await rejection(q("UPDATE content.versions SET status = 'PUBLISHED' WHERE version_id = $1", [second.versionId]))) as {
      code?: string;
      constraint?: string;
    };
    expect(e.code).toBe('23P01');
    expect(e.constraint).toBe('ex_versions__no_overlap');
    expect((await svc.getVersion(second.versionId)).status).toBe('APPROVED');
    // the service publishes it correctly: it closes v1 at the new start first
    expect((await svc.publish(second.versionId, A)).status).toBe('PUBLISHED');
    expect((await svc.getVersion(v1.versionId)).status).toBe('SUPERSEDED');
    // the same period is fine for another holder (another locale) and for unpublished rows
    await svc.registerLocale({ locale: 'ro-RO', reason: 'r' }, A);
    expect((await publishNew(svc, k, { locale: 'ro-RO', body: 'ro' })).status).toBe('PUBLISHED');
  });

  it('is only about PUBLISHED rows: drafts and approved versions of a holder may share any period', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'live' });
    const a = await authorVersion(svc, k, { body: 'a' });
    const b = await authorVersion(svc, k, { body: 'b' });
    expect([a.status, b.status]).toEqual(['APPROVED', 'APPROVED']);
  });

  it('duplicate version numbers are rejected by the database; the service numbers after any existing row', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await publishNew(svc, k, { body: 'one' });
    const id = await entryIdOf(k);
    await insertVersionSql(id, 2); // a competing writer took number 2
    expect(await dbCode(insertVersionSql(id, v1.version))).toBe('23505');
    expect(await dbCode(insertVersionSql(id, 2))).toBe('23505');
    expect((await svc.createVersion(k, { locale: 'en-US', body: 'next', reason: 'r' }, A)).version).toBe(3);
  });

  it('published periods can be changed only by the guarded transitions (SQL cannot stretch, reopen or move them)', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await publishNew(svc, k, { body: 'one' });
    const v2 = await publishNew(svc, k, { body: 'two' });
    // v1 was closed by the service; its end cannot be reopened or moved
    expect(await dbCode(q('UPDATE content.versions SET effective_to = NULL WHERE version_id = $1', [v1.versionId]))).toBe('23000');
    expect(await dbCode(q("UPDATE content.versions SET effective_to = effective_to + interval '1 hour' WHERE version_id = $1", [v1.versionId]))).toBe('23000');
    // v2 is open-ended: it can be closed once, never twice
    expect(await dbCode(q("UPDATE content.versions SET effective_to = now() + interval '1 day' WHERE version_id = $1", [v2.versionId]))).toBeUndefined();
    expect(await dbCode(q("UPDATE content.versions SET effective_to = now() + interval '2 days' WHERE version_id = $1", [v2.versionId]))).toBe('23000');
  });
});

// ====================================================================== 21. concurrency
describe('concurrent publication and version creation (21)', () => {
  it('publishing the same version three times concurrently yields exactly one publication and one event', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v = await authorVersion(svc, k);
    const results = await Promise.all([rejection(svc.publish(v.versionId, A)), rejection(svc.publish(v.versionId, A)), rejection(svc.publish(v.versionId, A))]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    for (const r of results.filter(Boolean)) expect((r as ContentError).code).toBe('INVALID_STATE');
    expect((await outbox(CONTENT_EVENTS.versionPublished)).filter((e) => e.aggregate_id === v.versionId)).toHaveLength(1);
    expect((await audit(k)).filter((a) => a.action === 'VERSION_PUBLISHED')).toHaveLength(1);
  });

  it('two versions of one holder published concurrently: the later-numbered one wins and the stale one is refused (deterministic interleaving)', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await authorVersion(svc, k, { body: 'older' });
    const v2 = await authorVersion(svc, k, { body: 'newer' });
    const entered = deferred();
    const release = deferred();
    // v2's publication holds the entry lock until we say so; v1's publication queues behind it
    const winner = db().transaction(async () => {
      await svc.publish(v2.versionId, A);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const loser = rejection(svc.publish(v1.versionId, A));
    await waitForBlockedSession();
    release.resolve();
    await winner;
    const e = (await loser) as ContentError;
    expect(e).toBeInstanceOf(ContentError);
    expect(e).toMatchObject({ code: 'CONFLICT', details: { latestVersion: 2 } });
    const r = await rows([v1.versionId, v2.versionId]);
    expect(r.map((x) => x.status)).toEqual(['APPROVED', 'PUBLISHED']);
    expect((await svc.resolve(k, { locale: 'en-US' })).body).toBe('newer');
    expect((await outbox(CONTENT_EVENTS.versionPublished)).filter((x) => x.aggregate_id === v1.versionId)).toHaveLength(0);
  });

  it('the opposite order is also safe: the older version published first, the newer one then supersedes it', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await authorVersion(svc, k, { body: 'older' });
    const v2 = await authorVersion(svc, k, { body: 'newer' });
    const entered = deferred();
    const release = deferred();
    const first = db().transaction(async () => {
      await svc.publish(v1.versionId, A);
      entered.resolve();
      await sleep(30); // make sure the newer publication starts strictly later (millisecond clock)
      await release.promise;
    });
    await entered.promise;
    const second = svc.publish(v2.versionId, A);
    await waitForBlockedSession();
    release.resolve();
    await first;
    expect((await second).status).toBe('PUBLISHED');
    expect((await rows([v1.versionId, v2.versionId])).map((x) => x.status)).toEqual(['SUPERSEDED', 'PUBLISHED']);
  });

  it('many versions of one holder published concurrently: no overlap, a gap-free chain, one open-ended head, losers get CONFLICT', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const versions: ContentVersion[] = [];
    for (let i = 0; i < 6; i++) versions.push(await authorVersion(svc, k, { body: `race ${i}` }));
    const results = await Promise.all(versions.map((v) => rejection(svc.publish(v.versionId, A))));
    const ok = results.filter((r) => r === undefined).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    for (const e of results.filter(Boolean)) expect((e as ContentError).code).toBe('CONFLICT');
    const published = (await rows(versions.map((v) => v.versionId))).filter((r) => r.status === 'PUBLISHED' || r.status === 'SUPERSEDED');
    expect(published).toHaveLength(ok);
    published.slice(0, -1).forEach((r, i) => expect(r.effective_to?.getTime()).toBe(published[i + 1]!.effective_from.getTime()));
    expect(published.at(-1)).toMatchObject({ status: 'PUBLISHED', effective_to: null });
    expect(published.slice(0, -1).every((r) => r.status === 'SUPERSEDED')).toBe(true);
    expect((await svc.resolve(k, { locale: 'en-US' })).versionId).toBe(published.at(-1)!.version_id);
  });

  it('concurrent version creation is serialized per entry: contiguous unique numbers per holder, no failures (deterministic interleaving)', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const entered = deferred<ContentVersion>();
    const release = deferred();
    const first = db().transaction(async () => {
      const v = await svc.createVersion(k, { locale: 'en-US', body: 'first', reason: 'r' }, A);
      entered.resolve(v);
      await release.promise;
      return v;
    });
    await entered.promise;
    const second = svc.createVersion(k, { locale: 'en-US', body: 'second', reason: 'r' }, B);
    await waitForBlockedSession();
    release.resolve();
    const [a, b] = [await first, await second];
    expect([a.version, b.version]).toEqual([1, 2]);
    // and without a barrier: eight at once
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => svc.createVersion(k, { locale: 'en-US', body: `many ${i}`, reason: 'r' }, A)));
    expect(many.map((v) => v.version).sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    await svc.registerLocale({ locale: 'nl-NL', reason: 'r' }, A);
    const nl = await Promise.all([1, 2, 3].map((i) => svc.createVersion(k, { locale: 'nl-NL', body: `nl ${i}`, reason: 'r' }, A)));
    expect(nl.map((v) => v.version).sort((x, y) => x - y)).toEqual([1, 2, 3]); // numbering is per locale
  });
});

// ====================================================================== 22. batch = 3 queries
describe('batch resolution (22)', () => {
  it('resolves any number of keys with exactly 3 queries, and 0 once cached', async () => {
    let queries = 0;
    const counting = await createIsolatedDatabase({ database: { onQuery: () => queries++ } });
    try {
      const s = new ContentService({ database: counting.database, env: 'test', allowTestKeys: true });
      const keys: string[] = [];
      for (let i = 0; i < 20; i++) {
        const k = `devtest.batch.k${i}`;
        keys.push(k);
        await s.createEntry(entryReq(k), A);
        await publishNew(s, k, { body: `text ${i}` });
      }
      keys.push('brand.name'); // seeded copy in the same batch
      queries = 0;
      const r = await s.resolveMany(keys, { locale: 'en-US', context: { country: 'US', market: 'us-ca' } });
      expect(r.items.size).toBe(21);
      expect(queries).toBe(3);
      queries = 0;
      await s.resolveMany(keys.slice(0, 2), { locale: 'es-MX', at: new Date() });
      expect(queries).toBeLessThanOrEqual(3);
      const cached = new ContentService({ database: counting.database, cache: new MemoryConfigCache(), env: 'test' });
      await cached.resolveMany(keys, { locale: 'en-US' });
      queries = 0;
      expect((await cached.resolveMany(keys, { locale: 'en-US' })).sources.get(keys[0]!)).toBe('cache');
      expect(queries).toBe(0);
    } finally {
      await counting.drop();
    }
  });
});

// ====================================================================== locale fallback
describe('locale fallback', () => {
  it('walks the chain: requested, language, market default, platform default; only ACTIVE locales count', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await svc.registerLocale({ locale: 'es-US', reason: 'US Spanish' }, A);
    await publishNew(svc, k, { locale: 'en-US', body: 'english' });
    await publishNew(svc, k, { locale: 'es-US', body: 'espanol US' });
    const at = async (locale: string, context: { marketDefaultLocale?: string } = {}) => svc.resolve(k, { locale, context });
    // es-US registered but inactive: nothing can reach it
    expect(await at('es-US')).toMatchObject({ resolvedLocale: 'en-US', fallback: { applied: true, chain: ['en-US'] } });
    await svc.setLocaleActive('es-US', true, 'launch', A);
    expect(await at('es-US')).toMatchObject({ resolvedLocale: 'es-US', body: 'espanol US', fallback: { applied: false, chain: ['es-US', 'en-US'] } });
    // es-MX is not registered: its chain is es-MX, es, (market default es-US), en-US filtered to active locales
    expect(await at('es-MX')).toMatchObject({ resolvedLocale: 'en-US', fallback: { applied: true, chain: ['en-US'] } });
    expect(await at('es-MX', { marketDefaultLocale: 'es-US' })).toMatchObject({
      resolvedLocale: 'es-US',
      body: 'espanol US',
      fallback: { applied: true, chain: ['es-US', 'en-US'] },
    });
    // a registered, active language-level locale is preferred over the market default and the platform default
    await svc.registerLocale({ locale: 'es', active: true, reason: 'generic Spanish' }, A);
    await publishNew(svc, k, { locale: 'es', body: 'espanol' });
    expect(await at('es-MX', { marketDefaultLocale: 'es-US' })).toMatchObject({
      resolvedLocale: 'es',
      body: 'espanol',
      fallback: { chain: ['es', 'es-US', 'en-US'] },
    });
    // deactivating a locale stops it serving immediately
    await svc.setLocaleActive('es', false, 'pause', A);
    expect((await at('es-MX', { marketDefaultLocale: 'es-US' })).resolvedLocale).toBe('es-US');
    // requesting a locale we never heard of still works through the platform default
    expect((await at('ja-JP')).resolvedLocale).toBe('en-US');
  });

  it('fallback and scope interplay: the exact locale at platform scope beats a fallback locale at market scope', async () => {
    const k = key();
    await svc.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
    await svc.registerLocale({ locale: 'de-DE', active: true, reason: 'launch' }, A);
    await publishNew(svc, k, { locale: 'en-US', body: 'en platform' });
    await publishNew(svc, k, { locale: 'en-US', body: 'en market', scopeType: 'MARKET', scopeRef: 'de-berlin' });
    expect((await svc.resolve(k, { locale: 'de-DE', context: { market: 'de-berlin' } })).body).toBe('en market'); // no de copy yet: the best English copy
    await publishNew(svc, k, { locale: 'de-DE', body: 'de platform' });
    expect(await svc.resolve(k, { locale: 'de-DE', context: { market: 'de-berlin' } })).toMatchObject({
      body: 'de platform',
      resolvedLocale: 'de-DE',
      sourceScope: 'PLATFORM',
    });
    await publishNew(svc, k, { locale: 'de-DE', body: 'de market', scopeType: 'MARKET', scopeRef: 'de-berlin' });
    expect((await svc.resolve(k, { locale: 'de-DE', context: { market: 'de-berlin' } })).body).toBe('de market');
    expect((await svc.resolve(k, { locale: 'de-DE', context: { market: 'de-munich' } })).body).toBe('de platform');
  });

  it('LANGUAGE_ONLY reaches the requested locale and its language, never the platform default', async () => {
    const lang = key('lang');
    await svc.createEntry(entryReq(lang, { fallbackPolicy: 'LANGUAGE_ONLY' }), A);
    await publishNew(svc, lang, { locale: 'en-US', body: 'english only' });
    expect(await code(svc.resolve(lang, { locale: 'es-US' }))).toBe('NO_CONTENT');
    expect(await code(svc.resolve(lang, { locale: 'en-GB' }))).toBe('NO_CONTENT'); // en-GB, en: the en-US copy is a different locale
    await svc.registerLocale({ locale: 'en', active: true, reason: 'generic English' }, A);
    await publishNew(svc, lang, { locale: 'en', body: 'generic english' });
    expect(await svc.resolve(lang, { locale: 'en-GB' })).toMatchObject({ resolvedLocale: 'en', fallback: { applied: true, chain: ['en'] } });
    expect((await svc.resolve(lang, { locale: 'en-US' })).body).toBe('english only');
  });
});

// ====================================================================== 26. legal documents
describe('legal documents (26)', () => {
  const legalReq = (k: string): CreateEntryInput => ({ key: k, contentType: 'LEGAL', ownerRole: 'LEGAL', description: 'Terms of service', variables: [] });
  const insertEntrySql = (k: string, f: { type?: string; owner?: string; policy?: string; criticality?: string; fallback?: string }) =>
    q(
      `INSERT INTO content.entries (key, content_type, owner_role, description, approval_policy, criticality, fallback_policy, created_by) VALUES ($1, $2, $3, 'd', $4, $5, $6, 'sql')`,
      [k, f.type ?? 'LEGAL', f.owner ?? 'LEGAL', f.policy ?? 'SECOND_APPROVER', f.criticality ?? 'CRITICAL', f.fallback ?? 'EXACT'],
    );
  const TERMS = '# Terms of service\n\nBy using BananaGig you agree to these **terms**.';

  it('legal entries get the strict policy by default; weaker ones are refused by the service and by the database CHECK', async () => {
    const k = key('terms');
    const e = await svc.createEntry(legalReq(k), A);
    expect(e).toMatchObject({ contentType: 'LEGAL', ownerRole: 'LEGAL', approvalPolicy: 'SECOND_APPROVER', criticality: 'CRITICAL', fallbackPolicy: 'EXACT' });
    expect(await err(svc.createEntry({ ...legalReq(key()), ownerRole: 'CONTENT' }, A))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'LEGAL_POLICY' },
    });
    expect(await err(svc.createEntry({ ...legalReq(key()), approvalPolicy: 'NONE' }, A))).toMatchObject({ details: { reason: 'LEGAL_POLICY' } });
    for (const weaker of [
      { owner: 'CONTENT' },
      { policy: 'NONE' },
      { policy: 'OWNER_APPROVAL' },
      { criticality: 'STANDARD' },
      { fallback: 'CHAIN' },
      { fallback: 'LANGUAGE_ONLY' },
    ]) {
      const e2 = (await rejection(insertEntrySql(key(), weaker))) as { code?: string; constraint?: string };
      expect(e2.code, JSON.stringify(weaker)).toBe('23514');
      expect(e2.constraint).toBe('ck_entries__legal_policy');
    }
    expect(await dbCode(insertEntrySql(key(), {}))).toBeUndefined(); // the strict combination is accepted
    expect(
      await dbCode(insertEntrySql(key(), { type: 'PLAIN_TEXT', owner: 'CONTENT', policy: 'NONE', criticality: 'STANDARD', fallback: 'CHAIN' })),
    ).toBeUndefined(); // non-legal is unconstrained
  });

  it('a second approver is required: the author cannot approve (service and database), another approver can; events carry the checksum', async () => {
    const k = key('terms');
    await svc.createEntry(legalReq(k), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: TERMS, reason: 'initial terms' }, A);
    expect((await svc.submit(d.versionId, A)).status).toBe('IN_REVIEW'); // legal never skips review
    expect(await code(svc.approve(d.versionId, A))).toBe('FORBIDDEN_APPROVER');
    expect(await dbCode(q("INSERT INTO content.version_approvals (version_id, approver, decision) VALUES ($1, $2, 'APPROVE')", [d.versionId, A]))).toBe(
      '23000',
    );
    expect(await q('SELECT 1 FROM content.version_approvals WHERE version_id = $1', [d.versionId])).toHaveLength(0);
    expect((await svc.approve(d.versionId, B, 'reviewed by counsel')).status).toBe('APPROVED');
    const live = await svc.publish(d.versionId, B);
    expect(live.status).toBe('PUBLISHED');
    const published = (await outbox(CONTENT_EVENTS.versionPublished)).filter((e) => e.aggregate_id === d.versionId);
    const legal = (await outbox(CONTENT_EVENTS.legalDocumentPublished)).filter((e) => e.aggregate_id === d.versionId);
    expect(published).toHaveLength(1);
    expect(legal).toHaveLength(1);
    expect(legal[0]!.payload_json).toMatchObject({ entryKey: k, locale: 'en-US', version: 1, bodySha256: sha(TERMS), scopeType: 'PLATFORM', scopeRef: null });
    expect('bodySha256' in published[0]!.payload_json).toBe(false);
    expect(JSON.stringify(legal)).not.toContain('Terms of service');
    // the author may still withdraw a legal draft before review, but not approve while a policy requires someone else
    const second = await svc.createVersion(k, { locale: 'en-US', body: `${TERMS} v2`, reason: 'update' }, A);
    expect(await code(svc.approve(second.versionId, B))).toBe('INVALID_STATE'); // still a draft: must be submitted first
    await svc.submit(second.versionId, A);
    expect(await code(svc.cancel(second.versionId, B))).toBe('FORBIDDEN_APPROVER');
  });

  it('legal copy never falls back to another locale and is never cached or served from last-known-good', async () => {
    const k = key('terms');
    const cache = new MemoryConfigCache();
    const cached = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    await svc.createEntry(legalReq(k), A);
    await svc.registerLocale({ locale: 'sv-SE', active: true, reason: 'launch' }, A);
    await publishNew(svc, k, { body: TERMS, author: A, approver: B });
    expect(await code(cached.resolve(k, { locale: 'sv-SE' }))).toBe('NO_CONTENT'); // en-US exists and is the platform default; EXACT does not use it
    expect(await code(cached.resolve(k, { locale: 'en-GB' }))).toBe('NO_CONTENT'); // not even the same language
    const r = await cached.resolve(k, { locale: 'en-US' });
    expect(r).toMatchObject({ criticality: 'CRITICAL', fallback: { applied: false, chain: ['en-US'] } });
    expect((await cached.resolveMany([k], { locale: 'en-US' })).sources.get(k)).toBe('db');
    expect([...cache.data.keys()].filter((x) => x.includes(k))).toEqual([]); // no resolution entry, no LKG, not even a generation
  });

  it('legal versions are immutable: text, checksum, period, identity and policy cannot change; nothing can be deleted', async () => {
    const k = key('terms');
    await svc.createEntry(legalReq(k), A);
    const draft = await svc.createVersion(k, { locale: 'en-US', body: TERMS, reason: 'draft' }, A);
    expect(await dbCode(q("UPDATE content.versions SET body = 'edited draft' WHERE version_id = $1", [draft.versionId]))).toBe('23000'); // immutable from creation
    const v = await publishNew(svc, k, { body: `${TERMS} signed`, author: A, approver: B });
    for (const set of [
      "body = 'We may change these terms at will'",
      "body_sha256 = 'deadbeef'",
      "locale = 'es-US'",
      "reason = 'edited'",
      "created_by = 'someone-else'",
      "approval_policy = 'NONE'",
      'version = 7',
      "effective_from = effective_from + interval '1 day'",
      "effective_from = effective_from - interval '1 day'",
      "status = 'DRAFT'",
      "status = 'APPROVED'",
      "status = 'CANCELLED'",
    ])
      expect(await dbCode(q(`UPDATE content.versions SET ${set} WHERE version_id = $1`, [v.versionId])), set).toBe('23000');
    expect(await dbCode(q('DELETE FROM content.versions WHERE version_id = $1', [v.versionId]))).toBe('23000');
    expect(await dbCode(q("UPDATE content.entries SET approval_policy = 'NONE' WHERE key = $1", [k]))).toBe('23000');
    expect(await dbCode(q("UPDATE content.entries SET content_type = 'PLAIN_TEXT' WHERE key = $1", [k]))).toBe('23000');
    const after = await svc.getVersion(v.versionId);
    expect(after.body).toBe(`${TERMS} signed`);
    expect(after.bodySha256).toBe(sha(`${TERMS} signed`));
  });

  it('a scheduled legal version emits version-published and legal-document-published exactly once when activated, even with concurrent runs', () =>
    withFreshService(async (s, fresh) => {
      const k = key('terms');
      await s.createEntry(legalReq(k), A);
      const v1 = await publishNew(s, k, { body: TERMS });
      const body2 = `${TERMS} (revised)`;
      const v2 = await publishNew(s, k, { body: body2, from: inMs(1_100) });
      expect(v2.status).toBe('SCHEDULED');
      await sleep(1_300);
      const total = (await Promise.all([s.activateDue(), s.activateDue()])).reduce((x, y) => x + y, 0);
      expect(total).toBe(1);
      const published = (await outbox(CONTENT_EVENTS.versionPublished, fresh)).filter((e) => e.aggregate_id === v2.versionId);
      const legal = (await outbox(CONTENT_EVENTS.legalDocumentPublished, fresh)).filter((e) => e.aggregate_id === v2.versionId);
      expect([published.length, legal.length]).toEqual([1, 1]);
      expect(legal[0]!.payload_json).toMatchObject({ bodySha256: sha(body2), previousVersionId: v1.versionId, version: 2 });
      expect(legal[0]!.actor_type).toBe('system');
    }));
});

// ====================================================================== 10/11. published-version immutability (real triggers)
describe('published-version immutability (10)', () => {
  it('body, identity, policy, period start and status of a published version cannot be changed by SQL; deletes are refused', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v = await publishNew(svc, k, { body: 'as published' });
    const other = await entryIdOf('brand.name');
    for (const set of [
      "body = 'tampered'",
      "body_sha256 = 'abc'",
      "locale = 'es-US'",
      "scope_type = 'COUNTRY', scope_ref = 'US'",
      'version = 99',
      "reason = 'x'",
      "created_by = 'evil'",
      "approval_policy = 'SECOND_APPROVER'",
      `entry_id = '${other}'`,
      "effective_from = effective_from + interval '1 minute'",
      "effective_from = effective_from - interval '1 minute'",
      "status = 'DRAFT'",
      "status = 'IN_REVIEW'",
      "status = 'APPROVED'",
      "status = 'CANCELLED'",
      "status = 'REJECTED'",
    ])
      expect(await dbCode(q(`UPDATE content.versions SET ${set} WHERE version_id = $1`, [v.versionId])), set).toBe('23000');
    expect(await dbCode(q('DELETE FROM content.versions WHERE version_id = $1', [v.versionId]))).toBe('23000');
    expect(await svc.getVersion(v.versionId)).toMatchObject({ body: 'as published', status: 'PUBLISHED', effectiveFrom: v.effectiveFrom });
  });

  it('mapDbError translates the REAL trigger and constraint errors into typed codes without leaking copy text', async () => {
    const SENTINEL = 'SECRET-COPY-SENTINEL';
    const k = key();
    await svc.createEntry(entryReq(k, { approvalPolicy: 'SECOND_APPROVER' }), A);
    const draft = await svc.createVersion(k, { locale: 'en-US', body: SENTINEL, reason: 'r' }, A);
    await svc.submit(draft.versionId, A);
    const typed = (p: Promise<unknown>) =>
      rejection(p).then((raw) => {
        expect(raw, 'the database should have refused').toBeDefined();
        try {
          mapDbError(raw);
        } catch (e) {
          return e as ContentError;
        }
        throw new Error('mapDbError returned');
      });
    const immutable = await typed(q("UPDATE content.versions SET body = 'x' WHERE version_id = $1", [draft.versionId])); // 23000 immutability guard
    expect(immutable).toMatchObject({ code: 'INVALID_STATE' });
    const selfApproval = await typed(
      q("INSERT INTO content.version_approvals (version_id, approver, decision) VALUES ($1, $2, 'APPROVE')", [draft.versionId, A]),
    ); // 23000 self-approval
    expect(selfApproval).toMatchObject({ code: 'FORBIDDEN_APPROVER' });
    const workflow = await typed(q("UPDATE content.versions SET status = 'PUBLISHED' WHERE version_id = $1", [draft.versionId])); // 23000 workflow
    expect(workflow).toMatchObject({ code: 'INVALID_STATE' });
    const legalPolicy = await typed(
      q(
        "INSERT INTO content.entries (key, content_type, owner_role, description, approval_policy, created_by) VALUES ($1, 'LEGAL', 'CONTENT', 'd', 'NONE', 'sql')",
        [key()],
      ),
    ); // 23514
    expect(legalPolicy).toMatchObject({ code: 'VALIDATION_FAILED', details: { constraint: 'ck_entries__legal_policy' } });
    const duplicate = await typed(
      q(
        "INSERT INTO content.entries (key, content_type, owner_role, description, approval_policy, created_by) VALUES ($1, 'UI_LABEL', 'CONTENT', 'd', 'NONE', 'sql')",
        [k],
      ),
    ); // 23505
    expect(duplicate).toMatchObject({ code: 'CONFLICT', details: { constraint: 'uq_entries__key' } });
    const k2 = key();
    await svc.createEntry(entryReq(k2), A);
    const live = await publishNew(svc, k2, { body: SENTINEL });
    const next = await authorVersion(svc, k2, { body: `${SENTINEL} next` });
    const overlap = await typed(q("UPDATE content.versions SET status = 'PUBLISHED' WHERE version_id = $1", [next.versionId])); // 23P01
    expect(overlap).toMatchObject({ code: 'CONFLICT', details: { constraint: 'ex_versions__no_overlap' } });
    expect(live.status).toBe('PUBLISHED');
    for (const e of [immutable, selfApproval, workflow, legalPolicy, duplicate, overlap])
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(SENTINEL);
    // through the service: a draft is refused by the state check, naming only identifiers
    const refused = await err(svc.publish(draft.versionId, A));
    expect(refused).toMatchObject({ code: 'INVALID_STATE' });
    expect(JSON.stringify({ m: refused.message, d: refused.details })).not.toContain(SENTINEL);
  });

  it('snapshots, snapshot items, audit rows and approvals are append-only', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'x' });
    const snap = await svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'immutability' }, A);
    for (const sqlText of [
      `UPDATE content.snapshots SET purpose = 'x' WHERE snapshot_id = '${snap.snapshotId}'`,
      `DELETE FROM content.snapshots WHERE snapshot_id = '${snap.snapshotId}'`,
      `UPDATE content.snapshot_items SET version_id = version_id WHERE snapshot_id = '${snap.snapshotId}'`,
      `DELETE FROM content.snapshot_items WHERE snapshot_id = '${snap.snapshotId}'`,
      `UPDATE content.audit_events SET actor = 'x' WHERE entry_id = '${snap.items[0]!.entryId}'`,
      `DELETE FROM content.audit_events WHERE entry_id = '${snap.items[0]!.entryId}'`,
    ])
      expect(await dbCode(q(sqlText)), sqlText).toBe('23000');
  });
});

// ====================================================================== 25. snapshots
describe('snapshots (25)', () => {
  it('records the exact versions used (with their text) and stays unchanged after later versions are published', async () => {
    const [k1, k2] = [key('a'), key('b')];
    await svc.createEntry(entryReq(k1), A);
    await svc.createEntry(entryReq(k2, { maxScopeType: 'MARKET' }), A);
    const a1 = await publishNew(svc, k1, { body: 'A one' });
    await publishNew(svc, k2, { body: 'B platform' });
    const b1 = await publishNew(svc, k2, { body: 'B market', scopeType: 'MARKET', scopeRef: 'us-ca' });
    const snap = await svc.createSnapshot({ keys: [k2, k1, k1], locale: 'en-US', context: { market: 'us-ca' }, purpose: 'accepted at checkout' }, A);
    expect(snap).toMatchObject({ requestedLocale: 'en-US', context: { market: 'us-ca' }, purpose: 'accepted at checkout', createdBy: A });
    expect(snap.items.map((i) => [i.key, i.body, i.version, i.sourceScope, i.scopeRef])).toEqual(
      [
        [k1, 'A one', 1, 'PLATFORM', null],
        [k2, 'B market', 1, 'MARKET', 'us-ca'],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(snap.items.find((i) => i.key === k1)).toMatchObject({ versionId: a1.versionId, bodySha256: sha('A one'), resolvedLocale: 'en-US' });
    // both entries change afterwards
    await publishNew(svc, k1, { body: 'A two' });
    await publishNew(svc, k2, { body: 'B market two', scopeType: 'MARKET', scopeRef: 'us-ca' });
    expect((await svc.resolve(k1, { locale: 'en-US' })).body).toBe('A two');
    const again = await svc.getSnapshot(snap.snapshotId);
    const pick = (s: typeof snap) =>
      s.items.map((i) => ({
        key: i.key,
        body: i.body,
        bodySha256: i.bodySha256,
        version: i.version,
        versionId: i.versionId,
        effectiveFrom: i.effectiveFrom,
        resolvedLocale: i.resolvedLocale,
        scope: i.sourceScope,
      }));
    expect(pick(again)).toEqual(pick(snap));
    // the whole read-back is byte-identical (no field that changes when a successor is published, such as effectiveTo)
    expect(JSON.stringify(again)).toBe(JSON.stringify(snap));
    expect(Object.keys(again.items[0]!)).not.toContain('effectiveTo');
    expect(again.items.find((i) => i.key === k2)!.versionId).toBe(b1.versionId);
    expect(again.evaluatedAt).toEqual(snap.evaluatedAt);
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.snapshot_items WHERE snapshot_id = $1', [snap.snapshotId]))[0]!.n)).toBe(2);
    // the pointed-to versions can never change underneath the snapshot
    expect(await dbCode(q("UPDATE content.versions SET body = 'rewritten' WHERE version_id = $1", [a1.versionId]))).toBe('23000');
    expect(await code(svc.getSnapshot('00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND');
  });

  it('a snapshot at an explicit past time records the version effective then; failures create nothing', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'old' });
    await sleep(30);
    const then = new Date();
    await sleep(30);
    await publishNew(svc, k, { body: 'new' });
    const past = await svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'what applied', at: then }, A);
    expect(past.items[0]).toMatchObject({ body: 'old', version: 1 });
    expect(past.evaluatedAt.getTime()).toBe(then.getTime());
    expect((await svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'now' }, A)).items[0]).toMatchObject({ body: 'new', version: 2 });
    const count = async () => Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.snapshots'))[0]!.n);
    const before = await count();
    expect(await code(svc.createSnapshot({ keys: [k, 'devtest.never.created'], locale: 'en-US', purpose: 'p' }, A))).toBe('ENTRY_NOT_FOUND');
    const empty = key();
    await svc.createEntry(entryReq(empty), A);
    expect(await code(svc.createSnapshot({ keys: [k, empty], locale: 'en-US', purpose: 'p' }, A))).toBe('NO_CONTENT');
    expect(await count()).toBe(before);
  });

  it('refuses a snapshot for an instant later than the database clock plus 5 seconds (a prediction is not a record of what applied)', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'open ended' });
    const count = async () => Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.snapshots'))[0]!.n);
    const before = await count();
    // the scenario of the finding: a snapshot of the future says v1 applies, then an earlier-starting v2 is published and makes it false
    for (const ms of [10_000, 120_000]) {
      const e = await err(svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'prediction', at: inMs(ms) }, A));
      expect(e).toBeInstanceOf(ContentError);
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'AT_IN_FUTURE', field: 'at' } });
    }
    expect(await code(svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'garbage', at: new Date('nope') }, A))).toBe('VALIDATION_FAILED');
    expect(await count()).toBe(before);
    // within the clock tolerance (and in the past) it is accepted
    expect((await svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'tolerated', at: inMs(2_000) }, A)).items[0]).toMatchObject({ body: 'open ended' });
    await sleep(20);
    expect((await svc.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'present', at: new Date() }, A)).items[0]).toMatchObject({ body: 'open ended' });
    expect(await count()).toBe(before + 2);
  });

  it('is always authoritative: it reads the database, never the cache or last-known-good', async () => {
    const k = key();
    const cache = new MemoryConfigCache();
    const cached = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'v1' });
    expect((await cached.resolve(k, { locale: 'en-US' })).body).toBe('v1'); // now cached
    await publishNew(svc, k, { body: 'v2' }); // through a service WITHOUT this cache: no generation bump, so the cached copy is stale by design
    expect((await cached.resolve(k, { locale: 'en-US' })).body).toBe('v1');
    expect((await cached.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'authoritative' }, A)).items[0]!.body).toBe('v2');
    const broken = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } });
    try {
      const outage = new ContentService({ database: broken, cache, env: 'test' });
      expect(await code(outage.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'p' }, A))).toBe('UNAVAILABLE'); // cached and LKG copies exist but are not used
    } finally {
      await broken.close();
    }
  });
});

// ====================================================================== 27. audit and outbox
describe('audit and events (27)', () => {
  it('records every mutation with actor, action, locale, versions, reason and correlation id; bodies never appear', async () => {
    const k = key();
    const SENTINEL = 'SECRET-COPY-SENTINEL-77';
    const cid = `corr-audit-${seq}`;
    const second = await runWithCorrelation(cid, async () => {
      await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL' }), A);
      const v1 = await svc.createVersion(k, { locale: 'en-US', body: SENTINEL, reason: 'first copy' }, A);
      await svc.submit(v1.versionId, A);
      await svc.approve(v1.versionId, B, 'fine');
      await svc.publish(v1.versionId, B);
      const v2 = await svc.createVersion(k, { locale: 'en-US', body: `${SENTINEL} 2`, reason: 'second copy' }, A);
      await svc.submit(v2.versionId, A);
      await svc.reject(v2.versionId, B, 'no');
      const v3 = await svc.createVersion(k, { locale: 'en-US', body: `${SENTINEL} 3`, reason: 'third copy' }, A);
      await svc.cancel(v3.versionId, A);
      await svc.setEntryActive(k, false, 'pause', C);
      return v1;
    });
    const trail = await audit(k);
    expect(trail.map((a) => a.action)).toEqual([
      'ENTRY_CREATED',
      'VERSION_DRAFTED',
      'VERSION_SUBMITTED',
      'VERSION_APPROVED',
      'VERSION_PUBLISHED',
      'VERSION_ACTIVATED',
      'VERSION_DRAFTED',
      'VERSION_SUBMITTED',
      'VERSION_REJECTED',
      'VERSION_DRAFTED',
      'VERSION_CANCELLED',
      'ENTRY_DEACTIVATED',
    ]);
    expect(trail.every((a) => a.correlation_id === cid)).toBe(true);
    expect(trail.map((a) => a.actor)).toEqual([A, A, A, B, B, B, A, A, B, A, A, C]);
    expect(trail.find((a) => a.action === 'VERSION_APPROVED')).toMatchObject({ reason: 'fine', locale: null, version_id: second.versionId });
    expect(trail.find((a) => a.action === 'VERSION_REJECTED')?.reason).toBe('no');
    expect(trail.at(-1)).toMatchObject({ action: 'ENTRY_DEACTIVATED', reason: 'pause', locale: null, version_id: null });
    // the audit table never copies the text, and the schema has nowhere to put it
    const everything = JSON.stringify(
      await q('SELECT * FROM content.audit_events WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1)', [k]),
    );
    expect(everything).not.toContain(SENTINEL);
    // without an ambient correlation id one is generated (never empty)
    const k2 = key();
    await svc.createEntry(entryReq(k2), A);
    expect((await audit(k2))[0]!.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes the four content events through the outbox with identifier-only payloads, one per transition', async () => {
    const k = key();
    const SENTINEL = 'SECRET-COPY-SENTINEL-88';
    await svc.createEntry(entryReq(k, { approvalPolicy: 'OWNER_APPROVAL', maxScopeType: 'MARKET' }), A);
    const d = await svc.createVersion(k, { locale: 'en-US', body: SENTINEL, reason: 'events' }, A);
    await svc.submit(d.versionId, A);
    await svc.approve(d.versionId, B);
    const live = await svc.publish(d.versionId, B);
    const next = await publishNew(svc, k, { body: `${SENTINEL} next`, from: inMs(60_000), author: A, approver: B });
    const market = await publishNew(svc, k, { body: `${SENTINEL} market`, scopeType: 'MARKET', scopeRef: 'us-ca', author: A, approver: B });
    const forVersion = async (type: string, id: string) => (await outbox(type)).filter((e) => e.aggregate_id === id);
    const approved = await forVersion(CONTENT_EVENTS.versionApproved, d.versionId);
    const published = await forVersion(CONTENT_EVENTS.versionPublished, live.versionId);
    const scheduled = await forVersion(CONTENT_EVENTS.versionScheduled, next.versionId);
    expect([approved.length, published.length, scheduled.length]).toEqual([1, 1, 1]);
    expect(await forVersion(CONTENT_EVENTS.versionPublished, next.versionId)).toHaveLength(0); // scheduled is not yet effective
    expect(await forVersion(CONTENT_EVENTS.legalDocumentPublished, live.versionId)).toHaveLength(0); // not a legal entry
    expect(approved[0]).toMatchObject({ aggregate_type: 'content_version', actor_type: 'user' });
    expect(approved[0]!.payload_json).toEqual({
      versionId: d.versionId,
      entryKey: k,
      locale: 'en-US',
      scopeType: 'PLATFORM',
      scopeRef: null,
      version: 1,
      effectiveFrom: d.effectiveFrom.toISOString(),
    });
    expect(published[0]!.payload_json).toEqual({
      versionId: live.versionId,
      entryKey: k,
      locale: 'en-US',
      scopeType: 'PLATFORM',
      scopeRef: null,
      version: 1,
      effectiveFrom: live.effectiveFrom.toISOString(),
      previousVersionId: null,
    });
    expect(scheduled[0]!.payload_json).toMatchObject({ version: 2, previousVersionId: live.versionId, effectiveFrom: next.effectiveFrom.toISOString() });
    const marketPublished = await forVersion(CONTENT_EVENTS.versionPublished, market.versionId);
    expect(marketPublished[0]!.payload_json).toMatchObject({ scopeType: 'MARKET', scopeRef: 'us-ca', previousVersionId: null });
    const all = JSON.stringify([approved, published, scheduled, marketPublished]);
    expect(all).not.toContain(SENTINEL);
    for (const e of [approved[0]!, published[0]!, scheduled[0]!]) expect(() => ContentEventPayloadCheck(e.payload_json)).not.toThrow();
  });

  it('state change, audit rows and outbox events commit or roll back together', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v = await authorVersion(svc, k);
    const count = async (t: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))[0]!.n);
    const [auditBefore, outboxBefore] = [await count('content.audit_events'), await count('integration.outbox_events')];
    await rejection(
      db().transaction(async () => {
        await svc.publish(v.versionId, A);
        throw new Error('business transaction fails after the service call');
      }),
    );
    expect((await svc.getVersion(v.versionId)).status).toBe('APPROVED');
    expect(await count('content.audit_events')).toBe(auditBefore);
    expect(await count('integration.outbox_events')).toBe(outboxBefore);
    await svc.publish(v.versionId, A);
    expect(await count('integration.outbox_events')).toBe(outboxBefore + 1);
    expect(await count('content.audit_events')).toBe(auditBefore + 2); // VERSION_PUBLISHED + VERSION_ACTIVATED
  });
});

/** Validates an event payload against the published contract schema. */
function ContentEventPayloadCheck(payload: unknown): void {
  const r = ContentEventPayload.safeParse(payload);
  if (!r.success) throw new Error(`event payload does not match the contract: ${r.error.message}`);
}

// ====================================================================== 23. cache invalidation (memory cache: always runs)
describe('cache invalidation (23)', () => {
  const cachedService = (cache: MemoryConfigCache, d: IsolatedDatabase = iso) =>
    new ContentService({ database: d.database, cache, env: 'test', allowTestKeys: true });
  const src = async (s: ContentService, k: string, locale = 'en-US') => (await s.resolveMany([k], { locale })).sources.get(k);

  it('publication invalidates cached copy immediately (generation bump after commit)', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const k = key();
    await s.createEntry(entryReq(k), A);
    await publishNew(s, k, { body: 'one' });
    expect(await src(s, k)).toBe('db');
    expect(await src(s, k)).toBe('cache');
    await publishNew(s, k, { body: 'two' });
    const r = await s.resolveMany([k], { locale: 'en-US' });
    expect([r.items.get(k)!.body, r.sources.get(k)]).toEqual(['two', 'db']);
    expect(await src(s, k)).toBe('cache');
    expect(cache.data.get(`bg:test:content:gen:${k}`)).toBe('2');
  });

  it('entry deactivation and reactivation take effect immediately', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const k = key();
    await s.createEntry(entryReq(k), A);
    await publishNew(s, k, { body: 'copy' });
    await s.resolveMany([k], { locale: 'en-US' });
    expect(await src(s, k)).toBe('cache');
    await s.setEntryActive(k, false, 'retire', A);
    expect(await code(s.resolve(k, { locale: 'en-US' }))).toBe('ENTRY_NOT_FOUND');
    await s.setEntryActive(k, true, 'restore', A);
    expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('copy');
  });

  it('any locale change invalidates every cached entry (locale generation); a request for an inactive locale is never cached', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const k = key();
    await s.createEntry(entryReq(k), A);
    await s.registerLocale({ locale: 'pl-PL', reason: 'prep' }, A);
    await publishNew(s, k, { locale: 'en-US', body: 'english' });
    await publishNew(s, k, { locale: 'pl-PL', body: 'polski' });
    expect((await s.resolve(k, { locale: 'pl-PL' })).body).toBe('english'); // pl-PL inactive: answered through the chain
    expect(await src(s, k, 'pl-PL')).toBe('db'); // ... from the database every time, never from (or into) the cache
    expect([...cache.data.keys()].filter((c) => c.includes(':pl-PL:'))).toEqual([]);
    expect(await src(s, k, 'en-US')).toBe('db');
    expect(await src(s, k, 'en-US')).toBe('cache');
    await s.setLocaleActive('pl-PL', true, 'go live', A);
    expect(await src(s, k, 'en-US')).toBe('db'); // the locale generation bump invalidated even the unrelated en-US entry
    const r = await s.resolveMany([k], { locale: 'pl-PL' });
    expect([r.items.get(k)!.body, r.sources.get(k)]).toEqual(['polski', 'db']);
    expect(await src(s, k, 'pl-PL')).toBe('cache'); // active now: cacheable
    await s.setLocaleActive('pl-PL', false, 'pause', A);
    expect((await s.resolve(k, { locale: 'pl-PL' })).body).toBe('english');
    expect(Number(cache.data.get('bg:test:content:locgen'))).toBeGreaterThanOrEqual(3);
  });

  it('a cached entry stops being served when the next version becomes effective, even without any activation job', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const k = key();
    await s.createEntry(entryReq(k), A);
    await publishNew(s, k, { body: 'current' });
    const from = inMs(2_600);
    await publishNew(s, k, { body: 'next', from });
    expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('current');
    expect(await src(s, k)).toBe('cache'); // valid until the boundary
    const entry = [...cache.data.entries()].find(([x]) => x.includes(`:v1:${k}:`))!;
    expect(JSON.parse(entry[1]).validUntil).toBe(from.getTime());
    await sleep(from.getTime() - Date.now() + 100); // past the boundary; the cache entry's TTL is not what protects us (the memory cache ignores it)
    const r = await s.resolveMany([k], { locale: 'en-US' });
    expect([r.items.get(k)!.body, r.sources.get(k)]).toEqual(['next', 'db']);
    expect(await src(s, k)).toBe('cache'); // and caches again, with no further boundary
  });

  it('activation by the job invalidates too', () =>
    withFreshService(async (_s, fresh) => {
      const cache = new MemoryConfigCache();
      const s = cachedService(cache, fresh);
      const k = key();
      await s.createEntry(entryReq(k), A);
      await publishNew(s, k, { body: 'one' });
      await publishNew(s, k, { body: 'two', from: inMs(1_100) });
      expect(cache.data.get(`bg:test:content:gen:${k}`)).toBe('2'); // two publications
      await sleep(1_300);
      expect(await s.activateDue()).toBe(1);
      expect(cache.data.get(`bg:test:content:gen:${k}`)).toBe('3'); // plus the activation
      expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('two');
    }));

  it('CRITICAL entries are never cached nor stored as last-known-good; `at` lookups bypass the cache', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const [crit, std] = [key('crit'), key('std')];
    await s.createEntry(entryReq(crit, { criticality: 'CRITICAL' }), A);
    await s.createEntry(entryReq(std), A);
    await publishNew(s, crit, { body: 'critical copy' });
    await publishNew(s, std, { body: 'standard copy' });
    expect(await src(s, crit)).toBe('db');
    expect(await src(s, crit)).toBe('db');
    expect([...cache.data.keys()].filter((x) => x.includes(`${crit}:`) && (x.includes(':v1:') || x.includes(':lkg:')))).toEqual([]);
    await s.resolveMany([std], { locale: 'en-US' });
    expect((await s.resolveMany([std], { locale: 'en-US', at: new Date() })).sources.get(std)).toBe('db');
    const poisonKey = [...cache.data.keys()].find((x) => x.includes(`:v1:${std}:`))!;
    const poisoned = JSON.parse(cache.data.get(poisonKey)!);
    poisoned.r = JSON.stringify({ ...JSON.parse(poisoned.r), body: 'POISON' });
    cache.data.set(poisonKey, JSON.stringify(poisoned));
    expect((await s.resolve(std, { locale: 'en-US' })).body).toBe('POISON'); // the cache is read normally
    expect((await s.resolve(std, { locale: 'en-US', at: new Date() })).body).toBe('standard copy'); // but never for `at`
  });

  it('a cache outage degrades to database reads and never changes a result (memory cache failing, real client pointed at a dead port)', async () => {
    const cache = new MemoryConfigCache();
    const s = cachedService(cache);
    const k = key();
    await s.createEntry(entryReq(k), A);
    await publishNew(s, k, { body: 'steady' });
    await s.resolveMany([k], { locale: 'en-US' });
    cache.fail = true;
    const r = await s.resolveMany([k], { locale: 'en-US' });
    expect([r.items.get(k)!.body, r.sources.get(k)]).toEqual(['steady', 'db']);
    await publishNew(s, k, { body: 'changed while the cache is down' });
    expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('changed while the cache is down');
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const withDead = new ContentService({ database: db(), cache: new ValkeyConfigCache(dead), env: 'test', allowTestKeys: true });
    const k2 = key();
    await withDead.createEntry(entryReq(k2), A);
    await publishNew(withDead, k2, { body: 'no cache at all' });
    const r2 = await withDead.resolveMany([k2], { locale: 'en-US' });
    expect([r2.items.get(k2)!.body, r2.sources.get(k2)]).toEqual(['no cache at all', 'db']);
    dead.disconnect();
  });
});

// ====================================================================== 24. database outage and last-known-good
describe('database outage and last-known-good (24)', () => {
  const brokenDatabase = () => createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } });
  const dropResolutionEntries = (cache: MemoryConfigCache) => {
    for (const x of [...cache.data.keys()]) if (x.includes(':v1:')) cache.data.delete(x);
  };

  it('serves last-known-good STANDARD copy during an outage; CRITICAL and mixed batches fail typed; no code fallback exists', async () => {
    const cache = new MemoryConfigCache();
    const healthy = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const [std, std2, crit] = [key('std'), key('std2'), key('crit')];
    await healthy.createEntry(entryReq(std), A);
    await healthy.createEntry(entryReq(std2), A);
    await healthy.createEntry(entryReq(crit, { criticality: 'CRITICAL' }), A);
    for (const k of [std, std2, crit]) await publishNew(healthy, k, { body: `copy of ${k}` });
    await healthy.resolveMany([std, std2, crit], { locale: 'en-US' });
    dropResolutionEntries(cache); // force database reads
    const broken = brokenDatabase();
    try {
      const outage = new ContentService({ database: broken, cache, env: 'test' });
      const r = await outage.resolveMany([std, std2], { locale: 'en-US' });
      expect([r.items.get(std)!.body, r.sources.get(std), r.sources.get(std2)]).toEqual([`copy of ${std}`, 'lkg', 'lkg']);
      expect(r.items.get(std)!.effectiveFrom).toBeInstanceOf(Date);
      expect(await code(outage.resolveMany([crit], { locale: 'en-US' }))).toBe('UNAVAILABLE');
      expect(await code(outage.resolveMany([std, crit], { locale: 'en-US' }))).toBe('UNAVAILABLE'); // all-or-nothing
      expect(await code(outage.resolveMany([std, 'devtest.never.cached'], { locale: 'en-US' }))).toBe('UNAVAILABLE');
      expect(await code(outage.resolveMany([std], { locale: 'es-MX' }))).toBe('UNAVAILABLE'); // LKG is per requested locale
      expect(await code(outage.resolveMany([std], { locale: 'en-US', context: { market: 'us-ca' } }))).toBe('UNAVAILABLE'); // and per context
      expect(await code(outage.resolveMany([std], { locale: 'en-US', at: new Date() }))).toBe('UNAVAILABLE'); // `at` never uses LKG
      expect(await code(outage.resolve(crit, { locale: 'en-US' }))).toBe('UNAVAILABLE');
      expect(await code(outage.createVersion(std, { locale: 'en-US', body: 'x', reason: 'r' }, A))).toBe('UNAVAILABLE'); // management writes fail typed too
      const e = await err(outage.resolveMany([crit], { locale: 'en-US' }));
      expect(e.details.keys).toEqual([crit]);
      expect(JSON.stringify(e.details)).not.toContain('copy of');
    } finally {
      await broken.close();
    }
  });

  it('last-known-good expires with its maximum age and is not used without a cache', async () => {
    const cache = new MemoryConfigCache();
    const healthy = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true, lkgMaxAgeSeconds: 1 });
    const k = key();
    await healthy.createEntry(entryReq(k), A);
    await publishNew(healthy, k, { body: 'aging copy' });
    await healthy.resolveMany([k], { locale: 'en-US' });
    dropResolutionEntries(cache);
    const broken = brokenDatabase();
    try {
      const outage = new ContentService({ database: broken, cache, env: 'test', lkgMaxAgeSeconds: 1 });
      expect((await outage.resolveMany([k], { locale: 'en-US' })).sources.get(k)).toBe('lkg');
      await sleep(1_200);
      expect(await code(outage.resolveMany([k], { locale: 'en-US' }))).toBe('UNAVAILABLE');
      expect(await code(new ContentService({ database: broken, env: 'test' }).resolveMany([k], { locale: 'en-US' }))).toBe('UNAVAILABLE');
    } finally {
      await broken.close();
    }
  });

  it('a definitive answer from a healthy database is never replaced by last-known-good (deactivated entry, no content)', async () => {
    const cache = new MemoryConfigCache();
    const s = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const k = key();
    await s.createEntry(entryReq(k, { fallbackPolicy: 'EXACT' }), A);
    await publishNew(s, k, { body: 'will be retired' });
    await s.resolveMany([k], { locale: 'en-US' }); // LKG stored
    expect(await code(s.resolve(k, { locale: 'sv-SE' }))).toBe('NO_CONTENT'); // authoritative: no copy in that locale, EXACT
    await s.setEntryActive(k, false, 'retired', A);
    const r = await s.resolveMany([k], { locale: 'en-US' });
    expect(r.items.size).toBe(0);
    expect(r.missing.get(k)).toBe('ENTRY_NOT_FOUND');
    expect([...cache.data.keys()].some((x) => x.includes(':lkg:') && x.includes(k))).toBe(true); // it exists, and is simply not used
  });
});

// ====================================================================== 23/24. real Valkey (self-skips when unreachable)
describe('real Valkey', () => {
  it('invalidation, TTL cap, generations and last-known-good against a real Valkey', async (ctx) => {
    const url = process.env.VALKEY_ITEST_URL ?? 'redis://127.0.0.1:16379';
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1_500, retryStrategy: () => null });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await redis.ping();
    } catch (e) {
      redis.disconnect();
      const reason = `Valkey is not reachable at ${url} (${e instanceof Error ? e.message : String(e)})`;
      console.warn(`[content.itest] SKIPPED real-Valkey test: ${reason}. The same behaviours are covered with MemoryConfigCache.`);
      ctx.skip(reason);
      return;
    }
    const env = `itest${Date.now()}`;
    const cache = new ValkeyConfigCache(redis);
    const s = new ContentService({ database: db(), cache, env, allowTestKeys: true, cacheTtlSeconds: 30 });
    const broken = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } });
    try {
      const [k, crit] = [key('valkey'), key('valkeycrit')];
      await s.createEntry(entryReq(k), A);
      await s.createEntry(entryReq(crit, { criticality: 'CRITICAL' }), A);
      await publishNew(s, k, { body: 'one' });
      await publishNew(s, crit, { body: 'critical' });
      const src = async (key_: string) => (await s.resolveMany([key_], { locale: 'en-US' })).sources.get(key_);
      expect(await src(k)).toBe('db');
      expect(await src(k)).toBe('cache');
      const entryKey = (await redis.keys(`bg:${env}:content:v1:${k}:*`))[0]!;
      const ttl = await redis.ttl(entryKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
      // invalidation: publication bumps the entry generation, the old entry becomes unreachable
      await publishNew(s, k, { body: 'two' });
      expect(await redis.get(`bg:${env}:content:gen:${k}`)).toBe('2');
      const r = await s.resolveMany([k], { locale: 'en-US' });
      expect([r.items.get(k)!.body, r.sources.get(k)]).toEqual(['two', 'db']);
      expect(await src(k)).toBe('cache');
      // locale changes bump the locale generation
      await s.registerLocale({ locale: 'ko-KR', reason: 'valkey test' }, A);
      expect(Number(await redis.get(`bg:${env}:content:locgen`))).toBeGreaterThanOrEqual(1);
      expect(await src(k)).toBe('db');
      // CRITICAL copy never reaches Valkey
      await s.resolveMany([crit], { locale: 'en-US' });
      expect([...(await redis.keys(`bg:${env}:content:v1:${crit}:*`)), ...(await redis.keys(`bg:${env}:content:lkg:${crit}:*`))]).toEqual([]); // only the generation counter exists
      // last-known-good during a database outage, from the real cache
      await s.resolveMany([k], { locale: 'en-US' });
      const lkg = await redis.keys(`bg:${env}:content:lkg:${k}:*`);
      expect(lkg).toHaveLength(1);
      for (const x of await redis.keys(`bg:${env}:content:v1:*`)) await redis.del(x);
      const outage = new ContentService({ database: broken, cache, env });
      const served = await outage.resolveMany([k], { locale: 'en-US' });
      expect([served.items.get(k)!.body, served.sources.get(k)]).toEqual(['two', 'lkg']);
      expect(await code(outage.resolveMany([crit], { locale: 'en-US' }))).toBe('UNAVAILABLE');
      expect(await code(outage.resolveMany([k, crit], { locale: 'en-US' }))).toBe('UNAVAILABLE');
    } finally {
      await broken.close();
      const leftovers = await redis.keys(`bg:${env}:content:*`);
      if (leftovers.length) await redis.del(...leftovers);
      redis.disconnect();
    }
  });
});

// ====================================================================== review fixes (CFG-002 findings R4#1, R1#1/R4#2, R1#2, R2#1, R2#4, R2#6, R2#7/R3#3)
describe('a cache outage never slows resolution (R4#1)', () => {
  /** n STANDARD entries, each with one published en-US version. */
  async function publishedKeys(n: number): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = key(`outage${i}`);
      await svc.createEntry(entryReq(k), A);
      await publishNew(svc, k, { body: `body ${i}` });
      keys.push(k);
    }
    return keys;
  }
  const never = <T>() => new Promise<T>(() => undefined);
  const slowFail = <T>() => new Promise<T>((_, reject) => setTimeout(() => reject(new Error('ECONNREFUSED 127.0.0.1:1')), 3_000));
  const fakeClient = (stall: <T>() => Promise<T>) => ({ get: () => stall(), mget: () => stall(), set: () => stall(), incr: () => stall() });

  for (const [name, stall] of [
    ['hangs forever', never],
    ['fails slowly (3 s per command)', slowFail],
  ] as const) {
    it(`resolveMany of 8 keys completes quickly with the correct database result while Valkey ${name}; publishing is not delayed either`, async () => {
      const keys = await publishedKeys(8);
      const s = new ContentService({
        database: db(),
        cache: new ValkeyConfigCache(fakeClient(stall) as never),
        env: 'test',
        allowTestKeys: true,
      });
      for (const round of [1, 2]) {
        const t = Date.now();
        const r = await s.resolveMany(keys, { locale: 'en-US' });
        expect(Date.now() - t, `round ${round}`).toBeLessThan(1500);
        expect([...r.items.values()].map((i) => i.body)).toEqual(keys.map((_, i) => `body ${i}`));
        expect([...r.sources.values()]).toEqual(Array(8).fill('db'));
      }
      const t = Date.now();
      await publishNew(s, keys[0]!, { body: 'republished during the outage' });
      expect(Date.now() - t).toBeLessThan(1500); // invalidation (generation bump) is bounded as well
      expect((await s.resolve(keys[0]!, { locale: 'en-US' })).body).toBe('republished during the outage');
    });
  }

  it('a real client pointed at a closed port with the production options (the reviewer reproduction: 3.3 s for 1 key, 88 s for 8) is fast too', async () => {
    const keys = await publishedKeys(8);
    const client = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 2 });
    client.on('error', () => undefined);
    try {
      const s = new ContentService({ database: db(), cache: new ValkeyConfigCache(client), env: 'test', allowTestKeys: true });
      const t = Date.now();
      const r = await s.resolveMany(keys, { locale: 'en-US' });
      expect(Date.now() - t).toBeLessThan(1500);
      expect([...r.items.values()].map((i) => i.body)).toEqual(keys.map((_, i) => `body ${i}`));
      expect([...r.sources.values()]).toEqual(Array(8).fill('db'));
    } finally {
      client.disconnect();
    }
  });
});

describe('INTERNAL entries leak no existence to callers without INTERNAL visibility (R1#1, R4#2)', () => {
  it('an unpublished INTERNAL entry, one with only a future-scheduled version, one with live content and a nonexistent key are indistinguishable', async () => {
    const draftOnly = key('int_draft');
    const futureOnly = key('int_future');
    const live = key('int_live');
    const nonexistent = key('int_nothing'); // never created
    for (const k of [draftOnly, futureOnly, live]) await svc.createEntry(entryReq(k, { sensitivity: 'INTERNAL' }), A);
    await svc.createVersion(draftOnly, { locale: 'en-US', body: 'draft secret', reason: 'draft' }, A);
    await publishNew(svc, futureOnly, { body: 'future secret', from: inMs(3_600_000) });
    await publishNew(svc, live, { body: 'live secret' });
    for (const cache of [undefined, new MemoryConfigCache()]) {
      const s = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
      for (const round of [1, 2]) {
        const outcomes = [];
        for (const k of [draftOnly, futureOnly, live, nonexistent]) {
          const e = await err(s.resolve(k, { locale: 'en-US', includeInternal: false }));
          outcomes.push([e.code, e.message, Object.keys(e.details).sort(), JSON.stringify(e.details).replace(k, 'KEY')]);
        }
        expect(outcomes, `round ${round}`).toEqual(Array(4).fill(outcomes[0]));
        expect(outcomes[0]![0]).toBe('ENTRY_NOT_FOUND');
        const batch = await s.resolveMany([draftOnly, futureOnly, live, nonexistent], { locale: 'en-US', includeInternal: false });
        expect(batch.items.size).toBe(0);
        expect([...batch.missing.values()]).toEqual(Array(4).fill('ENTRY_NOT_FOUND'));
      }
      // trusted callers keep the truthful answers
      expect(await code(s.resolve(draftOnly, { locale: 'en-US' }))).toBe('NO_CONTENT');
      expect(await code(s.resolve(futureOnly, { locale: 'en-US' }))).toBe('NO_CONTENT');
      expect((await s.resolve(live, { locale: 'en-US' })).body).toBe('live secret');
      expect(await code(s.resolve(nonexistent, { locale: 'en-US' }))).toBe('ENTRY_NOT_FOUND');
    }
  });
});

describe('the cache key space is bounded by operator-controlled data (R1#2)', () => {
  const cacheKeys = (cache: MemoryConfigCache) => [...cache.data.keys()].filter((k) => k.includes(':v1:') || k.includes(':lkg:'));

  it('1000 distinct unknown contexts and unregistered locales create ZERO cache or last-known-good keys, yet are answered correctly every time', async () => {
    const k = key('bounded');
    await svc.createEntry(entryReq(k), A);
    await publishNew(svc, k, { body: 'platform copy' });
    await publishNew(svc, k, { body: 'market copy', scopeType: 'MARKET', scopeRef: 'us-ca' }).catch(() => undefined); // maxScopeType PLATFORM: refused
    const cache = new MemoryConfigCache();
    const s = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const letter = (n: number) => String.fromCharCode(97 + (n % 26));
    const hit = async (i: number) => {
      const byContext = await s.resolveMany([k], { locale: 'en-US', context: { country: `zz${i}`, market: `mk-${i}` } });
      const byLocale = await s.resolveMany([k], { locale: `${letter(i)}${letter(Math.floor(i / 26))}${letter(Math.floor(i / 676))}-US` });
      for (const r of [byContext, byLocale]) {
        expect(r.items.get(k)?.body).toBe('platform copy');
        expect(r.sources.get(k)).toBe('db');
      }
    };
    for (let from = 0; from < 1000; from += 25) await Promise.all(Array.from({ length: 25 }, (_, j) => hit(from + j)));
    expect(cache.data.size).toBe(0);
    expect(cacheKeys(cache)).toEqual([]);
  }, 120_000);

  it('known contexts and active locales are still cached; an unknown reference next to a known one is not', async () => {
    const k = key('bounded_known');
    await svc.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
    await publishNew(svc, k, { body: 'platform copy' });
    await publishNew(svc, k, { body: 'california copy', scopeType: 'MARKET', scopeRef: 'us-ca' });
    await publishNew(svc, k, { body: 'us copy', scopeType: 'COUNTRY', scopeRef: 'US' });
    await svc.registerLocale({ locale: 'nl-NL', reason: 'bounded test' }, A).catch(() => undefined);
    const cache = new MemoryConfigCache();
    const s = new ContentService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const src = async (locale: string, context?: Record<string, string>) => (await s.resolveMany([k], { locale, context })).sources.get(k);

    expect(await src('en-US')).toBe('db');
    expect(await src('en-US')).toBe('cache');
    expect(await src('en-US', { market: 'us-ca', country: 'US' })).toBe('db');
    expect(await src('en-US', { market: 'us-ca', country: 'US' })).toBe('cache');
    expect((await s.resolve(k, { locale: 'en-US', context: { market: 'us-ca', country: 'US' } })).body).toBe('california copy');
    const known = cacheKeys(cache).length;
    expect(known).toBeGreaterThan(0);

    // a market that matches no published version of the entry, alone or next to a known country
    for (let i = 0; i < 5; i++) {
      expect(await src('en-US', { market: `nowhere-${i}` })).toBe('db');
      expect(await src('en-US', { country: 'US', market: `nowhere-${i}` })).toBe('db');
    }
    // a registered but inactive locale, and an inactive market default locale
    expect(await src('nl-NL')).toBe('db');
    expect(await src('nl-NL')).toBe('db');
    expect(await src('en-US', { marketDefaultLocale: 'nl-NL' })).toBe('db');
    expect(cacheKeys(cache).length).toBe(known);
    // and the answers are the truthful ones
    expect((await s.resolve(k, { locale: 'en-US', context: { country: 'US', market: 'nowhere-1' } })).body).toBe('us copy');
  });
});

describe('an immediate publication activates due-but-not-yet-activated predecessors (R2#1)', () => {
  it('LEGAL: v2 scheduled 400 ms ahead and never activated by the job, then an immediate v3: v2 ends SUPERSEDED with its activation audit and both events', () =>
    withFreshService(async (s, fresh) => {
      const k = key('terms');
      await s.createEntry({ key: k, contentType: 'LEGAL', ownerRole: 'LEGAL', description: 'Terms of service', variables: [] }, A);
      const v1 = await publishNew(s, k, { body: 'terms v1' });
      const v2 = await publishNew(s, k, { body: 'terms v2', from: inMs(400) });
      expect(v2.status).toBe('SCHEDULED');
      await sleep(700); // v2 is now in force (resolution never waits for the job) but the job has not run
      expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('terms v2');
      expect((await s.getVersion(v2.versionId)).status).toBe('SCHEDULED');
      const v3 = await publishNew(s, k, { body: 'terms v3' });
      expect(v3.status).toBe('PUBLISHED');
      const states = await rows([v1.versionId, v2.versionId, v3.versionId], fresh);
      expect(states.map((r) => r.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'PUBLISHED']);
      // a gap-free chain
      expect(states[0]!.effective_to).toEqual(states[1]!.effective_from);
      expect(states[1]!.effective_to).toEqual(states[2]!.effective_from);

      const trail = (await audit(k, fresh)).filter((a) => a.version_id === v2.versionId);
      expect(trail.map((a) => a.action)).toEqual([
        'VERSION_DRAFTED',
        'VERSION_SUBMITTED',
        'VERSION_APPROVED',
        'VERSION_PUBLISHED',
        'VERSION_ACTIVATED',
        'VERSION_SUPERSEDED',
      ]);
      expect(trail.find((a) => a.action === 'VERSION_ACTIVATED')).toMatchObject({ actor: 'system:content-activation', previous_version_id: v1.versionId });
      // v1 was superseded when v2 was activated, v2 when v3 was published: one supersession each, nothing skipped
      const all = await audit(k, fresh);
      expect(all.filter((a) => a.action === 'VERSION_ACTIVATED').map((a) => a.version_id)).toEqual([v1.versionId, v2.versionId, v3.versionId]);
      expect(all.filter((a) => a.action === 'VERSION_SUPERSEDED').map((a) => a.version_id)).toEqual([v1.versionId, v2.versionId]);

      // events of one transaction share created_at (the outbox orders by transaction time), so compare by version rather than by position
      const byVersion = async (type: string) => new Map((await outbox(type, fresh)).map((e) => [e.aggregate_id, e.payload_json]));
      const published = await byVersion(CONTENT_EVENTS.versionPublished);
      const legal = await byVersion(CONTENT_EVENTS.legalDocumentPublished);
      expect([...published.keys()].sort()).toEqual([v1.versionId, v2.versionId, v3.versionId].sort());
      expect([...legal.keys()].sort()).toEqual([v1.versionId, v2.versionId, v3.versionId].sort());
      expect(legal.get(v2.versionId)).toMatchObject({ bodySha256: sha('terms v2'), previousVersionId: v1.versionId, version: 2 });
      expect(legal.get(v3.versionId)).toMatchObject({ bodySha256: sha('terms v3'), previousVersionId: v2.versionId, version: 3 });
      expect(published.get(v2.versionId)).toMatchObject({ previousVersionId: v1.versionId, version: 2 });
      expect((await outbox(CONTENT_EVENTS.versionScheduled, fresh)).map((e) => e.aggregate_id)).toEqual([v2.versionId]);
      // the job has nothing left to do and emits nothing more
      expect(await s.activateDue()).toBe(0);
      expect((await outbox(CONTENT_EVENTS.versionPublished, fresh)).length).toBe(3);
    }));

  it('several due predecessors are activated in version order before the supersession', () =>
    withFreshService(async (s, fresh) => {
      const k = key('multi');
      await s.createEntry(entryReq(k), A);
      const v1 = await publishNew(s, k, { body: 'one' });
      const v2 = await publishNew(s, k, { body: 'two', from: inMs(300) });
      await sleep(500);
      // v3 cannot be scheduled after v2 while v2 is open-ended unless it starts later; start it after v2 and let both become due
      const v3 = await publishNew(s, k, { body: 'three', from: inMs(300) });
      await sleep(500);
      const v4 = await publishNew(s, k, { body: 'four' });
      const states = await rows([v1.versionId, v2.versionId, v3.versionId, v4.versionId], fresh);
      expect(states.map((r) => r.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED', 'PUBLISHED']);
      const activated = (await audit(k, fresh)).filter((a) => a.action === 'VERSION_ACTIVATED').map((a) => a.version_id);
      expect(activated).toEqual([v1.versionId, v2.versionId, v3.versionId, v4.versionId]);
      const published = new Map((await outbox(CONTENT_EVENTS.versionPublished, fresh)).map((e) => [e.aggregate_id, e.payload_json.previousVersionId]));
      expect(Object.fromEntries(published)).toEqual({
        [v1.versionId]: null,
        [v2.versionId]: v1.versionId,
        [v3.versionId]: v2.versionId,
        [v4.versionId]: v3.versionId,
      });
    }));
});

describe('the database refuses to rewrite history and keeps the audit trail consistent (R2#4, R2#6)', () => {
  it('closing a published version in the past is refused by SQL; the service flows (closing at the successor start) still pass', async () => {
    const k = key();
    await svc.createEntry(entryReq(k), A);
    const v1 = await publishNew(svc, k, { body: 'first' });
    await sleep(30);
    const past = new Date(Date.now() - 10).toISOString();
    expect(String(await rejection(q('UPDATE content.versions SET effective_to = $2 WHERE version_id = $1', [v1.versionId, past])))).toMatch(
      /effective_to cannot be closed in the past/,
    );
    expect(
      String(await rejection(q("UPDATE content.versions SET effective_to = effective_from + interval '1 millisecond' WHERE version_id = $1", [v1.versionId]))),
    ).toMatch(/effective_to cannot be closed in the past/);
    expect((await rows([v1.versionId]))[0]!.effective_to).toBeNull();
    // a historical resolution is unchanged by the refused attempts
    expect((await svc.resolve(k, { locale: 'en-US', at: new Date(Date.now() - 10) })).body).toBe('first');
    // the service closes at the successor start, which is never before the transaction start
    const v2 = await publishNew(svc, k, { body: 'second' });
    expect((await rows([v1.versionId]))[0]).toMatchObject({ status: 'SUPERSEDED' });
    expect((await rows([v1.versionId]))[0]!.effective_to).toEqual(v2.effectiveFrom);
    // closing in the future is still allowed by SQL (a one-time close of an open-ended published version)
    const v3 = await publishNew(svc, k, { body: 'third', from: inMs(60_000) });
    expect(v3.status).toBe('SCHEDULED');
    expect((await rows([v2.versionId]))[0]!.effective_to).toEqual(v3.effectiveFrom);
  });

  it('an audit row cannot attach a version to another entry (as version or as previous version), and version and entry actions carry no locale', async () => {
    const k1 = key();
    const k2 = key();
    await svc.createEntry(entryReq(k1), A);
    await svc.createEntry(entryReq(k2), A);
    const a = await publishNew(svc, k1, { body: 'a' });
    const b = await publishNew(svc, k2, { body: 'b' });
    const insert = (action: string, entryId: string, versionId: string | null, locale: string | null, previous: string | null = null) =>
      rejection(
        q(
          `INSERT INTO content.audit_events (actor, action, entry_id, locale, version_id, previous_version_id, correlation_id) VALUES ('sql', $1, $2, $3, $4, $5, 'cid')`,
          [action, entryId, locale, versionId, previous],
        ),
      ) as Promise<{ code?: string; constraint?: string }>;
    const eB = await entryIdOf(k2);
    expect(await insert('VERSION_SUBMITTED', eB, a.versionId, null)).toMatchObject({ code: '23503', constraint: 'fk_audit_events__version_entry' });
    expect(await insert('VERSION_PUBLISHED', eB, b.versionId, null, a.versionId)).toMatchObject({
      code: '23503',
      constraint: 'fk_audit_events__previous_version_entry',
    });
    expect(await insert('VERSION_SUBMITTED', eB, b.versionId, 'en-US')).toMatchObject({ code: '23514', constraint: 'ck_audit_events__subject' });
    expect(await insert('ENTRY_ACTIVATED', eB, null, 'en-US')).toMatchObject({ code: '23514', constraint: 'ck_audit_events__subject' });
    expect(await insert('LOCALE_ACTIVATED', eB, null, 'en-US')).toMatchObject({ code: '23514' }); // locale actions name no entry
    // consistent rows are accepted
    expect(await insert('VERSION_SUBMITTED', eB, b.versionId, null)).toBeUndefined();
  });
});

describe('exactly one platform default locale (R2#7, R3#3)', () => {
  it('SQL cannot unset the platform default (the unique index forbids two, the guard forbids none); other locale changes still work', async () => {
    expect(String(await rejection(q("UPDATE content.locales SET is_platform_default = false WHERE locale = 'en-US'")))).toMatch(
      /the platform default locale cannot be unset/,
    );
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM content.locales WHERE is_platform_default'))[0]!.n)).toBe(1);
    await svc.registerLocale({ locale: 'fi-FI', reason: 'default test' }, A);
    expect(await dbCode(q("UPDATE content.locales SET is_platform_default = true, is_active = true WHERE locale = 'fi-FI'"))).toBe('23505'); // a second default
    expect(await dbCode(q("UPDATE content.locales SET is_platform_default = false WHERE locale = 'fi-FI'"))).toBeUndefined(); // not a default: nothing to unset
  });

  it('resolution fails loudly with a typed UNAVAILABLE when no platform default exists (it never falls back to the requested locale)', () =>
    withFreshService(async (s, fresh) => {
      const k = key();
      await s.createEntry(entryReq(k), A);
      await publishNew(s, k, { body: 'english' });
      expect((await s.resolve(k, { locale: 'en-US' })).body).toBe('english');
      // only a migration moves the default: it disables the guard for its own transaction
      await fresh.database.query('ALTER TABLE content.locales DISABLE TRIGGER trg_locales__guard');
      await fresh.database.query("UPDATE content.locales SET is_platform_default = false WHERE locale = 'en-US'");
      await fresh.database.query('ALTER TABLE content.locales ENABLE TRIGGER trg_locales__guard');
      const e = await err(s.resolve(k, { locale: 'en-US' }));
      expect(e).toBeInstanceOf(ContentError);
      expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'NO_PLATFORM_DEFAULT' } });
      expect(await code(s.resolveMany([k, 'devtest.unknown.key'], { locale: 'es-MX' }))).toBe('UNAVAILABLE');
      expect(await code(s.createSnapshot({ keys: [k], locale: 'en-US', purpose: 'p' }, A))).toBe('UNAVAILABLE');
    }));
});

// ---------------------------------------------------------------- GEO-001: ports against the real database (fake geography)
describe('geography ports (GEO-001): fake MarketDefaultsProvider and ScopeReferenceValidator over real PostgreSQL', () => {
  let geo: IsolatedDatabase;
  const MARKET = 'devtest-m1';
  const answers: Record<string, string | null | Error> = {};
  const providerCalls: string[] = [];
  const markets: MarketDefaultsProvider = {
    defaultLocale: async (m) => {
      providerCalls.push(m);
      const a = answers[m];
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  };
  /** Accepts COUNTRY US and MARKET devtest-m1 only; `mode` simulates a retired reference or an outage. */
  let mode: 'ok' | 'retired' | 'down' = 'ok';
  const validator: ScopeReferenceValidator = {
    validate: async (t, r): Promise<ScopeReferenceCheck> => {
      if (mode === 'down') throw new Error('geography unavailable');
      if (mode === 'retired') return { valid: false, reason: 'INACTIVE' };
      return (t === 'COUNTRY' && r === 'US') || (t === 'MARKET' && r === MARKET) ? { valid: true } : { valid: false, reason: 'NOT_FOUND' };
    },
  };
  const make = (extra: Partial<ConstructorParameters<typeof ContentService>[0]> = {}) =>
    new ContentService({ database: geo.database, env: 'test', allowTestKeys: true, markets, scopeReferences: validator, ...extra });
  let s: ContentService;
  const versionCount = async (entryKey: string) =>
    Number(
      (
        await geo.database.query<{ n: string }>(
          'SELECT count(*) AS n FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key = $1',
          [entryKey],
        )
      )[0]!.n,
    );
  /** An entry with copy in en-US (platform default), es-MX, pt-BR (active) and de-DE (registered, inactive). */
  async function localized(maxScopeType: 'PLATFORM' | 'MARKET' = 'PLATFORM'): Promise<string> {
    const k = key();
    await s.createEntry(entryReq(k, { maxScopeType }), A);
    for (const [locale, body] of [
      ['en-US', 'english'],
      ['es-MX', 'mexico'],
      ['pt-BR', 'brasil'],
      ['de-DE', 'german'],
    ] as const)
      await publishNew(s, k, { locale, body });
    return k;
  }

  beforeAll(async () => {
    geo = await createIsolatedDatabase();
    s = make();
    for (const l of ['es-MX', 'pt-BR', 'fr-CA']) await s.registerLocale({ locale: l, active: true, reason: 'geo test' }, A);
    await s.registerLocale({ locale: 'de-DE', reason: 'geo test (inactive)' }, A);
  });
  afterAll(async () => geo.drop());

  describe('market default precedence: requested locale -> market default -> platform default', () => {
    it('a requested locale with content wins over any market default', async () => {
      const k = await localized();
      answers[MARKET] = 'pt-BR';
      expect(await s.resolve(k, { locale: 'es-MX', context: { market: MARKET } })).toMatchObject({ resolvedLocale: 'es-MX', body: 'mexico' });
    });
    it('a requested locale without content falls to the provider market default, then to the platform default when there is none', async () => {
      const k = await localized();
      answers[MARKET] = 'es-MX';
      const viaMarket = await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET } });
      expect(viaMarket).toMatchObject({
        resolvedLocale: 'es-MX',
        body: 'mexico',
        fallback: { applied: true, chain: ['fr-CA', 'es-MX', 'es', 'en-US'].filter((l) => l !== 'es') },
      });
      answers[MARKET] = null;
      const viaPlatform = await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET } });
      expect(viaPlatform).toMatchObject({ resolvedLocale: 'en-US', body: 'english', fallback: { chain: ['fr-CA', 'en-US'] } });
      expect(await s.resolve(k, { locale: 'fr-CA', context: { market: 'devtest-unknown' } })).toMatchObject({ resolvedLocale: 'en-US' }); // provider: no such market
    });
    it('an explicit marketDefaultLocale wins over the provider', async () => {
      const k = await localized();
      answers[MARKET] = 'es-MX';
      providerCalls.length = 0;
      expect(await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET, marketDefaultLocale: 'pt-BR' } })).toMatchObject({
        resolvedLocale: 'pt-BR',
        body: 'brasil',
      });
      expect(providerCalls).toEqual([]);
    });
    it('a failing provider degrades to the platform default; an inactive market default locale is skipped', async () => {
      const k = await localized();
      answers[MARKET] = new Error('geography is down');
      expect(await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET } })).toMatchObject({ resolvedLocale: 'en-US', body: 'english' });
      answers[MARKET] = 'de-DE'; // registered with content, but not active
      expect(await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET } })).toMatchObject({
        resolvedLocale: 'en-US',
        fallback: { chain: ['fr-CA', 'en-US'] },
      });
      answers[MARKET] = 'ja-JP'; // not registered at all
      expect((await s.resolve(k, { locale: 'fr-CA', context: { market: MARKET } })).resolvedLocale).toBe('en-US');
    });
    it('LANGUAGE_ONLY and EXACT entries never use a market default (the chain policy is unchanged)', async () => {
      answers[MARKET] = 'es-MX';
      for (const policy of ['LANGUAGE_ONLY', 'EXACT'] as const) {
        const k = key();
        await s.createEntry(entryReq(k, { fallbackPolicy: policy }), A);
        await publishNew(s, k, { locale: 'es-MX', body: 'mexico' });
        await publishNew(s, k, { locale: 'en-US', body: 'english' });
        const r = await s.resolveMany([k], { locale: 'fr-CA', context: { market: MARKET } });
        expect(r.items.has(k), policy).toBe(false);
        expect(r.missing.get(k), policy).toBe('NO_CONTENT');
      }
    });
  });

  describe('cache and snapshots use the derived default', () => {
    it('cache keys differ per derived default and a changed provider answer takes effect on the next resolve', async () => {
      const cache = new MemoryConfigCache();
      const cs = make({ cache });
      const k = await localized('MARKET');
      await publishNew(s, k, { scopeType: 'MARKET', scopeRef: MARKET, locale: 'en-US', body: 'market english' }); // makes the market reference "matched": cacheable
      const ask = () => cs.resolveMany([k], { locale: 'fr-CA', context: { market: MARKET } });
      const resolutionKeys = () => [...cache.data.keys()].filter((x) => x.includes(':v1:') && x.includes(k));
      answers[MARKET] = 'es-MX';
      expect((await ask()).items.get(k)).toMatchObject({ body: 'mexico' });
      expect((await ask()).sources.get(k)).toBe('cache');
      expect(resolutionKeys()).toHaveLength(1);
      answers[MARKET] = 'pt-BR';
      const changed = await ask();
      expect(changed.items.get(k)).toMatchObject({ body: 'brasil', resolvedLocale: 'pt-BR' });
      expect(changed.sources.get(k)).toBe('db');
      expect(resolutionKeys()).toHaveLength(2);
    });

    it('a snapshot records the market default locale that was actually used', async () => {
      const k = await localized();
      answers[MARKET] = 'es-MX';
      const snap = await s.createSnapshot({ keys: [k], locale: 'fr-CA', context: { market: MARKET }, purpose: 'geo precedence' }, A);
      expect(snap.context).toEqual({ market: MARKET, marketDefaultLocale: 'es-MX' });
      expect(snap.requestedLocale).toBe('fr-CA');
      expect(snap.items[0]).toMatchObject({ resolvedLocale: 'es-MX', body: 'mexico' });
      expect(await s.getSnapshot(snap.snapshotId)).toEqual(snap);
    });
    it('a snapshot does not claim a derived default that resolution skipped (inactive locale) or one the provider could not give', async () => {
      const k = await localized();
      for (const answer of ['de-DE', null, new Error('down')]) {
        answers[MARKET] = answer;
        const snap = await s.createSnapshot({ keys: [k], locale: 'fr-CA', context: { market: MARKET }, purpose: 'geo skipped' }, A);
        expect(snap.context).toEqual({ market: MARKET });
        expect(snap.items[0]).toMatchObject({ resolvedLocale: 'en-US' });
      }
      answers[MARKET] = 'es-MX';
      const explicit = await s.createSnapshot(
        { keys: [k], locale: 'fr-CA', context: { market: MARKET, marketDefaultLocale: 'pt-BR' }, purpose: 'geo explicit' },
        A,
      );
      expect(explicit.context).toEqual({ market: MARKET, marketDefaultLocale: 'pt-BR' });
      expect(explicit.items[0]).toMatchObject({ resolvedLocale: 'pt-BR' });
    });
    it('`at` lookups and CRITICAL entries keep their behaviour (never cached) with the derived default applied', async () => {
      const cache = new MemoryConfigCache();
      const cs = make({ cache });
      answers[MARKET] = 'es-MX';
      const k = await localized();
      const past = await cs.resolveMany([k], { locale: 'fr-CA', context: { market: MARKET }, at: inMs(60_000) });
      expect(past.items.get(k)).toMatchObject({ body: 'mexico' });
      expect(past.sources.get(k)).toBe('db');
      const crit = key();
      await s.createEntry(entryReq(crit, { criticality: 'CRITICAL' }), A);
      await publishNew(s, crit, { locale: 'es-MX', body: 'critical mexico' });
      await publishNew(s, crit, { locale: 'en-US', body: 'critical english' });
      for (let i = 0; i < 2; i++) {
        const r = await cs.resolveMany([crit], { locale: 'fr-CA', context: { market: MARKET } });
        expect(r.items.get(crit)).toMatchObject({ body: 'critical mexico' });
        expect(r.sources.get(crit)).toBe('db');
      }
      expect([...cache.data.keys()].filter((x) => x.includes(crit))).toEqual([]);
    });
  });

  describe('COUNTRY/MARKET scope reference validation', () => {
    it('createVersion accepts a valid reference and refuses an invalid one without writing anything', async () => {
      mode = 'ok';
      const k = key();
      await s.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
      const ok = await s.createVersion(k, { locale: 'en-US', scopeType: 'COUNTRY', scopeRef: 'US', body: 'us copy', reason: 'r' }, A);
      expect(ok).toMatchObject({ scopeType: 'COUNTRY', scopeRef: 'US', status: 'DRAFT' });
      const bad = await err(s.createVersion(k, { locale: 'en-US', scopeType: 'MARKET', scopeRef: 'nowhere', body: 'x', reason: 'r' }, A));
      expect(bad).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'MARKET', check: 'NOT_FOUND' } });
      expect(await versionCount(k)).toBe(1);
      expect((await s.createVersion(k, { locale: 'en-US', body: 'platform copy', reason: 'r' }, A)).scopeRef).toBeNull(); // PLATFORM skipped
    });
    it('publish re-validates: a reference retired after drafting blocks publication until it is valid again', async () => {
      mode = 'ok';
      const k = key();
      await s.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
      const approved = await authorVersion(s, k, { scopeType: 'MARKET', scopeRef: MARKET, body: 'market copy' });
      mode = 'retired';
      const blocked = await err(s.publish(approved.versionId, A));
      expect(blocked).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SCOPE_REFERENCE_INVALID', check: 'INACTIVE' } });
      expect((await s.getVersion(approved.versionId)).status).toBe('APPROVED');
      mode = 'ok';
      expect((await s.publish(approved.versionId, A)).status).toBe('PUBLISHED');
    });
    it('a validator outage fails writes closed with UNAVAILABLE and leaves no trace', async () => {
      mode = 'ok';
      const k = key();
      await s.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
      const approved = await authorVersion(s, k, { scopeType: 'COUNTRY', scopeRef: 'US' });
      mode = 'down';
      expect(await err(s.createVersion(k, { locale: 'en-US', scopeType: 'COUNTRY', scopeRef: 'US', body: 'x', reason: 'r' }, A))).toMatchObject({
        code: 'UNAVAILABLE',
        details: { reason: 'SCOPE_REFERENCE_UNAVAILABLE' },
      });
      expect(await code(s.publish(approved.versionId, A))).toBe('UNAVAILABLE');
      expect(await versionCount(k)).toBe(1);
      expect((await s.getVersion(approved.versionId)).status).toBe('APPROVED');
      mode = 'ok';
    });
    it('without the validator the same service accepts any well-formed reference (unchanged behaviour)', async () => {
      const plain = make({ markets: undefined, scopeReferences: undefined });
      const k = key();
      await plain.createEntry(entryReq(k, { maxScopeType: 'MARKET' }), A);
      expect((await plain.createVersion(k, { locale: 'en-US', scopeType: 'MARKET', scopeRef: 'anything-goes', body: 'x', reason: 'r' }, A)).scopeRef).toBe(
        'anything-goes',
      );
    });
  });

  describe('locale display name and derived columns through the service', () => {
    it('derives the display name with Intl and returns the generated language, script and region', async () => {
      const r = await s.registerLocale({ locale: 'es-419', reason: 'derived' }, A);
      expect(r).toMatchObject({ locale: 'es-419', language: 'es', script: null, region: '419', isActive: false, isPlatformDefault: false });
      expect(r.displayName).toMatch(/^Spanish/);
      const hant = await s.registerLocale({ locale: 'zh-Hant-TW', reason: 'derived' }, A);
      expect(hant).toMatchObject({ language: 'zh', script: 'Hant', region: 'TW' });
      expect(hant.displayName).toMatch(/Chinese/);
      const bare = await s.registerLocale({ locale: 'fil', reason: 'derived' }, A);
      expect(bare).toMatchObject({ language: 'fil', script: null, region: null });
    });
    it('keeps an explicit display name (trimmed) and the seeded en-US name; list returns the new columns', async () => {
      const r = await s.registerLocale({ locale: 'it-IT', displayName: '  Italiano (Italia)  ', reason: 'explicit' }, A);
      expect(r.displayName).toBe('Italiano (Italia)');
      expect(await s.getLocale('en-US')).toMatchObject({
        displayName: 'English (United States)',
        language: 'en',
        script: null,
        region: 'US',
        isPlatformDefault: true,
      });
      const all = await s.listLocales();
      expect(all.find((l) => l.locale === 'it-IT')).toEqual(r);
      expect(all.every((l) => typeof l.displayName === 'string' && l.displayName.length > 0 && typeof l.language === 'string')).toBe(true);
      expect((await s.listLocales({ activeOnly: true })).map((l) => l.locale)).not.toContain('it-IT');
    });
    it('rejects blank and oversized display names, and the database defaults a name-less insert to the tag', async () => {
      expect(await code(s.registerLocale({ locale: 'nl-NL', displayName: '   ', reason: 'r' }, A))).toBe('VALIDATION_FAILED');
      expect(await code(s.registerLocale({ locale: 'nl-NL', displayName: 'x'.repeat(101), reason: 'r' }, A))).toBe('VALIDATION_FAILED');
      await geo.database.query("INSERT INTO content.locales (locale) VALUES ('sv-SE')");
      expect((await s.getLocale('sv-SE')).displayName).toBe('sv-SE');
      expect(await dbCode(geo.database.query("UPDATE content.locales SET display_name = '  ' WHERE locale = 'sv-SE'"))).toBe('23514');
      expect(await dbCode(geo.database.query("UPDATE content.locales SET region = 'XX' WHERE locale = 'sv-SE'"))).toBe('428C9'); // generated columns cannot drift
    });
  });
});
