// The registration policy (PRO-001): five typed configuration values (CFG-001, PLATFORM scope, no code default). A missing, malformed or contradictory value is a policy outage:
// the operation fails closed with UNAVAILABLE (reason POLICY_INVALID), never a guess.
import { PROVIDER_POLICY_KEYS, ProviderRegistrationPolicy } from '@bananagig/contracts';
import { ProviderError } from './errors';
import type { PolicyProvider } from './types';

export const providerPolicyKeys = (): readonly string[] => Object.values(PROVIDER_POLICY_KEYS);

/** Parses the five configuration values (keyed by configuration key) with the strict contract schema. */
export function parseProviderPolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderRegistrationPolicy {
  const parsed = ProviderRegistrationPolicy.safeParse({
    requireVerifiedEmail: values[PROVIDER_POLICY_KEYS.requireVerifiedEmail],
    requireVerifiedPhone: values[PROVIDER_POLICY_KEYS.requireVerifiedPhone],
    marketStatusesAllowed: values[PROVIDER_POLICY_KEYS.marketStatusesAllowed],
    minServiceTypes: values[PROVIDER_POLICY_KEYS.minServiceTypes],
    maxServiceTypes: values[PROVIDER_POLICY_KEYS.maxServiceTypes],
  });
  if (!parsed.success) throw new ProviderError('UNAVAILABLE', 'the provider registration policy is not available', { reason: 'POLICY_INVALID' });
  return parsed.data;
}

/** A fixed policy for tests and tools that do not read the configuration registry. */
export class StaticPolicyProvider implements PolicyProvider {
  reads = 0;
  failure: Error | undefined;
  constructor(public value: ProviderRegistrationPolicy) {}
  async policy(): Promise<ProviderRegistrationPolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.value;
  }
}
