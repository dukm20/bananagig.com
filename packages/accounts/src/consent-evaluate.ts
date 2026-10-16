// The pure evaluation of one consent purpose (ID-005): given whether a role of the account needs the purpose, the re-acceptance mode, the version in force in the evaluated
// locale and the account's latest event, which requirement status is it in? No I/O: the service reads the facts, this file decides. Table-driven tests: consent-evaluate.test.ts.
import {
  isOutstandingStatus,
  type ConsentAcceptanceState,
  type ConsentEventType,
  type ConsentRequirementStatus,
  type ReacceptanceMode,
} from '@bananagig/contracts';

/** The version in force in the EVALUATED locale (its `locale` is the evaluated locale: legal documents never fall back to another one). */
export interface EvaluationDocument {
  versionId: string;
  locale: string;
}
/** The account's latest event for the purpose. */
export interface EvaluationEvent {
  eventType: ConsentEventType;
  versionId: string;
  locale: string;
}
export interface EvaluationInput {
  /** Some considered role of the account is in `required_for`. */
  required: boolean;
  reacceptance: ReacceptanceMode;
  /** The locale being evaluated (a legal document never falls back to another locale). */
  evaluatedLocale: string;
  /** The version in force in the evaluated locale, or null when there is none. */
  document: EvaluationDocument | null;
  /** The latest event of the account and purpose, or null when it never had one. */
  latest: EvaluationEvent | null;
}
export interface EvaluationResult {
  status: ConsentRequirementStatus;
  acceptanceState: ConsentAcceptanceState;
}

/** NONE (no event), ACCEPTED or WITHDRAWN: derived from the latest event only. */
export const acceptanceStateOf = (latest: Pick<EvaluationEvent, 'eventType'> | null): ConsentAcceptanceState =>
  latest === null ? 'NONE' : latest.eventType === 'ACCEPTED' ? 'ACCEPTED' : 'WITHDRAWN';

/** Whether any of the account's considered roles is in the purpose's `required_for` list (exact, case-sensitive role codes). */
export const isRequiredFor = (requiredForRoles: readonly string[], consideredRoles: readonly string[]): boolean => {
  const required = new Set(requiredForRoles);
  return consideredRoles.some((role) => required.has(role));
};

/**
 * The status of one purpose:
 *  1. NOT_REQUIRED when no considered role needs it (it may still have been accepted voluntarily: acceptanceState says so).
 *  2. When the latest event is an ACCEPTANCE, the LENIENT modes are decided first, whether or not a version is in force now (a Legal timeline gap, or the deactivation of
 *     the entry or locale, must not un-satisfy people who already accepted):
 *     - NO_REACCEPT: SATISFIED by any accepted version in any locale;
 *     - REACCEPT_FOR_NEW_USERS_ONLY: SATISFIED iff the accepted version has the SAME locale as the evaluated one (any version number).
 *  3. DOCUMENT_UNAVAILABLE when no version is in force in the evaluated locale (there is nothing to accept). This still applies under REACCEPT_REQUIRED even if the
 *     account accepted before, and to anyone the lenient rules did not satisfy.
 *  4. OUTSTANDING when the latest event is not an acceptance (never accepted, or withdrawn).
 *  5. Otherwise (an acceptance, a version in force):
 *     - REACCEPT_REQUIRED: SATISFIED iff the accepted version IS the version in force, else REACCEPTANCE_REQUIRED (also when the acceptance was in another locale);
 *     - REACCEPT_FOR_NEW_USERS_ONLY (accepted in another locale): OUTSTANDING.
 */
export function evaluateRequirement(input: EvaluationInput): EvaluationResult {
  const acceptanceState = acceptanceStateOf(input.latest);
  if (!input.required) return { status: 'NOT_REQUIRED', acceptanceState };
  const accepted = input.latest !== null && input.latest.eventType === 'ACCEPTED' ? input.latest : null;
  if (accepted !== null) {
    if (input.reacceptance === 'NO_REACCEPT') return { status: 'SATISFIED', acceptanceState };
    if (input.reacceptance === 'REACCEPT_FOR_NEW_USERS_ONLY' && accepted.locale === input.evaluatedLocale) return { status: 'SATISFIED', acceptanceState };
  }
  if (input.document === null) return { status: 'DOCUMENT_UNAVAILABLE', acceptanceState };
  if (accepted === null) return { status: 'OUTSTANDING', acceptanceState };
  switch (input.reacceptance) {
    case 'REACCEPT_REQUIRED':
      return { status: accepted.versionId === input.document.versionId ? 'SATISFIED' : 'REACCEPTANCE_REQUIRED', acceptanceState };
    default:
      // REACCEPT_FOR_NEW_USERS_ONLY accepted in another locale; an unknown mode is an invalid policy (the service never lets one through): both fail closed
      return { status: 'OUTSTANDING', acceptanceState };
  }
}

/** `satisfied` (every required purpose is SATISFIED) and the codes of the required purposes that are not. */
export function summarizeRequirements(items: readonly { purposeCode: string; status: ConsentRequirementStatus }[]): {
  satisfied: boolean;
  outstanding: string[];
} {
  const outstanding = items.filter((i) => isOutstandingStatus(i.status)).map((i) => i.purposeCode);
  return { satisfied: outstanding.length === 0, outstanding };
}
