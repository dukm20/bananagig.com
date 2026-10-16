// Unit tests of the consent contracts (ID-005): the vocabularies (values AND order), the purpose code pattern, the outstanding predicate, the content-key and
// configuration-key helpers (every produced key must be valid and must exist in migration 0013), the strict request bodies (nothing is coerced, nothing unknown is
// accepted), the read models and operation results (no legal text, address, token or account data can ride along), the identity events (identifiers only) and the parity
// with migration 0013 (audit action CHECK, vocabulary CHECKs, purpose code pattern, configuration enum, seeded copy keys).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateParameterRequest } from './configuration';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN } from './index';
import {
  AcceptConsentRequest,
  AcceptConsentResponse,
  AcceptConsentResultDto,
  AccountConsentsDto,
  AccountConsentsResponse,
  CONSENT_ACCEPTANCE_STATES,
  CONSENT_ERROR_CODES,
  CONSENT_EVENTS,
  CONSENT_EVENT_TYPES,
  CONSENT_HISTORY_LIMIT,
  CONSENT_PURPOSE_STATUSES,
  CONSENT_REQUIREMENT_STATUSES,
  CONSENT_SOURCES,
  ConsentAcceptanceState,
  ConsentCurrentDto,
  ConsentDocumentDto,
  ConsentEventDto,
  ConsentEventPayload,
  ConsentEventType,
  ConsentPurposeCode,
  ConsentPurposeParam,
  ConsentRequirementDto,
  ConsentRequirementStatus,
  ConsentRequirementsDto,
  ConsentRequirementsQuery,
  ConsentRequirementsResponse,
  ConsentSource,
  ConsentVersionRefDto,
  LEGAL_ENTRY_KEYS,
  PURPOSE_CODE_PATTERN,
  REACCEPTANCE_MODES,
  ReacceptanceMode,
  SEEDED_CONSENT_PURPOSES,
  SHA256_HEX_PATTERN,
  WITHDRAWAL_POLICIES,
  WithdrawConsentRequest,
  WithdrawConsentResponse,
  WithdrawConsentResultDto,
  WithdrawalPolicy,
  consentEventLabelKey,
  consentErrorMessageKey,
  consentPurposeLabelKey,
  consentReacceptanceKey,
  consentRequiredForKey,
  consentStateLabelKey,
  consentStatusLabelKey,
  isOutstandingStatus,
  type ConsentErrorCode,
} from './consent';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0013_consent.sql', import.meta.url)), 'utf8');

// ---------------------------------------------------------------- zod shape walker (same technique as security.test.ts and phone.test.ts)
type Entry = { path: string; key: string; type: string };
type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown; catchall?: { def: { type: string } } };
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;
function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  if ((def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) return unwrap(def.innerType);
  return schema;
}
function walk(schema: unknown, prefix = ''): Entry[] {
  const def = defOf(schema);
  if (def.type === 'object' && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const inner = unwrap(child);
      return [{ path, key, type: defOf(inner).type }, ...walk(inner, path)];
    });
  }
  if (def.type === 'array' && def.element) return walk(def.element, `${prefix}[]`);
  return [];
}
const keysOf = (schema: unknown): string[] => walk(schema).map((e) => e.key);
const shapeKeys = (schema: unknown): string[] => Object.keys(defOf(schema).shape ?? {});
const without = (o: object, k: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...o };
  delete copy[k];
  return copy;
};

// ---------------------------------------------------------------- fixtures
const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const UUID_B = '9b2f6d0e-5c1a-4e0b-8a77-0d3c5f9a1e21';
const ISO = '2026-10-16T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const META = { correlationId: 'corr-1' };
const wrap = (data: unknown) => ({ data, meta: META });

const versionRef = { versionId: UUID_A, version: 3, locale: 'en-US', bodySha256: HASH };
const eventDto = {
  consentEventId: UUID_B,
  purposeCode: 'TERMS_OF_SERVICE',
  eventType: 'ACCEPTED',
  eventSeq: 1,
  document: versionRef,
  occurredAt: ISO,
  source: 'ACCOUNT_API',
};
const currentDto = {
  purposeCode: 'TERMS_OF_SERVICE',
  labelContentKey: 'account.consent.purpose.terms_of_service',
  state: 'ACCEPTED',
  withdrawable: false,
  latest: eventDto,
};
const currentNever = { ...currentDto, state: 'NONE', latest: null };
const accountConsents = { current: [currentDto, currentNever], history: [eventDto] };
const documentDto = { entryKey: 'legal.terms_of_service', versionId: UUID_A, version: 3, locale: 'en-US', bodySha256: HASH, effectiveFrom: ISO };
const requirementDto = {
  purposeCode: 'TERMS_OF_SERVICE',
  labelContentKey: 'account.consent.purpose.terms_of_service',
  required: true,
  status: 'SATISFIED',
  acceptanceState: 'ACCEPTED',
  withdrawable: false,
  reacceptance: 'REACCEPT_REQUIRED',
  document: documentDto,
  accepted: eventDto,
};
const requirementUnavailable = { ...requirementDto, status: 'DOCUMENT_UNAVAILABLE', acceptanceState: 'NONE', document: null, accepted: null };
const requirementsDto = { locale: 'en-US', requirements: [requirementDto, requirementUnavailable], satisfied: false, outstanding: ['PRIVACY_POLICY'] };
const acceptResult = { changed: true, event: eventDto };
const withdrawResult = { changed: false, event: { ...eventDto, eventType: 'WITHDRAWN', eventSeq: 2 } };
const payload = { accountId: UUID_A, purposeCode: 'PRIVACY_POLICY', consentEventId: UUID_B, eventSeq: 2, contentVersionId: UUID_A };

// ====================================================================== vocabularies
describe('vocabularies (exact values and order)', () => {
  it.each([
    ['WITHDRAWAL_POLICIES', WITHDRAWAL_POLICIES, ['NOT_WITHDRAWABLE', 'WITHDRAWABLE']],
    ['CONSENT_PURPOSE_STATUSES', CONSENT_PURPOSE_STATUSES, ['ACTIVE', 'INACTIVE']],
    ['CONSENT_EVENT_TYPES', CONSENT_EVENT_TYPES, ['ACCEPTED', 'WITHDRAWN']],
    ['CONSENT_SOURCES', CONSENT_SOURCES, ['ACCOUNT_API']],
    ['REACCEPTANCE_MODES', REACCEPTANCE_MODES, ['NO_REACCEPT', 'REACCEPT_FOR_NEW_USERS_ONLY', 'REACCEPT_REQUIRED']],
    ['CONSENT_ACCEPTANCE_STATES', CONSENT_ACCEPTANCE_STATES, ['NONE', 'ACCEPTED', 'WITHDRAWN']],
    [
      'CONSENT_REQUIREMENT_STATUSES',
      CONSENT_REQUIREMENT_STATUSES,
      ['NOT_REQUIRED', 'SATISFIED', 'OUTSTANDING', 'REACCEPTANCE_REQUIRED', 'DOCUMENT_UNAVAILABLE'],
    ],
    ['SEEDED_CONSENT_PURPOSES', SEEDED_CONSENT_PURPOSES, ['TERMS_OF_SERVICE', 'PRIVACY_POLICY']],
    [
      'CONSENT_ERROR_CODES',
      CONSENT_ERROR_CODES,
      [
        'CONSENT_PURPOSE_NOT_FOUND',
        'CONSENT_PURPOSE_INACTIVE',
        'CONSENT_VERSION_NOT_FOUND',
        'CONSENT_VERSION_NOT_CURRENT',
        'CONSENT_LOCALE_MISMATCH',
        'CONSENT_HASH_MISMATCH',
        'CONSENT_NOT_WITHDRAWABLE',
        'CONSENT_NOT_ACCEPTED',
        'CONSENT_REQUIRED_FOR_ROLE',
        'CONSENT_REQUIRED',
      ],
    ],
  ] as const)('%s', (_name, actual, expected) => {
    expect([...actual]).toEqual([...expected]);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('has the documented sizes', () => {
    expect(WITHDRAWAL_POLICIES).toHaveLength(2);
    expect(CONSENT_PURPOSE_STATUSES).toHaveLength(2);
    expect(CONSENT_EVENT_TYPES).toHaveLength(2);
    expect(CONSENT_SOURCES).toHaveLength(1);
    expect(REACCEPTANCE_MODES).toHaveLength(3);
    expect(CONSENT_ACCEPTANCE_STATES).toHaveLength(3);
    expect(CONSENT_REQUIREMENT_STATUSES).toHaveLength(5);
    expect(SEEDED_CONSENT_PURPOSES).toHaveLength(2);
    expect(CONSENT_ERROR_CODES).toHaveLength(10);
  });

  it('every vocabulary value is upper snake case, and every error code carries the CONSENT_ prefix', () => {
    const all = [
      ...WITHDRAWAL_POLICIES,
      ...CONSENT_PURPOSE_STATUSES,
      ...CONSENT_EVENT_TYPES,
      ...CONSENT_SOURCES,
      ...REACCEPTANCE_MODES,
      ...CONSENT_ACCEPTANCE_STATES,
      ...CONSENT_REQUIREMENT_STATUSES,
      ...SEEDED_CONSENT_PURPOSES,
      ...CONSENT_ERROR_CODES,
    ];
    for (const v of all) expect(v).toMatch(/^[A-Z][A-Z_]*$/);
    for (const c of CONSENT_ERROR_CODES) expect(c.startsWith('CONSENT_')).toBe(true);
  });

  it('the seeded purposes are valid purpose codes', () => {
    for (const p of SEEDED_CONSENT_PURPOSES) {
      expect(PURPOSE_CODE_PATTERN.test(p), p).toBe(true);
      expect(ConsentPurposeCode.safeParse(p).success, p).toBe(true);
    }
  });

  it('REACCEPTANCE_MODES is ordered from the weakest to the strongest requirement', () => {
    expect(REACCEPTANCE_MODES[0]).toBe('NO_REACCEPT');
    expect(REACCEPTANCE_MODES[REACCEPTANCE_MODES.length - 1]).toBe('REACCEPT_REQUIRED');
    expect(REACCEPTANCE_MODES.indexOf('NO_REACCEPT')).toBeLessThan(REACCEPTANCE_MODES.indexOf('REACCEPT_FOR_NEW_USERS_ONLY'));
    expect(REACCEPTANCE_MODES.indexOf('REACCEPT_FOR_NEW_USERS_ONLY')).toBeLessThan(REACCEPTANCE_MODES.indexOf('REACCEPT_REQUIRED'));
  });

  it('LEGAL_ENTRY_KEYS maps every seeded purpose to its legal entry key and nothing else', () => {
    expect(LEGAL_ENTRY_KEYS).toEqual({ TERMS_OF_SERVICE: 'legal.terms_of_service', PRIVACY_POLICY: 'legal.privacy_policy' });
    expect(Object.keys(LEGAL_ENTRY_KEYS)).toEqual([...SEEDED_CONSENT_PURPOSES]);
    for (const k of Object.values(LEGAL_ENTRY_KEYS)) {
      expect(ContentKey.safeParse(k).success, k).toBe(true);
      expect(k.startsWith('legal.')).toBe(true);
    }
    expect(new Set(Object.values(LEGAL_ENTRY_KEYS)).size).toBe(2);
  });

  it('constants', () => {
    expect(CONSENT_HISTORY_LIMIT).toBe(200);
    expect(SHA256_HEX_PATTERN.source).toBe('^[0-9a-f]{64}$');
    expect(PURPOSE_CODE_PATTERN.source).toBe('^[A-Z][A-Z0-9_]{1,63}$');
    expect(PURPOSE_CODE_PATTERN.flags).toBe('');
    expect(SHA256_HEX_PATTERN.flags).toBe('');
  });

  it.each([
    ['WithdrawalPolicy', WithdrawalPolicy, WITHDRAWAL_POLICIES],
    ['ConsentEventType', ConsentEventType, CONSENT_EVENT_TYPES],
    ['ConsentSource', ConsentSource, CONSENT_SOURCES],
    ['ReacceptanceMode', ReacceptanceMode, REACCEPTANCE_MODES],
    ['ConsentAcceptanceState', ConsentAcceptanceState, CONSENT_ACCEPTANCE_STATES],
    ['ConsentRequirementStatus', ConsentRequirementStatus, CONSENT_REQUIREMENT_STATUSES],
  ] as const)('the %s schema accepts exactly its vocabulary', (_n, schema, values) => {
    for (const v of values) expect(schema.safeParse(v).success, v).toBe(true);
    const lowered = values.map((v) => v.toLowerCase());
    const mixed = values.map((v) => v[0] + v.slice(1).toLowerCase());
    const padded = values.flatMap((v) => [` ${v}`, `${v} `, `${v}\n`, `\t${v}`, `${v}\u00a0`, `${v}\u200b`]);
    for (const bad of ['', 'nope', ' ', ...lowered, ...mixed, ...padded, 1, 0, true, false, null, undefined, {}, [], ['ACCEPTED'], { value: 'ACCEPTED' }])
      expect(schema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('the schemas do not accept a value of a sibling vocabulary', () => {
    expect(ConsentEventType.safeParse('NONE').success).toBe(false);
    expect(ConsentAcceptanceState.safeParse('SATISFIED').success).toBe(false);
    expect(ConsentRequirementStatus.safeParse('ACCEPTED').success).toBe(false);
    expect(ConsentRequirementStatus.safeParse('WITHDRAWN').success).toBe(false);
    expect(ConsentSource.safeParse('API').success).toBe(false);
    expect(WithdrawalPolicy.safeParse('ACTIVE').success).toBe(false);
  });

  it('CONSENT_PURPOSE_STATUSES has no zod enum of its own (a plain vocabulary): it is exactly the migration CHECK', () => {
    expect([...CONSENT_PURPOSE_STATUSES]).toEqual(['ACTIVE', 'INACTIVE']);
  });
});

// ====================================================================== purpose code
describe('PURPOSE_CODE_PATTERN / ConsentPurposeCode', () => {
  it.each([
    'TERMS_OF_SERVICE',
    'PRIVACY_POLICY',
    'MARKETING_EMAIL',
    'AB',
    'A1',
    'A_',
    'A__',
    'Z9_9Z',
    `A${'B'.repeat(63)}`,
    `A${'_'.repeat(63)}`,
    `A${'0'.repeat(63)}`,
  ])('accepts %s', (code) => {
    expect(PURPOSE_CODE_PATTERN.test(code)).toBe(true);
    expect(ConsentPurposeCode.safeParse(code).success).toBe(true);
    expect(ConsentPurposeCode.parse(code)).toBe(code);
  });

  it('accepts exactly 2 and 64 characters, refuses 1 and 65', () => {
    expect(PURPOSE_CODE_PATTERN.test('A'.repeat(2))).toBe(true);
    expect(PURPOSE_CODE_PATTERN.test('A'.repeat(64))).toBe(true);
    expect(PURPOSE_CODE_PATTERN.test('A'.repeat(1))).toBe(false);
    expect(PURPOSE_CODE_PATTERN.test('A'.repeat(65))).toBe(false);
    expect(ConsentPurposeCode.safeParse('A').success).toBe(false);
    expect(ConsentPurposeCode.safeParse('A'.repeat(65)).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['lower case', 'terms_of_service'],
    ['mixed case', 'Terms_Of_Service'],
    ['one lower-case letter inside', 'TERMS_oF_SERVICE'],
    ['leading digit', '1TERMS'],
    ['leading underscore', '_TERMS'],
    ['single character', 'T'],
    ['single underscore', '_'],
    ['65 characters', 'A'.repeat(65)],
    ['dash', 'TERMS-OF-SERVICE'],
    ['space inside', 'TERMS OF_SERVICE'],
    ['leading space', ' TERMS'],
    ['trailing space', 'TERMS '],
    ['trailing newline', 'TERMS_OF_SERVICE\n'],
    ['leading newline', '\nTERMS_OF_SERVICE'],
    ['embedded newline', 'TERMS\nOF'],
    ['tab', 'TERMS\tOF'],
    ['dot', 'TERMS.OF'],
    ['slash', 'TERMS/OF'],
    ['colon', 'TERMS:OF'],
    ['null byte', 'TERMS\u0000'],
    ['cyrillic \u0415 lookalike', 'T\u0415RMS'],
    ['greek \u0391 lookalike', '\u0391BC'],
    ['fullwidth A', '\uff21BC'],
    ['fullwidth digit', 'A\uff11'],
    ['kelvin sign \u212a', 'A\u212a'],
    ['long s \u017f lookalike', 'TERM\u017f'],
    ['zero width space', 'TERMS\u200b'],
    ['accented', '\u00c9TAT'],
    ['emoji', 'TERMS\u{1F34C}'],
    ['sql wildcard', 'TERMS%'],
    ['path traversal', '../TERMS'],
  ])('refuses %s', (_n, code) => {
    expect(PURPOSE_CODE_PATTERN.test(code)).toBe(false);
    expect(ConsentPurposeCode.safeParse(code).success).toBe(false);
  });

  it('refuses non-strings (no coercion)', () => {
    for (const v of [1, null, undefined, true, ['TERMS_OF_SERVICE'], { code: 'TERMS_OF_SERVICE' }]) expect(ConsentPurposeCode.safeParse(v).success).toBe(false);
  });

  it('the pattern is not global or sticky, so it is safe to reuse (no lastIndex state)', () => {
    for (let i = 0; i < 4; i++) expect(PURPOSE_CODE_PATTERN.test('TERMS_OF_SERVICE')).toBe(true);
  });
});

// ====================================================================== isOutstandingStatus
describe('isOutstandingStatus', () => {
  it.each([
    ['NOT_REQUIRED', false],
    ['SATISFIED', false],
    ['OUTSTANDING', true],
    ['REACCEPTANCE_REQUIRED', true],
    ['DOCUMENT_UNAVAILABLE', true],
  ] as const)('%s is %s', (status, expected) => expect(isOutstandingStatus(status)).toBe(expected));

  it('covers every status exactly once and only the three unsatisfied ones are outstanding', () => {
    expect(CONSENT_REQUIREMENT_STATUSES.filter(isOutstandingStatus)).toEqual(['OUTSTANDING', 'REACCEPTANCE_REQUIRED', 'DOCUMENT_UNAVAILABLE']);
    expect(CONSENT_REQUIREMENT_STATUSES.filter((s) => !isOutstandingStatus(s))).toEqual(['NOT_REQUIRED', 'SATISFIED']);
  });
});

// ====================================================================== key helpers
describe('content-key and configuration-key helpers', () => {
  const configKey = CreateParameterRequest.shape.key;
  const labelCases: [string, readonly string[], (v: never) => string, string][] = [
    ['consentPurposeLabelKey', SEEDED_CONSENT_PURPOSES, consentPurposeLabelKey as (v: never) => string, 'account.consent.purpose.'],
    ['consentStatusLabelKey', CONSENT_REQUIREMENT_STATUSES, consentStatusLabelKey as (v: never) => string, 'account.consent.status.'],
    ['consentStateLabelKey', CONSENT_ACCEPTANCE_STATES, consentStateLabelKey as (v: never) => string, 'account.consent.state.'],
    ['consentEventLabelKey', CONSENT_EVENT_TYPES, consentEventLabelKey as (v: never) => string, 'account.consent.event.'],
  ];

  describe.each(labelCases)('%s', (_n, values, fn, prefix) => {
    it('produces prefix + lower-cased value, lower case, and a valid content key, for every value', () => {
      for (const v of values) {
        const key = fn(v as never);
        expect(key).toBe(`${prefix}${v.toLowerCase()}`);
        expect(key).toBe(key.toLowerCase());
        expect(ContentKey.safeParse(key).success, key).toBe(true);
      }
    });
  });

  it('consentErrorMessageKey strips the CONSENT_ prefix and lower-cases, for every code', () => {
    const expected: Record<ConsentErrorCode, string> = {
      CONSENT_PURPOSE_NOT_FOUND: 'account.consent.error.purpose_not_found',
      CONSENT_PURPOSE_INACTIVE: 'account.consent.error.purpose_inactive',
      CONSENT_VERSION_NOT_FOUND: 'account.consent.error.version_not_found',
      CONSENT_VERSION_NOT_CURRENT: 'account.consent.error.version_not_current',
      CONSENT_LOCALE_MISMATCH: 'account.consent.error.locale_mismatch',
      CONSENT_HASH_MISMATCH: 'account.consent.error.hash_mismatch',
      CONSENT_NOT_WITHDRAWABLE: 'account.consent.error.not_withdrawable',
      CONSENT_NOT_ACCEPTED: 'account.consent.error.not_accepted',
      CONSENT_REQUIRED_FOR_ROLE: 'account.consent.error.required_for_role',
      CONSENT_REQUIRED: 'account.consent.error.required',
    };
    expect(Object.keys(expected)).toEqual([...CONSENT_ERROR_CODES]);
    for (const c of CONSENT_ERROR_CODES) {
      const key = consentErrorMessageKey(c);
      expect(key).toBe(expected[c]);
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toContain('consent_');
      expect(ContentKey.safeParse(key).success, key).toBe(true);
    }
  });

  it('consentErrorMessageKey only strips a LEADING CONSENT_ (one occurrence)', () => {
    expect(consentErrorMessageKey('CONSENT_REQUIRED')).toBe('account.consent.error.required');
    expect(consentErrorMessageKey('CONSENT_REQUIRED_FOR_ROLE')).toBe('account.consent.error.required_for_role');
    // a code that has not been mapped keeps its text (the helper does not validate)
    expect(consentErrorMessageKey('NOT_A_CONSENT_CODE' as ConsentErrorCode)).toBe('account.consent.error.not_a_consent_code');
  });

  it.each(SEEDED_CONSENT_PURPOSES)('the configuration keys of %s are lower case and pass the configuration key validator', (code) => {
    for (const key of [consentRequiredForKey(code), consentReacceptanceKey(code)]) {
      expect(key).toBe(key.toLowerCase());
      expect(configKey.safeParse(key).success, key).toBe(true);
      expect(ContentKey.safeParse(key).success, key).toBe(true);
    }
    expect(consentRequiredForKey(code)).toBe(`consent.${code.toLowerCase()}.required_for`);
    expect(consentReacceptanceKey(code)).toBe(`consent.${code.toLowerCase()}.reacceptance`);
  });

  it('the exact configuration keys of the seeded purposes', () => {
    expect(consentRequiredForKey('TERMS_OF_SERVICE')).toBe('consent.terms_of_service.required_for');
    expect(consentReacceptanceKey('TERMS_OF_SERVICE')).toBe('consent.terms_of_service.reacceptance');
    expect(consentRequiredForKey('PRIVACY_POLICY')).toBe('consent.privacy_policy.required_for');
    expect(consentReacceptanceKey('PRIVACY_POLICY')).toBe('consent.privacy_policy.reacceptance');
    expect(consentPurposeLabelKey('PRIVACY_POLICY')).toBe('account.consent.purpose.privacy_policy');
  });

  it('every valid purpose code (shortest, longest, edge characters) yields valid content and configuration keys within their length limits', () => {
    for (const code of ['AB', 'A_', 'A0', `A${'Z'.repeat(63)}`, `A${'_'.repeat(63)}`, `A${'9'.repeat(63)}`, 'TERMS_OF_SERVICE']) {
      expect(PURPOSE_CODE_PATTERN.test(code), code).toBe(true);
      expect(ContentKey.safeParse(consentPurposeLabelKey(code)).success, code).toBe(true);
      expect(configKey.safeParse(consentRequiredForKey(code)).success, code).toBe(true);
      expect(configKey.safeParse(consentReacceptanceKey(code)).success, code).toBe(true);
    }
  });

  it('the helpers lower-case their input but do not validate it (callers must pass a ConsentPurposeCode)', () => {
    expect(consentPurposeLabelKey('Terms_Of_Service')).toBe('account.consent.purpose.terms_of_service');
    // a code outside the pattern can yield an invalid key: the guard is PURPOSE_CODE_PATTERN, applied at the boundary
    expect(ContentKey.safeParse(consentPurposeLabelKey('TERMS-OF-SERVICE')).success).toBe(false);
    expect(ContentKey.safeParse(consentPurposeLabelKey('1ABC')).success).toBe(false);
  });

  it('distinct purpose codes never collide (lower-casing is injective on the upper-case pattern)', () => {
    const codes = ['AB', 'A_', 'A_B', 'AB_', 'A_B_C', 'A1', 'TERMS_OF_SERVICE', 'PRIVACY_POLICY'];
    expect(new Set(codes.map(consentPurposeLabelKey)).size).toBe(codes.length);
    expect(new Set(codes.map(consentRequiredForKey)).size).toBe(codes.length);
  });

  it('no two helpers (or two values) produce the same key', () => {
    const all = [
      ...SEEDED_CONSENT_PURPOSES.map(consentPurposeLabelKey),
      ...CONSENT_REQUIREMENT_STATUSES.map(consentStatusLabelKey),
      ...CONSENT_ACCEPTANCE_STATES.map(consentStateLabelKey),
      ...CONSENT_EVENT_TYPES.map(consentEventLabelKey),
      ...CONSENT_ERROR_CODES.map(consentErrorMessageKey),
      ...SEEDED_CONSENT_PURPOSES.map(consentRequiredForKey),
      ...SEEDED_CONSENT_PURPOSES.map(consentReacceptanceKey),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(2 + 5 + 3 + 2 + 10 + 2 + 2);
  });

  it('the state and event helpers agree on the shared words but live in different namespaces', () => {
    expect(consentStateLabelKey('ACCEPTED')).toBe('account.consent.state.accepted');
    expect(consentEventLabelKey('ACCEPTED')).toBe('account.consent.event.accepted');
    expect(consentStateLabelKey('WITHDRAWN')).not.toBe(consentEventLabelKey('WITHDRAWN'));
  });

  it('the label key of a requirement in a DTO example is the helper output', () => {
    expect(requirementDto.labelContentKey).toBe(consentPurposeLabelKey(requirementDto.purposeCode));
    expect(currentDto.labelContentKey).toBe(consentPurposeLabelKey(currentDto.purposeCode));
  });
});

// ====================================================================== migration 0013 parity
describe('parity with migration 0013', () => {
  const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  const checkList = (constraint: string, column: string): string[] => {
    const re = new RegExp(`CONSTRAINT ${constraint} CHECK \\(${column} IN \\(([^)]*)\\)\\)`);
    const body = re.exec(migration)?.[1];
    expect(body, `${constraint} CHECK not found in the migration`).toBeDefined();
    return quoted(body ?? '');
  };

  describe('audit action CHECK', () => {
    const checkBody = /ADD CONSTRAINT ck_account_audit_events__action CHECK \(\s*action IN \(([^)]*)\)/.exec(migration)?.[1] ?? '';
    const actions = [...checkBody.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);

    it('parsed the CHECK list (37 older actions + 2 consent actions)', () => {
      expect(actions).toHaveLength(39);
      expect(new Set(actions).size).toBe(actions.length);
    });

    it('the consent actions are CONSENT_<event type> for every event type, in order, and are the last two', () => {
      expect(actions.slice(-2)).toEqual(CONSENT_EVENT_TYPES.map((t) => `CONSENT_${t}`));
      expect(actions.slice(-2)).toEqual(['CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN']);
    });

    it('the migration has no consent action the contract lacks, and vice versa', () => {
      const consentLike = actions.filter((a) => a.startsWith('CONSENT_'));
      expect([...consentLike].sort()).toEqual(CONSENT_EVENT_TYPES.map((t) => `CONSENT_${t}`).sort());
    });

    it('keeps the earlier security actions (the widening removes nothing)', () => {
      for (const a of ['ACCOUNT_CREATED', 'SESSION_CREATED', 'DEVICE_REMOVED', 'MFA_ENABLED', 'PASSWORD_RESET_COMPLETED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED'])
        expect(actions, a).toContain(a);
    });

    it('the audit consent_event_id column check ties exactly the CONSENT_ actions to an event', () => {
      expect(migration).toContain("CHECK ((action LIKE 'CONSENT\\_%') = (consent_event_id IS NOT NULL))");
    });
  });

  describe('vocabulary CHECK constraints', () => {
    it('event_type CHECK equals CONSENT_EVENT_TYPES (values and order)', () => {
      expect(checkList('ck_consent_events__event_type', 'event_type')).toEqual([...CONSENT_EVENT_TYPES]);
    });
    it('source CHECK equals CONSENT_SOURCES', () => {
      expect(checkList('ck_consent_events__source', 'source')).toEqual([...CONSENT_SOURCES]);
    });
    it('withdrawal_policy CHECK equals WITHDRAWAL_POLICIES', () => {
      expect(checkList('ck_consent_purposes__withdrawal_policy', 'withdrawal_policy')).toEqual([...WITHDRAWAL_POLICIES]);
    });
    it('purpose status CHECK equals CONSENT_PURPOSE_STATUSES', () => {
      expect(checkList('ck_consent_purposes__status', 'status')).toEqual([...CONSENT_PURPOSE_STATUSES]);
    });
    it('the column defaults are members of their vocabularies', () => {
      const status = /status\s+text\s+NOT NULL DEFAULT '([A-Z_]+)'/.exec(migration)?.[1];
      const source = /source\s+text\s+NOT NULL DEFAULT '([A-Z_]+)'/.exec(migration)?.[1];
      expect(CONSENT_PURPOSE_STATUSES as readonly string[]).toContain(status);
      expect(CONSENT_SOURCES as readonly string[]).toContain(source);
    });
    it('purpose_code CHECK is exactly PURPOSE_CODE_PATTERN', () => {
      const sql = /CONSTRAINT ck_consent_purposes__purpose_code CHECK \(purpose_code ~ '([^']*)'\)/.exec(migration)?.[1];
      expect(sql).toBe(PURPOSE_CODE_PATTERN.source);
    });
    it('body_sha256 CHECK is exactly SHA256_HEX_PATTERN', () => {
      const sql = /CONSTRAINT ck_consent_events__body_sha256 CHECK \(body_sha256 ~ '([^']*)'\)/.exec(migration)?.[1];
      expect(sql).toBe(SHA256_HEX_PATTERN.source);
    });
    it('the purpose code pattern accepts and refuses the same values as the SQL pattern does (same source, same engine semantics)', () => {
      const sql = new RegExp(/CHECK \(purpose_code ~ '([^']*)'\)/.exec(migration)?.[1] ?? '');
      for (const v of ['TERMS_OF_SERVICE', 'AB', 'A'.repeat(64), 'A', 'A'.repeat(65), 'terms', '1A', '_A', 'A-B'])
        expect(sql.test(v), v).toBe(PURPOSE_CODE_PATTERN.test(v));
    });
  });

  describe('configuration enum (reacceptance)', () => {
    const enumLists = [...migration.matchAll(/\{"enum": \[([^\]]*)\]\}/g)].map((m) => quoted((m[1] ?? '').replaceAll('"', "'")));

    it('one enum per seeded purpose, each equal to REACCEPTANCE_MODES (values and order)', () => {
      expect(enumLists).toHaveLength(SEEDED_CONSENT_PURPOSES.length);
      for (const list of enumLists) expect(list).toEqual([...REACCEPTANCE_MODES]);
    });

    it('the seeded default is a member of the vocabulary and is the strongest (conservative) mode', () => {
      const defaults = [...migration.matchAll(/'"(REACCEPT[A-Z_]*|NO_REACCEPT)"'::jsonb/g)].map((m) => m[1] as string);
      expect(defaults).toHaveLength(2);
      for (const d of defaults) {
        expect(REACCEPTANCE_MODES as readonly string[]).toContain(d);
        expect(ReacceptanceMode.safeParse(d).success).toBe(true);
        expect(d).toBe(REACCEPTANCE_MODES[REACCEPTANCE_MODES.length - 1]);
      }
    });

    it('the seeded parameter keys are exactly the keys the helpers produce for the seeded purposes', () => {
      const rows = [...migration.matchAll(/\(\d+, '(consent\.[a-z0-9_.]+)', '(JSON|ENUM)'/g)].map((m) => ({ key: m[1] as string, type: m[2] as string }));
      const expectedKeys = SEEDED_CONSENT_PURPOSES.flatMap((p) => [consentRequiredForKey(p), consentReacceptanceKey(p)]);
      expect(rows.map((r) => r.key).sort()).toEqual([...expectedKeys].sort());
      for (const r of rows) {
        expect(r.type).toBe(r.key.endsWith('.required_for') ? 'JSON' : 'ENUM');
        expect(CreateParameterRequest.shape.key.safeParse(r.key).success, r.key).toBe(true);
      }
    });

    it('the required_for role pattern in the migration accepts the application roles', () => {
      const pattern = /"pattern": "([^"]*)"/.exec(migration)?.[1] ?? '';
      const re = new RegExp(pattern);
      for (const role of ['CUSTOMER', 'PROVIDER']) expect(re.test(role), role).toBe(true);
    });
  });

  describe('seeded purposes and legal entries', () => {
    it('the purposes seeded are SEEDED_CONSENT_PURPOSES bound to LEGAL_ENTRY_KEYS', () => {
      const pairs = [...migration.matchAll(/\('([A-Z_]+)', '(legal\.[a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
      expect(pairs).toEqual(SEEDED_CONSENT_PURPOSES.map((p) => [p, LEGAL_ENTRY_KEYS[p]]));
    });
    it('the legal entry shells created are exactly the LEGAL_ENTRY_KEYS', () => {
      const keys = [...migration.matchAll(/\(\d, '(legal\.[a-z_]+)',/g)].map((m) => m[1]);
      expect(keys).toEqual(Object.values(LEGAL_ENTRY_KEYS));
    });
    it('both seeded purposes are NOT_WITHDRAWABLE and ACTIVE', () => {
      expect(migration).toContain("SELECT p.code, e.entry_id, 'NOT_WITHDRAWABLE', 'ACTIVE'");
      expect(WITHDRAWAL_POLICIES[0]).toBe('NOT_WITHDRAWABLE');
    });
  });

  describe('identity rules named by the guard triggers cover the error codes that come from the database', () => {
    const rules = new Set([...migration.matchAll(/identity_rule:([A-Z_]+)/g)].map((m) => m[1] as string));
    it.each([
      'CONSENT_PURPOSE_INACTIVE',
      'CONSENT_VERSION_NOT_FOUND',
      'CONSENT_VERSION_NOT_CURRENT',
      'CONSENT_NOT_WITHDRAWABLE',
      'CONSENT_NOT_ACCEPTED',
    ] as const)('the guard raises %s, which is a declared consent error code', (code) => {
      expect(rules.has(code), code).toBe(true);
      expect(CONSENT_ERROR_CODES as readonly string[]).toContain(code);
    });
  });

  describe('seeded copy keys (account.consent.*)', () => {
    const seededRows = [...migration.matchAll(/\(\d+,\s+'(UI_LABEL|PLAIN_TEXT)',\s+'(account\.consent\.[a-z0-9_.]+)'/g)].map((m) => m[2] as string);
    const seeded = new Set(seededRows);

    it('parsed 40 distinct keys, all valid content keys', () => {
      expect(seededRows).toHaveLength(40);
      expect(seeded.size).toBe(40);
      for (const k of seeded) expect(ContentKey.safeParse(k).success, k).toBe(true);
    });

    const helperKeys = [
      ...SEEDED_CONSENT_PURPOSES.map(consentPurposeLabelKey),
      ...CONSENT_REQUIREMENT_STATUSES.map(consentStatusLabelKey),
      ...CONSENT_ACCEPTANCE_STATES.map(consentStateLabelKey),
      ...CONSENT_EVENT_TYPES.map(consentEventLabelKey),
      ...CONSENT_ERROR_CODES.map(consentErrorMessageKey),
    ];

    it('every key produced by a helper exists in the migration', () => {
      for (const k of helperKeys) expect(seeded.has(k), k).toBe(true);
    });

    it('every migration key is produced by a helper or is one of the documented extras', () => {
      const documentedExtra = (k: string): boolean =>
        k === 'account.consent.error.unavailable' ||
        k === 'account.consent.title' ||
        k === 'account.consent.intro' ||
        k === 'account.consent.accepted_on' ||
        /^account\.consent\.(requirements|history|document|action|notice)\.[a-z_]+$/.test(k);
      const produced = new Set(helperKeys);
      for (const k of seeded) expect(produced.has(k) || documentedExtra(k), `${k} is neither helper-produced nor a documented extra`).toBe(true);
    });

    it('the namespaces that the helpers own are complete in the migration (no unowned purpose/status/state/event/error key)', () => {
      const produced = new Set(helperKeys);
      for (const k of seeded) {
        if (/^account\.consent\.(purpose|status|state|event)\./.test(k)) expect(produced.has(k), k).toBe(true);
        if (/^account\.consent\.error\./.test(k) && k !== 'account.consent.error.unavailable') expect(produced.has(k), k).toBe(true);
      }
    });

    it('the documented extras are exactly 18 keys and match the expected set', () => {
      const produced = new Set(helperKeys);
      const extras = [...seeded].filter((k) => !produced.has(k)).sort();
      expect(extras).toEqual(
        [
          'account.consent.accepted_on',
          'account.consent.action.accept',
          'account.consent.action.withdraw',
          'account.consent.document.locale',
          'account.consent.document.read',
          'account.consent.document.unavailable_note',
          'account.consent.document.version',
          'account.consent.error.unavailable',
          'account.consent.history.empty',
          'account.consent.history.title',
          'account.consent.intro',
          'account.consent.notice.accepted',
          'account.consent.notice.already_accepted',
          'account.consent.notice.withdrawn',
          'account.consent.requirements.all_done',
          'account.consent.requirements.outstanding_intro',
          'account.consent.requirements.title',
          'account.consent.title',
        ].sort(),
      );
      expect(helperKeys).toHaveLength(22);
      expect(extras).toHaveLength(18);
    });

    it('the unavailable error key is not a consent error code key (it covers every failure that is not one)', () => {
      expect(helperKeys).not.toContain('account.consent.error.unavailable');
      expect(CONSENT_ERROR_CODES.map((c) => c.toLowerCase())).not.toContain('consent_unavailable');
    });

    it('every seeded purpose has its label key in the migration', () => {
      for (const p of SEEDED_CONSENT_PURPOSES) expect(seeded.has(consentPurposeLabelKey(p)), p).toBe(true);
    });

    it('the typed variables of the copy are declared once each (version COUNT, locale STRING, date STRING)', () => {
      expect(migration).toContain('"name": "version", "type": "COUNT"');
      expect(migration).toContain('"name": "locale", "type": "STRING"');
      expect(migration).toContain('"name": "date", "type": "STRING"');
    });
  });
});

// ====================================================================== AcceptConsentRequest
describe('AcceptConsentRequest', () => {
  const ok = { versionId: UUID_A, locale: 'en-US', bodySha256: HASH };

  it('accepts a valid body and returns exactly its fields', () => {
    expect(AcceptConsentRequest.parse(ok)).toEqual(ok);
    expect(Object.keys(AcceptConsentRequest.parse(ok)).sort()).toEqual(['bodySha256', 'locale', 'versionId']);
  });

  it('has exactly the three fields and is strict (catchall never)', () => {
    expect(shapeKeys(AcceptConsentRequest).sort()).toEqual(['bodySha256', 'locale', 'versionId']);
    expect(defOf(AcceptConsentRequest).catchall?.def.type).toBe('never');
  });

  describe('versionId', () => {
    it('accepts a lower-case uuid', () => expect(AcceptConsentRequest.safeParse({ ...ok, versionId: UUID_B }).success).toBe(true));
    it('accepts an upper-case uuid and does not normalise it (zod uuid is case-insensitive)', () => {
      const upper = UUID_A.toUpperCase();
      expect(AcceptConsentRequest.parse({ ...ok, versionId: upper }).versionId).toBe(upper);
    });
    it('accepts the nil and max uuids (zod 4 special-cases them)', () => {
      expect(AcceptConsentRequest.safeParse({ ...ok, versionId: '00000000-0000-0000-0000-000000000000' }).success).toBe(true);
      expect(AcceptConsentRequest.safeParse({ ...ok, versionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }).success).toBe(true);
    });
    it.each([
      [''],
      ['abc'],
      [' '],
      [` ${UUID_A}`],
      [`${UUID_A} `],
      [`${UUID_A}\n`],
      [`{${UUID_A}}`],
      [UUID_A.replaceAll('-', '')],
      [`${UUID_A}0`],
      [UUID_A.slice(0, -1)],
      [UUID_A.replace('4', 'g')],
      ['123e4567-e89b-02d3-a456-426614174000'],
      [`urn:uuid:${UUID_A}`],
      [UUID_A.replace('a', '\u0430')],
      [1],
      [null],
      [undefined],
      [[UUID_A]],
      [{ id: UUID_A }],
      [true],
    ])('refuses %j', (versionId) => expect(AcceptConsentRequest.safeParse({ ...ok, versionId }).success).toBe(false));
    it('refuses a missing versionId', () => expect(AcceptConsentRequest.safeParse(without(ok, 'versionId')).success).toBe(false));
  });

  describe('locale (2 to 35 characters, not trimmed, not validated against a registry here)', () => {
    it('boundaries: 1 refused, 2 accepted, 35 accepted, 36 refused', () => {
      expect(AcceptConsentRequest.safeParse({ ...ok, locale: 'e' }).success).toBe(false);
      expect(AcceptConsentRequest.safeParse({ ...ok, locale: 'en' }).success).toBe(true);
      expect(AcceptConsentRequest.safeParse({ ...ok, locale: 'e'.repeat(35) }).success).toBe(true);
      expect(AcceptConsentRequest.safeParse({ ...ok, locale: 'e'.repeat(36) }).success).toBe(false);
    });
    it('refuses empty', () => expect(AcceptConsentRequest.safeParse({ ...ok, locale: '' }).success).toBe(false));
    it('accepts common tags', () => {
      for (const locale of ['en-US', 'en', 'pt-BR', 'zh-Hant-TW', 'es-419', 'sr-Latn-RS'])
        expect(AcceptConsentRequest.parse({ ...ok, locale }).locale).toBe(locale);
    });
    it('does not trim or case-fold (the service compares exactly): padded and lower-case values pass the schema unchanged', () => {
      expect(AcceptConsentRequest.parse({ ...ok, locale: ' en-US ' }).locale).toBe(' en-US ');
      expect(AcceptConsentRequest.parse({ ...ok, locale: 'en-us' }).locale).toBe('en-us');
    });
    it('refuses non-strings (no coercion)', () => {
      for (const locale of [12, null, undefined, true, ['en-US'], { tag: 'en-US' }])
        expect(AcceptConsentRequest.safeParse({ ...ok, locale }).success).toBe(false);
    });
    it('refuses a missing locale', () => expect(AcceptConsentRequest.safeParse(without(ok, 'locale')).success).toBe(false));
  });

  describe('bodySha256 (exactly 64 lower-case hex characters)', () => {
    it('accepts 64 lower-case hex characters, including all digits and a-f', () => {
      expect(AcceptConsentRequest.safeParse({ ...ok, bodySha256: '0123456789abcdef'.repeat(4) }).success).toBe(true);
      expect(AcceptConsentRequest.safeParse({ ...ok, bodySha256: '0'.repeat(64) }).success).toBe(true);
      expect(AcceptConsentRequest.safeParse({ ...ok, bodySha256: 'f'.repeat(64) }).success).toBe(true);
    });
    it('SHA256_HEX_PATTERN agrees', () => {
      expect(SHA256_HEX_PATTERN.test('a'.repeat(64))).toBe(true);
      expect(SHA256_HEX_PATTERN.test('a'.repeat(63))).toBe(false);
      expect(SHA256_HEX_PATTERN.test('a'.repeat(65))).toBe(false);
      expect(SHA256_HEX_PATTERN.test(`${'a'.repeat(64)}\n`)).toBe(false);
    });
    it.each([
      ['63 characters', 'a'.repeat(63)],
      ['65 characters', 'a'.repeat(65)],
      ['empty', ''],
      ['128 characters', 'a'.repeat(128)],
      ['upper case', 'A'.repeat(64)],
      ['one upper-case character', `${'a'.repeat(63)}A`],
      ['mixed case', `${'a'.repeat(32)}${'B'.repeat(32)}`],
      ['non-hex g', `${'a'.repeat(63)}g`],
      ['non-hex z at the start', `z${'a'.repeat(63)}`],
      ['0x prefix', `0x${'a'.repeat(62)}`],
      ['sha256: prefix', `sha256:${'a'.repeat(57)}`],
      ['leading space', ` ${'a'.repeat(63)}`],
      ['trailing space', `${'a'.repeat(63)} `],
      ['trailing newline', `${'a'.repeat(64)}\n`],
      ['trailing newline (63 hex + newline)', `${'a'.repeat(63)}\n`],
      ['leading newline', `\n${'a'.repeat(64)}`],
      ['inner space', `${'a'.repeat(32)} ${'a'.repeat(31)}`],
      ['tab', `${'a'.repeat(63)}\t`],
      ['inner dash', `${'a'.repeat(32)}-${'a'.repeat(31)}`],
      ['null byte', `${'a'.repeat(63)}\u0000`],
      ['fullwidth a', `${'a'.repeat(63)}\uff41`],
      ['cyrillic \u0430', `${'a'.repeat(63)}\u0430`],
      ['zero width space', `${'a'.repeat(63)}\u200b`],
      ['base64', `${'Q'.repeat(43)}=`],
    ])('refuses %s', (_n, bodySha256) => expect(AcceptConsentRequest.safeParse({ ...ok, bodySha256 }).success).toBe(false));
    it('refuses non-strings (no coercion)', () => {
      for (const bodySha256 of [1, null, undefined, true, [HASH], { h: HASH }, Buffer.from('aa', 'hex')])
        expect(AcceptConsentRequest.safeParse({ ...ok, bodySha256 }).success).toBe(false);
    });
    it('refuses a missing bodySha256', () => expect(AcceptConsentRequest.safeParse(without(ok, 'bodySha256')).success).toBe(false));
  });

  describe('unknown fields', () => {
    it.each([
      'accountId',
      'purpose',
      'purposeCode',
      'acceptedAt',
      'occurredAt',
      'ip',
      'legalText',
      'body',
      'text',
      'eventType',
      'source',
      'userAgent',
      'sessionId',
      'extra',
    ])('refuses the unknown field %s', (field) => {
      const r = AcceptConsentRequest.safeParse({ ...ok, [field]: 'x' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.code).toBe('unrecognized_keys');
    });
    it('refuses an unknown field even when its value is undefined or null', () => {
      expect(AcceptConsentRequest.safeParse({ ...ok, accountId: undefined }).success).toBe(false);
      expect(AcceptConsentRequest.safeParse({ ...ok, accountId: null }).success).toBe(false);
    });
    it('refuses prototype keys', () => {
      const base = `"versionId":"${UUID_A}","locale":"en-US","bodySha256":"${HASH}"`;
      expect(AcceptConsentRequest.safeParse(JSON.parse(`{${base},"__proto__":{"admin":true}}`)).success).toBe(false);
      expect(AcceptConsentRequest.safeParse(JSON.parse(`{${base},"constructor":{}}`)).success).toBe(false);
      expect(AcceptConsentRequest.safeParse(JSON.parse(`{${base},"prototype":{}}`)).success).toBe(false);
    });
    it('a polluted prototype does not satisfy a missing field', () => {
      expect(AcceptConsentRequest.safeParse(JSON.parse(`{"__proto__":{"versionId":"${UUID_A}","locale":"en-US","bodySha256":"${HASH}"}}`)).success).toBe(false);
    });
  });

  it('refuses non-objects', () => {
    for (const v of [null, undefined, 'x', 1, true, [], [ok], () => ok]) expect(AcceptConsentRequest.safeParse(v).success).toBe(false);
  });

  it('refuses an empty body', () => expect(AcceptConsentRequest.safeParse({}).success).toBe(false));

  it('reports every failing field at once', () => {
    const r = AcceptConsentRequest.safeParse({ versionId: 'x', locale: 'e', bodySha256: 'Z' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0]).sort()).toEqual(['bodySha256', 'locale', 'versionId']);
  });
});

// ====================================================================== WithdrawConsentRequest / params / query
describe('WithdrawConsentRequest', () => {
  it('accepts exactly the empty object', () => {
    expect(WithdrawConsentRequest.parse({})).toEqual({});
    expect(shapeKeys(WithdrawConsentRequest)).toEqual([]);
    expect(defOf(WithdrawConsentRequest).catchall?.def.type).toBe('never');
  });
  it.each(['versionId', 'locale', 'bodySha256', 'accountId', 'purpose', 'reason', 'extra', 'ip'])('refuses the field %s', (field) => {
    const r = WithdrawConsentRequest.safeParse({ [field]: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.code).toBe('unrecognized_keys');
  });
  it('refuses prototype keys and null/undefined-valued extras', () => {
    expect(WithdrawConsentRequest.safeParse(JSON.parse('{"__proto__":{"x":1}}')).success).toBe(false);
    expect(WithdrawConsentRequest.safeParse(JSON.parse('{"constructor":{}}')).success).toBe(false);
    expect(WithdrawConsentRequest.safeParse({ reason: undefined }).success).toBe(false);
    expect(WithdrawConsentRequest.safeParse({ reason: null }).success).toBe(false);
  });
  it('refuses non-objects', () => {
    for (const v of [null, undefined, 'x', '', 1, 0, true, [], [{}]]) expect(WithdrawConsentRequest.safeParse(v).success, String(v)).toBe(false);
  });
});

describe('ConsentPurposeParam', () => {
  it.each(SEEDED_CONSENT_PURPOSES)('accepts %s', (purpose) => expect(ConsentPurposeParam.parse({ purpose })).toEqual({ purpose }));
  it.each([['terms_of_service'], ['T'], ['A'.repeat(65)], [''], [' TERMS'], ['TERMS\n'], ['TERMS-OF'], [1], [null], [undefined], [['TERMS']], [{}]])(
    'refuses %j',
    (purpose) => {
      expect(ConsentPurposeParam.safeParse({ purpose }).success).toBe(false);
    },
  );
  it('refuses a missing purpose, another name and extra keys', () => {
    expect(ConsentPurposeParam.safeParse({}).success).toBe(false);
    expect(ConsentPurposeParam.safeParse({ purposeCode: 'TERMS_OF_SERVICE' }).success).toBe(false);
    expect(ConsentPurposeParam.safeParse({ purpose: 'TERMS_OF_SERVICE', extra: 1 }).success).toBe(false);
    expect(ConsentPurposeParam.safeParse({ purpose: 'TERMS_OF_SERVICE', accountId: UUID_A }).success).toBe(false);
  });
  it('is strict and has exactly one field', () => {
    expect(shapeKeys(ConsentPurposeParam)).toEqual(['purpose']);
    expect(defOf(ConsentPurposeParam).catchall?.def.type).toBe('never');
  });
});

describe('ConsentRequirementsQuery', () => {
  it('locale is optional', () => {
    expect(ConsentRequirementsQuery.parse({})).toEqual({});
    expect(ConsentRequirementsQuery.parse({ locale: undefined })).toEqual({});
    expect(ConsentRequirementsQuery.parse({ locale: 'en-US' })).toEqual({ locale: 'en-US' });
  });
  it('locale boundaries: 1 refused, 2 accepted, 35 accepted, 36 refused, empty refused', () => {
    expect(ConsentRequirementsQuery.safeParse({ locale: 'e' }).success).toBe(false);
    expect(ConsentRequirementsQuery.safeParse({ locale: 'en' }).success).toBe(true);
    expect(ConsentRequirementsQuery.safeParse({ locale: 'e'.repeat(35) }).success).toBe(true);
    expect(ConsentRequirementsQuery.safeParse({ locale: 'e'.repeat(36) }).success).toBe(false);
    expect(ConsentRequirementsQuery.safeParse({ locale: '' }).success).toBe(false);
  });
  it('refuses non-string locales (no coercion), including null', () => {
    for (const locale of [1, null, true, ['en-US'], { l: 'en' }]) expect(ConsentRequirementsQuery.safeParse({ locale }).success, String(locale)).toBe(false);
  });
  it('refuses unknown keys', () => {
    for (const k of ['accountId', 'purpose', 'lang', 'Locale', 'limit', 'extra'])
      expect(ConsentRequirementsQuery.safeParse({ [k]: 'x' }).success, k).toBe(false);
    expect(ConsentRequirementsQuery.safeParse({ locale: 'en-US', extra: 1 }).success).toBe(false);
    expect(ConsentRequirementsQuery.safeParse(JSON.parse('{"__proto__":{"locale":"en"}}')).success).toBe(false);
  });
  it('refuses non-objects', () => {
    for (const v of [null, undefined, 'x', 1, true, []]) expect(ConsentRequirementsQuery.safeParse(v).success).toBe(false);
  });
  it('is strict', () => expect(defOf(ConsentRequirementsQuery).catchall?.def.type).toBe('never'));
});

// ====================================================================== responses
describe('response schemas', () => {
  const cases: [string, z.ZodType, unknown][] = [
    ['AccountConsentsResponse', AccountConsentsResponse, accountConsents],
    ['ConsentRequirementsResponse', ConsentRequirementsResponse, requirementsDto],
    ['AcceptConsentResponse', AcceptConsentResponse, acceptResult],
    ['WithdrawConsentResponse', WithdrawConsentResponse, withdrawResult],
  ];

  describe.each(cases)('%s', (_n, schema, data) => {
    it('accepts a valid example', () => expect(schema.parse(wrap(data))).toEqual(wrap(data)));
    it('requires the envelope: data and meta.correlationId', () => {
      expect(schema.safeParse(data).success).toBe(false);
      expect(schema.safeParse({ data }).success).toBe(false);
      expect(schema.safeParse({ meta: META }).success).toBe(false);
      expect(schema.safeParse({ data, meta: {} }).success).toBe(false);
      expect(schema.safeParse({ data, meta: { correlationId: 1 } }).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
      expect(schema.safeParse(undefined).success).toBe(false);
    });
    it('strips (never returns) unknown top-level and data fields', () => {
      const out = schema.parse({ data: { ...(data as object), ip: '203.0.113.9', token: 't', legalText: 'x' }, meta: META, extra: 1 }) as Record<
        string,
        unknown
      >;
      expect(out).not.toHaveProperty('extra');
      expect(out.data).not.toHaveProperty('ip');
      expect(out.data).not.toHaveProperty('token');
      expect(out.data).not.toHaveProperty('legalText');
    });
  });

  describe('ConsentVersionRefDto', () => {
    it('accepts a valid example and returns exactly its fields', () => {
      expect(ConsentVersionRefDto.parse(versionRef)).toEqual(versionRef);
      expect(shapeKeys(ConsentVersionRefDto)).toEqual(['versionId', 'version', 'locale', 'bodySha256']);
    });
    it.each(['versionId', 'version', 'locale', 'bodySha256'])('%s is required and not nullable', (k) => {
      expect(ConsentVersionRefDto.safeParse(without(versionRef, k)).success).toBe(false);
      expect(ConsentVersionRefDto.safeParse({ ...versionRef, [k]: null }).success).toBe(false);
    });
    it('version must be an integer number', () => {
      for (const version of [1.5, '3', null, NaN, Infinity, true])
        expect(ConsentVersionRefDto.safeParse({ ...versionRef, version }).success, String(version)).toBe(false);
      expect(ConsentVersionRefDto.safeParse({ ...versionRef, version: 1 }).success).toBe(true);
    });
    it('the string fields are not shape-validated on the way out (a response model is trusted, a request is not): this is the real behaviour', () => {
      expect(ConsentVersionRefDto.safeParse({ ...versionRef, versionId: 'not-a-uuid', bodySha256: 'NOT-HEX', locale: 'x' }).success).toBe(true);
    });
    it('non-string identifiers are refused', () => {
      for (const v of [1, null, undefined, {}, []]) {
        expect(ConsentVersionRefDto.safeParse({ ...versionRef, versionId: v }).success).toBe(false);
        expect(ConsentVersionRefDto.safeParse({ ...versionRef, locale: v }).success).toBe(false);
        expect(ConsentVersionRefDto.safeParse({ ...versionRef, bodySha256: v }).success).toBe(false);
      }
    });
    it('extras (the legal text) are stripped', () => {
      expect(ConsentVersionRefDto.parse({ ...versionRef, body: '<p>Terms</p>', text: 'Terms', html: '<p/>' })).toEqual(versionRef);
    });
  });

  describe('ConsentEventDto', () => {
    it('accepts a valid example for every event type and source', () => {
      expect(ConsentEventDto.parse(eventDto)).toEqual(eventDto);
      for (const eventType of CONSENT_EVENT_TYPES) expect(ConsentEventDto.safeParse({ ...eventDto, eventType }).success, eventType).toBe(true);
      for (const source of CONSENT_SOURCES) expect(ConsentEventDto.safeParse({ ...eventDto, source }).success, source).toBe(true);
    });
    it('has exactly the documented fields', () => {
      expect(shapeKeys(ConsentEventDto)).toEqual(['consentEventId', 'purposeCode', 'eventType', 'eventSeq', 'document', 'occurredAt', 'source']);
    });
    it.each(['consentEventId', 'purposeCode', 'eventType', 'eventSeq', 'document', 'occurredAt', 'source'])('%s is required and not nullable', (k) => {
      expect(ConsentEventDto.safeParse(without(eventDto, k)).success).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, [k]: null }).success).toBe(false);
    });
    it('eventType and source are the vocabularies (case, whitespace, unknown values refused)', () => {
      for (const eventType of ['accepted', 'Accepted', 'NONE', 'REVOKED', ' ACCEPTED', '', 1])
        expect(ConsentEventDto.safeParse({ ...eventDto, eventType }).success, String(eventType)).toBe(false);
      for (const source of ['account_api', 'ADMIN', 'BACK_OFFICE', '', 1])
        expect(ConsentEventDto.safeParse({ ...eventDto, source }).success, String(source)).toBe(false);
    });
    it('eventSeq is an integer', () => {
      for (const eventSeq of [1.5, '1', NaN, Infinity, true])
        expect(ConsentEventDto.safeParse({ ...eventDto, eventSeq }).success, String(eventSeq)).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, eventSeq: 200 }).success).toBe(true);
    });
    it('occurredAt is a string, never a Date or a number', () => {
      expect(ConsentEventDto.safeParse({ ...eventDto, occurredAt: new Date() }).success).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, occurredAt: 1_760_000_000 }).success).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, occurredAt: null }).success).toBe(false);
    });
    it('the document is a version reference, never null and never partial', () => {
      expect(ConsentEventDto.safeParse({ ...eventDto, document: null }).success).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, document: { versionId: UUID_A } }).success).toBe(false);
      expect(ConsentEventDto.safeParse({ ...eventDto, document: 'text' }).success).toBe(false);
    });
    it('extras are stripped at the top level and inside the document', () => {
      const out = ConsentEventDto.parse({
        ...eventDto,
        accountId: UUID_A,
        ip: '1.2.3.4',
        correlationId: 'c',
        applicationSessionId: UUID_B,
        document: { ...versionRef, body: 'LEGAL TEXT', html: '<p>x</p>' },
      });
      expect(out).toEqual(eventDto);
      expect(Object.keys(out).sort()).toEqual(Object.keys(eventDto).sort());
      expect(Object.keys(out.document).sort()).toEqual(Object.keys(versionRef).sort());
    });
  });

  describe('ConsentCurrentDto', () => {
    it('accepts a valid example, and latest as null', () => {
      expect(ConsentCurrentDto.parse(currentDto)).toEqual(currentDto);
      expect(ConsentCurrentDto.parse(currentNever)).toEqual(currentNever);
    });
    it('latest is nullable but required', () => {
      expect(ConsentCurrentDto.safeParse(without(currentDto, 'latest')).success).toBe(false);
      expect(ConsentCurrentDto.safeParse({ ...currentDto, latest: null }).success).toBe(true);
      expect(ConsentCurrentDto.safeParse({ ...currentDto, latest: undefined }).success).toBe(false);
    });
    it.each(['purposeCode', 'labelContentKey', 'state', 'withdrawable'])('%s is required and not nullable', (k) => {
      expect(ConsentCurrentDto.safeParse(without(currentDto, k)).success).toBe(false);
      expect(ConsentCurrentDto.safeParse({ ...currentDto, [k]: null }).success).toBe(false);
    });
    it('state is the acceptance vocabulary', () => {
      for (const state of CONSENT_ACCEPTANCE_STATES) expect(ConsentCurrentDto.safeParse({ ...currentDto, state }).success, state).toBe(true);
      for (const state of ['accepted', 'SATISFIED', 'OUTSTANDING', '', null, 1])
        expect(ConsentCurrentDto.safeParse({ ...currentDto, state }).success, String(state)).toBe(false);
    });
    it('withdrawable is a boolean (no coercion)', () => {
      for (const withdrawable of ['true', 'false', 1, 0, 'yes'])
        expect(ConsentCurrentDto.safeParse({ ...currentDto, withdrawable }).success, String(withdrawable)).toBe(false);
    });
    it('a malformed latest event is refused', () => {
      expect(ConsentCurrentDto.safeParse({ ...currentDto, latest: {} }).success).toBe(false);
      expect(ConsentCurrentDto.safeParse({ ...currentDto, latest: { ...eventDto, eventType: 'x' } }).success).toBe(false);
    });
    it('does not enforce the cross-field rule state NONE <=> latest null (the service guarantees it; the schema is only a shape)', () => {
      expect(ConsentCurrentDto.safeParse({ ...currentDto, state: 'NONE' }).success).toBe(true);
    });
  });

  describe('AccountConsentsDto', () => {
    it('accepts empty lists and the example', () => {
      expect(AccountConsentsDto.parse({ current: [], history: [] })).toEqual({ current: [], history: [] });
      expect(AccountConsentsDto.parse(accountConsents)).toEqual(accountConsents);
    });
    it('both lists are required arrays', () => {
      expect(AccountConsentsDto.safeParse({ current: [] }).success).toBe(false);
      expect(AccountConsentsDto.safeParse({ history: [] }).success).toBe(false);
      expect(AccountConsentsDto.safeParse({ current: null, history: [] }).success).toBe(false);
      expect(AccountConsentsDto.safeParse({ current: currentDto, history: [] }).success).toBe(false);
      expect(AccountConsentsDto.safeParse({ current: [], history: eventDto }).success).toBe(false);
    });
    it('every element is validated', () => {
      expect(AccountConsentsDto.safeParse({ current: [{}], history: [] }).success).toBe(false);
      expect(AccountConsentsDto.safeParse({ current: [], history: [{ ...eventDto, eventType: 'NONE' }] }).success).toBe(false);
    });
    it('the schema does not itself cap the history (CONSENT_HISTORY_LIMIT is applied by the query): 201 events still parse', () => {
      expect(CONSENT_HISTORY_LIMIT).toBe(200);
      const history = Array.from({ length: CONSENT_HISTORY_LIMIT + 1 }, () => eventDto);
      expect(AccountConsentsDto.safeParse({ current: [], history }).success).toBe(true);
    });
  });

  describe('ConsentDocumentDto', () => {
    it('accepts a valid example and returns exactly its fields', () => {
      expect(ConsentDocumentDto.parse(documentDto)).toEqual(documentDto);
      expect(shapeKeys(ConsentDocumentDto)).toEqual(['entryKey', 'versionId', 'version', 'locale', 'bodySha256', 'effectiveFrom']);
    });
    it.each(['entryKey', 'versionId', 'version', 'locale', 'bodySha256', 'effectiveFrom'])('%s is required and not nullable', (k) => {
      expect(ConsentDocumentDto.safeParse(without(documentDto, k)).success).toBe(false);
      expect(ConsentDocumentDto.safeParse({ ...documentDto, [k]: null }).success).toBe(false);
    });
    it('effectiveFrom is a string; version an integer', () => {
      expect(ConsentDocumentDto.safeParse({ ...documentDto, effectiveFrom: new Date() }).success).toBe(false);
      expect(ConsentDocumentDto.safeParse({ ...documentDto, effectiveFrom: 0 }).success).toBe(false);
      expect(ConsentDocumentDto.safeParse({ ...documentDto, version: 2.5 }).success).toBe(false);
      expect(ConsentDocumentDto.safeParse({ ...documentDto, version: '2' }).success).toBe(false);
    });
    it('the legal text is stripped, never returned', () => {
      expect(ConsentDocumentDto.parse({ ...documentDto, body: 'LEGAL TEXT', text: 'x', html: '<p/>', effectiveTo: ISO })).toEqual(documentDto);
    });
  });

  describe('ConsentRequirementDto', () => {
    it('accepts a valid example with a document and an accepted event, and one with both null', () => {
      expect(ConsentRequirementDto.parse(requirementDto)).toEqual(requirementDto);
      expect(ConsentRequirementDto.parse(requirementUnavailable)).toEqual(requirementUnavailable);
    });
    it('has exactly the documented fields', () => {
      expect(shapeKeys(ConsentRequirementDto)).toEqual([
        'purposeCode',
        'labelContentKey',
        'required',
        'status',
        'acceptanceState',
        'withdrawable',
        'reacceptance',
        'document',
        'accepted',
      ]);
    });
    it.each(['document', 'accepted'])('%s is nullable but required (not optional)', (k) => {
      expect(ConsentRequirementDto.safeParse(without(requirementDto, k)).success).toBe(false);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, [k]: null }).success).toBe(true);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, [k]: undefined }).success).toBe(false);
    });
    it.each(['purposeCode', 'labelContentKey', 'required', 'status', 'acceptanceState', 'withdrawable', 'reacceptance'])(
      '%s is required and not nullable',
      (k) => {
        expect(ConsentRequirementDto.safeParse(without(requirementDto, k)).success).toBe(false);
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, [k]: null }).success).toBe(false);
      },
    );
    it('status accepts every requirement status and refuses everything else', () => {
      for (const status of CONSENT_REQUIREMENT_STATUSES) expect(ConsentRequirementDto.safeParse({ ...requirementDto, status }).success, status).toBe(true);
      for (const status of ['satisfied', 'ACCEPTED', 'NONE', 'PENDING', '', null, 0])
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, status }).success, String(status)).toBe(false);
    });
    it('acceptanceState accepts every acceptance state and refuses a requirement status', () => {
      for (const acceptanceState of CONSENT_ACCEPTANCE_STATES)
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, acceptanceState }).success, acceptanceState).toBe(true);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, acceptanceState: 'SATISFIED' }).success).toBe(false);
    });
    it('reacceptance accepts every mode and refuses everything else', () => {
      for (const reacceptance of REACCEPTANCE_MODES)
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, reacceptance }).success, reacceptance).toBe(true);
      for (const reacceptance of ['reaccept_required', 'ALWAYS', 'NEVER', '', null])
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, reacceptance }).success, String(reacceptance)).toBe(false);
    });
    it('booleans are not coerced', () => {
      for (const required of ['true', 1, 'false', 0])
        expect(ConsentRequirementDto.safeParse({ ...requirementDto, required }).success, String(required)).toBe(false);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, withdrawable: 'false' }).success).toBe(false);
    });
    it('a malformed document or accepted event is refused', () => {
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, document: {} }).success).toBe(false);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, document: { ...documentDto, effectiveFrom: 1 } }).success).toBe(false);
      expect(ConsentRequirementDto.safeParse({ ...requirementDto, accepted: {} }).success).toBe(false);
    });
    it('extras are stripped (also inside document and accepted)', () => {
      const out = ConsentRequirementDto.parse({
        ...requirementDto,
        accountId: UUID_A,
        email: 'a@b.c',
        document: { ...documentDto, body: 'LEGAL TEXT' },
        accepted: { ...eventDto, ip: '1.2.3.4' },
      });
      expect(out).toEqual(requirementDto);
    });
  });

  describe('ConsentRequirementsDto', () => {
    it('accepts a valid example and the empty case', () => {
      expect(ConsentRequirementsDto.parse(requirementsDto)).toEqual(requirementsDto);
      const empty = { locale: 'en-US', requirements: [], satisfied: true, outstanding: [] };
      expect(ConsentRequirementsDto.parse(empty)).toEqual(empty);
    });
    it.each(['locale', 'requirements', 'satisfied', 'outstanding'])('%s is required and not nullable', (k) => {
      expect(ConsentRequirementsDto.safeParse(without(requirementsDto, k)).success).toBe(false);
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, [k]: null }).success).toBe(false);
    });
    it('outstanding is an array of strings only', () => {
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, outstanding: [1] }).success).toBe(false);
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, outstanding: 'PRIVACY_POLICY' }).success).toBe(false);
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, outstanding: [{ purposeCode: 'X' }] }).success).toBe(false);
    });
    it('satisfied is a boolean (no coercion)', () => {
      for (const satisfied of ['true', 1, null])
        expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, satisfied }).success, String(satisfied)).toBe(false);
    });
    it('requirements is an array of valid requirements', () => {
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, requirements: requirementDto }).success).toBe(false);
      expect(ConsentRequirementsDto.safeParse({ ...requirementsDto, requirements: [{}] }).success).toBe(false);
    });
  });

  describe('operation results', () => {
    it.each([
      ['AcceptConsentResultDto', AcceptConsentResultDto, acceptResult],
      ['WithdrawConsentResultDto', WithdrawConsentResultDto, withdrawResult],
    ] as const)('%s', (_n, schema, data) => {
      expect(schema.parse(data)).toEqual(data);
      expect(shapeKeys(schema)).toEqual(['changed', 'event']);
      for (const changed of [true, false]) expect(schema.safeParse({ ...data, changed }).success).toBe(true);
      for (const changed of ['true', 1, null, undefined]) expect(schema.safeParse({ ...data, changed }).success, String(changed)).toBe(false);
      expect(schema.safeParse(without(data, 'event')).success).toBe(false);
      expect(schema.safeParse(without(data, 'changed')).success).toBe(false);
      expect(schema.safeParse({ ...data, event: null }).success).toBe(false);
      expect(schema.safeParse({ ...data, event: { ...data.event, eventType: 'NONE' } }).success).toBe(false);
      expect(schema.parse({ ...data, accountId: UUID_A, token: 't' })).toEqual(data);
    });
    it('the accept and withdraw results share one shape but are distinct schemas', () => {
      expect(shapeKeys(AcceptConsentResultDto)).toEqual(shapeKeys(WithdrawConsentResultDto));
      expect(AcceptConsentResultDto).not.toBe(WithdrawConsentResultDto);
    });
    it('the withdrawn example carries a WITHDRAWN event with the next sequence number', () => {
      expect(WithdrawConsentResultDto.parse(withdrawResult).event.eventType).toBe('WITHDRAWN');
      expect(WithdrawConsentResultDto.parse(withdrawResult).event.eventSeq).toBe(2);
    });
  });
});

// ====================================================================== events
describe('CONSENT_EVENTS', () => {
  it('names (exact, in order)', () => {
    expect(CONSENT_EVENTS).toEqual({
      accepted: 'bananagig.identity.consent-accepted.v1',
      withdrawn: 'bananagig.identity.consent-withdrawn.v1',
    });
    expect(Object.keys(CONSENT_EVENTS)).toEqual(['accepted', 'withdrawn']);
  });
  it('every name is bananagig.identity.<kebab>.v1, unique, and matches the platform event pattern', () => {
    const names = Object.values(CONSENT_EVENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^bananagig\.identity\.[a-z]+(-[a-z]+)*\.v1$/);
      expect(EVENT_TYPE_PATTERN.test(n), n).toBe(true);
    }
  });
  it('there is one event per consent event type, named consent-<event type lower case>', () => {
    for (const t of CONSENT_EVENT_TYPES) expect(Object.values(CONSENT_EVENTS)).toContain(`bananagig.identity.consent-${t.toLowerCase()}.v1`);
    expect(Object.keys(CONSENT_EVENTS)).toEqual(CONSENT_EVENT_TYPES.map((t) => t.toLowerCase()));
  });
});

describe('ConsentEventPayload', () => {
  it('accepts a valid example and has exactly the five identifier keys', () => {
    expect(ConsentEventPayload.parse(payload)).toEqual(payload);
    expect(shapeKeys(ConsentEventPayload)).toEqual(['accountId', 'purposeCode', 'consentEventId', 'eventSeq', 'contentVersionId']);
    expect(keysOf(ConsentEventPayload).sort()).toEqual(['accountId', 'consentEventId', 'contentVersionId', 'eventSeq', 'purposeCode']);
  });
  it('strips legal text, body, hash, email, ip, locale and token instead of returning them', () => {
    const out = ConsentEventPayload.parse({
      ...payload,
      legalText: 'LEGAL TEXT',
      body: '<p>x</p>',
      text: 'x',
      bodySha256: HASH,
      hash: HASH,
      email: 'a@b.c',
      ip: '1.2.3.4',
      locale: 'en-US',
      token: 't',
      eventType: 'ACCEPTED',
      occurredAt: ISO,
    });
    expect(out).toEqual(payload);
    expect(Object.keys(out).sort()).toEqual(['accountId', 'consentEventId', 'contentVersionId', 'eventSeq', 'purposeCode']);
  });
  it.each(['accountId', 'purposeCode', 'consentEventId', 'eventSeq', 'contentVersionId'])('%s is required and not nullable', (k) => {
    expect(ConsentEventPayload.safeParse(without(payload, k)).success).toBe(false);
    expect(ConsentEventPayload.safeParse({ ...payload, [k]: null }).success).toBe(false);
  });
  it('eventSeq is an integer; the identifiers are strings', () => {
    for (const eventSeq of [1.5, '2', NaN, Infinity, true])
      expect(ConsentEventPayload.safeParse({ ...payload, eventSeq }).success, String(eventSeq)).toBe(false);
    for (const k of ['accountId', 'purposeCode', 'consentEventId', 'contentVersionId']) {
      for (const v of [1, true, {}, []]) expect(ConsentEventPayload.safeParse({ ...payload, [k]: v }).success, `${k}=${String(v)}`).toBe(false);
    }
  });
  it('carries no event type: the event NAME says whether it was accepted or withdrawn', () => {
    expect(keysOf(ConsentEventPayload)).not.toContain('eventType');
  });
  it('every key is on an explicit identifier allowlist and none looks sensitive', () => {
    const ALLOWED_PAYLOAD_KEYS = new Set(['accountId', 'purposeCode', 'consentEventId', 'eventSeq', 'contentVersionId']);
    const FORBIDDEN = /body|text|html|hash|sha|email|phone|ip|token|secret|address|subject|password|session|locale/i;
    for (const e of walk(ConsentEventPayload)) {
      expect(ALLOWED_PAYLOAD_KEYS.has(e.key), e.path).toBe(true);
      expect(FORBIDDEN.test(e.key), e.path).toBe(false);
    }
  });
});

// ====================================================================== privacy walk over every read model / result
describe('privacy: no read model can carry legal text, an address, a secret or an account reference', () => {
  const dtos: [string, z.ZodType][] = [
    ['ConsentVersionRefDto', ConsentVersionRefDto],
    ['ConsentEventDto', ConsentEventDto],
    ['ConsentCurrentDto', ConsentCurrentDto],
    ['AccountConsentsDto', AccountConsentsDto],
    ['ConsentDocumentDto', ConsentDocumentDto],
    ['ConsentRequirementDto', ConsentRequirementDto],
    ['ConsentRequirementsDto', ConsentRequirementsDto],
    ['AcceptConsentResultDto', AcceptConsentResultDto],
    ['WithdrawConsentResultDto', WithdrawConsentResultDto],
    ['AccountConsentsResponse', AccountConsentsResponse],
    ['ConsentRequirementsResponse', ConsentRequirementsResponse],
    ['AcceptConsentResponse', AcceptConsentResponse],
    ['WithdrawConsentResponse', WithdrawConsentResponse],
  ];
  const SENSITIVE = /body|text|html|content(?!VersionId)|ip|address|token|secret|email|phone|subject|password|session|correlation|account(?!Id)/i;
  // Explicit allowlist (key => why it is safe). A key not on this list that matches SENSITIVE fails the test.
  const ALLOWED: Record<string, string> = {
    // "body" substring
    bodySha256:
      'the lower-case hex SHA-256 of the immutable version text the person was shown: a fingerprint that proves WHICH text, intentionally returned so the client can echo it back on accept; the text itself is never returned',
    // "content" substring
    labelContentKey:
      'the CONTENT KEY (an identifier such as account.consent.purpose.terms_of_service) the web resolves through the public content resolver; not content',
    // "correlation" substring (response envelope only)
    correlationId: 'the envelope meta correlation id of the request, an opaque trace identifier, present on every response; not account data',
  };
  // Keys that do NOT match SENSITIVE but are called out on purpose.
  const INTENTIONAL = {
    document: 'a reference (entryKey, versionId, version, locale, bodySha256, effectiveFrom), never the text; asserted key by key below',
  };

  it('the sensitive-word regex really bites (sanity check on the walker)', () => {
    for (const k of [
      'body',
      'bodyHtml',
      'legalText',
      'text',
      'html',
      'content',
      'contentBody',
      'ip',
      'ipAddress',
      'email',
      'phone',
      'accessToken',
      'secretKey',
      'subject',
      'passwordHash',
      'sessionId',
      'applicationSessionId',
      'correlationId',
      'accountEmail',
      'accountNumber',
      'bodySha256',
      'labelContentKey',
    ])
      expect(SENSITIVE.test(k), k).toBe(true);
    // the lookaheads let the identifiers through
    expect(SENSITIVE.test('contentVersionId')).toBe(false);
    expect(SENSITIVE.test('accountId')).toBe(false);
  });

  it('walks every DTO and finds keys', () => {
    for (const [n, s] of dtos) expect(walk(s).length, n).toBeGreaterThan(0);
  });

  it.each(dtos)('%s has no sensitive key outside the allowlist', (_n, schema) => {
    for (const e of walk(schema)) {
      if (SENSITIVE.test(e.key)) expect(ALLOWED[e.key], `${e.path} matches the sensitive-word list and is not allowlisted`).toBeDefined();
    }
  });

  it('every allowlisted key is actually used (the allowlist cannot rot)', () => {
    const used = new Set(dtos.flatMap(([, s]) => keysOf(s)));
    for (const k of [...Object.keys(ALLOWED), ...Object.keys(INTENTIONAL)]) expect(used.has(k), k).toBe(true);
  });

  it('the allowlisted keys have the expected, harmless types', () => {
    const entries = dtos.flatMap(([, s]) => walk(s));
    for (const e of entries.filter((x) => x.key === 'bodySha256')) expect(e.type).toBe('string');
    for (const e of entries.filter((x) => x.key === 'labelContentKey')) expect(e.type).toBe('string');
    for (const e of entries.filter((x) => x.key === 'correlationId')) expect(e.type).toBe('string');
    for (const e of entries.filter((x) => x.key === 'document')) expect(e.type).toBe('object');
  });

  it('bodySha256 appears only on a version reference or a document (its parent is the DTO root or a key named document)', () => {
    let found = 0;
    for (const [, s] of dtos) {
      for (const e of walk(s).filter((x) => x.key === 'bodySha256')) {
        found++;
        const parent = e.path.split('.').slice(-2, -1)[0];
        expect(parent === undefined || parent === 'document' || parent === 'data', e.path).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('the document reference holds exactly the identifying fields and no text', () => {
    expect(shapeKeys(ConsentVersionRefDto)).toEqual(['versionId', 'version', 'locale', 'bodySha256']);
    expect(shapeKeys(ConsentDocumentDto)).toEqual(['entryKey', 'versionId', 'version', 'locale', 'bodySha256', 'effectiveFrom']);
    expect(defOf((defOf(ConsentEventDto).shape as Record<string, unknown>).document).type).toBe('object');
    expect(keysOf(ConsentEventDto).filter((k) => /body|text|html/i.test(k))).toEqual(['bodySha256']);
  });

  it('no read model exposes an account id, an IP address, a session, a user agent, a correlation id (outside the envelope) or the version text', () => {
    for (const s of [
      ConsentEventDto,
      ConsentCurrentDto,
      AccountConsentsDto,
      ConsentRequirementDto,
      ConsentRequirementsDto,
      AcceptConsentResultDto,
      WithdrawConsentResultDto,
    ]) {
      const keys = keysOf(s).map((k) => k.toLowerCase());
      for (const bad of [
        'accountid',
        'account',
        'ip',
        'ipaddress',
        'useragent',
        'sessionid',
        'applicationsessionid',
        'correlationid',
        'body',
        'text',
        'html',
        'content',
        'legaltext',
        'email',
        'phone',
        'token',
        'subject',
        'acceptedat',
      ])
        expect(keys, bad).not.toContain(bad);
    }
  });

  it('the envelope adds only data.* and meta.correlationId', () => {
    for (const r of [AccountConsentsResponse, ConsentRequirementsResponse, AcceptConsentResponse, WithdrawConsentResponse]) {
      expect(shapeKeys(r)).toEqual(['data', 'meta']);
      expect(shapeKeys((defOf(r).shape as Record<string, unknown>).meta)).toEqual(['correlationId']);
    }
  });

  it('request bodies: the only free-text fields are the locale tag, and the version id and hash echo what was shown', () => {
    expect(shapeKeys(AcceptConsentRequest)).toEqual(['versionId', 'locale', 'bodySha256']);
    expect(shapeKeys(WithdrawConsentRequest)).toEqual([]);
    expect(shapeKeys(ConsentPurposeParam)).toEqual(['purpose']);
    expect(shapeKeys(ConsentRequirementsQuery)).toEqual(['locale']);
  });

  it('every request schema is strict (catchall never)', () => {
    for (const s of [AcceptConsentRequest, WithdrawConsentRequest, ConsentPurposeParam, ConsentRequirementsQuery])
      expect(defOf(s).catchall?.def.type).toBe('never');
  });

  it('no request schema accepts the account, the purpose in the body, the time or the text (the server sets every one)', () => {
    for (const s of [AcceptConsentRequest, WithdrawConsentRequest]) {
      const keys = shapeKeys(s);
      for (const bad of ['accountId', 'purpose', 'purposeCode', 'acceptedAt', 'occurredAt', 'ip', 'legalText', 'body', 'eventType', 'source'])
        expect(keys, bad).not.toContain(bad);
    }
  });
});
