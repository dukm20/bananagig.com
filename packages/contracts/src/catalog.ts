// Public contracts of the catalogue taxonomy (CAT-001, docs/engineering/CATALOG.md): the PLATFORM-OWNED categories and service types, their market availability
// and the prohibited-service list. Reference data only. A category is a group of service types (Auto Services), a service type is what a provider can offer
// (Car Detailing); a Gig (Full Detail) belongs to a provider and arrives later: nothing here carries a price, a duration, a radius, a capacity or any other
// provider-specific field. Names and descriptions are managed content (CFG-002): the tables hold a stable code, never display text.
import { z } from 'zod';
import { Locale } from './content';
import { envelope } from './envelope';
import { MarketCode } from './geography';
import { adminText } from './text';

// ---------------------------------------------------------------- codes
export const CATALOG_CODE_MIN = 2;
export const CATALOG_CODE_MAX = 48;
/**
 * The stable, immutable code of a category, a service type or a prohibited service: lower-case snake_case (home_cleaning). It is the identity used by the API,
 * the CATEGORY configuration scope and the content keys (catalog.category.<code>.name); it never changes and is never reused (a retired row keeps it).
 */
export const CATALOG_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const CatalogCode = z.string().min(CATALOG_CODE_MIN).max(CATALOG_CODE_MAX).regex(CATALOG_CODE_PATTERN);
export type CatalogCode = z.infer<typeof CatalogCode>;
/** DEV/TEST codes (devtest_*) exist only where the services run with allowTestKeys, like devtest markets and devtest content keys. */
export const CATALOG_TEST_CODE_PREFIX = 'devtest_';
/** A design-system icon name (not a URL, not media): lower-case kebab. The media pipeline is a later checkpoint (DEBT-0083). */
export const ICON_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const IconKey = z.string().min(1).max(48).regex(ICON_KEY_PATTERN);
/** Position in the menu of a market (ascending), unique per market. */
export const CATALOG_DISPLAY_ORDER_MIN = 1;
export const CATALOG_DISPLAY_ORDER_MAX = 9999;
export const DisplayOrder = z.number().int().min(CATALOG_DISPLAY_ORDER_MIN).max(CATALOG_DISPLAY_ORDER_MAX);

// ---------------------------------------------------------------- status machine
/**
 * DRAFT is the initial status only (never written back). ACTIVE and INACTIVE move both ways (INACTIVE is a pause). RETIRED is terminal: it blocks every new use,
 * keeps the row, the code and the history, and the code is never reused.
 */
export const CATALOG_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'] as const;
export const CatalogStatus = z.enum(CATALOG_STATUSES);
export type CatalogStatus = z.infer<typeof CatalogStatus>;
export const CATALOG_STATUS_TRANSITIONS: Readonly<Record<CatalogStatus, readonly CatalogStatus[]>> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['INACTIVE', 'RETIRED'],
  INACTIVE: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};
export const isCatalogTransitionAllowed = (from: CatalogStatus, to: CatalogStatus): boolean => CATALOG_STATUS_TRANSITIONS[from].includes(to);
/** The statuses a management request can ask for (DRAFT is never a target). */
export const CATALOG_TARGET_STATUSES = ['ACTIVE', 'INACTIVE', 'RETIRED'] as const;
export const CatalogTargetStatus = z.enum(CATALOG_TARGET_STATUSES);
export type CatalogTargetStatus = z.infer<typeof CatalogTargetStatus>;

// ---------------------------------------------------------------- managed content keys (CFG-002)
/** The content keys are DERIVED from the code (the database column is generated), so a rename in the content registry never touches the identity. */
export const categoryNameKey = (code: string): string => `catalog.category.${code}.name`;
export const categoryDescriptionKey = (code: string): string => `catalog.category.${code}.description`;
export const serviceTypeNameKey = (code: string): string => `catalog.service_type.${code}.name`;
export const serviceTypeDescriptionKey = (code: string): string => `catalog.service_type.${code}.description`;
export const prohibitedServiceNameKey = (code: string): string => `catalog.prohibited_service.${code}.name`;
export const prohibitedServiceDescriptionKey = (code: string): string => `catalog.prohibited_service.${code}.description`;

// ---------------------------------------------------------------- read models
/** A category as a customer or provider sees it in a market: resolved text, stable id and code, the position in that market. */
export const CatalogCategoryDto = z.object({
  categoryId: z.string(),
  code: CatalogCode,
  name: z.string(),
  description: z.string().nullable(),
  iconKey: z.string().nullable(),
  /** Position in the menu of the market. Public responses always carry it; the global management view (no market) has none. */
  displayOrder: z.number().int().nullable(),
  /** Management only. */
  status: CatalogStatus.optional(),
  /** Management only: with a market, whether the category is enabled there (disabled rows are listed to administrators). */
  enabled: z.boolean().optional(),
  nameContentKey: z.string().optional(),
  descriptionContentKey: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CatalogCategoryDto = z.infer<typeof CatalogCategoryDto>;
export const CatalogCategoryResponse = envelope(CatalogCategoryDto);
export const CatalogCategoryListResponse = envelope(z.array(CatalogCategoryDto));

export const CatalogServiceTypeDto = z.object({
  serviceTypeId: z.string(),
  code: CatalogCode,
  categoryCode: CatalogCode,
  name: z.string(),
  description: z.string().nullable(),
  displayOrder: z.number().int().nullable(),
  status: CatalogStatus.optional(),
  enabled: z.boolean().optional(),
  nameContentKey: z.string().optional(),
  descriptionContentKey: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CatalogServiceTypeDto = z.infer<typeof CatalogServiceTypeDto>;
export const CatalogServiceTypeResponse = envelope(CatalogServiceTypeDto);
export const CatalogServiceTypeListResponse = envelope(z.array(CatalogServiceTypeDto));

/** Management only: a platform-level prohibition. No moderation workflow exists; the list is data for the checkpoints that moderate. */
export const ProhibitedServiceDto = z.object({
  prohibitedServiceId: z.string(),
  code: CatalogCode,
  categoryCode: CatalogCode.nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  status: CatalogStatus,
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProhibitedServiceDto = z.infer<typeof ProhibitedServiceDto>;
export const ProhibitedServiceResponse = envelope(ProhibitedServiceDto);
export const ProhibitedServiceListResponse = envelope(z.array(ProhibitedServiceDto));

/** The state of one availability row after a change (management). */
export const MarketAvailabilityDto = z.object({
  marketCode: z.string(),
  code: CatalogCode,
  kind: z.enum(['CATEGORY', 'SERVICE_TYPE']),
  enabled: z.boolean(),
  displayOrder: z.number().int(),
  /** Service-type rows switched off in the same change because their category was switched off in the market (codes only). */
  alsoDisabled: z.array(CatalogCode),
});
export type MarketAvailabilityDto = z.infer<typeof MarketAvailabilityDto>;
export const MarketAvailabilityResponse = envelope(MarketAvailabilityDto);

// ---------------------------------------------------------------- queries
/** The query of the public reads: the market (REQUIRED for the public view) and the locale of the text (default: the default locale of the market). */
export const CatalogReadQuery = z.object({ market: MarketCode.optional(), locale: Locale.optional() }).strict();
export const CatalogServiceTypeQuery = CatalogReadQuery.extend({ category: CatalogCode.optional() }).strict();

// ---------------------------------------------------------------- requests (management; every change carries a reason)
const reason = adminText(1000);
export const CreateCategoryRequest = z.object({ code: CatalogCode, iconKey: IconKey.nullish(), withDescription: z.boolean().optional(), reason }).strict();
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;
/** Metadata only: the code, the content keys' stem and the status are not editable here. `withDescription` links (true) or unlinks (false) the description entry. */
export const UpdateCategoryRequest = z
  .object({ iconKey: IconKey.nullish(), withDescription: z.boolean().optional(), reason })
  .strict()
  .refine((v) => v.iconKey !== undefined || v.withDescription !== undefined, { message: 'at least one of iconKey and withDescription is required' });
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;
export const CreateServiceTypeRequest = z.object({ code: CatalogCode, categoryCode: CatalogCode, withDescription: z.boolean().optional(), reason }).strict();
export type CreateServiceTypeRequest = z.infer<typeof CreateServiceTypeRequest>;
export const UpdateServiceTypeRequest = z.object({ withDescription: z.boolean(), reason }).strict();
export type UpdateServiceTypeRequest = z.infer<typeof UpdateServiceTypeRequest>;
export const CatalogStatusRequest = z.object({ status: CatalogTargetStatus, reason }).strict();
export type CatalogStatusRequest = z.infer<typeof CatalogStatusRequest>;
export const CreateProhibitedServiceRequest = z
  .object({ code: CatalogCode, categoryCode: CatalogCode.nullish(), withDescription: z.boolean().optional(), reason })
  .strict();
export type CreateProhibitedServiceRequest = z.infer<typeof CreateProhibitedServiceRequest>;
/** Availability of a category or service type in ONE market: `displayOrder` is required when the row does not exist yet. */
export const SetMarketAvailabilityRequest = z.object({ enabled: z.boolean(), displayOrder: DisplayOrder.optional(), reason }).strict();
export type SetMarketAvailabilityRequest = z.infer<typeof SetMarketAvailabilityRequest>;

// ---------------------------------------------------------------- events (transactional outbox; identifiers only)
export const CATALOG_EVENTS = {
  categoryActivated: 'bananagig.catalog.category-activated.v1',
  categoryDeactivated: 'bananagig.catalog.category-deactivated.v1',
  serviceTypeActivated: 'bananagig.catalog.service-type-activated.v1',
  serviceTypeDeactivated: 'bananagig.catalog.service-type-deactivated.v1',
  availabilityChanged: 'bananagig.catalog.availability-changed.v1',
} as const;
export const CategoryEventPayload = z.object({ categoryCode: CatalogCode });
export type CategoryEventPayload = z.infer<typeof CategoryEventPayload>;
export const ServiceTypeEventPayload = z.object({ serviceTypeCode: CatalogCode, categoryCode: CatalogCode });
export type ServiceTypeEventPayload = z.infer<typeof ServiceTypeEventPayload>;
export const CatalogAvailabilityEventPayload = z.object({
  marketCode: z.string(),
  kind: z.enum(['CATEGORY', 'SERVICE_TYPE']),
  code: CatalogCode,
  enabled: z.boolean(),
});
export type CatalogAvailabilityEventPayload = z.infer<typeof CatalogAvailabilityEventPayload>;

// ---------------------------------------------------------------- errors
export const CATALOG_ERROR_CODES = [
  'CATEGORY_NOT_FOUND',
  'SERVICE_TYPE_NOT_FOUND',
  'PROHIBITED_SERVICE_NOT_FOUND',
  'GIG_TEMPLATE_NOT_FOUND',
  'GIG_TEMPLATE_VERSION_NOT_FOUND',
  'MARKET_NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'INVALID_STATE',
  'UNAVAILABLE',
] as const;
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];
