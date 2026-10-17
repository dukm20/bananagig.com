// Public contracts of provider verification (TRUST-001, docs/engineering/TRUST_VERIFICATION.md). Verification is MULTI-DIMENSIONAL: a provider has a verification CASE made of
// REQUIREMENTS (identity, background check, licence, insurance ...) that policy derives from the market and the service types, each decided on its own from submitted EVIDENCE
// (documents kept in private object storage, or an external verification). There is deliberately no `verified` flag anywhere: the overall state is DERIVED from the requirement
// states, and "verification approved" is NOT "live" (Go-Live is PRO-003). Nothing here carries an email, a phone, a name, document content, an object key or a signed URL
// except the one-time upload/download authorizations, which are returned to their authorized caller only and never stored or logged.
import { z } from 'zod';
import { CatalogCode } from './catalog';
import { envelope } from './envelope';
import { MarketCode } from './geography';

// ---------------------------------------------------------------- vocabularies
/** What kind of check a requirement is. A controlled vocabulary; which requirements exist, and where they apply, is data (policy), not code. */
export const TRUST_REQUIREMENT_TYPES = [
  'IDENTITY',
  'BACKGROUND_CHECK',
  'LICENSE',
  'INSURANCE',
  'CERTIFICATION',
  'BUSINESS_REGISTRATION',
  'OTHER_DOCUMENT',
] as const;
export const TrustRequirementType = z.enum(TRUST_REQUIREMENT_TYPES);
export type TrustRequirementType = z.infer<typeof TrustRequirementType>;

/** How a requirement is evidenced: documents reviewed by staff, or a verification run by an external provider through the adapter boundary. */
export const TRUST_EVIDENCE_KINDS = ['DOCUMENT', 'EXTERNAL'] as const;
export const TrustEvidenceKind = z.enum(TRUST_EVIDENCE_KINDS);
export type TrustEvidenceKind = z.infer<typeof TrustEvidenceKind>;

/** A requirement definition is INACTIVE (not required anywhere), ACTIVE (rules may require it) or RETIRED (terminal). */
export const TRUST_DEFINITION_STATUSES = ['INACTIVE', 'ACTIVE', 'RETIRED'] as const;
export const TrustDefinitionStatus = z.enum(TRUST_DEFINITION_STATUSES);
export type TrustDefinitionStatus = z.infer<typeof TrustDefinitionStatus>;
export const isTrustDefinitionTransitionAllowed = (from: TrustDefinitionStatus, to: TrustDefinitionStatus): boolean =>
  (from === 'INACTIVE' && (to === 'ACTIVE' || to === 'RETIRED')) || (from === 'ACTIVE' && (to === 'INACTIVE' || to === 'RETIRED'));

/**
 * The state of one requirement of one case (one CYCLE of it). NOT_STARTED: no evidence yet. PENDING: evidence submitted, waiting for a reviewer. IN_REVIEW: a reviewer started.
 * ACTION_REQUIRED: the reviewer needs more from the provider. REJECTED: the evidence was refused (PR-02.03: it can be fixed and resubmitted). APPROVED. EXPIRED: an approval whose
 * validity ended (a new cycle re-verifies it; the old approval stays as history). NOT_REQUIRED: the policy no longer asks for it.
 */
export const TRUST_REQUIREMENT_STATUSES = [
  'NOT_STARTED',
  'PENDING',
  'IN_REVIEW',
  'ACTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'NOT_REQUIRED',
] as const;
export const TrustRequirementStatus = z.enum(TRUST_REQUIREMENT_STATUSES);
export type TrustRequirementStatus = z.infer<typeof TrustRequirementStatus>;
const REQUIREMENT_TRANSITIONS: Readonly<Record<TrustRequirementStatus, readonly TrustRequirementStatus[]>> = {
  NOT_STARTED: ['PENDING', 'NOT_REQUIRED'],
  PENDING: ['IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'NOT_REQUIRED'],
  IN_REVIEW: ['ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'NOT_REQUIRED'],
  ACTION_REQUIRED: ['PENDING', 'NOT_REQUIRED'],
  REJECTED: ['PENDING', 'NOT_REQUIRED'],
  APPROVED: ['EXPIRED'],
  EXPIRED: [],
  NOT_REQUIRED: ['NOT_STARTED'],
};
export const isTrustRequirementTransitionAllowed = (from: TrustRequirementStatus, to: TrustRequirementStatus): boolean =>
  REQUIREMENT_TRANSITIONS[from].includes(to);
/** The requirement states from which the provider can attach new evidence (submitting it starts the next round). */
export const TRUST_EVIDENCE_OPEN_STATUSES = ['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED'] as const satisfies readonly TrustRequirementStatus[];

/**
 * The stored workflow position of a case. OPEN: the provider is assembling evidence (never submitted). IN_REVIEW: everything submitted is waiting. ACTION_REQUIRED: the provider must
 * act (a reviewer asked, evidence was rejected, a requirement was added or a new cycle started). APPROVED: every required requirement is approved. EXPIRED: an approval ended and must
 * be renewed. CANCELLED: the provider withdrew the case (terminal). There is no REJECTED case: rejection belongs to a requirement and the provider may resubmit (PR-02.03).
 * It is a DERIVED value stored for the reviewers' queue (see deriveCaseStatus in @bananagig/trust); the database only guards the initial and terminal states.
 */
export const TRUST_CASE_STATUSES = ['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED', 'CANCELLED'] as const;
export const TrustCaseStatus = z.enum(TRUST_CASE_STATUSES);
export type TrustCaseStatus = z.infer<typeof TrustCaseStatus>;
/** What the provider-facing overview calls the state of the whole verification: the case status plus "nothing is required" and "no case yet". */
export const TRUST_OVERALL_STATUSES = ['NOT_REQUIRED', 'NOT_STARTED', 'OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as const;
export const TrustOverallStatus = z.enum(TRUST_OVERALL_STATUSES);
export type TrustOverallStatus = z.infer<typeof TrustOverallStatus>;

/** UPLOAD_PENDING (authorized, nothing verified yet) -> ATTACHED (finalized: verified and scanned, still a draft) -> SUBMITTED (part of a submitted round, frozen); WITHDRAWN (draft removed); ABANDONED (refused or expired upload). */
export const TRUST_DOCUMENT_STATUSES = ['UPLOAD_PENDING', 'ATTACHED', 'SUBMITTED', 'WITHDRAWN', 'ABANDONED'] as const;
export const TrustDocumentStatus = z.enum(TRUST_DOCUMENT_STATUSES);
export type TrustDocumentStatus = z.infer<typeof TrustDocumentStatus>;
/** The malware-scan state of a document. A document that is not CLEAN is not reviewable or downloadable when clean scans are required (the default). */
export const TRUST_SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'ERROR'] as const;
export const TrustScanStatus = z.enum(TRUST_SCAN_STATUSES);
export type TrustScanStatus = z.infer<typeof TrustScanStatus>;

export const TRUST_REVIEW_DECISIONS = ['STARTED', 'APPROVED', 'REJECTED', 'ACTION_REQUIRED'] as const;
export const TrustReviewDecision = z.enum(TRUST_REVIEW_DECISIONS);
export type TrustReviewDecision = z.infer<typeof TrustReviewDecision>;

/** The status of an external verification as the adapter last reported it (a snapshot, not a source of truth for the requirement). */
export const TRUST_EXTERNAL_STATUSES = ['CREATED', 'PENDING', 'APPROVED', 'REJECTED', 'ERROR', 'CANCELLED'] as const;
export const TrustExternalStatus = z.enum(TRUST_EXTERNAL_STATUSES);
export type TrustExternalStatus = z.infer<typeof TrustExternalStatus>;

/** Structured decision reasons (generic operational ones; no legal conclusion). Reference data: the code is stable, the wording is content. */
export const TRUST_REASON_CODES = [
  'DOCUMENT_UNREADABLE',
  'DOCUMENT_EXPIRED',
  'NAME_MISMATCH',
  'LICENSE_INVALID',
  'INSURANCE_EXPIRED',
  'REQUIRES_RESUBMISSION',
  'OTHER_REVIEW_REQUIRED',
] as const;
export const TrustReasonCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/)
  .min(3)
  .max(48);
export type TrustReasonCode = z.infer<typeof TrustReasonCode>;

/** Document types by the requirement type they can evidence (reference data in trust.document_types). */
export const TRUST_DOCUMENT_TYPE_CODES = [
  'drivers_license',
  'state_id',
  'passport',
  'professional_license',
  'business_license',
  'insurance_certificate',
  'certification',
] as const;

// ---------------------------------------------------------------- content keys (the API returns keys; the web resolves them; nothing user-visible is hardcoded)
export const trustRequirementNameKey = (code: string): string => `trust.requirement.${code}.name`;
export const trustRequirementInstructionsKey = (code: string): string => `trust.requirement.${code}.instructions`;
export const trustDocumentTypeNameKey = (code: string): string => `trust.document_type.${code}.name`;
export const trustReasonNameKey = (code: string): string => `trust.reason.${code.toLowerCase()}.name`;
export const trustRequirementStatusKey = (status: TrustRequirementStatus): string => `trust.verification.requirement_status.${status.toLowerCase()}`;
export const trustVerificationStatusKey = (status: TrustOverallStatus | TrustCaseStatus): string => `trust.verification.status.${status.toLowerCase()}`;
export const trustDocumentStatusKey = (status: TrustDocumentStatus): string => `trust.verification.document_status.${status.toLowerCase()}`;
export const trustScanStatusKey = (status: TrustScanStatus): string => `trust.verification.scan_status.${status.toLowerCase()}`;
export const trustErrorKey = (code: TrustErrorCode): string => `trust.verification.error.${code.toLowerCase()}`;

// ---------------------------------------------------------------- policy (configuration, never code)
export const TRUST_POLICY_KEYS = {
  maxSizeBytes: 'trust.document.max_size_bytes',
  allowedMimeTypes: 'trust.document.allowed_mime_types',
  maxDocumentsPerRequirement: 'trust.document.max_per_requirement',
  uploadUrlTtlSeconds: 'trust.document.upload_url_ttl_seconds',
  downloadUrlTtlSeconds: 'trust.document.download_url_ttl_seconds',
  requireCleanScan: 'trust.verification.require_clean_scan',
} as const;
/** Structural ceiling of one document (the configured maximum must not exceed it). */
export const TRUST_DOCUMENT_SIZE_CEILING = 52_428_800;
export const TrustDocumentPolicy = z
  .object({
    maxSizeBytes: z.number().int().min(1024).max(TRUST_DOCUMENT_SIZE_CEILING),
    allowedMimeTypes: z
      .array(
        z
          .string()
          .regex(/^[a-z]+\/[a-z0-9.+-]+$/)
          .max(100),
      )
      .min(1)
      .max(10),
    maxDocumentsPerRequirement: z.number().int().min(1).max(20),
    uploadUrlTtlSeconds: z.number().int().min(60).max(3600),
    downloadUrlTtlSeconds: z.number().int().min(15).max(900),
    requireCleanScan: z.boolean(),
  })
  .strict()
  .refine((p) => new Set(p.allowedMimeTypes).size === p.allowedMimeTypes.length, { message: 'MIME types must be unique' });
export type TrustDocumentPolicy = z.infer<typeof TrustDocumentPolicy>;

// ---------------------------------------------------------------- requests (strict; the account is the caller's, never in a body or path)
const revision = z.number().int().min(1).max(2_147_483_647);
const round = z.number().int().min(1).max(10_000);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const OpenVerificationRequest = z.object({}).strict();
export type OpenVerificationRequest = z.infer<typeof OpenVerificationRequest>;
export const RequestDocumentUploadRequest = z
  .object({
    requirementCode: CatalogCode,
    documentTypeCode: CatalogCode,
    /** The content type the file will be sent with; checked against the configured list and against the file's own signature when it is finalized. */
    mimeType: z
      .string()
      .regex(/^[a-z]+\/[a-z0-9.+-]+$/)
      .max(100),
    sizeBytes: z.number().int().min(1).max(TRUST_DOCUMENT_SIZE_CEILING),
  })
  .strict();
export type RequestDocumentUploadRequest = z.infer<typeof RequestDocumentUploadRequest>;
/** Optional: the SHA-256 the client computed of the file it uploaded. The server always computes its own from the stored bytes and refuses a difference. */
export const FinalizeDocumentRequest = z.object({ sha256: sha256Hex.optional() }).strict();
export type FinalizeDocumentRequest = z.infer<typeof FinalizeDocumentRequest>;
export const SubmitVerificationRequest = z.object({ expectedRevision: revision }).strict();
export type SubmitVerificationRequest = z.infer<typeof SubmitVerificationRequest>;
export const CancelVerificationRequest = z.object({}).strict();
export type CancelVerificationRequest = z.infer<typeof CancelVerificationRequest>;
export const ReverifyRequirementRequest = z.object({}).strict();
export type ReverifyRequirementRequest = z.infer<typeof ReverifyRequirementRequest>;
export const StartExternalVerificationRequest = z.object({}).strict();
export type StartExternalVerificationRequest = z.infer<typeof StartExternalVerificationRequest>;

/** Reviewer decisions name the evidence ROUND they decided on: a provider resubmission in between makes the decision stale (409) instead of approving evidence nobody saw. */
export const StartReviewRequest = z.object({ round }).strict();
export type StartReviewRequest = z.infer<typeof StartReviewRequest>;
export const ApproveRequirementRequest = z
  .object({
    round,
    /** Optional end of the approval's validity (later than now); default: the definition's validity period, or none. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ApproveRequirementRequest = z.infer<typeof ApproveRequirementRequest>;
export const RejectRequirementRequest = z.object({ round, reasonCode: TrustReasonCode }).strict();
export type RejectRequirementRequest = z.infer<typeof RejectRequirementRequest>;
export const RequestActionRequest = z.object({ round, reasonCode: TrustReasonCode }).strict();
export type RequestActionRequest = z.infer<typeof RequestActionRequest>;
export const SetRequirementStatusRequest = z.object({ status: TrustDefinitionStatus }).strict();
export type SetRequirementStatusRequest = z.infer<typeof SetRequirementStatusRequest>;
export const SetRequirementRuleRequest = z
  .object({
    requirementCode: CatalogCode,
    /** null = every market */
    marketCode: MarketCode.nullable(),
    /** null = every service type */
    serviceTypeCode: CatalogCode.nullable(),
    enabled: z.boolean(),
  })
  .strict();
export type SetRequirementRuleRequest = z.infer<typeof SetRequirementRuleRequest>;

// ---------------------------------------------------------------- read models
/** A document's metadata. No object key, no hash, no URL: only what the owner needs to see. */
export const VerificationDocumentDto = z.object({
  verificationDocumentId: z.string(),
  documentTypeCode: z.string(),
  documentTypeNameKey: z.string(),
  status: TrustDocumentStatus,
  statusKey: z.string(),
  scanStatus: TrustScanStatus,
  scanStatusKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** The evidence round the document was submitted in, or null while it is a draft. */
  round: z.number().int().nullable(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
});
export type VerificationDocumentDto = z.infer<typeof VerificationDocumentDto>;

export const VerificationRequirementDto = z.object({
  /** null while the case does not hold the requirement yet (policy requires it; opening or submitting the case adds it). */
  caseRequirementId: z.string().nullable(),
  requirementCode: z.string(),
  requirementType: TrustRequirementType,
  evidenceKind: TrustEvidenceKind,
  nameKey: z.string(),
  instructionsKey: z.string(),
  /** The EFFECTIVE status: an approval past its end reads EXPIRED even before the expiry is recorded. */
  status: TrustRequirementStatus,
  statusKey: z.string(),
  cycle: z.number().int(),
  round: z.number().int(),
  expiresAt: z.string().nullable(),
  /** The reason of the latest reviewer decision while the provider has to act (ACTION_REQUIRED or REJECTED). */
  reasonCode: z.string().nullable(),
  reasonKey: z.string().nullable(),
  /** The provider may attach evidence now. */
  canAttachEvidence: z.boolean(),
  /** The approval ended: start a new cycle. */
  canReverify: z.boolean(),
  /** Document types that can evidence the requirement (accepted for its requirement type). */
  documentTypes: z.array(z.object({ code: z.string(), nameKey: z.string() })),
  documents: z.array(VerificationDocumentDto),
});
export type VerificationRequirementDto = z.infer<typeof VerificationRequirementDto>;

export const VerificationCaseDto = z.object({
  verificationCaseId: z.string(),
  caseNumber: z.number().int(),
  status: TrustCaseStatus,
  statusKey: z.string(),
  /** Concurrency token of the submission (bumped by every change of the case). */
  revision: z.number().int(),
  openedAt: z.string(),
  submittedAt: z.string().nullable(),
});
export type VerificationCaseDto = z.infer<typeof VerificationCaseDto>;

export const ProviderVerificationDto = z.object({
  /** The verification can be opened (the account is active, the registration is live and the configured contacts are verified). */
  prerequisiteMet: z.boolean(),
  case: VerificationCaseDto.nullable(),
  overall: z.object({
    status: TrustOverallStatus,
    statusKey: z.string(),
    /** Every required requirement is approved and none expired (or nothing is required). NOT "live": Go-Live is PRO-003's. */
    verificationComplete: z.boolean(),
    requiredCount: z.number().int(),
    approvedCount: z.number().int(),
    missing: z.array(z.string()),
    actionRequired: z.array(z.string()),
    expired: z.array(z.string()),
  }),
  requirements: z.array(VerificationRequirementDto),
  goLive: z.object({ evaluated: z.literal(false), eligible: z.literal(false) }),
});
export type ProviderVerificationDto = z.infer<typeof ProviderVerificationDto>;
export const ProviderVerificationResponse = envelope(ProviderVerificationDto);

export const VerificationDocumentResponse = envelope(VerificationDocumentDto);
export const VerificationDocumentListResponse = envelope(z.array(VerificationDocumentDto));
export const DocumentUploadAuthorizationDto = z.object({
  document: VerificationDocumentDto,
  upload: z.object({
    method: z.literal('PUT'),
    /** One-time, short-lived, bound to this object. Not stored, not logged; send the file to it with exactly these headers. */
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});
export type DocumentUploadAuthorizationDto = z.infer<typeof DocumentUploadAuthorizationDto>;
export const DocumentUploadAuthorizationResponse = envelope(DocumentUploadAuthorizationDto);
export const ExternalVerificationDto = z.object({
  requirementCode: z.string(),
  adapter: z.string(),
  status: TrustExternalStatus,
  lastCheckedAt: z.string().nullable(),
});
export type ExternalVerificationDto = z.infer<typeof ExternalVerificationDto>;
export const ExternalVerificationResponse = envelope(ExternalVerificationDto);

// ---- the reviewer / administrator views
export const TrustReviewDto = z.object({
  reviewId: z.string(),
  round: z.number().int(),
  decision: TrustReviewDecision,
  reasonCode: z.string().nullable(),
  reasonKey: z.string().nullable(),
  /** `admin:<subject>` of the reviewer, or `external:<adapter>` for a decision relayed from an external provider. */
  reviewer: z.string(),
  expiresAt: z.string().nullable(),
  reviewedAt: z.string(),
});
export type TrustReviewDto = z.infer<typeof TrustReviewDto>;
export const TrustAdminDocumentDto = VerificationDocumentDto.extend({
  /** Integrity evidence for reviewers only. */
  sha256: z.string().nullable(),
});
export type TrustAdminDocumentDto = z.infer<typeof TrustAdminDocumentDto>;
export const TrustAdminRequirementDto = z.object({
  caseRequirementId: z.string(),
  requirementCode: z.string(),
  requirementType: TrustRequirementType,
  evidenceKind: TrustEvidenceKind,
  nameKey: z.string(),
  status: TrustRequirementStatus,
  statusKey: z.string(),
  cycle: z.number().int(),
  round: z.number().int(),
  approvedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  superseded: z.boolean(),
  reviews: z.array(TrustReviewDto),
  documents: z.array(TrustAdminDocumentDto),
  external: ExternalVerificationDto.nullable(),
});
export type TrustAdminRequirementDto = z.infer<typeof TrustAdminRequirementDto>;
export const TrustCaseSummaryDto = z.object({
  verificationCaseId: z.string(),
  /** The internal account id (uuid): the reviewer sees no name, email or phone. */
  accountId: z.string(),
  caseNumber: z.number().int(),
  status: TrustCaseStatus,
  statusKey: z.string(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
  requirementCount: z.number().int(),
  awaitingReviewCount: z.number().int(),
});
export type TrustCaseSummaryDto = z.infer<typeof TrustCaseSummaryDto>;
export const TrustCaseListResponse = envelope(z.array(TrustCaseSummaryDto));
export const TrustCaseDetailDto = z.object({
  case: TrustCaseSummaryDto.extend({ revision: z.number().int(), openedAt: z.string(), decidedAt: z.string().nullable() }),
  requirements: z.array(TrustAdminRequirementDto),
});
export type TrustCaseDetailDto = z.infer<typeof TrustCaseDetailDto>;
export const TrustCaseDetailResponse = envelope(TrustCaseDetailDto);
export const TrustRequirementDecisionDto = z.object({
  requirement: TrustAdminRequirementDto,
  caseStatus: TrustCaseStatus,
  /** false when a retried decision found the same decision already recorded. */
  changed: z.boolean(),
});
export type TrustRequirementDecisionDto = z.infer<typeof TrustRequirementDecisionDto>;
export const TrustRequirementDecisionResponse = envelope(TrustRequirementDecisionDto);
export const TrustDownloadDto = z.object({ url: z.string(), expiresAt: z.string() });
export type TrustDownloadDto = z.infer<typeof TrustDownloadDto>;
export const TrustDownloadResponse = envelope(TrustDownloadDto);
export const TrustPolicyDto = z.object({
  requirements: z.array(
    z.object({
      code: z.string(),
      requirementType: TrustRequirementType,
      evidenceKind: TrustEvidenceKind,
      /** An approval of this requirement must carry an end date. */
      expiryRequired: z.boolean(),
      status: TrustDefinitionStatus,
      nameKey: z.string(),
    }),
  ),
  rules: z.array(z.object({ requirementCode: z.string(), marketCode: z.string().nullable(), serviceTypeCode: z.string().nullable(), enabled: z.boolean() })),
  documentTypes: z.array(z.object({ code: z.string(), requirementType: TrustRequirementType, nameKey: z.string() })),
});
export type TrustPolicyDto = z.infer<typeof TrustPolicyDto>;
export const TrustPolicyResponse = envelope(TrustPolicyDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers and safe status only)
export const TRUST_EVENTS = {
  caseOpened: 'bananagig.trust.verification-case-opened.v1',
  submitted: 'bananagig.trust.verification-submitted.v1',
  requirementApproved: 'bananagig.trust.verification-requirement-approved.v1',
  requirementRejected: 'bananagig.trust.verification-requirement-rejected.v1',
  actionRequired: 'bananagig.trust.verification-action-required.v1',
  expired: 'bananagig.trust.verification-expired.v1',
  completed: 'bananagig.trust.verification-completed.v1',
} as const;
export const TrustCaseEventPayload = z.object({ accountId: z.string(), verificationCaseId: z.string(), caseNumber: z.number().int(), status: TrustCaseStatus });
export type TrustCaseEventPayload = z.infer<typeof TrustCaseEventPayload>;
export const TrustRequirementEventPayload = TrustCaseEventPayload.extend({
  caseRequirementId: z.string(),
  requirementCode: z.string(),
  requirementType: TrustRequirementType,
  requirementStatus: TrustRequirementStatus,
  reasonCode: z.string().nullable(),
});
export type TrustRequirementEventPayload = z.infer<typeof TrustRequirementEventPayload>;

// ---------------------------------------------------------------- errors
export const TRUST_ERROR_CODES = [
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
] as const;
export type TrustErrorCode = (typeof TRUST_ERROR_CODES)[number];
