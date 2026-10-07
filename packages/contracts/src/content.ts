// Public contracts of the content registry (docs/engineering/CONTENT.md): managed product copy as stable keys with localized,
// effective-dated, immutable versions. Machine identifiers only in events; copy text never appears in events or audit.
import { z } from 'zod';
import { ApprovalPolicy, Criticality } from './configuration';
import { envelope } from './envelope';
import { adminText } from './text';

// ---------------------------------------------------------------- locales
/** Canonical BCP 47 subset: language[-Script][-REGION] (for example en-US, es-US, es, zh-Hant-TW). No variants or extensions yet. The database CHECK is identical. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
export const Locale = z.string().max(20).regex(LOCALE_PATTERN);
export type Locale = z.infer<typeof Locale>;

/**
 * Canonicalizes a locale tag to the form used everywhere (language lower-case, Script title-case, REGION upper-case, hyphen separated).
 * Returns null when the tag is not in the supported BCP 47 subset. Underscores are rejected on purpose (en_US is not BCP 47).
 */
export function canonicalizeLocale(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const parts = input.split('-'); // strict: padded or control-character input is rejected, not trimmed
  if (parts.length < 1 || parts.length > 3) return null;
  const out: string[] = [parts[0]!.toLowerCase()];
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(part)) out.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    else if (/^[A-Za-z]{2}$/.test(part)) out.push(part.toUpperCase());
    else if (/^[0-9]{3}$/.test(part)) out.push(part);
    else return null;
  }
  const tag = out.join('-');
  return tag.length <= 20 && LOCALE_PATTERN.test(tag) ? tag : null;
}

// ---------------------------------------------------------------- scopes (centrally managed copy only; gig/provider text is domain data)
export const CONTENT_SCOPE_TYPES = ['PLATFORM', 'COUNTRY', 'MARKET'] as const;
export const ContentScopeType = z.enum(CONTENT_SCOPE_TYPES);
export type ContentScopeType = z.infer<typeof ContentScopeType>;
const scopeRef = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

/** Resolution context: which country/market applies, and the market's default locale when the caller knows it (supplied by geography once it exists). */
export const ContentContext = z.object({ country: scopeRef, market: scopeRef, marketDefaultLocale: Locale }).partial().strict();
export type ContentContext = z.infer<typeof ContentContext>;

// ---------------------------------------------------------------- entries
export const CONTENT_TYPES = [
  'PLAIN_TEXT',
  'RICH_TEXT',
  'MARKDOWN',
  'EMAIL_SUBJECT',
  'EMAIL_BODY',
  'PUSH_TITLE',
  'PUSH_BODY',
  'LEGAL',
  'HELP_ARTICLE',
  'UI_LABEL',
] as const;
export const ContentType = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof ContentType>;
/** Types rendered to sanitized HTML from the restricted Markdown subset; all others render to plain text. */
export const MARKUP_CONTENT_TYPES: readonly ContentType[] = ['RICH_TEXT', 'MARKDOWN', 'EMAIL_BODY', 'LEGAL', 'HELP_ARTICLE'];
/** RICH_TEXT is inline-only markup (emphasis, links, line breaks); the other markup types also allow blocks (paragraphs, headings, lists, quotes). */
export const INLINE_ONLY_CONTENT_TYPES: readonly ContentType[] = ['RICH_TEXT'];

export const CONTENT_OWNER_ROLES = ['CONTENT', 'LEGAL', 'SUPPORT', 'MARKETING'] as const;
export const ContentOwnerRole = z.enum(CONTENT_OWNER_ROLES);
export type ContentOwnerRole = z.infer<typeof ContentOwnerRole>;
export const ContentSensitivity = z.enum(['PUBLIC', 'INTERNAL']);
export type ContentSensitivity = z.infer<typeof ContentSensitivity>;
export const FALLBACK_POLICIES = ['CHAIN', 'LANGUAGE_ONLY', 'EXACT'] as const;
export const FallbackPolicy = z.enum(FALLBACK_POLICIES);
export type FallbackPolicy = z.infer<typeof FallbackPolicy>;

export const ContentKey = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/);

// ---------------------------------------------------------------- template variables
export const VARIABLE_TYPES = ['STRING', 'NUMBER', 'MONEY', 'DATE', 'TIME', 'DATETIME', 'URL', 'PERSON_DISPLAY_NAME', 'COUNT'] as const;
export const VariableType = z.enum(VARIABLE_TYPES);
export type VariableType = z.infer<typeof VariableType>;
export const PII_CLASSES = ['NONE', 'PERSONAL', 'SENSITIVE_PERSONAL'] as const;
export const PiiClass = z.enum(PII_CLASSES);
export type PiiClass = z.infer<typeof PiiClass>;
export const VariableName = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/);

/**
 * Canonical value encodings (what callers pass in `variables`):
 *  STRING, PERSON_DISPLAY_NAME, URL: string. NUMBER: finite number or decimal string. COUNT: non-negative integer.
 *  MONEY: { amount_minor: integer, currency: ISO-4217 } (never a pre-formatted or floating-point amount).
 *  DATE: 'YYYY-MM-DD'. TIME: 'HH:mm' or 'HH:mm:ss'. DATETIME: ISO-8601 instant with offset or Z.
 */
export const MoneyVariable = z.object({ amount_minor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const VariableDefinition = z.object({
  name: VariableName,
  type: VariableType,
  required: z.boolean().default(true),
  description: z.string().min(1).max(300),
  /** Example/test value in the canonical encoding; used to dry-render every draft. */
  example: z.unknown(),
  piiClass: PiiClass.default('NONE'),
});
export type VariableDefinition = z.infer<typeof VariableDefinition>;
export const VariableDefinitionDto = z.object({
  name: z.string(),
  type: VariableType,
  required: z.boolean(),
  description: z.string(),
  example: z.unknown(),
  piiClass: PiiClass,
});
export type VariableDefinitionDto = z.infer<typeof VariableDefinitionDto>;
/** Values for one entry's variables, by variable name. */
export const VariableValues = z.record(VariableName, z.unknown());
export type VariableValues = z.infer<typeof VariableValues>;
/** IANA time zone used to render DATE-TIME variables for the reader (default UTC). */
export const TimeZoneName = z.string().min(1).max(64);

export const CreateEntryRequest = z.object({
  key: ContentKey,
  contentType: ContentType,
  ownerRole: ContentOwnerRole,
  description: z.string().min(1).max(500),
  sensitivity: ContentSensitivity.default('PUBLIC'),
  criticality: Criticality.optional(),
  approvalPolicy: ApprovalPolicy.optional(),
  fallbackPolicy: FallbackPolicy.optional(),
  /** Most specific scope at which this entry may be overridden. */
  maxScopeType: ContentScopeType.default('PLATFORM'),
  variables: z.array(VariableDefinition).max(30).default([]),
});
export type CreateEntryRequest = z.infer<typeof CreateEntryRequest>;

export const EntryDto = z.object({
  entryId: z.string(),
  key: z.string(),
  contentType: ContentType,
  ownerRole: ContentOwnerRole,
  description: z.string(),
  sensitivity: ContentSensitivity,
  criticality: Criticality,
  approvalPolicy: ApprovalPolicy,
  fallbackPolicy: FallbackPolicy,
  maxScopeType: ContentScopeType,
  isActive: z.boolean(),
  variables: z.array(VariableDefinitionDto),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntryDto = z.infer<typeof EntryDto>;

export const SetActiveRequest = z.object({ active: z.boolean(), reason: z.string().min(1).max(1000) });
export type SetActiveRequest = z.infer<typeof SetActiveRequest>;

// ---------------------------------------------------------------- versions and lifecycle
export const VERSION_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'CANCELLED'] as const;
export const VersionStatus = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof VersionStatus>;
/** Statuses that make a version eligible to resolve (which one applies is derived from the effective timestamps). */
export const PUBLISHED_STATUSES: readonly VersionStatus[] = ['SCHEDULED', 'PUBLISHED', 'SUPERSEDED'];

export const CreateVersionRequest = z.object({
  locale: Locale,
  scopeType: ContentScopeType.default('PLATFORM'),
  scopeRef: scopeRef.nullish(),
  body: z.string().min(1).max(200000),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveTo: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().min(1).max(1000),
});
export type CreateVersionRequest = z.infer<typeof CreateVersionRequest>;
export const ContentDecisionRequest = z.object({ comment: z.string().max(1000).optional() });
export type ContentDecisionRequest = z.infer<typeof ContentDecisionRequest>;

export const ContentVersionDto = z.object({
  versionId: z.string(),
  entryKey: z.string(),
  locale: z.string(),
  scopeType: ContentScopeType,
  scopeRef: z.string().nullable(),
  version: z.number().int(),
  status: VersionStatus,
  approvalPolicy: ApprovalPolicy,
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  reason: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  bodySha256: z.string(),
  /** The template source; management callers only. */
  body: z.string(),
});
export type ContentVersionDto = z.infer<typeof ContentVersionDto>;
export const EntryDetailDto = z.object({ entry: EntryDto, versions: z.array(ContentVersionDto) });
export type EntryDetailDto = z.infer<typeof EntryDetailDto>;

// ---------------------------------------------------------------- locales management
export const RegisterLocaleRequest = z.object({
  locale: Locale,
  active: z.boolean().default(false),
  /** Optional human-readable name; when omitted the service derives one (Intl.DisplayNames in English, the tag itself when Intl has none). */
  displayName: z.string().trim().pipe(adminText(100)).optional(),
  reason: z.string().min(1).max(1000),
});
export type RegisterLocaleRequest = z.infer<typeof RegisterLocaleRequest>;
export const LocaleDto = z.object({
  locale: z.string(),
  /** Human-readable name, for example English (United States). */
  displayName: z.string(),
  /** Derived from the tag (cannot drift): the language subtag, the ISO 15924 script (or null) and the region (or null). */
  language: z.string(),
  script: z.string().nullable(),
  region: z.string().nullable(),
  isActive: z.boolean(),
  isPlatformDefault: z.boolean(),
});
export type LocaleDto = z.infer<typeof LocaleDto>;

// ---------------------------------------------------------------- resolution
export const ResolveContentRequest = z.object({
  key: ContentKey,
  locale: Locale,
  context: ContentContext.default({}),
  variables: VariableValues.optional(),
  timeZone: TimeZoneName.optional(),
  /** Evaluate at a specific instant (historical or future preview). Management callers only: it bypasses the cache. */
  at: z.string().datetime({ offset: true }).optional(),
  /** Also return the template source. Management callers only. */
  includeTemplate: z.boolean().optional(),
});
export type ResolveContentRequest = z.infer<typeof ResolveContentRequest>;
export const ResolveManyContentRequest = z.object({
  keys: z.array(ContentKey).min(1).max(100),
  locale: Locale,
  context: ContentContext.default({}),
  /** Variable values by content key. */
  variables: z.record(ContentKey, VariableValues).optional(),
  timeZone: TimeZoneName.optional(),
  at: z.string().datetime({ offset: true }).optional(),
  includeTemplate: z.boolean().optional(),
});
export type ResolveManyContentRequest = z.infer<typeof ResolveManyContentRequest>;

export const FallbackInfoDto = z.object({
  /** True when the resolved locale differs from the requested one. */
  applied: z.boolean(),
  /** The locales considered, in order, for this entry's fallback policy. */
  chain: z.array(z.string()),
});
export const ResolvedContentDto = z.object({
  key: z.string(),
  contentType: ContentType,
  requestedLocale: z.string(),
  resolvedLocale: z.string(),
  fallback: FallbackInfoDto,
  version: z.number().int(),
  versionId: z.string(),
  sourceScope: ContentScopeType,
  scopeRef: z.string().nullable(),
  effectiveFrom: z.string(),
  /**
   * End of the effective period. Management callers (content-read) see the real value. Public callers always get null: a closed period would
   * disclose that unannounced scheduled copy exists and when it goes live (a published successor closes its predecessor's period).
   */
  effectiveTo: z.string().nullable().describe('End of the effective period; always null for callers without content-read (it would disclose scheduled copy)'),
  bodySha256: z.string(),
  /** 'text' for plain types, 'html' for sanitized markup types. 'html' values are safe to inject; 'text' values must still be escaped by the renderer (React does). */
  format: z.enum(['text', 'html']),
  value: z.string(),
  template: z.string().optional(),
});
export type ResolvedContentDto = z.infer<typeof ResolvedContentDto>;
export const ResolveContentResponse = envelope(ResolvedContentDto);
export const ResolveManyContentResponse = envelope(z.object({ evaluatedAt: z.string(), items: z.array(ResolvedContentDto) }));

// ---------------------------------------------------------------- snapshots
export const CreateContentSnapshotRequest = z.object({
  keys: z.array(ContentKey).min(1).max(100),
  locale: Locale,
  context: ContentContext.default({}),
  at: z.string().datetime({ offset: true }).optional(),
  purpose: z.string().min(1).max(200),
});
export type CreateContentSnapshotRequest = z.infer<typeof CreateContentSnapshotRequest>;
export const ContentSnapshotDto = z.object({
  snapshotId: z.string(),
  evaluatedAt: z.string(),
  requestedLocale: z.string(),
  context: ContentContext,
  purpose: z.string(),
  createdAt: z.string(),
  /**
   * The exact versions used, with their template source (the snapshot reproduces the text, not a rendering). There is deliberately no
   * `effectiveTo`: it changes when a successor is published, and a snapshot read-back must be byte-stable.
   */
  items: z.array(ResolvedContentDto.omit({ format: true, value: true, fallback: true, effectiveTo: true }).extend({ body: z.string() })),
});
export type ContentSnapshotDto = z.infer<typeof ContentSnapshotDto>;

export const EntryResponse = envelope(EntryDto);
export const EntryListResponse = envelope(z.array(EntryDto));
export const EntryDetailResponse = envelope(EntryDetailDto);
export const ContentVersionResponse = envelope(ContentVersionDto);
export const LocaleListResponse = envelope(z.array(LocaleDto));
export const LocaleResponse = envelope(LocaleDto);
export const ContentSnapshotResponse = envelope(ContentSnapshotDto);

// ---------------------------------------------------------------- events (published through the transactional outbox)
export const CONTENT_EVENTS = {
  versionApproved: 'bananagig.content.version-approved.v1',
  versionScheduled: 'bananagig.content.version-scheduled.v1',
  versionPublished: 'bananagig.content.version-published.v1',
  legalDocumentPublished: 'bananagig.content.legal-document-published.v1',
} as const;
/** Payloads carry identifiers and metadata only, never copy text. */
export const ContentEventPayload = z.object({
  versionId: z.string(),
  entryKey: z.string(),
  locale: z.string(),
  scopeType: ContentScopeType,
  scopeRef: z.string().nullable(),
  version: z.number().int(),
  effectiveFrom: z.string(),
  /** The version this one replaces, when there is one. */
  previousVersionId: z.string().nullable().optional(),
});
export type ContentEventPayload = z.infer<typeof ContentEventPayload>;
/** A legal document becoming effective. The checksum lets consent records bind to the exact text. */
export const LegalDocumentPublishedPayload = ContentEventPayload.extend({ bodySha256: z.string() });
export type LegalDocumentPublishedPayload = z.infer<typeof LegalDocumentPublishedPayload>;

/** Typed content error codes (mapped to the standard API error model by the API layer). */
export const CONTENT_ERROR_CODES = [
  'ENTRY_NOT_FOUND',
  'NO_CONTENT',
  'LOCALE_NOT_FOUND',
  'VALIDATION_FAILED',
  'TEMPLATE_ERROR',
  'SCOPE_NOT_ALLOWED',
  'CONFLICT',
  'INVALID_STATE',
  'FORBIDDEN_APPROVER',
  'NOT_FOUND',
  'UNAVAILABLE',
] as const;
export type ContentErrorCode = (typeof CONTENT_ERROR_CODES)[number];
