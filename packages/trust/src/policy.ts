// The evidence policy (TRUST-001) as configuration: typed parameters read fresh, never a code default. A missing or invalid value fails closed.
import { TRUST_POLICY_KEYS, TrustDocumentPolicy } from '@bananagig/contracts';
import { TrustError } from './errors';
import type { TrustPolicyProvider } from './types';

export const trustPolicyKeys = (): string[] => Object.values(TRUST_POLICY_KEYS);

/** Builds the policy from the resolved parameter values; any missing or invalid value is UNAVAILABLE (fail closed), never a default. */
export function parseTrustPolicy(values: Readonly<Record<string, unknown>>): TrustDocumentPolicy {
  const parsed = TrustDocumentPolicy.safeParse({
    maxSizeBytes: values[TRUST_POLICY_KEYS.maxSizeBytes],
    allowedMimeTypes: values[TRUST_POLICY_KEYS.allowedMimeTypes],
    maxDocumentsPerRequirement: values[TRUST_POLICY_KEYS.maxDocumentsPerRequirement],
    uploadUrlTtlSeconds: values[TRUST_POLICY_KEYS.uploadUrlTtlSeconds],
    downloadUrlTtlSeconds: values[TRUST_POLICY_KEYS.downloadUrlTtlSeconds],
    requireCleanScan: values[TRUST_POLICY_KEYS.requireCleanScan],
  });
  if (!parsed.success) throw new TrustError('UNAVAILABLE', 'the verification policy is not available', { reason: 'POLICY_INVALID' });
  return parsed.data;
}

export class StaticTrustPolicyProvider implements TrustPolicyProvider {
  constructor(private readonly policy: TrustDocumentPolicy) {}
  async documents(): Promise<TrustDocumentPolicy> {
    return this.policy;
  }
}
