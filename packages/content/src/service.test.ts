// Unit tests for the parts of the service that need no database (validation, error mapping, rendering) and for the resolution
// facade against a scripted database. Lifecycle, locking and trigger behaviour is proven against real PostgreSQL in content.itest.ts.
import { describe, expect, it } from 'vitest';
import { MemoryConfigCache } from '@bananagig/configuration';
import type { Database, DatabaseSchema, Kysely } from '@bananagig/database';
import { ContentError } from './errors';
import type { ResolvedContent } from './resolver';
import { ContentService, mapDbError, renderResolved, type CreateEntryInput } from './service';

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
} {
  let n = 0;
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ sql: '', parameters: [], query: node, queryId: {} }),
    executeQuery: async (compiled: { query: { sqlFragments: string[] } }) => {
      n++;
      const text = compiled.query.sqlFragments.join('?');
      if (text.includes('requested_key')) return { rows: rows.entries };
      if (text.includes('min(t)')) return { rows: [{ t: rows.boundary ?? null }] };
      return { rows: rows.candidates };
    },
    withPlugins: () => executor,
  };
  return { database: { db: { getExecutor: () => executor } as unknown as Kysely<DatabaseSchema> } as unknown as Database, queries: () => n };
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
