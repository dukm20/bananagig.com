// The pure part of provider verification (TRUST-001): deterministic functions from authoritative state to statuses. They store nothing and call nothing; the service gathers the
// state in batches and these functions compose it. There is no `verified` flag: "verification complete" is DERIVED from the requirement states.
import { TRUST_EVIDENCE_OPEN_STATUSES, type TrustCaseStatus, type TrustOverallStatus, type TrustRequirementStatus } from '@bananagig/contracts';
import type { CaseRow, DocumentView, InstanceRow, RequiredDefinition, RequirementView, VerificationView } from './types';

/** The effective status of an instance at `now`: an approval past its end reads EXPIRED even before the sweep records it (expiry is derivable from the timestamp). */
export function effectiveStatus(i: Pick<InstanceRow, 'status' | 'expiresAt'>, now: Date): TrustRequirementStatus {
  return i.status === 'APPROVED' && i.expiresAt !== null && new Date(i.expiresAt).getTime() <= now.getTime() ? 'EXPIRED' : i.status;
}

/**
 * The workflow position of a case from the statuses of its LIVE requirements (NOT_REQUIRED ones are ignored). Never submitted: OPEN. After a submission: ACTION_REQUIRED while the
 * provider owes something (a reviewer asked, evidence was rejected, a requirement has no evidence yet), else EXPIRED while an approval ended, else IN_REVIEW while anything waits for
 * a reviewer, else APPROVED. The same function gives the stored case status (from stored statuses) and the overall status of the overview (from effective statuses).
 */
export function deriveStatus(submitted: boolean, statuses: readonly TrustRequirementStatus[]): Exclude<TrustCaseStatus, 'CANCELLED'> {
  const live = statuses.filter((s) => s !== 'NOT_REQUIRED');
  if (!submitted) return 'OPEN';
  if (live.some((s) => s === 'ACTION_REQUIRED' || s === 'REJECTED' || s === 'NOT_STARTED')) return 'ACTION_REQUIRED';
  if (live.some((s) => s === 'EXPIRED')) return 'EXPIRED';
  if (live.some((s) => s === 'PENDING' || s === 'IN_REVIEW')) return 'IN_REVIEW';
  return 'APPROVED';
}

export const deriveCaseStatus = deriveStatus;

export interface EvaluationInput {
  now: Date;
  /** What policy requires of this provider right now (ACTIVE definitions with a matching enabled rule). */
  required: readonly RequiredDefinition[];
  /** The live case, or null. */
  case: CaseRow | null;
  /** The CURRENT (not superseded) instances of the case. */
  instances: readonly InstanceRow[];
  /** All documents of the case's current instances (any status). */
  documents: readonly DocumentView[];
  /** Document type codes that can evidence each requirement type. */
  documentTypes: ReadonlyMap<string, readonly string[]>;
}

/**
 * The provider's verification state. Deterministic: the same input gives the same output. A requirement that policy requires but the case does not hold yet is reported as
 * NOT_STARTED with no instance (opening or submitting the case adds it); a requirement the case holds but policy no longer requires is not reported (the next sync marks it
 * NOT_REQUIRED) unless it was approved, in which case it stays visible as history of what was approved.
 */
export function evaluateVerification(input: EvaluationInput): VerificationView {
  const { now, required, instances, documents } = input;
  const byDefinition = new Map(instances.map((i) => [i.requirementDefinitionId, i]));
  const requiredIds = new Set(required.map((r) => r.requirementDefinitionId));
  const requirements: RequirementView[] = [];
  const caseOpen = input.case !== null && input.case.status !== 'CANCELLED';

  const toView = (
    def: Pick<RequiredDefinition, 'code' | 'requirementType' | 'evidenceKind'>,
    i: InstanceRow | undefined,
    stillRequired: boolean,
  ): RequirementView => {
    const status: TrustRequirementStatus = i ? effectiveStatus(i, now) : 'NOT_STARTED';
    const docs = i ? documents.filter((d) => d.caseRequirementId === i.caseRequirementId) : [];
    const canAttachEvidence =
      caseOpen && stillRequired && i !== undefined && def.evidenceKind === 'DOCUMENT' && (TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(status);
    return {
      caseRequirementId: i?.caseRequirementId ?? null,
      requirementCode: def.code,
      requirementType: def.requirementType,
      evidenceKind: def.evidenceKind,
      status,
      cycle: i?.cycle ?? 0,
      round: i?.round ?? 0,
      expiresAt: i?.expiresAt ?? null,
      reasonCode: i && (status === 'ACTION_REQUIRED' || status === 'REJECTED') ? i.latestReasonCode : null,
      canAttachEvidence,
      canReverify: caseOpen && stillRequired && i !== undefined && status === 'EXPIRED',
      documentTypes: [...(input.documentTypes.get(def.requirementType) ?? [])],
      documents: docs,
    };
  };

  for (const r of required) requirements.push(toView(r, byDefinition.get(r.requirementDefinitionId), true));
  // approved or expired history of a requirement policy no longer asks for stays visible, read-only
  for (const i of instances) {
    if (requiredIds.has(i.requirementDefinitionId)) continue;
    const eff = effectiveStatus(i, now);
    if (eff === 'APPROVED' || eff === 'EXPIRED')
      requirements.push(toView({ code: i.requirementCode, requirementType: i.requirementType, evidenceKind: i.evidenceKind }, i, false));
  }

  const requiredViews = requirements.filter((_, idx) => idx < required.length);
  const statuses = requiredViews.map((r) => r.status);
  let status: TrustOverallStatus;
  if (required.length === 0) status = 'NOT_REQUIRED';
  else if (!caseOpen) status = 'NOT_STARTED';
  else status = deriveStatus(input.case!.submittedAt !== null, statuses);
  const missing = requiredViews.filter((r) => r.caseRequirementId === null).map((r) => r.requirementCode);
  return {
    case: caseOpen
      ? {
          verificationCaseId: input.case!.verificationCaseId,
          caseNumber: input.case!.caseNumber,
          status: input.case!.status,
          revision: input.case!.revision,
          openedAt: input.case!.openedAt,
          submittedAt: input.case!.submittedAt,
        }
      : null,
    overall: {
      status,
      verificationComplete: status === 'APPROVED' || status === 'NOT_REQUIRED',
      requiredCount: required.length,
      approvedCount: statuses.filter((s) => s === 'APPROVED').length,
      missing,
      actionRequired: requiredViews
        .filter(
          (r) => r.status === 'ACTION_REQUIRED' || r.status === 'REJECTED' || (r.status === 'NOT_STARTED' && caseOpen && input.case!.submittedAt !== null),
        )
        .map((r) => r.requirementCode),
      expired: requiredViews.filter((r) => r.status === 'EXPIRED').map((r) => r.requirementCode),
    },
    requirements,
  };
}

/** How PRO-001 reports the verification onboarding step from the verification state (PRO-001 owns no verification state; it asks). */
export function onboardingStepStatus(overall: TrustOverallStatus): 'NOT_REQUIRED' | 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETE' {
  switch (overall) {
    case 'NOT_REQUIRED':
      return 'NOT_REQUIRED';
    case 'NOT_STARTED':
      return 'NOT_STARTED';
    case 'OPEN':
    case 'IN_REVIEW':
      return 'IN_PROGRESS';
    case 'ACTION_REQUIRED':
    case 'EXPIRED':
      return 'BLOCKED';
    case 'APPROVED':
      return 'COMPLETE';
  }
}
