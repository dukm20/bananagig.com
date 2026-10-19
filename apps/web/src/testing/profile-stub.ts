// Contract-conforming stand-in for the provider profile endpoints (PRO-002), mounted on the content stub (the real API is exercised by its own integration tests and `pnpm smoke`).
// It behaves like the API where the web app depends on it: the owner routes need a bearer token, a revoked session is 401 SESSION_REVOKED, the public route needs none and answers the
// SAME 404 for anything that is not publicly readable, and every response is validated against the contract before it is served.
import type http from 'node:http';
import {
  CORRELATION_HEADER,
  FinalizeProfilePhotoRequest,
  GIG_MEDIA_REFUSAL_REASONS,
  OwnerProfileStateResponse,
  PROFILE_ERROR_CODES,
  PROFILE_ISSUE_REASONS,
  PROFILE_VISIBILITIES,
  PreviewProviderProfileResponse,
  ProfilePhotoUploadResponse,
  PublicProviderProfileResponse,
  RemoveProfilePhotoRequest,
  RequestProfilePhotoUploadRequest,
  SetProfileVisibilityRequest,
  TRUST_REQUIREMENT_TYPES,
  UpdateProviderProfileRequest,
  gigMediaRefusedKey,
  profileBadgeKey,
  profileErrorKey,
  profileIssueKey,
  profileVisibilityKey,
  type OwnerProfileStateDto,
  type OwnerProviderProfileDto,
  type PreviewProviderProfileDto,
  type ProfileLimitsDto,
  type ProfilePhotoUploadDto,
  type ProfileReadinessDto,
  type PublicGigSummaryDto,
  type PublicProviderProfileDto,
} from '@bananagig/contracts';
import type { ContentStub, StubCatalog } from './content-stub';
import { REGISTRY_COPY } from './content-stub';
import { profileKey } from '../lib/provider-profile';

export const PUBLIC_PROFILE_ID = '7e1c4d28-9b35-4f60-a2d8-3c5b9e0f1a46';
export const OTHER_PROFILE_ID = 'c4a9e6d1-2f58-4b07-8e31-6d0a7b2c9f13';
const T0 = '2026-10-16T09:30:00.000Z';
const T1 = '2026-10-17T10:00:00.000Z';

export const readinessDto = (over: Partial<ProfileReadinessDto> = {}): ProfileReadinessDto => ({
  displayNamePresent: true,
  publicNameAvailable: true,
  bioPresent: true,
  profilePhotoPresent: false,
  hasPublishedGig: true,
  trustSummaryAvailable: false,
  profileComplete: true,
  visibility: 'PRIVATE',
  ...over,
});
export const limitsDto = (over: Partial<ProfileLimitsDto> = {}): ProfileLimitsDto => ({
  displayNameMaxLength: 60,
  bioMaxLength: 1000,
  bioRequired: false,
  photoRequired: false,
  photoMaxSizeBytes: 2_097_152,
  photoMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  ...over,
});
export const ownerProfileDto = (over: Partial<OwnerProviderProfileDto> = {}): OwnerProviderProfileDto => ({
  publicProfileId: PUBLIC_PROFILE_ID,
  displayName: 'Sunny Home Care',
  publicName: 'Sunny Home Care',
  bio: 'We clean homes.\nSecond line of the bio.',
  photo: null,
  photoPending: false,
  visibility: 'PRIVATE',
  publishedAt: null,
  revision: 4,
  createdAt: T0,
  updatedAt: T1,
  ...over,
});
export const ownerStateDto = (profile: OwnerProviderProfileDto | null = ownerProfileDto(), over: Partial<OwnerProfileStateDto> = {}): OwnerProfileStateDto => ({
  exists: profile !== null,
  profile,
  readiness: readinessDto(profile === null ? { visibility: null, displayNamePresent: false, bioPresent: false } : { visibility: profile.visibility }),
  limits: limitsDto(),
  ...over,
});
export const publicGigDto = (n = 1, over: Partial<PublicGigSummaryDto> = {}): PublicGigSummaryDto => ({
  gigId: `5a0c2b9e-7d41-4c3a-9f60-1e8b2d7a4c${String(10 + n)}`,
  title: `Spotless clean ${n}`,
  shortPitch: 'We bring everything.',
  serviceTypeCode: 'house_cleaning',
  serviceTypeNameContentKey: 'catalog.service_type.house_cleaning.name',
  price: { amountMinor: 12500, currency: 'USD' },
  durationMinutes: 120,
  variantCount: 2,
  addOnCount: 1,
  photoCount: 3,
  ...over,
});
export const publicProfileDto = (over: Partial<PublicProviderProfileDto> = {}): PublicProviderProfileDto => ({
  publicProfileId: PUBLIC_PROFILE_ID,
  displayName: 'Sunny Home Care',
  bio: 'We clean homes.\nSecond line of the bio.',
  photo: null,
  badges: [],
  market: { code: 'us-orange-county' },
  gigs: [publicGigDto(1)],
  ratings: { available: false },
  drops: { available: false },
  ...over,
});
export const previewDto = (over: Partial<PreviewProviderProfileDto> = {}): PreviewProviderProfileDto => ({
  ...publicProfileDto(),
  preview: true,
  visibility: 'PRIVATE',
  ...over,
});
export const photoUploadDto = (over: Partial<ProfilePhotoUploadDto> = {}): ProfilePhotoUploadDto => ({
  upload: { url: 'http://127.0.0.1:1/private/profile-photo/one-time.upload?X-Signature=ONE-TIME', headers: { 'content-type': 'image/png' }, expiresAt: T1 },
  maxSizeBytes: 2_097_152,
  revision: 5,
  ...over,
});

export interface ProfileApiCall {
  method: string;
  path: string;
  authorization: string | undefined;
  activeRole: string | undefined;
  ifNoneMatch: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface ProfileApiStub {
  calls: ProfileApiCall[];
  /** The owner's state (null: the owner route answers a profile that does not exist). */
  owner: OwnerProfileStateDto;
  /** The owner's preview (null: 404 PROFILE_NOT_FOUND). */
  preview: PreviewProviderProfileDto | null;
  /** The publicly readable profiles by public id; any other id is a 404 PROFILE_NOT_FOUND (the API never says why). */
  publics: Map<string, PublicProviderProfileDto>;
  /** The owner's photo bytes (null: 404 PROFILE_NOT_FOUND) and the answer's content type and ETag. */
  photo: { bytes: Uint8Array; contentType: string; etag: string } | null;
  createdStatus: 200 | 201;
  revoked: boolean;
  upload: ProfilePhotoUploadDto;
  /** Per-route failure `METHOD /path` (without /api/v1): status, code, category, details. */
  forced: Record<string, { status: number; code: string; category: string; details?: Record<string, unknown> }>;
  /** Sends this JSON body (as is) instead of the data of the route, to prove a contract violation is handled. */
  rawBody: Record<string, unknown>;
  reset(): void;
  profileCalls(): ProfileApiCall[];
}

const fresh = (): Pick<ProfileApiStub, 'owner' | 'preview' | 'publics' | 'photo' | 'createdStatus' | 'revoked' | 'upload' | 'forced' | 'rawBody'> => ({
  owner: ownerStateDto(),
  preview: previewDto(),
  publics: new Map(),
  photo: null,
  createdStatus: 201,
  revoked: false,
  upload: photoUploadDto(),
  forced: {},
  rawBody: {},
});

export function attachProfileApi(stub: ContentStub): ProfileApiStub {
  const api: ProfileApiStub = {
    calls: [],
    ...fresh(),
    reset() {
      api.calls.length = 0;
      Object.assign(api, fresh());
    },
    profileCalls: () => api.calls.filter((c) => c.path.startsWith('/api/v1/provider/profile') || c.path.startsWith('/api/v1/providers/')),
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/v1/provider/profile') && !path.startsWith('/api/v1/providers/')) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    api.calls.push({
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization,
      activeRole: req.headers['x-active-role'] as string | undefined,
      ifNoneMatch: req.headers['if-none-match'] as string | undefined,
      body,
      correlationId,
    });
    const cid = correlationId ?? 'stub-correlation';
    const fail = (status: number, code: string, category: string, details?: Record<string, unknown>): boolean => {
      res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code, category, message: code, correlationId: cid, ...(details ? { details } : {}) } }));
      return true;
    };
    const ok = (data: unknown, status = 200): boolean => {
      res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
      res.statusCode = status;
      res.end(JSON.stringify({ data, meta: { correlationId: cid } }));
      return true;
    };
    const url = path.slice('/api/v1'.length).split('?')[0]!;
    const method = req.method ?? '';
    const route = `${method} ${/^\/providers\/[^/]+$/.test(url) ? '/providers/:id' : url}`;
    const forced = api.forced[route] ?? api.forced[`${method} ${url}`];
    if (forced) return fail(forced.status, forced.code, forced.category, forced.details);
    const raw = api.rawBody[route] ?? api.rawBody[`${method} ${url}`];
    if (raw !== undefined) return ok(raw);

    // the PUBLIC route: no token needed, an Authorization header is ignored, and anything not publicly readable is the SAME 404
    if (route === 'GET /providers/:id') {
      const found = api.publics.get(url.slice('/providers/'.length));
      return found ? ok(PublicProviderProfileResponse.shape.data.parse(found)) : fail(404, 'PROFILE_NOT_FOUND', 'NOT_FOUND');
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.revoked) return fail(401, 'SESSION_REVOKED', 'AUTHENTICATION');
    // a request body that violates the contract is a 400, like the API's strict bodies
    const strict = (schema: { safeParse: (v: unknown) => { success: boolean } }): boolean => schema.safeParse(body).success;
    const invalid = (): boolean => fail(400, 'VALIDATION_FAILED', 'VALIDATION');
    const state = (status = 200): boolean => ok(OwnerProfileStateResponse.shape.data.parse(api.owner), status);
    switch (route) {
      case 'GET /provider/profile':
        return state();
      case 'POST /provider/profile':
        return state(api.createdStatus);
      case 'PATCH /provider/profile':
        return strict(UpdateProviderProfileRequest) ? state() : invalid();
      case 'POST /provider/profile/visibility':
        return strict(SetProfileVisibilityRequest) ? state() : invalid();
      case 'POST /provider/profile/photo/uploads':
        return strict(RequestProfilePhotoUploadRequest) ? ok(ProfilePhotoUploadResponse.shape.data.parse(api.upload), 201) : invalid();
      case 'POST /provider/profile/photo/finalize':
        return strict(FinalizeProfilePhotoRequest) ? state() : invalid();
      case 'DELETE /provider/profile/photo':
        return strict(RemoveProfilePhotoRequest) ? state() : invalid();
      case 'GET /provider/profile/preview':
        return api.preview ? ok(PreviewProviderProfileResponse.shape.data.parse(api.preview)) : fail(404, 'PROFILE_NOT_FOUND', 'NOT_FOUND');
      case 'GET /provider/profile/photo': {
        if (!api.photo) return fail(404, 'PROFILE_NOT_FOUND', 'NOT_FOUND');
        res.setHeader('etag', api.photo.etag).setHeader(CORRELATION_HEADER, cid);
        if (req.headers['if-none-match'] === api.photo.etag) {
          res.statusCode = 304;
          res.end();
          return true;
        }
        res.setHeader('content-type', api.photo.contentType).statusCode = 200;
        res.end(Buffer.from(api.photo.bytes));
        return true;
      }
      default:
        return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
    }
  };
  return api;
}

/** Page copy of the profile pages, worded unlike anything that could be hardcoded in the app (so a test proves the text came from the registry). Keys as migration 0024 seeds them. */
export const PROFILE_PATHS = [
  'title',
  'intro',
  'name.label',
  'name.hint',
  'name.fallback_note',
  'bio.label',
  'bio.hint',
  'photo.heading',
  'photo.hint',
  'photo.upload',
  'photo.remove',
  'photo.none',
  'visibility.heading',
  'visibility.private_note',
  'visibility.public_note',
  'visibility.make_public',
  'visibility.make_private',
  'visibility.not_live_note',
  'visibility.view_public',
  'visibility.also_shown_note',
  'visibility.save_first_note',
  'readiness.heading',
  'readiness.required_heading',
  'readiness.shown_heading',
  'readiness.name',
  'readiness.bio',
  'readiness.photo',
  'readiness.gig',
  'readiness.trust',
  'readiness.complete',
  'preview.heading',
  'preview.note',
  'preview.back',
  'public.gigs_heading',
  'public.no_gigs',
  'public.badges_heading',
  'public.about_heading',
  'public.price_from',
  'public.duration',
  'public.options',
  'public.not_bookable_note',
  'save',
  'notice.created',
  'notice.saved',
  'notice.published',
  'notice.unpublished',
  'notice.photo_added',
  'notice.photo_removed',
] as const;
export const PROFILE_TEXT: Record<string, string> = {
  ...Object.fromEntries(PROFILE_PATHS.map((p) => [profileKey(p), `Registry profile ${p.replaceAll('_', ' ').replaceAll('.', ' ')}`])),
  ...Object.fromEntries(PROFILE_VISIBILITIES.map((v) => [profileVisibilityKey(v), `Registry profile visibility ${v.toLowerCase()}`])),
  ...Object.fromEntries(PROFILE_ERROR_CODES.map((c) => [profileErrorKey(c), `Registry profile error ${c.toLowerCase()}`])),
  ...Object.fromEntries(PROFILE_ISSUE_REASONS.map((r) => [profileIssueKey(r), `Registry profile issue ${r.toLowerCase()}`])),
  ...Object.fromEntries(TRUST_REQUIREMENT_TYPES.map((t) => [profileBadgeKey(t), `Registry badge ${t.toLowerCase()}`])),
  ...Object.fromEntries(GIG_MEDIA_REFUSAL_REASONS.map((r) => [gigMediaRefusedKey(r), `Registry photo refused ${r.toLowerCase()}`])),
  'provider.profile.error.page_unavailable_registration': 'Registry profile page unavailable registration',
  'provider.registration.page.title': 'Registry registration title',
  'provider.gig.editor.yes': 'Registry yes',
  'provider.gig.editor.no': 'Registry no',
  'provider.gig.media.types_note': 'Registry accepted types are shown here.',
  'provider.gig.media.size_note': 'Registry largest size is shown here.',
  'provider.gig.page.title': 'Registry gigs title',
  'catalog.service_type.house_cleaning.name': 'Registry service house cleaning',
};
export const PROFILE_COPY: StubCatalog = {
  'en-US': { ...REGISTRY_COPY['en-US'], ...Object.fromEntries(Object.entries(PROFILE_TEXT).map(([k, value]) => [k, { value }])) },
};
