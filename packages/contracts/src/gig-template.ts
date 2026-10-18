// Public contracts of the Gig Templates (CAT-002, docs/engineering/GIG_TEMPLATES.md): the PLATFORM-OWNED, versioned structure a provider later builds a Gig from. A template belongs to
// exactly one service type; its versions freeze the structure (fields, bounds, allowed pricing and area models, requirement hooks); names, labels and help are managed content (CFG-002).
// Nothing here is provider data: no price, no floor price, no chosen duration, no radius or area, no pitch, no photo, no capacity.
import { z } from 'zod';
import { CatalogCode, CatalogReadQuery, CatalogStatus, DisplayOrder, SetMarketAvailabilityRequest } from './catalog';
import { envelope } from './envelope';
import { adminText } from './text';

// ---------------------------------------------------------------- vocabulary
export const FIELD_KEY_MIN = 2;
export const FIELD_KEY_MAX = 32;
/** A field key or an option code: lower-case snake_case, 2..32 characters (the derived content keys stay below the 160 character limit of the registry). */
export const FieldKey = z
  .string()
  .min(FIELD_KEY_MIN)
  .max(FIELD_KEY_MAX)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
export const OptionCode = FieldKey;
export const GigTemplateCode = CatalogCode;

export const GIG_TEMPLATE_FIELD_TYPES = [
  'TEXT',
  'LONG_TEXT',
  'INTEGER',
  'DECIMAL',
  'BOOLEAN',
  'ENUM',
  'DURATION',
  'MONEY',
  'MEDIA',
  'EQUIPMENT_REFERENCE',
  'SKILL_REFERENCE',
] as const;
export const GigTemplateFieldType = z.enum(GIG_TEMPLATE_FIELD_TYPES);
export type GigTemplateFieldType = z.infer<typeof GigTemplateFieldType>;

/** PLATFORM_FIXED: the value is the template's (a Gig cannot change it); PROVIDER_CONFIGURABLE: optional, the provider may set it; PROVIDER_REQUIRED: the provider must provide it. */
export const GIG_TEMPLATE_FIELD_BEHAVIORS = ['PLATFORM_FIXED', 'PROVIDER_CONFIGURABLE', 'PROVIDER_REQUIRED'] as const;
export const GigTemplateFieldBehavior = z.enum(GIG_TEMPLATE_FIELD_BEHAVIORS);
export type GigTemplateFieldBehavior = z.infer<typeof GigTemplateFieldBehavior>;

export const GIG_TEMPLATE_SECTIONS = ['SCOPE', 'INCLUSIONS', 'EXCLUSIONS', 'PREPARATION', 'DETAILS'] as const;
export const GigTemplateSection = z.enum(GIG_TEMPLATE_SECTIONS);
export type GigTemplateSection = z.infer<typeof GigTemplateSection>;

/** Types that can carry a platform-fixed value (they have a default); the others (money, media, references) are always the provider's. */
export const FIXED_CAPABLE_FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION'] as const;

export const GIG_TEMPLATE_REQUIREMENT_TYPES = ['SKILL', 'EQUIPMENT', 'LICENSE', 'INSURANCE', 'BACKGROUND_CHECK'] as const;
export const GigTemplateRequirementType = z.enum(GIG_TEMPLATE_REQUIREMENT_TYPES);
export type GigTemplateRequirementType = z.infer<typeof GigTemplateRequirementType>;

/** `ADD_ONS` (CAT-004) is a permission, not a base price: it lets a Gig built on the version carry add-ons; a base model (FIXED or FIXED_WITH_VARIANTS) is still required. */
export const PRICING_MODELS = ['FIXED', 'FIXED_WITH_VARIANTS', 'BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE', 'ADD_ONS'] as const;
export const PricingModel = z.enum(PRICING_MODELS);
export type PricingModel = z.infer<typeof PricingModel>;
export const AREA_MODES = ['RADIUS', 'POSTAL_CODES', 'POLYGON'] as const;
export const AreaMode = z.enum(AREA_MODES);
export type AreaMode = z.infer<typeof AreaMode>;

/** DRAFT (editable), ACTIVE (published, frozen, at most one per template), SUPERSEDED (replaced by a newer published version, automatic), RETIRED (discarded draft or withdrawn version). */
export const GIG_TEMPLATE_VERSION_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED'] as const;
export const GigTemplateVersionStatus = z.enum(GIG_TEMPLATE_VERSION_STATUSES);
export type GigTemplateVersionStatus = z.infer<typeof GigTemplateVersionStatus>;
export const isGigTemplateVersionTransitionAllowed = (from: GigTemplateVersionStatus, to: GigTemplateVersionStatus): boolean =>
  (from === 'DRAFT' && (to === 'ACTIVE' || to === 'RETIRED')) || (from === 'ACTIVE' && (to === 'SUPERSEDED' || to === 'RETIRED'));

/** The only target a management request can ask for on a version: discarding a DRAFT (a publication has its own operation; SUPERSEDED is automatic; a published version is closed by pausing or retiring its template). */
export const GigTemplateVersionRetireRequest = z.object({ status: z.literal('RETIRED'), reason: adminText(1000) }).strict();
export type GigTemplateVersionRetireRequest = z.infer<typeof GigTemplateVersionRetireRequest>;

// ---------------------------------------------------------------- managed content keys (CFG-002), DERIVED, shared by all versions of a template
const P = 'catalog.gig_template';
export const gigTemplateNameKey = (code: string): string => `${P}.${code}.name`;
export const gigTemplateDescriptionKey = (code: string): string => `${P}.${code}.description`;
export const gigTemplateInstructionsKey = (code: string): string => `${P}.${code}.instructions`;
export const gigTemplateFieldLabelKey = (code: string, fieldKey: string): string => `${P}.${code}.field.${fieldKey}.label`;
export const gigTemplateFieldHelpKey = (code: string, fieldKey: string): string => `${P}.${code}.field.${fieldKey}.help`;
export const gigTemplateFieldDefaultKey = (code: string, fieldKey: string): string => `${P}.${code}.field.${fieldKey}.default`;
export const gigTemplateOptionLabelKey = (code: string, fieldKey: string, optionCode: string): string =>
  `${P}.${code}.field.${fieldKey}.option.${optionCode}.label`;

// ---------------------------------------------------------------- field definition (request)
// 1e9 keeps every accepted value exactly representable once scaled by 1e4 (1e13 < 2^53) and well inside numeric(18,4)
const NUMBER_ABS_MAX = 1_000_000_000;
/** At most 4 decimal places, tolerating the float error of the scaling itself (about 2 ulp of the scaled value), so 12345678.1234 is accepted and 5e-11 is not. */
const hasAtMost4Decimals = (v: number): boolean => {
  const scaled = Math.abs(v * 10_000);
  return Math.abs(scaled - Math.round(scaled)) <= 1e-9 + scaled * 4.5e-16;
};
const metaNumber = z.number().finite().min(-NUMBER_ABS_MAX).max(NUMBER_ABS_MAX).refine(hasAtMost4Decimals, { message: 'at most 4 decimal places' });
const count = z.number().int().min(0).max(1000);
const length = z.number().int().min(1).max(100_000);

export const GigTemplateOptionInput = z.object({ optionCode: OptionCode, isDefault: z.boolean().default(false) }).strict();
export type GigTemplateOptionInput = z.infer<typeof GigTemplateOptionInput>;

const FieldShape = z
  .object({
    fieldKey: FieldKey,
    fieldType: GigTemplateFieldType,
    section: GigTemplateSection.default('DETAILS'),
    behavior: GigTemplateFieldBehavior,
    /** Whether the value is shown to customers on the Gig (false = builder-only input). */
    customerVisible: z.boolean().default(true),
    /** Links the optional help text entry `...field.<key>.help`. */
    withHelp: z.boolean().default(false),
    /** TEXT, LONG_TEXT: links the platform-written default text entry `...field.<key>.default` (required for PLATFORM_FIXED). */
    withDefaultText: z.boolean().default(false),
    minLength: length.optional(),
    maxLength: length.optional(),
    minNumber: metaNumber.optional(),
    maxNumber: metaNumber.optional(),
    defaultNumber: metaNumber.optional(),
    defaultBoolean: z.boolean().optional(),
    /** MEDIA: the count of photos (maxItems 0 = no photos allowed); EQUIPMENT_REFERENCE and SKILL_REFERENCE: the count of selections. */
    minItems: count.optional(),
    maxItems: count.optional(),
    options: z.array(GigTemplateOptionInput).max(30).default([]),
  })
  .strict();

type FieldIn = z.infer<typeof FieldShape>;
const present = (...v: unknown[]): boolean => v.some((x) => x !== undefined);

/**
 * The per-type rules, mirrored by the database CHECK matrix: a metadata column that does not belong to the type must be absent, a fixed field needs a default, bounds are ordered and
 * a default lies within them. Returns the offending property names (empty when valid) so the schema can attach each issue to its path.
 */
export function fieldIssues(f: FieldIn): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  const t = f.fieldType;
  const isText = t === 'TEXT' || t === 'LONG_TEXT';
  const isNumeric = t === 'INTEGER' || t === 'DECIMAL' || t === 'DURATION';
  const isItems = t === 'MEDIA' || t === 'EQUIPMENT_REFERENCE' || t === 'SKILL_REFERENCE';
  if (!isText && present(f.minLength, f.maxLength)) bad('minLength', 'length bounds apply to TEXT and LONG_TEXT only');
  if (!isText && f.withDefaultText) bad('withDefaultText', 'a default text applies to TEXT and LONG_TEXT only');
  if (!isNumeric && present(f.minNumber, f.maxNumber, f.defaultNumber)) bad('minNumber', 'numeric bounds apply to INTEGER, DECIMAL and DURATION only');
  if (t !== 'BOOLEAN' && f.defaultBoolean !== undefined) bad('defaultBoolean', 'a boolean default applies to BOOLEAN only');
  if (!isItems && present(f.minItems, f.maxItems)) bad('minItems', 'item counts apply to MEDIA, EQUIPMENT_REFERENCE and SKILL_REFERENCE only');
  if (t !== 'ENUM' && f.options.length > 0) bad('options', 'options apply to ENUM only');
  if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) bad('maxLength', 'maxLength must not be below minLength');
  if (isNumeric) {
    const integral = t === 'INTEGER' || t === 'DURATION';
    for (const [name, v] of [
      ['minNumber', f.minNumber],
      ['maxNumber', f.maxNumber],
      ['defaultNumber', f.defaultNumber],
    ] as const) {
      if (v === undefined) continue;
      if (integral && !Number.isInteger(v)) bad(name, `${t} values are whole numbers`);
      if (t === 'DURATION' && v < 1) bad(name, 'a duration is at least 1 minute');
    }
    if (f.minNumber !== undefined && f.maxNumber !== undefined && f.minNumber > f.maxNumber) bad('maxNumber', 'maxNumber must not be below minNumber');
    if (f.defaultNumber !== undefined && f.minNumber !== undefined && f.defaultNumber < f.minNumber) bad('defaultNumber', 'the default is below minNumber');
    if (f.defaultNumber !== undefined && f.maxNumber !== undefined && f.defaultNumber > f.maxNumber) bad('defaultNumber', 'the default is above maxNumber');
  }
  if (isItems) {
    if (f.minItems !== undefined && f.maxItems !== undefined && f.minItems > f.maxItems) bad('maxItems', 'maxItems must not be below minItems');
    if (t !== 'MEDIA' && f.maxItems === 0) bad('maxItems', 'a reference field allows at least one selection');
  }
  if (t === 'ENUM') {
    const codes = f.options.map((o) => o.optionCode);
    if (new Set(codes).size !== codes.length) bad('options', 'option codes must be unique');
    if (f.options.filter((o) => o.isDefault).length > 1) bad('options', 'at most one option is the default');
  }
  if (f.behavior === 'PLATFORM_FIXED') {
    if (!(FIXED_CAPABLE_FIELD_TYPES as readonly string[]).includes(t)) bad('behavior', `a ${t} field is always the provider's: PLATFORM_FIXED is not allowed`);
    else {
      const hasDefault =
        (isText && f.withDefaultText) ||
        (isNumeric && f.defaultNumber !== undefined) ||
        (t === 'BOOLEAN' && f.defaultBoolean !== undefined) ||
        (t === 'ENUM' && f.options.some((o) => o.isDefault));
      if (!hasDefault) bad('behavior', 'a PLATFORM_FIXED field needs its default value');
    }
  }
  if (t === 'MEDIA' && f.behavior === 'PROVIDER_REQUIRED' && (f.maxItems === 0 || (f.minItems ?? 0) < 1))
    bad('minItems', 'required media needs minItems of at least 1 (and maxItems above 0)');
  return out;
}

export const GigTemplateFieldInput = FieldShape.superRefine((f, ctx) => {
  for (const i of fieldIssues(f)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
});
export type GigTemplateFieldInput = z.infer<typeof GigTemplateFieldInput>;

export const GigTemplateRequirementInput = z.object({ requirementType: GigTemplateRequirementType, referenceCode: CatalogCode.optional() }).strict();
export type GigTemplateRequirementInput = z.infer<typeof GigTemplateRequirementInput>;

export const GigTemplateDurationInput = z
  .object({
    minMinutes: z.number().int().min(1).max(1_000_000).optional(),
    maxMinutes: z.number().int().min(1).max(1_000_000).optional(),
    suggestedMinutes: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.minMinutes !== undefined && d.maxMinutes !== undefined && d.minMinutes > d.maxMinutes)
      ctx.addIssue({ code: 'custom', path: ['maxMinutes'], message: 'maxMinutes must not be below minMinutes' });
    if (d.suggestedMinutes !== undefined && d.minMinutes !== undefined && d.suggestedMinutes < d.minMinutes)
      ctx.addIssue({ code: 'custom', path: ['suggestedMinutes'], message: 'the suggestion is below minMinutes' });
    if (d.suggestedMinutes !== undefined && d.maxMinutes !== undefined && d.suggestedMinutes > d.maxMinutes)
      ctx.addIssue({ code: 'custom', path: ['suggestedMinutes'], message: 'the suggestion is above maxMinutes' });
  });
export type GigTemplateDurationInput = z.infer<typeof GigTemplateDurationInput>;

const reason = adminText(1000);
export const GIG_TEMPLATE_MAX_FIELDS = 60;
export const GIG_TEMPLATE_MAX_REQUIREMENTS = 30;
/** All enum options of ONE version together (a request replaces the whole draft in one transaction and the public detail resolves every label). */
export const GIG_TEMPLATE_MAX_OPTIONS = 200;

// ---------------------------------------------------------------- requests (management; every change carries a reason)
export const CreateGigTemplateRequest = z
  .object({ code: GigTemplateCode, serviceTypeCode: CatalogCode, withDescription: z.boolean().optional(), withInstructions: z.boolean().optional(), reason })
  .strict();
export type CreateGigTemplateRequest = z.infer<typeof CreateGigTemplateRequest>;
export const UpdateGigTemplateRequest = z
  .object({ withDescription: z.boolean().optional(), withInstructions: z.boolean().optional(), reason })
  .strict()
  .refine((v) => v.withDescription !== undefined || v.withInstructions !== undefined, {
    message: 'at least one of withDescription and withInstructions is required',
  });
export type UpdateGigTemplateRequest = z.infer<typeof UpdateGigTemplateRequest>;

/** Creates the next DRAFT (version number = highest + 1). `copyFromVersion` starts the draft from the structure of that version; without it the draft is empty (defaults only). */
export const CreateGigTemplateVersionRequest = z.object({ copyFromVersion: z.number().int().min(1).max(2_147_483_647).optional(), reason }).strict();
export type CreateGigTemplateVersionRequest = z.infer<typeof CreateGigTemplateVersionRequest>;

/** Replaces the WHOLE definition of the DRAFT in one atomic change. `expectedRevision` is the revision the administrator last read (a stale draft is a 409). */
export const ReplaceGigTemplateDraftRequest = z
  .object({
    expectedRevision: z.number().int().min(1),
    duration: GigTemplateDurationInput.optional(),
    pricingModels: z.array(PricingModel).min(1).max(PRICING_MODELS.length),
    areaModes: z.array(AreaMode).min(1).max(AREA_MODES.length),
    fields: z.array(GigTemplateFieldInput).max(GIG_TEMPLATE_MAX_FIELDS),
    requirements: z.array(GigTemplateRequirementInput).max(GIG_TEMPLATE_MAX_REQUIREMENTS).default([]),
    reason,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.pricingModels).size !== r.pricingModels.length)
      ctx.addIssue({ code: 'custom', path: ['pricingModels'], message: 'pricing models must be unique' });
    if (!r.pricingModels.includes('FIXED') && !r.pricingModels.includes('FIXED_WITH_VARIANTS'))
      ctx.addIssue({ code: 'custom', path: ['pricingModels'], message: 'FIXED or FIXED_WITH_VARIANTS is required (a Gig always has a base price)' });
    if (new Set(r.areaModes).size !== r.areaModes.length) ctx.addIssue({ code: 'custom', path: ['areaModes'], message: 'area modes must be unique' });
    if (r.fields.reduce((n, f) => n + f.options.length, 0) > GIG_TEMPLATE_MAX_OPTIONS)
      ctx.addIssue({ code: 'custom', path: ['fields'], message: `a version has at most ${GIG_TEMPLATE_MAX_OPTIONS} options in total` });
    const keys = r.fields.map((f) => f.fieldKey);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'field keys must be unique' });
    const reqs = r.requirements.map((q) => `${q.requirementType}:${q.referenceCode ?? ''}`);
    if (new Set(reqs).size !== reqs.length) ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'requirements must be unique' });
  });
export type ReplaceGigTemplateDraftRequest = z.infer<typeof ReplaceGigTemplateDraftRequest>;

export const PublishGigTemplateVersionRequest = z.object({ expectedRevision: z.number().int().min(1), reason }).strict();
export type PublishGigTemplateVersionRequest = z.infer<typeof PublishGigTemplateVersionRequest>;
export { SetMarketAvailabilityRequest as SetMarketGigTemplateAvailabilityRequest };

// ---------------------------------------------------------------- queries
/** The list query: the catalogue read query (`market` required for the public view, `locale`) plus an optional service type. */
export const GigTemplateListQuery = CatalogReadQuery.extend({ serviceType: CatalogCode.optional() }).strict();
/** A version number in a path: 1, 2, 3 (contiguous per template). */
export const GigTemplateVersionNumber = z.number().int().min(1).max(2_147_483_647);

// ---------------------------------------------------------------- read models
export const GigTemplateOptionDto = z.object({
  optionCode: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  displayOrder: z.number().int(),
  labelContentKey: z.string().optional(),
});
export type GigTemplateOptionDto = z.infer<typeof GigTemplateOptionDto>;

export const GigTemplateFieldDto = z.object({
  fieldKey: z.string(),
  fieldType: GigTemplateFieldType,
  section: GigTemplateSection,
  behavior: GigTemplateFieldBehavior,
  customerVisible: z.boolean(),
  displayOrder: z.number().int(),
  label: z.string(),
  help: z.string().nullable(),
  /** The platform-written value of a TEXT or LONG_TEXT field (the default, or the fixed value). */
  defaultText: z.string().nullable(),
  minLength: z.number().int().nullable(),
  maxLength: z.number().int().nullable(),
  minNumber: z.number().nullable(),
  maxNumber: z.number().nullable(),
  defaultNumber: z.number().nullable(),
  defaultBoolean: z.boolean().nullable(),
  minItems: z.number().int().nullable(),
  maxItems: z.number().int().nullable(),
  /** MEDIA only: derived from the behaviour and maxItems (PROHIBITED = no photos allowed, REQUIRED = at least one, else OPTIONAL). */
  mediaRule: z.enum(['OPTIONAL', 'REQUIRED', 'PROHIBITED']).nullable(),
  options: z.array(GigTemplateOptionDto),
  /** Management only. */
  labelContentKey: z.string().optional(),
  helpContentKey: z.string().nullable().optional(),
  defaultContentKey: z.string().nullable().optional(),
});
export type GigTemplateFieldDto = z.infer<typeof GigTemplateFieldDto>;

export const GigTemplateRequirementDto = z.object({ requirementType: GigTemplateRequirementType, referenceCode: z.string().nullable() });
export type GigTemplateRequirementDto = z.infer<typeof GigTemplateRequirementDto>;

export const GigTemplateDurationDto = z.object({
  minMinutes: z.number().int().nullable(),
  maxMinutes: z.number().int().nullable(),
  suggestedMinutes: z.number().int().nullable(),
});
export type GigTemplateDurationDto = z.infer<typeof GigTemplateDurationDto>;

/** The summary of a version (lists). */
export const GigTemplateVersionSummaryDto = z.object({
  gigTemplateVersionId: z.string(),
  versionNumber: z.number().int(),
  duration: GigTemplateDurationDto,
  pricingModels: z.array(PricingModel),
  areaModes: z.array(AreaMode),
  fieldCount: z.number().int(),
  /** Management only. */
  status: GigTemplateVersionStatus.optional(),
  revision: z.number().int().optional(),
  publishedAt: z.string().nullable().optional(),
  closedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});
export type GigTemplateVersionSummaryDto = z.infer<typeof GigTemplateVersionSummaryDto>;

/** The full frozen structure of a version. */
export const GigTemplateVersionDto = GigTemplateVersionSummaryDto.extend({
  fields: z.array(GigTemplateFieldDto),
  requirements: z.array(GigTemplateRequirementDto),
});
export type GigTemplateVersionDto = z.infer<typeof GigTemplateVersionDto>;
export const GigTemplateVersionResponse = envelope(GigTemplateVersionDto);

const TemplateBase = {
  gigTemplateId: z.string(),
  code: z.string(),
  serviceTypeCode: z.string(),
  categoryCode: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The platform guidance on how a provider fills the template (detail reads only). */
  instructions: z.string().nullable().optional(),
  displayOrder: z.number().int().nullable(),
  /** Management only. */
  status: CatalogStatus.optional(),
  enabled: z.boolean().optional(),
  nameContentKey: z.string().optional(),
  descriptionContentKey: z.string().nullable().optional(),
  instructionsContentKey: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};
export const GigTemplateListItemDto = z.object({ ...TemplateBase, activeVersion: GigTemplateVersionSummaryDto.nullable() });
export type GigTemplateListItemDto = z.infer<typeof GigTemplateListItemDto>;
export const GigTemplateDetailDto = z.object({
  ...TemplateBase,
  activeVersion: GigTemplateVersionDto.nullable(),
  /** Management only: every version, newest first. */
  versions: z.array(GigTemplateVersionSummaryDto).optional(),
});
export type GigTemplateDetailDto = z.infer<typeof GigTemplateDetailDto>;
export const GigTemplateListResponse = envelope(z.array(GigTemplateListItemDto));
export const GigTemplateResponse = envelope(GigTemplateDetailDto);

export const GigTemplateMarketAvailabilityDto = z.object({ marketCode: z.string(), code: z.string(), enabled: z.boolean(), displayOrder: DisplayOrder });
export type GigTemplateMarketAvailabilityDto = z.infer<typeof GigTemplateMarketAvailabilityDto>;
export const GigTemplateMarketAvailabilityResponse = envelope(GigTemplateMarketAvailabilityDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers only)
export const GIG_TEMPLATE_EVENTS = {
  activated: 'bananagig.catalog.gig-template-activated.v1',
  deactivated: 'bananagig.catalog.gig-template-deactivated.v1',
  retired: 'bananagig.catalog.gig-template-retired.v1',
  published: 'bananagig.catalog.gig-template-published.v1',
  availabilityChanged: 'bananagig.catalog.gig-template-availability-changed.v1',
} as const;
export const GigTemplateEventPayload = z.object({ gigTemplateCode: CatalogCode, serviceTypeCode: CatalogCode });
export type GigTemplateEventPayload = z.infer<typeof GigTemplateEventPayload>;
export const GigTemplatePublishedPayload = GigTemplateEventPayload.extend({ versionNumber: z.number().int().min(1), gigTemplateVersionId: z.string() });
export type GigTemplatePublishedPayload = z.infer<typeof GigTemplatePublishedPayload>;
export const GigTemplateAvailabilityEventPayload = z.object({ marketCode: z.string(), gigTemplateCode: CatalogCode, enabled: z.boolean() });
export type GigTemplateAvailabilityEventPayload = z.infer<typeof GigTemplateAvailabilityEventPayload>;
