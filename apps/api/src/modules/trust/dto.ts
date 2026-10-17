// Provider verification API shaping and error mapping (TRUST-001). Every mapper builds the response field by field. Nothing here carries a document body, an object key, a hash
// (except the reviewers' integrity hash), a contact, a name or a vendor payload: the views carry statuses and content KEYS (the web resolves the wording).
import {
  trustDocumentStatusKey,
  trustDocumentTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  trustRequirementInstructionsKey,
  trustRequirementNameKey,
  trustRequirementStatusKey,
  trustScanStatusKey,
  trustVerificationStatusKey,
  type DocumentUploadAuthorizationDto,
  type ProviderVerificationDto,
  type TrustAdminDocumentDto,
  type TrustAdminRequirementDto,
  type TrustCaseDetailDto,
  type TrustCaseSummaryDto,
  type TrustErrorCode,
  type TrustPolicyDto,
  type TrustRequirementDecisionDto,
  type VerificationDocumentDto,
  type VerificationRequirementDto,
} from '@bananagig/contracts';
import {
  TrustError,
  type AdminRequirementView,
  type CaseDetailView,
  type CaseSummaryView,
  type DecisionResult,
  type DocumentView,
  type PolicyView,
  type ProviderVerificationView,
  type RequirementView,
  type UploadAuthorizationView,
} from '@bananagig/trust';
import { AppError } from '../../errors';

export function documentDto(d: DocumentView): VerificationDocumentDto {
  return {
    verificationDocumentId: d.verificationDocumentId,
    documentTypeCode: d.documentTypeCode,
    documentTypeNameKey: trustDocumentTypeNameKey(d.documentTypeCode),
    status: d.status,
    statusKey: trustDocumentStatusKey(d.status),
    scanStatus: d.scanStatus,
    scanStatusKey: trustScanStatusKey(d.scanStatus),
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    round: d.round,
    createdAt: d.createdAt,
    submittedAt: d.submittedAt,
  };
}
const requirementDto = (r: RequirementView): VerificationRequirementDto => ({
  caseRequirementId: r.caseRequirementId,
  requirementCode: r.requirementCode,
  requirementType: r.requirementType,
  evidenceKind: r.evidenceKind,
  nameKey: trustRequirementNameKey(r.requirementCode),
  instructionsKey: trustRequirementInstructionsKey(r.requirementCode),
  status: r.status,
  statusKey: trustRequirementStatusKey(r.status),
  cycle: r.cycle,
  round: r.round,
  expiresAt: r.expiresAt,
  reasonCode: r.reasonCode,
  reasonKey: r.reasonCode === null ? null : trustReasonNameKey(r.reasonCode),
  canAttachEvidence: r.canAttachEvidence,
  canReverify: r.canReverify,
  documentTypes: r.documentTypes.map((code) => ({ code, nameKey: trustDocumentTypeNameKey(code) })),
  documents: r.documents.map(documentDto),
});
export function verificationDto(v: ProviderVerificationView): ProviderVerificationDto {
  return {
    prerequisiteMet: v.prerequisiteMet,
    case: v.case
      ? {
          verificationCaseId: v.case.verificationCaseId,
          caseNumber: v.case.caseNumber,
          status: v.case.status,
          statusKey: trustVerificationStatusKey(v.case.status),
          revision: v.case.revision,
          openedAt: v.case.openedAt,
          submittedAt: v.case.submittedAt,
        }
      : null,
    overall: {
      status: v.overall.status,
      statusKey: trustVerificationStatusKey(v.overall.status),
      verificationComplete: v.overall.verificationComplete,
      requiredCount: v.overall.requiredCount,
      approvedCount: v.overall.approvedCount,
      missing: [...v.overall.missing],
      actionRequired: [...v.overall.actionRequired],
      expired: [...v.overall.expired],
    },
    requirements: v.requirements.map(requirementDto),
    // approved verification is NOT Go-Live (PRO-003)
    goLive: { evaluated: false, eligible: false },
  };
}
export function uploadDto(u: UploadAuthorizationView): DocumentUploadAuthorizationDto {
  return { document: documentDto(u.document), upload: { method: 'PUT', url: u.upload.url, headers: { ...u.upload.headers }, expiresAt: u.upload.expiresAt } };
}

// ---- reviewers
const adminDocumentDto = (d: DocumentView): TrustAdminDocumentDto => ({ ...documentDto(d), sha256: d.sha256 });
const adminRequirementDto = (r: AdminRequirementView): TrustAdminRequirementDto => ({
  caseRequirementId: r.caseRequirementId,
  requirementCode: r.requirementCode,
  requirementType: r.requirementType,
  evidenceKind: r.evidenceKind,
  nameKey: trustRequirementNameKey(r.requirementCode),
  status: r.status,
  statusKey: trustRequirementStatusKey(r.status),
  cycle: r.cycle,
  round: r.round,
  approvedAt: r.approvedAt,
  expiresAt: r.expiresAt,
  superseded: r.superseded,
  reviews: r.reviews.map((v) => ({
    reviewId: v.reviewId,
    round: v.round,
    decision: v.decision,
    reasonCode: v.reasonCode,
    reasonKey: v.reasonCode === null ? null : trustReasonNameKey(v.reasonCode),
    reviewer: v.reviewer,
    expiresAt: v.expiresAt,
    reviewedAt: v.reviewedAt,
  })),
  documents: r.documents.map(adminDocumentDto),
  external: r.external
    ? { requirementCode: r.requirementCode, adapter: r.external.adapter, status: r.external.status, lastCheckedAt: r.external.lastCheckedAt }
    : null,
});
export const caseSummaryDto = (c: CaseSummaryView): TrustCaseSummaryDto => ({
  verificationCaseId: c.verificationCaseId,
  accountId: c.accountId,
  caseNumber: c.caseNumber,
  status: c.status,
  statusKey: trustVerificationStatusKey(c.status),
  submittedAt: c.submittedAt,
  updatedAt: c.updatedAt,
  requirementCount: c.requirementCount,
  awaitingReviewCount: c.awaitingReviewCount,
});
export const caseDetailDto = (c: CaseDetailView): TrustCaseDetailDto => ({
  case: { ...caseSummaryDto(c.case), revision: c.case.revision, openedAt: c.case.openedAt, decidedAt: c.case.decidedAt },
  requirements: c.requirements.map(adminRequirementDto),
});
export const decisionDto = (d: DecisionResult): TrustRequirementDecisionDto => ({
  requirement: adminRequirementDto(d.requirement),
  caseStatus: d.caseStatus,
  changed: d.changed,
});
export const policyDto = (p: PolicyView): TrustPolicyDto => ({
  requirements: p.requirements.map((r) => ({
    code: r.code,
    requirementType: r.requirementType,
    evidenceKind: r.evidenceKind,
    expiryRequired: r.expiryRequired,
    status: r.status as TrustPolicyDto['requirements'][number]['status'],
    nameKey: trustRequirementNameKey(r.code),
  })),
  rules: p.rules.map((r) => ({ ...r })),
  documentTypes: p.documentTypes.map((t) => ({ code: t.code, requirementType: t.requirementType, nameKey: trustDocumentTypeNameKey(t.code) })),
});

/**
 * The ONLY service details that reach a client: an ALLOW-list of short machine tokens (`reason`, `field`, `retryable`), the requirement codes that stand in the way (at most 20)
 * and the configured bounds. Anything else a future change might put in `details` (a cause, SQL, a value, a key) is dropped here.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
export function safeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reason', 'field'] as const) {
    const v = details[key];
    if (typeof v === 'string' && SAFE_TOKEN.test(v.slice(0, 64))) out[key] = v.slice(0, 64);
  }
  if (details.retryable === true) out.retryable = true;
  if (Array.isArray(details.codes)) {
    const codes = details.codes.filter((c): c is string => typeof c === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(c)).slice(0, 20);
    if (codes.length > 0) out.codes = codes;
  }
  const max = details.max;
  if (typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 100_000_000) out.max = max;
  return out;
}

type Category = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'DEPENDENCY';
const MESSAGES: Record<TrustErrorCode, { category: Category; message: string }> = {
  NOT_FOUND: { category: 'NOT_FOUND', message: 'Not found' },
  ACCOUNT_NOT_ACTIVE: { category: 'CONFLICT', message: 'The account is not active' },
  PREREQUISITE_NOT_MET: { category: 'CONFLICT', message: 'A prerequisite step is not complete' },
  REQUIREMENT_NOT_APPLICABLE: { category: 'CONFLICT', message: 'That requirement does not apply' },
  DOCUMENT_TYPE_NOT_ACCEPTED: { category: 'VALIDATION', message: 'That kind of document is not accepted for this requirement' },
  MIME_NOT_ALLOWED: { category: 'VALIDATION', message: 'That file type is not allowed' },
  FILE_TOO_LARGE: { category: 'VALIDATION', message: 'That file is too large' },
  TOO_MANY_DOCUMENTS: { category: 'CONFLICT', message: 'The most documents allowed for this requirement are already added' },
  EVIDENCE_NOT_ACCEPTED: { category: 'CONFLICT', message: 'This requirement does not take evidence right now' },
  UPLOAD_EXPIRED: { category: 'CONFLICT', message: 'The upload authorization expired' },
  OBJECT_MISSING: { category: 'VALIDATION', message: 'The file was not received' },
  OBJECT_MISMATCH: { category: 'VALIDATION', message: 'The file did not match what was described' },
  SCAN_UNAVAILABLE: { category: 'DEPENDENCY', message: 'The safety check is not available right now' },
  SCAN_INFECTED: { category: 'VALIDATION', message: 'The file was rejected by the safety check' },
  INVALID_STATE: { category: 'CONFLICT', message: 'That is not possible in the current state' },
  SUBMISSION_INCOMPLETE: { category: 'CONFLICT', message: 'Some requirements still need a document' },
  STALE_CASE: { category: 'CONFLICT', message: 'The verification changed since it was read' },
  STALE_ROUND: { category: 'CONFLICT', message: 'The evidence changed since it was read' },
  ALREADY_DECIDED: { category: 'CONFLICT', message: 'This evidence was already decided' },
  REASON_INVALID: { category: 'VALIDATION', message: 'That reason cannot be used for this decision' },
  NOT_REVERIFIABLE: { category: 'CONFLICT', message: 'This requirement cannot be verified again yet' },
  EXTERNAL_UNAVAILABLE: { category: 'DEPENDENCY', message: 'The verification service is not available right now' },
  VALIDATION_FAILED: { category: 'VALIDATION', message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', message: 'Verification is temporarily unavailable' },
};

/** Maps typed verification failures onto the standard API error model: fixed messages, a message KEY for the web, and allow-listed details. */
export function toAppError(err: unknown): never {
  if (!(err instanceof TrustError)) throw err;
  const m = MESSAGES[err.code];
  if (err.code === 'UNAVAILABLE') throw new AppError('DEPENDENCY', 'TRUST_UNAVAILABLE', m.message, { messageKey: trustErrorKey(err.code) });
  throw new AppError(m.category, `TRUST_${err.code}`, m.message, { ...safeDetails(err.details), messageKey: trustErrorKey(err.code) });
}
