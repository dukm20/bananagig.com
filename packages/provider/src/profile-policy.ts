// The provider profile policy (PRO-002): typed configuration values (CFG-001, PLATFORM scope, no code default). A missing, malformed or out-of-range value is a policy outage: the
// operation fails closed with UNAVAILABLE (reason POLICY_INVALID), never a guess. The configuration-backed provider lives in the API composition root (the provider package never
// imports the configuration package); it reads `profilePolicyKeys()` and hands the values to `parseProfilePolicy`.
import { PROVIDER_PROFILE_POLICY_KEYS, ProviderProfilePolicy } from '@bananagig/contracts';
import { ProfileError } from './profile-errors';

export const profilePolicyKeys = (): readonly string[] => Object.values(PROVIDER_PROFILE_POLICY_KEYS);

/** Parses the seven configuration values (keyed by configuration key) with the strict contract schema. */
export function parseProfilePolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderProfilePolicy {
  const k = PROVIDER_PROFILE_POLICY_KEYS;
  const parsed = ProviderProfilePolicy.safeParse({
    displayNameMaxLength: values[k.displayNameMaxLength],
    bioMaxLength: values[k.bioMaxLength],
    bioRequired: values[k.bioRequired],
    photoRequired: values[k.photoRequired],
    photoMaxFileSizeBytes: values[k.photoMaxFileSizeBytes],
    publicBadgeTypes: values[k.publicBadgeTypes],
    publicRequiresMarketplaceEligibility: values[k.publicRequiresMarketplaceEligibility],
  });
  if (!parsed.success) throw new ProfileError('UNAVAILABLE', 'the profile policy is not available', { reason: 'POLICY_INVALID' });
  return parsed.data;
}
