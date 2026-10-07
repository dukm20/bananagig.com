import { describe, expect, it } from 'vitest';
import { SCOPE_TYPES, scopeRank, type ScopeType } from '@bananagig/contracts';
import type { Database, DatabaseSchema, Kysely } from '@bananagig/database';
import { MemoryConfigCache, contextHash, resolveWithPolicy, type PolicyArgs } from './cache';
import { ConfigurationError } from './errors';
import { assertComplete, contextPairs, pickWinners, type BatchResult, type Candidate, type Resolved } from './resolver';
import type { ScopeReferenceCheck, ScopeReferenceValidator } from './scope-reference';
import { ConfigurationService } from './service';
import { compareDecimal, redactValue, validateDefinitionRules, validateValue } from './values';

const def = (dataType: Parameters<typeof validateValue>[0]['dataType'], validationRules: Record<string, unknown> = {}) => ({ dataType, validationRules });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ConfigurationError).code;
  }
};

describe('typed value validation', () => {
  it('STRING: length and pattern', () => {
    const d = def('STRING', { minLength: 2, maxLength: 5, pattern: '^[a-z]+$' });
    expect(validateValue(d, 'abc')).toBe('abc');
    for (const bad of ['a', 'abcdef', 'ABC', 5])
      expect(
        code(() => validateValue(d, bad)),
        String(bad),
      ).toBe('VALIDATION_FAILED');
  });
  it('INTEGER: safe integers and bounds only', () => {
    const d = def('INTEGER', { min: 1, max: 10 });
    expect(validateValue(d, 5)).toBe(5);
    for (const bad of [0, 11, 1.5, '5', Number.MAX_SAFE_INTEGER + 2, NaN]) expect(code(() => validateValue(d, bad))).toBe('VALIDATION_FAILED');
  });
  it('DECIMAL: canonical decimal strings, exact comparison, no floats', () => {
    const d = def('DECIMAL', { min: '0.10', max: '99.99' });
    expect(validateValue(d, '12.5')).toBe('12.5');
    for (const bad of [12.5, '12.5.1', '1e3', '0.09', '100', ' 5'])
      expect(
        code(() => validateValue(d, bad)),
        String(bad),
      ).toBe('VALIDATION_FAILED');
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('-1.5', '1.5')).toBe(-1);
    expect(compareDecimal('10.000000000000000001', '10')).toBe(1);
  });
  it('BOOLEAN and ENUM', () => {
    expect(validateValue(def('BOOLEAN'), true)).toBe(true);
    expect(code(() => validateValue(def('BOOLEAN'), 'true'))).toBe('VALIDATION_FAILED');
    const e = def('ENUM', { enum: ['A', 'B'] });
    expect(validateValue(e, 'A')).toBe('A');
    expect(code(() => validateValue(e, 'C'))).toBe('VALIDATION_FAILED');
  });
  it('DURATION: integer + unit with bounds compared in seconds', () => {
    const d = def('DURATION', { min: { amount: 1, unit: 'HOURS' }, max: { amount: 2, unit: 'DAYS' } });
    expect(validateValue(d, { amount: 90, unit: 'MINUTES' })).toEqual({ amount: 90, unit: 'MINUTES' });
    for (const bad of [{ amount: 30, unit: 'MINUTES' }, { amount: 3, unit: 'DAYS' }, { amount: 1.5, unit: 'HOURS' }, { amount: 1, unit: 'MONTHS' }, 'PT1H'])
      expect(code(() => validateValue(d, bad))).toBe('VALIDATION_FAILED');
  });
  it('MONEY: integer minor units + ISO currency, allowed-currency list, no floats', () => {
    const d = def('MONEY', { currencies: ['USD', 'EUR'], min: 0, max: 100000 });
    expect(validateValue(d, { amount_minor: 1250, currency: 'USD' })).toEqual({ amount_minor: 1250, currency: 'USD' });
    for (const bad of [
      { amount_minor: 12.5, currency: 'USD' },
      { amount_minor: 100, currency: 'GBP' },
      { amount_minor: 100, currency: 'usd' },
      { amount_minor: -1, currency: 'USD' },
      { amount_minor: 100001, currency: 'USD' },
      { amount: 5, currency: 'USD' },
      12.5,
    ])
      expect(code(() => validateValue(d, bad))).toBe('VALIDATION_FAILED');
  });
  it('JSON: validates against the declared JSON schema', () => {
    const d = def('JSON', { schema: { type: 'object', required: ['steps'], properties: { steps: { type: 'array', items: { type: 'integer' } } } } });
    expect(validateValue(d, { steps: [1, 2] })).toEqual({ steps: [1, 2] });
    for (const bad of [{ steps: ['x'] }, {}, 'str']) expect(code(() => validateValue(d, bad))).toBe('VALIDATION_FAILED');
  });
  it('reuses the cached validator for schemas with an $id', () => {
    const rules = { schema: { $id: 'https://bananagig.test/config-schema', type: 'object' } };
    expect(validateDefinitionRules('JSON', rules)).toEqual(rules);
    expect(validateDefinitionRules('JSON', rules)).toEqual(rules);
    expect(validateValue(def('JSON', rules), { enabled: true })).toEqual({ enabled: true });
  });
  it('definition rules must fit the data type', () => {
    expect(code(() => validateDefinitionRules('ENUM', {}))).toBe('VALIDATION_FAILED');
    expect(code(() => validateDefinitionRules('STRING', { currencies: ['USD'] }))).toBe('VALIDATION_FAILED');
    expect(code(() => validateDefinitionRules('INTEGER', { min: '1' }))).toBe('VALIDATION_FAILED');
    expect(code(() => validateDefinitionRules('STRING', { pattern: '(' }))).toBe('VALIDATION_FAILED');
    expect(code(() => validateDefinitionRules('JSON', { schema: { type: 'nonsense' } }))).toBe('VALIDATION_FAILED');
    expect(validateDefinitionRules('MONEY', { currencies: ['USD'], min: 0 })).toEqual({ currencies: ['USD'], min: 0 });
  });
});

const cand = (key: string, scope: Candidate['sourceScope'], version: number, value: unknown, extra: Partial<Candidate> = {}): Candidate => ({
  key,
  parameterId: `p-${key}`,
  dataType: 'INTEGER',
  sensitivity: 'INTERNAL',
  criticality: 'STANDARD',
  value,
  sourceScope: scope,
  scopeRef: scope === 'PLATFORM' ? null : `${scope.toLowerCase()}-1`,
  version,
  versionId: `v-${key}-${scope}-${version}`,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  rank: scopeRank(scope),
  ...extra,
});

describe('scope precedence', () => {
  it('the contract hierarchy is PLATFORM < COUNTRY < MARKET < CATEGORY < PLAN < PROVIDER < GIG < DROP', () => {
    expect([...SCOPE_TYPES]).toEqual(['PLATFORM', 'COUNTRY', 'MARKET', 'CATEGORY', 'PLAN', 'PROVIDER', 'GIG', 'DROP']);
  });
  it('the most specific applicable scope wins, for every pair of levels', () => {
    for (let i = 0; i < SCOPE_TYPES.length; i++)
      for (let j = i + 1; j < SCOPE_TYPES.length; j++) {
        const r = pickWinners([cand('k', SCOPE_TYPES[j]!, 1, 'specific'), cand('k', SCOPE_TYPES[i]!, 9, 'general')]);
        expect(r.get('k')?.value, `${SCOPE_TYPES[j]} over ${SCOPE_TYPES[i]}`).toBe('specific');
      }
  });
  it('is deterministic regardless of candidate order and picks per key independently', () => {
    const cs = [cand('a', 'PLATFORM', 1, 1), cand('a', 'MARKET', 1, 2), cand('b', 'PLATFORM', 1, 3), cand('a', 'GIG', 1, 4)];
    const forward = pickWinners(cs);
    const reverse = pickWinners([...cs].reverse());
    expect([...forward].map(([k, v]) => [k, v.value])).toEqual(
      [...reverse].map(([k, v]) => [k, v.value]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(forward.get('a')?.sourceScope).toBe('GIG');
    expect(forward.get('b')?.sourceScope).toBe('PLATFORM');
  });
  it('maps a context to scope pairs and ignores absent levels', () => {
    expect(contextPairs({ market: 'us-ca', provider: 'prov-1' })).toEqual({ types: ['MARKET', 'PROVIDER'], refs: ['us-ca', 'prov-1'] });
    expect(contextPairs({})).toEqual({ types: [], refs: [] });
  });
  it('hashes contexts independent of key order', () => {
    expect(contextHash({ market: 'm', plan: 'p' })).toBe(contextHash({ plan: 'p', market: 'm' }));
    expect(contextHash({ market: 'm' })).not.toBe(contextHash({ market: 'n' }));
  });
});

const batch = (resolved: Resolved[], over: Partial<BatchResult> = {}): BatchResult => ({
  resolved: new Map(resolved.map((r) => [r.key, r])),
  missing: [],
  unknown: [],
  nextChangeAt: null,
  at: new Date(),
  ...over,
});
const res = (key: string, value: unknown, criticality: Resolved['criticality'] = 'STANDARD'): Resolved => {
  const { rank: _r, ...r } = cand(key, 'PLATFORM', 1, value, { criticality });
  return r;
};
const args = (over: Partial<PolicyArgs>): PolicyArgs => ({
  keys: ['a'],
  ctx: {},
  env: 'test',
  cacheTtlSeconds: 30,
  lkgMaxAgeSeconds: 3600,
  load: async () => batch([res('a', 1)]),
  ...over,
});

describe('required values and no code fallback', () => {
  it('a missing required parameter is a typed NO_VALUE error, never a default', () => {
    const b = batch([], { missing: [{ key: 'a', parameterId: 'p', isRequired: true, criticality: 'STANDARD' }] });
    expect(code(() => assertComplete(b))).toBe('NO_VALUE');
  });
  it('unknown parameters are PARAMETER_NOT_FOUND; optional missing parameters are simply absent', () => {
    expect(code(() => assertComplete(batch([], { unknown: ['x'] })))).toBe('PARAMETER_NOT_FOUND');
    expect(() => assertComplete(batch([], { missing: [{ key: 'a', parameterId: 'p', isRequired: false, criticality: 'STANDARD' }] }))).not.toThrow();
  });
  it('NO_VALUE from the database is authoritative: last-known-good is NOT used', async () => {
    const cache = new MemoryConfigCache();
    await resolveWithPolicy(args({ cache })); // populates LKG
    const noValue = () => Promise.resolve(batch([], { missing: [{ key: 'a', parameterId: 'p', isRequired: true, criticality: 'STANDARD' }] }));
    await expect(resolveWithPolicy(args({ cache: new MemoryConfigCache(), load: noValue }))).rejects.toMatchObject({ code: 'NO_VALUE' });
    cache.data.clear(); // keep only the LKG entry
    await resolveWithPolicy(args({ cache })); // LKG written again
    for (const k of [...cache.data.keys()].filter((k) => k.includes(':v1:'))) cache.data.delete(k);
    await expect(resolveWithPolicy(args({ cache, load: noValue }))).rejects.toMatchObject({ code: 'NO_VALUE' });
  });
});

describe('cache and last-known-good policy', () => {
  it('serves a repeat read from the cache and reports the source', async () => {
    const cache = new MemoryConfigCache();
    let loads = 0;
    const load = async () => (loads++, batch([res('a', 1)]));
    expect((await resolveWithPolicy(args({ cache, load }))).sources.get('a')).toBe('db');
    expect((await resolveWithPolicy(args({ cache, load }))).sources.get('a')).toBe('cache');
    expect(loads).toBe(1);
  });
  it('publication invalidates the cache through the generation counter', async () => {
    const cache = new MemoryConfigCache();
    let value = 1;
    const load = async () => batch([res('a', value)]);
    await resolveWithPolicy(args({ cache, load }));
    value = 2;
    expect((await resolveWithPolicy(args({ cache, load }))).resolved.get('a')?.value).toBe(1); // still cached
    await cache.incr('bg:test:cfg:gen:a');
    expect((await resolveWithPolicy(args({ cache, load }))).resolved.get('a')?.value).toBe(2);
  });
  it('a cache entry never outlives the next effective boundary', async () => {
    const cache = new MemoryConfigCache();
    let t = 1_000_000;
    const now = () => t;
    let loads = 0;
    const load = async () => (loads++, batch([res('a', 1)], { nextChangeAt: new Date(t + 5000) }));
    await resolveWithPolicy(args({ cache, load, now }));
    t += 4500; // inside the 1s safety margin of the boundary (boundary at +5000)
    await resolveWithPolicy(args({ cache, load, now }));
    expect(loads).toBe(2);
  });
  it('database outage + cache outage -> typed UNAVAILABLE (nothing fabricated)', async () => {
    const cache = new MemoryConfigCache();
    cache.fail = true;
    await expect(resolveWithPolicy(args({ cache, load: () => Promise.reject(new Error('connection refused')) }))).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(resolveWithPolicy(args({ load: () => Promise.reject(new Error('connection refused')) }))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('database outage -> last-known-good for STANDARD parameters, labelled as such', async () => {
    const cache = new MemoryConfigCache();
    await resolveWithPolicy(args({ cache }));
    for (const k of [...cache.data.keys()].filter((k) => k.includes(':v1:'))) cache.data.delete(k); // force a DB read
    const r = await resolveWithPolicy(args({ cache, load: () => Promise.reject(new Error('db down')) }));
    expect(r.sources.get('a')).toBe('lkg');
    expect(r.resolved.get('a')?.value).toBe(1);
  });
  it('CRITICAL parameters are never cached and never served from last-known-good', async () => {
    const cache = new MemoryConfigCache();
    await resolveWithPolicy(args({ cache, load: async () => batch([res('a', 1, 'CRITICAL')]) }));
    expect([...cache.data.keys()].filter((k) => k.includes('cfg:v1') || k.includes('cfg:lkg'))).toEqual([]);
    await expect(resolveWithPolicy(args({ cache, load: () => Promise.reject(new Error('db down')) }))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('last-known-good is all-or-nothing across keys', async () => {
    const cache = new MemoryConfigCache();
    await resolveWithPolicy(args({ cache, keys: ['a'] }));
    await expect(resolveWithPolicy(args({ cache, keys: ['a', 'b'], load: () => Promise.reject(new Error('db down')) }))).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
  it('an explicit evaluation time bypasses the cache and last-known-good', async () => {
    const cache = new MemoryConfigCache();
    await resolveWithPolicy(args({ cache }));
    await expect(resolveWithPolicy(args({ cache, at: new Date('2020-01-01'), load: () => Promise.reject(new Error('db down')) }))).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});

describe('sensitive values', () => {
  it('SENSITIVE values are redacted, others pass through', () => {
    expect(redactValue('SENSITIVE', 'secret-ish')).toEqual({ value: null, redacted: true });
    expect(redactValue('INTERNAL', 5)).toEqual({ value: 5, redacted: false });
    expect(redactValue('PUBLIC', 'x')).toEqual({ value: 'x', redacted: false });
  });
});

// ---------------------------------------------------------------- scope reference validation (a port; geography implements it)
describe('scope reference validation', () => {
  const STOP = new Error('reached the transaction');
  /** A scripted database: answers the parameter and change-request reads and stops at the first transaction. */
  function scripted(changeRow: Record<string, unknown> = {}): Database {
    const executor = {
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown) => ({ sql: '', parameters: [], query: node, queryId: {} }),
      executeQuery: async (compiled: { query: { sqlFragments: string[] } }) => {
        const text = compiled.query.sqlFragments.join('?');
        if (text.includes('GROUP BY p.parameter_id'))
          return {
            rows: [
              {
                parameter_id: 'p1',
                key: 'devtest.geo.value',
                data_type: 'STRING',
                unit: null,
                description: 'd',
                owner_role: 'OPS',
                validation_rules: {},
                sensitivity: 'INTERNAL',
                approval_policy: 'NONE',
                criticality: 'STANDARD',
                is_required: true,
                is_active: true,
                allowed_scopes: ['PLATFORM', 'COUNTRY', 'MARKET'],
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        return {
          rows: [
            {
              change_request_id: 'c1',
              parameter_id: 'p1',
              key: 'devtest.geo.value',
              sensitivity: 'INTERNAL',
              scope_type: 'COUNTRY',
              scope_ref: 'US',
              proposed_value: 'v',
              effective_from: new Date(),
              effective_to: null,
              reason: 'r',
              requested_by: 'a',
              approval_policy: 'NONE',
              state: 'APPROVED',
              version: null,
              created_at: new Date(),
              updated_at: new Date(),
              ...changeRow,
            },
          ],
        };
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
  const recording = (answer: (t: ScopeType, r: string) => ScopeReferenceCheck | Error) => {
    const calls: [ScopeType, string][] = [];
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
  const draft = (scopeType: ScopeType, scopeRef: string | null) => ({
    parameterKey: 'devtest.geo.value',
    scopeType,
    scopeRef,
    value: 'v',
    reason: 'r',
  });
  const failure = async (p: Promise<unknown>) =>
    (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as ConfigurationError;

  it('createChangeRequest: a valid reference proceeds to the write', async () => {
    const { validator, calls } = recording(() => ({ valid: true }));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    expect(await failure(svc.createChangeRequest(draft('COUNTRY', 'US'), 'a'))).toBe(STOP);
    expect(calls).toEqual([['COUNTRY', 'US']]);
  });
  it('createChangeRequest: an invalid reference is VALIDATION_FAILED with a reason and no values', async () => {
    const { validator } = recording(() => ({ valid: false, reason: 'NOT_FOUND' }));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    const e = await failure(svc.createChangeRequest(draft('MARKET', 'la-oc'), 'a'));
    expect(e).toBeInstanceOf(ConfigurationError);
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'the scope reference is not valid',
      details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'MARKET', check: 'NOT_FOUND' },
    });
    expect(JSON.stringify([e.message, e.details])).not.toContain('la-oc');
  });
  it('PLATFORM is never validated', async () => {
    const { validator, calls } = recording(() => ({ valid: false, reason: 'NEVER' }));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    expect(await failure(svc.createChangeRequest(draft('PLATFORM', null), 'a'))).toBe(STOP);
    expect(calls).toEqual([]);
  });
  it('the existing scope shape checks still come first (no validator call for a missing or forbidden reference)', async () => {
    const { validator, calls } = recording(() => ({ valid: true }));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    expect((await failure(svc.createChangeRequest(draft('COUNTRY', null), 'a'))).code).toBe('VALIDATION_FAILED');
    expect((await failure(svc.createChangeRequest(draft('GIG', 'g'), 'a'))).code).toBe('SCOPE_NOT_ALLOWED');
    expect(calls).toEqual([]);
  });
  it('a validator that throws fails closed as UNAVAILABLE without leaking its message', async () => {
    const { validator } = recording(() => new Error('connection to geography failed: secret-host'));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: validator });
    const e = await failure(svc.createChangeRequest(draft('COUNTRY', 'US'), 'a'));
    expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'SCOPE_REFERENCE_UNAVAILABLE', scopeType: 'COUNTRY' } });
    expect(JSON.stringify([e.message, e.details])).not.toContain('secret-host');
    const p = await failure(svc.publish('c1', 'a'));
    expect(p.code).toBe('UNAVAILABLE');
  });
  it('without a validator the service behaves exactly as before', async () => {
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true });
    expect(await failure(svc.createChangeRequest(draft('COUNTRY', 'anything-at-all'), 'a'))).toBe(STOP);
    expect(await failure(svc.publish('c1', 'a'))).toBe(STOP);
  });
  it('publish re-validates the stored reference of an APPROVED request; other states and PLATFORM requests are left to the transaction', async () => {
    const bad = recording(() => ({ valid: false, reason: 'INACTIVE' }));
    const svc = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: bad.validator });
    expect(await failure(svc.publish('c1', 'a'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'COUNTRY', check: 'INACTIVE' },
    });
    expect(bad.calls).toEqual([['COUNTRY', 'US']]);
    const ok = recording(() => ({ valid: true }));
    const good = new ConfigurationService({ database: scripted(), env: 'test', allowTestKeys: true, scopeReferences: ok.validator });
    expect(await failure(good.publish('c1', 'a'))).toBe(STOP);
    const draftState = recording(() => ({ valid: false, reason: 'X' }));
    const notApproved = new ConfigurationService({
      database: scripted({ state: 'DRAFT' }),
      env: 'test',
      allowTestKeys: true,
      scopeReferences: draftState.validator,
    });
    expect(await failure(notApproved.publish('c1', 'a'))).toBe(STOP);
    const platform = recording(() => ({ valid: false, reason: 'X' }));
    const plat = new ConfigurationService({
      database: scripted({ scope_type: 'PLATFORM', scope_ref: null }),
      env: 'test',
      allowTestKeys: true,
      scopeReferences: platform.validator,
    });
    expect(await failure(plat.publish('c1', 'a'))).toBe(STOP);
    expect(draftState.calls).toEqual([]);
    expect(platform.calls).toEqual([]);
  });
});
