// Unit tests of the pure verification derivation (TRUST-001): effective status, the case/overall status precedence, the full evaluation and the PRO-001 step mapping.
// No database, no clock: every function takes `now` explicitly.
import { TRUST_OVERALL_STATUSES, TRUST_REQUIREMENT_STATUSES, type TrustRequirementStatus } from '@bananagig/contracts';
import { describe, expect, it } from 'vitest';
import { deriveCaseStatus, deriveStatus, effectiveStatus, evaluateVerification, onboardingStepStatus, type EvaluationInput } from './derive';
import type { CaseRow, DocumentView, InstanceRow, RequiredDefinition } from './types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const PAST = '2026-06-15T11:59:59.999Z'; // 1 ms before NOW
const FUTURE = '2026-06-15T12:00:00.001Z'; // 1 ms after NOW
const ALL: readonly TrustRequirementStatus[] = TRUST_REQUIREMENT_STATUSES;

const def = (code: string, over: Partial<RequiredDefinition> = {}): RequiredDefinition => ({
  requirementDefinitionId: `def-${code}`,
  code,
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  expiryRequired: false,
  ...over,
});
const inst = (code: string, status: TrustRequirementStatus, over: Partial<InstanceRow> = {}): InstanceRow => ({
  caseRequirementId: `req-${code}`,
  verificationCaseId: 'case-1',
  requirementDefinitionId: `def-${code}`,
  requirementCode: code,
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  expiryRequired: false,
  cycle: 1,
  status,
  round: 0,
  revision: 1,
  approvedAt: null,
  expiresAt: null,
  supersededAt: null,
  latestReasonCode: null,
  ...over,
});
const caseRow = (over: Partial<CaseRow> = {}): CaseRow => ({
  verificationCaseId: 'case-1',
  accountId: 'acct-1',
  caseNumber: 7,
  status: 'OPEN',
  revision: 3,
  openedAt: '2026-06-01T00:00:00.000Z',
  submittedAt: null,
  decidedAt: null,
  ...over,
});
const doc = (id: string, requirementCode: string, over: Partial<DocumentView> = {}): DocumentView => ({
  verificationDocumentId: id,
  caseRequirementId: `req-${requirementCode}`,
  documentTypeCode: 'passport',
  status: 'ATTACHED',
  scanStatus: 'CLEAN',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  round: null,
  createdAt: '2026-06-02T00:00:00.000Z',
  submittedAt: null,
  sha256: null,
  ...over,
});
const SUBMITTED = '2026-06-10T00:00:00.000Z';
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  now: NOW,
  required: [def('identity_verification')],
  case: caseRow({ submittedAt: SUBMITTED, status: 'IN_REVIEW' }),
  instances: [inst('identity_verification', 'PENDING')],
  documents: [],
  documentTypes: new Map([['IDENTITY', ['passport', 'drivers_license']]]),
  ...over,
});
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of o instanceof Map ? [...o.values()] : Object.values(o)) deepFreeze(v);
  }
  return o;
};

describe('effectiveStatus', () => {
  it('reads an APPROVED instance past its end as EXPIRED', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: PAST }, NOW)).toBe('EXPIRED');
  });
  it('treats the exact end instant as expired (expiry is inclusive of the boundary)', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: NOW.toISOString() }, NOW)).toBe('EXPIRED');
  });
  it('keeps an APPROVED instance whose end is one millisecond away', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: FUTURE }, NOW)).toBe('APPROVED');
  });
  it('keeps an APPROVED instance without an end date (identity does not expire)', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: null }, NOW)).toBe('APPROVED');
  });
  it.each(ALL.filter((s) => s !== 'APPROVED'))('never rewrites a %s instance, even with a past end date', (status) => {
    expect(effectiveStatus({ status, expiresAt: PAST }, NOW)).toBe(status);
  });
  it('parses ISO strings with an offset', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: '2026-06-15T13:59:59+02:00' }, NOW)).toBe('EXPIRED');
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: '2026-06-15T14:00:01+02:00' }, NOW)).toBe('APPROVED');
  });
});

describe('deriveStatus', () => {
  // An independent oracle of the documented precedence, checked against every subset of the 8 statuses.
  const oracle = (submitted: boolean, statuses: readonly TrustRequirementStatus[]): string => {
    const live = new Set(statuses.filter((s) => s !== 'NOT_REQUIRED'));
    if (!submitted) return 'OPEN';
    for (const s of ['ACTION_REQUIRED', 'REJECTED', 'NOT_STARTED'] as const) if (live.has(s)) return 'ACTION_REQUIRED';
    if (live.has('EXPIRED')) return 'EXPIRED';
    if (live.has('PENDING') || live.has('IN_REVIEW')) return 'IN_REVIEW';
    return 'APPROVED';
  };

  it('is exported under both names', () => {
    expect(deriveCaseStatus).toBe(deriveStatus);
  });
  it('is OPEN before the first submission whatever the requirement statuses are', () => {
    for (const s of ALL) expect(deriveStatus(false, [s])).toBe('OPEN');
    expect(deriveStatus(false, [])).toBe('OPEN');
    expect(deriveStatus(false, ['APPROVED', 'APPROVED'])).toBe('OPEN');
  });
  it.each([
    ['NOT_STARTED', 'ACTION_REQUIRED'],
    ['ACTION_REQUIRED', 'ACTION_REQUIRED'],
    ['REJECTED', 'ACTION_REQUIRED'],
    ['EXPIRED', 'EXPIRED'],
    ['PENDING', 'IN_REVIEW'],
    ['IN_REVIEW', 'IN_REVIEW'],
    ['APPROVED', 'APPROVED'],
    ['NOT_REQUIRED', 'APPROVED'],
  ] as const)('a submitted case holding only %s is %s', (status, expected) => {
    expect(deriveStatus(true, [status])).toBe(expected);
    expect(deriveStatus(true, [status, status])).toBe(expected);
  });
  it('a submitted case with nothing live is APPROVED (nothing is outstanding)', () => {
    expect(deriveStatus(true, [])).toBe('APPROVED');
    expect(deriveStatus(true, ['NOT_REQUIRED', 'NOT_REQUIRED'])).toBe('APPROVED');
  });
  it('ignores NOT_REQUIRED next to a live status', () => {
    expect(deriveStatus(true, ['NOT_REQUIRED', 'PENDING'])).toBe('IN_REVIEW');
    expect(deriveStatus(true, ['NOT_REQUIRED', 'APPROVED'])).toBe('APPROVED');
  });
  it.each([
    // the provider owes something: beats everything
    [['ACTION_REQUIRED', 'EXPIRED'], 'ACTION_REQUIRED'],
    [['ACTION_REQUIRED', 'PENDING'], 'ACTION_REQUIRED'],
    [['ACTION_REQUIRED', 'IN_REVIEW'], 'ACTION_REQUIRED'],
    [['ACTION_REQUIRED', 'APPROVED'], 'ACTION_REQUIRED'],
    [['REJECTED', 'EXPIRED'], 'ACTION_REQUIRED'],
    [['REJECTED', 'PENDING'], 'ACTION_REQUIRED'],
    [['REJECTED', 'APPROVED'], 'ACTION_REQUIRED'],
    [['NOT_STARTED', 'EXPIRED'], 'ACTION_REQUIRED'],
    [['NOT_STARTED', 'PENDING'], 'ACTION_REQUIRED'],
    [['NOT_STARTED', 'IN_REVIEW'], 'ACTION_REQUIRED'],
    [['NOT_STARTED', 'APPROVED'], 'ACTION_REQUIRED'],
    [['NOT_STARTED', 'REJECTED', 'ACTION_REQUIRED'], 'ACTION_REQUIRED'],
    // an ended approval beats waiting and approved
    [['EXPIRED', 'PENDING'], 'EXPIRED'],
    [['EXPIRED', 'IN_REVIEW'], 'EXPIRED'],
    [['EXPIRED', 'APPROVED'], 'EXPIRED'],
    // waiting beats approved
    [['PENDING', 'APPROVED'], 'IN_REVIEW'],
    [['IN_REVIEW', 'APPROVED'], 'IN_REVIEW'],
    [['PENDING', 'IN_REVIEW'], 'IN_REVIEW'],
  ] as const)('submitted %j is %s (order independent)', (statuses, expected) => {
    expect(deriveStatus(true, statuses)).toBe(expected);
    expect(deriveStatus(true, [...statuses].reverse())).toBe(expected);
  });
  it('matches the independent oracle for all 256 subsets of statuses, submitted or not', () => {
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const subset = ALL.filter((_, i) => mask & (1 << i));
      for (const submitted of [true, false]) expect(deriveStatus(submitted, subset), `${submitted} ${subset.join(',')}`).toBe(oracle(submitted, subset));
    }
  });
  it('never returns CANCELLED', () => {
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      expect(
        deriveStatus(
          true,
          ALL.filter((_, i) => mask & (1 << i)),
        ),
      ).not.toBe('CANCELLED');
    }
  });
});

describe('onboardingStepStatus', () => {
  it.each([
    ['NOT_REQUIRED', 'NOT_REQUIRED'],
    ['NOT_STARTED', 'NOT_STARTED'],
    ['OPEN', 'IN_PROGRESS'],
    ['IN_REVIEW', 'IN_PROGRESS'],
    ['ACTION_REQUIRED', 'BLOCKED'],
    ['EXPIRED', 'BLOCKED'],
    ['APPROVED', 'COMPLETE'],
  ] as const)('maps overall %s to the onboarding step %s', (overall, step) => {
    expect(onboardingStepStatus(overall)).toBe(step);
  });
  it('covers every overall status', () => {
    expect(TRUST_OVERALL_STATUSES).toHaveLength(7);
    for (const s of TRUST_OVERALL_STATUSES) expect(onboardingStepStatus(s)).toBeTruthy();
  });
});

describe('evaluateVerification: nothing required / no case', () => {
  it('is NOT_REQUIRED and complete when policy requires nothing, even with a case and a stale instance', () => {
    const v = evaluateVerification(input({ required: [], instances: [inst('identity_verification', 'PENDING')] }));
    expect(v.overall).toEqual({
      status: 'NOT_REQUIRED',
      verificationComplete: true,
      requiredCount: 0,
      approvedCount: 0,
      missing: [],
      actionRequired: [],
      expired: [],
    });
    expect(v.requirements).toEqual([]); // a pending (not approved) instance of a requirement no longer asked for is not shown
  });
  it('is NOT_REQUIRED when nothing is required and there is no case', () => {
    const v = evaluateVerification(input({ required: [], case: null, instances: [] }));
    expect(v.overall.status).toBe('NOT_REQUIRED');
    expect(v.case).toBeNull();
  });
  it('is NOT_STARTED, incomplete, with every required code missing when there is no case', () => {
    const v = evaluateVerification(input({ required: [def('a'), def('b', { requirementType: 'LICENSE' })], case: null, instances: [] }));
    expect(v.case).toBeNull();
    expect(v.overall).toEqual({
      status: 'NOT_STARTED',
      verificationComplete: false,
      requiredCount: 2,
      approvedCount: 0,
      missing: ['a', 'b'],
      actionRequired: [],
      expired: [],
    });
    expect(v.requirements.map((r) => [r.requirementCode, r.status, r.caseRequirementId, r.cycle, r.round])).toEqual([
      ['a', 'NOT_STARTED', null, 0, 0],
      ['b', 'NOT_STARTED', null, 0, 0],
    ]);
    expect(v.requirements.every((r) => !r.canAttachEvidence && !r.canReverify)).toBe(true);
  });
  it('treats a CANCELLED case as no case at all (instances, if any, are ignored for the status and the case is not reported)', () => {
    const v = evaluateVerification(
      input({ case: caseRow({ status: 'CANCELLED', submittedAt: SUBMITTED }), instances: [inst('identity_verification', 'APPROVED')] }),
    );
    expect(v.case).toBeNull();
    expect(v.overall.status).toBe('NOT_STARTED');
    expect(v.overall.verificationComplete).toBe(false);
    expect(v.requirements[0]!.canAttachEvidence).toBe(false);
    expect(v.requirements[0]!.canReverify).toBe(false);
  });
  it('a cancelled case offers no evidence upload and no reverify even for an expired approval', () => {
    const v = evaluateVerification(
      input({ case: caseRow({ status: 'CANCELLED' }), instances: [inst('identity_verification', 'APPROVED', { expiresAt: PAST })] }),
    );
    expect(v.requirements[0]!.canReverify).toBe(false);
  });
});

describe('evaluateVerification: overall status of an existing case', () => {
  it('is OPEN while the case was never submitted, whatever the instances say', () => {
    for (const s of ALL) {
      const v = evaluateVerification(input({ case: caseRow({ submittedAt: null }), instances: [inst('identity_verification', s)] }));
      expect(v.overall.status, s).toBe('OPEN');
      expect(v.overall.verificationComplete, s).toBe(false);
    }
  });
  it.each([
    ['NOT_STARTED', 'ACTION_REQUIRED'],
    ['ACTION_REQUIRED', 'ACTION_REQUIRED'],
    ['REJECTED', 'ACTION_REQUIRED'],
    ['EXPIRED', 'EXPIRED'],
    ['PENDING', 'IN_REVIEW'],
    ['IN_REVIEW', 'IN_REVIEW'],
    ['APPROVED', 'APPROVED'],
    ['NOT_REQUIRED', 'APPROVED'],
  ] as const)('a submitted case with one %s requirement is %s overall', (status, expected) => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', status)] }));
    expect(v.overall.status).toBe(expected);
    expect(v.overall.verificationComplete).toBe(expected === 'APPROVED');
  });
  it('uses the effective status: a stored APPROVED past its end makes the overall status EXPIRED and lists the code', () => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: PAST })] }));
    expect(v.overall.status).toBe('EXPIRED');
    expect(v.overall.expired).toEqual(['identity_verification']);
    expect(v.overall.approvedCount).toBe(0);
    expect(v.overall.verificationComplete).toBe(false);
    expect(v.requirements[0]!.status).toBe('EXPIRED');
  });
  it('an approval one millisecond before its end is still APPROVED and complete', () => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: FUTURE })] }));
    expect(v.overall).toMatchObject({ status: 'APPROVED', verificationComplete: true, approvedCount: 1, expired: [] });
  });
  it('derives the overall status from the instances, not from the stored case status', () => {
    const v = evaluateVerification(
      input({ case: caseRow({ submittedAt: SUBMITTED, status: 'APPROVED' }), instances: [inst('identity_verification', 'REJECTED')] }),
    );
    expect(v.overall.status).toBe('ACTION_REQUIRED');
    expect(v.case!.status).toBe('APPROVED'); // the stored value is reported as stored
  });
  it('combines several requirements by precedence', () => {
    const required = [def('a'), def('b'), def('c')];
    const mk = (a: TrustRequirementStatus, b: TrustRequirementStatus, c: TrustRequirementStatus) =>
      evaluateVerification(input({ required, instances: [inst('a', a), inst('b', b), inst('c', c)] })).overall;
    expect(mk('APPROVED', 'APPROVED', 'APPROVED')).toMatchObject({ status: 'APPROVED', approvedCount: 3, requiredCount: 3, verificationComplete: true });
    expect(mk('APPROVED', 'PENDING', 'APPROVED')).toMatchObject({ status: 'IN_REVIEW', approvedCount: 2, verificationComplete: false });
    expect(mk('APPROVED', 'PENDING', 'REJECTED')).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['c'] });
    expect(mk('EXPIRED', 'PENDING', 'APPROVED')).toMatchObject({ status: 'EXPIRED', expired: ['a'] });
    expect(mk('EXPIRED', 'ACTION_REQUIRED', 'APPROVED')).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['b'], expired: ['a'] });
  });
  it('a missing definition in a submitted case makes the provider act (NOT_STARTED beats APPROVED)', () => {
    const v = evaluateVerification(input({ required: [def('a'), def('b')], instances: [inst('a', 'APPROVED')] }));
    expect(v.overall.status).toBe('ACTION_REQUIRED');
    expect(v.overall.missing).toEqual(['b']);
    expect(v.overall.actionRequired).toEqual(['b']);
    expect(v.overall.approvedCount).toBe(1);
    expect(v.overall.requiredCount).toBe(2);
  });
  it('a missing definition in a case that was never submitted is not an action (it is OPEN)', () => {
    const v = evaluateVerification(input({ case: caseRow({ submittedAt: null }), required: [def('a'), def('b')], instances: [inst('a', 'APPROVED')] }));
    expect(v.overall.status).toBe('OPEN');
    expect(v.overall.missing).toEqual(['b']);
    expect(v.overall.actionRequired).toEqual([]);
  });
  it('NOT_STARTED instances of a submitted case are listed as actions, in an unsubmitted case they are not', () => {
    const submitted = evaluateVerification(input({ instances: [inst('identity_verification', 'NOT_STARTED')] }));
    expect(submitted.overall.actionRequired).toEqual(['identity_verification']);
    expect(submitted.overall.missing).toEqual([]); // it exists; it just has no evidence
    const open = evaluateVerification(input({ case: caseRow({ submittedAt: null }), instances: [inst('identity_verification', 'NOT_STARTED')] }));
    expect(open.overall.actionRequired).toEqual([]);
  });
  it('lists ACTION_REQUIRED and REJECTED requirements as actions, in required order, and only those', () => {
    const required = [def('a'), def('b'), def('c'), def('d')];
    const v = evaluateVerification(
      input({ required, instances: [inst('a', 'REJECTED'), inst('b', 'PENDING'), inst('c', 'ACTION_REQUIRED'), inst('d', 'APPROVED')] }),
    );
    expect(v.overall.actionRequired).toEqual(['a', 'c']);
  });
  it('reports the case fields of an open case', () => {
    const v = evaluateVerification(input());
    expect(v.case).toEqual({
      verificationCaseId: 'case-1',
      caseNumber: 7,
      status: 'IN_REVIEW',
      revision: 3,
      openedAt: '2026-06-01T00:00:00.000Z',
      submittedAt: SUBMITTED,
    });
  });
  it('does not leak the account id or the decision time of the case into the view', () => {
    const v = evaluateVerification(input({ case: caseRow({ submittedAt: SUBMITTED, decidedAt: '2026-06-11T00:00:00.000Z' }) }));
    expect(Object.keys(v.case!).sort()).toEqual(['caseNumber', 'openedAt', 'revision', 'status', 'submittedAt', 'verificationCaseId']);
  });
});

describe('evaluateVerification: requirement views', () => {
  it('copies code, type, kind, cycle, round and end date from the instance', () => {
    const v = evaluateVerification(
      input({
        required: [def('professional_license', { requirementType: 'LICENSE', expiryRequired: true })],
        instances: [inst('professional_license', 'PENDING', { cycle: 2, round: 4, expiresAt: FUTURE, caseRequirementId: 'req-x' })],
      }),
    );
    expect(v.requirements[0]).toMatchObject({
      caseRequirementId: 'req-x',
      requirementCode: 'professional_license',
      requirementType: 'LICENSE',
      evidenceKind: 'DOCUMENT',
      status: 'PENDING',
      cycle: 2,
      round: 4,
      expiresAt: FUTURE,
    });
  });
  it('keeps the required order, not the instance order', () => {
    const v = evaluateVerification(
      input({ required: [def('a'), def('b'), def('c')], instances: [inst('c', 'PENDING'), inst('a', 'PENDING'), inst('b', 'PENDING')] }),
    );
    expect(v.requirements.map((r) => r.requirementCode)).toEqual(['a', 'b', 'c']);
  });
  it('matches an instance to its definition by id, not by code', () => {
    const v = evaluateVerification(
      input({ required: [def('a')], instances: [inst('a', 'PENDING', { requirementDefinitionId: 'def-other', requirementCode: 'a' })] }),
    );
    expect(v.overall.missing).toEqual(['a']);
    expect(v.requirements[0]!.caseRequirementId).toBeNull();
  });

  describe('reasonCode', () => {
    it.each(ALL)('is shown for %s only while the provider must act', (status) => {
      const v = evaluateVerification(input({ instances: [inst('identity_verification', status, { latestReasonCode: 'BLURRY' })] }));
      expect(v.requirements[0]!.reasonCode).toBe(status === 'ACTION_REQUIRED' || status === 'REJECTED' ? 'BLURRY' : null);
    });
    it('is hidden once an approval expired by the clock (the effective status is EXPIRED)', () => {
      const v = evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: PAST, latestReasonCode: 'BLURRY' })] }));
      expect(v.requirements[0]!.reasonCode).toBeNull();
    });
    it('is null when there is no reason, and for a requirement without an instance', () => {
      expect(evaluateVerification(input({ instances: [inst('identity_verification', 'REJECTED')] })).requirements[0]!.reasonCode).toBeNull();
      expect(evaluateVerification(input({ instances: [] })).requirements[0]!.reasonCode).toBeNull();
    });
  });

  describe('canAttachEvidence', () => {
    it.each(ALL)('for a DOCUMENT requirement in %s of an open case', (status) => {
      const v = evaluateVerification(input({ instances: [inst('identity_verification', status)] }));
      expect(v.requirements[0]!.canAttachEvidence).toBe(status === 'NOT_STARTED' || status === 'ACTION_REQUIRED' || status === 'REJECTED');
    });
    it('is false for an EXTERNAL requirement in an attachable status', () => {
      const v = evaluateVerification(
        input({
          required: [def('background_check', { evidenceKind: 'EXTERNAL', requirementType: 'BACKGROUND_CHECK' })],
          instances: [inst('background_check', 'NOT_STARTED', { evidenceKind: 'EXTERNAL', requirementType: 'BACKGROUND_CHECK' })],
        }),
      );
      expect(v.requirements[0]!.canAttachEvidence).toBe(false);
    });
    it('is false for a requirement the case does not hold yet (nothing to attach to)', () => {
      expect(evaluateVerification(input({ instances: [] })).requirements[0]!.canAttachEvidence).toBe(false);
    });
    it('is true before the first submission too (OPEN case)', () => {
      const v = evaluateVerification(input({ case: caseRow(), instances: [inst('identity_verification', 'NOT_STARTED')] }));
      expect(v.requirements[0]!.canAttachEvidence).toBe(true);
    });
    it('is false when the effective status is EXPIRED (a new cycle is needed first)', () => {
      const v = evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: PAST })] }));
      expect(v.requirements[0]!.canAttachEvidence).toBe(false);
    });
  });

  describe('canReverify', () => {
    it('is true for an EXPIRED instance of a required requirement', () => {
      expect(evaluateVerification(input({ instances: [inst('identity_verification', 'EXPIRED')] })).requirements[0]!.canReverify).toBe(true);
    });
    it('is true for an APPROVED instance that expired by the clock before the sweep', () => {
      expect(evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: PAST })] })).requirements[0]!.canReverify).toBe(
        true,
      );
    });
    it.each(ALL.filter((s) => s !== 'EXPIRED'))('is false for %s', (status) => {
      expect(evaluateVerification(input({ instances: [inst('identity_verification', status)] })).requirements[0]!.canReverify).toBe(false);
    });
    it('is false for a still valid approval', () => {
      expect(evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED', { expiresAt: FUTURE })] })).requirements[0]!.canReverify).toBe(
        false,
      );
    });
    it('is false for a requirement that is not held', () => {
      expect(evaluateVerification(input({ instances: [] })).requirements[0]!.canReverify).toBe(false);
    });
  });

  describe('documents and document types', () => {
    it('attaches to each requirement only its own documents', () => {
      const v = evaluateVerification(
        input({
          required: [def('a'), def('b')],
          instances: [inst('a', 'NOT_STARTED'), inst('b', 'NOT_STARTED')],
          documents: [doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'a', { status: 'WITHDRAWN' }), doc('d4', 'zzz')],
        }),
      );
      expect(v.requirements[0]!.documents.map((d) => d.verificationDocumentId)).toEqual(['d1', 'd3']); // any status is kept
      expect(v.requirements[1]!.documents.map((d) => d.verificationDocumentId)).toEqual(['d2']);
    });
    it('a requirement without an instance has no documents, even if a document references a requirement id', () => {
      const v = evaluateVerification(input({ instances: [], documents: [doc('d1', 'identity_verification')] }));
      expect(v.requirements[0]!.documents).toEqual([]);
    });
    it('lists the document types of the requirement type, as a copy', () => {
      const types = new Map([['IDENTITY', ['passport']]]);
      const v = evaluateVerification(input({ documentTypes: types }));
      expect(v.requirements[0]!.documentTypes).toEqual(['passport']);
      v.requirements[0]!.documentTypes.push('x');
      expect(types.get('IDENTITY')).toEqual(['passport']);
    });
    it('lists no document types for a type the map does not know', () => {
      expect(evaluateVerification(input({ documentTypes: new Map() })).requirements[0]!.documentTypes).toEqual([]);
    });
  });
});

describe('evaluateVerification: requirements policy no longer asks for', () => {
  const retired = (status: TrustRequirementStatus, over: Partial<InstanceRow> = {}) =>
    inst('professional_license', status, { requirementType: 'LICENSE', ...over });

  it('keeps an APPROVED instance of a no-longer-required definition visible as history, after the required ones', () => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'PENDING'), retired('APPROVED')] }));
    expect(v.requirements.map((r) => [r.requirementCode, r.status])).toEqual([
      ['identity_verification', 'PENDING'],
      ['professional_license', 'APPROVED'],
    ]);
    expect(v.requirements[1]!.requirementType).toBe('LICENSE');
  });
  it('keeps an EXPIRED (stored or by the clock) history instance visible', () => {
    expect(evaluateVerification(input({ instances: [retired('EXPIRED')] })).requirements.map((r) => r.requirementCode)).toContain('professional_license');
    const byClock = evaluateVerification(input({ instances: [retired('APPROVED', { expiresAt: PAST })] }));
    expect(byClock.requirements.find((r) => r.requirementCode === 'professional_license')!.status).toBe('EXPIRED');
  });
  it.each(ALL.filter((s) => s !== 'APPROVED' && s !== 'EXPIRED'))('hides a %s instance of a no-longer-required definition', (status) => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'PENDING'), retired(status)] }));
    expect(v.requirements.map((r) => r.requirementCode)).toEqual(['identity_verification']);
  });
  it('history is read-only: no evidence upload and no reverify, even when expired', () => {
    const v = evaluateVerification(
      input({ instances: [retired('EXPIRED'), retired('APPROVED', { caseRequirementId: 'req-2', requirementDefinitionId: 'def-other', expiresAt: PAST })] }),
    );
    for (const r of v.requirements.filter((x) => x.requirementCode === 'professional_license')) {
      expect(r.canAttachEvidence).toBe(false);
      expect(r.canReverify).toBe(false);
    }
  });
  it('history does not count in the overall status, counts, missing, actions or expired lists', () => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'APPROVED'), retired('EXPIRED')] }));
    expect(v.overall).toEqual({
      status: 'APPROVED',
      verificationComplete: true,
      requiredCount: 1,
      approvedCount: 1,
      missing: [],
      actionRequired: [],
      expired: [],
    });
    expect(v.requirements).toHaveLength(2);
  });
  it('history of an approved retired requirement does not count as approved', () => {
    const v = evaluateVerification(input({ instances: [inst('identity_verification', 'PENDING'), retired('APPROVED')] }));
    expect(v.overall.approvedCount).toBe(0);
    expect(v.overall.status).toBe('IN_REVIEW');
  });
  it('shows the history documents of the retired instance', () => {
    const v = evaluateVerification(input({ instances: [retired('APPROVED')], documents: [doc('dh', 'professional_license')] }));
    expect(v.requirements.find((r) => r.requirementCode === 'professional_license')!.documents.map((d) => d.verificationDocumentId)).toEqual(['dh']);
  });
  it('when policy requires nothing, an approved retired instance is still shown but the overall stays NOT_REQUIRED', () => {
    const v = evaluateVerification(input({ required: [], instances: [retired('APPROVED')] }));
    expect(v.overall).toMatchObject({ status: 'NOT_REQUIRED', requiredCount: 0, approvedCount: 0 });
    expect(v.requirements).toHaveLength(1);
  });
});

describe('evaluateVerification: determinism and purity', () => {
  const rich = (): EvaluationInput =>
    input({
      required: [def('a'), def('b'), def('c', { evidenceKind: 'EXTERNAL', requirementType: 'BACKGROUND_CHECK' })],
      instances: [
        inst('a', 'APPROVED', { expiresAt: PAST }),
        inst('b', 'REJECTED', { latestReasonCode: 'BLURRY' }),
        inst('old', 'APPROVED', { requirementDefinitionId: 'def-old' }),
      ],
      documents: [doc('d1', 'a'), doc('d2', 'b')],
    });
  it('gives the same output for the same input', () => {
    expect(evaluateVerification(rich())).toEqual(evaluateVerification(rich()));
  });
  it('does not mutate its input (a deeply frozen input is accepted)', () => {
    const frozen = deepFreeze(rich());
    const v = evaluateVerification(frozen);
    expect(v.overall.status).toBe('ACTION_REQUIRED');
  });
  it('depends on `now` only through the clock argument', () => {
    const before = evaluateVerification({ ...rich(), now: new Date('2000-01-01T00:00:00Z') });
    const after = evaluateVerification(rich());
    expect(before.requirements[0]!.status).toBe('APPROVED');
    expect(after.requirements[0]!.status).toBe('EXPIRED');
  });
  it('returns fresh arrays: mutating a result does not change a later one', () => {
    const i = rich();
    const first = evaluateVerification(i);
    first.overall.missing.push('x');
    first.requirements.length = 0;
    expect(evaluateVerification(i).requirements).toHaveLength(4);
    expect(evaluateVerification(i).overall.missing).toEqual(['c']);
  });
});
