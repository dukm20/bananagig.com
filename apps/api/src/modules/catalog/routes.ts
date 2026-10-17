// Catalogue API (docs/engineering/CATALOG.md): the PLATFORM-OWNED taxonomy of categories and service types, their availability and order per market, and the prohibited-service
// list. The reads are PUBLIC routes with visibility rules: anonymous callers (and callers without the admin context plus catalog-read or catalog-write) get the PUBLIC view of
// a PUBLIC market: ACTIVE items enabled in it, in the market's order, with resolved names and descriptions, stable ids and codes, and nothing else. The market is REQUIRED for
// them; a market that is not public (unknown, PLANNED, INACTIVE, outside its window) is a 404, exactly like the geography reads. A caller with the admin context plus
// catalog-read (catalog-write implies it) gets every status, the disabled availability rows and the management-only fields, and the market is optional. Management mutations
// need the admin context plus catalog-write, a reason, and write an immutable audit row and (for activation and availability) an outbox event in the same transaction.
// Public reads answer with `Vary: Authorization` (the body depends on the optional token). Routes are thin; all rules live in @bananagig/catalog.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CatalogCode,
  CatalogCategoryListResponse,
  CatalogCategoryResponse,
  CatalogReadQuery,
  CatalogServiceTypeListResponse,
  CatalogServiceTypeQuery,
  CatalogServiceTypeResponse,
  CatalogStatusRequest,
  CreateCategoryRequest,
  CreateProhibitedServiceRequest,
  CreateServiceTypeRequest,
  MarketAvailabilityResponse,
  MarketCode,
  ProhibitedServiceListResponse,
  ProhibitedServiceResponse,
  SetMarketAvailabilityRequest,
  UpdateCategoryRequest,
  UpdateServiceTypeRequest,
} from '@bananagig/contracts';
import {
  CatalogError,
  type CatalogService,
  type GigTemplateService,
  type CategoryView,
  type ProhibitedServiceView,
  type ServiceTypeView,
} from '@bananagig/catalog';
import { log } from '@bananagig/observability';
import type { ContentService } from '@bananagig/content';
import { AppError } from '../../errors';
import { hasCatalogPermission, optionalAuthenticated, requireCatalogPermission } from '../../plugins/auth';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { schemaOf } from '../../schema';
import { categoryDto, prohibitedServiceDto, serviceTypeDto, toAppError, type Texts } from './dto';
import { bearer, dropNull, failures, meta, params, publicFailures, requireMarket, run } from './common';
import { registerGigTemplateRoutes } from './gig-template-routes';

const codeParams = params('code', CatalogCode);
const marketCodeParams = {
  type: 'object',
  properties: { market: schemaOf(MarketCode), code: schemaOf(CatalogCode) },
  required: ['market', 'code'],
  additionalProperties: false,
};

export interface CatalogRouteDeps {
  catalog: CatalogService;
  /** The Gig Templates (CAT-002); their routes are registered when provided. */
  gigTemplates?: GigTemplateService;
  content: ContentService;
}

export async function catalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): Promise<void> {
  const svc = deps.catalog;
  const content = deps.content;
  const tags = ['catalog'];
  const actor = (req: FastifyRequest): string => req.principal!.subject;
  /** Management view: every status and the management-only fields. Only the admin context with catalog-read or catalog-write; everyone else is anonymous-equivalent. */
  const privileged = (req: FastifyRequest): boolean => hasCatalogPermission(req.principal, 'read');
  const code = (req: FastifyRequest): string => (req.params as { code: string }).code;
  // The management view (every status, content keys, timestamps), the prohibited list and every mutation response are never stored by a shared cache; the public view keeps the default.
  app.addHook('onSend', async (req, reply) => {
    if (req.method !== 'GET' || privileged(req) || (req.url.split(/[?#]/)[0] ?? '').toLowerCase().includes('/prohibited-services')) {
      void reply.header('cache-control', 'private, no-store');
    }
  });

  /** Names and descriptions in ONE batch through the content registry (locale and market context; the registry applies its own fallback chain and cache). */
  async function textsFor(keys: readonly string[], locale: string | undefined, marketCode: string | undefined, management: boolean): Promise<Texts> {
    const unique = [...new Set(keys)];
    if (unique.length === 0 || locale === undefined) return { get: () => undefined };
    const r = await content
      .resolveRendered(unique, { locale, context: marketCode ? { market: marketCode } : undefined, includeInternal: management ? undefined : false })
      .catch((err: unknown) => {
        // The content registry could not answer (its own last-known-good policy is exhausted). A PUBLIC read must not pretend that the catalogue is empty or that an existing
        // item does not exist: it is a 503. The management view degrades to content keys so an administrator can still work.
        if (!management) toAppError(new CatalogError('UNAVAILABLE', 'the content registry is unavailable'));
        log('warn', 'catalogue text could not be resolved', { error: err instanceof Error ? err.name : 'error' });
        return undefined;
      });
    const out = new Map<string, string>();
    for (const [k, v] of r?.items ?? []) if (v.format === 'text') out.set(k, v.value);
    return { get: (k) => out.get(k) };
  }
  /** The locale of the text: the one asked for, else the default locale of the public market, else the platform default locale. */
  async function localeFor(requested: string | undefined, marketDefault: string | undefined): Promise<string | undefined> {
    if (requested) return requested;
    if (marketDefault) return marketDefault;
    const locales = await content.listLocales({ activeOnly: true }).catch(() => []);
    return locales.find((l) => l.isPlatformDefault)?.locale;
  }
  /** Management with a market: the locale the market's customers get (its default), so a preview in an es-US market is in Spanish; without a market, the platform default. */
  const managementLocale = async (requested: string | undefined, marketCode: string | undefined): Promise<string | undefined> =>
    localeFor(requested, marketCode === undefined ? undefined : await run(() => svc.getMarketDefaultLocale(marketCode)));
  const keysOf = (v: CategoryView | ServiceTypeView | ProhibitedServiceView): string[] => [
    v.nameContentKey,
    ...(v.descriptionContentKey ? [v.descriptionContentKey] : []),
  ];

  // ------------------------------------------------------------------ reads (public view of a public market; management view for catalog-read)
  app.get(
    '/categories',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listCatalogCategories',
        summary:
          "List categories. Public callers: the ACTIVE categories enabled in a PUBLIC market (query `market` is required; a market that is not ACTIVE and in effect is a 404), in the market's display order, with the resolved name and description (query `locale`, default: the market's default locale). Callers with catalog-read (or catalog-write): every status; with `market` the availability and order in that market (any market status), without it the global list ordered by code",
        tags,
        security: [],
        querystring: schemaOf(CatalogReadQuery),
        response: { 200: schemaOf(CatalogCategoryListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string };
      if (management) {
        const views = await run(() => svc.listCategories({ marketCode: q.market }));
        const texts = await textsFor(views.flatMap(keysOf), await managementLocale(q.locale, q.market), q.market, true);
        return { data: dropNull(views.map((v) => categoryDto(v, texts, true))), meta: meta(req) };
      }
      const r = await run(() => svc.listCategoriesForMarket(requireMarket(q.market)));
      const texts = await textsFor(r.categories.flatMap(keysOf), await localeFor(q.locale, r.market.defaultLocale), r.market.code, false);
      return { data: dropNull(r.categories.map((v) => categoryDto(v, texts, false))), meta: meta(req) };
    },
  );

  app.get(
    '/categories/:code',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getCatalogCategory',
        summary:
          'One category by its stable code. Public callers: only while it is ACTIVE and enabled in the PUBLIC market named by `market` (otherwise a 404); callers with catalog-read: any status',
        tags,
        security: [],
        params: codeParams,
        querystring: schemaOf(CatalogReadQuery),
        response: { 200: schemaOf(CatalogCategoryResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string };
      let view: CategoryView;
      let marketDefault: string | undefined;
      let marketCode = q.market;
      if (management) {
        view = await run(() => svc.getCategory(code(req), { marketCode: q.market }));
        if (q.market !== undefined) marketDefault = await run(() => svc.getMarketDefaultLocale(q.market as string));
      } else {
        const r = await run(() => svc.getCategoryForMarket(requireMarket(q.market), code(req)));
        view = r.category;
        marketDefault = r.market.defaultLocale;
        marketCode = r.market.code;
      }
      const texts = await textsFor(keysOf(view), await localeFor(q.locale, marketDefault), marketCode, management);
      const dto = categoryDto(view, texts, management);
      if (!dto) throw new AppError('NOT_FOUND', 'CATALOG_CATEGORY_NOT_FOUND', 'The category is not available', { code: view.code });
      return { data: dto, meta: meta(req) };
    },
  );

  app.get(
    '/service-types',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listCatalogServiceTypes',
        summary:
          "List service types, optionally of one category (query `category`). Public callers: the ACTIVE service types enabled in a PUBLIC market (query `market` is required) under an ACTIVE category that is enabled there, in the market's display order, with resolved name and description. Callers with catalog-read (or catalog-write): every status; with `market` the availability and order in that market, without it the global list",
        tags,
        security: [],
        querystring: schemaOf(CatalogServiceTypeQuery),
        response: { 200: schemaOf(CatalogServiceTypeListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string; category?: string };
      if (management) {
        const views = await run(() => svc.listServiceTypes({ marketCode: q.market, categoryCode: q.category }));
        const texts = await textsFor(views.flatMap(keysOf), await managementLocale(q.locale, q.market), q.market, true);
        return { data: dropNull(views.map((v) => serviceTypeDto(v, texts, true))), meta: meta(req) };
      }
      const r = await run(() => svc.listServiceTypesForMarket(requireMarket(q.market), { categoryCode: q.category }));
      const texts = await textsFor(r.serviceTypes.flatMap(keysOf), await localeFor(q.locale, r.market.defaultLocale), r.market.code, false);
      return { data: dropNull(r.serviceTypes.map((v) => serviceTypeDto(v, texts, false))), meta: meta(req) };
    },
  );

  app.get(
    '/service-types/:code',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getCatalogServiceType',
        summary:
          'One service type by its stable code. Public callers: only while it is ACTIVE and enabled in the PUBLIC market named by `market` under an enabled ACTIVE category (otherwise a 404); callers with catalog-read: any status',
        tags,
        security: [],
        params: codeParams,
        querystring: schemaOf(CatalogReadQuery),
        response: { 200: schemaOf(CatalogServiceTypeResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string };
      let view: ServiceTypeView;
      let marketDefault: string | undefined;
      let marketCode = q.market;
      if (management) {
        view = await run(() => svc.getServiceType(code(req), { marketCode: q.market }));
        if (q.market !== undefined) marketDefault = await run(() => svc.getMarketDefaultLocale(q.market as string));
      } else {
        const r = await run(() => svc.getServiceTypeForMarket(requireMarket(q.market), code(req)));
        view = r.serviceType;
        marketDefault = r.market.defaultLocale;
        marketCode = r.market.code;
      }
      const texts = await textsFor(keysOf(view), await localeFor(q.locale, marketDefault), marketCode, management);
      const dto = serviceTypeDto(view, texts, management);
      if (!dto) throw new AppError('NOT_FOUND', 'CATALOG_SERVICE_TYPE_NOT_FOUND', 'The service type is not available', { code: view.code });
      return { data: dto, meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ management reads: the prohibited-service list (never public)
  app.get(
    '/prohibited-services',
    {
      preValidation: requireCatalogPermission('read'),
      schema: {
        operationId: 'listCatalogProhibitedServices',
        summary: 'List the platform-level prohibited services (every status). Management only: it is never part of the public catalogue',
        tags,
        security: bearer,
        response: { 200: schemaOf(ProhibitedServiceListResponse), ...failures },
      },
    },
    async (req) => {
      const views = await run(() => svc.listProhibitedServices());
      const texts = await textsFor(views.flatMap(keysOf), await localeFor(undefined, undefined), undefined, true);
      return { data: views.map((v) => prohibitedServiceDto(v, texts)), meta: meta(req) };
    },
  );

  app.get(
    '/prohibited-services/:code',
    {
      preValidation: requireCatalogPermission('read'),
      schema: {
        operationId: 'getCatalogProhibitedService',
        summary: 'One prohibited service by its code (management only)',
        tags,
        security: bearer,
        params: codeParams,
        response: { 200: schemaOf(ProhibitedServiceResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.getProhibitedService(code(req)));
      const texts = await textsFor(keysOf(view), await localeFor(undefined, undefined), undefined, true);
      return { data: prohibitedServiceDto(view, texts), meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ management mutations (catalog-write, a reason, an audit row)
  const managementTexts = async (views: (CategoryView | ServiceTypeView | ProhibitedServiceView)[]) =>
    textsFor(views.flatMap(keysOf), await localeFor(undefined, undefined), undefined, true);

  app.post(
    '/categories',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CreateCategoryRequest)],
      schema: {
        operationId: 'createCatalogCategory',
        summary:
          'Create a category as DRAFT (nothing is public until an administrator activates it and enables it in a market). The code is the immutable identity (lower-case snake_case, never reused); its name content entry catalog.category.<code>.name must already exist in the content registry',
        tags,
        security: bearer,
        body: schemaOf(CreateCategoryRequest),
        response: { 201: schemaOf(CatalogCategoryResponse), ...failures },
      },
    },
    async (req, reply) => {
      const view = await run(() => svc.createCategory(parse(CreateCategoryRequest, req.body), actor(req)));
      return reply.status(201).send({ data: categoryDto(view, await managementTexts([view]), true), meta: meta(req) });
    },
  );

  app.patch(
    '/categories/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(UpdateCategoryRequest)],
      schema: {
        operationId: 'updateCatalogCategory',
        summary:
          'Change the metadata of a category (icon name; whether its description content entry is linked). The code and the status are not editable here. Idempotent: an unchanged request writes nothing',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(UpdateCategoryRequest),
        response: { 200: schemaOf(CatalogCategoryResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.updateCategory(code(req), parse(UpdateCategoryRequest, req.body), actor(req)));
      return { data: categoryDto(view, await managementTexts([view]), true), meta: meta(req) };
    },
  );

  app.put(
    '/categories/:code/status',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CatalogStatusRequest)],
      schema: {
        operationId: 'setCatalogCategoryStatus',
        summary:
          'Move a category to ACTIVE, INACTIVE (a pause) or RETIRED (terminal: blocks new use, keeps the row, the code and the history). DRAFT is never a target. A category cannot leave ACTIVE while it has ACTIVE service types and cannot be retired while it has service types that are not RETIRED (409). Idempotent for the current status',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(CatalogStatusRequest),
        response: { 200: schemaOf(CatalogCategoryResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.setCategoryStatus(code(req), parse(CatalogStatusRequest, req.body), actor(req)));
      return { data: categoryDto(view, await managementTexts([view]), true), meta: meta(req) };
    },
  );

  app.post(
    '/service-types',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CreateServiceTypeRequest)],
      schema: {
        operationId: 'createCatalogServiceType',
        summary:
          'Create a service type as DRAFT under exactly one category (the category never changes afterwards; none can be created under a RETIRED category). The code is the immutable identity, unique across all service types; its name content entry catalog.service_type.<code>.name must already exist',
        tags,
        security: bearer,
        body: schemaOf(CreateServiceTypeRequest),
        response: { 201: schemaOf(CatalogServiceTypeResponse), ...failures },
      },
    },
    async (req, reply) => {
      const view = await run(() => svc.createServiceType(parse(CreateServiceTypeRequest, req.body), actor(req)));
      return reply.status(201).send({ data: serviceTypeDto(view, await managementTexts([view]), true), meta: meta(req) });
    },
  );

  app.patch(
    '/service-types/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(UpdateServiceTypeRequest)],
      schema: {
        operationId: 'updateCatalogServiceType',
        summary: 'Link or unlink the description content entry of a service type. Idempotent: an unchanged request writes nothing',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(UpdateServiceTypeRequest),
        response: { 200: schemaOf(CatalogServiceTypeResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.updateServiceType(code(req), parse(UpdateServiceTypeRequest, req.body), actor(req)));
      return { data: serviceTypeDto(view, await managementTexts([view]), true), meta: meta(req) };
    },
  );

  app.put(
    '/service-types/:code/status',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CatalogStatusRequest)],
      schema: {
        operationId: 'setCatalogServiceTypeStatus',
        summary: 'Move a service type to ACTIVE (only while its category is ACTIVE), INACTIVE or RETIRED (terminal). Idempotent for the current status',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(CatalogStatusRequest),
        response: { 200: schemaOf(CatalogServiceTypeResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.setServiceTypeStatus(code(req), parse(CatalogStatusRequest, req.body), actor(req)));
      return { data: serviceTypeDto(view, await managementTexts([view]), true), meta: meta(req) };
    },
  );

  app.post(
    '/prohibited-services',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CreateProhibitedServiceRequest)],
      schema: {
        operationId: 'createCatalogProhibitedService',
        summary:
          'Create a platform-level prohibited service as DRAFT (a rule counts only while ACTIVE). Flat reference data: no moderation workflow exists. Its name content entry catalog.prohibited_service.<code>.name must already exist',
        tags,
        security: bearer,
        body: schemaOf(CreateProhibitedServiceRequest),
        response: { 201: schemaOf(ProhibitedServiceResponse), ...failures },
      },
    },
    async (req, reply) => {
      const view = await run(() => svc.createProhibitedService(parse(CreateProhibitedServiceRequest, req.body), actor(req)));
      return reply.status(201).send({ data: prohibitedServiceDto(view, await managementTexts([view])), meta: meta(req) });
    },
  );

  app.put(
    '/prohibited-services/:code/status',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CatalogStatusRequest)],
      schema: {
        operationId: 'setCatalogProhibitedServiceStatus',
        summary: 'Move a prohibited service to ACTIVE, INACTIVE or RETIRED (terminal). Idempotent for the current status',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(CatalogStatusRequest),
        response: { 200: schemaOf(ProhibitedServiceResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => svc.setProhibitedServiceStatus(code(req), parse(CatalogStatusRequest, req.body), actor(req)));
      return { data: prohibitedServiceDto(view, await managementTexts([view])), meta: meta(req) };
    },
  );

  app.put(
    '/markets/:market/categories/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(SetMarketAvailabilityRequest)],
      schema: {
        operationId: 'setCatalogMarketCategoryAvailability',
        summary:
          "Offer or withdraw a category in a market and set its position in that market's menu (`displayOrder`, required when the category is not yet part of the market; unique per market). The market can be of any status: a market can be prepared before launch, but nothing is public unless the market is ACTIVE and in effect and the category is ACTIVE. Switching a category off also switches off its service types in that market (listed in `alsoDisabled`). Idempotent",
        tags,
        security: bearer,
        params: marketCodeParams,
        body: schemaOf(SetMarketAvailabilityRequest),
        response: { 200: schemaOf(MarketAvailabilityResponse), ...failures },
      },
    },
    async (req) => {
      const p = req.params as { market: string; code: string };
      const data = await run(() => svc.setMarketCategoryAvailability(p.market, p.code, parse(SetMarketAvailabilityRequest, req.body), actor(req)));
      return { data, meta: meta(req) };
    },
  );

  app.put(
    '/markets/:market/service-types/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(SetMarketAvailabilityRequest)],
      schema: {
        operationId: 'setCatalogMarketServiceTypeAvailability',
        summary:
          "Offer or withdraw a service type in a market and set its position among the market's service types. Enabling needs the service type's category enabled in the same market and the service type not RETIRED (409). Idempotent",
        tags,
        security: bearer,
        params: marketCodeParams,
        body: schemaOf(SetMarketAvailabilityRequest),
        response: { 200: schemaOf(MarketAvailabilityResponse), ...failures },
      },
    },
    async (req) => {
      const p = req.params as { market: string; code: string };
      const data = await run(() => svc.setMarketServiceTypeAvailability(p.market, p.code, parse(SetMarketAvailabilityRequest, req.body), actor(req)));
      return { data, meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ Gig Templates (CAT-002): same context, so the no-store hook above covers them too
  if (deps.gigTemplates)
    await registerGigTemplateRoutes(app, {
      gigTemplates: deps.gigTemplates,
      catalog: svc,
      helpers: { privileged, actor, textsFor, localeFor, managementLocale },
    });
}
