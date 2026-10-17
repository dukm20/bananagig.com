// Unit tests of the provider registration (PRO-001) that need no database: the pure requirement evaluator over every combination of its facts, the contact / market / role helpers,
// the fail-closed policy parser, the translation of the database constraint, guard and concurrency failures, the strict input validation that must happen BEFORE any port or
// statement is touched, the default future prerequisites and the invariants of the evaluator output (Go-Live is never evaluated, only PRO-001 steps ever block). Behaviour that
// needs real constraints, triggers, locks and the outbox is covered in provider.itest.ts.
//
// Written by an author who did not write the code under test. The service is built over a `database` and over ports whose every entry point throws a sentinel: a test that expects
// "nothing was touched" proves it by the absence of the sentinel and the zero call counts, a test that expects to get PAST validation proves it by the presence of the sentinel.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FUTURE_STEPS,
  ONBOARDING_STEPS,
  PROVIDER_POLICY_KEYS,
  PROVIDER_SERVICE_TYPES_CEILING,
  REGISTRATION_STEPS,
  type OnboardingStep,
  type OnboardingStepStatus,
  type ProviderRegistrationPolicy,
} from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { migrationsDir } from '@bananagig/testing';
import {
  ProviderError,
  ProviderRegistrationService,
  StaticPolicyProvider,
  UnavailablePrerequisites,
  contactState,
  evaluateRequirements,
  guardRuleOf,
  isDatabaseOutage,
  mapDbError,
  marketAcceptsProviders,
  parseProviderPolicy,
  providerPolicyKeys,
  providerRoleOf,
  type AccountFacts,
  type ConsentFacts,
  type EvaluationInput,
  type MarketFacts,
  type PrerequisiteState,
  type RegistrationView,
  type Requirements,
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
beforeEach(() => {
  logSink.lines.length = 0;
});

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const fail = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};
const asProvider = (e: unknown): ProviderError => {
  expect(e).toBeInstanceOf(ProviderError);
  return e as ProviderError;
};
/** Everything a caller can observe of an error, as one string. */
const surface = (e: ProviderError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};

// ====================================================================== builders
const POLICY: ProviderRegistrationPolicy = {
  requireVerifiedEmail: true,
  requireVerifiedPhone: true,
  marketStatusesAllowed: ['ACTIVE'],
  minServiceTypes: 1,
  maxServiceTypes: 10,
};
const policy = (over: Partial<ProviderRegistrationPolicy> = {}): ProviderRegistrationPolicy => ({ ...POLICY, marketStatusesAllowed: ['ACTIVE'], ...over });
const account = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  accountId: 'acc-1',
  status: 'ACTIVE',
  memberships: [
    { code: 'CUSTOMER', status: 'ACTIVE' },
    { code: 'PROVIDER', status: 'PENDING' },
  ],
  emailVerified: true,
  phoneVerified: true,
  ...over,
});
const registration = (over: Partial<RegistrationView> = {}): RegistrationView => ({
  providerRegistrationId: 'reg-1',
  attempt: 1,
  status: 'IN_PROGRESS',
  revision: 1,
  marketCode: 'la-oc',
  serviceTypeCodes: ['car_wash'],
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  ...over,
});
const consent = (over: Partial<ConsentFacts> = {}): ConsentFacts => ({ satisfied: true, outstanding: [], unavailable: [], requiredCount: 2, ...over });
const market = (over: Partial<MarketFacts> = {}): MarketFacts => ({ code: 'la-oc', status: 'ACTIVE', inEffect: true, ...over });
const futureOf = (s: OnboardingStepStatus = 'NOT_AVAILABLE') => {
  const st = { status: s } as PrerequisiteState;
  return { verification: st, subscription: st, profile: st, gigs: st };
};
/** A fully ready input: every PRO-001 step COMPLETE. */
const ready = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  policy: policy(),
  account: account(),
  registration: registration(),
  consent: consent(),
  market: market(),
  offered: ['car_wash', 'lawn_care'],
  future: futureOf(),
  ...over,
});
const stepOf = (r: Requirements, s: OnboardingStep) => r.steps.find((x) => x.step === s)!;

// ====================================================================== evaluateRequirements: the whole output
describe('evaluateRequirements: shape of the output', () => {
  it('reports the nine steps in the documented order with the documented owners, and a ready registration has nothing in the way', () => {
    const r = evaluateRequirements(ready());
    expect(r.steps.map((s) => s.step)).toEqual(['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES', 'VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']);
    expect(r.steps.map((s) => s.step)).toEqual([...ONBOARDING_STEPS]);
    expect(r.steps.map((s) => s.owner)).toEqual(['ID-001', 'ID-002, ID-003', 'ID-005', 'PRO-001', 'PRO-001', 'TRUST-001', 'SUB', 'PRO-002', 'CAT-003']);
    expect(r.steps.map((s) => s.status)).toEqual([
      'COMPLETE',
      'COMPLETE',
      'COMPLETE',
      'COMPLETE',
      'COMPLETE',
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
      'NOT_AVAILABLE',
    ]);
    expect(r.overall).toEqual({ registrationComplete: false, registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
    expect(r.providerRole).toBe('PENDING');
  });

  it('passes the registration through unchanged (the same object, or null) and never invents one', () => {
    const reg = registration({ status: 'COMPLETED', completedAt: '2026-01-02T00:00:00.000Z' });
    expect(evaluateRequirements(ready({ registration: reg })).registration).toBe(reg);
    expect(evaluateRequirements(ready({ registration: null })).registration).toBeNull();
  });

  it('does not mutate any of its inputs and returns copies of the consent lists', () => {
    const input = deepFreeze(ready({ consent: consent({ satisfied: false, outstanding: ['TERMS'], requiredCount: 2 }) }));
    const r = evaluateRequirements(input);
    const legal = stepOf(r, 'LEGAL');
    expect(legal.detail?.outstandingPurposes).toEqual(['TERMS']);
    expect(legal.detail?.outstandingPurposes).not.toBe(input.consent!.outstanding);
    expect(() => evaluateRequirements(input)).not.toThrow();
  });

  it('is deterministic: the same input gives a deep-equal output', () => {
    const input = ready({ consent: consent({ satisfied: false, outstanding: ['A'], requiredCount: 2 }), offered: [] });
    expect(evaluateRequirements(input)).toEqual(evaluateRequirements(input));
  });

  it('the registration is COMPLETE as a fact of the registration, independently of whether it is still ready (a market closed later does not undo it)', () => {
    const r = evaluateRequirements(ready({ registration: registration({ status: 'COMPLETED' }), market: market({ status: 'INACTIVE' }) }));
    expect(r.overall.registrationComplete).toBe(true);
    expect(r.overall.registrationReady).toBe(false);
    expect(r.overall.blockedBy).toEqual(['MARKET']);
    for (const st of ['IN_PROGRESS', 'CANCELLED'] as const)
      expect(evaluateRequirements(ready({ registration: registration({ status: st }) })).overall.registrationComplete).toBe(false);
    expect(evaluateRequirements(ready({ registration: null })).overall.registrationComplete).toBe(false);
  });
});

// ====================================================================== ACCOUNT
describe('evaluateRequirements: ACCOUNT', () => {
  const statuses = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED', 'WHATEVER'];
  const registrations: [string, RegistrationView | null][] = [
    ['none', null],
    ['IN_PROGRESS', registration()],
    ['COMPLETED', registration({ status: 'COMPLETED' })],
    ['CANCELLED latest', registration({ status: 'CANCELLED', cancelledAt: '2026-01-02T00:00:00.000Z' })],
  ];
  for (const status of statuses)
    for (const [label, reg] of registrations) {
      const wanted = status !== 'ACTIVE' ? 'BLOCKED' : label === 'none' || label === 'CANCELLED latest' ? 'NOT_STARTED' : 'COMPLETE';
      it(`account ${status} with registration ${label} is ${wanted}`, () => {
        const r = evaluateRequirements(ready({ account: account({ status }), registration: reg }));
        expect(stepOf(r, 'ACCOUNT').status).toBe(wanted);
        expect(r.overall.blockedBy.includes('ACCOUNT')).toBe(wanted !== 'COMPLETE');
      });
    }
});

// ====================================================================== CONTACT
describe('contactState and the CONTACT step', () => {
  const bools = [true, false];
  for (const reqE of bools)
    for (const reqP of bools)
      for (const vE of bools)
        for (const vP of bools) {
          const required = [reqE, reqP].filter(Boolean).length;
          const verified = [reqE && vE, reqP && vP].filter(Boolean).length;
          const wanted = required === 0 ? 'NOT_REQUIRED' : verified === required ? 'COMPLETE' : verified === 0 ? 'NOT_STARTED' : 'IN_PROGRESS';
          it(`require email ${reqE} / phone ${reqP}, email verified ${vE} / phone verified ${vP} -> ${wanted}`, () => {
            const p = policy({ requireVerifiedEmail: reqE, requireVerifiedPhone: reqP });
            const a = account({ emailVerified: vE, phoneVerified: vP });
            const c = contactState(p, a);
            expect(c.step).toBe('CONTACT');
            expect(c.status).toBe(wanted);
            expect(c.owner).toBe('ID-002, ID-003');
            expect(c.detail).toEqual({
              email: !reqE ? 'NOT_REQUIRED' : vE ? 'VERIFIED' : 'NOT_VERIFIED',
              phone: !reqP ? 'NOT_REQUIRED' : vP ? 'VERIFIED' : 'NOT_VERIFIED',
            });
            const r = evaluateRequirements(ready({ policy: p, account: a }));
            expect(stepOf(r, 'CONTACT')).toEqual(c);
            expect(r.overall.blockedBy.includes('CONTACT')).toBe(wanted !== 'COMPLETE' && wanted !== 'NOT_REQUIRED');
          });
        }

  it('only the contact facts and the policy matter: the account status and memberships do not change the answer', () => {
    const base = contactState(policy(), account());
    expect(contactState(policy(), account({ status: 'SUSPENDED', memberships: [] }))).toEqual(base);
  });
});

// ====================================================================== LEGAL
describe('evaluateRequirements: LEGAL', () => {
  const legal = (c: ConsentFacts | null) => stepOf(evaluateRequirements(ready({ consent: c })), 'LEGAL');
  it('no consent facts (no provider role yet): not started, no detail, and it blocks', () => {
    expect(legal(null)).toEqual({ step: 'LEGAL', status: 'NOT_STARTED', owner: 'ID-005' });
    expect(evaluateRequirements(ready({ consent: null })).overall.blockedBy).toEqual(['LEGAL']);
  });
  it('nothing required: NOT_REQUIRED, and it does not block', () => {
    expect(legal(consent({ requiredCount: 0, satisfied: true }))).toEqual({ step: 'LEGAL', status: 'NOT_REQUIRED', owner: 'ID-005' });
    expect(legal(consent({ requiredCount: 0, satisfied: false })).status).toBe('NOT_REQUIRED');
    expect(evaluateRequirements(ready({ consent: consent({ requiredCount: 0 }) })).overall.blockedBy).toEqual([]);
  });
  it('a required purpose with no published document is BLOCKED and names the outstanding purposes', () => {
    const s = legal(consent({ satisfied: false, outstanding: ['TERMS', 'PRIVACY'], unavailable: ['PRIVACY'], requiredCount: 2 }));
    expect(s.status).toBe('BLOCKED');
    expect(s.detail).toEqual({ outstandingPurposes: ['TERMS', 'PRIVACY'] });
  });
  it('an unavailable document wins over "satisfied" (never reads as complete) but nothing-required still wins over unavailable', () => {
    expect(legal(consent({ satisfied: true, unavailable: ['X'], requiredCount: 1 })).status).toBe('BLOCKED');
    expect(legal(consent({ satisfied: false, unavailable: ['X'], requiredCount: 0 })).status).toBe('NOT_REQUIRED');
  });
  it('satisfied is COMPLETE without detail', () => {
    expect(legal(consent())).toEqual({ step: 'LEGAL', status: 'COMPLETE', owner: 'ID-005' });
  });
  it('outstanding: all of the required purposes is NOT_STARTED, some is IN_PROGRESS (with the purposes in the detail)', () => {
    const all = legal(consent({ satisfied: false, outstanding: ['A', 'B'], requiredCount: 2 }));
    expect(all.status).toBe('NOT_STARTED');
    expect(all.detail).toEqual({ outstandingPurposes: ['A', 'B'] });
    const one = legal(consent({ satisfied: false, outstanding: ['B'], requiredCount: 2 }));
    expect(one.status).toBe('IN_PROGRESS');
    expect(one.detail).toEqual({ outstandingPurposes: ['B'] });
    expect(legal(consent({ satisfied: false, outstanding: ['A'], requiredCount: 1 })).status).toBe('NOT_STARTED');
    expect(legal(consent({ satisfied: false, outstanding: ['A', 'B', 'C'], requiredCount: 5 })).status).toBe('IN_PROGRESS');
  });
  it('every non-complete legal state blocks submitting; COMPLETE and NOT_REQUIRED do not', () => {
    const cases: [ConsentFacts | null, boolean][] = [
      [null, true],
      [consent({ requiredCount: 0 }), false],
      [consent(), false],
      [consent({ satisfied: false, outstanding: ['A'], requiredCount: 1 }), true],
      [consent({ satisfied: false, outstanding: ['A'], requiredCount: 2 }), true],
      [consent({ satisfied: false, outstanding: ['A'], unavailable: ['A'], requiredCount: 1 }), true],
    ];
    for (const [c, blocks] of cases) expect(evaluateRequirements(ready({ consent: c })).overall.blockedBy.includes('LEGAL'), JSON.stringify(c)).toBe(blocks);
  });
});

// ====================================================================== marketAcceptsProviders and MARKET
describe('marketAcceptsProviders', () => {
  const lists: ProviderRegistrationPolicy['marketStatusesAllowed'][] = [
    ['ACTIVE'],
    ['PLANNED'],
    ['INACTIVE'],
    ['ACTIVE', 'PLANNED'],
    ['PLANNED', 'INACTIVE'],
    ['ACTIVE', 'PLANNED', 'INACTIVE'],
  ];
  for (const list of lists)
    for (const status of ['PLANNED', 'ACTIVE', 'INACTIVE'])
      for (const inEffect of [true, false]) {
        // the window is read only for an ACTIVE market: a PLANNED market has no window in force yet and an INACTIVE one has ended, the status decides
        const wanted = (list as readonly string[]).includes(status) && (status !== 'ACTIVE' || inEffect);
        it(`policy ${list.join('+')} / market ${status} / in effect ${inEffect} -> ${wanted}`, () => {
          expect(marketAcceptsProviders(policy({ marketStatusesAllowed: list }), market({ status, inEffect }))).toBe(wanted);
        });
      }
  it('no market (unknown or not chosen) never accepts providers', () => {
    expect(marketAcceptsProviders(policy({ marketStatusesAllowed: ['ACTIVE', 'PLANNED', 'INACTIVE'] }), null)).toBe(false);
  });
  it('an unknown status string is never accepted', () => {
    expect(marketAcceptsProviders(policy({ marketStatusesAllowed: ['ACTIVE', 'PLANNED', 'INACTIVE'] }), market({ status: 'ARCHIVED' }))).toBe(false);
    expect(marketAcceptsProviders(policy({ marketStatusesAllowed: ['ACTIVE'] }), market({ status: 'active' }))).toBe(false);
  });
});

describe('evaluateRequirements: MARKET', () => {
  const m = (over: Partial<EvaluationInput>) => stepOf(evaluateRequirements(ready(over)), 'MARKET');
  it('not started without a live registration, or without a chosen market, and the cancelled attempt does not count', () => {
    expect(m({ registration: null })).toEqual({ step: 'MARKET', status: 'NOT_STARTED', owner: 'PRO-001' });
    expect(m({ registration: registration({ marketCode: null }) }).status).toBe('NOT_STARTED');
    expect(m({ registration: registration({ status: 'CANCELLED', cancelledAt: 'x', marketCode: 'la-oc' }) }).status).toBe('NOT_STARTED');
  });
  it('COMPLETE when the chosen market is accepted (detail names the market), BLOCKED when it is gone, closed, outside its window or not allowed by the policy', () => {
    expect(m({})).toEqual({ step: 'MARKET', status: 'COMPLETE', owner: 'PRO-001', detail: { marketCode: 'la-oc' } });
    expect(m({ market: null })).toEqual({ step: 'MARKET', status: 'BLOCKED', owner: 'PRO-001', detail: { marketCode: 'la-oc' } });
    expect(m({ market: market({ inEffect: false }) }).status).toBe('BLOCKED');
    expect(m({ market: market({ status: 'PLANNED' }) }).status).toBe('BLOCKED');
    expect(m({ market: market({ status: 'INACTIVE' }) }).status).toBe('BLOCKED');
    expect(m({ market: market({ status: 'PLANNED' }), policy: policy({ marketStatusesAllowed: ['ACTIVE', 'PLANNED'] }) }).status).toBe('COMPLETE');
    expect(m({ market: market({ status: 'PLANNED', inEffect: false }), policy: policy({ marketStatusesAllowed: ['PLANNED'] }) }).status).toBe('COMPLETE');
  });
  it('uses the market of the registration as given: a market object for another code does not matter to the evaluator (the service looks up the chosen code)', () => {
    expect(m({ registration: registration({ marketCode: 'sf-bay' }), market: market({ code: 'la-oc' }) }).detail).toEqual({ marketCode: 'sf-bay' });
  });
});

// ====================================================================== SERVICES
describe('evaluateRequirements: SERVICES', () => {
  const OFFER = ['s_a', 's_b', 's_c', 's_d'];
  const svc = (over: Partial<EvaluationInput>) => stepOf(evaluateRequirements(ready(over)), 'SERVICES');
  for (const min of [0, 1, 2])
    for (const max of [1, 3])
      if (min <= max)
        for (const n of [0, 1, 2, 3, 4])
          for (const withStranger of [false, true]) {
            const selected = OFFER.slice(0, n);
            if (withStranger && n > 0) selected[selected.length - 1] = 'gone_type';
            const notOffered = selected.filter((c) => !OFFER.includes(c));
            let wanted: OnboardingStepStatus;
            if (notOffered.length > 0 || n > max) wanted = 'BLOCKED';
            else if (n === 0) wanted = min === 0 ? 'NOT_REQUIRED' : 'NOT_STARTED';
            else if (n < min) wanted = 'IN_PROGRESS';
            else wanted = 'COMPLETE';
            it(`min ${min} max ${max}, ${n} selected${withStranger && n > 0 ? ' (one not offered)' : ''} -> ${wanted}`, () => {
              const s = svc({
                policy: policy({ minServiceTypes: min, maxServiceTypes: max }),
                registration: registration({ serviceTypeCodes: selected }),
                offered: OFFER,
              });
              expect(s.status).toBe(wanted);
              expect(s.owner).toBe('PRO-001');
              expect(s.detail).toEqual({ selected: n, min, max, ...(notOffered.length > 0 ? { notOffered } : {}) });
            });
          }
  it('no live registration: NOT_STARTED with no detail, even when a cancelled attempt held selections', () => {
    expect(svc({ registration: null })).toEqual({ step: 'SERVICES', status: 'NOT_STARTED', owner: 'PRO-001' });
    expect(svc({ registration: registration({ status: 'CANCELLED', cancelledAt: 'x', serviceTypeCodes: ['car_wash'] }) })).toEqual({
      step: 'SERVICES',
      status: 'NOT_STARTED',
      owner: 'PRO-001',
    });
  });
  it('no market chosen (offered is null) with selections: every selected code is "not offered" and the step is BLOCKED', () => {
    const s = svc({ registration: registration({ marketCode: null, serviceTypeCodes: ['car_wash'] }), offered: null });
    expect(s.status).toBe('BLOCKED');
    expect(s.detail?.notOffered).toEqual(['car_wash']);
  });
  it('no market chosen and nothing selected: NOT_STARTED (or NOT_REQUIRED with min 0)', () => {
    expect(svc({ registration: registration({ marketCode: null, serviceTypeCodes: [] }), offered: null }).status).toBe('NOT_STARTED');
    expect(svc({ registration: registration({ marketCode: null, serviceTypeCodes: [] }), offered: null, policy: policy({ minServiceTypes: 0 }) }).status).toBe(
      'NOT_REQUIRED',
    );
  });
  it('min 0 with a selection within bounds is COMPLETE, never NOT_REQUIRED', () => {
    expect(svc({ policy: policy({ minServiceTypes: 0 }), registration: registration({ serviceTypeCodes: ['car_wash'] }) }).status).toBe('COMPLETE');
  });
  it('lists every code that is not offered, in selection order', () => {
    const s = svc({ registration: registration({ serviceTypeCodes: ['a_x', 'car_wash', 'z_y'] }), offered: ['car_wash'] });
    expect(s.detail?.notOffered).toEqual(['a_x', 'z_y']);
  });
  it('NOT_REQUIRED does not block; NOT_STARTED, IN_PROGRESS and BLOCKED do', () => {
    const blocks = (over: Partial<EvaluationInput>) => evaluateRequirements(ready(over)).overall.blockedBy.includes('SERVICES');
    expect(blocks({ policy: policy({ minServiceTypes: 0 }), registration: registration({ serviceTypeCodes: [] }) })).toBe(false);
    expect(blocks({ registration: registration({ serviceTypeCodes: [] }) })).toBe(true);
    expect(blocks({ policy: policy({ minServiceTypes: 2 }) })).toBe(true);
    expect(blocks({ offered: [] })).toBe(true);
  });
});

// ====================================================================== future steps and the invariants
describe('evaluateRequirements: future prerequisites and the invariants', () => {
  const fut = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'NOT_AVAILABLE', 'NOT_REQUIRED'] as const;
  for (const st of fut)
    it(`a future domain that reports ${st} is reported as such and never changes readiness`, () => {
      const base = evaluateRequirements(ready());
      const r = evaluateRequirements(ready({ future: futureOf(st) }));
      for (const s of FUTURE_STEPS) expect(stepOf(r, s).status).toBe(st);
      expect(r.overall).toEqual(base.overall);
      expect(r.overall.registrationReady).toBe(true);
      expect(r.overall.blockedBy).toEqual([]);
      expect(r.overall.goLive).toEqual({ evaluated: false, eligible: false });
    });
  it('each future step reads its own prerequisite', () => {
    const r = evaluateRequirements(
      ready({
        future: {
          verification: { status: 'COMPLETE' },
          subscription: { status: 'BLOCKED' },
          profile: { status: 'IN_PROGRESS' },
          gigs: { status: 'NOT_STARTED' },
        },
      }),
    );
    expect(stepOf(r, 'VERIFICATION').status).toBe('COMPLETE');
    expect(stepOf(r, 'SUBSCRIPTION').status).toBe('BLOCKED');
    expect(stepOf(r, 'PROFILE').status).toBe('IN_PROGRESS');
    expect(stepOf(r, 'GIGS').status).toBe('NOT_STARTED');
  });
  it('the future steps carry no detail and no fake record', () => {
    for (const s of FUTURE_STEPS) expect(Object.keys(stepOf(evaluateRequirements(ready()), s)).sort()).toEqual(['owner', 'status', 'step']);
  });

  it('PROPERTY: over a broad pseudo-random sample, Go-Live is never evaluated or eligible, only PRO-001 steps block, and blockedBy is exactly the unsatisfied registration steps in order', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]!;
    const OFFER = ['s_a', 's_b', 's_c'];
    for (let i = 0; i < 3000; i++) {
      const min = rnd(3);
      const p = policy({
        requireVerifiedEmail: rnd(2) === 0,
        requireVerifiedPhone: rnd(2) === 0,
        marketStatusesAllowed: pick([
          ['ACTIVE'],
          ['PLANNED'],
          ['ACTIVE', 'PLANNED'],
          ['INACTIVE', 'ACTIVE', 'PLANNED'],
        ] as const).slice() as ProviderRegistrationPolicy['marketStatusesAllowed'],
        minServiceTypes: min,
        maxServiceTypes: min + 1 + rnd(2),
      });
      const regStatus = pick(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const);
      const reg =
        rnd(5) === 0
          ? null
          : registration({
              status: regStatus,
              marketCode: rnd(4) === 0 ? null : 'la-oc',
              serviceTypeCodes: OFFER.slice(0, rnd(5)).concat(rnd(6) === 0 ? ['gone'] : []),
            });
      const required = rnd(4);
      const c =
        rnd(6) === 0
          ? null
          : consent({
              requiredCount: required,
              satisfied: rnd(2) === 0,
              outstanding: OFFER.slice(0, rnd(required + 1)),
              unavailable: rnd(5) === 0 ? ['x'] : [],
            });
      const input: EvaluationInput = {
        policy: p,
        account: account({
          status: pick(['ACTIVE', 'ACTIVE', 'SUSPENDED', 'CLOSED']),
          emailVerified: rnd(2) === 0,
          phoneVerified: rnd(2) === 0,
          memberships: rnd(3) === 0 ? [] : account().memberships,
        }),
        registration: reg,
        consent: c,
        market: rnd(5) === 0 ? null : market({ status: pick(['PLANNED', 'ACTIVE', 'INACTIVE']), inEffect: rnd(2) === 0 }),
        offered: rnd(5) === 0 ? null : OFFER.slice(0, 1 + rnd(3)),
        future: { verification: { status: pick(fut) }, subscription: { status: pick(fut) }, profile: { status: pick(fut) }, gigs: { status: pick(fut) } },
      };
      const r = evaluateRequirements(input);
      const ctx = JSON.stringify(input);
      expect(r.overall.goLive, ctx).toEqual({ evaluated: false, eligible: false });
      expect(
        r.steps.map((s) => s.step),
        ctx,
      ).toEqual([...ONBOARDING_STEPS]);
      const expected = REGISTRATION_STEPS.filter((s) => !['COMPLETE', 'NOT_REQUIRED'].includes(stepOf(r, s).status));
      expect(r.overall.blockedBy, ctx).toEqual(expected);
      for (const b of r.overall.blockedBy) expect((REGISTRATION_STEPS as readonly string[]).includes(b), ctx).toBe(true);
      for (const f of FUTURE_STEPS) expect(r.overall.blockedBy.includes(f as never), ctx).toBe(false);
      expect(r.overall.registrationReady, ctx).toBe(expected.length === 0);
      expect(r.overall.registrationComplete, ctx).toBe(reg?.status === 'COMPLETED');
    }
  });
});

// ====================================================================== providerRoleOf
describe('providerRoleOf', () => {
  it('NONE without a PROVIDER membership; otherwise the membership status', () => {
    expect(providerRoleOf([])).toBe('NONE');
    expect(providerRoleOf([{ code: 'CUSTOMER', status: 'ACTIVE' }])).toBe('NONE');
    for (const s of ['PENDING', 'ACTIVE', 'INACTIVE'] as const) {
      expect(providerRoleOf([{ code: 'PROVIDER', status: s }])).toBe(s);
      expect(
        providerRoleOf([
          { code: 'CUSTOMER', status: 'INACTIVE' },
          { code: 'PROVIDER', status: s },
        ]),
      ).toBe(s);
    }
  });
  it('is case-sensitive and ignores other roles', () => {
    expect(providerRoleOf([{ code: 'provider', status: 'ACTIVE' }])).toBe('NONE');
    expect(providerRoleOf([{ code: 'PROVIDER_ADMIN', status: 'ACTIVE' }])).toBe('NONE');
  });
});

// ====================================================================== policy
describe('parseProviderPolicy: fail closed, never a default', () => {
  const K = PROVIDER_POLICY_KEYS;
  const good = (): Record<string, unknown> => ({
    [K.requireVerifiedEmail]: true,
    [K.requireVerifiedPhone]: false,
    [K.marketStatusesAllowed]: ['ACTIVE', 'PLANNED'],
    [K.minServiceTypes]: 1,
    [K.maxServiceTypes]: 10,
  });
  const expectInvalid = (values: Record<string, unknown>, label = JSON.stringify(values)) => {
    const e = asProvider(capture(() => parseProviderPolicy(values)));
    expect(e.code, label).toBe('UNAVAILABLE');
    expect(e.details, label).toEqual({ reason: 'POLICY_INVALID' });
    expect(surface(e), label).not.toMatch(/ACTIVE|true|false|\d{2}/); // no configured value is echoed
  };

  it('maps the five configuration keys onto the typed policy', () => {
    expect(parseProviderPolicy(good())).toEqual({
      requireVerifiedEmail: true,
      requireVerifiedPhone: false,
      marketStatusesAllowed: ['ACTIVE', 'PLANNED'],
      minServiceTypes: 1,
      maxServiceTypes: 10,
    });
  });
  it('the five configuration keys are the documented ones', () => {
    expect([...providerPolicyKeys()].sort()).toEqual(
      [
        'provider.registration.market_statuses_allowed',
        'provider.registration.max_service_types',
        'provider.registration.min_service_types',
        'provider.registration.require_verified_email',
        'provider.registration.require_verified_phone',
      ].sort(),
    );
  });
  it('nothing at all, and any single missing key, fails closed (there is no code default)', () => {
    expectInvalid({});
    for (const key of Object.values(K)) {
      const v = good();
      delete v[key];
      expectInvalid(v, `missing ${key}`);
      v[key] = undefined;
      expectInvalid(v, `undefined ${key}`);
      v[key] = null;
      expectInvalid(v, `null ${key}`);
    }
  });
  it('values keyed by anything else (the field names, not the configuration keys) are not read', () => {
    expectInvalid({ requireVerifiedEmail: true, requireVerifiedPhone: true, marketStatusesAllowed: ['ACTIVE'], minServiceTypes: 1, maxServiceTypes: 10 });
  });
  it('wrong types fail: strings for booleans or numbers, numbers for booleans', () => {
    for (const bad of ['true', 'false', 1, 0, null, {}, []]) {
      expectInvalid({ ...good(), [K.requireVerifiedEmail]: bad }, `email ${JSON.stringify(bad)}`);
      expectInvalid({ ...good(), [K.requireVerifiedPhone]: bad }, `phone ${JSON.stringify(bad)}`);
    }
    for (const bad of ['1', '10', true, null, {}, [], NaN, Infinity, 1.5, -1]) {
      expectInvalid({ ...good(), [K.minServiceTypes]: bad }, `min ${String(bad)}`);
      expectInvalid({ ...good(), [K.maxServiceTypes]: bad }, `max ${String(bad)}`);
    }
  });
  it('the status list must be a non-empty list of unique known statuses', () => {
    for (const bad of [
      [],
      ['ARCHIVED'],
      ['active'],
      ['ACTIVE', 'ACTIVE'],
      'ACTIVE',
      '["ACTIVE"]',
      null,
      {},
      ['ACTIVE', 5],
      [['ACTIVE']],
      ['ACTIVE', 'PLANNED', 'INACTIVE', 'ACTIVE'],
    ])
      expectInvalid({ ...good(), [K.marketStatusesAllowed]: bad }, JSON.stringify(bad));
  });
  it('the service type bounds: 0 <= min <= max <= ceiling, max >= 1, integers', () => {
    expectInvalid({ ...good(), [K.minServiceTypes]: 11, [K.maxServiceTypes]: 10 });
    expectInvalid({ ...good(), [K.minServiceTypes]: 2, [K.maxServiceTypes]: 1 });
    expectInvalid({ ...good(), [K.minServiceTypes]: -1 });
    expectInvalid({ ...good(), [K.maxServiceTypes]: 0, [K.minServiceTypes]: 0 });
    expectInvalid({ ...good(), [K.maxServiceTypes]: PROVIDER_SERVICE_TYPES_CEILING + 1 });
    expectInvalid({ ...good(), [K.minServiceTypes]: PROVIDER_SERVICE_TYPES_CEILING + 1, [K.maxServiceTypes]: PROVIDER_SERVICE_TYPES_CEILING });
    expectInvalid({ ...good(), [K.minServiceTypes]: 1.0000001 });
  });
  it('the boundaries are valid', () => {
    expect(parseProviderPolicy({ ...good(), [K.minServiceTypes]: 0, [K.maxServiceTypes]: 1 })).toMatchObject({ minServiceTypes: 0, maxServiceTypes: 1 });
    expect(parseProviderPolicy({ ...good(), [K.minServiceTypes]: 5, [K.maxServiceTypes]: 5 })).toMatchObject({ minServiceTypes: 5, maxServiceTypes: 5 });
    expect(
      parseProviderPolicy({ ...good(), [K.minServiceTypes]: PROVIDER_SERVICE_TYPES_CEILING, [K.maxServiceTypes]: PROVIDER_SERVICE_TYPES_CEILING }),
    ).toMatchObject({ minServiceTypes: 50, maxServiceTypes: 50 });
    expect(parseProviderPolicy({ ...good(), [K.marketStatusesAllowed]: ['INACTIVE', 'PLANNED', 'ACTIVE'] }).marketStatusesAllowed).toEqual([
      'INACTIVE',
      'PLANNED',
      'ACTIVE',
    ]);
    expect(parseProviderPolicy({ ...good(), [K.requireVerifiedEmail]: false, [K.requireVerifiedPhone]: false })).toMatchObject({
      requireVerifiedEmail: false,
      requireVerifiedPhone: false,
    });
  });
  it('unrelated extra configuration keys are ignored', () => {
    expect(parseProviderPolicy({ ...good(), 'something.else': 1 })).toEqual(parseProviderPolicy(good()));
  });
});

describe('StaticPolicyProvider', () => {
  it('returns the current value, counts reads, follows a changed value and fails when told to', async () => {
    const p = new StaticPolicyProvider(policy());
    expect(await p.policy()).toEqual(policy());
    expect(p.reads).toBe(1);
    p.value = policy({ minServiceTypes: 3 });
    expect((await p.policy()).minServiceTypes).toBe(3);
    p.failure = new ProviderError('UNAVAILABLE', 'down');
    expect(await fail(p.policy())).toBe(p.failure);
    expect(p.reads).toBe(3);
    p.failure = undefined;
    expect(await p.policy()).toBeDefined();
  });
});

// ====================================================================== mapDbError
describe('guardRuleOf', () => {
  it('reads exactly provider_rule:<KEY>', () => {
    expect(guardRuleOf('provider_rule:ACCOUNT_NOT_ACTIVE')).toBe('ACCOUNT_NOT_ACTIVE');
    for (const bad of [
      undefined,
      null,
      5,
      '',
      'provider_rule:',
      'provider_rule:lower',
      'xprovider_rule:A',
      'provider_rule:A ',
      ' provider_rule:A',
      'catalog_rule:A',
      'provider_rule:A\nB',
      'provider_rule:1A',
    ])
      expect(guardRuleOf(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('mapDbError', () => {
  const dbErr = (props: Record<string, unknown>) =>
    Object.assign(new Error('driver text: relation "provider.registrations" violates something secret-looking SECRETVALUE'), props);
  const mapped = (e: unknown): ProviderError => asProvider(capture(() => mapDbError(e)));
  const noDriverText = (e: ProviderError) => expect(surface(e)).not.toMatch(/driver text|provider\.registrations|SECRETVALUE|relation "/);

  const GUARD_RULES: Record<string, { code: string; reason?: string }> = {
    ACCOUNT_NOT_ACTIVE: { code: 'ACCOUNT_NOT_ACTIVE', reason: 'ACCOUNT_NOT_ACTIVE' },
    REGISTRATION_NOT_IN_PROGRESS: { code: 'REGISTRATION_NOT_IN_PROGRESS', reason: 'REGISTRATION_NOT_IN_PROGRESS' },
    REGISTRATION_FROZEN: { code: 'REGISTRATION_NOT_IN_PROGRESS', reason: 'REGISTRATION_FROZEN' },
    STATUS_TRANSITION: { code: 'REGISTRATION_NOT_IN_PROGRESS', reason: 'STATUS_TRANSITION' },
    SERVICE_TYPE_RETIRED: { code: 'SERVICE_TYPE_NOT_ELIGIBLE', reason: 'SERVICE_TYPE_RETIRED' },
    SERVICE_TYPE_NOT_ACTIVE: { code: 'SERVICE_TYPE_NOT_ELIGIBLE', reason: 'SERVICE_TYPE_NOT_ACTIVE' },
    NOT_DELETABLE: { code: 'CONFLICT', reason: 'NOT_DELETABLE' },
    IMMUTABLE_IDENTITY: { code: 'CONFLICT', reason: 'IMMUTABLE_IDENTITY' },
    MUST_START_IN_PROGRESS: { code: 'CONFLICT', reason: 'MUST_START_IN_PROGRESS' },
    REGISTRATION_ATTEMPT_SEQUENCE: { code: 'CONFLICT', reason: 'REGISTRATION_ATTEMPT_SEQUENCE' },
    REVISION_ONLY_GROWS: { code: 'CONFLICT', reason: 'REVISION_ONLY_GROWS' },
    ROW_IMMUTABLE: { code: 'CONFLICT', reason: 'ROW_IMMUTABLE' },
  };

  it('every guard rule key of migration 0018 is mapped by this table (a new key in the migration must be added to the translation on purpose)', () => {
    const sql = readFileSync(path.join(migrationsDir(), '0018_provider_registration.sql'), 'utf8');
    const keys = [...new Set([...sql.matchAll(/provider_rule:([A-Z][A-Z_]*)/g)].map((m) => m[1]!))].sort();
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(GUARD_RULES).sort()).toEqual(keys);
  });
  for (const [rule, want] of Object.entries(GUARD_RULES))
    it(`guard rule ${rule} -> ${want.code}`, () => {
      const e = mapped(dbErr({ code: '23000', detail: `provider_rule:${rule}`, constraint: 'whatever' }));
      expect(e.code).toBe(want.code);
      expect(e.details).toEqual({ reason: want.reason });
      noDriverText(e);
    });
  it('a guard failure without a recognisable rule is a CONFLICT with no reason; a rule of another schema is not trusted', () => {
    for (const detail of [
      undefined,
      '',
      'catalog_rule:SERVICE_TYPE_RETIRED',
      'provider_rule:lower',
      'provider_rule:ACCOUNT_NOT_ACTIVE and more',
      'xprovider_rule:ACCOUNT_NOT_ACTIVE',
    ]) {
      const e = mapped(dbErr({ code: '23000', detail }));
      expect(e.code, String(detail)).toBe('CONFLICT');
      expect(e.details, String(detail)).toEqual({});
    }
  });
  it('an unknown but well-formed rule key is a CONFLICT that carries only the key', () => {
    const e = mapped(dbErr({ code: '23000', detail: 'provider_rule:SOMETHING_NEW' }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'SOMETHING_NEW' });
  });
  it('deadlock, serialization failure, lock timeout and a unique violation are a retryable CONFLICT', () => {
    for (const code of ['40P01', '40001', '55P03', '23505']) {
      const e = mapped(dbErr({ code, constraint: 'uq_registrations__live', detail: 'Key (account_id)=(secret) already exists.' }));
      expect(e.code, code).toBe('CONFLICT');
      expect(e.details, code).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
      noDriverText(e);
      expect(surface(e)).not.toMatch(/secret|uq_registrations/);
    }
  });
  it('a forbidden character is VALIDATION_FAILED, a missing reference is VALIDATION_FAILED REFERENCE_NOT_FOUND', () => {
    for (const code of ['22021', '22P05']) {
      const e = mapped(dbErr({ code }));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'FORBIDDEN_CHARACTER' });
    }
    const f = mapped(dbErr({ code: '23503', constraint: 'fk_registrations__market_id' }));
    expect(f.code).toBe('VALIDATION_FAILED');
    expect(f.details).toEqual({ reason: 'REFERENCE_NOT_FOUND' });
    noDriverText(f);
  });
  it('an outage is UNAVAILABLE with a fixed message, logged once without a stack, a registration id or an account id', () => {
    const outages = [
      dbErr({ code: 'ECONNREFUSED' }),
      dbErr({ code: 'ETIMEDOUT' }),
      dbErr({ code: '08006' }),
      dbErr({ code: '53300' }),
      dbErr({ code: '57P01' }),
      dbErr({ code: '57014' }),
      dbErr({ code: '58030' }),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
    ];
    for (const o of outages) {
      logSink.lines.length = 0;
      const e = mapped(o);
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.message).toBe('the provider registration is unavailable');
      expect(e.details).toEqual({});
      noDriverText(e);
      expect(logSink.lines).toHaveLength(1);
      expect(JSON.parse(logSink.lines[0]!)).toMatchObject({ level: 'error', message: 'provider registration database unavailable' });
    }
  });
  it('typed errors pass through as the same instance, untouched and unlogged', () => {
    const own = new ProviderError('STALE_REGISTRATION', 'stale', { reason: 'STALE_REGISTRATION' });
    expect(capture(() => mapDbError(own))).toBe(own);
    expect(logSink.lines).toEqual([]);
  });
  it('non-database errors are rethrown as they are: programming errors, SQL data and syntax errors, null, undefined and primitives', () => {
    const things: unknown[] = [
      new TypeError('x is not a function, connection'),
      new RangeError('out of range'),
      new ReferenceError('nope'),
      new SyntaxError('bad json'),
      new Error('boom'),
      dbErr({ code: '42P01' }),
      dbErr({ code: '23502' }),
      dbErr({ code: '23514' }),
      dbErr({ code: '25P02' }),
      dbErr({ code: '22001' }),
      dbErr({ code: 'XX000' }),
      'a string',
      42,
      null,
      undefined,
    ];
    for (const t of things)
      expect(
        capture(() => mapDbError(t)),
        String(t),
      ).toBe(t);
    expect(logSink.lines).toEqual([]);
  });
});

describe('isDatabaseOutage', () => {
  it('classifies connectivity, the 08/53/57/58 classes and connection-looking messages as outages; integrity, data and syntax classes and programming errors as not', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', '08000', '53200', '57P03', '58000'])
      expect(isDatabaseOutage(Object.assign(new Error('x'), { code })), code).toBe(true);
    for (const code of ['22003', '23505', '25001', '40001', '42601', 'P0001'])
      expect(isDatabaseOutage(Object.assign(new Error('connection lost'), { code })), code).toBe(code === 'P0001');
    expect(isDatabaseOutage(new Error('socket hang up'))).toBe(true);
    expect(isDatabaseOutage(new Error('plain failure'))).toBe(false);
    expect(isDatabaseOutage(new TypeError('connection'))).toBe(false);
    expect(isDatabaseOutage(new ProviderError('UNAVAILABLE', 'connection'))).toBe(false);
    expect(isDatabaseOutage(null)).toBe(false);
    expect(isDatabaseOutage('connection')).toBe(false);
  });
});

// ====================================================================== input validation, before any port or statement
const SENTINEL = new Error('the dependency was touched');
describe('input validation happens before any port or database access', () => {
  const calls: string[] = [];
  const trap = (name: string) => (): never => {
    calls.push(name);
    throw SENTINEL;
  };
  const trapped = (name: string) => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : trap(`${name}.${String(prop)}`)) });
  const database = {
    get db(): never {
      calls.push('database.db');
      throw SENTINEL;
    },
    get inTransaction(): boolean {
      return false;
    },
    transaction: trap('database.transaction'),
  } as unknown as Database;
  const service = new ProviderRegistrationService({
    database,
    accounts: trapped('accounts') as never,
    consent: trapped('consent') as never,
    markets: trapped('markets') as never,
    catalog: trapped('catalog') as never,
    policy: trapped('policy') as never,
  });
  beforeEach(() => {
    calls.length = 0;
  });

  const rejects = async (p: Promise<unknown>, field?: string): Promise<void> => {
    const e = asProvider(await fail(p));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.message).toBe('the request is not valid');
    expect(e.details.reason).toBe('INVALID_REQUEST');
    if (field !== undefined) expect(e.details.field).toBe(field);
    expect(Object.keys(e.details).sort()).toEqual(['field', 'reason']);
    expect(calls, 'nothing may be touched').toEqual([]);
  };
  const passes = async (p: Promise<unknown>): Promise<void> => {
    expect(await fail(p)).toBe(SENTINEL);
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
  };

  it('start: only an empty object (or nothing) is accepted; the account is never taken from the body', async () => {
    await passes(service.startRegistration('acc-1'));
    calls.length = 0;
    await passes(service.startRegistration('acc-1', {}));
    for (const bad of [{ accountId: 'acc-2' }, { x: 1 }, null, 'x', 5, [], [{}]]) await rejects(service.startRegistration('acc-1', bad));
  });

  it('selectMarket: a market code of the contract and, optionally, a positive 32-bit integer revision', async () => {
    await passes(service.selectMarket('acc-1', { marketCode: 'la-oc' }));
    calls.length = 0;
    await passes(service.selectMarket('acc-1', { marketCode: 'la-oc', expectedRevision: 1 }));
    calls.length = 0;
    await passes(service.selectMarket('acc-1', { marketCode: 'la-oc', expectedRevision: 2147483647 }));
    for (const marketCode of [
      undefined,
      null,
      '',
      'LA-OC',
      'la_oc',
      'la oc',
      '-la',
      'la-',
      'la--oc',
      '1la',
      'x'.repeat(61),
      5,
      ['la-oc'],
      { code: 'la-oc' },
      "la-oc'; DROP TABLE x;--",
    ])
      await rejects(service.selectMarket('acc-1', { marketCode }), 'marketCode');
    for (const expectedRevision of [0, -1, 1.5, '1', null, NaN, Infinity, 2147483648, {}, [1]])
      await rejects(service.selectMarket('acc-1', { marketCode: 'la-oc', expectedRevision }), 'expectedRevision');
    for (const bad of [undefined, null, 'la-oc', 7, [], {}, { marketCode: 'la-oc', accountId: 'acc-2' }, { marketCode: 'la-oc', extra: true }])
      await rejects(service.selectMarket('acc-1', bad));
  });

  it('replaceServiceTypes: a list of at most 50 distinct catalogue codes and, optionally, a positive 32-bit integer revision', async () => {
    await passes(service.replaceServiceTypes('acc-1', { serviceTypeCodes: [] }));
    calls.length = 0;
    await passes(service.replaceServiceTypes('acc-1', { serviceTypeCodes: ['car_wash', 'lawn_care'], expectedRevision: 3 }));
    calls.length = 0;
    const fifty = Array.from({ length: PROVIDER_SERVICE_TYPES_CEILING }, (_, i) => `type_${String(i).padStart(2, '0')}`);
    await passes(service.replaceServiceTypes('acc-1', { serviceTypeCodes: fifty }));
    await rejects(service.replaceServiceTypes('acc-1', { serviceTypeCodes: [...fifty, 'type_extra'] }), 'serviceTypeCodes');
    await rejects(service.replaceServiceTypes('acc-1', { serviceTypeCodes: ['car_wash', 'car_wash'] }), 'serviceTypeCodes');
    for (const serviceTypeCodes of [
      undefined,
      null,
      'car_wash',
      {},
      [5],
      [null],
      [''],
      ['a'],
      ['Car_Wash'],
      ['car-wash'],
      ['_car'],
      ['car__wash'],
      ['x'.repeat(49)],
      ['car_wash', ' lawn_care'],
    ])
      await rejects(service.replaceServiceTypes('acc-1', { serviceTypeCodes }), 'serviceTypeCodes');
    for (const expectedRevision of [0, -3, 2.5, '2', null])
      await rejects(service.replaceServiceTypes('acc-1', { serviceTypeCodes: ['car_wash'], expectedRevision }), 'expectedRevision');
    for (const bad of [
      undefined,
      null,
      [],
      'x',
      { serviceTypeCodes: ['car_wash'], marketCode: 'la-oc' },
      { serviceTypeCodes: ['car_wash'], accountId: 'acc-2' },
    ])
      await rejects(service.replaceServiceTypes('acc-1', bad));
  });

  it('submit: the revision is required (a positive 32-bit integer), nothing else is accepted', async () => {
    await passes(service.submitRegistration('acc-1', { expectedRevision: 1 }));
    for (const bad of [
      undefined,
      null,
      {},
      'x',
      [],
      { expectedRevision: 0 },
      { expectedRevision: -1 },
      { expectedRevision: 1.2 },
      { expectedRevision: '1' },
      { expectedRevision: null },
      { expectedRevision: 2147483648 },
      { expectedRevision: 1, extra: 1 },
      { expectedRevision: 1, accountId: 'a' },
    ]) {
      calls.length = 0;
      await rejects(service.submitRegistration('acc-1', bad));
    }
  });

  it('cancel: takes NO input at all (nothing, undefined or {}); a free-text reason is refused before anything is touched, so it can never reach the audit trail', async () => {
    await passes(service.cancelRegistration('acc-1'));
    await passes(service.cancelRegistration('acc-1', undefined));
    await passes(service.cancelRegistration('acc-1', {}));
    for (const reason of ['I changed my mind', 'x'.repeat(1000), 'x'.repeat(1001), '', '   ', '\t\n', 'a\u0000b', 5, null, true, ['x']])
      await rejects(service.cancelRegistration('acc-1', { reason }));
    for (const bad of [null, 'x', 5, [], { note: 'x' }, { status: 'CANCELLED' }, { reason: 'ok', accountId: 'a' }])
      await rejects(service.cancelRegistration('acc-1', bad));
  });

  it('the validation error never echoes the offending value', async () => {
    const e = asProvider(await fail(service.selectMarket('acc-1', { marketCode: 'LEAKED-SECRET-VALUE' })));
    expect(surface(e)).not.toContain('LEAKED-SECRET-VALUE');
    const f = asProvider(await fail(service.cancelRegistration('acc-1', { reason: `${'x'.repeat(1001)}LEAKED-REASON` })));
    expect(surface(f)).not.toContain('xxxxx');
    expect(surface(f)).not.toContain('LEAKED-REASON');
  });

  it('start proceeds to the transaction (and only the transaction) when the body is valid', async () => {
    await fail(service.startRegistration('acc-1'));
    expect(calls).toEqual(['database.transaction']);
  });
});

// ====================================================================== future prerequisites
describe('UnavailablePrerequisites', () => {
  it('every future prerequisite is NOT_AVAILABLE for every account, with nothing else in the answer', async () => {
    for (const k of ['verification', 'subscription', 'profile', 'gigs'] as const) {
      expect(await UnavailablePrerequisites[k]('acc-1')).toEqual({ status: 'NOT_AVAILABLE' });
      expect(await UnavailablePrerequisites[k]('acc-2')).toEqual({ status: 'NOT_AVAILABLE' });
    }
    expect(Object.keys(UnavailablePrerequisites).sort()).toEqual(['gigs', 'profile', 'subscription', 'verification']);
  });
});

describe('the ProviderError type', () => {
  it('is an Error with a name, a code and details that default to empty', () => {
    const e = new ProviderError('CONFLICT', 'msg');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProviderError');
    expect(e.details).toEqual({});
    expect(e.code).toBe('CONFLICT');
  });
});
