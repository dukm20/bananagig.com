// Row mappers and read-model builders of the provider Gig (CAT-003). Pure: rows and template facts in, DTOs out. Template structure is never copied into a Gig: the DTO's `fields`,
// `template` and `constraints` are resolved from the exact template version every time.
import {
  gigStatusKey,
  gigVersionStatusKey,
  isGigFieldTypeSupported,
  type GigChildSummaryDto,
  type GigConstraintsDto,
  type GigDto,
  type GigFieldDto,
  type GigFieldValueDto,
  type GigIssueDto,
  type GigOptionDto,
  type GigStatus,
  type GigTemplateLinkDto,
  type GigVersionDto,
  type GigVersionStatus,
  type GigVersionSummaryDto,
  type ProviderGigMediaPolicy,
  type ProviderGigOptionsPolicy,
  type ProviderGigPolicy,
} from '@bananagig/contracts';
import { optionKindValid, optionsIssues, optionsPermitted, type OptionStats } from './gig-options';
import { mediaSummary, mediaIssues, toMediaDtos, type GigMediaRow } from './gig-media-model';
import type { GigTemplateFieldFacts, GigTemplateStructure } from './gig-types';
import { completenessIssues, durationAllowed, priceAllowed, sortedFields, type FieldValue, type GigContent } from './gig-validate';

export type Row = Record<string, unknown>;

export const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const isoOrNull = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface GigRow {
  gigId: string;
  accountId: string;
  status: GigStatus;
  gigTemplateId: string;
  gigTemplateCode: string;
  nameContentKey: string;
  serviceTypeCode: string;
  categoryCode: string;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}
export const toGigRow = (r: Row): GigRow => ({
  gigId: r.gig_id as string,
  accountId: r.account_id as string,
  status: r.status as GigStatus,
  gigTemplateId: r.gig_template_id as string,
  gigTemplateCode: r.template_code as string,
  nameContentKey: r.name_content_key as string,
  serviceTypeCode: r.service_type_code as string,
  categoryCode: r.category_code as string,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  retiredAt: isoOrNull(r.retired_at),
});

export interface VersionRow {
  gigVersionId: string;
  gigId: string;
  versionNumber: number;
  gigTemplateVersionId: string;
  gigTemplateVersionNumber: number;
  status: GigVersionStatus;
  revision: number;
  title: string | null;
  shortPitch: string | null;
  description: string | null;
  priceAmountMinor: number | null;
  priceCurrency: string | null;
  durationMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  supersededAt: string | null;
  retiredAt: string | null;
}
export const toVersionRow = (r: Row): VersionRow => ({
  gigVersionId: r.gig_version_id as string,
  gigId: r.gig_id as string,
  versionNumber: Number(r.version_number),
  gigTemplateVersionId: r.gig_template_version_id as string,
  gigTemplateVersionNumber: Number(r.template_version_number),
  status: r.status as GigVersionStatus,
  revision: Number(r.revision),
  title: (r.title as string | null) ?? null,
  shortPitch: (r.short_pitch as string | null) ?? null,
  description: (r.description as string | null) ?? null,
  priceAmountMinor: numOrNull(r.price_amount_minor),
  priceCurrency: ((r.price_currency as string | null) ?? null)?.trim() ?? null,
  durationMinutes: numOrNull(r.duration_minutes),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  publishedAt: isoOrNull(r.published_at),
  supersededAt: isoOrNull(r.superseded_at),
  retiredAt: isoOrNull(r.retired_at),
});

/** The stored typed value of a field-value row as the one value the API speaks. */
export function valueOfRow(f: GigTemplateFieldFacts, r: Row): FieldValue | undefined {
  switch (f.fieldType) {
    case 'TEXT':
    case 'LONG_TEXT':
      return (r.text_value as string | null) ?? undefined;
    case 'INTEGER':
      return r.integer_value === null || r.integer_value === undefined ? undefined : Number(r.integer_value);
    case 'DECIMAL':
      return (r.decimal_value as string | null) ?? undefined;
    case 'BOOLEAN':
      return r.boolean_value === null || r.boolean_value === undefined ? undefined : r.boolean_value === true;
    case 'ENUM':
      return (r.option_code as string | null) ?? undefined;
    case 'DURATION':
      return r.duration_minutes === null || r.duration_minutes === undefined ? undefined : Number(r.duration_minutes);
    default:
      return undefined;
  }
}
/** The typed columns a value is written to (exactly one is set). */
export function columnsOf(f: GigTemplateFieldFacts, v: FieldValue) {
  const none = {
    text: null as string | null,
    integer: null as number | null,
    decimal: null as string | null,
    bool: null as boolean | null,
    option: null as string | null,
    duration: null as number | null,
  };
  switch (f.fieldType) {
    case 'TEXT':
    case 'LONG_TEXT':
      return { ...none, text: v as string };
    case 'INTEGER':
      return { ...none, integer: v as number };
    case 'DECIMAL':
      return { ...none, decimal: v as string };
    case 'BOOLEAN':
      return { ...none, bool: v as boolean };
    case 'ENUM':
      return { ...none, option: v as string };
    default:
      return { ...none, duration: v as number };
  }
}

export const contentOf = (v: VersionRow, values: ReadonlyMap<string, FieldValue>): GigContent => ({
  title: v.title,
  shortPitch: v.shortPitch,
  description: v.description,
  priceAmountMinor: v.priceAmountMinor,
  priceCurrency: v.priceCurrency,
  durationMinutes: v.durationMinutes,
  values,
});

// ---------------------------------------------------------------- DTOs
export function gigDto(g: GigRow): GigDto {
  return {
    gigId: g.gigId,
    status: g.status,
    statusKey: gigStatusKey(g.status),
    gigTemplateCode: g.gigTemplateCode,
    serviceTypeCode: g.serviceTypeCode,
    categoryCode: g.categoryCode,
    nameContentKey: g.nameContentKey,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    retiredAt: g.retiredAt,
  };
}

export function summaryDto(v: VersionRow): GigVersionSummaryDto {
  return {
    gigVersionId: v.gigVersionId,
    versionNumber: v.versionNumber,
    status: v.status,
    statusKey: gigVersionStatusKey(v.status),
    revision: v.revision,
    gigTemplateVersionNumber: v.gigTemplateVersionNumber,
    title: v.title,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    publishedAt: v.publishedAt,
    supersededAt: v.supersededAt,
    retiredAt: v.retiredAt,
  };
}

export function linkDto(s: GigTemplateStructure): GigTemplateLinkDto {
  return {
    gigTemplateCode: s.gigTemplateCode,
    gigTemplateVersionId: s.gigTemplateVersionId,
    gigTemplateVersionNumber: s.versionNumber,
    versionStatus: s.versionStatus,
    templateStatus: s.templateStatus,
    serviceTypeCode: s.serviceTypeCode,
    categoryCode: s.categoryCode,
    nameContentKey: s.nameContentKey,
    descriptionContentKey: s.descriptionContentKey,
    instructionsContentKey: s.instructionsContentKey,
    requirements: s.requirements.map((q) => ({ requirementType: q.requirementType, referenceCode: q.referenceCode })),
  };
}

export function fieldDtos(s: GigTemplateStructure): GigFieldDto[] {
  return sortedFields(s).map((f) => {
    const supported = isGigFieldTypeSupported(f.fieldType);
    return {
      fieldKey: f.fieldKey,
      fieldType: f.fieldType as GigFieldDto['fieldType'],
      section: f.section as GigFieldDto['section'],
      behavior: f.behavior,
      displayOrder: f.displayOrder,
      customerVisible: f.customerVisible,
      supported,
      required: supported && f.behavior === 'PROVIDER_REQUIRED',
      fixed: f.behavior === 'PLATFORM_FIXED',
      labelContentKey: f.labelContentKey,
      helpContentKey: f.helpContentKey,
      defaultContentKey: f.defaultContentKey,
      defaultNumber: f.defaultNumber,
      defaultBoolean: f.defaultBoolean,
      defaultOption: f.defaultOption,
      minLength: f.minLength,
      maxLength: f.maxLength,
      minNumber: f.minNumber,
      maxNumber: f.maxNumber,
      minItems: f.minItems,
      maxItems: f.maxItems,
      options: [...f.options]
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((o) => ({
          optionCode: o.optionCode,
          displayOrder: o.displayOrder,
          isDefault: o.isDefault,
          ...(o.labelContentKey === undefined ? {} : { labelContentKey: o.labelContentKey }),
        })),
    };
  });
}

/** The three policies a Gig view needs: the Gig content, the variants and add-ons, the photos (each fails closed on its own). */
export interface GigPolicies {
  gig: ProviderGigPolicy;
  options: ProviderGigOptionsPolicy;
  media: ProviderGigMediaPolicy;
}
/** The children of one version as loaded from the database. */
export interface VersionChildren {
  variants: readonly GigOptionDto[];
  addOns: readonly GigOptionDto[];
  media: readonly GigMediaRow[];
}
export const NO_CHILDREN: VersionChildren = { variants: [], addOns: [], media: [] };

/** A template version offers photos when it has a MEDIA field that does not prohibit them and the platform allows photos at all. */
const mediaPermitted = (s: GigTemplateStructure, media: ProviderGigMediaPolicy): boolean =>
  media.maxItems > 0 && s.fields.some((f) => f.fieldType === 'MEDIA' && f.maxItems !== 0);

export function constraintsDto(s: GigTemplateStructure, policies: GigPolicies, currency: string | null): GigConstraintsDto {
  const price = priceAllowed(s);
  const duration = durationAllowed(s);
  const { gig: policy, options, media } = policies;
  return {
    title: { maxLength: policy.titleMaxLength },
    shortPitch: { maxLength: policy.shortPitchMaxLength },
    description: { maxLength: policy.descriptionMaxLength },
    price: { permitted: price, required: price, currency: price ? currency : null },
    duration: {
      permitted: duration,
      required: duration,
      minMinutes: s.duration.minMinutes,
      maxMinutes: s.duration.maxMinutes,
      suggestedMinutes: s.duration.suggestedMinutes,
    },
    variants: {
      permitted: optionsPermitted('variants', s),
      maxCount: options.variantMaxCount,
      nameMaxLength: options.nameMaxLength,
      descriptionMaxLength: options.descriptionMaxLength,
    },
    addOns: {
      permitted: optionsPermitted('addOns', s),
      maxCount: options.addOnMaxCount,
      nameMaxLength: options.nameMaxLength,
      descriptionMaxLength: options.descriptionMaxLength,
    },
    media: {
      permitted: mediaPermitted(s, media),
      maxItems: media.maxItems,
      maxFileSizeBytes: media.maxFileSizeBytes,
      allowedMimeTypes: [...media.allowedMimeTypes],
      minEdgePixels: media.minEdgePixels,
      maxEdgePixels: media.maxEdgePixels,
      altTextMaxLength: media.altTextMaxLength,
    },
  };
}

/** Everything that stands between a draft and PUBLISHED: the Gig's own content, the variants and add-ons, and the photos. Identifiers only. */
export function publishIssues(
  content: GigContent,
  structure: GigTemplateStructure,
  policies: GigPolicies,
  currency: string | null,
  children: VersionChildren,
): GigIssueDto[] {
  return [
    ...completenessIssues(content, structure, policies.gig, currency),
    ...optionsIssues(children.variants, children.addOns, structure, policies.options, policies.gig),
    ...mediaIssues(children.media, structure, policies.media),
  ];
}

/** Structural facts about the children of a version (counts and the validity of each part). */
export function childSummary(structure: GigTemplateStructure, policies: GigPolicies, children: VersionChildren): GigChildSummaryDto {
  const option = optionsIssues(children.variants, children.addOns, structure, policies.options, policies.gig);
  const media = mediaSummary(children.media, structure, policies.media);
  return {
    variantCount: children.variants.length,
    addOnCount: children.addOns.length,
    mediaCount: media.mediaCount,
    variantsValid: !option.some((i) => i.target === 'variants'),
    addOnsValid: !option.some((i) => i.target === 'addOns'),
    mediaRequirementSatisfied: media.mediaRequirementSatisfied,
  };
}

/** The same facts for the GigMenu, from SQL aggregates of the options (counts and the longest texts) instead of the rows. */
export function menuChildSummary(
  structure: GigTemplateStructure,
  policies: GigPolicies,
  stats: OptionStats | undefined,
  media: readonly GigMediaRow[],
): GigChildSummaryDto {
  const none = { count: 0, maxNameLength: 0, maxDescriptionLength: 0 };
  const variants = stats?.variants ?? none;
  const addOns = stats?.addOns ?? none;
  const m = mediaSummary(media, structure, policies.media);
  return {
    variantCount: variants.count,
    addOnCount: addOns.count,
    mediaCount: m.mediaCount,
    variantsValid: optionKindValid('variants', variants, structure, policies.options),
    addOnsValid: optionKindValid('addOns', addOns, structure, policies.options),
    mediaRequirementSatisfied: m.mediaRequirementSatisfied,
  };
}

/**
 * A structure carrying ONLY what the options and media rules read (the permissions and the MEDIA fields), for the GigMenu, which must not call the template port (one batch read
 * of the bound versions instead). Never given to anything that reads other template facts.
 */
export function partialStructure(r: {
  fixedWithVariants: boolean;
  addOnsAllowed: boolean;
  mediaFields: readonly {
    gigTemplateFieldId: string;
    fieldKey: string;
    behavior: GigTemplateFieldFacts['behavior'];
    minItems: number | null;
    maxItems: number | null;
  }[];
}): GigTemplateStructure {
  return {
    gigTemplateId: '',
    gigTemplateCode: '',
    templateStatus: 'ACTIVE',
    serviceTypeCode: '',
    serviceTypeStatus: 'ACTIVE',
    categoryCode: '',
    nameContentKey: '',
    descriptionContentKey: null,
    instructionsContentKey: null,
    gigTemplateVersionId: '',
    versionNumber: 0,
    versionStatus: 'ACTIVE',
    duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null },
    pricing: { fixed: true, fixedWithVariants: r.fixedWithVariants },
    addOnsAllowed: r.addOnsAllowed,
    fields: r.mediaFields.map((f, i) => ({
      gigTemplateFieldId: f.gigTemplateFieldId,
      fieldKey: f.fieldKey,
      fieldType: 'MEDIA',
      section: 'DETAILS',
      behavior: f.behavior,
      customerVisible: true,
      displayOrder: i + 1,
      labelContentKey: '',
      helpContentKey: null,
      defaultContentKey: null,
      defaultNumber: null,
      defaultBoolean: null,
      defaultOption: null,
      minLength: null,
      maxLength: null,
      minNumber: null,
      maxNumber: null,
      minItems: f.minItems,
      maxItems: f.maxItems,
      options: [],
    })),
    requirements: [],
  };
}

export function versionDto(
  v: VersionRow,
  structure: GigTemplateStructure,
  values: ReadonlyMap<string, FieldValue>,
  policies: GigPolicies,
  currency: string | null,
  children: VersionChildren = NO_CHILDREN,
): GigVersionDto {
  const fieldValues: GigFieldValueDto[] = sortedFields(structure)
    .filter((f) => values.has(f.fieldKey))
    .map((f) => ({ fieldKey: f.fieldKey, value: values.get(f.fieldKey)! }));
  const issues = v.status === 'DRAFT' ? publishIssues(contentOf(v, values), structure, policies, currency, children) : [];
  return {
    ...summaryDto(v),
    shortPitch: v.shortPitch,
    description: v.description,
    price: v.priceAmountMinor === null || v.priceCurrency === null ? null : { amountMinor: v.priceAmountMinor, currency: v.priceCurrency },
    durationMinutes: v.durationMinutes,
    fieldValues,
    template: linkDto(structure),
    fields: fieldDtos(structure),
    constraints: constraintsDto(structure, policies, currency),
    variants: [...children.variants],
    addOns: [...children.addOns],
    media: toMediaDtos(children.media),
    children: childSummary(structure, policies, children),
    publishable: v.status === 'DRAFT' ? issues.length === 0 : null,
    issues,
  };
}
