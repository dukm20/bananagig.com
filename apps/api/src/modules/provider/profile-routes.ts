// Provider public profile API (PRO-002, docs/engineering/PROVIDER_PROFILE.md). Two surfaces:
//   - OWNER routes under /api/v1/provider/profile (tag `provider-profile`): the caller's own profile, its photo, its visibility and a preview. Every route acts on the account of the VERIFIED
//     token (requireAccount) and none accepts an account id, a profile id, a role, a status or an asset: another account's profile cannot be named. Every response, errors included, is
//     `Cache-Control: no-store`, except the conditional photo GET.
//   - PUBLIC routes under /api/v1/providers/{publicProfileId} (tag `providers`, `security: []`): a customer-appropriate projection and the sanitised photo bytes of a profile its owner chose to
//     show. No authentication is required and an Authorization header changes nothing. An unknown, private, ineligible or malformed id is ONE identical 404, so the answer cannot tell a
//     private profile from a missing one. PUBLIC visibility is not live and not bookable (Go-Live is PRO-003); nothing lists or searches profiles.
// Bodies are validated RAW and strictly (strictParsed) before Ajv can coerce them (LRN-0058).
import type { ZodType } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  CreateProviderProfileRequest,
  FinalizeProfilePhotoRequest,
  OwnerProfileStateResponse,
  PreviewProviderProfileResponse,
  ProfilePhotoUploadResponse,
  PublicProfileParams,
  PublicProviderProfileResponse,
  profileErrorKey,
  profileWireCode,
  RemoveProfilePhotoRequest,
  RequestProfilePhotoUploadRequest,
  SetProfileVisibilityRequest,
  UpdateProviderProfileRequest,
} from '@bananagig/contracts';
import { ProfileError, ProviderError, type ProfilePhotoApi, type ProfilePhotoResult, type ProviderProfileService } from '@bananagig/provider';
import { AppError } from '../../errors';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { ownerStateDto, photoUploadDto, PHOTO_CONTENT_TYPES, previewProfileDto, publicNotFound, publicProfileDto, toAppError } from './profile-dto';

const bearer = [{ bearerAuth: [] }];
/** 401 (missing or invalid token), 400, 403 (not an eligible provider, suspended or closed account), 404, 409, 503. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);

/**
 * Largest body any profile route can legitimately receive: a bio of up to 5000 characters (the structural ceiling, four times that is accepted raw so the service can answer with a precise
 * reason) plus a display name, as JSON with escapes (up to six bytes per character), so the cap is generous but finite.
 */
export const PROFILE_BODY_LIMIT = 131_072;
/** The small bodies (create, visibility, photo upload / finalize / remove): a revision, a content type, a size and a hash. No file ever travels through the API. */
export const PROFILE_SMALL_BODY_LIMIT = 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The public id is deliberately NOT validated by the router schema: a 400 for a malformed id and a 404 for an unknown one would tell the two apart. The handler answers the one 404.
 * (The router's own length limit is answered the same way by the framework error handler.)
 */
const publicParams = {
  type: 'object',
  properties: { publicProfileId: { type: 'string' } },
  required: ['publicProfileId'],
  additionalProperties: false,
} as const;
const noQuery = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * The body, validated RAW and STRICTLY in preValidation (ahead of Ajv) and kept for the handler. Fastify's Ajv runs with type coercion on and would rewrite a body declared for OpenAPI
 * before the handler sees it, so the handler never reads `req.body`: it reads what the strict contract parsed. A body-less POST (`optional`) is accepted as `{}`.
 */
const parsedBodies = new WeakMap<object, unknown>();
const strictParsed =
  (schema: ZodType, optional = false): preValidationAsyncHookHandler =>
  async (req) => {
    parsedBodies.set(req, parse(schema, optional && (req.body === undefined || req.body === null) ? {} : req.body));
  };
const bodyOf = <T>(req: FastifyRequest): T => parsedBodies.get(req) as T;

export interface ProviderProfileRouteDeps {
  profiles: ProviderProfileService;
  photos: ProfilePhotoApi;
}

/** A conditional-request validator is a short opaque token; anything longer is ignored (it cannot match) rather than passed on. */
const ifNoneMatchOf = (req: FastifyRequest): { ifNoneMatch?: string } => {
  const v = req.headers['if-none-match'];
  return typeof v === 'string' && v.length > 0 && v.length <= 1024 ? { ifNoneMatch: v } : {};
};

const PHOTO_OK = (description: string) => ({
  description,
  content: Object.fromEntries([...PHOTO_CONTENT_TYPES].map((t) => [t, { schema: { type: 'string', format: 'binary' } }])),
  headers: {
    ETag: { type: 'string', description: 'An opaque weak validator (never the content hash).' },
    'Cache-Control': { type: 'string', description: 'Always revalidated: `no-cache` (the public photo) or `private, no-cache` (the owner photo).' },
    'X-Content-Type-Options': { type: 'string', enum: ['nosniff'] },
    'Content-Security-Policy': { type: 'string', enum: ["default-src 'none'; sandbox"] },
    'Content-Disposition': { type: 'string', enum: ['inline'] },
    'Cross-Origin-Resource-Policy': { type: 'string', enum: ['cross-origin'] },
  },
});
/** A photo response is an image and nothing else: should anything ever render it as a document, it can load, run and embed nothing. */
const PHOTO_CSP = "default-src 'none'; sandbox";
const NOT_MODIFIED = { description: 'The validator matches: the image is unchanged.' };

/**
 * Sends sanitised photo bytes (or a 304). The content type is FORCED from the allow-list (never sniffed, never taken from a stored header), the image is `inline` and `nosniff`, may be embedded
 * cross-origin, and is revalidated on every use (`no-cache` plus an opaque weak ETag) so a removed or replaced photo disappears at once while an unchanged one costs a 304.
 */
function sendPhoto(reply: FastifyReply, r: ProfilePhotoResult, cacheControl: string): FastifyReply {
  if (r.kind === 'bytes' && !PHOTO_CONTENT_TYPES.has(r.contentType))
    throw new AppError('DEPENDENCY', 'PROFILE_UNAVAILABLE', 'The profile is temporarily unavailable');
  reply
    .header('etag', r.etag)
    .header('cache-control', cacheControl)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', PHOTO_CSP)
    .header('cross-origin-resource-policy', 'cross-origin');
  if (r.kind === 'not-modified') return reply.status(304).send();
  return reply.status(200).header('content-type', r.contentType).header('content-disposition', 'inline').send(r.bytes);
}

export async function providerProfileRoutes(app: FastifyInstance, deps: ProviderProfileRouteDeps): Promise<void> {
  const svc = deps.profiles;
  const photos = deps.photos;
  const tags = ['provider-profile'];
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const guard = requireAccount({ honorActiveRoleHeader: false });
  // the responses concern one person's presentation draft: never stored by a shared cache or the browser (the photo GET overrides this with its own revalidation policy)
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/profile',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderProfile',
        summary:
          "The caller's own public profile as the owner sees it: the presentation fields (display name, bio, whether a photo exists), the visibility (PRIVATE by default), the revision, the readiness facts (a fact is not a decision) and the configured limits. `exists: false` (with the facts and limits) when no profile was created yet. Owner only: there is no id in the path",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req) => ({ data: ownerStateDto(await run(() => svc.getOwnerProfile(accountId(req)))), meta: meta(req) }),
  );

  app.post(
    '/profile',
    {
      bodyLimit: PROFILE_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(CreateProviderProfileRequest, true)],
      schema: {
        operationId: 'createProviderProfile',
        summary:
          'Create the profile of the caller (PRIVATE, revision 1). Needs an ACTIVE account and a PROVIDER role with a COMPLETED registration. Idempotent: an existing profile is returned unchanged (200); a first creation is 201. Takes no input; the profile is private until the owner chooses otherwise',
        tags,
        security: bearer,
        response: { 200: schemaOf(OwnerProfileStateResponse), 201: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => svc.createProfile(accountId(req)));
      return reply.status(r.created ? 201 : 200).send({ data: ownerStateDto(r.state), meta: meta(req) });
    },
  );

  app.patch(
    '/profile',
    {
      bodyLimit: PROFILE_BODY_LIMIT,
      preValidation: [guard, strictParsed(UpdateProviderProfileRequest)],
      schema: {
        operationId: 'updateProviderProfile',
        summary:
          'Change the display name and/or the bio (plain text; a field that is absent stays unchanged, null clears it). The name and the bio are normalised, bounded by the configured limits and refused with a reason code when blank, too long, containing HTML or forbidden characters. The public name falls back to the first name and last initial when no display name is set; the legal name is never shown. `expectedRevision` must be the revision last read (409 STALE_PROFILE); a change raises the revision by exactly 1',
        tags,
        security: bearer,
        body: schemaOf(UpdateProviderProfileRequest),
        response: { 200: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req) => ({ data: ownerStateDto(await run(() => svc.updateProfile(accountId(req), bodyOf<UpdateProviderProfileRequest>(req)))), meta: meta(req) }),
  );

  app.post(
    '/profile/visibility',
    {
      bodyLimit: PROFILE_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(SetProfileVisibilityRequest)],
      schema: {
        operationId: 'setProviderProfileVisibility',
        summary:
          'Show (PUBLIC) or hide (PRIVATE) the profile. PUBLIC needs what the configuration requires of a public profile (409 PROFILE_INCOMPLETE lists identifier-only issues); PRIVATE is always allowed. A PUBLIC profile is an unlisted page reachable only by its opaque id: it does NOT make the provider live or bookable (Go-Live is a later checkpoint) and nothing lists or searches profiles. `expectedRevision` must be the revision last read (409 STALE_PROFILE)',
        tags,
        security: bearer,
        body: schemaOf(SetProfileVisibilityRequest),
        response: { 200: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req) => ({ data: ownerStateDto(await run(() => svc.setVisibility(accountId(req), bodyOf<SetProfileVisibilityRequest>(req)))), meta: meta(req) }),
  );

  app.post(
    '/profile/photo/uploads',
    {
      bodyLimit: PROFILE_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(RequestProfilePhotoUploadRequest)],
      schema: {
        operationId: 'requestProviderProfilePhotoUpload',
        summary:
          'Authorize ONE profile photo upload: validates the type (JPEG, PNG or WebP) and the size against the configured profile policy and answers a short-lived one-object PUT URL with the exact headers to send (content type and length are signed): shown once, never stored by BananaGig, never logged. A previous unfinished upload is abandoned. The file itself never passes through the API. Finish with the finalize call. `expectedRevision` must be the revision last read (409 STALE_PROFILE); the answer carries the revision to send next',
        tags,
        security: bearer,
        body: schemaOf(RequestProfilePhotoUploadRequest),
        response: { 201: schemaOf(ProfilePhotoUploadResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => photos.requestUpload(accountId(req), bodyOf<RequestProfilePhotoUploadRequest>(req)));
      return reply.status(201).send({ data: photoUploadDto(r), meta: meta(req) });
    },
  );

  app.post(
    '/profile/photo/finalize',
    {
      bodyLimit: PROFILE_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(FinalizeProfilePhotoRequest)],
      schema: {
        operationId: 'finalizeProviderProfilePhoto',
        summary:
          'Finish the upload: the server verifies the stored object (it exists, size and content type are the authorized ones, the signature and the image dimensions are those of the declared type, the SHA-256 equals the one sent), scans it, promotes exactly those bytes and records them as the profile photo. A refused photo (400 PROFILE_MEDIA_REFUSED with a reason code) is discarded, except OBJECT_MISSING (the file is not in the store yet), which leaves the upload pending so it can be repeated; an expired authorization is 409 PROFILE_MEDIA_EXPIRED; a scanner that cannot answer is 503 PROFILE_MEDIA_SCAN_UNAVAILABLE and the call can be repeated',
        tags,
        security: bearer,
        body: schemaOf(FinalizeProfilePhotoRequest),
        response: { 200: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req) => ({ data: ownerStateDto(await run(() => photos.finalize(accountId(req), bodyOf<FinalizeProfilePhotoRequest>(req)))), meta: meta(req) }),
  );

  app.delete(
    '/profile/photo',
    {
      bodyLimit: PROFILE_SMALL_BODY_LIMIT,
      preValidation: [guard, strictParsed(RemoveProfilePhotoRequest)],
      schema: {
        operationId: 'removeProviderProfilePhoto',
        summary:
          'Remove the profile photo and any unfinished upload (a JSON body carries `expectedRevision`; some intermediaries drop the body of a DELETE request, in which case the request is rejected as invalid and nothing changes). The photo disappears from the public profile at once. Idempotent when there is none',
        tags,
        security: bearer,
        body: schemaOf(RemoveProfilePhotoRequest),
        response: { 200: schemaOf(OwnerProfileStateResponse), ...failures },
      },
    },
    async (req) => ({ data: ownerStateDto(await run(() => photos.remove(accountId(req), bodyOf<RemoveProfilePhotoRequest>(req)))), meta: meta(req) }),
  );

  app.get(
    '/profile/preview',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderProfilePreview',
        summary:
          "The public projection of the caller's own profile, whatever its visibility, with `visibility` and `preview: true`: exactly what a customer would see through the public route (the same code builds both). A PRIVATE profile is previewable but is not public. 404 when no profile exists",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(PreviewProviderProfileResponse), ...failures },
      },
    },
    async (req) => ({ data: previewProfileDto(await run(() => svc.getPreview(accountId(req)))), meta: meta(req) }),
  );

  app.get(
    '/profile/photo',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderProfilePhoto',
        summary:
          "The caller's own profile photo as the public would receive it: the SANITISED image (location, camera and text metadata removed at the container level; only an orientation tag is kept), the content type forced from the allow-list, `nosniff`, `inline`. Revalidated with an opaque weak ETag (304 on a match). 404 when there is no photo. The stored original is never served",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: PHOTO_OK('The sanitised image.'), 304: NOT_MODIFIED, ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => photos.ownerPhoto(accountId(req), ifNoneMatchOf(req)));
      if (r === null)
        throw new AppError('NOT_FOUND', profileWireCode('MEDIA_NOT_FOUND'), 'The photo was not found', { messageKey: profileErrorKey('MEDIA_NOT_FOUND') });
      return sendPhoto(reply, r, 'private, no-cache');
    },
  );
}

/**
 * The public side never reveals why a profile is not shown: every refusal that depends on the profile (unknown, private, ineligible, disabled, a malformed id, an account that is no longer
 * active) is the SAME 404. A dependency outage is a 503 (accepted): the 503-versus-404 difference exists only when an id is publicly readable AND a port is down, and ids are unguessable random v4 uuids, so it reveals nothing about ids that are not already known.
 */
const publicRun = <T>(fn: () => Promise<T>): Promise<T> =>
  fn().catch((err: unknown) => {
    if (err instanceof ProfileError && err.code !== 'UNAVAILABLE' && err.code !== 'CONFLICT') throw publicNotFound();
    if (err instanceof ProviderError && err.code === 'ACCOUNT_NOT_ACTIVE') throw publicNotFound();
    return toAppError(err);
  });

export async function publicProfileRoutes(app: FastifyInstance, deps: ProviderProfileRouteDeps): Promise<void> {
  const svc = deps.profiles;
  const photos = deps.photos;
  const tags = ['providers'];
  const idOf = (req: FastifyRequest): string => {
    const id = (req.params as { publicProfileId: string }).publicProfileId;
    // a malformed id is the same 404 as an unknown one; the strict contract is the single definition of "well formed"
    if (!UUID.test(id) || !PublicProfileParams.safeParse({ publicProfileId: id }).success) throw publicNotFound();
    return id.toLowerCase();
  };

  app.get(
    '/:publicProfileId',
    {
      onRequest: async (_req, reply) => {
        reply.header('cache-control', 'no-store');
      },
      schema: {
        operationId: 'getPublicProviderProfile',
        summary:
          "The public profile of a provider who chose to show it: the public name (the provider's display name, else first name and last initial; never the legal name), the bio, whether a photo exists, customer-appropriate trust badges (type codes only, derived now from the live verification case), the market code, the ACTIVE published Gigs as cards (title, service, base price, duration, counts) and the placeholders `ratings` and `drops` (`available: false`). Public: no authentication, and an Authorization header is ignored. An unknown, private, ineligible or malformed id is one identical 404. A public profile is NOT live and NOT bookable; nothing lists or searches profiles. Never cached (`no-store`)",
        tags,
        security: [],
        params: publicParams,
        querystring: noQuery,
        response: { 200: schemaOf(PublicProviderProfileResponse), 400: errorResponses[400], 404: errorResponses[404], 503: errorResponses[503] },
      },
    },
    async (req) => {
      const id = idOf(req);
      const p = await publicRun(() => svc.getPublicProfile(id));
      if (p === null) throw publicNotFound();
      return { data: publicProfileDto(p), meta: meta(req) };
    },
  );

  app.get(
    '/:publicProfileId/photo',
    {
      schema: {
        operationId: 'getPublicProviderProfilePhoto',
        summary:
          'The photo of a publicly visible profile, as SANITISED bytes: location, camera and text metadata are removed at the container level (only an orientation tag is kept) and the stored original is never served; the content type is forced from the allow-list and the response is `nosniff`, `inline` and embeddable cross-origin. Revalidated on every use (`Cache-Control: no-cache` with an opaque weak ETag; 304 on a match, answered before the object is read). Public: no authentication. An unknown id, a private or ineligible profile, a profile without a photo and a malformed id are one identical 404',
        tags,
        security: [],
        params: publicParams,
        querystring: noQuery,
        response: { 200: PHOTO_OK('The sanitised image.'), 304: NOT_MODIFIED, 400: errorResponses[400], 404: errorResponses[404], 503: errorResponses[503] },
      },
    },
    async (req, reply) => {
      const id = idOf(req);
      const r = await publicRun(() => photos.publicPhoto(id, ifNoneMatchOf(req)));
      if (r === null) throw publicNotFound();
      return sendPhoto(reply, r, 'no-cache');
    },
  );
}
