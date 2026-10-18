// The Gig policy (CAT-003): five typed configuration values (CFG-001, PLATFORM scope, no code default). A missing, malformed or out-of-range value is a policy outage: the
// operation fails closed with UNAVAILABLE (reason POLICY_INVALID), never a guess.
import { PROVIDER_GIG_POLICY_KEYS, ProviderGigPolicy } from '@bananagig/contracts';
import { GigError } from './gig-errors';
import type { GigPolicyProvider } from './gig-types';

export const gigPolicyKeys = (): readonly string[] => Object.values(PROVIDER_GIG_POLICY_KEYS);

export function parseGigPolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderGigPolicy {
  const parsed = ProviderGigPolicy.safeParse({
    maxActive: values[PROVIDER_GIG_POLICY_KEYS.maxActive],
    maxDrafts: values[PROVIDER_GIG_POLICY_KEYS.maxDrafts],
    titleMaxLength: values[PROVIDER_GIG_POLICY_KEYS.titleMaxLength],
    shortPitchMaxLength: values[PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength],
    descriptionMaxLength: values[PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength],
  });
  if (!parsed.success) throw new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });
  return parsed.data;
}

/** A fixed policy for tests and tools that do not read the configuration registry. */
export class StaticGigPolicyProvider implements GigPolicyProvider {
  reads = 0;
  failure: Error | undefined;
  constructor(public value: ProviderGigPolicy) {}
  async policy(): Promise<ProviderGigPolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.value;
  }
}
