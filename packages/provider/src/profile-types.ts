// The ports and facts of the provider public profile (PRO-002). Domain packages never import each other: everything the profile needs from another domain is a PORT here, implemented in the
// API composition root over the owning service. A port returns FACTS (codes, names, booleans); nothing is copied into the profile, and the public projection is derived on every read.
import type { OwnerProfileStateDto, ProfileAuditAction, ProfileFieldName, ProviderProfilePolicy, TrustRequirementType } from '@bananagig/contracts';
import type { Trx } from '@bananagig/database';

/** The names of the account, read through the identity domain. Legal names are used ONLY to derive the fallback `First L.`; they never leave the projection in full. */
export interface AccountNamePort {
  /** Null when the account has no name row yet. */
  names(accountId: string): Promise<{ firstName: string; lastName: string } | null>;
}

/** TRUST-001: the customer-appropriate badges, derived from the live verification case on every call. */
export interface TrustSummaryPort {
  /**
   * The requirement TYPES (a subset of `allowedTypes`) for which the provider's CURRENT case holds at least one non-superseded requirement whose effective status is APPROVED and not
   * expired at this moment. Type codes only: no ids, dates, counts, document types or reasons. A constant number of statements.
   */
  publicBadgeTypes(accountId: string, allowedTypes: readonly TrustRequirementType[]): Promise<readonly TrustRequirementType[]>;
}

/** What the Gig summaries need to name a Gig's service: derived from the EXACT template versions, in ONE batch (no N+1). */
export interface GigServiceNamePort {
  forTemplateVersions(gigTemplateVersionIds: readonly string[]): Promise<ReadonlyMap<string, { serviceTypeCode: string; nameContentKey: string }>>;
}

/**
 * PRO-003 / SEARCH later: whether a provider may be shown to customers at all. Consulted only when `provider.profile.public_requires_marketplace_eligibility` is true; with the flag true
 * and no port wired the public read fails closed (the same 404 as an unknown profile).
 */
export interface MarketplaceEligibilityPort {
  isEligible(accountId: string): Promise<boolean>;
}

export interface ProfilePolicyProvider {
  /** The CURRENT policy. Throws ProfileError UNAVAILABLE (reason POLICY_INVALID) when the configuration is unreadable or invalid: no code default exists. */
  policy(): Promise<ProviderProfilePolicy>;
}

/** A fixed policy for tests and tools that do not read the configuration registry (the migration seeds the same values). */
export const DEFAULT_PROFILE_POLICY: ProviderProfilePolicy = {
  displayNameMaxLength: 60,
  bioMaxLength: 1000,
  bioRequired: false,
  photoRequired: false,
  photoMaxFileSizeBytes: 2_097_152,
  publicBadgeTypes: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'],
  publicRequiresMarketplaceEligibility: false,
};
export class StaticProfilePolicyProvider implements ProfilePolicyProvider {
  reads = 0;
  failure: Error | undefined;
  constructor(public value: ProviderProfilePolicy = DEFAULT_PROFILE_POLICY) {}
  async policy(): Promise<ProviderProfilePolicy> {
    this.reads++;
    if (this.failure) throw this.failure;
    return this.value;
  }
}

// ---------------------------------------------------------------- the profile-mutation primitive (shared by the profile service and the photo service)
/** What the photo service needs to know about the profile row (read without a lock). */
export interface ProfileReadContext {
  publicProfileId: string;
  revision: number;
  photoAssetId: string | null;
  pendingPhotoAssetId: string | null;
}
export interface ProfileMutationContext extends ProfileReadContext {
  trx: Trx;
  accountId: string;
  /** The correlation id to put on audit rows and outbox events. */
  cid: string;
}
/** What a mutation reports: whether anything really changed, which audit action and field NAMES describe it. */
export interface ProfileMutationOutcome<T> {
  changed: boolean;
  action: ProfileAuditAction;
  changedFields: readonly ProfileFieldName[];
  /**
   * Whether the change is visible to customers. Default true. A change that only moves the pending-upload pointer (an upload was authorized or abandoned) reports `false`: the revision
   * and the audit row are still written, but NO `profile-updated` outbox event is emitted because nothing public changed.
   */
  publicChange?: boolean;
  value: T;
}
/**
 * The primitive every profile mutation runs on, implemented by ProviderProfileService: owner-scoped, ONE transaction holding the locks in the fixed order (account, profile at
 * `expectedRevision`: a different revision is STALE_PROFILE, asset rows only afterwards), then `run`. REVISION CONTRACT: the database guard refuses a content change unless `revision = OLD + 1` is written in the SAME UPDATE (and refuses a revision-only UPDATE), so `run` itself
 * writes `revision = ctx.revision + 1` together with the change and reports `changed: true`; the primitive verifies the revision is exactly `ctx.revision + 1` (a plain Error rolls back otherwise).
 * A change of the pending pointer only reports `changed: false`. When `changed` is true ONE audit row and the outbox event are written in the same transaction, and the answer is the owner state read after the commit. The caller may not write the audit or the outbox itself.
 */
export interface ProfileMutator {
  /** Owner-scoped read of the profile row. Throws PROFILE_NOT_FOUND. Takes no lock and does not check a revision. */
  readProfile(accountId: string): Promise<ProfileReadContext>;
  mutateProfile<T>(
    accountId: string,
    expectedRevision: number,
    run: (ctx: ProfileMutationContext) => Promise<ProfileMutationOutcome<T>>,
  ): Promise<{ value: T; state: OwnerProfileStateDto }>;
}

/** Where a photo lives: the asset the bytes are read from, and the ETag seed for conditional requests. Produced by the profile service only after every visibility and eligibility rule passed. */
export interface ProfilePhotoTarget {
  assetId: string;
}

// ---------------------------------------------------------------- the photo service (profile-photo.ts, PRO-002 agent B2) as the API layer sees it
export interface ProfilePhotoBytes {
  kind: 'bytes';
  /** The SANITISED image (container-level: location, camera and text metadata are gone, the pixels are untouched). */
  bytes: Buffer;
  contentType: string;
  /** An opaque weak validator (never the content hash). */
  etag: string;
}
export interface ProfilePhotoNotModified {
  kind: 'not-modified';
  etag: string;
}
export type ProfilePhotoResult = ProfilePhotoBytes | ProfilePhotoNotModified;
export interface ProfilePhotoApi {
  /** Authorizes ONE upload (abandons a previous unfinished one). Throws ProfileError (MEDIA_REFUSED for a bad size or type). */
  requestUpload(accountId: string, input: unknown): Promise<import('@bananagig/contracts').ProfilePhotoUploadDto>;
  /** Verifies the uploaded object, promotes it and records it as the profile photo; answers the owner state. */
  finalize(accountId: string, input: unknown): Promise<OwnerProfileStateDto>;
  /** Removes the photo (and any pending upload); answers the owner state. */
  remove(accountId: string, input: unknown): Promise<OwnerProfileStateDto>;
  /** The owner's own photo (sanitised). Null when there is none. */
  ownerPhoto(accountId: string, opts?: { ifNoneMatch?: string }): Promise<ProfilePhotoResult | null>;
  /** The public photo of a profile that is publicly readable now. Null (never an error) for anything else, so the answer cannot tell a private profile from an unknown one. */
  publicPhoto(publicProfileId: string, opts?: { ifNoneMatch?: string }): Promise<ProfilePhotoResult | null>;
}
