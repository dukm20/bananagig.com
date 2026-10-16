// In-memory implementation of the consent policy port for tests (ID-005): a static provider with per-purpose values, a read counter and failure injection. Never imported
// by production code.
import { SEEDED_CONSENT_PURPOSES } from '@bananagig/contracts';
import type { ConsentPolicy, ConsentPolicyProvider } from './consent-types';
import { AccountError } from './errors';

/** The seeded values of migration 0013: CUSTOMER and PROVIDER accept both documents, a new version needs a fresh acceptance. */
export const SEEDED_CONSENT_POLICY: Readonly<ConsentPolicy> = Object.freeze({ requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });

export class StaticConsentPolicyProvider implements ConsentPolicyProvider {
  /** Number of reads, for tests that check a policy is read (or not) per operation. */
  reads = 0;
  /** The purposes read, in order. */
  readonly readPurposes: string[] = [];
  /** Set to make every read throw this value (a configuration outage). */
  failure: unknown;
  private readonly values = new Map<string, ConsentPolicy>();

  /** Starts with the seeded policy for the two seeded purposes (pass `{}` for an empty provider, or your own map). */
  constructor(
    initial: Readonly<Record<string, ConsentPolicy>> = Object.fromEntries(SEEDED_CONSENT_PURPOSES.map((code) => [code, { ...SEEDED_CONSENT_POLICY }])),
  ) {
    for (const [code, policy] of Object.entries(initial)) this.values.set(code, policy);
  }
  /** Replaces the policy of a purpose (a configuration change between two calls). The value is NOT validated here: the service validates every read, like a real provider's output. */
  set(purposeCode: string, policy: ConsentPolicy): void {
    this.values.set(purposeCode, policy);
  }
  /** Removes the policy of a purpose: reading it then fails like a missing configuration value. */
  unset(purposeCode: string): void {
    this.values.delete(purposeCode);
  }
  async policy(purposeCode: string): Promise<ConsentPolicy> {
    this.reads += 1;
    this.readPurposes.push(purposeCode);
    if (this.failure !== undefined) throw this.failure;
    const value = this.values.get(purposeCode);
    if (value === undefined) throw new AccountError('UNAVAILABLE', 'the consent policy is not available', { reason: 'POLICY_INVALID', purposeCode });
    // returned as set (a copy of the list): the service validates every read, so tests can inject a malformed value through set()
    return { ...value, requiredForRoles: Array.isArray(value.requiredForRoles) ? [...value.requiredForRoles] : value.requiredForRoles };
  }
}
