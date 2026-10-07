// Unit tests for the parts of the service that need no database (validation, error mapping, rendering) and for the resolution
// facade against a scripted database. Lifecycle, locking and trigger behaviour is proven against real PostgreSQL in content.itest.ts.
import { describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache } from '@bananagig/configuration';
import type { ContentScopeType } from '@bananagig/contracts';
import type { Database, DatabaseSchema, Kysely } from '@bananagig/database';
import { ContentError } from './errors';
import type { ResolvedContent } from './resolver';
import type { MarketDefaultsProvider, ScopeReferenceCheck, ScopeReferenceValidator } from './market-defaults';
import { ContentService, defaultLocaleDisplayName, mapDbError, renderResolved, type CreateEntryInput } from './service';

const noDatabase = {} as Database; // any code path that reaches it fails loudly
const svc = (over: { allowTestKeys?: boolean } = {}) => new ContentService({ database: noDatabase, env: 'test', allowTestKeys: true, ...over });
const code = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as ContentError | undefined
  )?.code;
const rejected = async (p: Promise<unknown>) =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as ContentError;

const entry = (over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key: 'devtest.unit.title',
  contentType: 'UI_LABEL',
  ownerRole: 'CONTENT',
  description: 'unit test entry',
  ...over,
});

describe('mapDbError', () => {
  const pgError = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });
  it('maps constraint failures to typed codes and passes ContentError through', () => {
    const cases: [string, string, string | undefined, string][] = [
      ['23P01', 'conflicting key value violates exclusion constraint', 'ex_versions__no_overlap', 'CONFLICT'],
      ['23505', 'duplicate key value', 'uq_entries__key', 'CONFLICT'],
      ['23514', 'violates check constraint', 'ck_entries__legal_policy', 'VALIDATION_FAILED'],
      ['23502', 'null value', 'x', 'VALIDATION_FAILED'],
      ['23503', 'violates foreign key', 'fk_versions__locale', 'LOCALE_NOT_FOUND'],
      ['23503', 'violates foreign key', 'fk_other', 'VALIDATION_FAILED'],
      ['22021', 'invalid byte sequence', undefined, 'VALIDATION_FAILED'],
      ['23000', 'the author cannot approve their own version when a second approver is required', undefined, 'FORBIDDEN_APPROVER'],
      ['23000', 'version content is immutable; corrections create a new version', undefined, 'INVALID_STATE'],
      ['23000', 'illegal version transition PUBLISHED -> DRAFT', undefined, 'INVALID_STATE'],
    ];
    for (const [c, message, constraint, expected] of cases) {
      try {
        mapDbError(pgError(c, message, constraint));
        expect.unreachable();
      } catch (e) {
        expect(e, `${c} ${message}`).toBeInstanceOf(ContentError);
        expect((e as ContentError).code, `${c} ${message}`).toBe(expected);
      }
    }
    const typed = new ContentError('NO_CONTENT', 'x');
    expect(() => mapDbError(typed)).toThrow(typed);
    const unknown = new Error('something unexpected');
    expect(() => mapDbError(unknown)).toThrow(unknown);
    // connectivity failures become UNAVAILABLE (cause = driver message only)
    for (const outage of [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
      pgError('57P01', 'terminating connection due to administrator command'),
    ]) {
      try {
        mapDbError(outage);
        expect.unreachable();
      } catch (e) {
        expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { cause: outage.message } });
      }
    }
  });
  it('maps the geography locale-in-use guard (detail geography_rule:LOCALE_IS_ACTIVE_DEFAULT) to INVALID_STATE / LOCALE_IN_USE_BY_GEOGRAPHY; other 23000 errors keep the generic mapping', () => {
    const guarded = (detail?: string) =>
      Object.assign(new Error('locale es-US is the default of an ACTIVE country or market and cannot be deactivated'), { code: '23000', detail });
    const mapped = (e: unknown): ContentError | undefined => {
      try {
        mapDbError(e);
      } catch (err) {
        return err as ContentError;
      }
      return undefined;
    };
    const specific = mapped(guarded('geography_rule:LOCALE_IS_ACTIVE_DEFAULT'));
    expect(specific).toBeInstanceOf(ContentError);
    expect(specific).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' } });
    expect(specific!.details).toEqual({ reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' }); // identifiers and reasons only: nothing from the driver
    expect(mapped(guarded('geography_rule:LOCALE_IS_ACTIVE_DEFAULT; locale=es-US'))?.details).toEqual({ reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' });
    // the key is absent, a different key, or a lookalike: the old generic mapping (no reason)
    for (const detail of [undefined, '', 'geography_rule:SOMETHING_ELSE', 'geography_rule:LOCALE_IS_ACTIVE_DEFAULTS', 'other:LOCALE_IS_ACTIVE_DEFAULT']) {
      const generic = mapped(guarded(detail));
      expect(generic, String(detail)).toMatchObject({ code: 'INVALID_STATE', message: 'the operation violates an immutability or workflow rule' });
      expect(generic!.details).toEqual({});
    }
    // the other 23000 meanings are unchanged by the detail check
    expect(
      mapped(Object.assign(new Error('the author cannot approve their own version'), { code: '23000', detail: 'geography_rule:LOCALE_IS_ACTIVE_DEFAULT' }))
        ?.code,
    ).toBe('FORBIDDEN_APPROVER');
  });
  it('setLocaleActive surfaces the geography guard as INVALID_STATE / LOCALE_IN_USE_BY_GEOGRAPHY (and the plain trigger error as the generic INVALID_STATE)', async () => {
    const failing = (detail?: string): Database =>
      ({
        db: {},
        transaction: async () => {
          throw Object.assign(new Error('guard'), { code: '23000', detail });
        },
      }) as unknown as Database;
    const e = await rejected(
      new ContentService({ database: failing('geography_rule:LOCALE_IS_ACTIVE_DEFAULT'), env: 'test' }).setLocaleActive('es-US', false, 'retire', 'a'),
    );
    expect(e).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'LOCALE_IN_USE_BY_GEOGRAPHY' } });
    const generic = await rejected(new ContentService({ database: failing(), env: 'test' }).setLocaleActive('es-US', false, 'retire', 'a'));
    expect(generic).toMatchObject({ code: 'INVALID_STATE' });
    expect(generic.details).toEqual({});
  });
  it('never leaks copy text or row data from the driver message or detail', () => {
    const e = Object.assign(new Error('duplicate key value violates unique constraint "uq_versions__holder_version"'), {
      code: '23505',
      constraint: 'uq_versions__holder_version',
      detail: 'Key (entry_id, version)=(…) already exists. SECRET-COPY-SENTINEL',
      where: 'SECRET-COPY-SENTINEL',
    });
    let mapped: ContentError | undefined;
    try {
      mapDbError(e);
    } catch (err) {
      mapped = err as ContentError;
    }
    expect(mapped?.code).toBe('CONFLICT');
    expect(JSON.stringify({ m: mapped!.message, d: mapped!.details })).not.toContain('SECRET-COPY-SENTINEL');
    expect(mapped!.details).toEqual({ constraint: 'uq_versions__holder_version' });
  });
});

describe('createEntry validation (no database reached)', () => {
  it('rejects devtest keys outside dev/test, malformed keys and blank descriptions', async () => {
    expect(await code(svc({ allowTestKeys: false }).createEntry(entry(), 'a'))).toBe('VALIDATION_FAILED');
    for (const key of ['Bad', 'nodot', 'a..b', 'a.B', '1a.b', `a.${'x'.repeat(200)}`, 'a.b-c', ''])
      expect(await code(svc().createEntry(entry({ key }), 'a')), key).toBe('VALIDATION_FAILED');
    expect(await code(svc().createEntry(entry({ description: '   ' }), 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().createEntry(entry({ contentType: 'NOPE' as never }), 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().createEntry(entry({ ownerRole: 'ROOT' as never }), 'a'))).toBe('VALIDATION_FAILED');
  });
  it('LEGAL entries must be owned by LEGAL with SECOND_APPROVER, CRITICAL and EXACT', async () => {
    const e = await rejected(svc().createEntry(entry({ contentType: 'LEGAL', ownerRole: 'CONTENT' }), 'a'));
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'LEGAL_POLICY' } });
    for (const over of [
      { approvalPolicy: 'NONE' },
      { approvalPolicy: 'OWNER_APPROVAL' },
      { criticality: 'STANDARD' },
      { fallbackPolicy: 'CHAIN' },
      { fallbackPolicy: 'LANGUAGE_ONLY' },
    ] as const)
      expect(await rejected(svc().createEntry(entry({ contentType: 'LEGAL', ownerRole: 'LEGAL', ...over }), 'a')), JSON.stringify(over)).toMatchObject({
        details: { reason: 'LEGAL_POLICY' },
      });
  });
  it('validates variable definitions, including that every example conforms to its type', async () => {
    const v = (over: Record<string, unknown> = {}) => ({ name: 'n', type: 'COUNT' as const, description: 'd', example: 3, ...over });
    const reason = async (variables: never[]) => ((await rejected(svc().createEntry(entry({ variables }), 'a'))).details as { reason?: string }).reason;
    expect(await reason([v({ name: 'Bad' })] as never)).toBe('INVALID_FIELD');
    expect(await reason([v(), v()] as never)).toBe('DUPLICATE_VARIABLE');
    expect(await reason([v({ example: -1 })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ example: 1.5 })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'MONEY', example: 12.5 })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'MONEY', example: { amount_minor: 1250, currency: 'XXXX' } })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'DATE', example: '2030-02-30' })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'URL', example: 'javascript:alert(1)' })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'DATETIME', example: '2030-01-01T10:00:00' })] as never)).toBe('INVALID_EXAMPLE'); // no offset
    expect(await reason([v({ example: undefined })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ example: null })] as never)).toBe('INVALID_EXAMPLE');
    expect(await reason([v({ type: 'PERSON_DISPLAY_NAME', example: 'Ana', piiClass: 'NONE' })] as never)).toBe('PII_CLASS');
    expect(await reason([v({ type: 'WIDGET' })] as never)).toBe('INVALID_FIELD');
    expect(await reason([v({ description: '' })] as never)).toBe('INVALID_FIELD');
    expect(await reason(Array.from({ length: 31 }, (_, i) => v({ name: `v${i}` })) as never)).toBe('INVALID_FIELD');
    // the example failure names the variable and the reason, never the value
    const e = await rejected(svc().createEntry(entry({ variables: [v({ example: 'SECRET-COPY-SENTINEL', type: 'COUNT' })] as never }), 'a'));
    expect(e.details).toMatchObject({ variable: 'n', reason: 'INVALID_EXAMPLE' });
    expect(JSON.stringify(e.details) + e.message).not.toContain('SECRET-COPY-SENTINEL');
  });
});

describe('request validation before any database access', () => {
  const base = { locale: 'en-US', body: 'Hello', reason: 'why' };
  it('createVersion: locale, scope, reason, body and instants', async () => {
    const cases: Record<string, Parameters<ContentService['createVersion']>[1]> = {
      underscore: { ...base, locale: 'en_US' },
      padded: { ...base, locale: ' en-US' },
      platformWithRef: { ...base, scopeType: 'PLATFORM', scopeRef: 'x' },
      marketWithoutRef: { ...base, scopeType: 'MARKET' },
      badRef: { ...base, scopeType: 'MARKET', scopeRef: 'has space' },
      badScope: { ...base, scopeType: 'GIG' as never, scopeRef: 'g' },
      blankReason: { ...base, reason: '  ' },
      emptyBody: { ...base, body: '' },
      badInstant: { ...base, effectiveFrom: 'tomorrow' },
      badEnd: { ...base, effectiveTo: 'never' },
    };
    for (const [name, req] of Object.entries(cases)) expect(await code(svc().createVersion('devtest.a.b', req, 'a')), name).toBe('VALIDATION_FAILED');
  });
  it('locale management validates tags and reasons', async () => {
    expect(await code(svc().registerLocale({ locale: 'es_US', reason: 'r' }, 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().registerLocale({ locale: 'es-US', reason: ' ' }, 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().setLocaleActive('xx_YY', true, 'r', 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().setEntryActive('a.b', true, '', 'a'))).toBe('VALIDATION_FAILED');
  });
  it('lifecycle calls reject malformed ids as NOT_FOUND', async () => {
    const s = svc();
    for (const call of [
      () => s.submit('nope', 'a'),
      () => s.approve('nope', 'a'),
      () => s.reject('nope', 'a'),
      () => s.cancel('nope', 'a'),
      () => s.publish('nope', 'a'),
      () => s.getVersion('nope'),
      () => s.getSnapshot('nope'),
    ])
      expect(await code(call())).toBe('NOT_FOUND');
  });
  it('createSnapshot validates locale, purpose and keys', async () => {
    expect(await code(svc().createSnapshot({ keys: ['a.b'], locale: 'en_US', purpose: 'p' }, 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().createSnapshot({ keys: ['a.b'], locale: 'en-US', purpose: ' ' }, 'a'))).toBe('VALIDATION_FAILED');
    expect(await code(svc().createSnapshot({ keys: [], locale: 'en-US', purpose: 'p' }, 'a'))).toBe('VALIDATION_FAILED');
  });
});

// ---------------------------------------------------------------- rendering
const resolved = (over: Partial<ResolvedContent> = {}): ResolvedContent => ({
  key: 'devtest.unit.greeting',
  entryId: 'e1',
  contentType: 'UI_LABEL',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  requestedLocale: 'es-MX',
  resolvedLocale: 'es',
  fallback: { applied: true, chain: ['es-MX', 'es', 'en-US'] },
  version: 3,
  versionId: 'v1',
  sourceScope: 'PLATFORM',
  scopeRef: null,
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
  effectiveTo: null,
  body: 'Hola {name}',
  bodySha256: 'abc',
  variables: [{ name: 'name', type: 'STRING', required: true, description: 'd', example: 'Ana', piiClass: 'NONE' }],
  ...over,
});

describe('renderResolved', () => {
  it('renders plain text and keeps the version metadata (no body, no variable definitions)', () => {
    const r = renderResolved(resolved(), { name: 'Ana' });
    expect(r).toMatchObject({
      format: 'text',
      value: 'Hola Ana',
      versionId: 'v1',
      resolvedLocale: 'es',
      requestedLocale: 'es-MX',
      bodySha256: 'abc',
      version: 3,
    });
    expect('body' in r || 'variables' in r).toBe(false);
  });
  it('renders markup types as sanitized HTML and escapes variable values', () => {
    const r = renderResolved(resolved({ contentType: 'MARKDOWN', body: '**Hola** {name}' }), { name: '<img src=x onerror=alert(1)>' });
    expect(r.format).toBe('html');
    expect(r.value).toBe('<p><strong>Hola</strong> &lt;img src=x onerror=alert(1)&gt;</p>');
  });
  it('formats with the resolved locale by default and the override when given; strict about variables', () => {
    const money = resolved({
      body: '{total}',
      variables: [{ name: 'total', type: 'MONEY', required: true, description: 'd', example: { amount_minor: 100, currency: 'EUR' }, piiClass: 'NONE' }],
      resolvedLocale: 'de-DE',
    });
    const amount = { amount_minor: 123456, currency: 'EUR' };
    const norm = (s: string) => s.replace(new RegExp('[\\u00a0\\u202f]', 'g'), ' ');
    expect(norm(renderResolved(money, { total: amount }).value)).toBe('1.234,56 €');
    expect(norm(renderResolved(money, { total: amount }, { locale: 'en-US' }).value)).toBe('€1,234.56');
    expect(() => renderResolved(money, {})).toThrow(
      expect.objectContaining({ code: 'TEMPLATE_ERROR', details: expect.objectContaining({ reason: 'MISSING_REQUIRED_VARIABLE' }) }),
    );
    expect(() => renderResolved(money, { total: amount, extra: 1 })).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'UNKNOWN_VARIABLE' }) }),
    );
  });
});

// ---------------------------------------------------------------- resolution facade against a scripted database
function scriptedDatabase(rows: { entries: Record<string, unknown>[]; candidates: Record<string, unknown>[]; boundary?: Date | null }): {
  database: Database;
  queries: () => number;
  /** Every value bound into every query so far (flattened): lets a test prove which context references reached the database. */
  bound: () => unknown[];
} {
  let n = 0;
  const values: unknown[] = [];
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ sql: '', parameters: [], query: node, queryId: {} }),
    executeQuery: async (compiled: { query: { sqlFragments: string[]; parameters?: { value?: unknown }[] } }) => {
      n++;
      for (const p of compiled.query.parameters ?? []) values.push(p?.value);
      const text = compiled.query.sqlFragments.join('?');
      if (text.includes('requested_key')) return { rows: rows.entries };
      if (text.includes('min(t)')) return { rows: [{ t: rows.boundary ?? null }] };
      return { rows: rows.candidates };
    },
    withPlugins: () => executor,
  };
  return {
    database: { db: { getExecutor: () => executor } as unknown as Kysely<DatabaseSchema> } as unknown as Database,
    queries: () => n,
    bound: () => values.flat(),
  };
}
const eRow = (key: string, over: Record<string, unknown> = {}) => ({
  requested_key: key,
  entry_id: `id-${key}`,
  content_type: 'UI_LABEL',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  fallback_policy: 'CHAIN',
  is_active: true,
  variables: [{ name: 'name', type: 'STRING', required: true, description: 'd', example: 'Ana', piiClass: 'NONE' }],
  active_locales: ['en-US', 'es', 'es-MX'],
  platform_default: 'en-US',
  context_matched: true,
  db_now: new Date('2030-01-01T00:00:00Z'),
  ...over,
});
const cRow = (key: string, locale: string, body: string) => ({
  entry_id: `id-${key}`,
  locale,
  scope_type: 'PLATFORM',
  scope_ref: null,
  rank: 0,
  version_id: `v-${key}-${locale}`,
  version: 1,
  body,
  body_sha256: 'sha',
  effective_from: new Date('2029-01-01T00:00:00Z'),
  effective_to: null,
});

describe('resolution facade', () => {
  it('resolve/resolveMany/render/resolveRendered over a scripted database, with the cache in front', async () => {
    const { database, queries } = scriptedDatabase({
      entries: [eRow('ui.greeting'), eRow('ui.farewell')],
      candidates: [cRow('ui.greeting', 'en-US', 'Hello {name}'), cRow('ui.greeting', 'es', 'Hola {name}'), cRow('ui.farewell', 'en-US', 'Bye {name}')],
    });
    const s = new ContentService({ database, cache: new MemoryConfigCache(), env: 'test' });
    const many = await s.resolveMany(['ui.greeting', 'ui.farewell', 'ui.greeting'], { locale: 'es-MX', context: { country: 'US' } });
    expect(queries()).toBe(3);
    expect(many.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'es', body: 'Hola {name}' });
    expect(many.items.get('ui.farewell')).toMatchObject({ resolvedLocale: 'en-US', fallback: { applied: true, chain: ['es-MX', 'es', 'en-US'] } });
    expect([...many.sources.values()]).toEqual(['db', 'db']);
    const again = await s.resolveMany(['ui.greeting', 'ui.farewell'], { locale: 'es-MX', context: { country: 'US' } });
    expect([...again.sources.values()]).toEqual(['cache', 'cache']);
    expect(queries()).toBe(3);
    const rendered = await s.resolveRendered(['ui.greeting', 'ui.farewell'], {
      locale: 'es-MX',
      context: { country: 'US' },
      variables: { 'ui.greeting': { name: 'Ana' }, 'ui.farewell': { name: 'Luis' } },
    });
    expect(rendered.items.get('ui.greeting')).toMatchObject({
      format: 'text',
      value: 'Hola Ana',
      versionId: 'v-ui.greeting-es',
      resolvedLocale: 'es',
      bodySha256: 'sha',
    });
    expect(rendered.items.get('ui.farewell')?.value).toBe('Bye Luis');
    expect((await s.render('ui.greeting', { locale: 'es-MX', variables: { name: 'Bea' } })).value).toBe('Hola Bea');
    expect(await code(s.resolveRendered(['ui.greeting'], { locale: 'es-MX', context: { country: 'US' } }))).toBe('TEMPLATE_ERROR'); // required variable missing
  });

  it('reports unknown and empty entries; resolve() throws the typed errors', async () => {
    const { database } = scriptedDatabase({ entries: [eRow('ui.empty'), eRow('ui.gone', { entry_id: null, is_active: null })], candidates: [] });
    const s = new ContentService({ database, env: 'test' });
    const r = await s.resolveMany(['ui.empty', 'ui.gone'], { locale: 'en-US' });
    expect(Object.fromEntries(r.missing)).toEqual({ 'ui.empty': 'NO_CONTENT', 'ui.gone': 'ENTRY_NOT_FOUND' });
    expect(await code(s.resolve('ui.empty', { locale: 'en-US' }))).toBe('NO_CONTENT');
    expect(await code(s.resolve('ui.gone', { locale: 'en-US' }))).toBe('ENTRY_NOT_FOUND');
    expect(await code(s.resolve('ui.empty', { locale: 'en_US' }))).toBe('VALIDATION_FAILED');
  });

  it('INTERNAL entries behave like unknown ones when includeInternal is false (also when served from the cache)', async () => {
    const { database } = scriptedDatabase({
      entries: [eRow('ui.public'), eRow('ops.internal', { sensitivity: 'INTERNAL' })],
      candidates: [cRow('ui.public', 'en-US', 'p'), cRow('ops.internal', 'en-US', 'i')],
    });
    const s = new ContentService({ database, cache: new MemoryConfigCache(), env: 'test' });
    for (const round of [1, 2]) {
      const r = await s.resolveMany(['ui.public', 'ops.internal'], { locale: 'en-US', includeInternal: false });
      expect([...r.items.keys()], `round ${round}`).toEqual(['ui.public']);
      expect(Object.fromEntries(r.missing)).toEqual({ 'ops.internal': 'ENTRY_NOT_FOUND' });
      expect(r.sources.has('ops.internal')).toBe(false);
    }
    expect(await code(s.resolve('ops.internal', { locale: 'en-US', includeInternal: false }))).toBe('ENTRY_NOT_FOUND');
    expect((await s.resolve('ops.internal', { locale: 'en-US' })).sensitivity).toBe('INTERNAL'); // trusted callers (default) see it
  });

  it('INTERNAL entries without effective content look exactly like unknown keys for callers without INTERNAL visibility (no existence oracle)', async () => {
    // an unpublished INTERNAL entry, an INTERNAL entry with content, and a key that does not exist
    for (const cache of [undefined, new MemoryConfigCache()]) {
      const { database } = scriptedDatabase({
        entries: [
          eRow('ops.draft', { sensitivity: 'INTERNAL' }),
          eRow('ops.live', { sensitivity: 'INTERNAL' }),
          eRow('ui.public'),
          eRow('ops.gone', { entry_id: null, is_active: null }),
        ],
        candidates: [cRow('ops.live', 'en-US', 'secret'), cRow('ui.public', 'en-US', 'p')],
      });
      const s = new ContentService({ database, cache, env: 'test' });
      const keys = ['ops.draft', 'ops.live', 'ops.gone', 'ui.public'];
      for (const round of [1, 2]) {
        const hidden = await s.resolveMany(keys, { locale: 'en-US', includeInternal: false });
        expect([...hidden.items.keys()], `round ${round}`).toEqual(['ui.public']);
        expect(Object.fromEntries(hidden.missing)).toEqual({ 'ops.draft': 'ENTRY_NOT_FOUND', 'ops.live': 'ENTRY_NOT_FOUND', 'ops.gone': 'ENTRY_NOT_FOUND' });
      }
      // the thrown errors (what the API turns into the response) are identical apart from the key
      const errs = await Promise.all(['ops.draft', 'ops.live', 'ops.gone'].map((k) => rejected(s.resolve(k, { locale: 'en-US', includeInternal: false }))));
      expect(errs.map((e) => [e.code, e.message, Object.keys(e.details).sort()])).toEqual(
        Array(3).fill(['ENTRY_NOT_FOUND', 'content entry not found', ['key', 'locale']]),
      );
      // trusted callers (the default) still get the truthful NO_CONTENT for the draft
      expect(await code(s.resolve('ops.draft', { locale: 'en-US' }))).toBe('NO_CONTENT');
      expect((await s.resolveMany(['ops.draft'], { locale: 'en-US' })).missing.get('ops.draft')).toBe('NO_CONTENT');
    }
  });

  it('requests outside the bounded key space never write cache or last-known-good entries, and are still answered from the database every time', async () => {
    const cache = new MemoryConfigCache();
    const { database, queries } = scriptedDatabase({ entries: [eRow('ui.public')], candidates: [cRow('ui.public', 'en-US', 'p')] });
    const s = new ContentService({ database, cache, env: 'test' });
    // unknown context references (the database says nothing matched) and a locale that is not active
    const unmatched = scriptedDatabase({ entries: [eRow('ui.public', { context_matched: false })], candidates: [cRow('ui.public', 'en-US', 'p')] });
    const u = new ContentService({ database: unmatched.database, cache, env: 'test' });
    for (let i = 0; i < 1000; i++) {
      const r = await u.resolveMany(['ui.public'], { locale: 'en-US', context: { country: `zz${i}`, market: `m${i}` } });
      expect(r.items.get('ui.public')?.body).toBe('p');
      expect(r.sources.get('ui.public')).toBe('db');
    }
    const letter = (n: number) => String.fromCharCode(97 + (n % 26));
    for (let i = 0; i < 1000; i++) {
      const loc = `${letter(i)}${letter(Math.floor(i / 26))}${letter(Math.floor(i / 676))}-US`; // 1000 distinct well-formed, unregistered locales
      const r = await s.resolveMany(['ui.public'], { locale: loc });
      expect(r.items.get('ui.public')).toMatchObject({ body: 'p', fallback: { applied: true, chain: ['en-US'] } });
      expect(r.sources.get('ui.public')).toBe('db');
    }
    expect(cache.data.size).toBe(0);
    expect(queries()).toBe(3000); // the locale loop alone: 1000 requests x 3 queries (the unmatched-context loop used its own database)
    // the normal case still caches: active locale, references that matched
    await s.resolveMany(['ui.public'], { locale: 'en-US' });
    expect([...cache.data.keys()].some((k) => k.includes(':v1:'))).toBe(true);
    expect([...cache.data.keys()].some((k) => k.includes(':lkg:'))).toBe(true);
    expect((await s.resolveMany(['ui.public'], { locale: 'en-US' })).sources.get('ui.public')).toBe('cache');
  });
});

// ---------------------------------------------------------------- market default locale (port) and scope references (port)
const ALL_LOCALES = ['en-US', 'es', 'es-MX', 'fr-CA'];
/** A provider fake: answers from a mutable map, records every call, and can be told to throw. */
function fakeMarkets(answers: Record<string, string | null | Error>) {
  const calls: string[] = [];
  const provider: MarketDefaultsProvider = {
    defaultLocale: async (market) => {
      calls.push(market);
      const a = answers[market];
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  };
  return { provider, calls, answers };
}
const logged = () => {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // not a log line
    }
  });
  return { lines, restore: () => spy.mockRestore() };
};
const greeting = (over: Record<string, unknown> = {}) => ({
  entries: [eRow('ui.greeting', { active_locales: ALL_LOCALES, ...over })],
  candidates: [cRow('ui.greeting', 'en-US', 'Hello'), cRow('ui.greeting', 'es', 'Hola'), cRow('ui.greeting', 'es-MX', 'Hola Mexico')],
});

describe('market default locale derivation (requested locale -> market default -> platform default)', () => {
  it('uses the market default for a requested locale without content, and the platform default when the provider has no answer', async () => {
    const withMarket = new ContentService({
      database: scriptedDatabase(greeting()).database,
      env: 'test',
      markets: fakeMarkets({ 'la-oc': 'es' }).provider,
    });
    const r = await withMarket.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } });
    expect(r).toMatchObject({ resolvedLocale: 'es', body: 'Hola', requestedLocale: 'fr-CA', fallback: { applied: true, chain: ['fr-CA', 'es', 'en-US'] } });

    const noAnswer = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test', markets: fakeMarkets({ 'la-oc': null }).provider });
    expect(await noAnswer.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } })).toMatchObject({
      resolvedLocale: 'en-US',
      fallback: { applied: true, chain: ['fr-CA', 'en-US'] },
    });
    const noProvider = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test' });
    expect((await noProvider.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } })).resolvedLocale).toBe('en-US');
  });

  it('an explicit marketDefaultLocale always wins and the provider is not even asked', async () => {
    const m = fakeMarkets({ 'la-oc': 'es-MX' });
    const s = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test', markets: m.provider });
    const r = await s.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc', marketDefaultLocale: 'es' } });
    expect(r).toMatchObject({ resolvedLocale: 'es', fallback: { chain: ['fr-CA', 'es', 'en-US'] } });
    expect(m.calls).toEqual([]);
  });

  it('asks the provider once per call and only when a market is named without a default', async () => {
    const m = fakeMarkets({ 'la-oc': 'es' });
    const s = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test', markets: m.provider });
    await s.resolveMany(['ui.greeting', 'ui.other', 'ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' } });
    expect(m.calls).toEqual(['la-oc']);
    await s.resolveRendered(['ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' }, variables: { 'ui.greeting': { name: 'Ana' } } });
    await s.render('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' }, variables: { name: 'Ana' } });
    expect(m.calls).toEqual(['la-oc', 'la-oc', 'la-oc']);
    await s.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { country: 'US' } });
    await s.resolveMany(['ui.greeting'], { locale: 'fr-CA' });
    expect(m.calls).toHaveLength(3);
  });

  it('a failing provider degrades to no market default, logs only the market code, and never fails the request', async () => {
    const out = logged();
    try {
      const secret = new Error('postgres://user:s3cret@db/geography refused');
      const s = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test', markets: fakeMarkets({ 'la-oc': secret }).provider });
      const r = await s.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } });
      expect(r).toMatchObject({ resolvedLocale: 'en-US', fallback: { chain: ['fr-CA', 'en-US'] } });
      const warn = out.lines.filter((l) => l.level === 'warn');
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ market: 'la-oc' });
      expect(JSON.stringify(warn)).not.toContain('s3cret');
    } finally {
      out.restore();
    }
  });

  it('a malformed provider answer is ignored like a failure', async () => {
    const out = logged();
    try {
      const s = new ContentService({
        database: scriptedDatabase(greeting()).database,
        env: 'test',
        markets: fakeMarkets({ 'la-oc': 'not_a_locale' }).provider,
      });
      expect((await s.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } })).resolvedLocale).toBe('en-US');
      expect(out.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  it('an inactive or unregistered market default locale is skipped by the chain and never cached', async () => {
    const cache = new MemoryConfigCache();
    const s = new ContentService({
      database: scriptedDatabase(greeting()).database,
      cache,
      env: 'test',
      markets: fakeMarkets({ 'la-oc': 'de', inactive: 'es' }).provider,
    });
    const r = await s.resolve('ui.greeting', { locale: 'en-US', context: { market: 'la-oc' } });
    expect(r.fallback.chain).toEqual(['en-US']);
    expect(cache.data.size).toBe(0); // 'de' is not an ACTIVE locale: the key space would not be bounded by operator data
    const inactive = new ContentService({
      database: scriptedDatabase(greeting({ active_locales: ['en-US'] })).database,
      env: 'test',
      markets: fakeMarkets({ 'la-oc': 'es' }).provider,
    });
    expect((await inactive.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'la-oc' } })).resolvedLocale).toBe('en-US');
  });

  it('cache keys differ per derived default, and a changed provider answer takes effect on the next resolve', async () => {
    const cache = new MemoryConfigCache();
    const m = fakeMarkets({ 'la-oc': 'es' });
    const s = new ContentService({ database: scriptedDatabase(greeting()).database, cache, env: 'test', markets: m.provider });
    const ask = () => s.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' } });
    const first = await ask();
    expect(first.items.get('ui.greeting')?.body).toBe('Hola');
    expect(first.sources.get('ui.greeting')).toBe('db');
    expect((await ask()).sources.get('ui.greeting')).toBe('cache');
    const resolutionKeys = () => [...cache.data.keys()].filter((k) => k.includes(':v1:'));
    expect(resolutionKeys()).toHaveLength(1);
    m.answers['la-oc'] = 'es-MX';
    const changed = await ask();
    expect(changed.items.get('ui.greeting')).toMatchObject({ body: 'Hola Mexico', resolvedLocale: 'es-MX' });
    expect(changed.sources.get('ui.greeting')).toBe('db'); // not the cached 'es' answer
    expect(resolutionKeys()).toHaveLength(2);
    m.answers['la-oc'] = 'es';
    expect((await ask()).sources.get('ui.greeting')).toBe('cache'); // the first key is still valid for the first derived default
  });

  it('`at` lookups and CRITICAL entries behave as before (never cached), with the derived default applied', async () => {
    const cache = new MemoryConfigCache();
    const m = fakeMarkets({ 'la-oc': 'es' });
    const at = new Date('2030-06-01T00:00:00Z');
    const s = new ContentService({ database: scriptedDatabase(greeting()).database, cache, env: 'test', markets: m.provider });
    const r = await s.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' }, at });
    expect(r.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'es' });
    expect(r.sources.get('ui.greeting')).toBe('db');
    expect(cache.data.size).toBe(0);
    const critical = new ContentService({
      database: scriptedDatabase(greeting({ criticality: 'CRITICAL' })).database,
      cache,
      env: 'test',
      markets: m.provider,
    });
    await critical.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' } });
    expect((await critical.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'la-oc' } })).sources.get('ui.greeting')).toBe('db');
    expect(cache.data.size).toBe(0);
  });

  it('an invalid explicit marketDefaultLocale is still rejected (the provider does not mask caller errors)', async () => {
    const s = new ContentService({ database: scriptedDatabase(greeting()).database, env: 'test', markets: fakeMarkets({}).provider });
    expect(await code(s.resolveMany(['ui.greeting'], { locale: 'en-US', context: { market: 'x', marketDefaultLocale: 'es_MX' } }))).toBe('VALIDATION_FAILED');
  });
});

/** A provider with visibility: `visible` lists the references the public geography API would show; everything else (PLANNED, INACTIVE, unknown) is not visible. */
function visibleMarkets(
  visible: { MARKET?: string[]; COUNTRY?: string[] },
  defaults: Record<string, string | null> = {},
  failing: Partial<Record<'MARKET' | 'COUNTRY', Error>> = {},
) {
  const defaultCalls: string[] = [];
  const visibleCalls: string[] = [];
  const provider: MarketDefaultsProvider = {
    defaultLocale: async (market) => {
      defaultCalls.push(market);
      return defaults[market] ?? null;
    },
    isVisible: async (scopeType, ref) => {
      visibleCalls.push(`${scopeType}:${ref}`);
      const failure = failing[scopeType];
      if (failure) throw failure;
      return (visible[scopeType] ?? []).includes(ref);
    },
  };
  return { provider, defaultCalls, visibleCalls };
}

describe('public visibility of the context (includeInternal: false drops a market or country the public API would not show)', () => {
  const PUBLIC = { includeInternal: false } as const;
  const build = (provider: MarketDefaultsProvider | undefined, cache?: MemoryConfigCache) => {
    const db = scriptedDatabase(greeting());
    return { ...db, service: new ContentService({ database: db.database, cache, env: 'test', markets: provider }) };
  };
  const referencesSeen = (bound: unknown[]) =>
    bound.filter((v) => typeof v === 'string' && ['planned-m', 'inactive-m', 'ghost-m', 'CA', 'ZZ', 'live-m', 'US'].includes(v));

  it('a PLANNED, INACTIVE and unknown market (and a non-visible country) never reach the database for a public caller: they behave like no context at all', async () => {
    const m = visibleMarkets({ MARKET: ['live-m'], COUNTRY: ['US'] }, { 'live-m': 'es', 'planned-m': 'es', 'inactive-m': 'es' });
    for (const ctx of [{ market: 'planned-m' }, { market: 'inactive-m' }, { market: 'ghost-m' }, { country: 'CA' }, { market: 'planned-m', country: 'ZZ' }]) {
      const { service, bound } = build(m.provider);
      const r = await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: ctx, ...PUBLIC });
      expect(referencesSeen(bound()), JSON.stringify(ctx)).toEqual([]);
      // no market default either: the chain is the platform default only
      expect(r.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'en-US', fallback: { applied: true, chain: ['fr-CA', 'en-US'] } });
    }
    expect(m.defaultCalls).toEqual([]); // a dropped market is not even asked for its default locale
  });

  it('PLANNED, INACTIVE and unknown markets are indistinguishable from each other and from no market (identical results and one shared cache key)', async () => {
    const cache = new MemoryConfigCache();
    const m = visibleMarkets({ MARKET: ['live-m'] }, { 'planned-m': 'es', 'inactive-m': 'es-MX' });
    const { service } = build(m.provider, cache);
    const answers = [];
    for (const ctx of [undefined, { market: 'planned-m' }, { market: 'inactive-m' }, { market: 'ghost-m' }, {}]) {
      const r = await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: ctx, ...PUBLIC });
      answers.push(JSON.stringify({ items: [...r.items], missing: [...r.missing] }));
    }
    expect(new Set(answers).size).toBe(1);
    expect([...cache.data.keys()].filter((k) => k.includes(':v1:'))).toHaveLength(1); // the same resolution cache entry served all five
  });

  it('a visible market (and country) still resolve with their references and the derived market default', async () => {
    const m = visibleMarkets({ MARKET: ['live-m'], COUNTRY: ['US'] }, { 'live-m': 'es' });
    const { service, bound } = build(m.provider);
    const r = await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'live-m', country: 'US' }, ...PUBLIC });
    expect(referencesSeen(bound()).sort()).toEqual(expect.arrayContaining(['US', 'live-m']));
    expect(r.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'es', body: 'Hola', fallback: { chain: ['fr-CA', 'es', 'en-US'] } });
    expect(m.defaultCalls).toEqual(['live-m']);
    expect(m.visibleCalls.sort()).toEqual(['COUNTRY:US', 'MARKET:live-m']);
  });

  it('only the invisible member is dropped: a visible country survives next to a PLANNED market and vice versa', async () => {
    const m = visibleMarkets({ MARKET: ['live-m'], COUNTRY: ['US'] }, { 'live-m': 'es' });
    const a = build(m.provider);
    await a.service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'planned-m', country: 'US' }, ...PUBLIC });
    expect(referencesSeen(a.bound())).toEqual(expect.arrayContaining(['US']));
    expect(referencesSeen(a.bound())).not.toContain('planned-m');
    const b = build(m.provider);
    await b.service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'live-m', country: 'CA' }, ...PUBLIC });
    expect(referencesSeen(b.bound())).toEqual(expect.arrayContaining(['live-m']));
    expect(referencesSeen(b.bound())).not.toContain('CA');
  });

  it('management callers (includeInternal true or unspecified) keep seeing everything and never consult visibility', async () => {
    for (const opts of [{ includeInternal: true }, {}]) {
      const m = visibleMarkets({ MARKET: [], COUNTRY: [] }, { 'planned-m': 'es' });
      const { service, bound } = build(m.provider);
      const r = await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'planned-m', country: 'CA' }, ...opts });
      expect(referencesSeen(bound()).sort(), JSON.stringify(opts)).toEqual(['CA', 'planned-m']);
      expect(r.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'es' }); // previewing copy for a PLANNED market is a legitimate management use
      expect(m.visibleCalls).toEqual([]);
    }
  });

  it('fails closed: a provider whose visibility check throws makes the member invisible for public callers (warning without the reference) and changes nothing for management', async () => {
    const out = logged();
    try {
      const boom = new Error('postgres://user:s3cret@db/geography refused');
      const m = visibleMarkets({ MARKET: ['live-m'], COUNTRY: ['US'] }, { 'live-m': 'es' }, { MARKET: boom });
      const pub = build(m.provider);
      const r = await pub.service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'live-m', country: 'US' }, ...PUBLIC });
      expect(referencesSeen(pub.bound())).toEqual(expect.arrayContaining(['US'])); // the country check succeeded
      expect(referencesSeen(pub.bound())).not.toContain('live-m');
      expect(r.items.get('ui.greeting')).toMatchObject({ resolvedLocale: 'en-US' });
      const warn = out.lines.filter((l) => l.level === 'warn');
      expect(warn).toHaveLength(1);
      expect(JSON.stringify(warn)).not.toMatch(/s3cret|live-m/);
      const mgmt = build(m.provider);
      await mgmt.service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'live-m' } });
      expect(referencesSeen(mgmt.bound())).toContain('live-m');
    } finally {
      out.restore();
    }
  });

  it('a provider that answers anything other than true counts as not visible', async () => {
    const odd = { defaultLocale: async () => 'es', isVisible: async () => 'yes' as unknown as boolean } as MarketDefaultsProvider;
    const { service, bound } = build(odd);
    await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'live-m' }, ...PUBLIC });
    expect(referencesSeen(bound())).toEqual([]);
  });

  it("a provider without isVisible, or no provider at all, keeps today's behaviour (nothing is dropped)", async () => {
    const legacy = fakeMarkets({ 'planned-m': 'es' }).provider; // no isVisible
    for (const provider of [legacy, undefined]) {
      const { service, bound } = build(provider);
      await service.resolveMany(['ui.greeting'], { locale: 'fr-CA', context: { market: 'planned-m', country: 'CA' }, ...PUBLIC });
      expect(referencesSeen(bound()).sort()).toEqual(['CA', 'planned-m']);
    }
  });

  it('the public filter covers resolve, render and resolveRendered; an explicit marketDefaultLocale without a market still works', async () => {
    const m = visibleMarkets({ MARKET: [] });
    const { service, bound } = build(m.provider);
    await service.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'planned-m' }, ...PUBLIC });
    await service.render('ui.greeting', { locale: 'fr-CA', context: { market: 'planned-m' }, variables: { name: 'Ana' }, ...PUBLIC });
    await service.resolveRendered(['ui.greeting'], {
      locale: 'fr-CA',
      context: { market: 'planned-m' },
      variables: { 'ui.greeting': { name: 'Ana' } },
      ...PUBLIC,
    });
    expect(referencesSeen(bound())).toEqual([]);
    const explicit = await service.resolve('ui.greeting', { locale: 'fr-CA', context: { market: 'planned-m', marketDefaultLocale: 'es' }, ...PUBLIC });
    expect(explicit).toMatchObject({ resolvedLocale: 'es' }); // the caller's own value is theirs to use; the market reference itself was dropped
    expect(referencesSeen(bound())).toEqual([]);
  });
});

describe('scope reference validation (COUNTRY and MARKET)', () => {
  const STOP = new Error('reached the database');
  /** Every read fails with STOP, except the version row of a publish pre-check. */
  function databaseFor(versionRow?: Record<string, unknown>): Database {
    const executor = {
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown) => ({ sql: '', parameters: [], query: node, queryId: {} }),
      executeQuery: async () => {
        if (!versionRow) throw STOP;
        return { rows: [versionRow] };
      },
      withPlugins: () => executor,
    };
    return {
      db: { getExecutor: () => executor } as unknown as Kysely<DatabaseSchema>,
      transaction: async () => {
        throw STOP;
      },
    } as unknown as Database;
  }
  const version = (over: Record<string, unknown> = {}) => ({
    version_id: '6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111',
    entry_id: 'e1',
    entry_key: 'devtest.a.b',
    locale: 'en-US',
    scope_type: 'COUNTRY',
    scope_ref: 'US',
    version: 1,
    status: 'APPROVED',
    approval_policy: 'NONE',
    effective_from: new Date(),
    effective_to: null,
    reason: 'r',
    created_by: 'a',
    created_at: new Date(),
    updated_at: new Date(),
    body_sha256: 'sha',
    body: 'text',
    ...over,
  });
  const recording = (answer: (t: string, r: string) => ScopeReferenceCheck | Error) => {
    const calls: [string, string][] = [];
    const validator: ScopeReferenceValidator = {
      validate: async (t, r) => {
        calls.push([t, r]);
        const a = answer(t, r);
        if (a instanceof Error) throw a;
        return a;
      },
    };
    return { validator, calls };
  };
  const draft = (scopeType: ContentScopeType, scopeRef: string | null) => ({ locale: 'en-US', body: 'Hello', reason: 'why', scopeType, scopeRef });
  const failure = async (p: Promise<unknown>) =>
    (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as ContentError;

  it('createVersion: a valid reference proceeds to the database', async () => {
    const { validator, calls } = recording(() => ({ valid: true }));
    const s = new ContentService({ database: databaseFor(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    expect(await failure(s.createVersion('devtest.a.b', draft('MARKET', 'la-oc'), 'a'))).toBe(STOP);
    expect(calls).toEqual([['MARKET', 'la-oc']]);
  });
  it('createVersion: an invalid reference is VALIDATION_FAILED with reason SCOPE_REFERENCE_INVALID and no copy or reference in the message', async () => {
    const { validator } = recording(() => ({ valid: false, reason: 'NOT_FOUND' }));
    const s = new ContentService({ database: databaseFor(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    const e = await failure(s.createVersion('devtest.a.b', draft('COUNTRY', 'zz-bad'), 'a'));
    expect(e).toBeInstanceOf(ContentError);
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'the scope reference is not valid',
      details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'COUNTRY', check: 'NOT_FOUND' },
    });
    expect(JSON.stringify([e.message, e.details])).not.toContain('zz-bad');
  });
  it('PLATFORM is never validated, and the existing shape checks come first', async () => {
    const { validator, calls } = recording(() => ({ valid: false, reason: 'NEVER' }));
    const s = new ContentService({ database: databaseFor(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    expect(await failure(s.createVersion('devtest.a.b', draft('PLATFORM', null), 'a'))).toBe(STOP);
    expect((await failure(s.createVersion('devtest.a.b', draft('COUNTRY', null), 'a'))).code).toBe('VALIDATION_FAILED');
    expect((await failure(s.createVersion('devtest.a.b', draft('COUNTRY', 'has space'), 'a'))).details.reason).toBe('INVALID_FIELD');
    expect(calls).toEqual([]);
  });
  it('a validator that throws fails closed as UNAVAILABLE without leaking its message', async () => {
    const { validator } = recording(() => new Error('geography db refused: secret-host'));
    const s = new ContentService({ database: databaseFor(version()), env: 'test', allowTestKeys: true, scopeReferences: validator });
    for (const e of [await failure(s.createVersion('devtest.a.b', draft('COUNTRY', 'US'), 'a')), await failure(s.publish(version().version_id, 'a'))]) {
      expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'SCOPE_REFERENCE_UNAVAILABLE', scopeType: 'COUNTRY' } });
      expect(JSON.stringify([e.message, e.details])).not.toContain('secret-host');
    }
  });
  it('without a validator the service behaves exactly as before', async () => {
    const s = new ContentService({ database: databaseFor(version()), env: 'test', allowTestKeys: true });
    expect(await failure(s.createVersion('devtest.a.b', draft('COUNTRY', 'whatever'), 'a'))).toBe(STOP);
    expect(await failure(s.publish(version().version_id, 'a'))).toBe(STOP);
  });
  it('publish re-validates the stored reference of an APPROVED version; other states and PLATFORM versions are left to the transaction', async () => {
    const bad = recording(() => ({ valid: false, reason: 'INACTIVE' }));
    const s = new ContentService({ database: databaseFor(version()), env: 'test', allowTestKeys: true, scopeReferences: bad.validator });
    expect(await failure(s.publish(version().version_id, 'a'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'COUNTRY', check: 'INACTIVE' },
    });
    expect(bad.calls).toEqual([['COUNTRY', 'US']]);
    const ok = recording(() => ({ valid: true }));
    expect(
      await failure(new ContentService({ database: databaseFor(version()), env: 'test', scopeReferences: ok.validator }).publish(version().version_id, 'a')),
    ).toBe(STOP);
    const idle = recording(() => ({ valid: false, reason: 'X' }));
    for (const row of [version({ status: 'DRAFT' }), version({ scope_type: 'PLATFORM', scope_ref: null })])
      expect(
        await failure(new ContentService({ database: databaseFor(row), env: 'test', scopeReferences: idle.validator }).publish(version().version_id, 'a')),
      ).toBe(STOP);
    expect(idle.calls).toEqual([]);
  });
});

describe('locale display names', () => {
  it('derives an English display name with Intl.DisplayNames', () => {
    expect(defaultLocaleDisplayName('en-US')).toBe('English (United States)');
    expect(defaultLocaleDisplayName('es-MX')).toBe('Spanish (Mexico)');
    expect(defaultLocaleDisplayName('fr')).toBe('French');
    expect(defaultLocaleDisplayName('zh-Hant-TW')).toMatch(/Chinese/);
  });
  it('falls back to the tag when Intl yields nothing or throws', () => {
    const original = Intl.DisplayNames;
    try {
      (Intl as unknown as { DisplayNames: unknown }).DisplayNames = class {
        of() {
          return undefined;
        }
      };
      expect(defaultLocaleDisplayName('es-MX')).toBe('es-MX');
      (Intl as unknown as { DisplayNames: unknown }).DisplayNames = class {
        constructor() {
          throw new RangeError('unsupported');
        }
      };
      expect(defaultLocaleDisplayName('es-MX')).toBe('es-MX');
    } finally {
      (Intl as unknown as { DisplayNames: unknown }).DisplayNames = original;
    }
  });
  it('registerLocale validates an explicit display name before touching the database', async () => {
    for (const displayName of ['', '   ', 'x'.repeat(101), 5 as unknown as string])
      expect(await code(svc().registerLocale({ locale: 'es-US', displayName, reason: 'r' }, 'a')), String(displayName)).toBe('VALIDATION_FAILED');
  });
});
