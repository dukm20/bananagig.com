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
  DetachGigMediaRequest,
  FinalizeGigMediaRequest,
  GigDetailResponse,
  GigMediaPreviewResponse,
  GigMediaUploadResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  PublishGigRequest,
  ReorderGigMediaRequest,
  ReplaceGigAddOnsRequest,
  ReplaceGigVariantsRequest,
  RequestGigMediaUploadRequest,
  RetireGigRequest,
  UpdateGigDraftRequest,
  UpdateGigMediaRequest,
} from '@bananagig/contracts';
import type { ProviderGigService } from '@bananagig/provider';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse } from '../../plugins/strict-body';
import { integerParamSchema, strictIntegerParams } from '../../plugins/strict-params';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { choicesDto, detailDto, mediaPreviewDto, mediaUploadDto, menuDto, toAppError, versionDto } from './gig-dto';

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
/** The photo requests (CAT-004): an alt text of up to 2000 characters as escaped JSON, or the whole order of up to 200 media ids. No file ever travels through the API. */
export const GIG_MEDIA_BODY_LIMIT = 16_384;

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
const mediaParams = {
  type: 'object',
  properties: { gigId: { type: 'string', pattern: UUID_PATTERN }, mediaId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['gigId', 'mediaId'],
  additionalProperties: false,
} as const;
const versionMediaParams = {
  type: 'object',
  properties: {
    gigId: { type: 'string', pattern: UUID_PATTERN },
    version: integerParamSchema(VERSION_BOUNDS),
    mediaId: { type: 'string', pattern: UUID_PATTERN },
  },
  required: ['gigId', 'version', 'mediaId'],
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
  const mediaId = (req: FastifyRequest): string => (req.params as { mediaId: string }).mediaId;
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

  // ---------------------------------------------------------------- CAT-004: variants, add-ons and photos of the DRAFT (version-owned; a published version never changes)
  app.put(
    '/gigs/:gigId/draft/variants',
    {
      bodyLimit: GIG_BODY_LIMIT,
      preValidation: [guard, strictParsed(ReplaceGigVariantsRequest)],
      schema: {
        operationId: 'replaceProviderGigDraftVariants',
        summary:
          'Replace the WHOLE list of variants of the DRAFT (array order is the display order; an omitted variant is removed). Variants are mutually exclusive alternatives that add a non-negative price delta (minor units of the Gig currency, never sent) and non-negative minutes to the base price and duration. Allowed only when the bound template version allows FIXED_WITH_VARIANTS. An item sent with its `key` is kept, one without gets a server-minted key; names are plain text and unique within the list. `expectedRevision` must be the revision last read (409 GIG_STALE_DRAFT); a change raises the revision by exactly 1',
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(ReplaceGigVariantsRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({
      data: detailDto(await run(() => svc.replaceVariants(accountId(req), gigId(req), bodyOf<ReplaceGigVariantsRequest>(req)))),
      meta: meta(req),
    }),
  );

  app.put(
    '/gigs/:gigId/draft/add-ons',
    {
      bodyLimit: GIG_BODY_LIMIT,
      preValidation: [guard, strictParsed(ReplaceGigAddOnsRequest)],
      schema: {
        operationId: 'replaceProviderGigDraftAddOns',
        summary:
          'Replace the WHOLE list of add-ons of the DRAFT (array order is the display order). Add-ons are independent optional extras without a quantity, each adding a non-negative price delta and non-negative minutes to the base. Allowed only when the bound template version explicitly allows add-ons (the ADD_ONS pricing permission). Same keys, names, limits and revision rules as the variants',
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(ReplaceGigAddOnsRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.replaceAddOns(accountId(req), gigId(req), bodyOf<ReplaceGigAddOnsRequest>(req)))), meta: meta(req) }),
  );

  app.post(
    '/gigs/:gigId/draft/media/uploads',
    {
      bodyLimit: GIG_MEDIA_BODY_LIMIT,
      preValidation: [guard, strictParsed(RequestGigMediaUploadRequest)],
      schema: {
        operationId: 'requestProviderGigMediaUpload',
        summary:
          'Authorize ONE photo upload for a MEDIA field of the template version the DRAFT is bound to: validates the type (JPEG, PNG or WebP) and size against the configured policy, the field rules and the photo limits, reserves the last place in the draft as an UPLOADING photo and raises the draft revision by 1. The answer carries a short-lived one-object PUT URL with the exact headers to send (content type and length are signed): shown once, never stored by BananaGig, never logged. The file itself never passes through the API. Finish with the finalize call; an upload not finished before it expires is closed by the server',
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(RequestGigMediaUploadRequest),
        response: { 201: schemaOf(GigMediaUploadResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => svc.requestMediaUpload(accountId(req), gigId(req), bodyOf<RequestGigMediaUploadRequest>(req)));
      return reply.status(201).send({ data: mediaUploadDto(r.upload), meta: meta(req) });
    },
  );

  app.post(
    '/gigs/:gigId/draft/media/:mediaId/finalize',
    {
      bodyLimit: GIG_MEDIA_BODY_LIMIT,
      preValidation: [guard, strictParsed(FinalizeGigMediaRequest)],
      schema: {
        operationId: 'finalizeProviderGigMedia',
        summary:
          "Finish an upload: the server verifies the stored object (it exists, size and content type are the authorized ones, the signature and the image dimensions are those of the declared type and inside the configured bounds, the SHA-256 equals the one sent), scans it, promotes exactly those bytes and marks the photo READY. A refused photo (400 GIG_MEDIA_REFUSED with a reason code) is removed from the draft, except OBJECT_MISSING (the file is not in the store yet), which leaves the photo pending so the upload can be repeated and finalized again, or the photo removed with the detach call; an expired authorization is 409 GIG_MEDIA_EXPIRED; a scanner that cannot answer is 503 GIG_MEDIA_SCAN_UNAVAILABLE and the call can be repeated. Idempotent: finishing a READY photo returns the Gig. Another account's photo is 404",
        tags,
        security: bearer,
        params: mediaParams,
        body: schemaOf(FinalizeGigMediaRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({
      data: detailDto(await run(() => svc.finalizeMedia(accountId(req), gigId(req), mediaId(req), bodyOf<FinalizeGigMediaRequest>(req)))),
      meta: meta(req),
    }),
  );

  // the static segment `order` wins over the `:mediaId` parameter below (find-my-way), and `order` is not a UUID anyway
  app.put(
    '/gigs/:gigId/draft/media/order',
    {
      bodyLimit: GIG_MEDIA_BODY_LIMIT,
      preValidation: [guard, strictParsed(ReorderGigMediaRequest)],
      schema: {
        operationId: 'reorderProviderGigDraftMedia',
        summary:
          "Set the WHOLE order of the photos of the DRAFT: `mediaIds` must be exactly the draft's photos, each once (400 otherwise, nothing changes). Raises the revision by 1 when the order changed",
        tags,
        security: bearer,
        params: gigParams,
        body: schemaOf(ReorderGigMediaRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: detailDto(await run(() => svc.reorderMedia(accountId(req), gigId(req), bodyOf<ReorderGigMediaRequest>(req)))), meta: meta(req) }),
  );

  app.put(
    '/gigs/:gigId/draft/media/:mediaId',
    {
      bodyLimit: GIG_MEDIA_BODY_LIMIT,
      preValidation: [guard, strictParsed(UpdateGigMediaRequest)],
      schema: {
        operationId: 'updateProviderGigDraftMedia',
        summary:
          'Set or clear the alt text of a photo of the DRAFT (plain single-line text up to the configured length; null clears it). Raises the revision by 1 when it changed',
        tags,
        security: bearer,
        params: mediaParams,
        body: schemaOf(UpdateGigMediaRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({
      data: detailDto(await run(() => svc.updateMedia(accountId(req), gigId(req), mediaId(req), bodyOf<UpdateGigMediaRequest>(req)))),
      meta: meta(req),
    }),
  );

  app.delete(
    '/gigs/:gigId/draft/media/:mediaId',
    {
      bodyLimit: GIG_MEDIA_BODY_LIMIT,
      preValidation: [guard, strictParsed(DetachGigMediaRequest)],
      schema: {
        operationId: 'detachProviderGigDraftMedia',
        summary:
          'Remove a photo from the DRAFT (a JSON body carries `expectedRevision`; some intermediaries drop the body of a DELETE request, in which case the request is rejected as invalid and nothing changes). Only the attachment is removed: the stored image stays while any version, published ones included, still uses it; an unfinished upload (including one left pending by an OBJECT_MISSING refusal) is abandoned and its objects are deleted. Raises the revision by 1',
        tags,
        security: bearer,
        params: mediaParams,
        body: schemaOf(DetachGigMediaRequest),
        response: { 200: schemaOf(GigDetailResponse), ...failures },
      },
    },
    async (req) => ({
      data: detailDto(await run(() => svc.detachMedia(accountId(req), gigId(req), mediaId(req), bodyOf<DetachGigMediaRequest>(req)))),
      meta: meta(req),
    }),
  );

  app.get(
    '/gigs/:gigId/draft/media/:mediaId/preview',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderGigDraftMediaPreview',
        summary:
          "A short-lived one-object GET URL (inline, `no-store`) for a READY photo of the caller's own DRAFT. Owner only; another account's photo or an unfinished upload is 404. The URL is for the owner's browser right now: never store, log or share it. Image bytes never stream through the API",
        tags,
        security: bearer,
        params: mediaParams,
        querystring: noQuery,
        response: { 200: schemaOf(GigMediaPreviewResponse), ...failures },
      },
    },
    async (req) => ({ data: mediaPreviewDto(await run(() => svc.previewMedia(accountId(req), gigId(req), null, mediaId(req)))), meta: meta(req) }),
  );

  app.get(
    '/gigs/:gigId/versions/:version/media/:mediaId/preview',
    {
      preValidation: [guard, strictIntegerParams({ version: VERSION_BOUNDS })],
      schema: {
        operationId: 'getProviderGigVersionMediaPreview',
        summary:
          "A short-lived one-object GET URL (inline, `no-store`) for a READY photo of any version (draft, published, superseded or retired) of the caller's own Gig. Owner only; another account's Gig, a photo of another version or an unknown id is 404. Same URL rules as the draft preview",
        tags,
        security: bearer,
        params: versionMediaParams,
        querystring: noQuery,
        response: { 200: schemaOf(GigMediaPreviewResponse), ...failures },
      },
    },
    async (req) => ({
      data: mediaPreviewDto(await run(() => svc.previewMedia(accountId(req), gigId(req), versionNumber(req), mediaId(req)))),
      meta: meta(req),
    }),
  );
}
