// Service-level views of the catalogue: structure, codes and CONTENT KEYS, never display text (the API resolves the text through the content registry). Management-only fields are
// present only in the management view.
import type { CatalogStatus } from '@bananagig/contracts';

export interface CategoryView {
  categoryId: string;
  code: string;
  nameContentKey: string;
  descriptionContentKey: string | null;
  iconKey: string | null;
  /** Position in the market's menu; null in the global management view (no market). */
  displayOrder: number | null;
  /** Management only. */
  status?: CatalogStatus;
  /** Management only, with a market: whether the category is enabled there. */
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ServiceTypeView {
  serviceTypeId: string;
  code: string;
  categoryCode: string;
  nameContentKey: string;
  descriptionContentKey: string | null;
  displayOrder: number | null;
  status?: CatalogStatus;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProhibitedServiceView {
  prohibitedServiceId: string;
  code: string;
  categoryCode: string | null;
  nameContentKey: string;
  descriptionContentKey: string | null;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
}

/** What the catalogue needs to know about a market that is visible to the public (ACTIVE and in effect). */
export interface PublicMarket {
  code: string;
  defaultLocale: string;
}

/**
 * Port: the public visibility of a market is decided by the geography registry (ACTIVE and in effect), never copied here. Implemented in the API composition root
 * on top of GeographyService.getMarket; returns null for anything that is not public (unknown, PLANNED, INACTIVE, outside its window).
 */
export interface MarketGate {
  publicMarket(code: string): Promise<PublicMarket | null>;
}

/** The public catalogue of one market, as the cache holds it: ACTIVE items enabled in the market, in the market's order. */
export interface MarketCatalog {
  market: PublicMarket;
  categories: CategoryView[];
  serviceTypes: ServiceTypeView[];
}

export interface ManagementReadOptions {
  /** The market whose availability and order are shown (any status of the market). Absent: the global view ordered by code (the documented fallback for administration). */
  marketCode?: string;
}
