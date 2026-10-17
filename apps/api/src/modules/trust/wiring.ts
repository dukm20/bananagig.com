// Composition helpers for provider verification (TRUST-001): the ports of TrustService that need other packages, wired in the API composition root. They live here (not in the
// package) so `trust` never imports `provider`, `accounts`, `configuration` or the catalogue; and the PRO-001 prerequisite port that reports the verification step.
import type { ConfigurationService } from '@bananagig/configuration';
import {
  ProviderError,
  UnavailablePrerequisites,
  contactState,
  type AccountPort,
  type PolicyProvider as ProviderPolicyProvider,
  type PrerequisitePort,
  type ProviderRegistrationService,
} from '@bananagig/provider';
import {
  TrustError,
  onboardingStepStatus,
  parseTrustPolicy,
  trustPolicyKeys,
  type ProviderContextPort,
  type TrustPolicyProvider,
  type TrustService,
} from '@bananagig/trust';

/**
 * What verification needs to know about the provider's registration, read through the registration's own ports (PRO-001 owns it; nothing is copied): the account status, whether the
 * configured contacts are verified (the registration policy decides which), whether a live registration exists and its market and service types. `registrations` is a getter
 * because the registration service itself is constructed with the verification prerequisite that uses this port.
 */
export function createProviderContextPort(deps: {
  accounts: AccountPort;
  policy: ProviderPolicyProvider;
  registrations: () => Pick<ProviderRegistrationService, 'getRegistration'>;
}): ProviderContextPort {
  return {
    async context(accountId) {
      let facts;
      try {
        facts = await deps.accounts.facts(accountId);
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'ACCOUNT_NOT_ACTIVE') return null;
        throw new TrustError('UNAVAILABLE', 'verification is unavailable');
      }
      try {
        const [policy, state] = await Promise.all([deps.policy.policy(), deps.registrations().getRegistration(accountId, { facts })]);
        const contacts = contactState(policy, facts).status;
        const live = state.registration !== null && state.registration.status !== 'CANCELLED' ? state.registration : null;
        return {
          accountActive: facts.status === 'ACTIVE',
          contactsVerified: contacts === 'COMPLETE' || contacts === 'NOT_REQUIRED',
          registrationLive: live !== null,
          marketCode: live?.marketCode ?? null,
          serviceTypeCodes: live ? [...live.serviceTypeCodes] : [],
        };
      } catch {
        throw new TrustError('UNAVAILABLE', 'verification is unavailable');
      }
    },
  };
}

/**
 * The evidence policy from the configuration registry (CFG-001): typed values, read fresh. No code default: a missing, malformed or unreadable value is an outage of the policy
 * (UNAVAILABLE) and the operation fails closed.
 */
export function createTrustPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): TrustPolicyProvider {
  return {
    async documents() {
      let values: Map<string, { value: unknown }>;
      try {
        values = (await configuration.resolveMany([...trustPolicyKeys()])).values;
      } catch {
        throw new TrustError('UNAVAILABLE', 'the verification policy is not available', { reason: 'POLICY_UNREADABLE' });
      }
      return parseTrustPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/**
 * PRO-001's `verification` onboarding step, answered by the verification domain (TRUST-001). PRO-001 owns no verification state and does not change its own lifecycle because of it;
 * a failure of the verification domain reports the step NOT_AVAILABLE (it never blocks or breaks the registration read). The other future steps stay as they were.
 */
export function createTrustPrerequisites(trust: Pick<TrustService, 'getVerification'>, rest: PrerequisitePort = UnavailablePrerequisites): PrerequisitePort {
  return {
    ...rest,
    async verification(accountId) {
      try {
        const v = await trust.getVerification(accountId);
        return { status: onboardingStepStatus(v.overall.status) };
      } catch {
        return { status: 'NOT_AVAILABLE' };
      }
    },
  };
}
