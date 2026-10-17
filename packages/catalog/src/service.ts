// The catalogue service (CAT-001): the PLATFORM-OWNED taxonomy of categories and service types, their availability per market, the prohibited-service list and the audited
// management operations. Transaction boundaries live here. Events go through the transactional outbox, in the same transaction as the change.
//
// Visibility: the service never reads roles. Callers decide: `management: true` shows every status, the management-only fields and the disabled availability rows,
// needs no public market and bypasses the cache; the default is the PUBLIC view: a market that is public (the MarketGate: ACTIVE and in effect, decided by the geography
// registry), a category that is ACTIVE and enabled in it and, for a service type, ACTIVE and enabled in it too. Nothing here holds or returns display text: names and
// descriptions are content keys, resolved by the content registry in the API layer.
//
// Concurrency: the database constraints and guard triggers decide (codes, orders, the status machine, the hierarchy rules). ONE lock order everywhere: the category row, then
// the service type row, then the market rows (a child takes its parent FOR SHARE inside its guard; a parent's change takes its own row lock and the guard reads the children).
// Rows are LOCKED with a bare single-table statement and READ by a second statement (READ COMMITTED re-checks only the locked row after a wait).
import { randomUUID } from 'node:crypto';
import {
  CATALOG_EVENTS,
  CATALOG_TEST_CODE_PREFIX,
  CatalogStatusRequest,
  CreateCategoryRequest,
  CreateProhibitedServiceRequest,
  CreateServiceTypeRequest,
  MarketCode,
  SetMarketAvailabilityRequest,
  UpdateCategoryRequest,
  UpdateServiceTypeRequest,
  categoryDescriptionKey,
  prohibitedServiceDescriptionKey,
  serviceTypeDescriptionKey,
  type CatalogAvailabilityEventPayload,
  type CatalogStatus,
  type CategoryEventPayload,
  type MarketAvailabilityDto,
  type ServiceTypeEventPayload,
} from '@bananagig/contracts';
import type { ConfigCache } from '@bananagig/configuration';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { z } from 'zod';
import { cachedRead, invalidateCatalog, DEFAULT_CATALOG_CACHE_TTL_SECONDS, type ReadSource } from './cache';
import { CatalogError, isDatabaseOutage } from './errors';
import type { CategoryView, ManagementReadOptions, MarketCatalog, MarketGate, ProhibitedServiceView, ServiceTypeView } from './types';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

export interface CatalogServiceDeps {
  database: Database;
  /** The public visibility of a market (geography). */
  markets: MarketGate;
  cache?: ConfigCache;
  env: string;
  /** Cache entry lifetime (default 300 s: the taxonomy changes rarely and every change bumps the generation). */
  cacheTtlSeconds?: number;
  /** Deadline of each cache call (default 250 ms). */
  cacheDeadlineMs?: number;
  /** DEV/TEST only: permits `devtest_*` codes. Must be false in production. */
  allowTestKeys?: boolean;
}

// ---------------------------------------------------------------- errors
/** The machine-readable key the migration puts in the DETAIL of every guard failure: exactly `catalog_rule:<KEY>`. */
const RULE_DETAIL = /^catalog_rule:([A-Z][A-Z_]*)$/;
export function guardRuleOf(detail: unknown): string | undefined {
  return typeof detail === 'string' ? RULE_DETAIL.exec(detail)?.[1] : undefined;
}
const INVALID_STATE_RULES: Readonly<Record<string, string>> = {
  CATEGORY_HAS_ACTIVE_SERVICE_TYPES: 'the category still has ACTIVE service types: deactivate them first',
  CATEGORY_HAS_OPEN_SERVICE_TYPES: 'the category still has service types that are not RETIRED: retire them first',
  CATEGORY_NOT_ACTIVE: 'a service type can be ACTIVE only while its category is ACTIVE',
  CATEGORY_RETIRED: 'a service type cannot be created under a RETIRED category',
  ITEM_RETIRED: 'a RETIRED item cannot be enabled in a market',
  CATEGORY_NOT_ENABLED_IN_MARKET: 'a service type can be enabled in a market only while its category is enabled there',
  CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES: 'the category still has service types enabled in the market',
  DRAFT_IS_INITIAL: 'DRAFT is the initial status and cannot be set again',
  STATUS_TRANSITION: 'the status transition is not allowed',
  MUST_START_AS_DRAFT: 'a catalogue item is created as DRAFT',
};
function guardError(rule: string | undefined): CatalogError {
  if (rule && INVALID_STATE_RULES[rule]) return new CatalogError('INVALID_STATE', INVALID_STATE_RULES[rule]!, { reason: rule });
  if (rule === 'NOT_DELETABLE' || rule === 'IMMUTABLE_IDENTITY' || rule === 'ROW_IMMUTABLE')
    return new CatalogError('INVALID_STATE', 'the record is immutable (identity fields cannot change and rows are never deleted)', { reason: 'IMMUTABLE' });
  return new CatalogError('INVALID_STATE', 'the operation violates a catalogue integrity rule');
}
/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names). Guard (trigger) failures are
 * classified by `error.detail` (`catalog_rule:<KEY>`), constraint failures by SQLSTATE and constraint name.
 */
export function mapDbError(err: unknown): never {
  if (err instanceof CatalogError || err === null || typeof err !== 'object') throw err;
  const e = err as { code?: string; detail?: string; constraint?: string };
  const constraint = e.constraint;
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03')
    throw new CatalogError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  if (e.code === '22021' || e.code === '22P05')
    throw new CatalogError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23505') {
    // two identical first submissions of the same (market, item) pair: the loser hit the primary key. It is a lost race, not a code clash: repeat the request
    if (constraint?.startsWith('pk_market_'))
      throw new CatalogError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
        reason: 'CONCURRENT_UPDATE',
        retryable: true,
      });
    if (constraint?.endsWith('__market_order'))
      throw new CatalogError('CONFLICT', 'another item of the market already has that display order', { reason: 'DISPLAY_ORDER_TAKEN' });
    throw new CatalogError('CONFLICT', 'a record with this code already exists', { reason: 'CODE_TAKEN' });
  }
  if (e.code === '23514') throw new CatalogError('VALIDATION_FAILED', 'the operation violates a catalogue constraint', { constraint });
  if (e.code === '23502') throw new CatalogError('VALIDATION_FAILED', 'a required field is missing', { constraint });
  if (e.code === '23503') {
    if (constraint?.endsWith('__name_content_key'))
      throw new CatalogError('VALIDATION_FAILED', 'the name content entry of this code does not exist: create and publish it in the content registry first', {
        reason: 'NAME_CONTENT_MISSING',
      });
    if (constraint?.endsWith('__description_content_key'))
      throw new CatalogError('VALIDATION_FAILED', 'the description content entry of this code does not exist: create it in the content registry first', {
        reason: 'DESCRIPTION_CONTENT_MISSING',
      });
    throw new CatalogError('VALIDATION_FAILED', 'a referenced record does not exist', { constraint });
  }
  if (e.code === '23000') throw guardError(guardRuleOf(e.detail));
  if (isDatabaseOutage(err)) {
    log('error', 'catalog database unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw new CatalogError('UNAVAILABLE', 'the catalogue database is unavailable');
  }
  throw err;
}

// ---------------------------------------------------------------- pure helpers
const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const status = (v: unknown): CatalogStatus => v as CatalogStatus;
const invalid = (message: string, details: Record<string, unknown>): CatalogError => new CatalogError('VALIDATION_FAILED', message, details);

/** Validates a management input with the contract schema; the first issue names the field and nothing of the value. */
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw invalid('the request is not valid', { reason: 'INVALID_FIELD', field: first?.path.join('.') || undefined });
}
export function categoryView(r: Row, management: boolean): CategoryView {
  return {
    categoryId: r.category_id as string,
    code: r.code as string,
    nameContentKey: r.name_content_key as string,
    descriptionContentKey: (r.description_content_key as string | null) ?? null,
    iconKey: (r.icon_key as string | null) ?? null,
    displayOrder: r.display_order === null || r.display_order === undefined ? null : Number(r.display_order),
    ...(management
      ? {
          status: status(r.status),
          ...(r.enabled === null || r.enabled === undefined ? {} : { enabled: r.enabled === true }),
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
        }
      : {}),
  };
}
export function serviceTypeView(r: Row, management: boolean): ServiceTypeView {
  return {
    serviceTypeId: r.service_type_id as string,
    code: r.code as string,
    categoryCode: r.category_code as string,
    nameContentKey: r.name_content_key as string,
    descriptionContentKey: (r.description_content_key as string | null) ?? null,
    displayOrder: r.display_order === null || r.display_order === undefined ? null : Number(r.display_order),
    ...(management
      ? {
          status: status(r.status),
          ...(r.enabled === null || r.enabled === undefined ? {} : { enabled: r.enabled === true }),
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
        }
      : {}),
  };
}
function prohibitedView(r: Row): ProhibitedServiceView {
  return {
    prohibitedServiceId: r.prohibited_service_id as string,
    code: r.code as string,
    categoryCode: (r.category_code as string | null) ?? null,
    nameContentKey: r.name_content_key as string,
    descriptionContentKey: (r.description_content_key as string | null) ?? null,
    status: status(r.status),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// ---------------------------------------------------------------- cached snapshot validation (a malformed cache entry is a miss)
const CategoryViewSchema = z.object({
  categoryId: z.string(),
  code: z.string(),
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  iconKey: z.string().nullable(),
  displayOrder: z.number().int().nullable(),
});
const ServiceTypeViewSchema = z.object({
  serviceTypeId: z.string(),
  code: z.string(),
  categoryCode: z.string(),
  nameContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
  displayOrder: z.number().int().nullable(),
});
const SnapshotSchema = z.object({ categories: z.array(CategoryViewSchema), serviceTypes: z.array(ServiceTypeViewSchema) });
type Snapshot = z.infer<typeof SnapshotSchema>;
const parseSnapshot = (raw: unknown): Snapshot | null => {
  const r = SnapshotSchema.safeParse(raw);
  return r.success ? r.data : null;
};

// ---------------------------------------------------------------- SQL
const categorySelect = sql`SELECT c.category_id, c.code, c.name_content_key, c.description_content_key, c.icon_key, c.status, c.created_at, c.updated_at`;
const serviceTypeSelect = sql`SELECT st.service_type_id, st.code, c.code AS category_code, st.name_content_key, st.description_content_key, st.status, st.created_at, st.updated_at`;

export class CatalogService {
  private readonly ttl: number;

  constructor(private readonly d: CatalogServiceDeps) {
    this.ttl = d.cacheTtlSeconds ?? DEFAULT_CATALOG_CACHE_TTL_SECONDS;
  }

  private get db(): Executor {
    return this.d.database.db;
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  /** Reads in ONE consistent snapshot: a read-only REPEATABLE READ transaction. */
  private snapshotRead<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true }).catch(mapDbError);
  }
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch(mapDbError);
  }
  private invalidate(): Promise<void> {
    return invalidateCatalog(this.d.cache, this.d.env, this.d.cacheDeadlineMs);
  }
  /**
   * Runs an idempotent availability change and repeats it ONCE when it lost a race (a deadlock, a serialization failure or the primary key of the same new pair): the second
   * attempt sees the winner's row and either changes nothing (a double click) or applies what it asked for. Anything else, and a second loss, surfaces as the retryable CONFLICT.
   */
  private async retryOnRace<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CatalogError && err.code === 'CONFLICT' && err.details.reason === 'CONCURRENT_UPDATE') return fn();
      throw err;
    }
  }

  // ================================================================== public reads (the market must be public)
  private async publicMarketOrThrow(marketCode: string) {
    if (!MarketCode.safeParse(marketCode).success)
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code: String(marketCode).slice(0, 64) });
    const market = await this.d.markets.publicMarket(marketCode);
    if (!market) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code: marketCode });
    return market;
  }

  /**
   * The public catalogue of a market: its ACTIVE categories enabled in it and its ACTIVE service types enabled in it (under an enabled, ACTIVE category), in the market's order.
   * Throws MARKET_NOT_FOUND unless the market is public (ACTIVE and in effect). Cached by market and catalogue generation; the market's own visibility is decided by the
   * gate on every call (never cached here).
   */
  async getMarketCatalog(marketCode: string): Promise<MarketCatalog & { source: ReadSource }> {
    const market = await this.publicMarketOrThrow(marketCode);
    const { value, source } = await cachedRead<Snapshot>({
      cache: this.d.cache,
      env: this.d.env,
      what: `market:${market.code}`,
      ttlSeconds: this.ttl,
      deadlineMs: this.d.cacheDeadlineMs,
      load: () => this.loadPublicSnapshot(market.code),
      parse: parseSnapshot,
    });
    return { market, categories: value.categories, serviceTypes: value.serviceTypes, source };
  }

  private loadPublicSnapshot(marketCode: string): Promise<Snapshot> {
    return this.snapshotRead(async (trx) => {
      const categories = (
        await sql<Row>`SELECT c.category_id, c.code, c.name_content_key, c.description_content_key, c.icon_key, mc.display_order
          FROM catalog.market_categories mc
          JOIN geography.markets m ON m.market_id = mc.market_id
          JOIN catalog.categories c ON c.category_id = mc.category_id
         WHERE m.code = ${marketCode} AND mc.enabled AND c.status = 'ACTIVE'
         ORDER BY mc.display_order`.execute(trx)
      ).rows.map((r) => categoryView(r, false));
      const serviceTypes = (
        await sql<Row>`SELECT st.service_type_id, st.code, c.code AS category_code, st.name_content_key, st.description_content_key, mst.display_order
          FROM catalog.market_service_types mst
          JOIN geography.markets m ON m.market_id = mst.market_id
          JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
          JOIN catalog.categories c ON c.category_id = st.category_id
          JOIN catalog.market_categories mc ON mc.market_id = mst.market_id AND mc.category_id = st.category_id
         WHERE m.code = ${marketCode} AND mst.enabled AND st.status = 'ACTIVE' AND c.status = 'ACTIVE' AND mc.enabled
         ORDER BY mst.display_order`.execute(trx)
      ).rows.map((r) => serviceTypeView(r, false));
      return { categories, serviceTypes };
    });
  }

  /** Public: the categories of a public market. Management: every category (any status) with its availability in the market, or the global list when no market is given. */
  async listCategoriesForMarket(marketCode: string): Promise<{ market: MarketCatalog['market']; categories: CategoryView[] }> {
    const c = await this.getMarketCatalog(marketCode);
    return { market: c.market, categories: c.categories };
  }

  /** Public: the service types of a public market, optionally of one category. */
  async listServiceTypesForMarket(
    marketCode: string,
    opts: { categoryCode?: string } = {},
  ): Promise<{ market: MarketCatalog['market']; serviceTypes: ServiceTypeView[] }> {
    const c = await this.getMarketCatalog(marketCode);
    return {
      market: c.market,
      serviceTypes: opts.categoryCode === undefined ? c.serviceTypes : c.serviceTypes.filter((s) => s.categoryCode === opts.categoryCode),
    };
  }

  async getCategoryForMarket(marketCode: string, code: string): Promise<{ market: MarketCatalog['market']; category: CategoryView }> {
    const c = await this.getMarketCatalog(marketCode);
    const category = c.categories.find((x) => x.code === code);
    if (!category) throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not available', { code: String(code).slice(0, 64) });
    return { market: c.market, category };
  }

  async getServiceTypeForMarket(marketCode: string, code: string): Promise<{ market: MarketCatalog['market']; serviceType: ServiceTypeView }> {
    const c = await this.getMarketCatalog(marketCode);
    const serviceType = c.serviceTypes.find((x) => x.code === code);
    if (!serviceType) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not available', { code: String(code).slice(0, 64) });
    return { market: c.market, serviceType };
  }

  // ================================================================== management reads (every status; never cached)
  /** The id of a market of ANY status (the foreign keys of the availability rows take their own key-share lock; markets are never deleted). */
  private async marketIdOf(ex: Executor, marketCode: string): Promise<string> {
    if (!MarketCode.safeParse(marketCode).success)
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(marketCode).slice(0, 64) });
    const r = await sql<Row>`SELECT market_id FROM geography.markets WHERE code = ${marketCode}`.execute(ex);
    const id = r.rows[0]?.market_id as string | undefined;
    if (!id) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: marketCode });
    return id;
  }

  /** The default locale of a market of ANY status (the management view shows a market's text in the locale its customers will get). */
  async getMarketDefaultLocale(marketCode: string): Promise<string> {
    if (!MarketCode.safeParse(marketCode).success)
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(marketCode).slice(0, 64) });
    const r = await this.read(async () => (await sql<Row>`SELECT default_locale FROM geography.markets WHERE code = ${marketCode}`.execute(this.db)).rows[0]);
    if (!r) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: marketCode });
    return r.default_locale as string;
  }

  async listCategories(opts: ManagementReadOptions = {}): Promise<CategoryView[]> {
    return this.read(async () => {
      if (opts.marketCode === undefined)
        return (await sql<Row>`${categorySelect} FROM catalog.categories c ORDER BY c.code COLLATE "C"`.execute(this.db)).rows.map((r) =>
          categoryView(r, true),
        );
      const marketId = await this.marketIdOf(this.db, opts.marketCode);
      return (
        await sql<Row>`${categorySelect}, mc.display_order, mc.enabled
          FROM catalog.categories c
          LEFT JOIN catalog.market_categories mc ON mc.category_id = c.category_id AND mc.market_id = ${marketId}
         ORDER BY mc.display_order NULLS LAST, c.code COLLATE "C"`.execute(this.db)
      ).rows.map((r) => categoryView(r, true));
    });
  }

  async getCategory(code: string, opts: ManagementReadOptions = {}): Promise<CategoryView> {
    const row = await this.read(async () => {
      const marketId = opts.marketCode === undefined ? null : await this.marketIdOf(this.db, opts.marketCode);
      return (
        await sql<Row>`${categorySelect}, mc.display_order, mc.enabled
          FROM catalog.categories c
          LEFT JOIN catalog.market_categories mc ON mc.category_id = c.category_id AND mc.market_id = ${marketId}
         WHERE c.code = ${code}`.execute(this.db)
      ).rows[0];
    });
    if (!row) throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not registered', { code: String(code).slice(0, 64) });
    return categoryView(row, true);
  }

  async listServiceTypes(opts: ManagementReadOptions & { categoryCode?: string } = {}): Promise<ServiceTypeView[]> {
    return this.read(async () => {
      const marketId = opts.marketCode === undefined ? null : await this.marketIdOf(this.db, opts.marketCode);
      return (
        await sql<Row>`${serviceTypeSelect}, mst.display_order, mst.enabled
          FROM catalog.service_types st
          JOIN catalog.categories c ON c.category_id = st.category_id
          LEFT JOIN catalog.market_service_types mst ON mst.service_type_id = st.service_type_id AND mst.market_id = ${marketId}
         WHERE (${opts.categoryCode ?? null}::text IS NULL OR c.code = ${opts.categoryCode ?? null})
         ORDER BY mst.display_order NULLS LAST, c.code COLLATE "C", st.code COLLATE "C"`.execute(this.db)
      ).rows.map((r) => serviceTypeView(r, true));
    });
  }

  async getServiceType(code: string, opts: ManagementReadOptions = {}): Promise<ServiceTypeView> {
    const row = await this.read(async () => {
      const marketId = opts.marketCode === undefined ? null : await this.marketIdOf(this.db, opts.marketCode);
      return (
        await sql<Row>`${serviceTypeSelect}, mst.display_order, mst.enabled
          FROM catalog.service_types st
          JOIN catalog.categories c ON c.category_id = st.category_id
          LEFT JOIN catalog.market_service_types mst ON mst.service_type_id = st.service_type_id AND mst.market_id = ${marketId}
         WHERE st.code = ${code}`.execute(this.db)
      ).rows[0];
    });
    if (!row) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code: String(code).slice(0, 64) });
    return serviceTypeView(row, true);
  }

  async listProhibitedServices(): Promise<ProhibitedServiceView[]> {
    return this.read(async () =>
      (
        await sql<Row>`SELECT p.prohibited_service_id, p.code, c.code AS category_code, p.name_content_key, p.description_content_key, p.status, p.created_at, p.updated_at
          FROM catalog.prohibited_services p LEFT JOIN catalog.categories c ON c.category_id = p.category_id ORDER BY p.code COLLATE "C"`.execute(this.db)
      ).rows.map(prohibitedView),
    );
  }

  async getProhibitedService(code: string): Promise<ProhibitedServiceView> {
    const row = await this.read(
      async () =>
        (
          await sql<Row>`SELECT p.prohibited_service_id, p.code, c.code AS category_code, p.name_content_key, p.description_content_key, p.status, p.created_at, p.updated_at
            FROM catalog.prohibited_services p LEFT JOIN catalog.categories c ON c.category_id = p.category_id WHERE p.code = ${code}`.execute(this.db)
        ).rows[0],
    );
    if (!row) throw new CatalogError('PROHIBITED_SERVICE_NOT_FOUND', 'the prohibited service is not registered', { code: String(code).slice(0, 64) });
    return prohibitedView(row);
  }

  // ================================================================== management: shared helpers
  private audit(
    trx: Trx,
    cid: string,
    a: {
      actor: string;
      action: string;
      categoryId?: string;
      serviceTypeId?: string;
      prohibitedServiceId?: string;
      marketId?: string;
      changes?: Record<string, unknown>;
      reason: string;
    },
  ) {
    return sql`INSERT INTO catalog.audit_events (actor, action, category_id, service_type_id, prohibited_service_id, market_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.categoryId ?? null}, ${a.serviceTypeId ?? null}, ${a.prohibitedServiceId ?? null}, ${a.marketId ?? null},
              ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason}, ${cid})`.execute(trx);
  }
  private event(trx: Trx, cid: string, type: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, actor: string) {
    return insertOutboxEvent(trx, { aggregateType, aggregateId, eventType: type, actorType: 'user', actorId: actor, correlationId: cid, payload });
  }
  private gateTestCode(code: string): void {
    if (code.startsWith(CATALOG_TEST_CODE_PREFIX) && this.d.allowTestKeys !== true)
      throw invalid('test codes are not allowed in this environment', { reason: 'TEST_KEY_NOT_ALLOWED', field: 'code' });
  }

  /** Locks ONE category by code with a bare statement and returns its id and status (CATEGORY_NOT_FOUND otherwise). */
  private async lockCategory(trx: Trx, code: string, lock: 'update' | 'share'): Promise<{ id: string; status: CatalogStatus }> {
    const locked =
      lock === 'update'
        ? await sql<Row>`SELECT category_id FROM catalog.categories WHERE code = ${code} FOR UPDATE`.execute(trx)
        : await sql<Row>`SELECT category_id FROM catalog.categories WHERE code = ${code} FOR SHARE`.execute(trx);
    const id = locked.rows[0]?.category_id as string | undefined;
    if (!id) throw new CatalogError('CATEGORY_NOT_FOUND', 'the category is not registered', { code: String(code).slice(0, 64) });
    const r = await sql<Row>`SELECT status FROM catalog.categories WHERE category_id = ${id}`.execute(trx);
    return { id, status: status(r.rows[0]!.status) };
  }
  private async lockServiceType(trx: Trx, code: string): Promise<{ id: string; categoryId: string; categoryCode: string; status: CatalogStatus }> {
    const locked = await sql<Row>`SELECT service_type_id FROM catalog.service_types WHERE code = ${code} FOR UPDATE`.execute(trx);
    const id = locked.rows[0]?.service_type_id as string | undefined;
    if (!id) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code: String(code).slice(0, 64) });
    const r =
      await sql<Row>`SELECT st.category_id, st.status, c.code AS category_code FROM catalog.service_types st JOIN catalog.categories c ON c.category_id = st.category_id
      WHERE st.service_type_id = ${id}`.execute(trx);
    const row = r.rows[0]!;
    return { id, categoryId: row.category_id as string, categoryCode: row.category_code as string, status: status(row.status) };
  }

  // ================================================================== management: categories
  async createCategory(input: unknown, actor: string): Promise<CategoryView> {
    const body = parseInput(CreateCategoryRequest, input);
    this.gateTestCode(body.code);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const inserted = await sql<Row>`INSERT INTO catalog.categories (code, icon_key, description_content_key)
        VALUES (${body.code}, ${body.iconKey ?? null}, ${body.withDescription ? categoryDescriptionKey(body.code) : null}) RETURNING category_id`.execute(trx);
      const categoryId = inserted.rows[0]!.category_id as string;
      await this.audit(trx, cid, {
        actor,
        action: 'CATEGORY_CREATED',
        categoryId,
        changes: { status: [null, 'DRAFT'], iconKey: [null, body.iconKey ?? null], withDescription: [null, body.withDescription === true] },
        reason: body.reason,
      });
    });
    return this.getCategory(body.code);
  }

  async updateCategory(code: string, input: unknown, actor: string): Promise<CategoryView> {
    const body = parseInput(UpdateCategoryRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const { id } = await this.lockCategory(trx, code, 'update');
      const before = (await sql<Row>`SELECT icon_key, description_content_key FROM catalog.categories WHERE category_id = ${id}`.execute(trx)).rows[0]!;
      const iconKey = body.iconKey === undefined ? ((before.icon_key as string | null) ?? null) : body.iconKey;
      const descriptionKey =
        body.withDescription === undefined
          ? ((before.description_content_key as string | null) ?? null)
          : body.withDescription
            ? categoryDescriptionKey(code)
            : null;
      const changes: Record<string, [unknown, unknown]> = {};
      if (iconKey !== ((before.icon_key as string | null) ?? null)) changes.iconKey = [before.icon_key ?? null, iconKey];
      if (descriptionKey !== ((before.description_content_key as string | null) ?? null))
        changes.withDescription = [before.description_content_key !== null, descriptionKey !== null];
      if (Object.keys(changes).length === 0) return false;
      await sql`UPDATE catalog.categories SET icon_key = ${iconKey}, description_content_key = ${descriptionKey} WHERE category_id = ${id}`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'CATEGORY_UPDATED', categoryId: id, changes, reason: body.reason });
      return true;
    });
    if (changed) await this.invalidate();
    return this.getCategory(code);
  }

  async setCategoryStatus(code: string, input: unknown, actor: string): Promise<CategoryView> {
    const body = parseInput(CatalogStatusRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const { id, status: from } = await this.lockCategory(trx, code, 'update');
      if (from === body.status) return false; // idempotent
      await sql`UPDATE catalog.categories SET status = ${body.status} WHERE category_id = ${id}`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'CATEGORY_STATUS_CHANGED', categoryId: id, changes: { status: [from, body.status] }, reason: body.reason });
      const payload: CategoryEventPayload = { categoryCode: code };
      if (body.status === 'ACTIVE') await this.event(trx, cid, CATALOG_EVENTS.categoryActivated, 'catalog_category', id, payload, actor);
      else if (from === 'ACTIVE') await this.event(trx, cid, CATALOG_EVENTS.categoryDeactivated, 'catalog_category', id, payload, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getCategory(code);
  }

  // ================================================================== management: service types
  async createServiceType(input: unknown, actor: string): Promise<ServiceTypeView> {
    const body = parseInput(CreateServiceTypeRequest, input);
    this.gateTestCode(body.code);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const category = await this.lockCategory(trx, body.categoryCode, 'share');
      const inserted = await sql<Row>`INSERT INTO catalog.service_types (category_id, code, description_content_key)
        VALUES (${category.id}, ${body.code}, ${body.withDescription ? serviceTypeDescriptionKey(body.code) : null}) RETURNING service_type_id`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'SERVICE_TYPE_CREATED',
        serviceTypeId: inserted.rows[0]!.service_type_id as string,
        changes: { status: [null, 'DRAFT'], categoryCode: [null, body.categoryCode], withDescription: [null, body.withDescription === true] },
        reason: body.reason,
      });
    });
    return this.getServiceType(body.code);
  }

  async updateServiceType(code: string, input: unknown, actor: string): Promise<ServiceTypeView> {
    const body = parseInput(UpdateServiceTypeRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const { id } = await this.lockServiceType(trx, code);
      const before = (await sql<Row>`SELECT description_content_key FROM catalog.service_types WHERE service_type_id = ${id}`.execute(trx)).rows[0]!;
      const descriptionKey = body.withDescription ? serviceTypeDescriptionKey(code) : null;
      if (descriptionKey === ((before.description_content_key as string | null) ?? null)) return false;
      await sql`UPDATE catalog.service_types SET description_content_key = ${descriptionKey} WHERE service_type_id = ${id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'SERVICE_TYPE_UPDATED',
        serviceTypeId: id,
        changes: { withDescription: [before.description_content_key !== null, descriptionKey !== null] },
        reason: body.reason,
      });
      return true;
    });
    if (changed) await this.invalidate();
    return this.getServiceType(code);
  }

  async setServiceTypeStatus(code: string, input: unknown, actor: string): Promise<ServiceTypeView> {
    const body = parseInput(CatalogStatusRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const { id, categoryCode, status: from } = await this.lockServiceType(trx, code);
      if (from === body.status) return false;
      await sql`UPDATE catalog.service_types SET status = ${body.status} WHERE service_type_id = ${id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'SERVICE_TYPE_STATUS_CHANGED',
        serviceTypeId: id,
        changes: { status: [from, body.status] },
        reason: body.reason,
      });
      const payload: ServiceTypeEventPayload = { serviceTypeCode: code, categoryCode };
      if (body.status === 'ACTIVE') await this.event(trx, cid, CATALOG_EVENTS.serviceTypeActivated, 'catalog_service_type', id, payload, actor);
      else if (from === 'ACTIVE') await this.event(trx, cid, CATALOG_EVENTS.serviceTypeDeactivated, 'catalog_service_type', id, payload, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getServiceType(code);
  }

  // ================================================================== management: prohibited services
  async createProhibitedService(input: unknown, actor: string): Promise<ProhibitedServiceView> {
    const body = parseInput(CreateProhibitedServiceRequest, input);
    this.gateTestCode(body.code);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const categoryId = body.categoryCode ? (await this.lockCategory(trx, body.categoryCode, 'share')).id : null;
      const inserted = await sql<Row>`INSERT INTO catalog.prohibited_services (category_id, code, description_content_key)
        VALUES (${categoryId}, ${body.code}, ${body.withDescription ? prohibitedServiceDescriptionKey(body.code) : null}) RETURNING prohibited_service_id`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'PROHIBITED_SERVICE_CREATED',
        prohibitedServiceId: inserted.rows[0]!.prohibited_service_id as string,
        changes: { status: [null, 'DRAFT'], categoryCode: [null, body.categoryCode ?? null], withDescription: [null, body.withDescription === true] },
        reason: body.reason,
      });
    });
    return this.getProhibitedService(body.code);
  }

  async setProhibitedServiceStatus(code: string, input: unknown, actor: string): Promise<ProhibitedServiceView> {
    const body = parseInput(CatalogStatusRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const locked = await sql<Row>`SELECT prohibited_service_id FROM catalog.prohibited_services WHERE code = ${code} FOR UPDATE`.execute(trx);
      const id = locked.rows[0]?.prohibited_service_id as string | undefined;
      if (!id) throw new CatalogError('PROHIBITED_SERVICE_NOT_FOUND', 'the prohibited service is not registered', { code: String(code).slice(0, 64) });
      const from = status((await sql<Row>`SELECT status FROM catalog.prohibited_services WHERE prohibited_service_id = ${id}`.execute(trx)).rows[0]!.status);
      if (from === body.status) return;
      await sql`UPDATE catalog.prohibited_services SET status = ${body.status} WHERE prohibited_service_id = ${id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'PROHIBITED_SERVICE_STATUS_CHANGED',
        prohibitedServiceId: id,
        changes: { status: [from, body.status] },
        reason: body.reason,
      });
    });
    return this.getProhibitedService(code);
  }

  // ================================================================== management: market availability
  /**
   * Sets whether a category is offered in a market and its position there. `displayOrder` is required when the row does not exist yet. Switching a category OFF in a market
   * first switches off the service types of that category enabled in the same market (audited and announced one by one), because a service type cannot be enabled without its
   * category. A repeat that changes nothing writes nothing. A market of any status can be prepared.
   */
  async setMarketCategoryAvailability(marketCode: string, categoryCode: string, input: unknown, actor: string): Promise<MarketAvailabilityDto> {
    const body = parseInput(SetMarketAvailabilityRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const result = await this.retryOnRace(() =>
      this.tx(async (trx) => {
        const marketId = await this.marketIdOf(trx, marketCode);
        const category = await this.lockCategory(trx, categoryCode, 'share');
        const lockedRow =
          await sql<Row>`SELECT 1 AS ok FROM catalog.market_categories WHERE market_id = ${marketId} AND category_id = ${category.id} FOR UPDATE`.execute(trx);
        const existing = lockedRow.rows[0]
          ? (
              await sql<Row>`SELECT enabled, display_order FROM catalog.market_categories WHERE market_id = ${marketId} AND category_id = ${category.id}`.execute(
                trx,
              )
            ).rows[0]
          : undefined;
        const alsoDisabled: string[] = [];
        let enabled = body.enabled;
        let displayOrder = body.displayOrder;
        if (!existing) {
          if (displayOrder === undefined)
            throw invalid('displayOrder is required when the category is not yet part of the market', {
              reason: 'DISPLAY_ORDER_REQUIRED',
              field: 'displayOrder',
            });
          await sql`INSERT INTO catalog.market_categories (market_id, category_id, enabled, display_order) VALUES (${marketId}, ${category.id}, ${enabled}, ${displayOrder})`.execute(
            trx,
          );
        } else {
          displayOrder = displayOrder ?? Number(existing.display_order);
          enabled = body.enabled;
          const wasEnabled = existing.enabled === true;
          if (wasEnabled === enabled && displayOrder === Number(existing.display_order))
            return { changed: false, marketId, dto: this.availabilityDto(marketCode, categoryCode, 'CATEGORY', enabled, displayOrder, []) };
          if (wasEnabled && !enabled)
            alsoDisabled.push(...(await this.disableServiceTypesOfCategory(trx, cid, marketId, marketCode, category.id, categoryCode, body.reason, actor)));
          await sql`UPDATE catalog.market_categories SET enabled = ${enabled}, display_order = ${displayOrder} WHERE market_id = ${marketId} AND category_id = ${category.id}`.execute(
            trx,
          );
        }
        await this.audit(trx, cid, {
          actor,
          action: 'MARKET_CATALOG_AVAILABILITY_CHANGED',
          marketId,
          categoryId: category.id,
          changes: {
            enabled: [existing ? existing.enabled === true : null, enabled],
            displayOrder: [existing ? Number(existing.display_order) : null, displayOrder],
          },
          reason: body.reason,
        });
        const payload: CatalogAvailabilityEventPayload = { marketCode, kind: 'CATEGORY', code: categoryCode, enabled };
        await this.event(trx, cid, CATALOG_EVENTS.availabilityChanged, 'catalog_market_availability', marketId, payload, actor);
        return { changed: true, marketId, dto: this.availabilityDto(marketCode, categoryCode, 'CATEGORY', enabled, displayOrder as number, alsoDisabled) };
      }),
    );
    if (result.changed) await this.invalidate();
    return result.dto;
  }

  /** Switches off, inside the caller's transaction, the service types of a category that are enabled in a market. Returns their codes (in code order). */
  private async disableServiceTypesOfCategory(
    trx: Trx,
    cid: string,
    marketId: string,
    marketCode: string,
    categoryId: string,
    categoryCode: string,
    reason: string,
    actor: string,
  ): Promise<string[]> {
    const rows = (
      await sql<Row>`SELECT mst.service_type_id, st.code, mst.display_order FROM catalog.market_service_types mst
        JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
       WHERE mst.market_id = ${marketId} AND st.category_id = ${categoryId} AND mst.enabled ORDER BY st.code COLLATE "C" FOR UPDATE OF mst`.execute(trx)
    ).rows;
    for (const r of rows) {
      await sql`UPDATE catalog.market_service_types SET enabled = false WHERE market_id = ${marketId} AND service_type_id = ${r.service_type_id as string}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'MARKET_CATALOG_AVAILABILITY_CHANGED',
        marketId,
        serviceTypeId: r.service_type_id as string,
        changes: { enabled: [true, false], displayOrder: [Number(r.display_order), Number(r.display_order)], becauseCategory: categoryCode },
        reason,
      });
      const payload: CatalogAvailabilityEventPayload = { marketCode, kind: 'SERVICE_TYPE', code: r.code as string, enabled: false };
      await this.event(trx, cid, CATALOG_EVENTS.availabilityChanged, 'catalog_market_availability', marketId, payload, actor);
    }
    return rows.map((r) => r.code as string);
  }

  /** Sets whether a service type is offered in a market and its position among the market's service types. Enabling needs the category enabled in the same market. */
  async setMarketServiceTypeAvailability(marketCode: string, serviceTypeCode: string, input: unknown, actor: string): Promise<MarketAvailabilityDto> {
    const body = parseInput(SetMarketAvailabilityRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const result = await this.retryOnRace(() =>
      this.tx(async (trx) => {
        const marketId = await this.marketIdOf(trx, marketCode);
        const found = await sql<Row>`SELECT service_type_id FROM catalog.service_types WHERE code = ${serviceTypeCode}`.execute(trx);
        const serviceTypeId = found.rows[0]?.service_type_id as string | undefined;
        if (!serviceTypeId)
          throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code: String(serviceTypeCode).slice(0, 64) });
        const lockedRow =
          await sql<Row>`SELECT 1 AS ok FROM catalog.market_service_types WHERE market_id = ${marketId} AND service_type_id = ${serviceTypeId} FOR UPDATE`.execute(
            trx,
          );
        const existing = lockedRow.rows[0]
          ? (
              await sql<Row>`SELECT enabled, display_order FROM catalog.market_service_types WHERE market_id = ${marketId} AND service_type_id = ${serviceTypeId}`.execute(
                trx,
              )
            ).rows[0]
          : undefined;
        let displayOrder = body.displayOrder;
        if (!existing) {
          if (displayOrder === undefined)
            throw invalid('displayOrder is required when the service type is not yet part of the market', {
              reason: 'DISPLAY_ORDER_REQUIRED',
              field: 'displayOrder',
            });
          await sql`INSERT INTO catalog.market_service_types (market_id, service_type_id, enabled, display_order) VALUES (${marketId}, ${serviceTypeId}, ${body.enabled}, ${displayOrder})`.execute(
            trx,
          );
        } else {
          displayOrder = displayOrder ?? Number(existing.display_order);
          if ((existing.enabled === true) === body.enabled && displayOrder === Number(existing.display_order))
            return { changed: false, dto: this.availabilityDto(marketCode, serviceTypeCode, 'SERVICE_TYPE', body.enabled, displayOrder, []) };
          await sql`UPDATE catalog.market_service_types SET enabled = ${body.enabled}, display_order = ${displayOrder} WHERE market_id = ${marketId} AND service_type_id = ${serviceTypeId}`.execute(
            trx,
          );
        }
        await this.audit(trx, cid, {
          actor,
          action: 'MARKET_CATALOG_AVAILABILITY_CHANGED',
          marketId,
          serviceTypeId,
          changes: {
            enabled: [existing ? existing.enabled === true : null, body.enabled],
            displayOrder: [existing ? Number(existing.display_order) : null, displayOrder],
          },
          reason: body.reason,
        });
        const payload: CatalogAvailabilityEventPayload = { marketCode, kind: 'SERVICE_TYPE', code: serviceTypeCode, enabled: body.enabled };
        await this.event(trx, cid, CATALOG_EVENTS.availabilityChanged, 'catalog_market_availability', marketId, payload, actor);
        return { changed: true, dto: this.availabilityDto(marketCode, serviceTypeCode, 'SERVICE_TYPE', body.enabled, displayOrder as number, []) };
      }),
    );
    if (result.changed) await this.invalidate();
    return result.dto;
  }

  private availabilityDto(
    marketCode: string,
    code: string,
    kind: 'CATEGORY' | 'SERVICE_TYPE',
    enabled: boolean,
    displayOrder: number,
    alsoDisabled: string[],
  ): MarketAvailabilityDto {
    return { marketCode, code, kind, enabled, displayOrder, alsoDisabled };
  }
}
