// The ports and facts of the provider Gig (CAT-003). Domain packages never import each other: everything the Gig needs from the Gig Template domain (CAT-002) is a PORT here,
// implemented in the API composition root over the catalog service. A port returns FACTS about an EXACT template version; nothing is copied into a Gig.
import type { GigDetailDto, ProviderGigMediaPolicy, ProviderGigOptionsPolicy, ProviderGigPolicy } from '@bananagig/contracts';
import type { Trx } from '@bananagig/database';

export type TemplateVersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';

export interface GigTemplateFieldFacts {
  /** The identity the Gig's field values reference (catalog.gig_template_fields.gig_template_field_id). */
  gigTemplateFieldId: string;
  fieldKey: string;
  fieldType: string;
  section: string;
  behavior: 'PLATFORM_FIXED' | 'PROVIDER_CONFIGURABLE' | 'PROVIDER_REQUIRED';
  customerVisible: boolean;
  displayOrder: number;
  labelContentKey: string;
  helpContentKey: string | null;
  defaultContentKey: string | null;
  defaultNumber: number | null;
  defaultBoolean: boolean | null;
  /** The option code flagged as default (ENUM). */
  defaultOption: string | null;
  minLength: number | null;
  maxLength: number | null;
  minNumber: number | null;
  maxNumber: number | null;
  /** MEDIA fields: the template version's bounds on the number of photos (max 0 = prohibited; a PROVIDER_REQUIRED field has min >= 1). */
  minItems: number | null;
  maxItems: number | null;
  options: readonly { optionCode: string; displayOrder: number; isDefault: boolean; labelContentKey?: string }[];
}

/** Everything the Gig needs to know about ONE exact template version, with the identity facts it belongs to. */
export interface GigTemplateStructure {
  gigTemplateId: string;
  gigTemplateCode: string;
  /** ACTIVE, INACTIVE or RETIRED (DRAFT never reaches a provider). */
  templateStatus: string;
  serviceTypeCode: string;
  serviceTypeStatus: string;
  categoryCode: string;
  nameContentKey: string;
  descriptionContentKey: string | null;
  instructionsContentKey: string | null;
  gigTemplateVersionId: string;
  versionNumber: number;
  versionStatus: TemplateVersionStatus;
  duration: { minMinutes: number | null; maxMinutes: number | null; suggestedMinutes: number | null };
  /** The pricing models the version allows (a provider price is permitted when FIXED or FIXED_WITH_VARIANTS is allowed; the others concern later checkpoints). */
  pricing: { fixed: boolean; fixedWithVariants: boolean };
  /** CAT-004: whether the version lets a Gig offer add-ons (an explicit template-version permission, off unless the template author turned it on). */
  addOnsAllowed: boolean;
  fields: readonly GigTemplateFieldFacts[];
  requirements: readonly { requirementType: string; referenceCode: string | null }[];
}

/** What a provider can start a Gig from in a market (the ACTIVE version of an ACTIVE template, enabled in the market). */
export interface GigTemplateOffer {
  gigTemplateCode: string;
  serviceTypeCode: string;
  categoryCode: string;
  nameContentKey: string;
  descriptionContentKey: string | null;
  versionNumber: number;
}

export interface GigTemplatePort {
  /** The templates offered in a market, restricted to the given service type codes (ordered by the market's display order, then code). */
  offered(marketCode: string, serviceTypeCodes: readonly string[]): Promise<readonly GigTemplateOffer[]>;
  /**
   * The structure of the ACTIVE version of the template, only when a NEW Gig can be created from it now: the template is ACTIVE, its service type is ACTIVE, it has an ACTIVE
   * version and it is enabled in the market. null otherwise (the service says why from `byCode`).
   */
  forCreate(marketCode: string, gigTemplateCode: string): Promise<GigTemplateStructure | null>;
  /** The template by code with its ACTIVE version when there is one (any template status); null when the code is unknown. Used to give the right refusal reason. */
  byCode(gigTemplateCode: string): Promise<GigTemplateStructure | null>;
  /** The EXACT version, whatever its status (a Gig keeps the version it was built from); null when unknown. */
  exactVersion(gigTemplateVersionId: string): Promise<GigTemplateStructure | null>;
  /** Whether the template (identity) is enabled in the market now. */
  enabledInMarket(marketCode: string, gigTemplateId: string): Promise<boolean>;
}

export interface GigPolicyProvider {
  /** The CURRENT policy. Throws GigError UNAVAILABLE (reason POLICY_INVALID) when the configuration is unreadable or invalid: no code default exists. */
  policy(): Promise<ProviderGigPolicy>;
  /** CAT-004: the limits of variants and add-ons (same fail-closed rule). */
  options(): Promise<ProviderGigOptionsPolicy>;
  /** CAT-004: the limits of the photos (same fail-closed rule). */
  media(): Promise<ProviderGigMediaPolicy>;
}

// ---------------------------------------------------------------- CAT-004: media scanning and the draft-mutation primitive
export interface GigMediaScanInput {
  /** The object key, only so a scanner can correlate; it never leaves the process. */
  key: string;
  size: number;
  bytes: Buffer;
}
export interface GigMediaScanResult {
  status: 'CLEAN' | 'INFECTED' | 'ERROR';
}
/** The malware scanner for provider photos (provider-neutral). Production has none yet: the disabled adapter reports ERROR, so with `requireCleanScan` nothing can be attached. */
export interface GigMediaScanner {
  scan(i: GigMediaScanInput): Promise<GigMediaScanResult>;
}
/** The adapter used when no scanner is wired: every scan is an ERROR (fail closed). */
export const DisabledGigMediaScanner: GigMediaScanner = { scan: async () => ({ status: 'ERROR' }) };

/** What the draft-mutation helpers know about the DRAFT of a Gig (no lock held). */
export interface DraftReadContext {
  gigId: string;
  gigStatus: string;
  draft: { gigVersionId: string; versionNumber: number; revision: number; gigTemplateVersionId: string };
  /** The EXACT bound template version. */
  structure: GigTemplateStructure;
  /** The provider's market currency (null when the registration is not completed). */
  currency: string | null;
}
export interface DraftMutationContext extends DraftReadContext {
  trx: Trx;
  accountId: string;
  /** The correlation id to put on audit rows and outbox events. */
  cid: string;
}
/**
 * The primitive every child mutation (variants, add-ons, media) runs on, implemented by ProviderGigService: owner-scoped, ONE transaction holding the locks in the fixed order
 * (account, Gig, the DRAFT row at `expectedRevision`: a different revision is STALE_DRAFT), then `run`; when `run` reports a change the draft revision is raised by exactly 1 and the
 * answer is the Gig detail read after the commit. Eligibility (ACTIVE account, ACTIVE role) is checked like a draft save.
 */
export interface DraftMutator {
  /** Owner-scoped read of the draft context. Throws GIG_NOT_FOUND, GIG_RETIRED or NO_DRAFT. Takes no lock and does not check a revision. */
  readDraft(accountId: string, gigId: string): Promise<DraftReadContext>;
  mutateDraft<T>(
    accountId: string,
    gigId: string,
    expectedRevision: number,
    run: (ctx: DraftMutationContext) => Promise<{ changed: boolean; value: T }>,
  ): Promise<{ value: T; detail: GigDetailDto }>;
}
