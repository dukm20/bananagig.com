// Public contracts of the PROVIDER GIG and its versions (CAT-003, docs/engineering/PROVIDER_GIGS.md). A Gig is the provider-owned offer an account builds from a PLATFORM-OWNED Gig Template
// (CAT-002). Three rules shape every type here:
//   1. A Gig is an IDENTITY (provider.gigs) plus immutable VERSIONS (provider.gig_versions). Every version binds the EXACT template version it was built from; the service type is reached
//      through the template, never stored on the Gig, and the market is the provider's (never stored on the Gig).
//   2. A published version never changes: an edit is a NEW draft version; publishing it supersedes the previous one atomically. Nothing is hard-deleted.
//   3. A Gig is NOT live and NOT bookable: Go-Live (PRO-003), variants/add-ons/media (CAT-004), service areas, availability and search are later checkpoints. `goLive` is always
//      `{ evaluated: false, eligible: false }` here.
// The provider-written text (title, short pitch, description, text field values) is PLAIN TEXT: it never reaches an audit row, an event, a log or an error detail.
import { z } from 'zod';
import { CatalogCode } from './catalog';
import { envelope } from './envelope';
import { FieldKey, GigTemplateFieldBehavior, GigTemplateFieldType, GigTemplateSection } from './gig-template';

// ---------------------------------------------------------------- vocabularies
/** DRAFT (identity created, no version published yet) -> ACTIVE (a version is published) -> RETIRED (terminal; history kept; a provider who wants the offer again creates a new Gig). */
export const GIG_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export const GigStatus = z.enum(GIG_STATUSES);
export type GigStatus = z.infer<typeof GigStatus>;
/** DRAFT (editable, at most one per Gig) -> PUBLISHED (frozen, at most one per Gig) -> SUPERSEDED (a newer version was published) ; DRAFT or PUBLISHED -> RETIRED (the Gig was retired). */
export const GIG_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'RETIRED'] as const;
export const GigVersionStatus = z.enum(GIG_VERSION_STATUSES);
export type GigVersionStatus = z.infer<typeof GigVersionStatus>;
export const isGigStatusTransitionAllowed = (from: GigStatus, to: GigStatus): boolean =>
  (from === 'DRAFT' && (to === 'ACTIVE' || to === 'RETIRED')) || (from === 'ACTIVE' && to === 'RETIRED');
export const isGigVersionStatusTransitionAllowed = (from: GigVersionStatus, to: GigVersionStatus): boolean =>
  (from === 'DRAFT' && (to === 'PUBLISHED' || to === 'RETIRED')) || (from === 'PUBLISHED' && (to === 'SUPERSEDED' || to === 'RETIRED'));

/** The field types a provider can fill in CAT-003 (the typed value columns exist). MONEY is the Gig price column; MEDIA, EQUIPMENT_REFERENCE and SKILL_REFERENCE belong to CAT-004 and later. */
export const SUPPORTED_GIG_FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION'] as const;
export const isGigFieldTypeSupported = (t: string): boolean => (SUPPORTED_GIG_FIELD_TYPES as readonly string[]).includes(t);

// ---------------------------------------------------------------- managed content keys (CFG-002; platform UI labels and errors only, never provider text)
export const gigStatusKey = (s: GigStatus): string => `provider.gig.status.${s.toLowerCase()}`;
export const gigVersionStatusKey = (s: GigVersionStatus): string => `provider.gig.version_status.${s.toLowerCase()}`;
export const gigErrorKey = (c: GigErrorCode): string => `provider.gig.error.${c.toLowerCase()}`;
export const gigIssueKey = (reason: GigIssueReason): string => `provider.gig.issue.${reason.toLowerCase()}`;

// ---------------------------------------------------------------- policy (configuration, never code)
export const PROVIDER_GIG_POLICY_KEYS = {
  maxActive: 'provider.gig.max_active',
  maxDrafts: 'provider.gig.max_drafts',
  titleMaxLength: 'provider.gig.title.max_length',
  shortPitchMaxLength: 'provider.gig.short_pitch.max_length',
  descriptionMaxLength: 'provider.gig.description.max_length',
} as const;
/** Structural ceilings of the stored text (the database CHECKs repeat them); the configured limits must not exceed them. */
export const GIG_TITLE_CEILING = 200;
export const GIG_SHORT_PITCH_CEILING = 2000;
export const GIG_DESCRIPTION_CEILING = 20000;
export const GIG_COUNT_CEILING = 500;
/** Structural ceiling of a price in minor units (10^12: far above any local service, far below the precision limit of a JavaScript number). The configurable floor/ceiling policy is DEBT-0092. */
export const GIG_PRICE_MINOR_CEILING = 1_000_000_000_000;
export const ProviderGigPolicy = z
  .object({
    maxActive: z.number().int().min(1).max(GIG_COUNT_CEILING),
    maxDrafts: z.number().int().min(1).max(GIG_COUNT_CEILING),
    titleMaxLength: z.number().int().min(1).max(GIG_TITLE_CEILING),
    shortPitchMaxLength: z.number().int().min(1).max(GIG_SHORT_PITCH_CEILING),
    descriptionMaxLength: z.number().int().min(1).max(GIG_DESCRIPTION_CEILING),
  })
  .strict();
export type ProviderGigPolicy = z.infer<typeof ProviderGigPolicy>;

// ---------------------------------------------------------------- provider text (plain text only)
const FORBIDDEN_SINGLE_LINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// multi-line text may also hold line feeds and tabs (carriage returns are normalised to line feeds first)
const FORBIDDEN_MULTI_LINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Linear on purpose: a tag opener is `<`, optional whitespace or slashes, then a letter, `!` or `?` (no adjacent overlapping quantifiers, so a long whitespace run cannot backtrack).
const HTML_TAG = /<[\s/]*[A-Za-z!?]/;
// Invisible or blank-looking characters (all format characters except the joiners emoji and some scripts need, plus the blank Hangul filler and the blank Braille pattern).
const INVISIBLE = /(?![\u200C\u200D])\p{Cf}|[\u3164\u2800]/u;
// Something a person can see: a letter, number, mark, punctuation or symbol (emoji are symbols).
const VISIBLE = /[\p{L}\p{N}\p{M}\p{P}\p{S}]/u;
export const PROVIDER_TEXT_REASONS = ['FORBIDDEN_CHARACTER', 'HTML_NOT_ALLOWED'] as const;
export type ProviderTextProblem = (typeof PROVIDER_TEXT_REASONS)[number];

/** Length in Unicode code points (what a person counts), not UTF-16 units. */
export const textLength = (s: string): number => Array.from(s).length;

/**
 * Normalises provider text: Unicode NFC, carriage returns to line feeds, outer whitespace trimmed; single-line text also collapses every whitespace run to one space. Returns the
 * normalised text, or the reason it is refused (control or bidirectional-override characters, unpaired surrogates, HTML-looking markup).
 */
export function normalizeProviderText(raw: string, opts: { multiline: boolean }): { ok: true; value: string } | { ok: false; reason: ProviderTextProblem } {
  let v = raw.normalize('NFC').replace(/\r\n?/g, '\n');
  if (opts.multiline ? FORBIDDEN_MULTI_LINE.test(v) : FORBIDDEN_SINGLE_LINE.test(v.replace(/[\n\t]/g, ' ')))
    return { ok: false, reason: 'FORBIDDEN_CHARACTER' };
  if (INVISIBLE.test(v)) return { ok: false, reason: 'FORBIDDEN_CHARACTER' };
  v = opts.multiline ? v.trim() : v.replace(/\s+/g, ' ').trim();
  if (!VISIBLE.test(v)) return { ok: true, value: '' };
  if (HTML_TAG.test(v)) return { ok: false, reason: 'HTML_NOT_ALLOWED' };
  return { ok: true, value: v };
}

// ---------------------------------------------------------------- requests (strict; the account is the caller's, never in a body or a path)
const revision = z.number().int().min(1).max(2_147_483_647);
export const CreateGigRequest = z
  .object({
    /** The Gig Template (CAT-002) to build from. The server binds its ACTIVE version; the client never names a version. */
    gigTemplateCode: CatalogCode,
    /** Optional idempotency token: repeating the same token returns the Gig it created instead of a second one. */
    clientRequestId: z.string().uuid().optional(),
  })
  .strict();
export type CreateGigRequest = z.infer<typeof CreateGigRequest>;
/** Starts the next draft of an ACTIVE Gig from its published version (same template version; no migration). Takes no input. */
export const CreateGigVersionRequest = z.object({}).strict();
export type CreateGigVersionRequest = z.infer<typeof CreateGigVersionRequest>;

/** A provider value of one template field: text, an integer, a decimal as a string (never a float), a boolean or an option code; null clears it. */
export const GigFieldValue = z.union([
  z.string().max(GIG_DESCRIPTION_CEILING),
  z.number().int().min(-9_007_199_254_740_991).max(9_007_199_254_740_991),
  z.boolean(),
  z.null(),
]);
export type GigFieldValue = z.infer<typeof GigFieldValue>;
export const GIG_FIELD_VALUES_MAX = 64;
/**
 * REPLACES the whole editable content of the draft (an omitted field is cleared). A draft may be incomplete; only publishing requires completeness. `expectedRevision` is the revision
 * last read (a different one is 409 STALE_DRAFT). The price currency is NEVER sent: the server derives it from the provider's market.
 */
export const UpdateGigDraftRequest = z
  .object({
    expectedRevision: revision,
    title: z
      .string()
      .max(GIG_TITLE_CEILING * 4)
      .nullable(),
    shortPitch: z
      .string()
      .max(GIG_SHORT_PITCH_CEILING * 4)
      .nullable(),
    description: z
      .string()
      .max(GIG_DESCRIPTION_CEILING * 4)
      .nullable(),
    priceAmountMinor: z.number().int().min(0).max(GIG_PRICE_MINOR_CEILING).nullable(),
    durationMinutes: z.number().int().min(1).max(100_000).nullable(),
    fieldValues: z.array(z.object({ fieldKey: FieldKey, value: GigFieldValue }).strict()).max(GIG_FIELD_VALUES_MAX),
  })
  .strict()
  .refine((r) => new Set(r.fieldValues.map((f) => f.fieldKey)).size === r.fieldValues.length, { message: 'field keys must be unique', path: ['fieldValues'] });
export type UpdateGigDraftRequest = z.infer<typeof UpdateGigDraftRequest>;
export const PublishGigRequest = z.object({ expectedRevision: revision }).strict();
export type PublishGigRequest = z.infer<typeof PublishGigRequest>;
/** Retiring takes no input: free text would end up in the immutable audit trail. */
export const RetireGigRequest = z.object({}).strict();
export type RetireGigRequest = z.infer<typeof RetireGigRequest>;
export const GigIdParams = z.object({ gigId: z.string().uuid() }).strict();
export const GigVersionParams = z.object({ gigId: z.string().uuid(), version: z.string().regex(/^[1-9][0-9]{0,8}$/) }).strict();

// ---------------------------------------------------------------- read models
/** Why a draft cannot be published (or a value is refused). Identifiers only; the message text is managed content (`gigIssueKey`). */
export const GIG_ISSUE_REASONS = [
  'TITLE_REQUIRED',
  'TITLE_TOO_LONG',
  'SHORT_PITCH_REQUIRED',
  'SHORT_PITCH_TOO_LONG',
  'DESCRIPTION_REQUIRED',
  'DESCRIPTION_TOO_LONG',
  'FORBIDDEN_CHARACTER',
  'HTML_NOT_ALLOWED',
  'PRICE_REQUIRED',
  'PRICE_NOT_PERMITTED',
  'PRICE_NOT_POSITIVE',
  'DURATION_REQUIRED',
  'DURATION_NOT_PERMITTED',
  'DURATION_OUT_OF_RANGE',
  'FIELD_REQUIRED',
  'FIELD_UNKNOWN',
  'FIELD_NOT_PROVIDER_EDITABLE',
  'FIELD_TYPE_NOT_SUPPORTED',
  'FIELD_VALUE_INVALID',
  'FIELD_VALUE_OUT_OF_RANGE',
  'FIELD_OPTION_UNKNOWN',
  'FIELD_TOO_SHORT',
  'FIELD_TOO_LONG',
  'TEMPLATE_VERSION_RETIRED',
] as const;
export type GigIssueReason = (typeof GIG_ISSUE_REASONS)[number];
export const GigIssueDto = z.object({
  /** `title`, `shortPitch`, `description`, `price`, `duration` or `field` (with `fieldKey`). */
  target: z.enum(['title', 'shortPitch', 'description', 'price', 'duration', 'field', 'template']),
  fieldKey: z.string().optional(),
  reason: z.enum(GIG_ISSUE_REASONS),
  messageKey: z.string(),
});
export type GigIssueDto = z.infer<typeof GigIssueDto>;

/** The exact template version a Gig version is bound to (the template's facts, never a copy). */
export const GigTemplateLinkDto = z.object({
  gigTemplateCode: z.string(),
  gigTemplateVersionId: z.string(),
  gigTemplateVersionNumber: z.number().int(),
  /** The status of the BOUND version: ACTIVE (current), SUPERSEDED (a newer version exists; the Gig keeps this one) or RETIRED (withdrawn: the Gig cannot publish). */
  versionStatus: z.enum(['ACTIVE', 'SUPERSEDED', 'RETIRED', 'DRAFT']),
  /** The template identity status (ACTIVE, INACTIVE, RETIRED). */
  templateStatus: z.string(),
  serviceTypeCode: z.string(),
  categoryCode: z.string(),
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  instructionsContentKey: z.string().nullable(),
  /** Requirement hooks of the bound version, opaque to this domain (PRO-003 and TRUST decide what they mean). */
  requirements: z.array(z.object({ requirementType: z.string(), referenceCode: z.string().nullable() })),
});
export type GigTemplateLinkDto = z.infer<typeof GigTemplateLinkDto>;

export const GigPriceDto = z.object({ amountMinor: z.number().int(), currency: z.string().length(3) });
export type GigPriceDto = z.infer<typeof GigPriceDto>;

/** The template field as the editor needs it (structure comes from the bound template version; nothing is copied into the Gig). */
export const GigFieldDto = z.object({
  fieldKey: z.string(),
  fieldType: GigTemplateFieldType,
  section: GigTemplateSection,
  behavior: GigTemplateFieldBehavior,
  displayOrder: z.number().int(),
  customerVisible: z.boolean(),
  /** Whether CAT-003 can store a value of this type (false for MONEY, MEDIA, EQUIPMENT_REFERENCE and SKILL_REFERENCE). */
  supported: z.boolean(),
  /** PROVIDER_REQUIRED and supported: publishing needs a value. */
  required: z.boolean(),
  /** PLATFORM_FIXED: the value belongs to the template and is resolved from it; a Gig stores no value for it. */
  fixed: z.boolean(),
  labelContentKey: z.string(),
  helpContentKey: z.string().nullable(),
  defaultContentKey: z.string().nullable(),
  defaultNumber: z.number().nullable(),
  defaultBoolean: z.boolean().nullable(),
  defaultOption: z.string().nullable(),
  minLength: z.number().int().nullable(),
  maxLength: z.number().int().nullable(),
  minNumber: z.number().nullable(),
  maxNumber: z.number().nullable(),
  options: z.array(z.object({ optionCode: z.string(), displayOrder: z.number().int(), isDefault: z.boolean(), labelContentKey: z.string().optional() })),
});
export type GigFieldDto = z.infer<typeof GigFieldDto>;

export const GigFieldValueDto = z.object({ fieldKey: z.string(), value: GigFieldValue });
export type GigFieldValueDto = z.infer<typeof GigFieldValueDto>;

/** What the server will accept for this version (limits are configuration, the permissions come from the bound template version). */
export const GigConstraintsDto = z.object({
  title: z.object({ maxLength: z.number().int() }),
  shortPitch: z.object({ maxLength: z.number().int() }),
  description: z.object({ maxLength: z.number().int() }),
  price: z.object({ permitted: z.boolean(), required: z.boolean(), currency: z.string().length(3).nullable() }),
  duration: z.object({
    permitted: z.boolean(),
    required: z.boolean(),
    minMinutes: z.number().int().nullable(),
    maxMinutes: z.number().int().nullable(),
    suggestedMinutes: z.number().int().nullable(),
  }),
});
export type GigConstraintsDto = z.infer<typeof GigConstraintsDto>;

export const GigVersionSummaryDto = z.object({
  gigVersionId: z.string(),
  versionNumber: z.number().int(),
  status: GigVersionStatus,
  statusKey: z.string(),
  /** Concurrency token of a DRAFT (bumped by every save); fixed once published. */
  revision: z.number().int(),
  gigTemplateVersionNumber: z.number().int(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
export type GigVersionSummaryDto = z.infer<typeof GigVersionSummaryDto>;

export const GigVersionDto = GigVersionSummaryDto.extend({
  shortPitch: z.string().nullable(),
  description: z.string().nullable(),
  price: GigPriceDto.nullable(),
  durationMinutes: z.number().int().nullable(),
  fieldValues: z.array(GigFieldValueDto),
  template: GigTemplateLinkDto,
  fields: z.array(GigFieldDto),
  constraints: GigConstraintsDto,
  /** DRAFT only: whether publishing would succeed now, and what stands in the way. Published versions are complete by definition. */
  publishable: z.boolean().nullable(),
  issues: z.array(GigIssueDto),
});
export type GigVersionDto = z.infer<typeof GigVersionDto>;

export const GigDto = z.object({
  gigId: z.string(),
  status: GigStatus,
  statusKey: z.string(),
  gigTemplateCode: z.string(),
  serviceTypeCode: z.string(),
  categoryCode: z.string(),
  nameContentKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retiredAt: z.string().nullable(),
});
export type GigDto = z.infer<typeof GigDto>;

/** One Gig with its current published version, its editable draft and the history. */
export const GigDetailDto = z.object({
  gig: GigDto,
  currentVersion: GigVersionDto.nullable(),
  draftVersion: GigVersionDto.nullable(),
  versions: z.array(GigVersionSummaryDto),
});
export type GigDetailDto = z.infer<typeof GigDetailDto>;
export const GigDetailResponse = envelope(GigDetailDto);
export const GigVersionResponse = envelope(GigVersionDto);

/** A GigMenu row: owner-only, one read for the whole list (no per-Gig lookups). Not a public listing and not search. */
export const GigMenuItemDto = z.object({
  gig: GigDto,
  currentVersion: z
    .object({
      versionNumber: z.number().int(),
      title: z.string().nullable(),
      shortPitch: z.string().nullable(),
      price: GigPriceDto.nullable(),
      durationMinutes: z.number().int().nullable(),
      publishedAt: z.string(),
    })
    .nullable(),
  draftVersion: z.object({ versionNumber: z.number().int(), revision: z.number().int(), title: z.string().nullable(), updatedAt: z.string() }).nullable(),
  versionCount: z.number().int(),
});
export type GigMenuItemDto = z.infer<typeof GigMenuItemDto>;

/** The Gig facts a later checkpoint (PRO-003 Go-Live) reads. Facts only: nothing here says a provider is live or bookable. */
export const GigReadinessDto = z.object({
  hasPublishedGig: z.boolean(),
  publishedGigCount: z.number().int(),
  draftVersionCount: z.number().int(),
  goLive: z.object({ evaluated: z.literal(false), eligible: z.literal(false) }),
});
export type GigReadinessDto = z.infer<typeof GigReadinessDto>;

export const GigMenuDto = z.object({
  gigs: z.array(GigMenuItemDto),
  readiness: GigReadinessDto,
  limits: z.object({ maxActive: z.number().int(), maxDrafts: z.number().int(), activeCount: z.number().int(), draftCount: z.number().int() }),
  /** Whether the account can create Gigs now (an eligible provider with a market) and why not otherwise. */
  canCreate: z.boolean(),
  cannotCreateReason: z.enum(['PROVIDER_NOT_ELIGIBLE', 'DRAFT_LIMIT_REACHED']).nullable(),
});
export type GigMenuDto = z.infer<typeof GigMenuDto>;
export const GigMenuResponse = envelope(GigMenuDto);

/** A Gig Template the provider can start a Gig from now (ACTIVE template with an ACTIVE version, enabled in the provider's market, for a service type the provider selected). */
export const GigTemplateChoiceDto = z.object({
  gigTemplateCode: z.string(),
  serviceTypeCode: z.string(),
  categoryCode: z.string(),
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  gigTemplateVersionNumber: z.number().int(),
});
export type GigTemplateChoiceDto = z.infer<typeof GigTemplateChoiceDto>;
export const GigTemplateChoicesDto = z.object({ marketCode: z.string().nullable(), templates: z.array(GigTemplateChoiceDto) });
export type GigTemplateChoicesDto = z.infer<typeof GigTemplateChoicesDto>;
export const GigTemplateChoicesResponse = envelope(GigTemplateChoicesDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers only, never provider text)
export const GIG_EVENTS = {
  gigCreated: 'bananagig.provider.gig-created.v1',
  gigVersionPublished: 'bananagig.provider.gig-version-published.v1',
  gigRetired: 'bananagig.provider.gig-retired.v1',
} as const;
export const GigCreatedPayload = z.object({ accountId: z.string(), gigId: z.string(), gigVersionId: z.string(), gigTemplateVersionId: z.string() });
export type GigCreatedPayload = z.infer<typeof GigCreatedPayload>;
export const GigVersionPublishedPayload = z.object({
  accountId: z.string(),
  gigId: z.string(),
  gigVersionId: z.string(),
  versionNumber: z.number().int(),
  gigTemplateVersionId: z.string(),
  supersededGigVersionId: z.string().nullable(),
});
export type GigVersionPublishedPayload = z.infer<typeof GigVersionPublishedPayload>;
export const GigRetiredPayload = z.object({ accountId: z.string(), gigId: z.string() });
export type GigRetiredPayload = z.infer<typeof GigRetiredPayload>;

// ---------------------------------------------------------------- errors
export const GIG_ERROR_CODES = [
  'GIG_NOT_FOUND',
  'GIG_VERSION_NOT_FOUND',
  'GIG_TEMPLATE_NOT_FOUND',
  'GIG_TEMPLATE_NOT_AVAILABLE',
  'PROVIDER_NOT_ELIGIBLE',
  'ACCOUNT_NOT_ACTIVE',
  'GIG_RETIRED',
  'DRAFT_EXISTS',
  'NO_DRAFT',
  'STALE_DRAFT',
  'PUBLISH_BLOCKED',
  'LIMIT_REACHED',
  'VALIDATION_FAILED',
  'CONFLICT',
  'UNAVAILABLE',
] as const;
export type GigErrorCode = (typeof GIG_ERROR_CODES)[number];

/** The code on the wire (`error.code`): the contract code itself when it already starts with `GIG_`, else `GIG_<code>` (never `GIG_GIG_...`). */
export const gigWireCode = (c: GigErrorCode): string => (c.startsWith('GIG_') ? c : `GIG_${c}`);
