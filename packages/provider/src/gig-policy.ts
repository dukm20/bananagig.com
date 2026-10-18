// The Gig policy (CAT-003, CAT-004): typed configuration values (CFG-001, PLATFORM scope, no code default). A missing, malformed or out-of-range value is a policy outage: the
// operation fails closed with UNAVAILABLE (reason POLICY_INVALID), never a guess.
import {
  PROVIDER_GIG_MEDIA_POLICY_KEYS,
  PROVIDER_GIG_OPTIONS_POLICY_KEYS,
  PROVIDER_GIG_POLICY_KEYS,
  ProviderGigMediaPolicy,
  ProviderGigOptionsPolicy,
  ProviderGigPolicy,
} from '@bananagig/contracts';
import { GigError } from './gig-errors';
import type { GigPolicyProvider } from './gig-types';

export const gigPolicyKeys = (): readonly string[] => Object.values(PROVIDER_GIG_POLICY_KEYS);
export const gigOptionsPolicyKeys = (): readonly string[] => Object.values(PROVIDER_GIG_OPTIONS_POLICY_KEYS);
export const gigMediaPolicyKeys = (): readonly string[] => Object.values(PROVIDER_GIG_MEDIA_POLICY_KEYS);
const invalid = () => new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });

export function parseGigPolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderGigPolicy {
  const parsed = ProviderGigPolicy.safeParse({
    maxActive: values[PROVIDER_GIG_POLICY_KEYS.maxActive],
    maxDrafts: values[PROVIDER_GIG_POLICY_KEYS.maxDrafts],
    titleMaxLength: values[PROVIDER_GIG_POLICY_KEYS.titleMaxLength],
    shortPitchMaxLength: values[PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength],
    descriptionMaxLength: values[PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength],
  });
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function parseGigOptionsPolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderGigOptionsPolicy {
  const k = PROVIDER_GIG_OPTIONS_POLICY_KEYS;
  const parsed = ProviderGigOptionsPolicy.safeParse({
    variantMaxCount: values[k.variantMaxCount],
    addOnMaxCount: values[k.addOnMaxCount],
    nameMaxLength: values[k.nameMaxLength],
    descriptionMaxLength: values[k.descriptionMaxLength],
  });
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function parseGigMediaPolicy(values: Readonly<Partial<Record<string, unknown>>>): ProviderGigMediaPolicy {
  const k = PROVIDER_GIG_MEDIA_POLICY_KEYS;
  const parsed = ProviderGigMediaPolicy.safeParse({
    maxFileSizeBytes: values[k.maxFileSizeBytes],
    maxItems: values[k.maxItems],
    allowedMimeTypes: values[k.allowedMimeTypes],
    uploadTtlSeconds: values[k.uploadTtlSeconds],
    requireCleanScan: values[k.requireCleanScan],
    minEdgePixels: values[k.minEdgePixels],
    maxEdgePixels: values[k.maxEdgePixels],
    maxPixels: values[k.maxPixels],
    downloadTtlSeconds: values[k.downloadTtlSeconds],
    orphanGraceSeconds: values[k.orphanGraceSeconds],
    altTextMaxLength: values[k.altTextMaxLength],
  });
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** The seeded defaults (the migration seeds the same values); tests that do not read the configuration registry use them. */
export const DEFAULT_GIG_OPTIONS_POLICY: ProviderGigOptionsPolicy = { variantMaxCount: 10, addOnMaxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 };
export const DEFAULT_GIG_MEDIA_POLICY: ProviderGigMediaPolicy = {
  maxFileSizeBytes: 10_485_760,
  maxItems: 50,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  uploadTtlSeconds: 900,
  requireCleanScan: true,
  minEdgePixels: 200,
  maxEdgePixels: 12_000,
  maxPixels: 50_000_000,
  downloadTtlSeconds: 60,
  orphanGraceSeconds: 86_400,
  altTextMaxLength: 200,
};

/** A fixed policy for tests and tools that do not read the configuration registry. */
export class StaticGigPolicyProvider implements GigPolicyProvider {
  reads = 0;
  failure: Error | undefined;
  constructor(
    public value: ProviderGigPolicy,
    public optionsValue: ProviderGigOptionsPolicy = DEFAULT_GIG_OPTIONS_POLICY,
    public mediaValue: ProviderGigMediaPolicy = DEFAULT_GIG_MEDIA_POLICY,
  ) {}
  async policy(): Promise<ProviderGigPolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.value;
  }
  async options(): Promise<ProviderGigOptionsPolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.optionsValue;
  }
  async media(): Promise<ProviderGigMediaPolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.mediaValue;
  }
}
