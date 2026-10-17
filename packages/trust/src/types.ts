// The views and ports of the verification service (TRUST-001). The service reads nothing of the identity, provider, geography or catalogue domains except through these ports and
// the reference-table joins in its policy query; storage, scanning and external providers are ports too, so the domain logic names no vendor and no SDK.
import type {
  TrustCaseStatus,
  TrustDocumentPolicy,
  TrustDocumentStatus,
  TrustEvidenceKind,
  TrustExternalStatus,
  TrustOverallStatus,
  TrustRequirementStatus,
  TrustRequirementType,
  TrustReviewDecision,
  TrustScanStatus,
} from '@bananagig/contracts';

// ---------------------------------------------------------------- ports
/** What the verification needs to know about the provider's registration (PRO-001 owns it; nothing here is copied or stored). */
export interface ProviderContext {
  accountActive: boolean;
  /** The configured contacts of the provider registration policy are verified (PRD: identity verification starts only after email and phone are verified). */
  contactsVerified: boolean;
  /** A live (IN_PROGRESS or COMPLETED) provider registration exists. */
  registrationLive: boolean;
  marketCode: string | null;
  serviceTypeCodes: readonly string[];
}
export interface ProviderContextPort {
  /** The context of the account, or null when the account does not exist. */
  context(accountId: string): Promise<ProviderContext | null>;
}

export interface TrustPolicyProvider {
  /** The evidence policy (configuration), read fresh; a missing or invalid value fails closed (UNAVAILABLE). */
  documents(): Promise<TrustDocumentPolicy>;
}

export interface ScanInput {
  key: string;
  size: number;
  bytes: Buffer;
}
export interface ScanResult {
  status: Exclude<TrustScanStatus, 'PENDING'>;
}
/** The malware scanner. Production has none yet: `DisabledEvidenceScanner` reports ERROR, so with clean scans required nothing can be attached (fail closed). */
export interface EvidenceScanner {
  scan(i: ScanInput): Promise<ScanResult>;
}

export interface ExternalVerificationRequest {
  /** An opaque reference of ours (the case requirement id). No name, contact or document. */
  reference: string;
  requirementType: TrustRequirementType;
}
export interface ExternalVerificationSummary {
  status: TrustExternalStatus;
  /** For an APPROVED verification: the end of its validity when the provider reports one. */
  validUntil: Date | null;
}
/** The boundary to an external verification provider (ID.me may be one future adapter). Only structured state crosses it: no payload, no personal attribute. */
export interface VerificationProvider {
  readonly name: string;
  create(r: ExternalVerificationRequest): Promise<{ externalId: string; status: Extract<TrustExternalStatus, 'CREATED' | 'PENDING'> }>;
  status(externalId: string): Promise<ExternalVerificationSummary>;
  cancel(externalId: string): Promise<void>;
  /** A structured summary of the outcome (the same fields as `status`, plus the time the provider reached it); never the provider's evidence. */
  evidenceSummary(externalId: string): Promise<ExternalVerificationSummary & { checkedAt: Date }>;
}

// ---------------------------------------------------------------- views (the API adds content keys)
export interface RequiredDefinition {
  requirementDefinitionId: string;
  code: string;
  requirementType: TrustRequirementType;
  evidenceKind: TrustEvidenceKind;
  expiryRequired: boolean;
}
export interface DocumentView {
  verificationDocumentId: string;
  caseRequirementId: string;
  documentTypeCode: string;
  status: TrustDocumentStatus;
  scanStatus: TrustScanStatus;
  mimeType: string;
  sizeBytes: number;
  round: number | null;
  createdAt: string;
  submittedAt: string | null;
  /** Reviewer views only. */
  sha256: string | null;
}
export interface InstanceRow {
  caseRequirementId: string;
  verificationCaseId: string;
  requirementDefinitionId: string;
  requirementCode: string;
  requirementType: TrustRequirementType;
  evidenceKind: TrustEvidenceKind;
  expiryRequired: boolean;
  cycle: number;
  status: TrustRequirementStatus;
  round: number;
  revision: number;
  approvedAt: string | null;
  expiresAt: string | null;
  supersededAt: string | null;
  /** The reason of the latest ACTION_REQUIRED or REJECTED decision of the current round chain (null when none). */
  latestReasonCode: string | null;
}
export interface CaseRow {
  verificationCaseId: string;
  accountId: string;
  caseNumber: number;
  status: TrustCaseStatus;
  revision: number;
  openedAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
}
export interface RequirementView {
  caseRequirementId: string | null;
  requirementCode: string;
  requirementType: TrustRequirementType;
  evidenceKind: TrustEvidenceKind;
  /** The effective status: an approval past its end reads EXPIRED. A requirement the case does not hold yet reads NOT_STARTED. */
  status: TrustRequirementStatus;
  cycle: number;
  round: number;
  expiresAt: string | null;
  reasonCode: string | null;
  canAttachEvidence: boolean;
  canReverify: boolean;
  documentTypes: string[];
  documents: DocumentView[];
}
export interface VerificationView {
  case: Pick<CaseRow, 'verificationCaseId' | 'caseNumber' | 'status' | 'revision' | 'openedAt' | 'submittedAt'> | null;
  overall: {
    status: TrustOverallStatus;
    verificationComplete: boolean;
    requiredCount: number;
    approvedCount: number;
    missing: string[];
    actionRequired: string[];
    expired: string[];
  };
  requirements: RequirementView[];
}

export interface ReviewView {
  reviewId: string;
  caseRequirementId: string;
  round: number;
  decision: TrustReviewDecision;
  reasonCode: string | null;
  reviewer: string;
  expiresAt: string | null;
  reviewedAt: string;
}

/** What the provider sees: the verification state plus whether it can be opened. */
export type ProviderVerificationView = VerificationView & { prerequisiteMet: boolean };

export interface UploadAuthorizationView {
  document: DocumentView;
  upload: { url: string; headers: Record<string, string>; expiresAt: string };
}

// ---- the reviewer / administrator read models
export interface AdminRequirementView {
  caseRequirementId: string;
  requirementCode: string;
  requirementType: TrustRequirementType;
  evidenceKind: TrustEvidenceKind;
  status: TrustRequirementStatus;
  cycle: number;
  round: number;
  approvedAt: string | null;
  expiresAt: string | null;
  superseded: boolean;
  reviews: ReviewView[];
  documents: DocumentView[];
  external: { adapter: string; status: TrustExternalStatus; lastCheckedAt: string | null } | null;
}
export interface CaseSummaryView {
  verificationCaseId: string;
  accountId: string;
  caseNumber: number;
  status: TrustCaseStatus;
  submittedAt: string | null;
  updatedAt: string;
  requirementCount: number;
  awaitingReviewCount: number;
}
export interface CaseDetailView {
  case: CaseSummaryView & { revision: number; openedAt: string; decidedAt: string | null };
  requirements: AdminRequirementView[];
}
export interface DecisionResult {
  requirement: AdminRequirementView;
  caseStatus: TrustCaseStatus;
  changed: boolean;
}
export interface PolicyView {
  requirements: { code: string; requirementType: TrustRequirementType; evidenceKind: TrustEvidenceKind; expiryRequired: boolean; status: string }[];
  rules: { requirementCode: string; marketCode: string | null; serviceTypeCode: string | null; enabled: boolean }[];
  documentTypes: { code: string; requirementType: TrustRequirementType }[];
}
