// Catalogue API shaping and error mapping. Every mapper builds the response field by field: the service already shapes its public view, but the API never relies on that
// alone. The management-only fields (status, availability flag, content keys, timestamps) are added only when the route authorized the management view; audit and actor
// fields have no mapping at all, so they cannot leak by accident.
import type { CatalogCategoryDto, CatalogServiceTypeDto, ProhibitedServiceDto } from '@bananagig/contracts';
import { CatalogError, type CategoryView, type ProhibitedServiceView, type ServiceTypeView } from '@bananagig/catalog';
import { AppError } from '../../errors';

/** The resolved text of a set of content keys (the content registry decides the locale and the fallback). */
export interface Texts {
  get(key: string): string | undefined;
}

/**
 * PUBLIC: an item whose NAME has no published text is not offered (an unnamed item cannot be shown to a customer) and `null` is returned. MANAGEMENT: the name falls back to
 * the content key so an administrator can see exactly what is missing.
 */
export function categoryDto(v: CategoryView, texts: Texts, management: boolean): CatalogCategoryDto | null {
  const name = texts.get(v.nameContentKey) ?? (management ? v.nameContentKey : undefined);
  if (name === undefined) return null;
  return {
    categoryId: v.categoryId,
    code: v.code,
    name,
    description: v.descriptionContentKey === null ? null : (texts.get(v.descriptionContentKey) ?? null),
    iconKey: v.iconKey,
    displayOrder: management ? v.displayOrder : (v.displayOrder as number),
    ...(management
      ? {
          ...(v.status !== undefined ? { status: v.status } : {}),
          ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
          nameContentKey: v.nameContentKey,
          descriptionContentKey: v.descriptionContentKey,
          ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
          ...(v.updatedAt !== undefined ? { updatedAt: v.updatedAt } : {}),
        }
      : {}),
  };
}

export function serviceTypeDto(v: ServiceTypeView, texts: Texts, management: boolean): CatalogServiceTypeDto | null {
  const name = texts.get(v.nameContentKey) ?? (management ? v.nameContentKey : undefined);
  if (name === undefined) return null;
  return {
    serviceTypeId: v.serviceTypeId,
    code: v.code,
    categoryCode: v.categoryCode,
    name,
    description: v.descriptionContentKey === null ? null : (texts.get(v.descriptionContentKey) ?? null),
    displayOrder: management ? v.displayOrder : (v.displayOrder as number),
    ...(management
      ? {
          ...(v.status !== undefined ? { status: v.status } : {}),
          ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
          nameContentKey: v.nameContentKey,
          descriptionContentKey: v.descriptionContentKey,
          ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
          ...(v.updatedAt !== undefined ? { updatedAt: v.updatedAt } : {}),
        }
      : {}),
  };
}

/** Management only (the route requires catalog-read): the name and description fall back to nothing when no text is published. */
export function prohibitedServiceDto(v: ProhibitedServiceView, texts: Texts): ProhibitedServiceDto {
  return {
    prohibitedServiceId: v.prohibitedServiceId,
    code: v.code,
    categoryCode: v.categoryCode,
    name: texts.get(v.nameContentKey) ?? null,
    description: v.descriptionContentKey === null ? null : (texts.get(v.descriptionContentKey) ?? null),
    status: v.status,
    nameContentKey: v.nameContentKey,
    descriptionContentKey: v.descriptionContentKey,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

/**
 * The ONLY service details that reach a client: an ALLOW-list of short machine tokens (`reason`, `field`, `retryable`, and the `code` that was asked for, cut to 64 characters).
 * Anything else a future service change might put in `details` (a constraint, a cause, SQL, a table, a value) is dropped here, not trusted to be absent.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
export function safeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reason', 'field', 'code'] as const) {
    const v = details[key];
    if (typeof v === 'string' && SAFE_TOKEN.test(v.slice(0, 64))) out[key] = v.slice(0, 64);
  }
  if (details.retryable === true) out.retryable = true;
  return out;
}

/** Maps typed catalogue failures onto the standard API error model. The AppError code is `CATALOG_<CatalogError code>`; details hold identifiers and reasons only. */
export function toAppError(err: unknown): never {
  if (!(err instanceof CatalogError)) throw err;
  const details = safeDetails(err.details);
  const code = `CATALOG_${err.code}`;
  switch (err.code) {
    case 'CATEGORY_NOT_FOUND':
    case 'SERVICE_TYPE_NOT_FOUND':
    case 'PROHIBITED_SERVICE_NOT_FOUND':
    case 'MARKET_NOT_FOUND':
      throw new AppError('NOT_FOUND', code, err.message, details);
    case 'VALIDATION_FAILED':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'CONFLICT':
    case 'INVALID_STATE':
      throw new AppError('CONFLICT', code, err.message, details);
    case 'UNAVAILABLE':
      throw new AppError('DEPENDENCY', code, 'The catalogue is temporarily unavailable');
  }
}
