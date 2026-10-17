// Gig Template API (docs/engineering/GIG_TEMPLATES.md): the PLATFORM-OWNED, versioned structure a provider later builds a Gig from. Registered by the catalogue plugin, so it shares its
// visibility model: the reads are PUBLIC routes with the same rules as the taxonomy (anonymous callers and callers without the admin context plus catalog-read or catalog-write get the
// PUBLIC view of a PUBLIC market: ACTIVE templates enabled in it, under a service type that is public there, with their ACTIVE version, resolved text and safe structural metadata;
// privileged callers get every status, the revision and the content keys). The version read, every mutation and the market availability are management only. Management mutations need
// the admin context plus catalog-write, a reason, and write an immutable audit row (and, for activation, retirement, publication and availability, an outbox event) in the same
// transaction. Routes are thin; all rules live in @bananagig/catalog.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CatalogCode,
  CatalogReadQuery,
  CatalogStatusRequest,
  CreateGigTemplateRequest,
  CreateGigTemplateVersionRequest,
  GigTemplateListQuery,
  GigTemplateListResponse,
  GigTemplateMarketAvailabilityResponse,
  GigTemplateResponse,
  GigTemplateVersionResponse,
  GigTemplateVersionRetireRequest,
  MarketCode,
  PublishGigTemplateVersionRequest,
  ReplaceGigTemplateDraftRequest,
  SetMarketGigTemplateAvailabilityRequest,
  UpdateGigTemplateRequest,
} from '@bananagig/contracts';
import type { CatalogService, GigTemplateService, GigTemplateView } from '@bananagig/catalog';
import { AppError } from '../../errors';
import { optionalAuthenticated, requireCatalogPermission } from '../../plugins/auth';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { strictIntegerParams, integerParamSchema } from '../../plugins/strict-params';
import { schemaOf } from '../../schema';
import { bearer, dropNull, failures, meta, params, publicFailures, requireMarket, run, type CatalogRouteHelpers } from './common';
import { gigTemplateDetailDto, gigTemplateListItemDto, templateKeys, versionDto, versionKeys } from './gig-template-dto';

export interface GigTemplateRouteDeps {
  gigTemplates: GigTemplateService;
  catalog: CatalogService;
  helpers: CatalogRouteHelpers;
}

const codeParams = params('code', CatalogCode);
/** A version number in a path: canonical base-10 text, 1 to the largest 32-bit integer (the same bounds as the contract GigTemplateVersionNumber). */
const VERSION_BOUNDS = { min: 1, max: 2_147_483_647 };
const versionParams = {
  type: 'object',
  properties: { code: schemaOf(CatalogCode), version: integerParamSchema(VERSION_BOUNDS) },
  required: ['code', 'version'],
  additionalProperties: false,
};
const marketCodeParams = {
  type: 'object',
  properties: { market: schemaOf(MarketCode), code: schemaOf(CatalogCode) },
  required: ['market', 'code'],
  additionalProperties: false,
};

export async function registerGigTemplateRoutes(app: FastifyInstance, deps: GigTemplateRouteDeps): Promise<void> {
  const gt = deps.gigTemplates;
  const catalog = deps.catalog;
  const { privileged, actor, textsFor, localeFor, managementLocale } = deps.helpers;
  const tags = ['gig-templates'];
  const code = (req: FastifyRequest): string => (req.params as { code: string }).code;
  const versionNumber = (req: FastifyRequest): number => Number((req.params as { version: number | string }).version);
  const detailKeys = (t: GigTemplateView): string[] => [...templateKeys(t, true), ...versionKeys(t.activeVersion)];
  /** Mutation responses show the management view in the platform default locale. */
  const managementTexts = async (keys: readonly string[]) => textsFor(keys, await localeFor(undefined, undefined), undefined, true);

  // ------------------------------------------------------------------ reads (public view of a public market; management view for catalog-read)
  app.get(
    '/gig-templates',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGigTemplates',
        summary:
          "List Gig Templates, optionally of one service type (query `serviceType`). Public callers: the ACTIVE templates enabled in a PUBLIC market (query `market` is required) under a service type that is public there, in the market's order, each with the summary of its ACTIVE version, resolved name and description (query `locale`, default: the market's default locale). Callers with catalog-read: every status, with `market` the availability and order in that market (any market status)",
        tags,
        security: [],
        querystring: schemaOf(GigTemplateListQuery),
        response: { 200: schemaOf(GigTemplateListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string; serviceType?: string };
      if (management) {
        const views = await run(() => gt.listGigTemplates({ serviceTypeCode: q.serviceType, marketCode: q.market }));
        const texts = await textsFor(
          views.flatMap((t) => templateKeys(t, false)),
          await managementLocale(q.locale, q.market),
          q.market,
          true,
        );
        return { data: dropNull(views.map((t) => gigTemplateListItemDto(t, texts, true))), meta: meta(req) };
      }
      const r = await run(() => gt.listGigTemplatesForMarket(requireMarket(q.market), { serviceTypeCode: q.serviceType }));
      const texts = await textsFor(
        r.templates.flatMap((t) => templateKeys(t, false)),
        await localeFor(q.locale, r.market.defaultLocale),
        r.market.code,
        false,
      );
      return { data: dropNull(r.templates.map((t) => gigTemplateListItemDto(t, texts, false))), meta: meta(req) };
    },
  );

  app.get(
    '/gig-templates/:code',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getGigTemplate',
        summary:
          'One Gig Template by its stable code with the full structure of its ACTIVE version: typed fields (fixed, configurable or required for the provider), duration guidance, allowed pricing models and service-area modes, requirement hooks, resolved copy. Public callers: only while it is ACTIVE and enabled in the PUBLIC market named by `market` under a public service type (otherwise a 404). Callers with catalog-read: any status, plus every version summary',
        tags,
        security: [],
        params: codeParams,
        querystring: schemaOf(CatalogReadQuery),
        response: { 200: schemaOf(GigTemplateResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string };
      let view: GigTemplateView;
      let marketDefault: string | undefined;
      let marketCode = q.market;
      if (management) {
        view = await run(() => gt.getGigTemplate(code(req), { marketCode: q.market }));
        if (q.market !== undefined) marketDefault = await run(() => catalog.getMarketDefaultLocale(q.market as string));
      } else {
        const r = await run(() => gt.getGigTemplateForMarket(requireMarket(q.market), code(req)));
        view = r.template;
        marketDefault = r.market.defaultLocale;
        marketCode = r.market.code;
      }
      const texts = await textsFor(detailKeys(view), await localeFor(q.locale, marketDefault), marketCode, management);
      const dto = gigTemplateDetailDto(view, texts, management);
      if (!dto) throw new AppError('NOT_FOUND', 'CATALOG_GIG_TEMPLATE_NOT_FOUND', 'The Gig Template is not available', { code: view.code });
      return { data: dto, meta: meta(req) };
    },
  );

  app.get(
    '/service-types/:code/gig-templates',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listServiceTypeGigTemplates',
        summary:
          'The Gig Templates of ONE service type. Public callers: only while the service type is ACTIVE and public in the PUBLIC market named by `market` (otherwise a 404), the ACTIVE templates enabled there. Callers with catalog-read: every template of the service type, any status',
        tags,
        security: [],
        params: codeParams,
        querystring: schemaOf(CatalogReadQuery),
        response: { 200: schemaOf(GigTemplateListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const q = req.query as { market?: string; locale?: string };
      if (management) {
        await run(() => catalog.getServiceType(code(req)));
        const views = await run(() => gt.listGigTemplates({ serviceTypeCode: code(req), marketCode: q.market }));
        const texts = await textsFor(
          views.flatMap((t) => templateKeys(t, false)),
          await managementLocale(q.locale, q.market),
          q.market,
          true,
        );
        return { data: dropNull(views.map((t) => gigTemplateListItemDto(t, texts, true))), meta: meta(req) };
      }
      const market = requireMarket(q.market);
      await run(() => catalog.getServiceTypeForMarket(market, code(req)));
      const r = await run(() => gt.listGigTemplatesForMarket(market, { serviceTypeCode: code(req) }));
      const texts = await textsFor(
        r.templates.flatMap((t) => templateKeys(t, false)),
        await localeFor(q.locale, r.market.defaultLocale),
        r.market.code,
        false,
      );
      return { data: dropNull(r.templates.map((t) => gigTemplateListItemDto(t, texts, false))), meta: meta(req) };
    },
  );

  app.get(
    '/gig-templates/:code/versions/:version',
    {
      preValidation: [requireCatalogPermission('read'), strictIntegerParams({ version: VERSION_BOUNDS })],
      schema: {
        operationId: 'getGigTemplateVersion',
        summary:
          'The full definition of ONE version of a Gig Template (any status, including the DRAFT being edited), with the revision, the content keys and the requirement hooks. Management only',
        tags,
        security: bearer,
        params: versionParams,
        response: { 200: schemaOf(GigTemplateVersionResponse), ...failures },
      },
    },
    async (req) => {
      const v = await run(() => gt.getGigTemplateVersion(code(req), versionNumber(req)));
      return { data: versionDto(v, await managementTexts(versionKeys(v)), true), meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ management mutations (catalog-write, a reason, an audit row)
  const templateResponse = async (view: GigTemplateView) => gigTemplateDetailDto(view, await managementTexts(detailKeys(view)), true);

  app.post(
    '/gig-templates',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CreateGigTemplateRequest)],
      schema: {
        operationId: 'createGigTemplate',
        summary:
          'Create a Gig Template as DRAFT under a service type (nothing is public until it has a published version, is ACTIVE and is enabled in a market). The code is the immutable identity (lower-case snake_case, never reused); the content entry catalog.gig_template.<code>.name must already exist, and so must the description and instructions entries when linked',
        tags,
        security: bearer,
        body: schemaOf(CreateGigTemplateRequest),
        response: { 201: schemaOf(GigTemplateResponse), ...failures },
      },
    },
    async (req, reply) => {
      const view = await run(() => gt.createGigTemplate(parse(CreateGigTemplateRequest, req.body), actor(req)));
      return reply.status(201).send({ data: await templateResponse(view), meta: meta(req) });
    },
  );

  app.patch(
    '/gig-templates/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(UpdateGigTemplateRequest)],
      schema: {
        operationId: 'updateGigTemplate',
        summary:
          'Change the metadata of a Gig Template: whether its description and instructions content entries are linked. The code, the service type and the status are not editable here. Idempotent: an unchanged request writes nothing',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(UpdateGigTemplateRequest),
        response: { 200: schemaOf(GigTemplateResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => gt.updateGigTemplate(code(req), parse(UpdateGigTemplateRequest, req.body), actor(req)));
      return { data: await templateResponse(view), meta: meta(req) };
    },
  );

  app.put(
    '/gig-templates/:code/status',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CatalogStatusRequest)],
      schema: {
        operationId: 'setGigTemplateStatus',
        summary:
          'Move a Gig Template to ACTIVE (needs an ACTIVE service type), INACTIVE (a pause: nothing new is built from it) or RETIRED (terminal: closes the ACTIVE version, discards an open draft, keeps every version and the code). DRAFT is never a target. Idempotent',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(CatalogStatusRequest),
        response: { 200: schemaOf(GigTemplateResponse), ...failures },
      },
    },
    async (req) => {
      const view = await run(() => gt.setGigTemplateStatus(code(req), parse(CatalogStatusRequest, req.body), actor(req)));
      return { data: await templateResponse(view), meta: meta(req) };
    },
  );

  app.post(
    '/gig-templates/:code/versions',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(CreateGigTemplateVersionRequest)],
      schema: {
        operationId: 'createGigTemplateVersion',
        summary:
          'Create the next DRAFT version (highest number + 1), empty or copied from an existing version (`copyFromVersion`). A template has at most one DRAFT at a time (409 DRAFT_EXISTS) and a RETIRED template accepts none',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(CreateGigTemplateVersionRequest),
        response: { 201: schemaOf(GigTemplateVersionResponse), ...failures },
      },
    },
    async (req, reply) => {
      const v = await run(() => gt.createGigTemplateVersion(code(req), parse(CreateGigTemplateVersionRequest, req.body), actor(req)));
      return reply.status(201).send({ data: versionDto(v, await managementTexts(versionKeys(v)), true), meta: meta(req) });
    },
  );

  app.put(
    '/gig-templates/:code/versions/:version',
    {
      preValidation: [requireCatalogPermission('write'), strictIntegerParams({ version: VERSION_BOUNDS }), strictBody(ReplaceGigTemplateDraftRequest)],
      schema: {
        operationId: 'replaceGigTemplateDraft',
        summary:
          'Replace the WHOLE definition of the DRAFT in one atomic change: duration guidance, allowed pricing models and area modes, typed fields (with options) and requirement hooks. `expectedRevision` is the revision last read; a different one is 409 STALE_DRAFT. The content entries of every label, help, default text and option must already exist. A definition equal to the stored one changes nothing. A published version is frozen (409)',
        tags,
        security: bearer,
        params: versionParams,
        body: schemaOf(ReplaceGigTemplateDraftRequest),
        response: { 200: schemaOf(GigTemplateVersionResponse), ...failures },
      },
    },
    async (req) => {
      const v = await run(() => gt.replaceGigTemplateDraft(code(req), versionNumber(req), parse(ReplaceGigTemplateDraftRequest, req.body), actor(req)));
      return { data: versionDto(v, await managementTexts(versionKeys(v)), true), meta: meta(req) };
    },
  );

  app.post(
    '/gig-templates/:code/versions/:version/publish',
    {
      preValidation: [requireCatalogPermission('write'), strictIntegerParams({ version: VERSION_BOUNDS }), strictBody(PublishGigTemplateVersionRequest)],
      schema: {
        operationId: 'publishGigTemplateVersion',
        summary:
          "Publish the DRAFT: it becomes the ACTIVE version, is frozen with all its rows and supersedes the previous ACTIVE version. Needs an ACTIVE Gig Template and service type, at least one field, ENUM fields with options and every content key published in the platform default locale (409 names the missing keys). `expectedRevision` must be the draft's current revision (409 STALE_DRAFT). Repeating a publication with the same revision is a no-op",
        tags,
        security: bearer,
        params: versionParams,
        body: schemaOf(PublishGigTemplateVersionRequest),
        response: { 200: schemaOf(GigTemplateVersionResponse), ...failures },
      },
    },
    async (req) => {
      const v = await run(() => gt.publishGigTemplateVersion(code(req), versionNumber(req), parse(PublishGigTemplateVersionRequest, req.body), actor(req)));
      return { data: versionDto(v, await managementTexts(versionKeys(v)), true), meta: meta(req) };
    },
  );

  app.put(
    '/gig-templates/:code/versions/:version/status',
    {
      preValidation: [requireCatalogPermission('write'), strictIntegerParams({ version: VERSION_BOUNDS }), strictBody(GigTemplateVersionRetireRequest)],
      schema: {
        operationId: 'setGigTemplateVersionStatus',
        summary:
          'Discard a DRAFT version (status RETIRED: the row, its number and its rows stay). The only target is RETIRED and only a DRAFT can be discarded; a published version is closed by pausing or retiring its template. Idempotent',
        tags,
        security: bearer,
        params: versionParams,
        body: schemaOf(GigTemplateVersionRetireRequest),
        response: { 200: schemaOf(GigTemplateVersionResponse), ...failures },
      },
    },
    async (req) => {
      const v = await run(() => gt.retireGigTemplateVersion(code(req), versionNumber(req), parse(GigTemplateVersionRetireRequest, req.body), actor(req)));
      return { data: versionDto(v, await managementTexts(versionKeys(v)), true), meta: meta(req) };
    },
  );

  app.put(
    '/markets/:market/gig-templates/:code',
    {
      preValidation: [requireCatalogPermission('write'), strictBody(SetMarketGigTemplateAvailabilityRequest)],
      schema: {
        operationId: 'setCatalogMarketGigTemplateAvailability',
        summary:
          "Offer or withdraw a Gig Template in a market and set its position among the market's templates (`displayOrder`, required when the template is not yet part of the market; unique per market). The market can be of any status: a market can be prepared before launch, and nothing is public until the market is ACTIVE and in effect. A RETIRED template cannot be enabled (409). Idempotent",
        tags,
        security: bearer,
        params: marketCodeParams,
        body: schemaOf(SetMarketGigTemplateAvailabilityRequest),
        response: { 200: schemaOf(GigTemplateMarketAvailabilityResponse), ...failures },
      },
    },
    async (req) => {
      const p = req.params as { market: string; code: string };
      const data = await run(() => gt.setMarketGigTemplateAvailability(p.market, p.code, parse(SetMarketGigTemplateAvailabilityRequest, req.body), actor(req)));
      return { data, meta: meta(req) };
    },
  );
}
