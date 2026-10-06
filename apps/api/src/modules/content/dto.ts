import type { ContentSnapshotDto, ContentVersionDto, EntryDto, LocaleDto, ResolvedContentDto, VariableDefinitionDto } from '@bananagig/contracts';
import { ContentError, type ContentEntry, type ContentLocale, type ContentSnapshot, type ContentVersion, type RenderedContent } from '@bananagig/content';
import { AppError } from '../../errors';

const iso = (d: Date): string => d.toISOString();

const variableDto = (v: VariableDefinitionDto): VariableDefinitionDto => ({
  name: v.name,
  type: v.type,
  required: v.required,
  description: v.description,
  example: v.example,
  piiClass: v.piiClass,
});

export const entryDto = (e: ContentEntry): EntryDto => ({
  entryId: e.entryId,
  key: e.key,
  contentType: e.contentType,
  ownerRole: e.ownerRole,
  description: e.description,
  sensitivity: e.sensitivity,
  criticality: e.criticality,
  approvalPolicy: e.approvalPolicy,
  fallbackPolicy: e.fallbackPolicy,
  maxScopeType: e.maxScopeType,
  isActive: e.isActive,
  variables: e.variables.map(variableDto),
  createdBy: e.createdBy,
  createdAt: iso(e.createdAt),
  updatedAt: iso(e.updatedAt),
});

/** Management view of a version (includes the template source; management routes only). */
export const versionDto = (v: ContentVersion): ContentVersionDto => ({
  versionId: v.versionId,
  entryKey: v.entryKey,
  locale: v.locale,
  scopeType: v.scopeType,
  scopeRef: v.scopeRef,
  version: v.version,
  status: v.status,
  approvalPolicy: v.approvalPolicy,
  effectiveFrom: iso(v.effectiveFrom),
  effectiveTo: v.effectiveTo ? iso(v.effectiveTo) : null,
  reason: v.reason,
  createdBy: v.createdBy,
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
  bodySha256: v.bodySha256,
  body: v.body,
});

export const localeDto = (l: ContentLocale): LocaleDto => ({ locale: l.locale, isActive: l.isActive, isPlatformDefault: l.isPlatformDefault });

/**
 * Public view of a rendered entry. Built field by field: sensitivity, criticality and entry ids are internal and never returned, and the
 * template source appears only when the route authorized it (`template` is passed by the caller after the visibility check).
 * `effectiveTo` is returned only to management callers (`management: true`): a closed period would tell a public caller that unannounced
 * scheduled copy exists and exactly when it goes live. Everyone else gets null.
 */
export const renderedDto = (r: RenderedContent, opts: { template?: string; management: boolean }): ResolvedContentDto => ({
  key: r.key,
  contentType: r.contentType,
  requestedLocale: r.requestedLocale,
  resolvedLocale: r.resolvedLocale,
  fallback: { applied: r.fallback.applied, chain: [...r.fallback.chain] },
  version: r.version,
  versionId: r.versionId,
  sourceScope: r.sourceScope,
  scopeRef: r.scopeRef,
  effectiveFrom: iso(r.effectiveFrom),
  effectiveTo: opts.management && r.effectiveTo ? iso(r.effectiveTo) : null,
  bodySha256: r.bodySha256,
  format: r.format,
  value: r.value,
  ...(opts.template !== undefined ? { template: opts.template } : {}),
});

/**
 * Snapshots are management only; they carry the exact template source of each version used. Items deliberately omit `effectiveTo`: it is the
 * live end of the version's period and changes when a successor is published, so including it would make a read-back differ from the original.
 */
export const snapshotDto = (s: ContentSnapshot): ContentSnapshotDto => ({
  snapshotId: s.snapshotId,
  evaluatedAt: iso(s.evaluatedAt),
  requestedLocale: s.requestedLocale,
  context: s.context,
  purpose: s.purpose,
  createdAt: iso(s.createdAt),
  items: s.items.map((i) => ({
    key: i.key,
    contentType: i.contentType,
    requestedLocale: i.requestedLocale,
    resolvedLocale: i.resolvedLocale,
    version: i.version,
    versionId: i.versionId,
    sourceScope: i.sourceScope,
    scopeRef: i.scopeRef,
    effectiveFrom: iso(i.effectiveFrom),
    bodySha256: i.bodySha256,
    body: i.body,
  })),
});

/**
 * Maps typed content failures onto the standard API error model. The AppError code is `CONTENT_<ContentError code>`. Driver causes are never
 * exposed, and database outages are reported generically. ContentError details hold identifiers, positions and machine-readable reasons only
 * (never copy text or variable values), so they pass through.
 */
export function toAppError(err: unknown): never {
  if (!(err instanceof ContentError)) throw err;
  const { cause: _cause, ...details } = err.details;
  const code = `CONTENT_${err.code}`;
  switch (err.code) {
    case 'ENTRY_NOT_FOUND':
    case 'NO_CONTENT':
    case 'LOCALE_NOT_FOUND':
    case 'NOT_FOUND':
      throw new AppError('NOT_FOUND', code, err.message, details);
    case 'VALIDATION_FAILED':
    case 'TEMPLATE_ERROR':
    case 'SCOPE_NOT_ALLOWED':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'CONFLICT':
    case 'INVALID_STATE':
      throw new AppError('CONFLICT', code, err.message, details);
    case 'FORBIDDEN_APPROVER':
      throw new AppError('AUTHORIZATION', code, err.message);
    case 'UNAVAILABLE':
      throw new AppError('DEPENDENCY', code, 'The content registry is temporarily unavailable');
  }
}
