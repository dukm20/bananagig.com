// Contract-conforming stand-in for the provider Gig endpoints (CAT-003), mounted on the content stub (the real API is exercised by its own integration tests and `pnpm smoke`). It
// behaves like the API where the web app depends on it: the Gig calls need a bearer token, a revoked session is 401 SESSION_REVOKED, a Gig that is not in `details` is a 404, and
// every response is validated against the contract before it is served.
import type http from 'node:http';
import {
  CORRELATION_HEADER,
  GIG_ERROR_CODES,
  GIG_ISSUE_REASONS,
  GIG_MEDIA_REFUSAL_REASONS,
  gigMediaRefusedKey,
  GIG_STATUSES,
  GIG_VERSION_STATUSES,
  GigDetailResponse,
  GigMediaPreviewResponse,
  GigMediaUploadResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  FinalizeGigMediaRequest,
  DetachGigMediaRequest,
  ReorderGigMediaRequest,
  ReplaceGigAddOnsRequest,
  ReplaceGigVariantsRequest,
  RequestGigMediaUploadRequest,
  UpdateGigMediaRequest,
  gigErrorKey,
  gigIssueKey,
  gigStatusKey,
  gigVersionStatusKey,
  type GigDetailDto,
  type GigDto,
  type GigChildSummaryDto,
  type GigFieldDto,
  type GigIssueDto,
  type GigMediaDto,
  type GigMediaUploadDto,
  type GigOptionDto,
  type GigMenuDto,
  type GigMenuItemDto,
  type GigTemplateChoicesDto,
  type GigVersionDto,
  type GigVersionSummaryDto,
} from '@bananagig/contracts';
import type { ContentStub, StubCatalog } from './content-stub';
import { REGISTRY_COPY } from './content-stub';

export const GIG_ID = '5a0c2b9e-7d41-4c3a-9f60-1e8b2d7a4c11';
export const OTHER_GIG_ID = '9d3e6f10-2b74-4a85-8c39-0f1a5e6b7d22';
const T0 = '2026-10-16T09:30:00.000Z';
const T1 = '2026-10-17T10:00:00.000Z';

export const fieldDto = (over: Partial<GigFieldDto> = {}): GigFieldDto => ({
  fieldKey: 'rooms',
  fieldType: 'INTEGER',
  section: 'DETAILS',
  behavior: 'PROVIDER_CONFIGURABLE',
  displayOrder: 1,
  customerVisible: true,
  supported: true,
  required: false,
  fixed: false,
  labelContentKey: 'catalog.gig_template.field.rooms.label',
  helpContentKey: null,
  defaultContentKey: null,
  defaultNumber: null,
  defaultBoolean: null,
  defaultOption: null,
  minLength: null,
  maxLength: null,
  minNumber: null,
  maxNumber: null,
  minItems: null,
  maxItems: null,
  options: [],
  ...over,
});

/** A MEDIA field of the bound template version (CAT-004): `photos` is required with at least one and at most three photos unless overridden. */
export const mediaFieldDto = (over: Partial<GigFieldDto> = {}): GigFieldDto =>
  fieldDto({
    fieldKey: 'photos',
    fieldType: 'MEDIA',
    section: 'DETAILS',
    behavior: 'PROVIDER_REQUIRED',
    required: true,
    displayOrder: 20,
    labelContentKey: 'catalog.gig_template.field.photos.label',
    minItems: 1,
    maxItems: 3,
    ...over,
  });

export const optionDto = (n: number, over: Partial<GigOptionDto> = {}): GigOptionDto => ({
  key: `opt_${String(n).padStart(12, '0')}`,
  name: `Option ${n}`,
  description: null,
  priceDeltaMinor: n * 500,
  durationDeltaMinutes: n * 15,
  displayOrder: n,
  ...over,
});

export const MEDIA_ID = '6c2f9b44-1d7a-4e08-b3a5-7f0e8d1c2a55';
export const mediaDto = (n: number, over: Partial<GigMediaDto> = {}): GigMediaDto => ({
  mediaId: `6c2f9b44-1d7a-4e08-b3a5-7f0e8d1c2a${String(50 + n)}`,
  fieldKey: 'photos',
  displayOrder: n,
  status: 'READY',
  mimeType: 'image/png',
  sizeBytes: 2048,
  width: 800,
  height: 600,
  altText: null,
  ...over,
});

export const childSummary = (over: Partial<GigChildSummaryDto> = {}): GigChildSummaryDto => ({
  variantCount: 0,
  addOnCount: 0,
  mediaCount: 0,
  variantsValid: true,
  addOnsValid: true,
  mediaRequirementSatisfied: true,
  ...over,
});
/** The children facts a version's own lists imply (valid unless overridden). */
export const childrenOf = (v: Pick<GigVersionDto, 'variants' | 'addOns' | 'media'>, over: Partial<GigChildSummaryDto> = {}): GigChildSummaryDto =>
  childSummary({ variantCount: v.variants.length, addOnCount: v.addOns.length, mediaCount: v.media.length, ...over });

export const issueDto = (over: Partial<GigIssueDto> = {}): GigIssueDto => ({
  target: 'title',
  reason: 'TITLE_REQUIRED',
  messageKey: gigIssueKey('TITLE_REQUIRED'),
  ...over,
});

export const versionDto = (over: Partial<GigVersionDto> = {}): GigVersionDto => ({
  gigVersionId: '3f9c1d70-5b2e-4e18-a4d6-8c7b0a9e1f33',
  versionNumber: 1,
  status: 'DRAFT',
  statusKey: gigVersionStatusKey('DRAFT'),
  revision: 3,
  gigTemplateVersionNumber: 2,
  title: null,
  createdAt: T0,
  updatedAt: T0,
  publishedAt: null,
  supersededAt: null,
  retiredAt: null,
  shortPitch: null,
  description: null,
  price: null,
  durationMinutes: null,
  fieldValues: [],
  template: {
    gigTemplateCode: 'deep_clean',
    gigTemplateVersionId: '8b1d4e92-6c03-4f57-b2a8-3d9e7c5a1b44',
    gigTemplateVersionNumber: 2,
    versionStatus: 'ACTIVE',
    templateStatus: 'ACTIVE',
    serviceTypeCode: 'house_cleaning',
    categoryCode: 'home_services',
    nameContentKey: 'catalog.gig_template.deep_clean.name',
    descriptionContentKey: null,
    instructionsContentKey: null,
    requirements: [],
  },
  fields: [],
  constraints: {
    title: { maxLength: 100 },
    shortPitch: { maxLength: 1000 },
    description: { maxLength: 5000 },
    price: { permitted: true, required: true, currency: 'USD' },
    duration: { permitted: true, required: true, minMinutes: 30, maxMinutes: 480, suggestedMinutes: 120 },
    variants: { permitted: true, maxCount: 10, nameMaxLength: 80, descriptionMaxLength: 500 },
    addOns: { permitted: true, maxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 },
    media: {
      permitted: true,
      maxItems: 50,
      maxFileSizeBytes: 10_485_760,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      minEdgePixels: 200,
      maxEdgePixels: 12_000,
      altTextMaxLength: 200,
    },
  },
  variants: [],
  addOns: [],
  media: [],
  children: childSummary(),
  publishable: false,
  issues: [],
  ...over,
});
/** A complete published version (what the page shows as the current one). */
export const publishedVersionDto = (over: Partial<GigVersionDto> = {}): GigVersionDto =>
  versionDto({
    status: 'PUBLISHED',
    statusKey: gigVersionStatusKey('PUBLISHED'),
    title: 'Spotless two-room clean',
    shortPitch: 'We bring everything.',
    description: 'A thorough clean of up to two rooms.\nSecond line.',
    price: { amountMinor: 12500, currency: 'USD' },
    durationMinutes: 120,
    publishedAt: T1,
    publishable: null,
    ...over,
  });
export const summaryOf = (v: GigVersionDto): GigVersionSummaryDto => ({
  gigVersionId: v.gigVersionId,
  versionNumber: v.versionNumber,
  status: v.status,
  statusKey: v.statusKey,
  revision: v.revision,
  gigTemplateVersionNumber: v.gigTemplateVersionNumber,
  title: v.title,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
  publishedAt: v.publishedAt,
  supersededAt: v.supersededAt,
  retiredAt: v.retiredAt,
});
export const gigDto = (over: Partial<GigDto> = {}): GigDto => ({
  gigId: GIG_ID,
  status: 'DRAFT',
  statusKey: gigStatusKey('DRAFT'),
  gigTemplateCode: 'deep_clean',
  serviceTypeCode: 'house_cleaning',
  categoryCode: 'home_services',
  nameContentKey: 'catalog.gig_template.deep_clean.name',
  createdAt: T0,
  updatedAt: T0,
  retiredAt: null,
  ...over,
});
/** A detail whose versions list is derived from the current and draft versions. */
export const detailDto = (
  o: { gig?: Partial<GigDto>; current?: GigVersionDto | null; draft?: GigVersionDto | null; extraVersions?: GigVersionSummaryDto[] } = {},
): GigDetailDto => {
  const current = o.current ?? null;
  const draft = o.draft ?? null;
  return {
    gig: gigDto({ status: current ? 'ACTIVE' : 'DRAFT', statusKey: gigStatusKey(current ? 'ACTIVE' : 'DRAFT'), ...o.gig }),
    currentVersion: current,
    draftVersion: draft,
    versions: [...(draft ? [summaryOf(draft)] : []), ...(current ? [summaryOf(current)] : []), ...(o.extraVersions ?? [])].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    ),
  };
};
export const menuItemDto = (d: GigDetailDto): GigMenuItemDto => ({
  gig: d.gig,
  currentVersion: d.currentVersion
    ? {
        versionNumber: d.currentVersion.versionNumber,
        title: d.currentVersion.title,
        shortPitch: d.currentVersion.shortPitch,
        price: d.currentVersion.price,
        durationMinutes: d.currentVersion.durationMinutes,
        publishedAt: d.currentVersion.publishedAt ?? T1,
        children: d.currentVersion.children,
      }
    : null,
  draftVersion: d.draftVersion
    ? {
        versionNumber: d.draftVersion.versionNumber,
        revision: d.draftVersion.revision,
        title: d.draftVersion.title,
        updatedAt: d.draftVersion.updatedAt,
        children: d.draftVersion.children,
      }
    : null,
  versionCount: d.versions.length,
});
export const menuDto = (items: GigMenuItemDto[] = [], over: Partial<GigMenuDto> = {}): GigMenuDto => ({
  gigs: items,
  readiness: {
    hasPublishedGig: items.some((i) => i.currentVersion),
    publishedGigCount: items.filter((i) => i.currentVersion).length,
    draftVersionCount: items.filter((i) => i.draftVersion).length,
    goLive: { evaluated: false, eligible: false },
  },
  limits: {
    maxActive: 25,
    maxDrafts: 10,
    activeCount: items.filter((i) => i.gig.status === 'ACTIVE').length,
    draftCount: items.filter((i) => i.draftVersion).length,
  },
  canCreate: true,
  cannotCreateReason: null,
  ...over,
});
export const choicesDto = (codes: Array<[string, string]> = [['deep_clean', 'house_cleaning']]): GigTemplateChoicesDto => ({
  marketCode: 'us-orange-county',
  templates: codes.map(([code, service]) => ({
    gigTemplateCode: code,
    serviceTypeCode: service,
    categoryCode: 'home_services',
    nameContentKey: `catalog.gig_template.${code}.name`,
    descriptionContentKey: null,
    gigTemplateVersionNumber: 1,
  })),
});

export interface GigApiCall {
  method: string;
  path: string;
  authorization: string | undefined;
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface GigApiStub {
  calls: GigApiCall[];
  menu: GigMenuDto;
  choices: GigTemplateChoicesDto;
  /** The caller's Gigs by id; any other id is a 404 GIG_NOT_FOUND (the API never says whether it exists for someone else). */
  details: Map<string, GigDetailDto>;
  /** Versions by `<gigId>/<number>`. */
  versions: Map<string, GigVersionDto>;
  createdStatus: 200 | 201;
  revoked: boolean;
  /** Per-route failure `METHOD /path` (without /api/v1): status, code, category. */
  forced: Record<string, { status: number; code: string; category: string }>;
  /** Sends this JSON body (as is) instead of the data of the route, to prove a contract violation is handled. */
  rawBody: Record<string, unknown>;
  /** The answer of `POST .../draft/media/uploads` (CAT-004). */
  upload: GigMediaUploadDto;
  /** The one-object GET target the preview routes answer with, by media id (a media id that is not here is a 404 GIG_MEDIA_NOT_FOUND). */
  previews: Map<string, string>;
  reset(): void;
  gigCalls(): GigApiCall[];
}

export const uploadDto = (over: Partial<GigMediaUploadDto> = {}): GigMediaUploadDto => ({
  media: mediaDto(9, { status: 'UPLOADING', mimeType: 'image/png', sizeBytes: 100, width: null, height: null }),
  upload: { url: 'http://127.0.0.1:1/private/gig-media/one-time.upload?X-Signature=ONE-TIME', headers: { 'content-type': 'image/png' }, expiresAt: T1 },
  maxSizeBytes: 10_485_760,
  revision: 4,
  ...over,
});

const fresh = (): Pick<
  GigApiStub,
  'menu' | 'choices' | 'details' | 'versions' | 'createdStatus' | 'revoked' | 'forced' | 'rawBody' | 'upload' | 'previews'
> => ({
  menu: menuDto(),
  choices: choicesDto(),
  details: new Map(),
  versions: new Map(),
  createdStatus: 201,
  revoked: false,
  forced: {},
  rawBody: {},
  upload: uploadDto(),
  previews: new Map(),
});

export function attachGigApi(stub: ContentStub): GigApiStub {
  const api: GigApiStub = {
    calls: [],
    ...fresh(),
    reset() {
      api.calls.length = 0;
      Object.assign(api, fresh());
    },
    gigCalls: () => api.calls.filter((c) => c.path.startsWith('/api/v1/provider/gig')),
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/v1/provider/gig')) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    api.calls.push({
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization,
      activeRole: req.headers['x-active-role'] as string | undefined,
      body,
      correlationId,
    });
    const cid = correlationId ?? 'stub-correlation';
    res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
    const fail = (status: number, code: string, category: string): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code, category, message: code, correlationId: cid } }));
      return true;
    };
    const ok = (data: unknown, status = 200): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ data, meta: { correlationId: cid } }));
      return true;
    };
    const url = path.slice('/api/v1'.length).split('?')[0]!;
    const m = /^\/provider\/gigs\/([^/]+)(\/versions(?:\/([^/]+))?|\/draft|\/publish|\/retire)?$/.exec(url);
    // CAT-004: the child routes of the draft and the preview of a version's photo
    const child =
      /^\/provider\/gigs\/([^/]+)\/(?:draft\/(variants|add-ons|media\/uploads|media\/order|media\/([^/]+)(?:\/(finalize|preview))?)|versions\/([^/]+)\/media\/([^/]+)\/preview)$/.exec(
        url,
      );
    let tail: string | undefined;
    if (child) {
      const [, , kind, mediaId, sub, versionNo] = child;
      tail = versionNo ? '/versions/:version/media/:mediaId/preview' : mediaId ? `/draft/media/:mediaId${sub ? `/${sub}` : ''}` : `/draft/${kind}`;
    }
    const route = `${req.method ?? ''} ${child ? `/provider/gigs/:gigId${tail}` : m ? `/provider/gigs/:gigId${m[2] ? (m[3] ? '/versions/:version' : m[2]) : ''}` : url}`;
    const forced = api.forced[route] ?? api.forced[`${req.method ?? ''} ${url}`];
    if (forced) return fail(forced.status, forced.code, forced.category);
    const raw = api.rawBody[route] ?? api.rawBody[`${req.method ?? ''} ${url}`];
    if (raw !== undefined) return ok(raw);
    if (!req.headers.authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.revoked) return fail(401, 'SESSION_REVOKED', 'AUTHENTICATION');
    const detail = (id: string): GigDetailDto | undefined => api.details.get(id);
    const notFound = (): boolean => fail(404, 'GIG_NOT_FOUND', 'NOT_FOUND');
    const detailOut = (id: string, status = 200): boolean => {
      const d = detail(id);
      return d ? ok(GigDetailResponse.shape.data.parse(d), status) : notFound();
    };
    // a request body that violates the contract is a 400, like the API's strict bodies
    const strict = (schema: { safeParse: (v: unknown) => { success: boolean } }): boolean => schema.safeParse(body).success;
    const invalid = (): boolean => fail(400, 'VALIDATION_FAILED', 'VALIDATION');
    switch (route) {
      case 'GET /provider/gig-templates':
        return ok(GigTemplateChoicesResponse.shape.data.parse(api.choices));
      case 'GET /provider/gigs':
        return ok(GigMenuResponse.shape.data.parse(api.menu));
      case 'POST /provider/gigs': {
        const id = [...api.details.keys()][0];
        return id ? detailOut(id, api.createdStatus) : notFound();
      }
      case 'GET /provider/gigs/:gigId':
      case 'PUT /provider/gigs/:gigId/draft':
      case 'POST /provider/gigs/:gigId/publish':
      case 'POST /provider/gigs/:gigId/retire':
        return detailOut(m![1]!);
      case 'POST /provider/gigs/:gigId/versions':
        return detailOut(m![1]!, 201);
      case 'GET /provider/gigs/:gigId/versions/:version': {
        const v = api.versions.get(`${m![1]}/${m![3]}`);
        return v && detail(m![1]!) ? ok(GigVersionResponse.shape.data.parse(v)) : fail(404, 'GIG_VERSION_NOT_FOUND', 'NOT_FOUND');
      }
      case 'PUT /provider/gigs/:gigId/draft/variants':
        return strict(ReplaceGigVariantsRequest) ? detailOut(child![1]!) : invalid();
      case 'PUT /provider/gigs/:gigId/draft/add-ons':
        return strict(ReplaceGigAddOnsRequest) ? detailOut(child![1]!) : invalid();
      case 'POST /provider/gigs/:gigId/draft/media/uploads':
        if (!strict(RequestGigMediaUploadRequest)) return invalid();
        return detail(child![1]!) ? ok(GigMediaUploadResponse.shape.data.parse(api.upload), 201) : notFound();
      case 'POST /provider/gigs/:gigId/draft/media/:mediaId/finalize':
        return strict(FinalizeGigMediaRequest) ? detailOut(child![1]!) : invalid();
      case 'PUT /provider/gigs/:gigId/draft/media/:mediaId':
        return strict(UpdateGigMediaRequest) ? detailOut(child![1]!) : invalid();
      case 'DELETE /provider/gigs/:gigId/draft/media/:mediaId':
        return strict(DetachGigMediaRequest) ? detailOut(child![1]!) : invalid();
      case 'PUT /provider/gigs/:gigId/draft/media/order':
        return strict(ReorderGigMediaRequest) ? detailOut(child![1]!) : invalid();
      case 'GET /provider/gigs/:gigId/draft/media/:mediaId/preview':
      case 'GET /provider/gigs/:gigId/versions/:version/media/:mediaId/preview': {
        if (!detail(child![1]!)) return notFound();
        const target = api.previews.get(child![3] ?? child![6]!);
        return target ? ok(GigMediaPreviewResponse.shape.data.parse({ url: target, expiresAt: T1 })) : fail(404, 'GIG_MEDIA_NOT_FOUND', 'NOT_FOUND');
      }
      default:
        return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
    }
  };
  return api;
}

/** Registry copy of the Gig pages, worded unlike anything that could be hardcoded in the app (so a test proves the text came from the registry). */
const editorKeys = [
  'heading',
  'title',
  'title_hint',
  'short_pitch',
  'short_pitch_hint',
  'description',
  'description_hint',
  'price',
  'price_hint',
  'currency',
  'duration',
  'duration_hint',
  'fields_heading',
  'fixed_heading',
  'fixed_note',
  'unsupported_note',
  'required',
  'optional',
  'save',
  'publish',
  'retire',
  'retire_note',
  'new_draft',
  'back',
  'issues_heading',
  'history_heading',
  'version',
  'template',
  'template_version',
  'published_at',
  'not_editable',
  'draft_heading',
  'current_heading',
  'yes',
  'no',
  'select_empty',
];
const menuKeys = [
  'empty',
  'not_eligible',
  'draft_limit',
  'not_live_note',
  'limits_heading',
  'limit_active',
  'limit_drafts',
  'open',
  'current_version',
  'draft_version',
  'no_published',
  'price',
  'duration',
  'heading',
];
const createKeys = ['heading', 'template', 'submit', 'none_available'];
const noticeKeys = [
  'created',
  'saved',
  'published',
  'draft_created',
  'retired',
  'variants_saved',
  'add_ons_saved',
  'photo_added',
  'photo_removed',
  'photo_order_saved',
  'photo_saved',
];
/** CAT-004 UI labels (section 8 of the checkpoint spec). */
const optionsKeys = [
  'variants.heading',
  'variants.intro',
  'add_ons.heading',
  'add_ons.intro',
  'empty',
  'not_permitted',
  'name',
  'description',
  'price_delta',
  'duration_delta',
  'add',
  'remove',
  'move_up',
  'move_down',
  'save',
  'limit_note',
  'delta_note',
];
const mediaKeys = [
  'heading',
  'intro',
  'rule_required',
  'rule_optional',
  'rule_prohibited',
  'no_field',
  'count',
  'status_uploading',
  'status_ready',
  'upload',
  'file',
  'alt_text',
  'alt_hint',
  'save_alt',
  'remove',
  'move_up',
  'move_down',
  'finish',
  'preview',
  'types_note',
  'size_note',
  'unavailable',
];
const menuChildKeys = ['variants', 'add_ons', 'photos', 'photos_missing'];
export const GIG_TEXT: Record<string, string> = {
  'provider.gig.page.title': 'Registry gigs title',
  'provider.gig.page.intro': 'Registry gigs intro',
  ...Object.fromEntries(editorKeys.map((s) => [`provider.gig.editor.${s}`, `Registry editor ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(menuKeys.map((s) => [`provider.gig.menu.${s}`, `Registry menu ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(optionsKeys.map((s) => [`provider.gig.options.${s}`, `Registry options ${s.replaceAll('_', ' ').replaceAll('.', ' ')}`])),
  ...Object.fromEntries(mediaKeys.map((s) => [`provider.gig.media.${s}`, `Registry media ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(menuChildKeys.map((s) => [`provider.gig.menu.${s}`, `Registry menu ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(createKeys.map((s) => [`provider.gig.create.${s}`, `Registry create ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(noticeKeys.map((s) => [`provider.gig.notice.${s}`, `Registry notice ${s.replaceAll('_', ' ')}`])),
  ...Object.fromEntries(GIG_STATUSES.map((s) => [gigStatusKey(s), `Registry gig state ${s.toLowerCase()}`])),
  ...Object.fromEntries(GIG_VERSION_STATUSES.map((s) => [gigVersionStatusKey(s), `Registry version state ${s.toLowerCase()}`])),
  ...Object.fromEntries(GIG_ERROR_CODES.map((c) => [gigErrorKey(c), `Registry gig error ${c.toLowerCase()}`])),
  ...Object.fromEntries(GIG_MEDIA_REFUSAL_REASONS.map((r) => [gigMediaRefusedKey(r), `Registry photo refused ${r.toLowerCase()}`])),
  ...Object.fromEntries(GIG_ISSUE_REASONS.map((r) => [gigIssueKey(r), `Registry issue ${r.toLowerCase()}`])),
  'catalog.gig_template.deep_clean.name': 'Registry template deep clean',
  'catalog.gig_template.window_wash.name': 'Registry template window wash',
  'catalog.gig_template.field.rooms.label': 'Registry field rooms',
};
export const GIG_COPY: StubCatalog = {
  'en-US': { ...REGISTRY_COPY['en-US'], ...Object.fromEntries(Object.entries(GIG_TEXT).map(([k, value]) => [k, { value }])) },
};
