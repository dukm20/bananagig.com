// Unit tests of the provider registration contracts (PRO-001), written by an independent author: the registration status machine (all 9 pairs, equal to the migration guard), the
// vocabularies (steps, step statuses, role states) and the REGISTRATION/FUTURE partition of the onboarding steps, every managed content key helper (equal to the keys migration 0018
// seeds, in BOTH directions), the registration policy (strict, bounds, min <= max, unique statuses), every strict request, the read models (nothing personal), the events and the
// error code list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOG_CODE_MAX } from './catalog';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN } from './index';
import {
  CancelProviderRegistrationRequest,
  FUTURE_STEPS,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_STATUSES,
  OnboardingStep,
  OnboardingStepDetailDto,
  OnboardingStepDto,
  OnboardingStepStatus,
  PROVIDER_ERROR_CODES,
  PROVIDER_EVENTS,
  PROVIDER_POLICY_KEYS,
  PROVIDER_REGISTRATION_STATUSES,
  PROVIDER_ROLE_STATES,
  PROVIDER_SERVICE_TYPES_CEILING,
  ProviderRegistrationCompletedPayload,
  ProviderRegistrationDto,
  ProviderRegistrationEventPayload,
  ProviderRegistrationPolicy,
  ProviderRegistrationStateDto,
  ProviderRegistrationStateResponse,
  ProviderRegistrationStatus,
  ProviderRequirementsDto,
  ProviderRequirementsQuery,
  ProviderRequirementsResponse,
  ProviderRoleState,
  REGISTRATION_STEPS,
  ReplaceProviderServicesRequest,
  SelectProviderMarketRequest,
  StartProviderRegistrationRequest,
  SubmitProviderRegistrationRequest,
  isProviderRegistrationTransitionAllowed,
  isStepSatisfied,
  providerErrorKey,
  providerRegistrationStatusKey,
  providerRoleStateKey,
  providerStepLabelKey,
  providerStepStatusKey,
  type ProviderErrorCode,
  type ProviderRegistrationStatus as RegistrationStatus,
} from './provider';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0018_provider_registration.sql', import.meta.url)), 'utf8');

const ok = (schema: z.ZodType, v: unknown): boolean => schema.safeParse(v).success;
const issuePaths = (schema: z.ZodType, v: unknown): string[] => {
  const r = schema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};
const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const defOf = (schema: unknown): { shape?: Record<string, unknown> } => (schema as { def: { shape?: Record<string, unknown> } }).def;
const shapeKeys = (schema: unknown): string[] => Object.keys(defOf(schema).shape ?? {}).sort();

const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const ISO = '2026-10-16T12:00:00.000Z';

/** Every managed content key the migration seeds, by family (the seed rows look like `(1, 'UI_LABEL', 'provider.registration.step.account.label', ...`). */
const seededKeys = [...migration.matchAll(/\(\d+,\s+'(?:UI_LABEL|PLAIN_TEXT)',\s+'(provider\.registration\.[a-z_.]+)'/g)].map((m) => m[1]!);
const seeded = (prefix: string): string[] => seededKeys.filter((k) => k.startsWith(`${prefix}.`)).sort();

const policy = (over: Record<string, unknown> = {}) => ({
  requireVerifiedEmail: true,
  requireVerifiedPhone: true,
  marketStatusesAllowed: ['ACTIVE'],
  minServiceTypes: 1,
  maxServiceTypes: 10,
  ...over,
});
const registration = (over: Record<string, unknown> = {}) => ({
  providerRegistrationId: UUID_A,
  attempt: 1,
  status: 'IN_PROGRESS',
  revision: 1,
  marketCode: null,
  serviceTypeCodes: [],
  createdAt: ISO,
  completedAt: null,
  cancelledAt: null,
  ...over,
});
const requirements = (over: Record<string, unknown> = {}) => ({
  providerRole: 'PENDING',
  registration: registration(),
  steps: ONBOARDING_STEPS.map((step) => ({
    step,
    status: 'NOT_STARTED',
    owner: 'PRO-001',
    labelKey: providerStepLabelKey(step),
    statusKey: providerStepStatusKey('NOT_STARTED'),
  })),
  overall: { registrationComplete: false, registrationReady: false, blockedBy: ['CONTACT'], goLive: { evaluated: false, eligible: false } },
  ...over,
});

// ====================================================================== status machine
describe('provider registration status machine', () => {
  it('has exactly IN_PROGRESS, COMPLETED, CANCELLED (no SUBMITTED: nothing could reach it)', () => {
    expect([...PROVIDER_REGISTRATION_STATUSES]).toEqual(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
    expect(ProviderRegistrationStatus.options).toEqual([...PROVIDER_REGISTRATION_STATUSES]);
    expect(ok(ProviderRegistrationStatus, 'SUBMITTED')).toBe(false);
    expect(ok(ProviderRegistrationStatus, 'in_progress')).toBe(false);
  });

  const EXPECTED: Record<string, boolean> = {
    'IN_PROGRESS>IN_PROGRESS': false,
    'IN_PROGRESS>COMPLETED': true,
    'IN_PROGRESS>CANCELLED': true,
    'COMPLETED>IN_PROGRESS': false,
    'COMPLETED>COMPLETED': false,
    'COMPLETED>CANCELLED': false,
    'CANCELLED>IN_PROGRESS': false,
    'CANCELLED>COMPLETED': false,
    'CANCELLED>CANCELLED': false,
  };
  it.each(Object.entries(EXPECTED))('%s is %s', (pair, allowed) => {
    const [from, to] = pair.split('>') as [RegistrationStatus, RegistrationStatus];
    expect(isProviderRegistrationTransitionAllowed(from, to)).toBe(allowed);
  });
  it('covers all 9 pairs exactly once', () => {
    const all = PROVIDER_REGISTRATION_STATUSES.flatMap((f) => PROVIDER_REGISTRATION_STATUSES.map((t) => `${f}>${t}`));
    expect(sorted(Object.keys(EXPECTED))).toEqual(sorted(all));
  });
  it('is the same machine as the migration guard and its CHECKs (statuses, terminal states, allowed targets)', () => {
    const m = /ck_registrations__status CHECK \(status IN \(([^)]*)\)\)/.exec(migration);
    expect(m, 'status CHECK').not.toBeNull();
    expect([...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])).toEqual([...PROVIDER_REGISTRATION_STATUSES]);
    expect(migration).toContain("IF NEW.status NOT IN ('COMPLETED', 'CANCELLED') THEN");
    expect(migration).toContain("IF OLD.status <> 'IN_PROGRESS' THEN");
    expect(migration).toContain('provider_rule:REGISTRATION_FROZEN');
  });
  it('the audit actions of the migration are the ones the service writes', () => {
    for (const a of [
      'PROVIDER_REGISTRATION_STARTED',
      'PROVIDER_MARKET_SELECTED',
      'PROVIDER_SERVICES_UPDATED',
      'PROVIDER_REGISTRATION_COMPLETED',
      'PROVIDER_REGISTRATION_CANCELLED',
    ])
      expect(migration, a).toContain(`'${a}'`);
  });
});

// ====================================================================== vocabularies
describe('vocabularies', () => {
  it('role states are NONE plus the three ID-001 membership statuses', () => {
    expect([...PROVIDER_ROLE_STATES]).toEqual(['NONE', 'PENDING', 'ACTIVE', 'INACTIVE']);
    expect(ProviderRoleState.options).toEqual([...PROVIDER_ROLE_STATES]);
    expect(ok(ProviderRoleState, 'SUSPENDED')).toBe(false);
  });
  it('onboarding steps are the nine of the design in order', () => {
    expect([...ONBOARDING_STEPS]).toEqual(['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES', 'VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']);
    expect(OnboardingStep.options).toEqual([...ONBOARDING_STEPS]);
  });
  it('step statuses are the six of the design in order', () => {
    expect([...ONBOARDING_STEP_STATUSES]).toEqual(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'NOT_AVAILABLE', 'NOT_REQUIRED']);
    expect(OnboardingStepStatus.options).toEqual([...ONBOARDING_STEP_STATUSES]);
  });
  it('REGISTRATION_STEPS and FUTURE_STEPS partition ONBOARDING_STEPS (disjoint, complete, in order, registration first)', () => {
    expect([...REGISTRATION_STEPS]).toEqual(['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES']);
    expect([...FUTURE_STEPS]).toEqual(['VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']);
    expect([...REGISTRATION_STEPS, ...FUTURE_STEPS]).toEqual([...ONBOARDING_STEPS]);
    expect(REGISTRATION_STEPS.filter((s) => (FUTURE_STEPS as readonly string[]).includes(s))).toEqual([]);
  });
  it.each([
    ['COMPLETE', true],
    ['NOT_REQUIRED', true],
    ['NOT_STARTED', false],
    ['IN_PROGRESS', false],
    ['BLOCKED', false],
    ['NOT_AVAILABLE', false],
  ] as const)('isStepSatisfied(%s) is %s', (status, expected) => {
    expect(isStepSatisfied(status)).toBe(expected);
  });
  it('isStepSatisfied is decided for every status of the vocabulary (a new status cannot slip in unclassified)', () => {
    expect(ONBOARDING_STEP_STATUSES.filter(isStepSatisfied)).toEqual(['COMPLETE', 'NOT_REQUIRED']);
  });
});

// ====================================================================== managed content keys
describe('managed content keys', () => {
  it('derive from the vocabulary in the documented shape', () => {
    expect(providerStepLabelKey('ACCOUNT')).toBe('provider.registration.step.account.label');
    expect(providerStepLabelKey('GIGS')).toBe('provider.registration.step.gigs.label');
    expect(providerStepStatusKey('NOT_STARTED')).toBe('provider.registration.step_status.not_started');
    expect(providerRegistrationStatusKey('IN_PROGRESS')).toBe('provider.registration.status.in_progress');
    expect(providerRoleStateKey('NONE')).toBe('provider.registration.role.none');
    expect(providerErrorKey('STALE_REGISTRATION')).toBe('provider.registration.error.stale_registration');
  });
  it('every key is a valid content key', () => {
    const all = [
      ...ONBOARDING_STEPS.map(providerStepLabelKey),
      ...ONBOARDING_STEP_STATUSES.map(providerStepStatusKey),
      ...PROVIDER_REGISTRATION_STATUSES.map(providerRegistrationStatusKey),
      ...PROVIDER_ROLE_STATES.map(providerRoleStateKey),
      ...PROVIDER_ERROR_CODES.map(providerErrorKey),
    ];
    for (const k of all) expect(ok(ContentKey, k), k).toBe(true);
    expect(new Set(all).size, 'no two helpers derive the same key').toBe(all.length);
  });

  it('the migration seeds the managed copy (the parse sees all of it)', () => {
    // 9 step labels + 6 step statuses + 3 statuses + 4 role states + 14 errors + 20 page copy rows = 56
    expect(seededKeys.length).toBe(56);
    expect(new Set(seededKeys).size).toBe(56);
  });
  it.each([
    ['provider.registration.step', ONBOARDING_STEPS.map(providerStepLabelKey)],
    ['provider.registration.step_status', ONBOARDING_STEP_STATUSES.map(providerStepStatusKey)],
    ['provider.registration.status', PROVIDER_REGISTRATION_STATUSES.map(providerRegistrationStatusKey)],
    ['provider.registration.role', PROVIDER_ROLE_STATES.map(providerRoleStateKey)],
    ['provider.registration.error', PROVIDER_ERROR_CODES.map(providerErrorKey)],
  ] as const)('the keys of %s.* are EXACTLY the keys the migration seeds, in both directions', (prefix, derived) => {
    expect(sorted(derived)).toEqual(seeded(prefix));
  });
  it('the page copy keys are not claimed by any helper family', () => {
    const page = seeded('provider.registration.page');
    expect(page.length).toBe(20);
    expect(page).toContain('provider.registration.page.title');
  });
  it('the seed has no unexpected family', () => {
    const families = new Set(seededKeys.map((k) => k.split('.')[2]!));
    expect(sorted([...families])).toEqual(['error', 'page', 'role', 'status', 'step', 'step_status']);
  });
});

// ====================================================================== policy
describe('policy keys and ProviderRegistrationPolicy', () => {
  it('the five keys equal the parameters the migration seeds with their data types', () => {
    const seededParams = [...migration.matchAll(/\(\d,\s+'(provider\.registration\.[a-z_]+)',\s+'([A-Z]+)'/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(sorted(seededParams)).toEqual(
      sorted([
        `${PROVIDER_POLICY_KEYS.requireVerifiedEmail}:BOOLEAN`,
        `${PROVIDER_POLICY_KEYS.requireVerifiedPhone}:BOOLEAN`,
        `${PROVIDER_POLICY_KEYS.marketStatusesAllowed}:JSON`,
        `${PROVIDER_POLICY_KEYS.minServiceTypes}:INTEGER`,
        `${PROVIDER_POLICY_KEYS.maxServiceTypes}:INTEGER`,
      ]),
    );
  });
  it('the seeded defaults (true, true, ["ACTIVE"], 1, 10) are a valid policy', () => {
    for (const v of ["'true'::jsonb", `'["ACTIVE"]'::jsonb`, "'1'::jsonb", "'10'::jsonb"]) expect(migration, v).toContain(v);
    expect(ok(ProviderRegistrationPolicy, policy())).toBe(true);
  });
  it('the structural ceiling is the maximum of the seeded validation rules', () => {
    expect(PROVIDER_SERVICE_TYPES_CEILING).toBe(50);
    expect(migration).toContain('{"min": 0, "max": 50}');
    expect(migration).toContain('{"min": 1, "max": 50}');
  });
  it('accepts every legal combination of the allowed statuses and the bounds', () => {
    expect(ok(ProviderRegistrationPolicy, policy({ marketStatusesAllowed: ['PLANNED', 'ACTIVE', 'INACTIVE'] }))).toBe(true);
    expect(ok(ProviderRegistrationPolicy, policy({ marketStatusesAllowed: ['PLANNED'] }))).toBe(true);
    expect(ok(ProviderRegistrationPolicy, policy({ requireVerifiedEmail: false, requireVerifiedPhone: false }))).toBe(true);
    expect(ok(ProviderRegistrationPolicy, policy({ minServiceTypes: 0, maxServiceTypes: 1 }))).toBe(true);
    expect(ok(ProviderRegistrationPolicy, policy({ minServiceTypes: 5, maxServiceTypes: 5 }))).toBe(true);
    expect(ok(ProviderRegistrationPolicy, policy({ minServiceTypes: 50, maxServiceTypes: 50 }))).toBe(true);
  });
  it.each<[string, Record<string, unknown>]>([
    ['min above max', { minServiceTypes: 6, maxServiceTypes: 5 }],
    ['min 51', { minServiceTypes: 51, maxServiceTypes: 50 }],
    ['max 51', { maxServiceTypes: 51 }],
    ['max 0', { minServiceTypes: 0, maxServiceTypes: 0 }],
    ['negative min', { minServiceTypes: -1 }],
    ['fractional min', { minServiceTypes: 1.5 }],
    ['fractional max', { maxServiceTypes: 10.5 }],
    ['string min', { minServiceTypes: '1' }],
    ['NaN max', { maxServiceTypes: Number.NaN }],
    ['Infinity max', { maxServiceTypes: Number.POSITIVE_INFINITY }],
    ['null min', { minServiceTypes: null }],
    ['empty statuses', { marketStatusesAllowed: [] }],
    ['duplicate statuses', { marketStatusesAllowed: ['ACTIVE', 'ACTIVE'] }],
    ['unknown status', { marketStatusesAllowed: ['LIVE'] }],
    ['lower-case status', { marketStatusesAllowed: ['active'] }],
    ['four statuses', { marketStatusesAllowed: ['PLANNED', 'ACTIVE', 'INACTIVE', 'ACTIVE'] }],
    ['statuses not an array', { marketStatusesAllowed: 'ACTIVE' }],
    ['string email flag', { requireVerifiedEmail: 'true' }],
    ['number phone flag', { requireVerifiedPhone: 1 }],
    ['null email flag', { requireVerifiedEmail: null }],
    ['unknown key', { extra: true }],
    ['a go-live flag', { goLive: true }],
  ])('rejects %s', (_name, over) => {
    expect(ok(ProviderRegistrationPolicy, policy(over))).toBe(false);
  });
  it.each(['requireVerifiedEmail', 'requireVerifiedPhone', 'marketStatusesAllowed', 'minServiceTypes', 'maxServiceTypes'])(
    'rejects a policy without %s (no code default exists)',
    (k) => {
      const p: Record<string, unknown> = policy();
      delete p[k];
      expect(ok(ProviderRegistrationPolicy, p)).toBe(false);
    },
  );
  it.each([undefined, null, [], 'policy', 7, {}])('rejects %j as a policy', (v) => {
    expect(ok(ProviderRegistrationPolicy, v)).toBe(false);
  });
  it('reports the contradiction messages', () => {
    const r = ProviderRegistrationPolicy.safeParse(policy({ minServiceTypes: 6, maxServiceTypes: 5 }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain('min_service_types must not exceed max_service_types');
    const r2 = ProviderRegistrationPolicy.safeParse(policy({ marketStatusesAllowed: ['ACTIVE', 'ACTIVE'] }));
    expect(JSON.stringify(r2.error)).toContain('market statuses must be unique');
  });
});

// ====================================================================== requests
describe('requests are strict and carry no account, registration, role, status or completion flag', () => {
  describe('StartProviderRegistrationRequest', () => {
    it('is exactly the empty object', () => {
      expect(ok(StartProviderRegistrationRequest, {})).toBe(true);
      for (const v of [
        { accountId: UUID_A },
        { providerRegistrationId: UUID_A },
        { role: 'PROVIDER' },
        { status: 'COMPLETED' },
        { x: 1 },
        null,
        undefined,
        [],
        'x',
        1,
      ])
        expect(ok(StartProviderRegistrationRequest, v), JSON.stringify(v)).toBe(false);
    });
  });

  describe('SelectProviderMarketRequest', () => {
    it('accepts a market code with or without expectedRevision', () => {
      expect(ok(SelectProviderMarketRequest, { marketCode: 'us-sf' })).toBe(true);
      expect(ok(SelectProviderMarketRequest, { marketCode: 'us-sf', expectedRevision: 1 })).toBe(true);
      expect(ok(SelectProviderMarketRequest, { marketCode: 'a', expectedRevision: 2_147_483_647 })).toBe(true);
    });
    it('does not default expectedRevision (absent stays absent)', () => {
      expect(SelectProviderMarketRequest.parse({ marketCode: 'us-sf' })).toEqual({ marketCode: 'us-sf' });
    });
    it.each<[string, unknown]>([
      ['empty body', {}],
      ['no code', { expectedRevision: 1 }],
      ['empty code', { marketCode: '' }],
      ['upper case', { marketCode: 'US-SF' }],
      ['underscore', { marketCode: 'us_sf' }],
      ['trailing hyphen', { marketCode: 'us-' }],
      ['leading digit', { marketCode: '1us' }],
      ['space', { marketCode: 'us sf' }],
      ['61 characters', { marketCode: `a${'b'.repeat(60)}` }],
      ['trailing newline', { marketCode: 'us-sf\n' }],
      ['numeric', { marketCode: 7 }],
      ['null', { marketCode: null }],
      ['array', { marketCode: ['us-sf'] }],
      ['zero revision', { marketCode: 'us-sf', expectedRevision: 0 }],
      ['negative revision', { marketCode: 'us-sf', expectedRevision: -1 }],
      ['fractional revision', { marketCode: 'us-sf', expectedRevision: 1.5 }],
      ['revision over int4', { marketCode: 'us-sf', expectedRevision: 2_147_483_648 }],
      ['string revision', { marketCode: 'us-sf', expectedRevision: '1' }],
      ['null revision', { marketCode: 'us-sf', expectedRevision: null }],
      ['NaN revision', { marketCode: 'us-sf', expectedRevision: Number.NaN }],
      ['account id', { marketCode: 'us-sf', accountId: UUID_A }],
      ['registration id', { marketCode: 'us-sf', providerRegistrationId: UUID_A }],
      ['role', { marketCode: 'us-sf', role: 'PROVIDER' }],
      ['status', { marketCode: 'us-sf', status: 'COMPLETED' }],
      ['completed flag', { marketCode: 'us-sf', completed: true }],
      ['__proto__ key', JSON.parse('{"marketCode":"us-sf","__proto__":{"x":1}}')],
      ['array body', ['us-sf']],
      ['null body', null],
      ['string body', 'us-sf'],
    ])('rejects %s', (_n, v) => {
      expect(ok(SelectProviderMarketRequest, v)).toBe(false);
    });
  });

  describe('ReplaceProviderServicesRequest', () => {
    it('accepts a set, an empty set, and expectedRevision', () => {
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['car_detailing', 'regular_cleaning'] })).toBe(true);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: [] })).toBe(true);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['ab'], expectedRevision: 3 })).toBe(true);
    });
    it('accepts exactly 50 distinct codes and rejects 51', () => {
      const codes = Array.from({ length: 51 }, (_, i) => `service_${String(i).padStart(2, '0')}`);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: codes.slice(0, 50) })).toBe(true);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: codes })).toBe(false);
      expect(issuePaths(ReplaceProviderServicesRequest, { serviceTypeCodes: codes })).toEqual(['serviceTypeCodes']);
    });
    it('rejects a duplicate code (and names the field), also when it is the only violation', () => {
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['car_detailing', 'car_detailing'] })).toBe(false);
      expect(issuePaths(ReplaceProviderServicesRequest, { serviceTypeCodes: ['car_detailing', 'car_detailing'] })).toEqual(['serviceTypeCodes']);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['ab', 'cd', 'ab'] })).toBe(false);
    });
    it('treats codes that differ only by case or spacing as invalid codes, not as distinct ones', () => {
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['Car_Detailing'] })).toBe(false);
      expect(ok(ReplaceProviderServicesRequest, { serviceTypeCodes: ['car_detailing '] })).toBe(false);
    });
    it.each<[string, unknown]>([
      ['no list', {}],
      ['null list', { serviceTypeCodes: null }],
      ['string list', { serviceTypeCodes: 'car_detailing' }],
      ['object list', { serviceTypeCodes: { 0: 'car_detailing' } }],
      ['code too short', { serviceTypeCodes: ['a'] }],
      [`code ${CATALOG_CODE_MAX + 1} characters`, { serviceTypeCodes: [`a${'b'.repeat(CATALOG_CODE_MAX)}`] }],
      ['hyphen', { serviceTypeCodes: ['car-detailing'] }],
      ['double underscore', { serviceTypeCodes: ['car__detailing'] }],
      ['leading digit', { serviceTypeCodes: ['1car'] }],
      ['empty string', { serviceTypeCodes: [''] }],
      ['number', { serviceTypeCodes: [7] }],
      ['null item', { serviceTypeCodes: [null] }],
      ['nested array', { serviceTypeCodes: [['ab']] }],
      ['zero revision', { serviceTypeCodes: [], expectedRevision: 0 }],
      ['fractional revision', { serviceTypeCodes: [], expectedRevision: 1.2 }],
      ['revision over int4', { serviceTypeCodes: [], expectedRevision: 2_147_483_648 }],
      ['string revision', { serviceTypeCodes: [], expectedRevision: '2' }],
      ['market in the services body', { serviceTypeCodes: [], marketCode: 'us-sf' }],
      ['account id', { serviceTypeCodes: [], accountId: UUID_A }],
      ['registration id', { serviceTypeCodes: [], providerRegistrationId: UUID_A }],
      ['status', { serviceTypeCodes: [], status: 'COMPLETED' }],
      ['array body', [['ab']]],
      ['null body', null],
    ])('rejects %s', (_n, v) => {
      expect(ok(ReplaceProviderServicesRequest, v)).toBe(false);
    });
  });

  describe('SubmitProviderRegistrationRequest', () => {
    it('requires expectedRevision (a submit names the revision it read)', () => {
      expect(ok(SubmitProviderRegistrationRequest, { expectedRevision: 1 })).toBe(true);
      expect(ok(SubmitProviderRegistrationRequest, { expectedRevision: 2_147_483_647 })).toBe(true);
      expect(ok(SubmitProviderRegistrationRequest, {})).toBe(false);
      expect(issuePaths(SubmitProviderRegistrationRequest, {})).toEqual(['expectedRevision']);
    });
    it.each<[string, unknown]>([
      ['zero', { expectedRevision: 0 }],
      ['negative', { expectedRevision: -3 }],
      ['fractional', { expectedRevision: 1.5 }],
      ['over int4', { expectedRevision: 2_147_483_648 }],
      ['string', { expectedRevision: '1' }],
      ['null', { expectedRevision: null }],
      ['Infinity', { expectedRevision: Number.POSITIVE_INFINITY }],
      ['a completion flag', { expectedRevision: 1, completed: true }],
      ['a status', { expectedRevision: 1, status: 'COMPLETED' }],
      ['a role', { expectedRevision: 1, role: 'PROVIDER' }],
      ['an account id', { expectedRevision: 1, accountId: UUID_A }],
      ['an array', [1]],
      ['null body', null],
    ])('rejects %s', (_n, v) => {
      expect(ok(SubmitProviderRegistrationRequest, v)).toBe(false);
    });
  });

  describe('CancelProviderRegistrationRequest', () => {
    // cancelling takes NO input at all: free text would land in the immutable audit table
    it('accepts exactly the empty object', () => {
      expect(ok(CancelProviderRegistrationRequest, {})).toBe(true);
    });
    it('refuses a free-text reason of any kind: it would be stored in the immutable audit trail', () => {
      for (const reason of ['changed my mind', 'x'.repeat(1000), 'x'.repeat(1001), '', ' ', ch(0x200b), `a${ch(0)}b`, `moving ${ch(0xd83c, 0xdf4c)}`])
        expect(ok(CancelProviderRegistrationRequest, { reason }), JSON.stringify(reason)).toBe(false);
      const r = CancelProviderRegistrationRequest.safeParse({ reason: 'moving away' });
      expect(r.success).toBe(false);
      // the schema itself must not know a `reason` field (a regression to an optional field would pass a strict check)
      expect(Object.keys(CancelProviderRegistrationRequest.shape)).toEqual([]);
    });
    it.each<[string, unknown]>([
      ['a number reason', { reason: 7 }],
      ['a null reason', { reason: null }],
      ['an undefined reason key', { reason: undefined }],
      ['an array reason', { reason: ['x'] }],
      ['an account id', { accountId: UUID_A }],
      ['an unknown key', { why: 'x' }],
      ['a status', { status: 'CANCELLED' }],
      ['an array body', []],
      ['a string body', 'x'],
      ['a null body', null],
    ])('rejects %s', (_n, v) => {
      expect(ok(CancelProviderRegistrationRequest, v)).toBe(false);
    });
  });

  describe('ProviderRequirementsQuery', () => {
    it('accepts nothing, or a locale of 2..35 characters', () => {
      expect(ok(ProviderRequirementsQuery, {})).toBe(true);
      expect(ok(ProviderRequirementsQuery, { locale: 'en-US' })).toBe(true);
      expect(ok(ProviderRequirementsQuery, { locale: 'en' })).toBe(true);
      expect(ok(ProviderRequirementsQuery, { locale: 'x'.repeat(35) })).toBe(true);
    });
    it.each<[string, unknown]>([
      ['one character', { locale: 'e' }],
      ['36 characters', { locale: 'x'.repeat(36) }],
      ['an array (a repeated parameter)', { locale: ['en-US', 'es-US'] }],
      ['a number', { locale: 7 }],
      ['an unknown parameter', { locale: 'en-US', accountId: UUID_A }],
      ['only an unknown parameter', { role: 'PROVIDER' }],
    ])('rejects %s', (_n, v) => {
      expect(ok(ProviderRequirementsQuery, v)).toBe(false);
    });
  });
});

// ====================================================================== read models
describe('read models', () => {
  it('the registration DTO has exactly the nine documented keys (no account id, contact, name or text)', () => {
    expect(shapeKeys(ProviderRegistrationDto)).toEqual(
      ['attempt', 'cancelledAt', 'completedAt', 'createdAt', 'marketCode', 'providerRegistrationId', 'revision', 'serviceTypeCodes', 'status'].sort(),
    );
    expect(shapeKeys(ProviderRegistrationStateDto)).toEqual(['providerRole', 'registration']);
    expect(shapeKeys(OnboardingStepDto)).toEqual(['detail', 'labelKey', 'owner', 'status', 'statusKey', 'step']);
    expect(shapeKeys(ProviderRequirementsDto)).toEqual(['overall', 'providerRole', 'registration', 'steps']);
    expect(shapeKeys(OnboardingStepDetailDto)).toEqual(['email', 'marketCode', 'max', 'min', 'notOffered', 'outstandingPurposes', 'phone', 'selected']);
    const forbidden = /account|email address|phone number|name|address|body|text|token|subject|document/i;
    for (const k of [
      ...shapeKeys(ProviderRegistrationDto),
      ...shapeKeys(ProviderRegistrationStateDto),
      ...shapeKeys(OnboardingStepDto),
      ...shapeKeys(ProviderRequirementsDto),
    ])
      expect(k, k).not.toMatch(forbidden);
  });
  it('accepts the shapes the mappers produce', () => {
    expect(ok(ProviderRegistrationDto, registration())).toBe(true);
    expect(
      ok(
        ProviderRegistrationDto,
        registration({ status: 'COMPLETED', marketCode: 'us-sf', serviceTypeCodes: ['car_detailing'], completedAt: ISO, revision: 4, attempt: 2 }),
      ),
    ).toBe(true);
    expect(ok(ProviderRegistrationStateDto, { providerRole: 'NONE', registration: null })).toBe(true);
    expect(ok(ProviderRegistrationStateDto, { providerRole: 'PENDING', registration: registration() })).toBe(true);
    expect(ok(ProviderRequirementsDto, requirements())).toBe(true);
    expect(ok(ProviderRequirementsDto, requirements({ registration: null, providerRole: 'NONE' }))).toBe(true);
  });
  it('rejects an invalid vocabulary value anywhere', () => {
    expect(ok(ProviderRegistrationDto, registration({ status: 'SUBMITTED' }))).toBe(false);
    expect(ok(ProviderRegistrationStateDto, { providerRole: 'SUSPENDED', registration: null })).toBe(false);
    expect(ok(ProviderRegistrationStateDto, { providerRole: 'NONE' })).toBe(false);
    expect(ok(OnboardingStepDto, { step: 'ACCOUNT', status: 'DONE', owner: 'x', labelKey: 'a.b', statusKey: 'a.b' })).toBe(false);
    expect(ok(OnboardingStepDto, { step: 'PAYOUTS', status: 'COMPLETE', owner: 'x', labelKey: 'a.b', statusKey: 'a.b' })).toBe(false);
    expect(ok(ProviderRegistrationDto, registration({ attempt: 1.5 }))).toBe(false);
    expect(ok(ProviderRegistrationDto, registration({ serviceTypeCodes: 'a' }))).toBe(false);
    expect(ok(ProviderRegistrationDto, registration({ marketCode: undefined }))).toBe(false);
  });
  it('the step detail is strict: an email address or any other extra key is rejected', () => {
    expect(
      ok(OnboardingStepDetailDto, {
        email: 'VERIFIED',
        phone: 'NOT_REQUIRED',
        selected: 1,
        min: 1,
        max: 10,
        notOffered: ['a'],
        outstandingPurposes: ['TERMS_OF_SERVICE'],
        marketCode: 'us-sf',
      }),
    ).toBe(true);
    expect(ok(OnboardingStepDetailDto, {})).toBe(true);
    expect(ok(OnboardingStepDetailDto, { emailAddress: 'a@example.test' })).toBe(false);
    expect(ok(OnboardingStepDetailDto, { email: 'a@example.test' })).toBe(false);
    expect(ok(OnboardingStepDetailDto, { phone: 'MAYBE' })).toBe(false);
    expect(ok(OnboardingStepDetailDto, { selected: 1.5 })).toBe(false);
  });
  it('the registration DTO strips unknown keys instead of passing them on (the response serializer drops them too)', () => {
    const parsed = ProviderRegistrationDto.parse({ ...registration(), accountId: UUID_A, email: 'a@example.test' });
    expect(Object.keys(parsed).sort()).toEqual(shapeKeys(ProviderRegistrationDto));
  });
  it('Go-Live is never evaluated and never eligible: the literal false is the only accepted value', () => {
    const base = requirements();
    for (const goLive of [
      { evaluated: true, eligible: false },
      { evaluated: false, eligible: true },
      { evaluated: true, eligible: true },
      { evaluated: 'false', eligible: false },
      { evaluated: false },
      {},
      null,
    ])
      expect(ok(ProviderRequirementsDto, { ...base, overall: { ...base.overall, goLive } }), JSON.stringify(goLive)).toBe(false);
  });
  it('blockedBy only accepts onboarding steps', () => {
    const base = requirements();
    expect(ok(ProviderRequirementsDto, { ...base, overall: { ...base.overall, blockedBy: ['MARKET', 'SERVICES'] } })).toBe(true);
    expect(ok(ProviderRequirementsDto, { ...base, overall: { ...base.overall, blockedBy: ['PAYOUTS'] } })).toBe(false);
  });
  it('the response envelopes require the correlation id', () => {
    expect(ok(ProviderRegistrationStateResponse, { data: { providerRole: 'NONE', registration: null }, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(ProviderRegistrationStateResponse, { data: { providerRole: 'NONE', registration: null } })).toBe(false);
    expect(ok(ProviderRequirementsResponse, { data: requirements(), meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(ProviderRequirementsResponse, { data: requirements() })).toBe(false);
  });
});

// ====================================================================== events
describe('events', () => {
  it('are exactly three, versioned, in the provider domain', () => {
    expect(PROVIDER_EVENTS).toEqual({
      registrationStarted: 'bananagig.provider.registration-started.v1',
      registrationCompleted: 'bananagig.provider.registration-completed.v1',
      registrationCancelled: 'bananagig.provider.registration-cancelled.v1',
    });
    for (const t of Object.values(PROVIDER_EVENTS)) expect(t).toMatch(EVENT_TYPE_PATTERN);
  });
  it('the payloads carry identifiers (and codes on completion) only', () => {
    const base = { accountId: UUID_A, providerRegistrationId: UUID_A, attempt: 1 };
    expect(ok(ProviderRegistrationEventPayload, base)).toBe(true);
    expect(ok(ProviderRegistrationEventPayload, { ...base, attempt: 1.5 })).toBe(false);
    expect(ok(ProviderRegistrationEventPayload, { accountId: UUID_A, providerRegistrationId: UUID_A })).toBe(false);
    expect(shapeKeys(ProviderRegistrationEventPayload)).toEqual(['accountId', 'attempt', 'providerRegistrationId']);
    expect(shapeKeys(ProviderRegistrationCompletedPayload)).toEqual(['accountId', 'attempt', 'marketCode', 'providerRegistrationId', 'serviceTypeCodes']);
    expect(ok(ProviderRegistrationCompletedPayload, { ...base, marketCode: 'us-sf', serviceTypeCodes: ['car_detailing'] })).toBe(true);
    expect(ok(ProviderRegistrationCompletedPayload, base)).toBe(false);
    expect(ok(ProviderRegistrationCompletedPayload, { ...base, marketCode: 'us-sf' })).toBe(false);
    expect(ok(ProviderRegistrationCompletedPayload, { ...base, serviceTypeCodes: [] })).toBe(false);
  });
});

// ====================================================================== errors
describe('PROVIDER_ERROR_CODES', () => {
  it('is exactly the documented list, in order, without duplicates', () => {
    expect([...PROVIDER_ERROR_CODES]).toEqual([
      'REGISTRATION_NOT_FOUND',
      'REGISTRATION_NOT_IN_PROGRESS',
      'ROLE_INACTIVE',
      'ACCOUNT_NOT_ACTIVE',
      'PREREQUISITE_NOT_MET',
      'MARKET_NOT_ELIGIBLE',
      'MARKET_REQUIRED',
      'SERVICE_TYPE_NOT_ELIGIBLE',
      'SERVICE_COUNT_OUT_OF_RANGE',
      'REGISTRATION_INCOMPLETE',
      'STALE_REGISTRATION',
      'VALIDATION_FAILED',
      'CONFLICT',
      'UNAVAILABLE',
    ]);
    expect(new Set(PROVIDER_ERROR_CODES).size).toBe(PROVIDER_ERROR_CODES.length);
  });
  it('every code is upper snake case and derives a distinct key', () => {
    for (const c of PROVIDER_ERROR_CODES as readonly ProviderErrorCode[]) {
      expect(c).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
      expect(providerErrorKey(c)).toBe(`provider.registration.error.${c.toLowerCase()}`);
    }
  });
});
