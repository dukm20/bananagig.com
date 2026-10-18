// Service-level views of the Gig Templates (CAT-002): structure, codes and CONTENT KEYS, never display text (the API resolves the text through the content registry). Management-only fields
// (status, revision, timestamps, availability) are present only in the management view. The same schemas validate what the cache returns, so a poisoned entry is a miss.
import {
  AREA_MODES,
  PRICING_MODELS,
  GigTemplateFieldBehavior,
  GigTemplateFieldType,
  GigTemplateRequirementType,
  GigTemplateSection,
  GigTemplateVersionStatus,
  CatalogStatus,
  type AreaMode,
  type PricingModel,
} from '@bananagig/contracts';
import { z } from 'zod';
import { iso } from './service';

type Row = Record<string, unknown>;

export const FieldOptionViewSchema = z.object({
  optionCode: z.string(),
  labelContentKey: z.string(),
  isDefault: z.boolean(),
  displayOrder: z.number().int(),
});
export type GigTemplateFieldOptionView = z.infer<typeof FieldOptionViewSchema>;

export const FieldViewSchema = z.object({
  fieldKey: z.string(),
  fieldType: GigTemplateFieldType,
  section: GigTemplateSection,
  behavior: GigTemplateFieldBehavior,
  customerVisible: z.boolean(),
  displayOrder: z.number().int(),
  labelContentKey: z.string(),
  helpContentKey: z.string().nullable(),
  defaultContentKey: z.string().nullable(),
  minLength: z.number().int().nullable(),
  maxLength: z.number().int().nullable(),
  minNumber: z.number().nullable(),
  maxNumber: z.number().nullable(),
  defaultNumber: z.number().nullable(),
  defaultBoolean: z.boolean().nullable(),
  minItems: z.number().int().nullable(),
  maxItems: z.number().int().nullable(),
  options: z.array(FieldOptionViewSchema),
});
export type GigTemplateFieldView = z.infer<typeof FieldViewSchema>;

export const RequirementViewSchema = z.object({ requirementType: GigTemplateRequirementType, referenceCode: z.string().nullable() });
export type GigTemplateRequirementView = z.infer<typeof RequirementViewSchema>;

export const VersionSummaryViewSchema = z.object({
  gigTemplateVersionId: z.string(),
  versionNumber: z.number().int(),
  duration: z.object({ minMinutes: z.number().int().nullable(), maxMinutes: z.number().int().nullable(), suggestedMinutes: z.number().int().nullable() }),
  pricingModels: z.array(z.enum(PRICING_MODELS)),
  areaModes: z.array(z.enum(AREA_MODES)),
  fieldCount: z.number().int(),
  /** Management only. */
  status: GigTemplateVersionStatus.optional(),
  revision: z.number().int().optional(),
  publishedAt: z.string().nullable().optional(),
  closedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});
export type GigTemplateVersionSummaryView = z.infer<typeof VersionSummaryViewSchema>;

export const VersionViewSchema = VersionSummaryViewSchema.extend({ fields: z.array(FieldViewSchema), requirements: z.array(RequirementViewSchema) });
export type GigTemplateVersionView = z.infer<typeof VersionViewSchema>;

export const GigTemplateViewSchema = z.object({
  gigTemplateId: z.string(),
  code: z.string(),
  serviceTypeCode: z.string(),
  categoryCode: z.string(),
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  instructionsContentKey: z.string().nullable(),
  /** Position among the templates of the market; null in the global management view (no market). */
  displayOrder: z.number().int().nullable(),
  /** Management only. */
  status: CatalogStatus.optional(),
  /** Management only, with a market: whether the template is enabled there. */
  enabled: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** The ACTIVE version with its full structure (null when the template has none). */
  activeVersion: VersionViewSchema.nullable(),
  /** Management only (detail): every version, newest first. */
  versions: z.array(VersionSummaryViewSchema).optional(),
});
export type GigTemplateView = z.infer<typeof GigTemplateViewSchema>;

/**
 * ONE exact version with the identity facts it belongs to (CAT-003: a provider Gig binds an exact template version and needs the facts to decide whether it can still be created,
 * edited or published). Management view: every status, never cached. The field identities (`gigTemplateFieldId`) are what a Gig's field values reference; they are NOT part of
 * the public template views.
 */
export interface GigTemplateFieldDetailView extends GigTemplateFieldView {
  gigTemplateFieldId: string;
}
export interface GigTemplateVersionDetailView {
  gigTemplateId: string;
  code: string;
  /** The template identity status (DRAFT, ACTIVE, INACTIVE, RETIRED). */
  templateStatus: CatalogStatusValue;
  serviceTypeCode: string;
  /** The status of the template's service type. */
  serviceTypeStatus: CatalogStatusValue;
  categoryCode: string;
  nameContentKey: string;
  descriptionContentKey: string | null;
  instructionsContentKey: string | null;
  /** The version, with its status (DRAFT, ACTIVE, SUPERSEDED, RETIRED), duration facts and pricing models. */
  version: GigTemplateVersionSummaryView;
  fields: GigTemplateFieldDetailView[];
  requirements: GigTemplateRequirementView[];
}
type CatalogStatusValue = z.infer<typeof CatalogStatus>;

export const GigTemplateSnapshotSchema = z.object({ templates: z.array(GigTemplateViewSchema) });
export type GigTemplateSnapshot = z.infer<typeof GigTemplateSnapshotSchema>;

// ---------------------------------------------------------------- row mappers
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function pricingModelsOf(r: Row): PricingModel[] {
  const out: PricingModel[] = [];
  if (r.pricing_fixed === true) out.push('FIXED');
  if (r.pricing_fixed_with_variants === true) out.push('FIXED_WITH_VARIANTS');
  if (r.pricing_bundle_eligible === true) out.push('BUNDLE_ELIGIBLE');
  if (r.pricing_drop_eligible === true) out.push('DROP_ELIGIBLE');
  if (r.pricing_add_ons === true) out.push('ADD_ONS');
  return out;
}
export function areaModesOf(r: Row): AreaMode[] {
  const out: AreaMode[] = [];
  if (r.area_radius === true) out.push('RADIUS');
  if (r.area_postal_codes === true) out.push('POSTAL_CODES');
  if (r.area_polygon === true) out.push('POLYGON');
  return out;
}

export function versionSummaryView(r: Row, fieldCount: number, management: boolean): GigTemplateVersionSummaryView {
  return {
    gigTemplateVersionId: r.gig_template_version_id as string,
    versionNumber: Number(r.version_number),
    duration: { minMinutes: num(r.min_duration_minutes), maxMinutes: num(r.max_duration_minutes), suggestedMinutes: num(r.suggested_duration_minutes) },
    pricingModels: pricingModelsOf(r),
    areaModes: areaModesOf(r),
    fieldCount,
    ...(management
      ? {
          status: r.status as GigTemplateVersionSummaryView['status'],
          revision: Number(r.revision),
          publishedAt: r.published_at === null || r.published_at === undefined ? null : iso(r.published_at),
          closedAt: r.closed_at === null || r.closed_at === undefined ? null : iso(r.closed_at),
          createdAt: iso(r.created_at),
        }
      : {}),
  };
}

export function fieldView(r: Row, options: GigTemplateFieldOptionView[]): GigTemplateFieldView {
  return {
    fieldKey: r.field_key as string,
    fieldType: r.field_type as GigTemplateFieldView['fieldType'],
    section: r.section as GigTemplateFieldView['section'],
    behavior: r.behavior as GigTemplateFieldView['behavior'],
    customerVisible: r.customer_visible === true,
    displayOrder: Number(r.display_order),
    labelContentKey: r.label_content_key as string,
    helpContentKey: (r.help_content_key as string | null) ?? null,
    defaultContentKey: (r.default_content_key as string | null) ?? null,
    minLength: num(r.min_length),
    maxLength: num(r.max_length),
    minNumber: num(r.min_number),
    maxNumber: num(r.max_number),
    defaultNumber: num(r.default_number),
    defaultBoolean: r.default_boolean === null || r.default_boolean === undefined ? null : r.default_boolean === true,
    minItems: num(r.min_items),
    maxItems: num(r.max_items),
    options,
  };
}
