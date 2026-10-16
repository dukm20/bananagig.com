// The interfaces of the account consent layer (ID-005, docs/engineering/CONSENT.md): what the service needs from configuration and what it offers (ConsentOperations).
// The service itself is packages/accounts/src/consent-service.ts.
//
// Ownership (ADR-0037, ADR-0038): CFG-002 owns the legal documents and their immutable versions; this layer binds an ACCOUNT to an exact version (id, locale, hash) in an
// append-only event log and DERIVES the current state. Policy (who needs which purpose, what a newer version does) is configuration (CFG-001), never code.
import type {
  AcceptConsentRequest,
  AcceptConsentResultDto,
  AccountConsentsDto,
  ConsentRequirementDto,
  ConsentRequirementsDto,
  ReacceptanceMode,
  WithdrawConsentResultDto,
} from '@bananagig/contracts';

/** The policy of one purpose (configuration keys `consent.<purpose>.required_for` and `consent.<purpose>.reacceptance`). */
export interface ConsentPolicy {
  /** Application role codes (for example CUSTOMER, PROVIDER) that need the purpose. An empty list means nobody is required to accept it. */
  requiredForRoles: readonly string[];
  reacceptance: ReacceptanceMode;
}
export interface ConsentPolicyProvider {
  /** Reads the CURRENT policy of a purpose. Throws when the configuration is unavailable or invalid: a legal requirement has no code default, the operation then fails closed. */
  policy(purposeCode: string): Promise<ConsentPolicy>;
}

/** Facts about the request the service may record. Never the client's account id, time or address. */
export interface ConsentRequestContext {
  /** The application session of the request (ID-004), when it has one. */
  applicationSessionId?: string;
}

export interface RequirementOptions {
  /** The locale to evaluate in. Default: the account's preferred locale, else the platform default locale. Legal documents never fall back to another locale. */
  locale?: string;
  /** Evaluate only these purposes (default: every ACTIVE purpose). */
  purposes?: readonly string[];
}

export interface ConsentOperations {
  /** The account's derived current state per ACTIVE-or-used purpose plus its whole event history (newest first, bounded). Owner data. */
  getConsents(accountId: string): Promise<AccountConsentsDto>;
  /** Evaluates every ACTIVE purpose for the account (its roles, the policy, the version in force) in one locale. */
  getRequirements(accountId: string, options?: RequirementOptions): Promise<ConsentRequirementsDto>;
  /**
   * Records that the account accepted the exact version it was shown. The version must belong to the purpose's document, be in force now (platform scope), and the
   * locale and hash the client claims must be those of the immutable version. Repeating the same acceptance (the latest event is the same version) is idempotent
   * (`changed:false`, nothing written). The server sets the time.
   */
  accept(accountId: string, purposeCode: string, input: AcceptConsentRequest, ctx?: ConsentRequestContext): Promise<AcceptConsentResultDto>;
  /** Withdraws the accepted consent of a WITHDRAWABLE purpose that no role of the account requires. Repeating it is idempotent. */
  withdraw(accountId: string, purposeCode: string, ctx?: ConsentRequestContext): Promise<WithdrawConsentResultDto>;

  // ---- for the flows that need consent (sign-up CU-03, provider onboarding PR-01, later gates); no flow calls them yet
  /** The REQUIRED purposes that are not satisfied (OUTSTANDING, REACCEPTANCE_REQUIRED, DOCUMENT_UNAVAILABLE). */
  listOutstandingConsents(accountId: string, options?: RequirementOptions): Promise<ConsentRequirementDto[]>;
  hasRequiredConsents(accountId: string, options?: RequirementOptions): Promise<boolean>;
  /** Throws AccountError('CONSENT_REQUIRED', ..., { outstanding: purposeCodes }) when any required purpose (of `options.purposes`, default all) is not satisfied. */
  requireConsents(accountId: string, options?: RequirementOptions): Promise<void>;
}
