import { describe, expect, it } from 'vitest';
import type { DatabaseSchema, Kysely } from '@bananagig/database';
import { ContentError } from './errors';
import { buildFallbackChain } from './locale';
import { contextScopePairs, normalizeContext, normalizeLocale, resolveBatch, selectCandidate, type Candidate } from './resolver';

const cand = (over: Partial<Candidate> & Pick<Candidate, 'locale'>): Candidate => ({
  versionId: over.versionId ?? `${over.locale}-${over.scopeType ?? 'PLATFORM'}-${over.version ?? 1}`,
  version: 1,
  scopeType: 'PLATFORM',
  scopeRef: null,
  rank: 0,
  body: 'b',
  bodySha256: 'h',
  effectiveFrom: new Date(0),
  effectiveTo: null,
  ...over,
});
const PLATFORM = { scopeType: 'PLATFORM' as const, rank: 0 };
const COUNTRY = { scopeType: 'COUNTRY' as const, scopeRef: 'US', rank: 1 };
const MARKET = { scopeType: 'MARKET' as const, scopeRef: 'us-ca', rank: 2 };

describe('selectCandidate (deterministic precedence)', () => {
  it('chain position beats scope specificity: an exact-locale platform version beats a fallback-locale market override', () => {
    const chain = ['es-MX', 'es', 'en-US'];
    const win = selectCandidate(chain, [cand({ locale: 'es', ...MARKET }), cand({ locale: 'es-MX', ...PLATFORM }), cand({ locale: 'en-US', ...MARKET })]);
    expect(win).toMatchObject({ locale: 'es-MX', scopeType: 'PLATFORM' });
  });
  it('within one locale the most specific applicable scope wins (MARKET > COUNTRY > PLATFORM)', () => {
    const chain = ['en-US'];
    expect(selectCandidate(chain, [cand({ locale: 'en-US', ...PLATFORM }), cand({ locale: 'en-US', ...COUNTRY })])?.scopeType).toBe('COUNTRY');
    expect(
      selectCandidate(chain, [cand({ locale: 'en-US', ...MARKET }), cand({ locale: 'en-US', ...COUNTRY }), cand({ locale: 'en-US', ...PLATFORM })])?.scopeType,
    ).toBe('MARKET');
  });
  it('fallback + scope interplay: the next chain locale is only used when the earlier locale has NO candidate at any applicable scope', () => {
    const chain = ['es-MX', 'es', 'en-US'];
    // es has a platform copy, en-US has a market override: es wins (chain position first)
    expect(selectCandidate(chain, [cand({ locale: 'es', ...PLATFORM }), cand({ locale: 'en-US', ...MARKET })])?.locale).toBe('es');
    // nothing in es-MX/es: the platform default locale is used, at its most specific scope
    expect(selectCandidate(chain, [cand({ locale: 'en-US', ...PLATFORM }), cand({ locale: 'en-US', ...COUNTRY })])).toMatchObject({
      locale: 'en-US',
      scopeType: 'COUNTRY',
    });
  });
  it('ignores locales outside the chain (an EXACT entry never picks another language)', () => {
    expect(selectCandidate(['es-MX'], [cand({ locale: 'es' }), cand({ locale: 'en-US' })])).toBeUndefined();
    expect(selectCandidate([], [cand({ locale: 'en-US' })])).toBeUndefined();
    expect(selectCandidate(['en-US'], [])).toBeUndefined();
  });
  it('tie-breakers (impossible per holder) are deterministic: higher version, then versionId, regardless of input order', () => {
    const a = cand({ locale: 'en-US', version: 1, versionId: 'a' });
    const b = cand({ locale: 'en-US', version: 2, versionId: 'b' });
    const c = cand({ locale: 'en-US', version: 2, versionId: 'c' });
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ])
      expect(selectCandidate(['en-US'], order)?.versionId).toBe('c');
  });
  it('is consistent with real fallback chains', () => {
    const chain = buildFallbackChain({ requested: 'es-MX', policy: 'CHAIN', platformDefault: 'en-US', active: new Set(['es-MX', 'es', 'en-US']) });
    expect(chain).toEqual(['es-MX', 'es', 'en-US']);
    expect(selectCandidate(chain, [cand({ locale: 'en-US' }), cand({ locale: 'es' })])?.locale).toBe('es');
  });
});

describe('request normalization', () => {
  it('canonicalizes locales and rejects padded, underscore and malformed tags', () => {
    expect(normalizeLocale('ES-mx')).toBe('es-MX');
    expect(normalizeLocale('zh-hant-tw')).toBe('zh-Hant-TW');
    for (const bad of [' en-US', 'en-US ', 'en-US\n', 'en_US', 'english', '', 'e', 'en-US-x-private', 42, null, undefined]) {
      const e = (() => {
        try {
          normalizeLocale(bad);
        } catch (err) {
          return err as ContentError;
        }
      })();
      expect(e, String(bad)).toBeInstanceOf(ContentError);
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
  it('normalizes the context (canonical marketDefaultLocale, no undefined members) and derives scope pairs', () => {
    expect(normalizeContext(undefined)).toEqual({});
    expect(normalizeContext({ country: 'US', market: undefined, marketDefaultLocale: 'ES-us' })).toEqual({ country: 'US', marketDefaultLocale: 'es-US' });
    expect(() => normalizeContext({ marketDefaultLocale: 'es_US' })).toThrow(ContentError);
    expect(contextScopePairs({})).toEqual({ types: [], refs: [] });
    expect(contextScopePairs({ country: 'US', market: 'us-ca', marketDefaultLocale: 'es-US' })).toEqual({
      types: ['COUNTRY', 'MARKET'],
      refs: ['US', 'us-ca'],
    });
  });
});

// ---------------------------------------------------------------- resolveBatch with a scripted database
interface Call {
  text: string;
  params: unknown[];
}
/** A minimal Kysely stand-in: every `sql` fragment executed against it is answered by `answer(text)`, and recorded. */
function fakeDb(answer: (text: string, params: unknown[]) => Record<string, unknown>[]): { db: Kysely<DatabaseSchema>; calls: Call[] } {
  const calls: Call[] = [];
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: { sqlFragments: string[]; parameters: unknown[] }) => ({ sql: '', parameters: [], query: node, queryId: {} }),
    executeQuery: async (compiled: { query: { sqlFragments: string[]; parameters: unknown[] } }) => {
      const text = compiled.query.sqlFragments.join('?');
      const params = compiled.query.parameters.flatMap((p) => (p && typeof p === 'object' && 'value' in p ? [(p as { value: unknown }).value] : []));
      calls.push({ text, params });
      return { rows: answer(text, params) };
    },
    withPlugins: () => executor,
  };
  return { db: { getExecutor: () => executor } as unknown as Kysely<DatabaseSchema>, calls };
}

const entryRow = (key: string, over: Record<string, unknown> = {}) => ({
  requested_key: key,
  entry_id: `id-${key}`,
  content_type: 'UI_LABEL',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  fallback_policy: 'CHAIN',
  is_active: true,
  variables: [{ name: 'n', type: 'COUNT', required: true, description: 'd', example: 1, piiClass: 'NONE' }],
  active_locales: ['en-US', 'es', 'es-MX'],
  platform_default: 'en-US',
  context_matched: true,
  db_now: new Date('2030-01-01T00:00:00Z'),
  ...over,
});
const candRow = (entry: string, locale: string, over: Record<string, unknown> = {}) => ({
  entry_id: `id-${entry}`,
  locale,
  scope_type: 'PLATFORM',
  scope_ref: null,
  rank: 0,
  version_id: `v-${entry}-${locale}`,
  version: 1,
  body: `body ${entry} ${locale}`,
  body_sha256: 'sha',
  effective_from: new Date('2029-01-01T00:00:00Z'),
  effective_to: null,
  ...over,
});

describe('resolveBatch', () => {
  it('uses exactly 3 queries however many keys are requested', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `devtest.k${i}.x`);
    const { db, calls } = fakeDb((text) =>
      text.includes('requested_key')
        ? keys.map((k) => entryRow(k))
        : text.includes('min(t)')
          ? [{ t: new Date('2030-02-01T00:00:00Z') }]
          : keys.map((k) => candRow(k, 'en-US')),
    );
    const r = await resolveBatch(db, keys, { locale: 'en-US', context: {} });
    expect(calls).toHaveLength(3);
    expect(r.resolved.size).toBe(40);
    expect(r.nextChangeAt).toEqual(new Date('2030-02-01T00:00:00Z'));
    expect(r.at).toEqual(new Date('2030-01-01T00:00:00Z'));
  });

  const ACTIVE = { active_locales: ['en-US', 'es'] }; // es-MX and es-US are registered but inactive
  it('builds the chain per entry policy from ACTIVE locales only, and picks by chain position', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('requested_key'))
        return [
          entryRow('chain.key', ACTIVE),
          entryRow('exact.key', { ...ACTIVE, fallback_policy: 'EXACT' }),
          entryRow('lang.key', { ...ACTIVE, fallback_policy: 'LANGUAGE_ONLY' }),
        ];
      if (text.includes('min(t)')) return [{ t: null }];
      return [candRow('chain.key', 'en-US'), candRow('chain.key', 'es'), candRow('exact.key', 'es'), candRow('lang.key', 'es'), candRow('lang.key', 'en-US')];
    });
    const r = await resolveBatch(db, ['chain.key', 'exact.key', 'lang.key'], { locale: 'es-MX', context: { marketDefaultLocale: 'es-US' } });
    // CHAIN: es-MX (inactive, skipped), es, es-US (inactive, skipped), en-US; es wins over en-US
    expect(r.resolved.get('chain.key')).toMatchObject({
      resolvedLocale: 'es',
      requestedLocale: 'es-MX',
      fallback: { applied: true, chain: ['es', 'en-US'] },
      body: 'body chain.key es',
    });
    // LANGUAGE_ONLY with es-MX inactive: only es is considered (the reported chain is the ACTIVE part)
    expect(r.resolved.get('lang.key')).toMatchObject({ resolvedLocale: 'es', fallback: { applied: true, chain: ['es'] } });
    // EXACT never falls back: the requested locale is inactive / has no copy, so the entry is "missing" even though es exists
    expect(r.resolved.has('exact.key')).toBe(false);
    expect(r.missing).toEqual([{ key: 'exact.key', entryId: 'id-exact.key', criticality: 'STANDARD', sensitivity: 'PUBLIC' }]);
    expect(r.nextChangeAt).toBeNull();
    // the candidate query is given the union of the chains' locales
    const locales = calls[1]!.params.find((p) => Array.isArray(p) && p.includes('es')) as string[];
    expect([...locales].sort()).toEqual(['en-US', 'es']);
  });

  it('EXACT never falls back even when the requested locale is active but has no copy', async () => {
    const { db } = fakeDb((text) =>
      text.includes('requested_key')
        ? [entryRow('legal.terms', { fallback_policy: 'EXACT', criticality: 'CRITICAL' })]
        : text.includes('min(t)')
          ? [{ t: null }]
          : [candRow('legal.terms', 'es'), candRow('legal.terms', 'en-US')],
    );
    const r = await resolveBatch(db, ['legal.terms'], { locale: 'es-MX', context: {} });
    expect(r.resolved.size).toBe(0);
    expect(r.missing).toEqual([{ key: 'legal.terms', entryId: 'id-legal.terms', criticality: 'CRITICAL', sensitivity: 'PUBLIC' }]);
  });

  it('reports the requested locale as the resolved one when it has copy (no fallback applied)', async () => {
    const { db } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('a.b')] : text.includes('min(t)') ? [{ t: null }] : [candRow('a.b', 'es-MX'), candRow('a.b', 'en-US')],
    );
    const r = await resolveBatch(db, ['a.b'], { locale: 'es-MX', context: {} });
    expect(r.resolved.get('a.b')).toMatchObject({ resolvedLocale: 'es-MX', fallback: { applied: false } });
    expect(r.resolved.get('a.b')!.variables).toEqual([{ name: 'n', type: 'COUNT', required: true, description: 'd', example: 1, piiClass: 'NONE' }]);
  });

  it('classifies unknown and inactive keys as unknown, and entries without a candidate as missing; unknown-only batches stop after one query', async () => {
    const onlyUnknown = fakeDb(() => [entryRow('x.y', { entry_id: null, is_active: null }), entryRow('z.w', { is_active: false })]);
    const u = await resolveBatch(onlyUnknown.db, ['x.y', 'z.w'], { locale: 'en-US', context: {} });
    expect(u.unknown).toEqual(['x.y', 'z.w']);
    expect(u.resolved.size).toBe(0);
    expect(onlyUnknown.calls).toHaveLength(1);

    const mixed = fakeDb((text) =>
      text.includes('requested_key')
        ? [entryRow('has.copy'), entryRow('no.copy', { criticality: 'CRITICAL' }), entryRow('gone.key', { entry_id: null })]
        : text.includes('min(t)')
          ? [{ t: null }]
          : [candRow('has.copy', 'en-US')],
    );
    const m = await resolveBatch(mixed.db, ['has.copy', 'no.copy', 'gone.key'], { locale: 'en-US', context: {} });
    expect([...m.resolved.keys()]).toEqual(['has.copy']);
    expect(m.missing).toEqual([{ key: 'no.copy', entryId: 'id-no.copy', criticality: 'CRITICAL', sensitivity: 'PUBLIC' }]);
    expect(m.unknown).toEqual(['gone.key']);
  });

  it('an explicit evaluation time is used as given (never the database clock)', async () => {
    const at = new Date('2040-05-05T05:05:05Z');
    const { db, calls } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('a.b')] : text.includes('min(t)') ? [{ t: null }] : [candRow('a.b', 'en-US')],
    );
    const r = await resolveBatch(db, ['a.b'], { locale: 'en-US', context: {} }, at);
    expect(r.at).toBe(at);
    expect(calls[1]!.params).toContainEqual(at);
  });

  it('rejects an invalid locale before touching the database and returns nothing for no keys', async () => {
    const { db, calls } = fakeDb(() => []);
    await expect(resolveBatch(db, ['a.b'], { locale: 'en_US', context: {} })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await resolveBatch(db, [], { locale: 'en-US', context: {} })).resolved.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveBatch: sensitivity of entries without content', () => {
  it('carries the entry sensitivity on missing entries (so callers can hide INTERNAL ones like unknown keys)', async () => {
    const { db } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('int.key', { sensitivity: 'INTERNAL' }), entryRow('pub.key')] : text.includes('min(t)') ? [{ t: null }] : [],
    );
    const r = await resolveBatch(db, ['int.key', 'pub.key'], { locale: 'en-US', context: {} });
    expect(r.missing).toEqual([
      { key: 'int.key', entryId: 'id-int.key', criticality: 'STANDARD', sensitivity: 'INTERNAL' },
      { key: 'pub.key', entryId: 'id-pub.key', criticality: 'STANDARD', sensitivity: 'PUBLIC' },
    ]);
  });
});

describe('resolveBatch: cacheable answers (bounded cache key space)', () => {
  const run = async (locale: string, context: Record<string, string>, rowOver: Record<string, unknown> = {}) => {
    const { db } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('a.b', rowOver)] : text.includes('min(t)') ? [{ t: null }] : [candRow('a.b', 'en-US')],
    );
    return resolveBatch(db, ['a.b'], { locale, context });
  };
  it('is cacheable for an active locale with an empty context, or a context whose references matched published versions', async () => {
    expect((await run('en-US', {})).cacheable).toBe(true);
    expect((await run('es-MX', { country: 'US', market: 'us-ca' })).cacheable).toBe(true);
    expect((await run('en-US', { marketDefaultLocale: 'es' })).cacheable).toBe(true);
  });
  it('is not cacheable when the requested locale is not an active locale (it is still resolved, via the fallback chain)', async () => {
    const r = await run('fr-FR', {}); // active_locales: en-US, es, es-MX
    expect(r.cacheable).toBe(false);
    expect(r.resolved.get('a.b')).toMatchObject({ resolvedLocale: 'en-US', fallback: { applied: true, chain: ['en-US'] } });
  });
  it('is not cacheable when a supplied scope reference matched no published version, or the market default locale is not active', async () => {
    expect((await run('en-US', { market: 'nowhere' }, { context_matched: false })).cacheable).toBe(false);
    expect((await run('en-US', { marketDefaultLocale: 'fr-FR' })).cacheable).toBe(false);
  });
  it('fails closed: without the database answer about references the batch is not cacheable', async () => {
    expect((await run('en-US', {}, { context_matched: undefined })).cacheable).toBe(false);
  });
  it('an all-unknown batch reports the same flag (nothing to cache either way)', async () => {
    const { db } = fakeDb(() => [entryRow('x.y', { entry_id: null, is_active: null })]);
    expect((await resolveBatch(db, ['x.y'], { locale: 'fr-FR', context: {} })).cacheable).toBe(false);
    expect((await resolveBatch(db, ['x.y'], { locale: 'en-US', context: {} })).cacheable).toBe(true);
  });
  it('sends the context references to the first query only (still exactly 3 queries)', async () => {
    const { db, calls } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('a.b')] : text.includes('min(t)') ? [{ t: null }] : [candRow('a.b', 'en-US')],
    );
    await resolveBatch(db, ['a.b'], { locale: 'en-US', context: { country: 'US', market: 'us-ca' } });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.params).toContainEqual(['COUNTRY', 'MARKET']);
    expect(calls[0]!.params).toContainEqual(['US', 'us-ca']);
  });
});

describe('resolveBatch: platform default locale', () => {
  it('fails loudly with a typed UNAVAILABLE when no platform default locale exists, never silently falling back to the requested locale', async () => {
    const { db, calls } = fakeDb((text) =>
      text.includes('requested_key') ? [entryRow('a.b', { platform_default: null })] : text.includes('min(t)') ? [{ t: null }] : [candRow('a.b', 'es-MX')],
    );
    const err = await resolveBatch(db, ['a.b'], { locale: 'es-MX', context: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ContentError);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'NO_PLATFORM_DEFAULT' } });
    expect(calls).toHaveLength(1); // stops before the candidate queries
    // also when every key is unknown: the registry is misconfigured, not merely empty
    const unknownOnly = fakeDb(() => [entryRow('x.y', { entry_id: null, is_active: null, platform_default: null })]);
    await expect(resolveBatch(unknownOnly.db, ['x.y'], { locale: 'en-US', context: {} })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
