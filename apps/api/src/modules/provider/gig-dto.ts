// Provider Gig API shaping and error mapping (CAT-003). Every mapper builds the response field by field: the service already shapes its view, but the API never relies on that alone.
// The only provider-written text in any response is the title, the short pitch, the description and the text field values of the caller's OWN Gig; an error never carries one.
import {
  GIG_ISSUE_REASONS,
  GigIssueDto as GigIssueSchema,
  gigErrorKey,
  gigIssueKey,
  type GigDetailDto,
  type GigDto,
  type GigErrorCode,
  type GigFieldDto,
  type GigIssueDto,
  type GigIssueReason,
  type GigMenuDto,
  type GigMenuItemDto,
  type GigTemplateChoicesDto,
  type GigTemplateLinkDto,
  type GigVersionDto,
  type GigVersionSummaryDto,
} from '@bananagig/contracts';
import { GigError, ProviderError } from '@bananagig/provider';
import { AppError } from '../../errors';

const priceDto = (p: { amountMinor: number; currency: string } | null) => (p === null ? null : { amountMinor: p.amountMinor, currency: p.currency });

export const gigDto = (g: GigDto): GigDto => ({
  gigId: g.gigId,
  status: g.status,
  statusKey: g.statusKey,
  gigTemplateCode: g.gigTemplateCode,
  serviceTypeCode: g.serviceTypeCode,
  categoryCode: g.categoryCode,
  nameContentKey: g.nameContentKey,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
  retiredAt: g.retiredAt,
});

export const versionSummaryDto = (v: GigVersionSummaryDto): GigVersionSummaryDto => ({
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

const templateLinkDto = (t: GigTemplateLinkDto): GigTemplateLinkDto => ({
  gigTemplateCode: t.gigTemplateCode,
  gigTemplateVersionId: t.gigTemplateVersionId,
  gigTemplateVersionNumber: t.gigTemplateVersionNumber,
  versionStatus: t.versionStatus,
  templateStatus: t.templateStatus,
  serviceTypeCode: t.serviceTypeCode,
  categoryCode: t.categoryCode,
  nameContentKey: t.nameContentKey,
  descriptionContentKey: t.descriptionContentKey,
  instructionsContentKey: t.instructionsContentKey,
  requirements: t.requirements.map((r) => ({ requirementType: r.requirementType, referenceCode: r.referenceCode })),
});

const fieldDto = (f: GigFieldDto): GigFieldDto => ({
  fieldKey: f.fieldKey,
  fieldType: f.fieldType,
  section: f.section,
  behavior: f.behavior,
  displayOrder: f.displayOrder,
  customerVisible: f.customerVisible,
  supported: f.supported,
  required: f.required,
  fixed: f.fixed,
  labelContentKey: f.labelContentKey,
  helpContentKey: f.helpContentKey,
  defaultContentKey: f.defaultContentKey,
  defaultNumber: f.defaultNumber,
  defaultBoolean: f.defaultBoolean,
  defaultOption: f.defaultOption,
  minLength: f.minLength,
  maxLength: f.maxLength,
  minNumber: f.minNumber,
  maxNumber: f.maxNumber,
  options: f.options.map((o) => ({
    optionCode: o.optionCode,
    displayOrder: o.displayOrder,
    isDefault: o.isDefault,
    ...(o.labelContentKey === undefined ? {} : { labelContentKey: o.labelContentKey }),
  })),
});

/** The issue is rebuilt from its identifiers: the message KEY is derived from the reason here, never trusted from the service. */
const SAFE_FIELD_KEY = /^[a-z][a-z0-9_]{1,31}$/;
const ISSUE_REASON = new Set<string>(GIG_ISSUE_REASONS);
const ISSUE_TARGETS = new Set<string>(GigIssueSchema.shape.target.options);
export const issueDto = (i: GigIssueDto): GigIssueDto => ({
  target: i.target,
  ...(i.fieldKey !== undefined && SAFE_FIELD_KEY.test(i.fieldKey) ? { fieldKey: i.fieldKey } : {}),
  reason: i.reason,
  messageKey: gigIssueKey(i.reason),
});

export const versionDto = (v: GigVersionDto): GigVersionDto => ({
  ...versionSummaryDto(v),
  shortPitch: v.shortPitch,
  description: v.description,
  price: priceDto(v.price),
  durationMinutes: v.durationMinutes,
  fieldValues: v.fieldValues.map((f) => ({ fieldKey: f.fieldKey, value: f.value })),
  template: templateLinkDto(v.template),
  fields: v.fields.map(fieldDto),
  constraints: {
    title: { maxLength: v.constraints.title.maxLength },
    shortPitch: { maxLength: v.constraints.shortPitch.maxLength },
    description: { maxLength: v.constraints.description.maxLength },
    price: { permitted: v.constraints.price.permitted, required: v.constraints.price.required, currency: v.constraints.price.currency },
    duration: {
      permitted: v.constraints.duration.permitted,
      required: v.constraints.duration.required,
      minMinutes: v.constraints.duration.minMinutes,
      maxMinutes: v.constraints.duration.maxMinutes,
      suggestedMinutes: v.constraints.duration.suggestedMinutes,
    },
  },
  publishable: v.publishable,
  issues: v.issues.map(issueDto),
});

export const detailDto = (d: GigDetailDto): GigDetailDto => ({
  gig: gigDto(d.gig),
  currentVersion: d.currentVersion === null ? null : versionDto(d.currentVersion),
  draftVersion: d.draftVersion === null ? null : versionDto(d.draftVersion),
  versions: d.versions.map(versionSummaryDto),
});

const menuItemDto = (m: GigMenuItemDto): GigMenuItemDto => ({
  gig: gigDto(m.gig),
  currentVersion:
    m.currentVersion === null
      ? null
      : {
          versionNumber: m.currentVersion.versionNumber,
          title: m.currentVersion.title,
          shortPitch: m.currentVersion.shortPitch,
          price: priceDto(m.currentVersion.price),
          durationMinutes: m.currentVersion.durationMinutes,
          publishedAt: m.currentVersion.publishedAt,
        },
  draftVersion:
    m.draftVersion === null
      ? null
      : { versionNumber: m.draftVersion.versionNumber, revision: m.draftVersion.revision, title: m.draftVersion.title, updatedAt: m.draftVersion.updatedAt },
  versionCount: m.versionCount,
});

export const menuDto = (m: GigMenuDto): GigMenuDto => ({
  gigs: m.gigs.map(menuItemDto),
  readiness: {
    hasPublishedGig: m.readiness.hasPublishedGig,
    publishedGigCount: m.readiness.publishedGigCount,
    draftVersionCount: m.readiness.draftVersionCount,
    // Go-Live is PRO-003: whatever the service says, this API never reports a provider as live or eligible
    goLive: { evaluated: false, eligible: false },
  },
  limits: {
    maxActive: m.limits.maxActive,
    maxDrafts: m.limits.maxDrafts,
    activeCount: m.limits.activeCount,
    draftCount: m.limits.draftCount,
  },
  canCreate: m.canCreate,
  cannotCreateReason: m.cannotCreateReason,
});

export const choicesDto = (c: GigTemplateChoicesDto): GigTemplateChoicesDto => ({
  marketCode: c.marketCode,
  templates: c.templates.map((t) => ({
    gigTemplateCode: t.gigTemplateCode,
    serviceTypeCode: t.serviceTypeCode,
    categoryCode: t.categoryCode,
    nameContentKey: t.nameContentKey,
    descriptionContentKey: t.descriptionContentKey,
    gigTemplateVersionNumber: t.gigTemplateVersionNumber,
  })),
});

// ---------------------------------------------------------------- errors
/**
 * The ONLY service details that reach a client: an ALLOW-list of short machine tokens (`reason`, `field`, `code`), `retryable`, small integer bounds (`limit`, `max`, `count`) and the
 * issues of a refused value or a blocked publish (target, field key, reason, message KEY: identifiers only). Anything else a future service change might put in `details` (a cause,
 * SQL, a value, provider text) is dropped here.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ISSUES = 64;
export function safeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reason', 'field', 'code'] as const) {
    const v = details[key];
    if (typeof v === 'string' && SAFE_TOKEN.test(v)) out[key] = v;
  }
  if (details.retryable === true) out.retryable = true;
  for (const key of ['limit', 'max', 'count'] as const) {
    const v = details[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000) out[key] = v;
  }
  if (Array.isArray(details.issues)) {
    const issues: GigIssueDto[] = [];
    for (const raw of details.issues) {
      if (issues.length >= MAX_ISSUES) break;
      if (raw === null || typeof raw !== 'object') continue;
      const i = raw as Record<string, unknown>;
      if (typeof i.target !== 'string' || !ISSUE_TARGETS.has(i.target) || typeof i.reason !== 'string' || !ISSUE_REASON.has(i.reason)) continue;
      issues.push(
        issueDto({
          target: i.target as GigIssueDto['target'],
          ...(typeof i.fieldKey === 'string' ? { fieldKey: i.fieldKey } : {}),
          reason: i.reason as GigIssueReason,
          messageKey: '',
        }),
      );
    }
    if (issues.length > 0) out.issues = issues;
  }
  return out;
}

type Category = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'AUTHORIZATION' | 'DEPENDENCY';
/** PUBLISH_BLOCKED is a conflict-class refusal (409): the repository's error model has no 422. */
const MESSAGES: Record<GigErrorCode, { category: Category; message: string }> = {
  GIG_NOT_FOUND: { category: 'NOT_FOUND', message: 'The Gig was not found' },
  GIG_VERSION_NOT_FOUND: { category: 'NOT_FOUND', message: 'The Gig version was not found' },
  GIG_TEMPLATE_NOT_FOUND: { category: 'NOT_FOUND', message: 'The Gig Template was not found' },
  GIG_TEMPLATE_NOT_AVAILABLE: { category: 'CONFLICT', message: 'The Gig Template is not available for a new Gig' },
  PROVIDER_NOT_ELIGIBLE: { category: 'AUTHORIZATION', message: 'The account cannot create Gigs yet' },
  ACCOUNT_NOT_ACTIVE: { category: 'AUTHORIZATION', message: 'The account is not active' },
  GIG_RETIRED: { category: 'CONFLICT', message: 'The Gig is retired' },
  DRAFT_EXISTS: { category: 'CONFLICT', message: 'The Gig already has a draft' },
  NO_DRAFT: { category: 'CONFLICT', message: 'The Gig has no draft' },
  STALE_DRAFT: { category: 'CONFLICT', message: 'The draft changed since it was read' },
  PUBLISH_BLOCKED: { category: 'CONFLICT', message: 'The draft cannot be published yet' },
  LIMIT_REACHED: { category: 'CONFLICT', message: 'A configured limit on Gigs was reached' },
  VALIDATION_FAILED: { category: 'VALIDATION', message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', message: 'Gigs are temporarily unavailable' },
};

/** The public error code of a Gig failure: the contract code itself when it already starts with `GIG_`, otherwise `GIG_<code>` (the web keeps a closed list built the same way). */
export const gigApiErrorCode = (code: GigErrorCode): string => (code.startsWith('GIG_') ? code : `GIG_${code}`);

/** Maps typed Gig failures onto the standard API error model: fixed messages, a message KEY for the web, and allow-listed details. */
export function toAppError(err: unknown): never {
  // the account port reports its own outages and refusals as ProviderError: translate them to the Gig vocabulary (never a 500)
  if (err instanceof ProviderError) {
    if (err.code === 'ACCOUNT_NOT_ACTIVE') err = new GigError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
    else if (err.code === 'CONFLICT')
      err = new GigError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
    else err = new GigError('UNAVAILABLE', 'Gigs are unavailable');
  }
  if (!(err instanceof GigError)) throw err;
  const m = MESSAGES[err.code];
  if (!m) throw err;
  if (err.code === 'UNAVAILABLE') throw new AppError('DEPENDENCY', gigApiErrorCode(err.code), m.message, { messageKey: gigErrorKey(err.code) });
  throw new AppError(m.category, gigApiErrorCode(err.code), m.message, { ...safeDetails(err.details), messageKey: gigErrorKey(err.code) });
}
