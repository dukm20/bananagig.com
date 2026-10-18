// Provider Gig API (CAT-003, docs/engineering/PROVIDER_GIGS.md), registered under /api/v1/provider: the caller's own GigMenu. A Gig is built from a PLATFORM-OWNED Gig Template (CAT-002),
// is a stable identity with immutable versions, and is NOT live and NOT bookable (Go-Live is PRO-003). Every route acts on the account of the VERIFIED token (requireAccount) and none
// accepts an account id, a role, a status, a market, a currency, a template version or a version status: the market is the one of the account's completed registration, the currency
// is the market's, the template version is the ACTIVE one at creation. Someone else's Gig or version is "not found" (404), never 403. The provider-written text (title, pitch,
// description, text field values) appears only in the caller's own Gig and never in an error, a log or an event. Every response, errors included, is `Cache-Control: no-store`.
// Bodies are validated RAW and strictly (strictParsed) before Ajv can coerce them.
import type { ZodType } from 'zod';
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  CreateGigRequest,
  CreateGigVersionRequest,
  GigDetailResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  PublishGigRequest,
  RetireGigRequest,
  UpdateGigDraftRequest,
} from '@bananagig/contracts';
import type { ProviderGigService } from '@bananagig/provider';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse } from '../../plugins/strict-body';
import { integerParamSchema, strictIntegerParams } from '../../plugins/strict-params';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { choicesDto, detailDto, menuDto, toAppError, versionDto } from './gig-dto';

const bearer = [{ bearerAuth: [] }];
/** 401 (missing or invalid token), 400, 403 (not an eligible provider, suspended or closed account), 404, 409, 503. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);

/**
 * Largest body any Gig route can legitimately receive: a draft replaces the whole content (title, pitch, up to 20 000 characters of description, up to 64 field values of up to 20 000
 * characters each, as JSON with escapes), so the cap is generous but finite.
 */
export const GIG_BODY_LIMIT = 1_048_576;
/** The small bodies (create, publish, next draft, retire). */
export const GIG_SMALL_BODY_LIMIT = 4096;

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const gigParams = {
  type: 'object',
  properties: { gigId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['gigId'],
  additionalProperties: false,
} as const;
/** The same bounds as the contract GigVersionParams (up to nine digits). */
const VERSION_BOUNDS = { min: 1, max: 999_999_999 };
const versionParams = {
  type: 'object',
  properties: { gigId: { type: 'string', pattern: UUID_PATTERN }, version: integerParamSchema(VERSION_BOUNDS) },
  required: ['gigId', 'version'],
  additionalProperties: false,
} as const;
const noQuery = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * The body, validated RAW and STRICTLY in preValidation (ahead of Ajv) and kept for the handler. Fastify's Ajv runs with type coercion on and would rewrite a body that is declared
 * for OpenAPI before the handler sees it (a field value `3` becomes "3", `true` becomes "true", `null` becomes ""), so the handler never reads `req.body`: it reads what the strict
 * contract parsed. A body-less POST (`optional`) is accepted as `{}`; anything else is validated strictly.
 */
const parsedBodies = new WeakMap<object, unknown>();
const strictParsed =
  (schema: ZodType, optional = false): preValidationAsyncHookHandler =>
  async (req) => {
    parsedBodies.set(req, parse(schema, optional && (req.body === undefined || req.body === null) ? {} : req.body));
  };
const bodyOf = <T>(req: FastifyRequest): T => parsedBodies.get(req) as T;

export interface ProviderGigRouteDeps {
  gigs: ProviderGigService;
}

export async function providerGigRoutes(app: FastifyInstance, deps: ProviderGigRouteDeps): Promise<void> {
  const svc = deps.gigs;
  const tags = ['gigs'];
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const gigId = (req: FastifyRequest): string => (req.params as { gigId: string }).gigId;
  const versionNumber = (req: FastifyRequest): number => Number((req.params as { version: string | number }).version);
  const guard = requireAccount({ honorActiveRoleHeader: false });
  // the responses concern one person's offers: never stored by a shared cache or the browser
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/gig-templates',
    {
      preValidation: guard,
      schema: {
        operationId: 'listProviderGigTemplates',
        summary:
          "The Gig Templates the caller can start a Gig from now: the ACTIVE templates (with an ACTIVE version) enabled in the market of the caller's completed registration, for the service types the caller selected. Names and descriptions are content KEYS. Empty when the registration is not completed. Writes nothing",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(GigTemplateChoicesResponse), ...failures },
      },
    },
    async (req) => ({ data: choicesDto(await run(() => svc.listGigTemplates(accountId(req)))), meta: meta(req) }),
  );

  app.get(
    '/gigs',
    {
      preValidation: guard,
      schema: {
        operationId: 'listProviderGigs',
        summary:
          "The caller's GigMenu: every Gig of the account (any status, retired ones included) with its current published version and its draft, the configured limits, the readiness facts for Go-Live (goLive is always not evaluated: a published Gig does not make the provider live or bookable) and whether a new Gig can be created now. Owner only: there is no id in the path. Reads in a constant number of queries",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(GigMenuResponse), ...failures },
      },
    },
    async (req) => ({ data: menuDto(await run(() => svc.listProviderGigs(accountId(req)))), meta: meta(req) }),
  );

  app.post(
    '/gigs',
    {
      bodyLimit: GIG_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(CreateGigRequest)],
      schema: {
        operationId: 'createProviderGig',
        summary:
          "Create a Gig from a Gig Template: the Gig identity and its first DRAFT version, bound to the template's ACTIVE version at this moment (the client never names a version). Needs an ACTIVE account and PROVIDER role, a completed registration whose market offers the template and a service type the caller selected. Several Gigs per template are allowed within the configured draft limit. `clientRequestId` makes the request idempotent: repeating it returns the Gig it created (200 instead of 201). The price currency, the market and the owner are decided by the server",
        tags,
        security: bearer,
        body: schemaOf(CreateGigRequest),
        response: { 200: schemaOf(GigDetailResponse), 201: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => svc.createGig(accountId(req), bodyOf<CreateGigRequest>(req)));
      return reply.status(r.created ? 201 : 200).send({ data: detailDto(r.detail), meta: meta(req) });
    },
  );

  app.get(
    '/gigs/:gigId',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderGig',
        summary:
          "One Gig of the caller with its current published version, its editable draft (with the typed fields of the exact template version it is bound to, the server's constraints and what blocks publishing) and its version history. Readable in every state, even after the Gig or its template was retired. Another account's Gig is 404, never 403",
        tags,
        security: bearer,
        params: gigParams,
        querystring: noQuery,
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.getGig(accountId(req), gigId(req)))), meta: meta(req) }),
  );

  app.post(
    '/gigs/:gigId/versions',
    {
      bodyLimit: GIG_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(CreateGigVersionRequest, true)],
      schema: {
        operationId: 'createProviderGigVersion',
        summary:
          'Start the next DRAFT of an ACTIVE Gig from its published version (the same template version: a newer template version is not adopted automatically). At most one draft exists per Gig (409 GIG_DRAFT_EXISTS) and the configured draft limit applies. Takes no input',
        tags,
        security: bearer,
        params: gigParams,
        response: { 201: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req, reply) => {
      const d = await run(() => svc.createNextDraft(accountId(req), gigId(req), bodyOf<CreateGigVersionRequest>(req)));
      return reply.status(201).send({ data: detailDto(d), meta: meta(req) });
    },
  );

  app.get(
    '/gigs/:gigId/versions/:version',
    {
      preValidation: [guard, strictIntegerParams({ version: VERSION_BOUNDS })],
      schema: {
        operationId: 'getProviderGigVersion',
        summary:
          "One version of a Gig of the caller by its number (DRAFT, PUBLISHED, SUPERSEDED or RETIRED), with the typed fields of the exact template version it is bound to. A published version never changes. Another account's Gig or an unknown number is 404",
        tags,
        security: bearer,
        params: versionParams,
        querystring: noQuery,
        response: { 200: schemaOf(GigVersionResponse), ...failures },
      },
    },
    async (req) => ({ data: versionDto(await run(() => svc.getGigVersion(accountId(req), gigId(req), versionNumber(req)))), meta: meta(req) }),
  );

  app.put(
    '/gigs/:gigId/draft',
    {
      bodyLimit: GIG_BODY_LIMIT,
      preValidation: [guard, strictParsed(UpdateGigDraftRequest)],
      schema: {
        operationId: 'updateProviderGigDraft',
        summary:
          'Replace the whole editable content of the DRAFT (an omitted field value is cleared): title, short pitch, description (plain text), price in minor units, duration in minutes and the values of the provider-editable template fields. A draft may be incomplete but every value present is validated against the exact template version (type, bounds, options) and the configured limits; a value for a platform-fixed or unknown field is refused. The price currency is never sent: the server sets the market currency. `expectedRevision` must be the revision last read (409 GIG_STALE_DRAFT)',
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(UpdateGigDraftRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.updateDraft(accountId(req), gigId(req), bodyOf<UpdateGigDraftRequest>(req)))), meta: meta(req) }),
  );

  app.post(
    '/gigs/:gigId/publish',
    {
      bodyLimit: GIG_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(PublishGigRequest)],
      schema: {
        operationId: 'publishProviderGig',
        summary:
          'Publish the DRAFT: it becomes the PUBLISHED version (frozen) and the previous published version is SUPERSEDED in the same transaction. The server checks completeness (title, pitch, description, required fields, a price above zero and a duration where the template calls for them), the template version not being retired and the configured limit of active Gigs; 409 GIG_PUBLISH_BLOCKED lists identifier-only issues. `expectedRevision` must be the revision last read (409 GIG_STALE_DRAFT). Publishing does NOT make the provider live or bookable',
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(PublishGigRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.publish(accountId(req), gigId(req), bodyOf<PublishGigRequest>(req)))), meta: meta(req) }),
  );

  app.post(
    '/gigs/:gigId/retire',
    {
      bodyLimit: GIG_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(RetireGigRequest, true)],
      schema: {
        operationId: 'retireProviderGig',
        summary:
          'Retire the Gig. Terminal: its draft and published versions become RETIRED, earlier superseded versions stay, nothing is deleted and the history stays readable. A retired Gig cannot be reactivated (create a new Gig). Takes no input',
        tags,
        security: bearer,
        params: gigParams,
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.retire(accountId(req), gigId(req), bodyOf<RetireGigRequest>(req)))), meta: meta(req) }),
  );
}
