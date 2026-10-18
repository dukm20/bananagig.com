// Composition helpers for the provider Gigs (CAT-003): the ports of ProviderGigService that need other packages, wired in the API composition root. They live here (not in the package)
// so `provider` never imports `catalog` or `configuration`. The Gig Template port answers FACTS about an EXACT template version (a Gig keeps the version it was built from); the
// policy comes from the configuration registry with no code default.
import { CatalogError, type GigTemplateService, type GigTemplateVersionDetailView } from '@bananagig/catalog';
import type { ConfigurationService } from '@bananagig/configuration';
import {
  gigsPrerequisite,
  GigError,
  UnavailablePrerequisites,
  gigPolicyKeys,
  parseGigPolicy,
  type GigPolicyProvider,
  type GigTemplateFieldFacts,
  type GigTemplateOffer,
  type GigTemplatePort,
  type GigTemplateStructure,
  type PrerequisitePort,
  type ProviderGigService,
  type TemplateVersionStatus,
} from '@bananagig/provider';

const unavailable = (): GigError => new GigError('UNAVAILABLE', 'the Gig Template catalogue is unavailable', { reason: 'TEMPLATES_UNAVAILABLE' });

/** Whatever the catalogue throws that the port does not answer as "not found" is an outage of the catalogue: the Gig operation fails closed (UNAVAILABLE). */
const guarded = async <T>(fn: () => Promise<T>, notFound: readonly string[], whenNotFound: T): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GigError) throw err;
    if (err instanceof CatalogError && notFound.includes(err.code)) return whenNotFound;
    throw unavailable();
  }
};

const VERSION_STATUS = new Set<string>(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED']);

/** The catalogue's exact-version view as the Gig's template facts. */
export function toGigTemplateStructure(d: GigTemplateVersionDetailView): GigTemplateStructure {
  const status = d.version.status;
  if (status === undefined || !VERSION_STATUS.has(status)) throw unavailable();
  const fields: GigTemplateFieldFacts[] = d.fields.map((f) => ({
    gigTemplateFieldId: f.gigTemplateFieldId,
    fieldKey: f.fieldKey,
    fieldType: f.fieldType,
    section: f.section,
    behavior: f.behavior,
    customerVisible: f.customerVisible,
    displayOrder: f.displayOrder,
    labelContentKey: f.labelContentKey,
    helpContentKey: f.helpContentKey,
    defaultContentKey: f.defaultContentKey,
    defaultNumber: f.defaultNumber,
    defaultBoolean: f.defaultBoolean,
    defaultOption: f.options.find((o) => o.isDefault)?.optionCode ?? null,
    minLength: f.minLength,
    maxLength: f.maxLength,
    minNumber: f.minNumber,
    maxNumber: f.maxNumber,
    options: f.options.map((o) => ({ optionCode: o.optionCode, displayOrder: o.displayOrder, isDefault: o.isDefault, labelContentKey: o.labelContentKey })),
  }));
  return {
    gigTemplateId: d.gigTemplateId,
    gigTemplateCode: d.code,
    templateStatus: d.templateStatus,
    serviceTypeCode: d.serviceTypeCode,
    serviceTypeStatus: d.serviceTypeStatus,
    categoryCode: d.categoryCode,
    nameContentKey: d.nameContentKey,
    descriptionContentKey: d.descriptionContentKey,
    instructionsContentKey: d.instructionsContentKey,
    gigTemplateVersionId: d.version.gigTemplateVersionId,
    versionNumber: d.version.versionNumber,
    versionStatus: status as TemplateVersionStatus,
    duration: { minMinutes: d.version.duration.minMinutes, maxMinutes: d.version.duration.maxMinutes, suggestedMinutes: d.version.duration.suggestedMinutes },
    pricing: { fixed: d.version.pricingModels.includes('FIXED'), fixedWithVariants: d.version.pricingModels.includes('FIXED_WITH_VARIANTS') },
    fields,
    requirements: d.requirements.map((r) => ({ requirementType: r.requirementType, referenceCode: r.referenceCode })),
  };
}

/**
 * The Gig Templates over the catalogue (CAT-002). What a provider can START from is the public view of the market (ACTIVE template, ACTIVE service type enabled in the market, ACTIVE
 * version): the same answer the public catalogue gives, so `offered` and `forCreate` can never disagree. Every other question is about an EXACT version or a template by code and uses
 * the management reads (any status), because a Gig must stay readable and explainable after its template was paused or retired.
 */
export function createGigTemplatePort(
  templates: Pick<
    GigTemplateService,
    'listGigTemplatesForMarket' | 'getGigTemplateForMarket' | 'getGigTemplateVersionById' | 'getGigTemplateStructure' | 'isGigTemplateEnabledInMarket'
  >,
): GigTemplatePort {
  return {
    async offered(marketCode, serviceTypeCodes): Promise<readonly GigTemplateOffer[]> {
      const wanted = new Set(serviceTypeCodes);
      if (wanted.size === 0) return [];
      return guarded(
        async () => {
          const { templates: all } = await templates.listGigTemplatesForMarket(marketCode);
          return all
            .filter((t) => wanted.has(t.serviceTypeCode) && t.activeVersion !== null)
            .sort(
              (a, b) =>
                (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
            )
            .map((t) => ({
              gigTemplateCode: t.code,
              serviceTypeCode: t.serviceTypeCode,
              categoryCode: t.categoryCode,
              nameContentKey: t.nameContentKey,
              descriptionContentKey: t.descriptionContentKey,
              versionNumber: t.activeVersion!.versionNumber,
            }));
        },
        ['MARKET_NOT_FOUND'],
        [],
      );
    },
    async forCreate(marketCode, gigTemplateCode) {
      return guarded(
        async () => {
          const { template } = await templates.getGigTemplateForMarket(marketCode, gigTemplateCode);
          if (template.activeVersion === null) return null;
          return toGigTemplateStructure(await templates.getGigTemplateVersionById(template.activeVersion.gigTemplateVersionId));
        },
        ['MARKET_NOT_FOUND', 'GIG_TEMPLATE_NOT_FOUND', 'GIG_TEMPLATE_VERSION_NOT_FOUND'],
        null,
      );
    },
    async byCode(gigTemplateCode) {
      return guarded(async () => toGigTemplateStructure(await templates.getGigTemplateStructure(gigTemplateCode)), ['GIG_TEMPLATE_NOT_FOUND'], null);
    },
    async exactVersion(gigTemplateVersionId) {
      return guarded(
        async () => toGigTemplateStructure(await templates.getGigTemplateVersionById(gigTemplateVersionId)),
        ['GIG_TEMPLATE_VERSION_NOT_FOUND'],
        null,
      );
    },
    async enabledInMarket(marketCode, gigTemplateId) {
      return guarded(() => templates.isGigTemplateEnabledInMarket(marketCode, gigTemplateId), [], false);
    },
  };
}

/**
 * The Gig policy comes from the configuration registry (CFG-001): five typed values at PLATFORM scope, read fresh through the registry's own cache, with NO code default. A missing,
 * malformed or unreadable value is an outage of the policy (UNAVAILABLE): the operation fails closed.
 */
export function createGigPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): GigPolicyProvider {
  return {
    async policy() {
      let values: Map<string, { value: unknown }>;
      try {
        values = (await configuration.resolveMany([...gigPolicyKeys()])).values;
      } catch {
        throw new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_UNREADABLE' });
      }
      return parseGigPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/**
 * PRO-001's `gigs` onboarding step, answered by the Gig domain (CAT-003): NOT_STARTED, IN_PROGRESS or COMPLETE from the readiness facts. PRO-001 owns no Gig state and does not change
 * its own lifecycle because of it; a failure of the Gig domain reports the step NOT_AVAILABLE (it never blocks or breaks the registration read). The other steps stay as they were.
 */
export function createGigPrerequisites(
  gigs: Pick<ProviderGigService, 'getGigReadinessFacts'>,
  rest: PrerequisitePort = UnavailablePrerequisites,
): PrerequisitePort {
  const step = gigsPrerequisite(gigs);
  return {
    ...rest,
    async gigs(accountId) {
      try {
        return await step(accountId);
      } catch {
        return { status: 'NOT_AVAILABLE' };
      }
    },
  };
}
