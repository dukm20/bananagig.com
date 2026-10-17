// Unit tests of the provider verification contracts (TRUST-001), written by an independent author: the vocabularies (equal to the CHECK constraints of migration 0019), the requirement
// status machine (all 64 pairs, equal to the migration guard) and the definition machine (all 9 pairs), every managed content key helper (equal to the keys the migration seeds, in BOTH
// directions), the evidence policy (strict, bounds equal to the seeded validation rules), every strict request (sizes, MIME pattern, SHA-256, round, expiresAt, reason code, nullable
// rule scope), the read models (what a provider can and cannot see), the events and the error code list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOG_CODE_MAX } from './catalog';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN } from './index';
import {
  ApproveRequirementRequest,
  CancelVerificationRequest,
  DocumentUploadAuthorizationDto,
  DocumentUploadAuthorizationResponse,
  ExternalVerificationDto,
  FinalizeDocumentRequest,
  OpenVerificationRequest,
  ProviderVerificationDto,
  ProviderVerificationResponse,
  RejectRequirementRequest,
  RequestActionRequest,
  RequestDocumentUploadRequest,
  ReverifyRequirementRequest,
  SetRequirementRuleRequest,
  SetRequirementStatusRequest,
  StartExternalVerificationRequest,
  StartReviewRequest,
  SubmitVerificationRequest,
  TRUST_CASE_STATUSES,
  TRUST_DEFINITION_STATUSES,
  TRUST_DOCUMENT_SIZE_CEILING,
  TRUST_DOCUMENT_STATUSES,
  TRUST_DOCUMENT_TYPE_CODES,
  TRUST_ERROR_CODES,
  TRUST_EVENTS,
  TRUST_EVIDENCE_KINDS,
  TRUST_EVIDENCE_OPEN_STATUSES,
  TRUST_EXTERNAL_STATUSES,
  TRUST_OVERALL_STATUSES,
  TRUST_POLICY_KEYS,
  TRUST_REASON_CODES,
  TRUST_REQUIREMENT_STATUSES,
  TRUST_REQUIREMENT_TYPES,
  TRUST_REVIEW_DECISIONS,
  TRUST_SCAN_STATUSES,
  TrustAdminDocumentDto,
  TrustAdminRequirementDto,
  TrustCaseDetailDto,
  TrustCaseDetailResponse,
  TrustCaseEventPayload,
  TrustCaseListResponse,
  TrustCaseStatus,
  TrustCaseSummaryDto,
  TrustDefinitionStatus,
  TrustDocumentPolicy,
  TrustDocumentStatus,
  TrustDownloadDto,
  TrustDownloadResponse,
  TrustEvidenceKind,
  TrustExternalStatus,
  TrustOverallStatus,
  TrustPolicyDto,
  TrustPolicyResponse,
  TrustReasonCode,
  TrustRequirementDecisionDto,
  TrustRequirementDecisionResponse,
  TrustRequirementEventPayload,
  TrustRequirementStatus,
  TrustRequirementType,
  TrustReviewDecision,
  TrustReviewDto,
  TrustScanStatus,
  VerificationCaseDto,
  VerificationDocumentDto,
  VerificationDocumentListResponse,
  VerificationDocumentResponse,
  VerificationRequirementDto,
  isTrustDefinitionTransitionAllowed,
  isTrustRequirementTransitionAllowed,
  trustDocumentStatusKey,
  trustDocumentTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  trustRequirementInstructionsKey,
  trustRequirementNameKey,
  trustRequirementStatusKey,
  trustScanStatusKey,
  trustVerificationStatusKey,
  type TrustDefinitionStatus as DefinitionStatus,
  type TrustErrorCode,
  type TrustRequirementStatus as RequirementStatus,
} from './trust';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0019_trust_verification.sql', import.meta.url)), 'utf8');

const ok = (schema: z.ZodType, v: unknown): boolean => schema.safeParse(v).success;
const issuePaths = (schema: z.ZodType, v: unknown): string[] => {
  const r = schema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};
const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
type Def = { type?: string; shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; valueType?: unknown };
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;
const shapeKeys = (schema: unknown): string[] => Object.keys(defOf(schema).shape ?? {}).sort();
/** Every property name reachable from a schema (objects, arrays, optional, nullable, records), as dotted paths. */
const allPaths = (schema: unknown, prefix = ''): string[] => {
  const d = defOf(schema);
  if (d.shape) return Object.entries(d.shape).flatMap(([k, v]) => [`${prefix}${k}`, ...allPaths(v, `${prefix}${k}.`)]);
  if (d.element) return allPaths(d.element, prefix);
  if (d.innerType) return allPaths(d.innerType, prefix);
  return [];
};

const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const UUID_B = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const ISO = '2026-10-16T12:00:00.000Z';
const SHA = 'a'.repeat(64);

// ---------------------------------------------------------------- what the migration says
/** Values of `CONSTRAINT <name> CHECK (<col> IN ('A', 'B', ...))`. */
const checkList = (constraint: string): string[] => {
  const m = new RegExp(`${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(migration);
  expect(m, constraint).not.toBeNull();
  return [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
};
const seededKeys = [...migration.matchAll(/\(\d+,\s+'(?:UI_LABEL|PLAIN_TEXT)',\s+'(trust\.[a-z_.]+)'/g)].map((m) => m[1]!);
const seeded = (prefix: string): string[] => seededKeys.filter((k) => k.startsWith(`${prefix}.`)).sort();
const seededDefinitionCodes = [...migration.matchAll(/^ {2}\('([a-z_]+)', '([A-Z_]+)', '(DOCUMENT|EXTERNAL)', (true|false), '(ACTIVE|INACTIVE)'\)/gm)].map(
  (m) => m[1]!,
);
const seededDocumentTypes = [
  ...migration.matchAll(/^ {2}\('([a-z_]+)', '(IDENTITY|LICENSE|BUSINESS_REGISTRATION|INSURANCE|CERTIFICATION|BACKGROUND_CHECK|OTHER_DOCUMENT)'\)/gm),
].map((m) => m[1]!);
const seededReasons = [...migration.matchAll(/^ {2}\('([A-Z_]+)', '(BOTH|REJECT|ACTION_REQUIRED)'\)/gm)].map((m) => m[1]!);

const policy = (over: Record<string, unknown> = {}) => ({
  maxSizeBytes: 10_485_760,
  allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxDocumentsPerRequirement: 5,
  uploadUrlTtlSeconds: 300,
  downloadUrlTtlSeconds: 60,
  requireCleanScan: true,
  ...over,
});
const document = (over: Record<string, unknown> = {}) => ({
  verificationDocumentId: UUID_A,
  documentTypeCode: 'drivers_license',
  documentTypeNameKey: trustDocumentTypeNameKey('drivers_license'),
  status: 'ATTACHED',
  statusKey: trustDocumentStatusKey('ATTACHED'),
  scanStatus: 'CLEAN',
  scanStatusKey: trustScanStatusKey('CLEAN'),
  mimeType: 'application/pdf',
  sizeBytes: 1234,
  round: null,
  createdAt: ISO,
  submittedAt: null,
  ...over,
});
const requirement = (over: Record<string, unknown> = {}) => ({
  caseRequirementId: UUID_A,
  requirementCode: 'identity_verification',
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  nameKey: trustRequirementNameKey('identity_verification'),
  instructionsKey: trustRequirementInstructionsKey('identity_verification'),
  status: 'NOT_STARTED',
  statusKey: trustRequirementStatusKey('NOT_STARTED'),
  cycle: 1,
  round: 0,
  expiresAt: null,
  reasonCode: null,
  reasonKey: null,
  canAttachEvidence: true,
  canReverify: false,
  documentTypes: [{ code: 'drivers_license', nameKey: trustDocumentTypeNameKey('drivers_license') }],
  documents: [document()],
  ...over,
});
const verification = (over: Record<string, unknown> = {}) => ({
  prerequisiteMet: true,
  case: {
    verificationCaseId: UUID_A,
    caseNumber: 1,
    status: 'OPEN',
    statusKey: trustVerificationStatusKey('OPEN'),
    revision: 1,
    openedAt: ISO,
    submittedAt: null,
  },
  overall: {
    status: 'OPEN',
    statusKey: trustVerificationStatusKey('OPEN'),
    verificationComplete: false,
    requiredCount: 1,
    approvedCount: 0,
    missing: [],
    actionRequired: [],
    expired: [],
  },
  requirements: [requirement()],
  goLive: { evaluated: false, eligible: false },
  ...over,
});
const adminRequirement = (over: Record<string, unknown> = {}) => ({
  caseRequirementId: UUID_A,
  requirementCode: 'identity_verification',
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  nameKey: trustRequirementNameKey('identity_verification'),
  status: 'PENDING',
  statusKey: trustRequirementStatusKey('PENDING'),
  cycle: 1,
  round: 1,
  approvedAt: null,
  expiresAt: null,
  superseded: false,
  reviews: [],
  documents: [{ ...document({ status: 'SUBMITTED', round: 1, submittedAt: ISO }), sha256: SHA }],
  external: null,
  ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  verificationCaseId: UUID_A,
  accountId: UUID_B,
  caseNumber: 1,
  status: 'IN_REVIEW',
  statusKey: trustVerificationStatusKey('IN_REVIEW'),
  submittedAt: ISO,
  updatedAt: ISO,
  requirementCount: 1,
  awaitingReviewCount: 1,
  ...over,
});

// ====================================================================== vocabularies
describe('vocabularies', () => {
  it.each([
    [
      'requirement types',
      TRUST_REQUIREMENT_TYPES,
      TrustRequirementType,
      ['IDENTITY', 'BACKGROUND_CHECK', 'LICENSE', 'INSURANCE', 'CERTIFICATION', 'BUSINESS_REGISTRATION', 'OTHER_DOCUMENT'],
    ],
    ['evidence kinds', TRUST_EVIDENCE_KINDS, TrustEvidenceKind, ['DOCUMENT', 'EXTERNAL']],
    ['definition statuses', TRUST_DEFINITION_STATUSES, TrustDefinitionStatus, ['INACTIVE', 'ACTIVE', 'RETIRED']],
    [
      'requirement statuses',
      TRUST_REQUIREMENT_STATUSES,
      TrustRequirementStatus,
      ['NOT_STARTED', 'PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'EXPIRED', 'NOT_REQUIRED'],
    ],
    ['case statuses', TRUST_CASE_STATUSES, TrustCaseStatus, ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED', 'CANCELLED']],
    [
      'overall statuses',
      TRUST_OVERALL_STATUSES,
      TrustOverallStatus,
      ['NOT_REQUIRED', 'NOT_STARTED', 'OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'],
    ],
    ['document statuses', TRUST_DOCUMENT_STATUSES, TrustDocumentStatus, ['UPLOAD_PENDING', 'ATTACHED', 'SUBMITTED', 'WITHDRAWN', 'ABANDONED']],
    ['scan statuses', TRUST_SCAN_STATUSES, TrustScanStatus, ['PENDING', 'CLEAN', 'INFECTED', 'ERROR']],
    ['review decisions', TRUST_REVIEW_DECISIONS, TrustReviewDecision, ['STARTED', 'APPROVED', 'REJECTED', 'ACTION_REQUIRED']],
    ['external statuses', TRUST_EXTERNAL_STATUSES, TrustExternalStatus, ['CREATED', 'PENDING', 'APPROVED', 'REJECTED', 'ERROR', 'CANCELLED']],
  ] as const)('%s are exactly the documented list, in order, and the enum accepts nothing else', (_n, list, schema, expected) => {
    expect([...list]).toEqual([...expected]);
    expect(schema.options).toEqual([...expected]);
    for (const v of expected) expect(ok(schema, v), v).toBe(true);
    for (const bad of ['', 'VERIFIED', 'approved', ' APPROVED', 'APPROVED ', null, 7, undefined]) expect(ok(schema, bad), String(bad)).toBe(false);
  });

  it('there is no `verified` flag and no REJECTED case: rejection belongs to a requirement', () => {
    expect(TRUST_CASE_STATUSES).not.toContain('REJECTED');
    expect(TRUST_OVERALL_STATUSES).not.toContain('REJECTED');
    expect(TRUST_OVERALL_STATUSES).not.toContain('VERIFIED');
    expect(TRUST_CASE_STATUSES).not.toContain('VERIFIED');
  });

  it('the overall statuses are the case statuses plus NOT_REQUIRED and NOT_STARTED, minus CANCELLED', () => {
    expect(sorted(TRUST_OVERALL_STATUSES)).toEqual(sorted([...TRUST_CASE_STATUSES.filter((s) => s !== 'CANCELLED'), 'NOT_REQUIRED', 'NOT_STARTED']));
  });

  it('every vocabulary equals the CHECK constraint of the migration (the contract cannot drift from the database)', () => {
    expect(checkList('ck_requirement_definitions__type')).toEqual([...TRUST_REQUIREMENT_TYPES]);
    expect(checkList('ck_document_types__requirement_type')).toEqual([...TRUST_REQUIREMENT_TYPES]);
    expect(checkList('ck_requirement_definitions__evidence_kind')).toEqual([...TRUST_EVIDENCE_KINDS]);
    expect(checkList('ck_requirement_definitions__status')).toEqual([...TRUST_DEFINITION_STATUSES]);
    expect(checkList('ck_case_requirements__status')).toEqual([...TRUST_REQUIREMENT_STATUSES]);
    expect(checkList('ck_verification_cases__status')).toEqual([...TRUST_CASE_STATUSES]);
    expect(checkList('ck_documents__status')).toEqual([...TRUST_DOCUMENT_STATUSES]);
    expect(checkList('ck_documents__scan')).toEqual([...TRUST_SCAN_STATUSES]);
    expect(checkList('ck_reviews__decision')).toEqual([...TRUST_REVIEW_DECISIONS]);
    expect(checkList('ck_external_verifications__status')).toEqual([...TRUST_EXTERNAL_STATUSES]);
  });

  it('the evidence-open statuses are exactly the states from which the provider may submit evidence, and each can move to PENDING', () => {
    expect([...TRUST_EVIDENCE_OPEN_STATUSES]).toEqual(['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED']);
    for (const s of TRUST_EVIDENCE_OPEN_STATUSES) expect(isTrustRequirementTransitionAllowed(s, 'PENDING'), s).toBe(true);
    // and no other state can move to PENDING
    for (const s of TRUST_REQUIREMENT_STATUSES.filter((x) => !(TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(x)))
      expect(isTrustRequirementTransitionAllowed(s, 'PENDING'), s).toBe(false);
  });

  it('reason codes: the seven seeded ones are valid, in the order of the migration, and nothing else is in the list', () => {
    expect([...TRUST_REASON_CODES]).toEqual(seededReasons);
    expect(seededReasons).toHaveLength(7);
    for (const c of TRUST_REASON_CODES) expect(ok(TrustReasonCode, c), c).toBe(true);
  });
  it('document type codes: the seven seeded ones, in the order of the migration', () => {
    expect([...TRUST_DOCUMENT_TYPE_CODES]).toEqual(seededDocumentTypes);
    expect(seededDocumentTypes).toHaveLength(7);
  });
  it('the seeded requirement definitions are the four of the design (only identity_verification is ACTIVE)', () => {
    expect(seededDefinitionCodes).toEqual(['identity_verification', 'background_check', 'professional_license', 'liability_insurance']);
    const active = [...migration.matchAll(/^ {2}\('([a-z_]+)', '[A-Z_]+', '(?:DOCUMENT|EXTERNAL)', (?:true|false), 'ACTIVE'\)/gm)].map((m) => m[1]);
    expect(active).toEqual(['identity_verification']);
  });
});

// ====================================================================== status machines
describe('requirement status machine', () => {
  const EXPECTED_ALLOWED = [
    'NOT_STARTED>PENDING',
    'NOT_STARTED>NOT_REQUIRED',
    'PENDING>IN_REVIEW',
    'PENDING>ACTION_REQUIRED',
    'PENDING>APPROVED',
    'PENDING>REJECTED',
    'PENDING>NOT_REQUIRED',
    'IN_REVIEW>ACTION_REQUIRED',
    'IN_REVIEW>APPROVED',
    'IN_REVIEW>REJECTED',
    'IN_REVIEW>NOT_REQUIRED',
    'ACTION_REQUIRED>PENDING',
    'ACTION_REQUIRED>NOT_REQUIRED',
    'REJECTED>PENDING',
    'REJECTED>NOT_REQUIRED',
    'APPROVED>EXPIRED',
    'NOT_REQUIRED>NOT_STARTED',
  ];
  const PAIRS = TRUST_REQUIREMENT_STATUSES.flatMap((f) => TRUST_REQUIREMENT_STATUSES.map((t) => `${f}>${t}` as const));
  it('covers all 64 pairs', () => {
    expect(PAIRS).toHaveLength(64);
    expect(new Set(PAIRS).size).toBe(64);
  });
  it.each(PAIRS)('%s', (pair) => {
    const [from, to] = pair.split('>') as [RequirementStatus, RequirementStatus];
    expect(isTrustRequirementTransitionAllowed(from, to)).toBe(EXPECTED_ALLOWED.includes(pair));
  });
  it('allows exactly the 17 transitions of the design', () => {
    const allowed = PAIRS.filter((p) => {
      const [f, t] = p.split('>') as [RequirementStatus, RequirementStatus];
      return isTrustRequirementTransitionAllowed(f, t);
    });
    expect(sorted(allowed)).toEqual(sorted(EXPECTED_ALLOWED));
    expect(allowed).toHaveLength(17);
  });
  it('is the same machine as the migration guard (the allowed pairs, character for character)', () => {
    const m = /'NOT_STARTED>PENDING'[^\]]*\]/.exec(migration);
    expect(m, 'transition array').not.toBeNull();
    const inMigration = [...m![0].matchAll(/'([A-Z_]+>[A-Z_]+)'/g)].map((x) => x[1]!);
    expect(sorted(inMigration)).toEqual(sorted(EXPECTED_ALLOWED));
  });
  it('EXPIRED is a dead end (a new CYCLE re-verifies it), APPROVED only expires, nothing is ever un-approved, no decision is undone', () => {
    for (const to of TRUST_REQUIREMENT_STATUSES) {
      expect(isTrustRequirementTransitionAllowed('EXPIRED', to), `EXPIRED>${to}`).toBe(false);
      expect(isTrustRequirementTransitionAllowed('APPROVED', to), `APPROVED>${to}`).toBe(to === 'EXPIRED');
    }
    expect(isTrustRequirementTransitionAllowed('REJECTED', 'APPROVED')).toBe(false);
    expect(isTrustRequirementTransitionAllowed('ACTION_REQUIRED', 'APPROVED')).toBe(false);
    expect(isTrustRequirementTransitionAllowed('PENDING', 'NOT_STARTED')).toBe(false);
  });
  it('no state transitions to itself', () => {
    for (const s of TRUST_REQUIREMENT_STATUSES) expect(isTrustRequirementTransitionAllowed(s, s), s).toBe(false);
  });
  it('every state can be reached from NOT_STARTED, and every state except EXPIRED can leave', () => {
    const reach = new Set<string>(['NOT_STARTED']);
    for (let i = 0; i < 10; i++)
      for (const f of [...reach]) for (const t of TRUST_REQUIREMENT_STATUSES) if (isTrustRequirementTransitionAllowed(f as RequirementStatus, t)) reach.add(t);
    expect(sorted([...reach])).toEqual(sorted(TRUST_REQUIREMENT_STATUSES));
    for (const s of TRUST_REQUIREMENT_STATUSES.filter((x) => x !== 'EXPIRED'))
      expect(
        TRUST_REQUIREMENT_STATUSES.some((t) => isTrustRequirementTransitionAllowed(s, t)),
        s,
      ).toBe(true);
  });
});

describe('requirement definition status machine', () => {
  const EXPECTED: Record<string, boolean> = {
    'INACTIVE>INACTIVE': false,
    'INACTIVE>ACTIVE': true,
    'INACTIVE>RETIRED': true,
    'ACTIVE>INACTIVE': true,
    'ACTIVE>ACTIVE': false,
    'ACTIVE>RETIRED': true,
    'RETIRED>INACTIVE': false,
    'RETIRED>ACTIVE': false,
    'RETIRED>RETIRED': false,
  };
  it.each(Object.entries(EXPECTED))('%s is %s', (pair, allowed) => {
    const [from, to] = pair.split('>') as [DefinitionStatus, DefinitionStatus];
    expect(isTrustDefinitionTransitionAllowed(from, to)).toBe(allowed);
  });
  it('covers all 9 pairs exactly once', () => {
    const all = TRUST_DEFINITION_STATUSES.flatMap((f) => TRUST_DEFINITION_STATUSES.map((t) => `${f}>${t}`));
    expect(sorted(Object.keys(EXPECTED))).toEqual(sorted(all));
  });
  it('is the same machine as the migration guard', () => {
    const m = /ARRAY\['INACTIVE>ACTIVE'[^\]]*\]/.exec(migration);
    expect(m).not.toBeNull();
    const pairs = [...m![0].matchAll(/'([A-Z]+>[A-Z]+)'/g)].map((x) => x[1]!);
    expect(sorted(pairs)).toEqual(
      sorted(
        Object.entries(EXPECTED)
          .filter(([, v]) => v)
          .map(([k]) => k),
      ),
    );
  });
  it('RETIRED is terminal', () => {
    for (const to of TRUST_DEFINITION_STATUSES) expect(isTrustDefinitionTransitionAllowed('RETIRED', to)).toBe(false);
  });
});

// ====================================================================== managed content keys
describe('managed content keys', () => {
  it('derive from the vocabulary in the documented shape', () => {
    expect(trustRequirementNameKey('identity_verification')).toBe('trust.requirement.identity_verification.name');
    expect(trustRequirementInstructionsKey('background_check')).toBe('trust.requirement.background_check.instructions');
    expect(trustDocumentTypeNameKey('state_id')).toBe('trust.document_type.state_id.name');
    // reason codes are UPPER_SNAKE, their keys are lower case
    expect(trustReasonNameKey('DOCUMENT_UNREADABLE')).toBe('trust.reason.document_unreadable.name');
    expect(trustRequirementStatusKey('ACTION_REQUIRED')).toBe('trust.verification.requirement_status.action_required');
    expect(trustVerificationStatusKey('IN_REVIEW')).toBe('trust.verification.status.in_review');
    expect(trustVerificationStatusKey('CANCELLED')).toBe('trust.verification.status.cancelled');
    expect(trustVerificationStatusKey('NOT_REQUIRED')).toBe('trust.verification.status.not_required');
    expect(trustDocumentStatusKey('UPLOAD_PENDING')).toBe('trust.verification.document_status.upload_pending');
    expect(trustScanStatusKey('INFECTED')).toBe('trust.verification.scan_status.infected');
    expect(trustErrorKey('STALE_ROUND')).toBe('trust.verification.error.stale_round');
  });

  const derived = {
    requirementKeys: seededDefinitionCodes.flatMap((c) => [trustRequirementNameKey(c), trustRequirementInstructionsKey(c)]),
    documentTypes: TRUST_DOCUMENT_TYPE_CODES.map(trustDocumentTypeNameKey),
    reasons: TRUST_REASON_CODES.map(trustReasonNameKey),
    requirementStatuses: TRUST_REQUIREMENT_STATUSES.map(trustRequirementStatusKey),
    statuses: [...new Set([...TRUST_OVERALL_STATUSES, ...TRUST_CASE_STATUSES])].map((s) => trustVerificationStatusKey(s)),
    documentStatuses: TRUST_DOCUMENT_STATUSES.map(trustDocumentStatusKey),
    scanStatuses: TRUST_SCAN_STATUSES.map(trustScanStatusKey),
    errors: TRUST_ERROR_CODES.map(trustErrorKey),
  };
  it('every key is a valid content key and no two helpers derive the same key', () => {
    const all = Object.values(derived).flat();
    for (const k of all) expect(ok(ContentKey, k), k).toBe(true);
    expect(new Set(all).size, 'distinct').toBe(all.length);
  });
  it('the migration seeds 97 entries, all distinct', () => {
    // 8 requirement + 7 document type + 7 reason + 8 requirement status + 8 status + 5 document status + 4 scan status + 25 errors + 25 page copy
    expect(seededKeys.length).toBe(97);
    expect(new Set(seededKeys).size).toBe(97);
  });
  it.each([
    ['trust.requirement', () => derived.requirementKeys],
    ['trust.document_type', () => derived.documentTypes],
    ['trust.reason', () => derived.reasons],
    ['trust.verification.requirement_status', () => derived.requirementStatuses],
    ['trust.verification.status', () => derived.statuses],
    ['trust.verification.document_status', () => derived.documentStatuses],
    ['trust.verification.scan_status', () => derived.scanStatuses],
    ['trust.verification.error', () => derived.errors],
  ] as const)('the keys of %s.* are EXACTLY the keys the migration seeds, in both directions', (prefix, keys) => {
    expect(sorted(keys())).toEqual(seeded(prefix));
  });
  it('the helper families together claim every seeded key except the 25 page copy rows', () => {
    const claimed = new Set(Object.values(derived).flat());
    const unclaimed = seededKeys.filter((k) => !claimed.has(k));
    expect(unclaimed).toHaveLength(25);
    for (const k of unclaimed) expect(k.startsWith('trust.verification.page.'), k).toBe(true);
    expect(seeded('trust.verification.page')).toHaveLength(25);
  });
  it('the generated content keys of the tables (definition, document type, reason) are the helpers', () => {
    expect(migration).toContain(`'trust.requirement.' || code || '.name'`);
    expect(migration).toContain(`'trust.requirement.' || code || '.instructions'`);
    expect(migration).toContain(`'trust.document_type.' || code || '.name'`);
    expect(migration).toContain(`'trust.reason.' || lower(code) || '.name'`);
  });
  it('the seed has no unexpected family', () => {
    const families = new Set(seededKeys.map((k) => k.split('.').slice(0, 2).join('.')));
    expect(sorted([...families])).toEqual(['trust.document_type', 'trust.reason', 'trust.requirement', 'trust.verification']);
  });
});

// ====================================================================== policy
describe('policy keys and TrustDocumentPolicy', () => {
  it('the six keys equal the parameters the migration seeds with their data types', () => {
    const seededParams = [...migration.matchAll(/\(\d,\s+'(trust\.[a-z_.]+)',\s+'([A-Z]+)'/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(sorted(seededParams)).toEqual(
      sorted([
        `${TRUST_POLICY_KEYS.maxSizeBytes}:INTEGER`,
        `${TRUST_POLICY_KEYS.allowedMimeTypes}:JSON`,
        `${TRUST_POLICY_KEYS.maxDocumentsPerRequirement}:INTEGER`,
        `${TRUST_POLICY_KEYS.uploadUrlTtlSeconds}:INTEGER`,
        `${TRUST_POLICY_KEYS.downloadUrlTtlSeconds}:INTEGER`,
        `${TRUST_POLICY_KEYS.requireCleanScan}:BOOLEAN`,
      ]),
    );
    expect(Object.values(TRUST_POLICY_KEYS)).toHaveLength(6);
  });
  it('the seeded defaults are a valid policy, and the seeded validation rules are the contract bounds', () => {
    for (const v of [
      "'10485760'::jsonb",
      `'["application/pdf", "image/jpeg", "image/png"]'::jsonb`,
      "'5'::jsonb",
      "'300'::jsonb",
      "'60'::jsonb",
      "'true'::jsonb",
    ])
      expect(migration, v).toContain(v);
    expect(ok(TrustDocumentPolicy, policy())).toBe(true);
    expect(migration).toContain(`{"min": 1024, "max": ${TRUST_DOCUMENT_SIZE_CEILING}}`);
    expect(migration).toContain('{"min": 1, "max": 20}');
    expect(migration).toContain('{"min": 60, "max": 3600}');
    expect(migration).toContain('{"min": 15, "max": 900}');
    expect(migration).toContain('"minItems": 1, "maxItems": 10');
  });
  it('the structural size ceiling is 50 MiB and equals the documents CHECK', () => {
    expect(TRUST_DOCUMENT_SIZE_CEILING).toBe(52_428_800);
    expect(migration).toContain('size_bytes BETWEEN 1 AND 52428800');
  });
  it('accepts the boundaries of every number', () => {
    for (const over of [
      { maxSizeBytes: 1024 },
      { maxSizeBytes: TRUST_DOCUMENT_SIZE_CEILING },
      { maxDocumentsPerRequirement: 1 },
      { maxDocumentsPerRequirement: 20 },
      { uploadUrlTtlSeconds: 60 },
      { uploadUrlTtlSeconds: 3600 },
      { downloadUrlTtlSeconds: 15 },
      { downloadUrlTtlSeconds: 900 },
      { requireCleanScan: false },
      { allowedMimeTypes: ['application/pdf'] },
      { allowedMimeTypes: Array.from({ length: 10 }, (_, i) => `image/t${i}`) },
    ])
      expect(ok(TrustDocumentPolicy, policy(over)), JSON.stringify(over)).toBe(true);
  });
  it.each<[string, Record<string, unknown>]>([
    ['size 1023', { maxSizeBytes: 1023 }],
    ['size above the ceiling', { maxSizeBytes: TRUST_DOCUMENT_SIZE_CEILING + 1 }],
    ['fractional size', { maxSizeBytes: 2048.5 }],
    ['string size', { maxSizeBytes: '10485760' }],
    ['NaN size', { maxSizeBytes: Number.NaN }],
    ['Infinity size', { maxSizeBytes: Number.POSITIVE_INFINITY }],
    ['null size', { maxSizeBytes: null }],
    ['zero documents', { maxDocumentsPerRequirement: 0 }],
    ['21 documents', { maxDocumentsPerRequirement: 21 }],
    ['fractional documents', { maxDocumentsPerRequirement: 2.5 }],
    ['upload ttl 59', { uploadUrlTtlSeconds: 59 }],
    ['upload ttl 3601', { uploadUrlTtlSeconds: 3601 }],
    ['download ttl 14', { downloadUrlTtlSeconds: 14 }],
    ['download ttl 901', { downloadUrlTtlSeconds: 901 }],
    ['string flag', { requireCleanScan: 'true' }],
    ['number flag', { requireCleanScan: 1 }],
    ['null flag', { requireCleanScan: null }],
    ['no mime types', { allowedMimeTypes: [] }],
    ['11 mime types', { allowedMimeTypes: Array.from({ length: 11 }, (_, i) => `image/t${i}`) }],
    ['duplicate mime types', { allowedMimeTypes: ['application/pdf', 'application/pdf'] }],
    ['upper-case mime type', { allowedMimeTypes: ['Application/PDF'] }],
    ['mime type with a parameter', { allowedMimeTypes: ['text/html; charset=utf-8'] }],
    ['mime type without a slash', { allowedMimeTypes: ['pdf'] }],
    ['mime type with a trailing newline', { allowedMimeTypes: ['application/pdf\n'] }],
    ['mime type over 100 characters', { allowedMimeTypes: [`a/${'b'.repeat(99)}`] }],
    ['mime types not an array', { allowedMimeTypes: 'application/pdf' }],
    ['unknown key', { extra: true }],
    ['a go-live flag', { goLive: true }],
  ])('rejects %s', (_n, over) => {
    expect(ok(TrustDocumentPolicy, policy(over))).toBe(false);
  });
  it('accepts a mime type of exactly 100 characters', () => {
    expect(ok(TrustDocumentPolicy, policy({ allowedMimeTypes: [`a/${'b'.repeat(98)}`] }))).toBe(true);
  });
  it.each(['maxSizeBytes', 'allowedMimeTypes', 'maxDocumentsPerRequirement', 'uploadUrlTtlSeconds', 'downloadUrlTtlSeconds', 'requireCleanScan'])(
    'rejects a policy without %s (no code default exists)',
    (k) => {
      const p: Record<string, unknown> = policy();
      delete p[k];
      expect(ok(TrustDocumentPolicy, p)).toBe(false);
    },
  );
  it.each([undefined, null, [], 'policy', 7, {}])('rejects %j as a policy', (v) => {
    expect(ok(TrustDocumentPolicy, v)).toBe(false);
  });
  it('reports the uniqueness message', () => {
    expect(JSON.stringify(TrustDocumentPolicy.safeParse(policy({ allowedMimeTypes: ['image/png', 'image/png'] })).error)).toContain(
      'MIME types must be unique',
    );
  });
});

// ====================================================================== requests
describe('requests are strict and carry no account, case, requirement or decision', () => {
  describe('body-less requests (open, cancel, reverify, external start and refresh)', () => {
    it.each([
      ['OpenVerificationRequest', OpenVerificationRequest],
      ['CancelVerificationRequest', CancelVerificationRequest],
      ['ReverifyRequirementRequest', ReverifyRequirementRequest],
      ['StartExternalVerificationRequest', StartExternalVerificationRequest],
    ] as const)('%s is exactly the empty object', (_n, schema) => {
      expect(ok(schema, {})).toBe(true);
      expect(Object.keys((schema as unknown as { shape: object }).shape)).toEqual([]);
      for (const v of [
        { accountId: UUID_A },
        { caseId: UUID_A },
        { verificationCaseId: UUID_A },
        { requirementCode: 'identity_verification' },
        { status: 'APPROVED' },
        { reason: 'x' },
        { approved: true },
        { x: 1 },
        null,
        undefined,
        [],
        'x',
        1,
      ])
        expect(ok(schema, v), JSON.stringify(v)).toBe(false);
    });
  });

  describe('RequestDocumentUploadRequest', () => {
    const base = { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 1234 };
    it('accepts a valid request and does not default anything', () => {
      expect(RequestDocumentUploadRequest.parse(base)).toEqual(base);
    });
    it('sizeBytes: 1 .. 50 MiB, integers only', () => {
      for (const sizeBytes of [1, 2, 1024, TRUST_DOCUMENT_SIZE_CEILING])
        expect(ok(RequestDocumentUploadRequest, { ...base, sizeBytes }), String(sizeBytes)).toBe(true);
      for (const sizeBytes of [0, -1, 1.5, TRUST_DOCUMENT_SIZE_CEILING + 1, Number.NaN, Number.POSITIVE_INFINITY, '1234', null, true, undefined])
        expect(ok(RequestDocumentUploadRequest, { ...base, sizeBytes }), String(sizeBytes)).toBe(false);
    });
    it('mimeType: lower-case type/subtype, no parameters, at most 100 characters', () => {
      for (const mimeType of ['application/pdf', 'image/jpeg', 'image/png', 'image/svg+xml', 'application/vnd.ms-excel', 'a/b', `a/${'b'.repeat(98)}`])
        expect(ok(RequestDocumentUploadRequest, { ...base, mimeType }), mimeType).toBe(true);
      for (const mimeType of [
        '',
        'pdf',
        '/pdf',
        'application/',
        'Application/pdf',
        'application/PDF',
        'application/pdf; charset=utf-8',
        'application/pdf ',
        ' application/pdf',
        'application/pdf\n',
        'application//pdf',
        'application/pdf/x',
        '1pdf/pdf',
        'app_lication/pdf',
        `a/${'b'.repeat(99)}`,
        7,
        null,
        ['application/pdf'],
      ])
        expect(ok(RequestDocumentUploadRequest, { ...base, mimeType }), JSON.stringify(mimeType)).toBe(false);
    });
    it('requirementCode and documentTypeCode are catalogue codes (2..48, lower snake)', () => {
      for (const k of ['requirementCode', 'documentTypeCode'] as const) {
        for (const v of ['ab', 'drivers_license', `a${'b'.repeat(CATALOG_CODE_MAX - 1)}`])
          expect(ok(RequestDocumentUploadRequest, { ...base, [k]: v }), `${k} ${v}`).toBe(true);
        for (const v of [
          '',
          'a',
          'Drivers_License',
          'drivers-license',
          'drivers__license',
          '1abc',
          'abc_',
          'a b',
          `a${'b'.repeat(CATALOG_CODE_MAX)}`,
          7,
          null,
          undefined,
        ])
          expect(ok(RequestDocumentUploadRequest, { ...base, [k]: v }), `${k} ${JSON.stringify(v)}`).toBe(false);
      }
    });
    it.each(['requirementCode', 'documentTypeCode', 'mimeType', 'sizeBytes'])('requires %s', (k) => {
      const b: Record<string, unknown> = { ...base };
      delete b[k];
      expect(ok(RequestDocumentUploadRequest, b)).toBe(false);
      expect(issuePaths(RequestDocumentUploadRequest, b)).toEqual([k]);
    });
    it.each<[string, Record<string, unknown>]>([
      ['an account id', { accountId: UUID_A }],
      ['a case id', { verificationCaseId: UUID_A }],
      ['a case requirement id', { caseRequirementId: UUID_A }],
      ['an object key', { objectKey: 'trust/evidence/x/y' }],
      ['a hash', { sha256: SHA }],
      ['a status', { status: 'ATTACHED' }],
      ['a scan status', { scanStatus: 'CLEAN' }],
      ['a round', { round: 1 }],
      ['a file name', { fileName: 'id.pdf' }],
    ])('rejects %s', (_n, extra) => {
      expect(ok(RequestDocumentUploadRequest, { ...base, ...extra })).toBe(false);
    });
    it.each([null, undefined, [], 'x', 7, true])('rejects %j as a body', (v) => {
      expect(ok(RequestDocumentUploadRequest, v)).toBe(false);
    });
  });

  describe('FinalizeDocumentRequest', () => {
    it('accepts {} and a lower-case 64-digit hex SHA-256', () => {
      expect(ok(FinalizeDocumentRequest, {})).toBe(true);
      expect(ok(FinalizeDocumentRequest, { sha256: SHA })).toBe(true);
      expect(ok(FinalizeDocumentRequest, { sha256: '0123456789abcdef'.repeat(4) })).toBe(true);
      expect(FinalizeDocumentRequest.parse({})).toEqual({});
    });
    it.each<[string, unknown]>([
      ['63 digits', { sha256: 'a'.repeat(63) }],
      ['65 digits', { sha256: 'a'.repeat(65) }],
      ['upper case', { sha256: 'A'.repeat(64) }],
      ['mixed case', { sha256: `${'a'.repeat(63)}F` }],
      ['a non-hex digit', { sha256: `${'a'.repeat(63)}g` }],
      ['a prefix', { sha256: `sha256:${SHA}` }],
      ['a trailing newline', { sha256: `${SHA}\n` }],
      ['a leading space', { sha256: ` ${SHA}` }],
      ['empty', { sha256: '' }],
      ['null', { sha256: null }],
      ['a number', { sha256: 7 }],
      ['an array', { sha256: [SHA] }],
      ['a size', { sha256: SHA, sizeBytes: 5 }],
      ['a status', { status: 'ATTACHED' }],
      ['a scan status', { scanStatus: 'CLEAN' }],
      ['an account id', { accountId: UUID_A }],
      ['null body', null],
      ['array body', []],
    ])('rejects %s', (_n, v) => {
      expect(ok(FinalizeDocumentRequest, v)).toBe(false);
    });
  });

  describe('SubmitVerificationRequest', () => {
    it('requires expectedRevision (a submit names the revision it read), 1 .. int4', () => {
      expect(ok(SubmitVerificationRequest, { expectedRevision: 1 })).toBe(true);
      expect(ok(SubmitVerificationRequest, { expectedRevision: 2_147_483_647 })).toBe(true);
      expect(ok(SubmitVerificationRequest, {})).toBe(false);
      expect(issuePaths(SubmitVerificationRequest, {})).toEqual(['expectedRevision']);
    });
    it.each<[string, unknown]>([
      ['zero', { expectedRevision: 0 }],
      ['negative', { expectedRevision: -1 }],
      ['fractional', { expectedRevision: 1.5 }],
      ['over int4', { expectedRevision: 2_147_483_648 }],
      ['string', { expectedRevision: '1' }],
      ['null', { expectedRevision: null }],
      ['NaN', { expectedRevision: Number.NaN }],
      ['Infinity', { expectedRevision: Number.POSITIVE_INFINITY }],
      ['an account id', { expectedRevision: 1, accountId: UUID_A }],
      ['a case id', { expectedRevision: 1, verificationCaseId: UUID_A }],
      ['a status', { expectedRevision: 1, status: 'APPROVED' }],
      ['an approved flag', { expectedRevision: 1, approved: true }],
      ['null body', null],
      ['array body', [1]],
    ])('rejects %s', (_n, v) => {
      expect(ok(SubmitVerificationRequest, v)).toBe(false);
    });
  });

  describe('StartReviewRequest', () => {
    it('requires the evidence round, 1 .. 10000', () => {
      for (const round of [1, 2, 9_999, 10_000]) expect(ok(StartReviewRequest, { round }), String(round)).toBe(true);
      expect(ok(StartReviewRequest, {})).toBe(false);
      for (const round of [0, -1, 10_001, 1.5, '1', null, true, Number.NaN, Number.POSITIVE_INFINITY])
        expect(ok(StartReviewRequest, { round }), String(round)).toBe(false);
    });
    it.each<[string, Record<string, unknown>]>([
      ['a decision', { decision: 'APPROVED' }],
      ['a reason', { reasonCode: 'DOCUMENT_UNREADABLE' }],
      ['a reviewer', { reviewer: 'admin:x' }],
      ['an account id', { accountId: UUID_A }],
      ['expiresAt', { expiresAt: ISO }],
    ])('rejects %s', (_n, extra) => {
      expect(ok(StartReviewRequest, { round: 1, ...extra })).toBe(false);
    });
  });

  describe('ApproveRequirementRequest', () => {
    it('round is required; expiresAt is optional and never defaulted', () => {
      expect(ApproveRequirementRequest.parse({ round: 1 })).toEqual({ round: 1 });
      expect(ok(ApproveRequirementRequest, {})).toBe(false);
      expect(issuePaths(ApproveRequirementRequest, {})).toEqual(['round']);
    });
    it('expiresAt is an ISO-8601 date-time WITH a zone (Z or an offset)', () => {
      for (const expiresAt of [
        '2027-01-01T00:00:00Z',
        '2027-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.123456Z',
        '2027-01-01T12:30:00+02:00',
        '2027-01-01T12:30:00-08:00',
        '2027-12-31T23:59:59Z',
        '2028-02-29T00:00:00Z',
      ])
        expect(ok(ApproveRequirementRequest, { round: 1, expiresAt }), expiresAt).toBe(true);
      for (const expiresAt of [
        '2027-01-01',
        '2027-01-01T00:00:00',
        '2027-01-01 00:00:00Z',
        '2027-13-01T00:00:00Z',
        '2027-02-30T00:00:00Z',
        '2027-01-01T25:00:00Z',
        '2027-01-01T00:60:00Z',
        '2027-01-01T00:00:00Z ',
        ' 2027-01-01T00:00:00Z',
        '2027-01-01T00:00:00Z\n',
        '2027-01-01T00:00:00+2:00',
        'tomorrow',
        '1767225600',
        '',
        1767225600,
        null,
        true,
        ['2027-01-01T00:00:00Z'],
        {},
      ])
        expect(ok(ApproveRequirementRequest, { round: 1, expiresAt }), JSON.stringify(expiresAt)).toBe(false);
    });
    it('rejects an expiresAt of null (absent means the definition default; null is not a value)', () => {
      expect(ok(ApproveRequirementRequest, { round: 1, expiresAt: null })).toBe(false);
    });
    it.each<[string, Record<string, unknown>]>([
      ['a round of 0', { round: 0 }],
      ['a round over 10000', { round: 10_001 }],
      ['a string round', { round: '1' }],
      ['a reason code', { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }],
      ['a decision', { round: 1, decision: 'APPROVED' }],
      ['a reviewer', { round: 1, reviewer: 'admin:x' }],
      ['an account id', { round: 1, accountId: UUID_A }],
      ['a case status', { round: 1, status: 'APPROVED' }],
    ])('rejects %s', (_n, v) => {
      expect(ok(ApproveRequirementRequest, v)).toBe(false);
    });
  });

  describe.each([
    ['RejectRequirementRequest', RejectRequirementRequest],
    ['RequestActionRequest', RequestActionRequest],
  ] as const)('%s', (_n, schema) => {
    it('requires round and reasonCode (a decision without a structured reason is not a decision)', () => {
      expect(ok(schema, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' })).toBe(true);
      expect(ok(schema, { round: 1 })).toBe(false);
      expect(ok(schema, { reasonCode: 'DOCUMENT_UNREADABLE' })).toBe(false);
      expect(ok(schema, {})).toBe(false);
      expect(issuePaths(schema, {}).sort()).toEqual(['reasonCode', 'round']);
    });
    it('reasonCode: UPPER_SNAKE, 3..48 characters', () => {
      for (const reasonCode of ['ABC', 'A1B', 'DOCUMENT_UNREADABLE', 'A_B', 'A1_B2_C3', `A${'B'.repeat(47)}`])
        expect(ok(schema, { round: 1, reasonCode }), reasonCode).toBe(true);
      for (const reasonCode of [
        '',
        'AB',
        'A',
        `A${'B'.repeat(48)}`,
        'document_unreadable',
        'Document_Unreadable',
        'DOCUMENT-UNREADABLE',
        'DOCUMENT__UNREADABLE',
        'DOCUMENT_',
        '_DOCUMENT',
        '1DOCUMENT',
        'DOCUMENT UNREADABLE',
        'DOCUMENT_UNREADABLE\n',
        ' DOCUMENT_UNREADABLE',
        'DÖCUMENT',
        7,
        null,
        ['DOCUMENT_UNREADABLE'],
      ])
        expect(ok(schema, { round: 1, reasonCode }), JSON.stringify(reasonCode)).toBe(false);
    });
    it('accepts a free-text note? No: free text would land in the immutable audit trail', () => {
      for (const extra of [
        { note: 'x' },
        { reason: 'x' },
        { comment: 'x' },
        { message: 'x' },
        { expiresAt: ISO },
        { decision: 'REJECTED' },
        { accountId: UUID_A },
      ])
        expect(ok(schema, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE', ...extra }), JSON.stringify(extra)).toBe(false);
    });
    it('rejects bad rounds', () => {
      for (const round of [0, -1, 10_001, 1.5, '1', null]) expect(ok(schema, { round, reasonCode: 'DOCUMENT_UNREADABLE' }), String(round)).toBe(false);
    });
  });

  describe('TrustReasonCode', () => {
    it('is the same pattern and length as the reason_codes CHECK', () => {
      expect(migration).toContain(`code ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$' AND length(code) BETWEEN 3 AND 48`);
      expect(ok(TrustReasonCode, 'ABC')).toBe(true);
      expect(ok(TrustReasonCode, 'AB')).toBe(false);
    });
  });

  describe('SetRequirementStatusRequest', () => {
    it('takes exactly one definition status', () => {
      for (const status of TRUST_DEFINITION_STATUSES) expect(ok(SetRequirementStatusRequest, { status }), status).toBe(true);
      for (const v of [
        {},
        { status: 'active' },
        { status: 'DELETED' },
        { status: 'NOT_REQUIRED' },
        { status: null },
        { status: 'ACTIVE', reason: 'x' },
        { status: 'ACTIVE', code: 'x' },
        null,
        [],
      ])
        expect(ok(SetRequirementStatusRequest, v), JSON.stringify(v)).toBe(false);
    });
  });

  describe('SetRequirementRuleRequest', () => {
    const base = { requirementCode: 'identity_verification', marketCode: 'us-sf', serviceTypeCode: 'car_detailing', enabled: true };
    it('accepts a market and a service type, either or both null (= all), and both flag values', () => {
      expect(ok(SetRequirementRuleRequest, base)).toBe(true);
      expect(ok(SetRequirementRuleRequest, { ...base, marketCode: null })).toBe(true);
      expect(ok(SetRequirementRuleRequest, { ...base, serviceTypeCode: null })).toBe(true);
      expect(ok(SetRequirementRuleRequest, { ...base, marketCode: null, serviceTypeCode: null })).toBe(true);
      expect(ok(SetRequirementRuleRequest, { ...base, enabled: false })).toBe(true);
    });
    it('marketCode and serviceTypeCode are NULLABLE but REQUIRED: absent is not "all"', () => {
      const noMarket: Record<string, unknown> = { ...base };
      delete noMarket.marketCode;
      const noService: Record<string, unknown> = { ...base };
      delete noService.serviceTypeCode;
      expect(ok(SetRequirementRuleRequest, noMarket)).toBe(false);
      expect(issuePaths(SetRequirementRuleRequest, noMarket)).toEqual(['marketCode']);
      expect(ok(SetRequirementRuleRequest, noService)).toBe(false);
      expect(issuePaths(SetRequirementRuleRequest, noService)).toEqual(['serviceTypeCode']);
      expect(ok(SetRequirementRuleRequest, { ...base, marketCode: undefined })).toBe(false);
    });
    it('enabled must be a boolean', () => {
      for (const enabled of ['true', 1, 0, null, undefined]) expect(ok(SetRequirementRuleRequest, { ...base, enabled }), String(enabled)).toBe(false);
    });
    it('the market is a market code (lower-case kebab, at most 60), the service type a catalogue code', () => {
      for (const marketCode of ['us-sf', 'a', 'la-oc', `a${'b'.repeat(59)}`])
        expect(ok(SetRequirementRuleRequest, { ...base, marketCode }), marketCode).toBe(true);
      for (const marketCode of ['', 'US-SF', 'us_sf', 'us-', '-us', '1us', 'us sf', `a${'b'.repeat(60)}`, 'us-sf\n', 7, []])
        expect(ok(SetRequirementRuleRequest, { ...base, marketCode }), JSON.stringify(marketCode)).toBe(false);
      for (const serviceTypeCode of ['', 'a', 'Car', 'car-detailing', 'car__x', `a${'b'.repeat(CATALOG_CODE_MAX)}`, 7, []])
        expect(ok(SetRequirementRuleRequest, { ...base, serviceTypeCode }), JSON.stringify(serviceTypeCode)).toBe(false);
      for (const requirementCode of ['', 'a', 'Identity', 'identity-verification', null, undefined])
        expect(ok(SetRequirementRuleRequest, { ...base, requirementCode }), JSON.stringify(requirementCode)).toBe(false);
    });
    it('rejects unknown keys (an id, a status, a reason)', () => {
      for (const extra of [{ requirementRuleId: UUID_A }, { status: 'ACTIVE' }, { reason: 'x' }, { accountId: UUID_A }, { expiryRequired: true }])
        expect(ok(SetRequirementRuleRequest, { ...base, ...extra }), JSON.stringify(extra)).toBe(false);
    });
  });
});

// ====================================================================== read models
describe('read models', () => {
  it('the provider document DTO has exactly the eleven documented keys: no object key, no hash, no url', () => {
    expect(shapeKeys(VerificationDocumentDto)).toEqual(
      [
        'createdAt',
        'documentTypeCode',
        'documentTypeNameKey',
        'mimeType',
        'round',
        'scanStatus',
        'scanStatusKey',
        'sizeBytes',
        'status',
        'statusKey',
        'submittedAt',
        'verificationDocumentId',
      ].sort(),
    );
  });
  it('NO provider-facing schema reaches an object key, a hash, a url, a file name or a body; the url exists only in the upload authorization and the reviewer download', () => {
    const forbidden = /sha|hash|objectKey|object_key|bucket|storageKey|fileName|filename|^bytes$|^content$|body|payload/i;
    const providerSchemas = {
      ProviderVerificationDto,
      VerificationDocumentDto,
      VerificationRequirementDto,
      VerificationCaseDto,
      VerificationDocumentListResponse,
      ExternalVerificationDto,
    };
    for (const [n, s] of Object.entries(providerSchemas))
      for (const p of allPaths(s)) {
        const leaf = p.split('.').pop()!;
        expect(leaf, `${n}.${p}`).not.toMatch(forbidden);
        expect(leaf, `${n}.${p}`).not.toBe('url');
        expect(leaf, `${n}.${p}`).not.toBe('key');
      }
    expect(allPaths(DocumentUploadAuthorizationDto).filter((p) => p.endsWith('url'))).toEqual(['upload.url']);
    expect(sorted(allPaths(TrustDownloadDto))).toEqual(['expiresAt', 'url']);
    // and nothing personal: the case carries no name, e-mail or phone for either audience
    for (const s of [ProviderVerificationDto, TrustCaseDetailDto, TrustCaseSummaryDto, TrustPolicyDto])
      for (const p of allPaths(s)) expect(p.split('.').pop()!, p).not.toMatch(/^(email|phone|firstName|lastName|name|address|subject)$/i);
  });
  it('the hash exists on the reviewer document only', () => {
    expect(shapeKeys(TrustAdminDocumentDto)).toEqual([...shapeKeys(VerificationDocumentDto), 'sha256'].sort());
    expect(allPaths(ProviderVerificationDto).some((p) => /sha256/.test(p))).toBe(false);
    expect(allPaths(TrustCaseDetailDto).filter((p) => /sha256/.test(p))).toEqual(['requirements.documents.sha256']);
    expect(ok(TrustAdminDocumentDto, { ...document(), sha256: SHA })).toBe(true);
    expect(ok(TrustAdminDocumentDto, { ...document(), sha256: null })).toBe(true);
    expect(ok(TrustAdminDocumentDto, document())).toBe(false);
  });
  it('shape keys of the other views', () => {
    expect(shapeKeys(VerificationCaseDto)).toEqual(['caseNumber', 'openedAt', 'revision', 'status', 'statusKey', 'submittedAt', 'verificationCaseId']);
    expect(shapeKeys(ProviderVerificationDto)).toEqual(['case', 'goLive', 'overall', 'prerequisiteMet', 'requirements']);
    expect(shapeKeys(VerificationRequirementDto)).toEqual(
      [
        'canAttachEvidence',
        'canReverify',
        'caseRequirementId',
        'cycle',
        'documentTypes',
        'documents',
        'evidenceKind',
        'expiresAt',
        'instructionsKey',
        'nameKey',
        'reasonCode',
        'reasonKey',
        'requirementCode',
        'requirementType',
        'round',
        'status',
        'statusKey',
      ].sort(),
    );
    expect(shapeKeys(DocumentUploadAuthorizationDto)).toEqual(['document', 'upload']);
    expect(shapeKeys(defOf(DocumentUploadAuthorizationDto).shape!.upload)).toEqual(['expiresAt', 'headers', 'method', 'url']);
    expect(shapeKeys(TrustReviewDto)).toEqual(['decision', 'expiresAt', 'reasonCode', 'reasonKey', 'reviewId', 'reviewedAt', 'reviewer', 'round']);
    expect(shapeKeys(TrustAdminRequirementDto)).toEqual(
      [
        'approvedAt',
        'caseRequirementId',
        'cycle',
        'documents',
        'evidenceKind',
        'expiresAt',
        'external',
        'nameKey',
        'requirementCode',
        'requirementType',
        'reviews',
        'round',
        'status',
        'statusKey',
        'superseded',
      ].sort(),
    );
    expect(shapeKeys(TrustCaseSummaryDto)).toEqual(
      ['accountId', 'awaitingReviewCount', 'caseNumber', 'requirementCount', 'status', 'statusKey', 'submittedAt', 'updatedAt', 'verificationCaseId'].sort(),
    );
    expect(shapeKeys(defOf(TrustCaseDetailDto).shape!.case)).toEqual([...shapeKeys(TrustCaseSummaryDto), 'decidedAt', 'openedAt', 'revision'].sort());
    expect(shapeKeys(TrustRequirementDecisionDto)).toEqual(['caseStatus', 'changed', 'requirement']);
    expect(shapeKeys(ExternalVerificationDto)).toEqual(['adapter', 'lastCheckedAt', 'requirementCode', 'status']);
    expect(shapeKeys(TrustPolicyDto)).toEqual(['documentTypes', 'requirements', 'rules']);
  });
  it('accepts the shapes the mappers produce', () => {
    expect(ok(VerificationDocumentDto, document())).toBe(true);
    expect(ok(VerificationDocumentDto, document({ status: 'SUBMITTED', round: 2, submittedAt: ISO }))).toBe(true);
    expect(ok(VerificationRequirementDto, requirement())).toBe(true);
    expect(ok(VerificationRequirementDto, requirement({ caseRequirementId: null, cycle: 0 }))).toBe(true);
    expect(ok(ProviderVerificationDto, verification())).toBe(true);
    expect(ok(ProviderVerificationDto, verification({ case: null }))).toBe(true);
    expect(ok(ProviderVerificationResponse, { data: verification(), meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(ProviderVerificationResponse, { data: verification() })).toBe(false);
    expect(ok(VerificationDocumentResponse, { data: document(), meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(VerificationDocumentListResponse, { data: [document(), document()], meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(VerificationDocumentListResponse, { data: document(), meta: { correlationId: 'c' } })).toBe(false);
    const upload = {
      document: document({ status: 'UPLOAD_PENDING', scanStatus: 'PENDING' }),
      upload: { method: 'PUT', url: 'https://x.example/u', headers: { 'content-type': 'application/pdf' }, expiresAt: ISO },
    };
    expect(ok(DocumentUploadAuthorizationDto, upload)).toBe(true);
    expect(ok(DocumentUploadAuthorizationResponse, { data: upload, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(DocumentUploadAuthorizationDto, { ...upload, upload: { ...upload.upload, method: 'POST' } })).toBe(false);
    expect(ok(DocumentUploadAuthorizationDto, { ...upload, upload: { ...upload.upload, headers: { a: 1 } } })).toBe(false);
  });
  it('rejects an invalid vocabulary value anywhere', () => {
    expect(ok(VerificationDocumentDto, document({ status: 'DONE' }))).toBe(false);
    expect(ok(VerificationDocumentDto, document({ scanStatus: 'OK' }))).toBe(false);
    expect(ok(VerificationDocumentDto, document({ sizeBytes: 1.5 }))).toBe(false);
    expect(ok(VerificationDocumentDto, document({ round: undefined }))).toBe(false);
    expect(ok(VerificationRequirementDto, requirement({ status: 'VERIFIED' }))).toBe(false);
    expect(ok(VerificationRequirementDto, requirement({ requirementType: 'SELFIE' }))).toBe(false);
    expect(ok(VerificationRequirementDto, requirement({ evidenceKind: 'PHOTO' }))).toBe(false);
    expect(ok(ProviderVerificationDto, verification({ case: { ...verification().case, status: 'REJECTED' } }))).toBe(false);
    expect(ok(ProviderVerificationDto, verification({ overall: { ...verification().overall, status: 'CANCELLED' } }))).toBe(false);
    expect(ok(ProviderVerificationDto, verification({ prerequisiteMet: 'yes' }))).toBe(false);
  });
  it('the provider overview offers no `verified` flag: verificationComplete is DERIVED and goLive can only be the literal false pair', () => {
    expect(allPaths(ProviderVerificationDto).some((p) => /^(verified|isVerified|live|isLive)$/i.test(p.split('.').pop()!))).toBe(false);
    for (const goLive of [
      { evaluated: true, eligible: false },
      { evaluated: false, eligible: true },
      { evaluated: true, eligible: true },
      { evaluated: 'false', eligible: false },
      { evaluated: false },
      {},
      null,
    ])
      expect(ok(ProviderVerificationDto, verification({ goLive })), JSON.stringify(goLive)).toBe(false);
    expect(ok(ProviderVerificationDto, verification({ goLive: { evaluated: false, eligible: false } }))).toBe(true);
  });
  it('the response serializer drops unknown keys instead of passing them on (an object key or a hash can never ride along)', () => {
    const parsed = VerificationDocumentDto.parse({ ...document(), sha256: SHA, objectKey: 'trust/evidence/x/y', url: 'https://x.example' });
    expect(Object.keys(parsed).sort()).toEqual(shapeKeys(VerificationDocumentDto));
  });
  it('reviewer views', () => {
    expect(ok(TrustCaseSummaryDto, summary())).toBe(true);
    expect(ok(TrustCaseListResponse, { data: [summary()], meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(TrustAdminRequirementDto, adminRequirement())).toBe(true);
    expect(
      ok(
        TrustAdminRequirementDto,
        adminRequirement({ external: { requirementCode: 'background_check', adapter: 'fake', status: 'PENDING', lastCheckedAt: null } }),
      ),
    ).toBe(true);
    const review = {
      reviewId: UUID_A,
      round: 1,
      decision: 'REJECTED',
      reasonCode: 'DOCUMENT_UNREADABLE',
      reasonKey: trustReasonNameKey('DOCUMENT_UNREADABLE'),
      reviewer: 'admin:sub-1',
      expiresAt: null,
      reviewedAt: ISO,
    };
    expect(ok(TrustReviewDto, review)).toBe(true);
    expect(ok(TrustReviewDto, { ...review, decision: 'VERIFIED' })).toBe(false);
    expect(ok(TrustAdminRequirementDto, adminRequirement({ reviews: [review] }))).toBe(true);
    expect(ok(TrustAdminRequirementDto, adminRequirement({ documents: [document()] }))).toBe(false);
    const detail = { case: { ...summary(), revision: 3, openedAt: ISO, decidedAt: null }, requirements: [adminRequirement()] };
    expect(ok(TrustCaseDetailDto, detail)).toBe(true);
    expect(ok(TrustCaseDetailResponse, { data: detail, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(TrustCaseDetailDto, { ...detail, case: summary() })).toBe(false);
    const decision = { requirement: adminRequirement(), caseStatus: 'IN_REVIEW', changed: true };
    expect(ok(TrustRequirementDecisionDto, decision)).toBe(true);
    expect(ok(TrustRequirementDecisionResponse, { data: decision, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(TrustRequirementDecisionDto, { ...decision, caseStatus: 'REJECTED' })).toBe(false);
    expect(ok(TrustRequirementDecisionDto, { ...decision, changed: 'yes' })).toBe(false);
    expect(ok(TrustDownloadDto, { url: 'https://x.example/d', expiresAt: ISO })).toBe(true);
    expect(ok(TrustDownloadResponse, { data: { url: 'https://x.example/d', expiresAt: ISO }, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(TrustDownloadDto, { url: 'https://x.example/d' })).toBe(false);
  });
  it('the summary names an internal account id and nothing about the person', () => {
    expect(shapeKeys(TrustCaseSummaryDto)).toContain('accountId');
    expect(ok(TrustCaseSummaryDto, summary({ accountId: 7 }))).toBe(false);
  });
  it('the policy view', () => {
    const view = {
      requirements: [
        {
          code: 'identity_verification',
          requirementType: 'IDENTITY',
          evidenceKind: 'DOCUMENT',
          expiryRequired: false,
          status: 'ACTIVE',
          nameKey: trustRequirementNameKey('identity_verification'),
        },
      ],
      rules: [
        { requirementCode: 'identity_verification', marketCode: null, serviceTypeCode: null, enabled: true },
        { requirementCode: 'identity_verification', marketCode: 'us-sf', serviceTypeCode: 'car_detailing', enabled: false },
      ],
      documentTypes: [{ code: 'drivers_license', requirementType: 'IDENTITY', nameKey: trustDocumentTypeNameKey('drivers_license') }],
    };
    expect(ok(TrustPolicyDto, view)).toBe(true);
    expect(ok(TrustPolicyResponse, { data: view, meta: { correlationId: 'c' } })).toBe(true);
    expect(ok(TrustPolicyDto, { ...view, requirements: [{ ...view.requirements[0], status: 'DELETED' }] })).toBe(false);
    expect(ok(TrustPolicyDto, { ...view, rules: [{ requirementCode: 'x', enabled: true }] })).toBe(false);
  });
  it('the external verification view carries only the adapter, the status snapshot and the check time', () => {
    expect(ok(ExternalVerificationDto, { requirementCode: 'background_check', adapter: 'fake', status: 'PENDING', lastCheckedAt: null })).toBe(true);
    expect(ok(ExternalVerificationDto, { requirementCode: 'background_check', adapter: 'fake', status: 'CLEARED', lastCheckedAt: null })).toBe(false);
  });
});

// ====================================================================== events
describe('events', () => {
  it('are exactly seven, versioned, in the trust domain', () => {
    expect(TRUST_EVENTS).toEqual({
      caseOpened: 'bananagig.trust.verification-case-opened.v1',
      submitted: 'bananagig.trust.verification-submitted.v1',
      requirementApproved: 'bananagig.trust.verification-requirement-approved.v1',
      requirementRejected: 'bananagig.trust.verification-requirement-rejected.v1',
      actionRequired: 'bananagig.trust.verification-action-required.v1',
      expired: 'bananagig.trust.verification-expired.v1',
      completed: 'bananagig.trust.verification-completed.v1',
    });
    for (const t of Object.values(TRUST_EVENTS)) expect(t).toMatch(EVENT_TYPE_PATTERN);
    expect(new Set(Object.values(TRUST_EVENTS)).size).toBe(7);
  });
  it('the case payload carries identifiers, the number and the case status only', () => {
    const base = { accountId: UUID_A, verificationCaseId: UUID_B, caseNumber: 1, status: 'OPEN' };
    expect(ok(TrustCaseEventPayload, base)).toBe(true);
    expect(shapeKeys(TrustCaseEventPayload)).toEqual(['accountId', 'caseNumber', 'status', 'verificationCaseId']);
    for (const status of TRUST_CASE_STATUSES) expect(ok(TrustCaseEventPayload, { ...base, status }), status).toBe(true);
    expect(ok(TrustCaseEventPayload, { ...base, status: 'VERIFIED' })).toBe(false);
    expect(ok(TrustCaseEventPayload, { ...base, caseNumber: 1.5 })).toBe(false);
    expect(ok(TrustCaseEventPayload, { accountId: UUID_A, verificationCaseId: UUID_B, caseNumber: 1 })).toBe(false);
  });
  it('the requirement payload adds the requirement, its type, its status and the reason code (nullable) and nothing else', () => {
    expect(shapeKeys(TrustRequirementEventPayload)).toEqual(
      [
        'accountId',
        'caseNumber',
        'caseRequirementId',
        'reasonCode',
        'requirementCode',
        'requirementStatus',
        'requirementType',
        'status',
        'verificationCaseId',
      ].sort(),
    );
    const base = {
      accountId: UUID_A,
      verificationCaseId: UUID_B,
      caseNumber: 1,
      status: 'ACTION_REQUIRED',
      caseRequirementId: UUID_A,
      requirementCode: 'identity_verification',
      requirementType: 'IDENTITY',
      requirementStatus: 'ACTION_REQUIRED',
      reasonCode: 'DOCUMENT_UNREADABLE',
    };
    expect(ok(TrustRequirementEventPayload, base)).toBe(true);
    expect(ok(TrustRequirementEventPayload, { ...base, reasonCode: null })).toBe(true);
    const noReason: Record<string, unknown> = { ...base };
    delete noReason.reasonCode;
    expect(ok(TrustRequirementEventPayload, noReason)).toBe(false);
    expect(ok(TrustRequirementEventPayload, { ...base, requirementStatus: 'VERIFIED' })).toBe(false);
    expect(ok(TrustRequirementEventPayload, { ...base, requirementType: 'SELFIE' })).toBe(false);
  });
  it('no payload can carry a document, a hash, a key, a url, a contact or a name', () => {
    const forbidden = /sha|hash|objectKey|url|key$|email|phone|name$|body|content|file/i;
    for (const s of [TrustCaseEventPayload, TrustRequirementEventPayload]) for (const p of allPaths(s)) expect(p, p).not.toMatch(forbidden);
  });
});

// ====================================================================== errors
describe('TRUST_ERROR_CODES', () => {
  it('is exactly the documented list of 25, in order, without duplicates', () => {
    expect([...TRUST_ERROR_CODES]).toEqual([
      'NOT_FOUND',
      'ACCOUNT_NOT_ACTIVE',
      'PREREQUISITE_NOT_MET',
      'REQUIREMENT_NOT_APPLICABLE',
      'DOCUMENT_TYPE_NOT_ACCEPTED',
      'MIME_NOT_ALLOWED',
      'FILE_TOO_LARGE',
      'TOO_MANY_DOCUMENTS',
      'EVIDENCE_NOT_ACCEPTED',
      'UPLOAD_EXPIRED',
      'OBJECT_MISSING',
      'OBJECT_MISMATCH',
      'SCAN_UNAVAILABLE',
      'SCAN_INFECTED',
      'INVALID_STATE',
      'SUBMISSION_INCOMPLETE',
      'STALE_CASE',
      'STALE_ROUND',
      'ALREADY_DECIDED',
      'REASON_INVALID',
      'NOT_REVERIFIABLE',
      'EXTERNAL_UNAVAILABLE',
      'VALIDATION_FAILED',
      'CONFLICT',
      'UNAVAILABLE',
    ]);
    expect(TRUST_ERROR_CODES).toHaveLength(25);
    expect(new Set(TRUST_ERROR_CODES).size).toBe(25);
  });
  it('every code is upper snake case and derives a distinct key', () => {
    for (const c of TRUST_ERROR_CODES as readonly TrustErrorCode[]) {
      expect(c).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
      expect(trustErrorKey(c)).toBe(`trust.verification.error.${c.toLowerCase()}`);
    }
  });
});

describe('hygiene', () => {
  it('uses no control characters in any helper output (a guard for the unicode-escape pitfall of the Write tool)', () => {
    const everything = [...seededKeys, ...TRUST_ERROR_CODES.map(trustErrorKey), trustReasonNameKey('X_Y')].join('');
    expect(everything).not.toMatch(new RegExp(`[${ch(0)}-${ch(0x1f)}]`));
  });
});
