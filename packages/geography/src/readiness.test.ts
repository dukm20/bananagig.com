import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_READINESS_CODES,
  ReadinessRegistry,
  defaultReadinessRegistry,
  registerReadinessCheck,
  toReadinessDto,
  type ReadinessContext,
} from './readiness';
import { GeographyError } from './errors';
import { assertReadyForActivation } from './service';

const ctx = (
  over: Partial<{
    country: 'ACTIVE' | 'PLANNED' | 'INACTIVE';
    currency: 'ACTIVE' | 'PLANNED' | 'INACTIVE';
    locale: boolean;
    zone: 'ACTIVE' | 'PLANNED' | 'INACTIVE';
  }> = {},
): ReadinessContext => ({
  market: { code: 'm-1', status: 'PLANNED', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: 'America/Denver' },
  country: { code: 'US', status: over.country ?? 'ACTIVE' },
  currency: { code: 'USD', status: over.currency ?? 'ACTIVE' },
  locale: { tag: 'en-US', isActive: over.locale ?? true },
  timeZone: { ianaName: 'America/Denver', status: over.zone ?? 'ACTIVE' },
  at: new Date('2026-01-01T00:00:00Z'),
});
const failure = (fn: () => unknown): GeographyError => {
  try {
    fn();
  } catch (e) {
    return e as GeographyError;
  }
  throw new Error('expected a failure');
};

describe('readiness registry', () => {
  it('has the four built-in checks and passes when every dependency is ACTIVE', async () => {
    const r = new ReadinessRegistry();
    expect(r.list().map((c) => c.code)).toEqual([...BUILT_IN_READINESS_CODES]);
    const report = await r.evaluate(ctx());
    expect(report.ready).toBe(true);
    expect(report.checks.every((c) => c.passed && c.required)).toBe(true);
  });

  it('each built-in fails for its own dependency and the report says which', async () => {
    const r = new ReadinessRegistry();
    for (const [over, code] of [
      [{ country: 'PLANNED' as const }, 'COUNTRY_ACTIVE'],
      [{ currency: 'INACTIVE' as const }, 'CURRENCY_ACTIVE'],
      [{ locale: false }, 'LOCALE_ACTIVE'],
      [{ zone: 'PLANNED' as const }, 'TIME_ZONE_ACTIVE'],
    ] as const) {
      const report = await r.evaluate(ctx(over));
      expect(report.ready).toBe(false);
      expect(report.checks.filter((c) => !c.passed).map((c) => c.code)).toEqual([code]);
    }
  });

  it('a registered custom check is evaluated and honored; required decides whether a failure blocks', async () => {
    const r = new ReadinessRegistry();
    let tax = false;
    r.register({ code: 'TAX', description: 'tax', evaluate: async () => ({ passed: tax, detail: tax ? 'ok' : 'missing' }) });
    r.register({ code: 'OPTIONAL', description: 'optional', required: false, evaluate: () => ({ passed: false, detail: 'no' }) });
    expect((await r.evaluate(ctx())).ready).toBe(false);
    tax = true;
    const report = await r.evaluate(ctx());
    expect(report.ready).toBe(true); // the failing OPTIONAL check is reported but does not block
    expect(report.checks.find((c) => c.code === 'OPTIONAL')).toMatchObject({ passed: false, required: false });
    expect(toReadinessDto('m-1', report).checks.every((c) => Object.keys(c).sort().join() === 'code,detail,passed')).toBe(true);
  });

  it('rejects duplicate and malformed codes; the returned function unregisters; registries are independent', async () => {
    const r = new ReadinessRegistry();
    const off = r.register({ code: 'EXTRA', description: 'x', evaluate: () => ({ passed: true, detail: 'ok' }) });
    expect(() => r.register({ code: 'EXTRA', description: 'x', evaluate: () => ({ passed: true, detail: 'ok' }) })).toThrow(/already registered/);
    expect(() => r.register({ code: 'COUNTRY_ACTIVE', description: 'x', evaluate: () => ({ passed: true, detail: 'ok' }) })).toThrow();
    expect(() => r.register({ code: 'bad code', description: 'x', evaluate: () => ({ passed: true, detail: 'ok' }) })).toThrow(/invalid/);
    expect(r.has('EXTRA')).toBe(true);
    off();
    expect(r.has('EXTRA')).toBe(false);
    expect(new ReadinessRegistry().has('EXTRA')).toBe(false);
    expect(new ReadinessRegistry(false).list()).toEqual([]);
  });

  it('a throwing check fails with a fixed detail; its message is never returned', async () => {
    const r = new ReadinessRegistry();
    r.register({
      code: 'BOOM',
      description: 'x',
      evaluate: () => {
        throw new Error('postgres://user:password@host/db');
      },
    });
    const report = await r.evaluate(ctx());
    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.code === 'BOOM')).toEqual({ code: 'BOOM', passed: false, detail: 'the check could not be evaluated', required: true });
  });

  it('registerReadinessCheck adds to the process-wide registry', () => {
    const off = registerReadinessCheck({ code: 'GLOBAL_TEST_CHECK', description: 'x', evaluate: () => ({ passed: true, detail: 'ok' }) });
    expect(defaultReadinessRegistry.has('GLOBAL_TEST_CHECK')).toBe(true);
    off();
    expect(defaultReadinessRegistry.has('GLOBAL_TEST_CHECK')).toBe(false);
  });
});

describe('inactive dependency rejection (6)', () => {
  const run = async (c: ReadinessContext, registry = new ReadinessRegistry()) => assertReadyForActivation('m-1', await registry.evaluate(c));
  it('a failing built-in raises INVALID_STATE with the matching reason and the failing checks', async () => {
    for (const [over, reason] of [
      [{ country: 'INACTIVE' as const }, 'COUNTRY_NOT_ACTIVE'],
      [{ currency: 'PLANNED' as const }, 'CURRENCY_NOT_ACTIVE'],
      [{ locale: false }, 'LOCALE_NOT_ACTIVE'],
      [{ zone: 'INACTIVE' as const }, 'TIME_ZONE_NOT_ACTIVE'],
    ] as const) {
      let e: GeographyError | undefined;
      try {
        await run(ctx(over));
      } catch (x) {
        e = x as GeographyError;
      }
      expect([e?.code, e?.details.reason]).toEqual(['INVALID_STATE', reason]);
      expect((e?.details.checks as unknown[]).length).toBe(1);
    }
  });
  it('only a custom required check failing raises NOT_READY; nothing failing does not throw', async () => {
    const r = new ReadinessRegistry();
    r.register({ code: 'PAYMENT_PROVIDER', description: 'x', evaluate: () => ({ passed: false, detail: 'no provider' }) });
    let e: GeographyError | undefined;
    try {
      await run(ctx(), r);
    } catch (x) {
      e = x as GeographyError;
    }
    expect(e?.code).toBe('NOT_READY');
    expect(e?.details.checks).toEqual([{ code: 'PAYMENT_PROVIDER', detail: 'no provider' }]);
    await expect(run(ctx())).resolves.toBeUndefined();
    expect(failure(() => assertReadyForActivation('m', { ready: false, checks: [{ code: 'X', passed: false, detail: 'd', required: true }] })).code).toBe(
      'NOT_READY',
    );
    expect(() => assertReadyForActivation('m', { ready: true, checks: [{ code: 'X', passed: false, detail: 'd', required: false }] })).not.toThrow();
  });
});
