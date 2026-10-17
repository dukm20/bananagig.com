// The provider-onboarding requirement evaluator (PRO-001): a PURE function from the facts of the authoritative domains to the status of every onboarding step. It stores nothing
// and calls nothing; the service gathers the facts in batches (one read per domain, never one per step) and this function composes them. Contact state (ID-002/003) and consent
// (ID-005) are read from their owners; verification, subscription, profile and Gigs belong to later checkpoints and are reported through ports as NOT_AVAILABLE until they exist.
import {
  ONBOARDING_STEPS,
  REGISTRATION_STEPS,
  isStepSatisfied,
  type OnboardingStep,
  type ProviderRegistrationPolicy,
  type ProviderRoleState,
} from '@bananagig/contracts';
import type { AccountFacts, ConsentFacts, MarketFacts, PrerequisiteState, RegistrationView, Requirements, RequirementStep } from './types';

export const PROVIDER_ROLE_CODE = 'PROVIDER';

export interface EvaluationInput {
  policy: ProviderRegistrationPolicy;
  account: AccountFacts;
  /** The LATEST attempt of the account (any status), or null when it never started. A CANCELLED latest attempt counts as "not started". */
  registration: RegistrationView | null;
  /** The consent state, or null when it was not evaluated (the account has no PENDING or ACTIVE provider role: no provider purpose applies yet). */
  consent: ConsentFacts | null;
  /** The chosen market of the registration (null when none is chosen or it no longer exists). */
  market: MarketFacts | null;
  /** The codes offered in the chosen market, or null when no market is chosen. */
  offered: readonly string[] | null;
  future: { verification: PrerequisiteState; subscription: PrerequisiteState; profile: PrerequisiteState; gigs: PrerequisiteState };
}

/** The provider role as the registration reports it: NONE or the ID-001 membership status (never a second source of truth). */
export function providerRoleOf(memberships: AccountFacts['memberships']): ProviderRoleState {
  return memberships.find((m) => m.code === PROVIDER_ROLE_CODE)?.status ?? 'NONE';
}

/** Whether the market accepts provider registration today: its status is in the policy list and an ACTIVE market is inside its window. */
export function marketAcceptsProviders(policy: ProviderRegistrationPolicy, market: MarketFacts | null): market is MarketFacts {
  if (!market) return false;
  if (!(policy.marketStatusesAllowed as readonly string[]).includes(market.status)) return false;
  return market.status !== 'ACTIVE' || market.inEffect;
}

/** The contact prerequisite (PR-01.03, PR-01.05) as configured: which of the two must be verified and what the account has. */
export function contactState(policy: ProviderRegistrationPolicy, account: Pick<AccountFacts, 'emailVerified' | 'phoneVerified'>): RequirementStep {
  const detail = {
    email: !policy.requireVerifiedEmail ? ('NOT_REQUIRED' as const) : account.emailVerified ? ('VERIFIED' as const) : ('NOT_VERIFIED' as const),
    phone: !policy.requireVerifiedPhone ? ('NOT_REQUIRED' as const) : account.phoneVerified ? ('VERIFIED' as const) : ('NOT_VERIFIED' as const),
  };
  const required = [detail.email, detail.phone].filter((x) => x !== 'NOT_REQUIRED');
  const verified = required.filter((x) => x === 'VERIFIED').length;
  const status = required.length === 0 ? 'NOT_REQUIRED' : verified === required.length ? 'COMPLETE' : verified === 0 ? 'NOT_STARTED' : 'IN_PROGRESS';
  return { step: 'CONTACT', status, owner: 'ID-002, ID-003', detail };
}

export function evaluateRequirements(input: EvaluationInput): Requirements {
  const { policy, account, consent, market, offered, future } = input;
  const live = input.registration !== null && input.registration.status !== 'CANCELLED' ? input.registration : null;
  const steps = new Map<OnboardingStep, RequirementStep>();

  steps.set('ACCOUNT', {
    step: 'ACCOUNT',
    status: account.status !== 'ACTIVE' ? 'BLOCKED' : live ? 'COMPLETE' : 'NOT_STARTED',
    owner: 'ID-001',
  });

  steps.set('CONTACT', contactState(policy, account));

  // LEGAL: composed from the consent evaluator. No consent facts = no PENDING/ACTIVE provider role yet: nothing provider-specific applies, so the step has not started.
  if (consent === null) steps.set('LEGAL', { step: 'LEGAL', status: 'NOT_STARTED', owner: 'ID-005' });
  else if (consent.requiredCount === 0) steps.set('LEGAL', { step: 'LEGAL', status: 'NOT_REQUIRED', owner: 'ID-005' });
  else if (consent.unavailable.length > 0)
    steps.set('LEGAL', { step: 'LEGAL', status: 'BLOCKED', owner: 'ID-005', detail: { outstandingPurposes: [...consent.outstanding] } });
  else if (consent.satisfied) steps.set('LEGAL', { step: 'LEGAL', status: 'COMPLETE', owner: 'ID-005' });
  else
    steps.set('LEGAL', {
      step: 'LEGAL',
      status: consent.outstanding.length >= consent.requiredCount ? 'NOT_STARTED' : 'IN_PROGRESS',
      owner: 'ID-005',
      detail: { outstandingPurposes: [...consent.outstanding] },
    });

  // MARKET
  const marketCode = live?.marketCode ?? null;
  if (live === null || marketCode === null) steps.set('MARKET', { step: 'MARKET', status: 'NOT_STARTED', owner: 'PRO-001' });
  else
    steps.set('MARKET', {
      step: 'MARKET',
      status: marketAcceptsProviders(policy, market) ? 'COMPLETE' : 'BLOCKED',
      owner: 'PRO-001',
      detail: { marketCode },
    });

  // SERVICES
  const selected = live?.serviceTypeCodes ?? [];
  if (live === null) steps.set('SERVICES', { step: 'SERVICES', status: 'NOT_STARTED', owner: 'PRO-001' });
  else {
    const offeredSet = new Set(offered ?? []);
    const notOffered = selected.filter((c) => !offeredSet.has(c));
    const detail = { selected: selected.length, min: policy.minServiceTypes, max: policy.maxServiceTypes, ...(notOffered.length > 0 ? { notOffered } : {}) };
    let status: RequirementStep['status'];
    if (notOffered.length > 0 || selected.length > policy.maxServiceTypes) status = 'BLOCKED';
    else if (selected.length >= policy.minServiceTypes && selected.length > 0) status = 'COMPLETE';
    else if (policy.minServiceTypes === 0 && selected.length === 0) status = 'NOT_REQUIRED';
    else status = selected.length === 0 ? 'NOT_STARTED' : 'IN_PROGRESS';
    steps.set('SERVICES', { step: 'SERVICES', status, owner: 'PRO-001', detail });
  }

  // future domains: reported, never required for the registration, never stored here
  steps.set('VERIFICATION', { step: 'VERIFICATION', status: future.verification.status, owner: 'TRUST-001' });
  steps.set('SUBSCRIPTION', { step: 'SUBSCRIPTION', status: future.subscription.status, owner: 'SUB' });
  steps.set('PROFILE', { step: 'PROFILE', status: future.profile.status, owner: 'PRO-002' });
  steps.set('GIGS', { step: 'GIGS', status: future.gigs.status, owner: 'CAT-003' });

  const ordered = ONBOARDING_STEPS.map((s) => steps.get(s)!);
  const blockedBy = REGISTRATION_STEPS.filter((s) => !isStepSatisfied(steps.get(s)!.status));
  return {
    providerRole: providerRoleOf(account.memberships),
    registration: input.registration,
    steps: ordered,
    overall: {
      registrationComplete: input.registration?.status === 'COMPLETED',
      registrationReady: blockedBy.length === 0,
      blockedBy,
      // Go-Live eligibility is PRO-003's: this registration never says "live", whatever its steps are
      goLive: { evaluated: false, eligible: false },
    },
  };
}
