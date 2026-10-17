// The ports and views of the provider registration (PRO-001). Domain packages never import each other: everything the registration needs from another domain is a PORT here,
// implemented in the API composition root over the owning service. A port returns FACTS (statuses, codes, counts), never a copy the registration could store.
import type { OnboardingStep, OnboardingStepStatus, ProviderRegistrationPolicy, ProviderRegistrationStatus, ProviderRoleState } from '@bananagig/contracts';

/** What the registration needs to know about the account (read through the identity domain). */
export interface AccountFacts {
  accountId: string;
  /** The account status (ACTIVE, SUSPENDED, ...). */
  status: string;
  /** Every application role membership of the account (any status). */
  memberships: readonly { code: string; status: 'PENDING' | 'ACTIVE' | 'INACTIVE' }[];
  /** DERIVED by the owner from the email and phone verification state; the registration never stores them. */
  emailVerified: boolean;
  phoneVerified: boolean;
}
export interface AccountPort {
  /** The facts of the account, read fresh. Throws when the account does not exist. */
  facts(accountId: string): Promise<AccountFacts>;
  /**
   * Grants the role (idempotent): `pending: true` requests it (PENDING), `pending: false` makes it ACTIVE (a PENDING membership is activated). Joins the caller's
   * transaction. Throws when an INACTIVE membership would have to become PENDING.
   */
  grantRole(accountId: string, roleCode: string, opts: { pending: boolean; actor: string; reason: string }): Promise<{ changed: boolean; status: string }>;
}

/** The consent state of the account as ID-005 evaluates it (the role PENDING or ACTIVE is what makes a purpose required). */
export interface ConsentFacts {
  /** Every REQUIRED purpose is satisfied. */
  satisfied: boolean;
  /** The REQUIRED purposes that are not satisfied. */
  outstanding: readonly string[];
  /** The REQUIRED purposes whose document is not published (cannot proceed yet, never "nothing required"). */
  unavailable: readonly string[];
  /** How many purposes are required at all (0 = nothing is required for this account). */
  requiredCount: number;
}
export interface ConsentPort {
  /**
   * Evaluates the consents. It opens its own repeatable-read snapshot, so it must NEVER be called inside a registration transaction. Throws when the policy or the
   * documents cannot be read (the operation fails closed).
   */
  requirements(accountId: string, opts: { locale?: string }): Promise<ConsentFacts>;
}

export interface MarketFacts {
  code: string;
  /** PLANNED, ACTIVE or INACTIVE. */
  status: string;
  /** Whether the market is inside its effective window now. */
  inEffect: boolean;
}
export interface MarketPort {
  /** Any market, any status; null when it does not exist. */
  lookup(code: string): Promise<MarketFacts | null>;
}

export interface CatalogPort {
  /**
   * The codes of the service types a provider can choose in a market: ACTIVE, enabled in the market, under an ACTIVE category enabled there. The market may be of ANY
   * status (the registration policy decides which statuses accept providers). An unknown market has none.
   */
  offeredServiceTypes(marketCode: string): Promise<readonly string[]>;
}

/** The state of a prerequisite that belongs to a LATER domain (verification, subscription, profile, Gigs). */
export interface PrerequisiteState {
  status: Extract<OnboardingStepStatus, 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'NOT_AVAILABLE' | 'NOT_REQUIRED'>;
}
export interface PrerequisitePort {
  /** TRUST-001. */
  verification(accountId: string): Promise<PrerequisiteState>;
  /** The subscription checkpoints. */
  subscription(accountId: string): Promise<PrerequisiteState>;
  /** PRO-002. */
  profile(accountId: string): Promise<PrerequisiteState>;
  /** CAT-003. */
  gigs(accountId: string): Promise<PrerequisiteState>;
}
/** The default until the owning domains exist: every future prerequisite is NOT_AVAILABLE, with no fake record anywhere. */
export const UnavailablePrerequisites: PrerequisitePort = {
  verification: async () => ({ status: 'NOT_AVAILABLE' }),
  subscription: async () => ({ status: 'NOT_AVAILABLE' }),
  profile: async () => ({ status: 'NOT_AVAILABLE' }),
  gigs: async () => ({ status: 'NOT_AVAILABLE' }),
};

export interface PolicyProvider {
  /** The CURRENT policy. Throws ProviderError UNAVAILABLE when the configuration is unreadable or invalid: no code default exists. */
  policy(): Promise<ProviderRegistrationPolicy>;
}

// ---------------------------------------------------------------- service-level views
export interface RegistrationView {
  providerRegistrationId: string;
  attempt: number;
  status: ProviderRegistrationStatus;
  revision: number;
  marketCode: string | null;
  /** Codes of the selected service types, ordered by code. */
  serviceTypeCodes: string[];
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}
export interface RegistrationState {
  providerRole: ProviderRoleState;
  registration: RegistrationView | null;
}
export interface RequirementStep {
  step: OnboardingStep;
  status: OnboardingStepStatus;
  owner: string;
  detail?: {
    email?: 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_REQUIRED';
    phone?: 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_REQUIRED';
    outstandingPurposes?: string[];
    marketCode?: string;
    selected?: number;
    min?: number;
    max?: number;
    notOffered?: string[];
  };
}
export interface Requirements {
  providerRole: ProviderRoleState;
  registration: RegistrationView | null;
  steps: RequirementStep[];
  overall: {
    registrationComplete: boolean;
    registrationReady: boolean;
    blockedBy: OnboardingStep[];
    goLive: { evaluated: false; eligible: false };
  };
}
