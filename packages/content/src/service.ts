// The content registry service: locales, entries, the version lifecycle (draft, review, approval, publication, activation),
// resolution, rendering and snapshots. Transaction boundaries live here. Events go through the transactional outbox, never directly to NATS.
// Lock order (deadlock freedom): every entry-scoped mutation locks the ENTRY row first, then the version rows it touches. The activation
// job never waits for an entry lock (SKIP LOCKED). Cache generations are bumped only AFTER the transaction commits.
import { randomUUID } from 'node:crypto';
import {
  CONTENT_EVENTS,
  ContentKey,
  ContentOwnerRole as OwnerRoleSchema,
  ContentScopeType as ScopeTypeSchema,
  ContentSensitivity as SensitivitySchema,
  ContentType as ContentTypeSchema,
  Criticality as CriticalitySchema,
  ApprovalPolicy as ApprovalPolicySchema,
  FallbackPolicy as FallbackPolicySchema,
  PiiClass as PiiClassSchema,
  VariableName,
  VariableType as VariableTypeSchema,
  canonicalizeLocale,
  type ApprovalPolicy,
  type ContentContext,
  type ContentOwnerRole,
  type ContentScopeType,
  type ContentSensitivity,
  type ContentType,
  type Criticality,
  type FallbackPolicy,
  type PiiClass,
  type VariableDefinitionDto,
  type VariableType,
  type VersionStatus,
} from '@bananagig/contracts';
import type { ConfigCache, ScopeReferenceCheck } from '@bananagig/configuration';
import { sql, type Database, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { invalidateEntry, invalidateLocales, isDatabaseOutage, resolveWithPolicy, type MissingCode, type Source } from './cache';
import { ContentError } from './errors';
import { formatVariable } from './format';
import type { MarketDefaultsProvider, ScopeReferenceValidator } from './market-defaults';
import { ENTRY_VARIABLES_SQL, mapVariables, normalizeContext, normalizeLocale, resolveBatch, type ResolvedContent } from './resolver';
import { renderTemplate, validateTemplate } from './template';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- public types
export interface ContentEntry {
  entryId: string;
  key: string;
  contentType: ContentType;
  /** The API gates LEGAL-owned entries by role (content-legal); the service only exposes the owner. */
  ownerRole: ContentOwnerRole;
  description: string;
  sensitivity: ContentSensitivity;
  criticality: Criticality;
  approvalPolicy: ApprovalPolicy;
  fallbackPolicy: FallbackPolicy;
  maxScopeType: ContentScopeType;
  isActive: boolean;
  variables: VariableDefinitionDto[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ContentVersion {
  versionId: string;
  entryId: string;
  entryKey: string;
  locale: string;
  scopeType: ContentScopeType;
  scopeRef: string | null;
  version: number;
  status: VersionStatus;
  approvalPolicy: ApprovalPolicy;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  bodySha256: string;
  body: string;
}
export interface EntryDetail {
  entry: ContentEntry;
  versions: ContentVersion[];
}
export interface ContentLocale {
  locale: string;
  /** Human-readable name (for example English (United States)). */
  displayName: string;
  /** Derived from the tag by the database (cannot drift). */
  language: string;
  script: string | null;
  region: string | null;
  isActive: boolean;
  isPlatformDefault: boolean;
}
/** One version of a snapshot. `effectiveTo` is deliberately absent: it changes when a successor is published, so including it would make a read-back differ from the creation response. */
export type SnapshotItem = Omit<ResolvedContent, 'fallback' | 'effectiveTo'>;
export interface ContentSnapshot {
  snapshotId: string;
  evaluatedAt: Date;
  requestedLocale: string;
  context: ContentContext;
  purpose: string;
  createdBy: string;
  createdAt: Date;
  items: SnapshotItem[];
}
/** A variable definition as supplied by callers (the API's parsed request fits). */
export interface VariableInput {
  name: string;
  type: VariableType;
  description: string;
  example: unknown;
  required?: boolean;
  piiClass?: PiiClass;
}
export interface CreateEntryInput {
  key: string;
  contentType: ContentType;
  ownerRole: ContentOwnerRole;
  description: string;
  sensitivity?: ContentSensitivity;
  criticality?: Criticality;
  approvalPolicy?: ApprovalPolicy;
  fallbackPolicy?: FallbackPolicy;
  maxScopeType?: ContentScopeType;
  variables?: VariableInput[];
}
export interface CreateVersionInput {
  locale: string;
  scopeType?: ContentScopeType;
  scopeRef?: string | null;
  body: string;
  /** ISO-8601 instant with offset or Z. Default: now. May not be in the past (5 seconds of clock tolerance). */
  effectiveFrom?: string;
  effectiveTo?: string | null;
  reason: string;
}
export interface ResolveOptions {
  locale: string;
  context?: ContentContext;
  /** Evaluate at a specific instant. Bypasses the cache and last-known-good. */
  at?: Date;
  /**
   * Default true (trusted callers: notifications, the API after its own authorization). When false, INTERNAL entries behave exactly like
   * unknown ones (ENTRY_NOT_FOUND) so their existence does not leak.
   */
  includeInternal?: boolean;
}
export interface ResolveManyResult {
  items: Map<string, ResolvedContent>;
  sources: Map<string, Source>;
  /** Keys without usable content: unknown, inactive or not visible (ENTRY_NOT_FOUND), or active with nothing effective (NO_CONTENT). */
  missing: Map<string, MissingCode>;
  at: Date;
}
export interface RenderOptions {
  /** Formatting and plural locale. Default: the resolved locale of the copy. */
  locale?: string;
  /** IANA time zone for DATETIME variables (default UTC). */
  timeZone?: string;
}
/** Resolution metadata plus the rendered value; carries the exact version used so a notification service can persist it. */
export type RenderedContent = Omit<ResolvedContent, 'body' | 'variables'> & { format: 'text' | 'html'; value: string };
export interface RenderManyOptions extends ResolveOptions {
  /** Variable values by content key, then by variable name. */
  variables?: Record<string, Record<string, unknown>>;
  timeZone?: string;
}
export interface RenderManyResult {
  items: Map<string, RenderedContent>;
  sources: Map<string, Source>;
  missing: Map<string, MissingCode>;
  at: Date;
}

export interface ServiceDeps {
  database: Database;
  cache?: ConfigCache;
  env: string;
  /** Same setting as configuration (`cfg.configuration.cacheTtlSeconds`). */
  cacheTtlSeconds?: number;
  /** Same setting as configuration (`cfg.configuration.lkgMaxAgeSeconds`). */
  lkgMaxAgeSeconds?: number;
  /** DEV/TEST only: permits `devtest.*` entry keys. Must be false in production. */
  allowTestKeys?: boolean;
  /**
   * Optional: supplies a market's default locale when a context names a market but no `marketDefaultLocale`. The derived value joins the effective
   * context before hashing, caching and snapshotting. A failing provider never fails a request (no market default is used).
   */
  markets?: MarketDefaultsProvider;
  /** Optional: proves COUNTRY/MARKET scope references exist (at createVersion and again at publish). Absent: references are not validated. */
  scopeReferences?: ScopeReferenceValidator;
}

/**
 * The display name stored for a newly registered locale when the caller gives none: Intl.DisplayNames in English (for example
 * English (United States)), or the tag itself when Intl yields nothing useful.
 */
export function defaultLocaleDisplayName(tag: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(tag);
    if (typeof name === 'string' && name.trim().length > 0) return name.trim().slice(0, 100);
  } catch {
    // structurally unsupported by this runtime's ICU data: fall through to the tag
  }
  return tag;
}

// ---------------------------------------------------------------- rendering
/** Renders an already resolved entry. Strict (see renderTemplate); 'html' values are sanitized markup, 'text' values must still be escaped by the caller. */
export function renderResolved(resolved: ResolvedContent, values: Record<string, unknown> | undefined, options: RenderOptions = {}): RenderedContent {
  const rendered = renderTemplate({
    source: resolved.body,
    contentType: resolved.contentType,
    variables: resolved.variables,
    values,
    locale: options.locale ?? resolved.resolvedLocale,
    timeZone: options.timeZone,
  });
  const { body: _body, variables: _variables, ...meta } = resolved;
  return { ...meta, format: rendered.format, value: rendered.value };
}

// ---------------------------------------------------------------- errors
/** Translates database constraint failures into typed errors. Messages never contain copy text; only constraint names are passed on. */
export function mapDbError(err: unknown): never {
  if (err instanceof ContentError) throw err;
  const e = err as { code?: string; message?: string; constraint?: string; detail?: string };
  if (e.code === '23P01')
    throw new ContentError('CONFLICT', 'the effective period overlaps a published version of the same locale and scope', { constraint: e.constraint });
  if (e.code === '23505')
    throw new ContentError('CONFLICT', 'a conflicting record already exists (duplicate key, version or decision)', { constraint: e.constraint });
  if (e.code === '23514') throw new ContentError('VALIDATION_FAILED', 'the operation violates a content constraint', { constraint: e.constraint });
  if (e.code === '23502') throw new ContentError('VALIDATION_FAILED', 'a required field is missing', { constraint: e.constraint });
  if (e.code === '23503' && e.constraint === 'fk_versions__locale')
    throw new ContentError('LOCALE_NOT_FOUND', 'the locale is not registered', { constraint: e.constraint });
  if (e.code === '23503') throw new ContentError('VALIDATION_FAILED', 'a referenced record does not exist', { constraint: e.constraint });
  if (e.code === '22021' || e.code === '22P05')
    throw new ContentError('VALIDATION_FAILED', 'the text contains characters that cannot be stored', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23000' && /own version/.test(e.message ?? ''))
    throw new ContentError('FORBIDDEN_APPROVER', 'the author cannot approve their own version when a second approver is required');
  if (e.code === '23000') {
    // Geography guards (migration 0007) name the rule in the error DETAIL ('geography_rule:<KEY>'); only the key is read, never the message text.
    if (/^geography_rule:LOCALE_IS_ACTIVE_DEFAULT\b/.test(e.detail ?? ''))
      throw new ContentError('INVALID_STATE', 'the locale is the default locale of an active country or market and cannot be deactivated', {
        reason: 'LOCALE_IN_USE_BY_GEOGRAPHY',
      });
    throw new ContentError('INVALID_STATE', 'the operation violates an immutability or workflow rule');
  }
  // The cause is the driver's connection/timeout message; it never contains copy.
  if (isDatabaseOutage(err))
    throw new ContentError('UNAVAILABLE', 'the content database is unavailable', { cause: err instanceof Error ? err.message : String(err) });
  throw err;
}

// ---------------------------------------------------------------- mapping and SQL
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_REF = /^[A-Za-z0-9._:-]{1,200}$/;
/** Clock tolerance for a snapshot `at` (the same 5 seconds as effectiveFrom). */
const SNAPSHOT_FUTURE_TOLERANCE_MS = 5000;
const HOLDER_PUBLISHED = sql`status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')`;

const mapEntry = (r: Row): ContentEntry => ({
  entryId: r.entry_id as string,
  key: r.key as string,
  contentType: r.content_type as ContentType,
  ownerRole: r.owner_role as ContentOwnerRole,
  description: r.description as string,
  sensitivity: r.sensitivity as ContentSensitivity,
  criticality: r.criticality as Criticality,
  approvalPolicy: r.approval_policy as ApprovalPolicy,
  fallbackPolicy: r.fallback_policy as FallbackPolicy,
  maxScopeType: r.max_scope_type as ContentScopeType,
  isActive: r.is_active as boolean,
  variables: mapVariables(r.variables),
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});
const mapVersion = (r: Row): ContentVersion => ({
  versionId: r.version_id as string,
  entryId: r.entry_id as string,
  entryKey: r.entry_key as string,
  locale: r.locale as string,
  scopeType: r.scope_type as ContentScopeType,
  scopeRef: (r.scope_ref as string | null) ?? null,
  version: r.version as number,
  status: r.status as VersionStatus,
  approvalPolicy: r.approval_policy as ApprovalPolicy,
  effectiveFrom: r.effective_from as Date,
  effectiveTo: (r.effective_to as Date | null) ?? null,
  reason: r.reason as string,
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
  bodySha256: r.body_sha256 as string,
  body: r.body as string,
});
const LOCALE_COLUMNS = sql`locale, display_name, language, script, region, is_active, is_platform_default`;
const mapLocale = (r: Row): ContentLocale => ({
  locale: r.locale as string,
  displayName: r.display_name as string,
  language: r.language as string,
  script: (r.script as string | null) ?? null,
  region: (r.region as string | null) ?? null,
  isActive: r.is_active as boolean,
  isPlatformDefault: r.is_platform_default as boolean,
});

const ENTRY_SELECT = sql`SELECT e.*, ${ENTRY_VARIABLES_SQL} AS variables FROM content.entries e`;
const VERSION_SELECT = sql`SELECT v.*, e.key AS entry_key FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id`;

interface LockedVersion extends ContentVersion {
  contentType: ContentType;
  entryActive: boolean;
}
interface EventVersion {
  versionId: string;
  entryKey: string;
  locale: string;
  scopeType: ContentScopeType;
  scopeRef: string | null;
  version: number;
  effectiveFrom: Date;
  previousVersionId?: string | null;
  bodySha256?: string;
}
interface AuditInput {
  actor: string;
  action: string;
  entryId?: string | null;
  locale?: string | null;
  versionId?: string | null;
  previousVersionId?: string | null;
  reason?: string | null;
}

// ---------------------------------------------------------------- validation helpers
function invalid(message: string, details: Record<string, unknown> = {}): ContentError {
  return new ContentError('VALIDATION_FAILED', message, details);
}
function parseWith<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, value: unknown, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(`${field} is not valid`, { reason: 'INVALID_FIELD', field });
  return r.data as T;
}
function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    throw invalid(`${field} must be a non-blank string of at most ${max} characters`, { reason: 'INVALID_FIELD', field });
  return value;
}
function parseInstant(value: string, field: string): Date {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw invalid(`${field} is not a valid instant`, { reason: 'INVALID_FIELD', field });
  return d;
}
function requireUuid(id: string, what: string): void {
  if (typeof id !== 'string' || !UUID.test(id))
    throw new ContentError('NOT_FOUND', `${what} not found`, { id: typeof id === 'string' ? id.slice(0, 64) : null });
}

/** Validates variable definitions (types, uniqueness, PII rules) and proves every example conforms to its type. Returns normalized definitions. */
function validateVariables(inputs: VariableInput[]): Required<VariableInput>[] {
  if (!Array.isArray(inputs) || inputs.length > 30) throw invalid('an entry can define at most 30 variables', { reason: 'INVALID_FIELD', field: 'variables' });
  const seen = new Set<string>();
  return inputs.map((v) => {
    const name = parseWith<string>(VariableName, v?.name, 'variable name');
    if (seen.has(name)) throw invalid('variable names must be unique within an entry', { reason: 'DUPLICATE_VARIABLE', variable: name });
    seen.add(name);
    const type = parseWith<VariableType>(VariableTypeSchema, v.type, 'variable type');
    const piiClass = parseWith<PiiClass>(PiiClassSchema, v.piiClass ?? 'NONE', 'variable piiClass');
    const description = requireText(v.description, 'variable description', 300);
    const required = v.required ?? true;
    if (typeof required !== 'boolean') throw invalid('variable required must be a boolean', { reason: 'INVALID_FIELD', field: 'required', variable: name });
    if (type === 'PERSON_DISPLAY_NAME' && piiClass === 'NONE')
      throw invalid('a PERSON_DISPLAY_NAME variable is personal data (piiClass cannot be NONE)', { reason: 'PII_CLASS', variable: name });
    if (v.example === undefined || v.example === null) throw invalid('every variable needs an example value', { reason: 'INVALID_EXAMPLE', variable: name });
    try {
      formatVariable({ name, type }, v.example, { locale: 'en-US', timeZone: 'UTC' });
    } catch (e) {
      if (e instanceof ContentError)
        throw invalid('the example value does not conform to the variable type', { reason: 'INVALID_EXAMPLE', variable: name, cause: e.details.reason });
      throw e;
    }
    return { name, type, description, required, piiClass, example: v.example };
  });
}

export class ContentService {
  private readonly cacheTtl: number;
  private readonly lkgMax: number;

  constructor(private readonly d: ServiceDeps) {
    this.cacheTtl = d.cacheTtlSeconds ?? 30;
    this.lkgMax = d.lkgMaxAgeSeconds ?? 86_400;
  }

  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  /** Non-transactional reads: connectivity failures surface as the typed UNAVAILABLE like everything else. */
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch(mapDbError);
  }
  private audit(trx: Trx, cid: string, a: AuditInput) {
    // clock_timestamp(), not the transaction's now(): rows written by one transaction keep their causal order.
    return sql`INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, locale, version_id, previous_version_id, reason, correlation_id)
      VALUES (clock_timestamp(), ${a.actor}, ${a.action}, ${a.entryId ?? null}, ${a.locale ?? null}, ${a.versionId ?? null}, ${a.previousVersionId ?? null}, ${a.reason ?? null}, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, type: string, v: EventVersion, actor: string, actorType: 'user' | 'system' | 'service' = 'user') {
    return insertOutboxEvent(trx, {
      aggregateType: 'content_version',
      aggregateId: v.versionId,
      eventType: type,
      actorType,
      actorId: actor,
      correlationId: cid,
      payload: {
        versionId: v.versionId,
        entryKey: v.entryKey,
        locale: v.locale,
        scopeType: v.scopeType,
        scopeRef: v.scopeRef,
        version: v.version,
        effectiveFrom: v.effectiveFrom.toISOString(),
        ...(v.previousVersionId !== undefined ? { previousVersionId: v.previousVersionId } : {}),
        ...(v.bodySha256 !== undefined ? { bodySha256: v.bodySha256 } : {}),
      },
    });
  }
  /** version-published, plus legal-document-published (with the checksum) for LEGAL entries. */
  private async eventPublished(
    trx: Trx,
    cid: string,
    v: EventVersion & { bodySha256: string },
    contentType: ContentType,
    actor: string,
    actorType: 'user' | 'system',
  ) {
    await this.event(trx, cid, CONTENT_EVENTS.versionPublished, { ...v, bodySha256: undefined }, actor, actorType);
    if (contentType === 'LEGAL') await this.event(trx, cid, CONTENT_EVENTS.legalDocumentPublished, v, actor, actorType);
  }

  // ------------------------------------------------------------------ geography ports
  /**
   * Asks the optional validator whether a COUNTRY/MARKET reference is real. Fails closed: an invalid reference is VALIDATION_FAILED, a validator that
   * throws is UNAVAILABLE (a write is never accepted on an unverifiable reference). PLATFORM has no reference and is never validated.
   */
  private async checkScopeReference(scopeType: ContentScopeType, scopeRef: string | null): Promise<void> {
    const validator = this.d.scopeReferences;
    if (!validator || scopeType === 'PLATFORM' || scopeRef === null) return;
    let check: ScopeReferenceCheck;
    try {
      check = await validator.validate(scopeType, scopeRef);
    } catch {
      throw new ContentError('UNAVAILABLE', 'the scope reference could not be verified', { reason: 'SCOPE_REFERENCE_UNAVAILABLE', scopeType });
    }
    if (!check.valid) throw invalid('the scope reference is not valid', { reason: 'SCOPE_REFERENCE_INVALID', scopeType, check: check.reason });
  }

  /**
   * The PUBLIC view of a context (`includeInternal: false`): a country or market the public geography API would not show (unknown, PLANNED,
   * INACTIVE, out of effect) is dropped BEFORE anything is hashed, cached or queried, so it behaves exactly like a context without it. Otherwise an
   * anonymous caller could read MARKET-scoped copy of a market that is not live yet, and tell an unknown market from a PLANNED one. Fails closed:
   * a provider that throws makes the member invisible (warning without the reference). Without a provider, or a provider without `isVisible`, the
   * context is returned unchanged. Management callers never reach this.
   */
  private async publicContext(context: ContentContext): Promise<ContentContext> {
    const provider = this.d.markets;
    if (!provider?.isVisible || (context.country === undefined && context.market === undefined)) return context;
    const check = provider.isVisible.bind(provider);
    const visible = async (scopeType: 'COUNTRY' | 'MARKET', ref: string): Promise<boolean> => {
      try {
        return (await check(scopeType, ref)) === true;
      } catch {
        log('warn', 'scope visibility unavailable; treating the context member as not visible', { scopeType, reason: 'PROVIDER_FAILED' });
        return false;
      }
    };
    const [country, market] = await Promise.all([
      context.country === undefined ? true : visible('COUNTRY', context.country),
      context.market === undefined ? true : visible('MARKET', context.market),
    ]);
    if (country && market) return context;
    const { country: c, market: m, ...rest } = context;
    return { ...rest, ...(country && c !== undefined ? { country: c } : {}), ...(market && m !== undefined ? { market: m } : {}) };
  }

  /**
   * The effective context of one call. When the context names a market but no marketDefaultLocale, the provider is asked once and a usable answer
   * is merged in BEFORE anything is hashed, cached, queried or snapshotted. An explicit marketDefaultLocale always wins. Any provider problem
   * (null, malformed answer, throw) degrades to "no market default": a warning with the market code only, never a failed request.
   */
  private async effectiveContext(context: ContentContext): Promise<{ context: ContentContext; derived: boolean }> {
    const market = context.market;
    if (!this.d.markets || market === undefined || context.marketDefaultLocale !== undefined) return { context, derived: false };
    let answer: string | null;
    try {
      answer = await this.d.markets.defaultLocale(market);
    } catch {
      log('warn', 'market default locale unavailable; resolving without a market default', { market, reason: 'PROVIDER_FAILED' });
      return { context, derived: false };
    }
    if (answer === null || answer === undefined) return { context, derived: false };
    const canonical = canonicalizeLocale(answer);
    if (!canonical) {
      log('warn', 'market default locale is not a valid locale tag; resolving without a market default', { market, reason: 'INVALID_LOCALE' });
      return { context, derived: false };
    }
    return { context: { ...context, marketDefaultLocale: canonical }, derived: true };
  }

  // ------------------------------------------------------------------ locales
  async listLocales(opts: { activeOnly?: boolean } = {}): Promise<ContentLocale[]> {
    const r = await this.read(() =>
      sql<Row>`SELECT ${LOCALE_COLUMNS} FROM content.locales WHERE (${opts.activeOnly ?? false} = false OR is_active) ORDER BY locale`.execute(
        this.d.database.db,
      ),
    );
    return r.rows.map(mapLocale);
  }

  /** Registers a locale (inactive unless `active: true`). Authoring needs registration; serving needs activation. */
  async registerLocale(req: { locale: string; active?: boolean; displayName?: string; reason: string }, actor: string): Promise<ContentLocale> {
    const locale = normalizeLocale(req.locale);
    const reason = requireText(req.reason, 'reason', 1000);
    const displayName = req.displayName === undefined ? defaultLocaleDisplayName(locale) : requireText(req.displayName, 'displayName', 100).trim();
    const active = req.active ?? false;
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const r =
        await sql<Row>`INSERT INTO content.locales (locale, display_name, is_active) VALUES (${locale}, ${displayName}, ${active}) ON CONFLICT (locale) DO NOTHING RETURNING locale`.execute(
          trx,
        );
      if (!r.rows[0]) throw new ContentError('CONFLICT', 'the locale is already registered', { locale });
      await this.audit(trx, cid, { actor, action: 'LOCALE_REGISTERED', locale, reason });
      if (active) await this.audit(trx, cid, { actor, action: 'LOCALE_ACTIVATED', locale, reason });
    });
    await invalidateLocales(this.d.cache, this.d.env);
    return this.getLocale(locale);
  }

  async getLocale(locale: string): Promise<ContentLocale> {
    const tag = normalizeLocale(locale);
    const r = await this.read(() => sql<Row>`SELECT ${LOCALE_COLUMNS} FROM content.locales WHERE locale = ${tag}`.execute(this.d.database.db));
    if (!r.rows[0]) throw new ContentError('LOCALE_NOT_FOUND', 'the locale is not registered', { locale: tag });
    return mapLocale(r.rows[0]);
  }

  /** Activates or deactivates a locale for serving. The platform default locale cannot be deactivated. A no-op change writes nothing. */
  async setLocaleActive(localeInput: string, active: boolean, reasonInput: string, actor: string): Promise<ContentLocale> {
    const locale = normalizeLocale(localeInput);
    const reason = requireText(reasonInput, 'reason', 1000);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const r = await sql<Row>`SELECT is_active, is_platform_default FROM content.locales WHERE locale = ${locale} FOR UPDATE`.execute(trx);
      const row = r.rows[0];
      if (!row) throw new ContentError('LOCALE_NOT_FOUND', 'the locale is not registered', { locale });
      if (row.is_active === active) return false;
      if (!active && row.is_platform_default) throw invalid('the platform default locale cannot be deactivated', { reason: 'PLATFORM_DEFAULT', locale });
      await sql`UPDATE content.locales SET is_active = ${active}, updated_at = now() WHERE locale = ${locale}`.execute(trx);
      await this.audit(trx, cid, { actor, action: active ? 'LOCALE_ACTIVATED' : 'LOCALE_DEACTIVATED', locale, reason });
      return true;
    });
    if (changed) await invalidateLocales(this.d.cache, this.d.env);
    return this.getLocale(locale);
  }

  // ------------------------------------------------------------------ entries
  async createEntry(req: CreateEntryInput, actor: string): Promise<ContentEntry> {
    const key = parseWith<string>(ContentKey, req.key, 'key');
    if (key.startsWith('devtest.') && !this.d.allowTestKeys)
      throw invalid('devtest.* keys are DEV/TEST only and not allowed in this environment', { reason: 'TEST_KEY' });
    const contentType = parseWith<ContentType>(ContentTypeSchema, req.contentType, 'contentType');
    const ownerRole = parseWith<ContentOwnerRole>(OwnerRoleSchema, req.ownerRole, 'ownerRole');
    const description = requireText(req.description, 'description', 500);
    const sensitivity = parseWith<ContentSensitivity>(SensitivitySchema, req.sensitivity ?? 'PUBLIC', 'sensitivity');
    const maxScopeType = parseWith<ContentScopeType>(ScopeTypeSchema, req.maxScopeType ?? 'PLATFORM', 'maxScopeType');
    const legal = contentType === 'LEGAL';
    // Legal documents are stricter by construction: owned by LEGAL, second approver, never stale, never a silently different language.
    const criticality = parseWith<Criticality>(CriticalitySchema, req.criticality ?? (legal ? 'CRITICAL' : 'STANDARD'), 'criticality');
    const approvalPolicy = parseWith<ApprovalPolicy>(
      ApprovalPolicySchema,
      req.approvalPolicy ?? (legal ? 'SECOND_APPROVER' : 'OWNER_APPROVAL'),
      'approvalPolicy',
    );
    const fallbackPolicy = parseWith<FallbackPolicy>(FallbackPolicySchema, req.fallbackPolicy ?? (legal ? 'EXACT' : 'CHAIN'), 'fallbackPolicy');
    if (legal && (ownerRole !== 'LEGAL' || approvalPolicy !== 'SECOND_APPROVER' || criticality !== 'CRITICAL' || fallbackPolicy !== 'EXACT'))
      throw invalid('LEGAL content must be owned by LEGAL with a SECOND_APPROVER policy, CRITICAL criticality and EXACT fallback', { reason: 'LEGAL_POLICY' });
    const variables = validateVariables(req.variables ?? []);
    const cid = getCorrelationId() ?? randomUUID();
    const id = await this.tx(async (trx) => {
      const r = await sql<{
        entry_id: string;
      }>`INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
        VALUES (${key}, ${contentType}, ${ownerRole}, ${description}, ${sensitivity}, ${criticality}, ${approvalPolicy}, ${fallbackPolicy}, ${maxScopeType}, ${actor})
        RETURNING entry_id`.execute(trx);
      const entryId = r.rows[0]!.entry_id;
      for (const v of variables)
        await sql`INSERT INTO content.entry_variables (entry_id, name, var_type, is_required, description, example_value, pii_class)
          VALUES (${entryId}, ${v.name}, ${v.type}, ${v.required}, ${v.description}, ${JSON.stringify(v.example)}::jsonb, ${v.piiClass})`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'ENTRY_CREATED', entryId, reason: 'content entry created' });
      return entryId;
    });
    return (await this.findEntryById(id))!;
  }

  private async findEntryById(id: string): Promise<ContentEntry | undefined> {
    const r = await this.read(() => sql<Row>`${ENTRY_SELECT} WHERE e.entry_id = ${id}`.execute(this.d.database.db));
    return r.rows[0] ? mapEntry(r.rows[0]) : undefined;
  }
  /** The entry by key (management view: inactive entries are returned). */
  async findEntry(key: string): Promise<ContentEntry> {
    const r = await this.read(() => sql<Row>`${ENTRY_SELECT} WHERE e.key = ${key}`.execute(this.d.database.db));
    if (!r.rows[0]) throw new ContentError('ENTRY_NOT_FOUND', 'content entry not found', { key });
    return mapEntry(r.rows[0]);
  }
  async getEntry(key: string): Promise<EntryDetail> {
    const entry = await this.findEntry(key);
    const v = await this.read(() =>
      sql<Row>`${VERSION_SELECT} WHERE v.entry_id = ${entry.entryId} ORDER BY v.locale, v.scope_type, v.scope_ref NULLS FIRST, v.version`.execute(
        this.d.database.db,
      ),
    );
    return { entry, versions: v.rows.map(mapVersion) };
  }
  async listEntries(f: { contentType?: ContentType; ownerRole?: ContentOwnerRole; isActive?: boolean } = {}): Promise<ContentEntry[]> {
    const r = await this.read(() =>
      sql<Row>`${ENTRY_SELECT}
      WHERE (${f.contentType ?? null}::text IS NULL OR e.content_type = ${f.contentType ?? null})
        AND (${f.ownerRole ?? null}::text IS NULL OR e.owner_role = ${f.ownerRole ?? null})
        AND (${f.isActive ?? null}::boolean IS NULL OR e.is_active = ${f.isActive ?? null})
      ORDER BY e.key LIMIT 1000`.execute(this.d.database.db),
    );
    return r.rows.map(mapEntry);
  }

  /** Activates or deactivates an entry (an inactive entry resolves as unknown and accepts no new versions). A no-op change writes nothing. */
  async setEntryActive(key: string, active: boolean, reasonInput: string, actor: string): Promise<ContentEntry> {
    const reason = requireText(reasonInput, 'reason', 1000);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const r = await sql<Row>`SELECT entry_id, is_active FROM content.entries WHERE key = ${key} FOR UPDATE`.execute(trx);
      const row = r.rows[0];
      if (!row) throw new ContentError('ENTRY_NOT_FOUND', 'content entry not found', { key });
      if (row.is_active === active) return false;
      await sql`UPDATE content.entries SET is_active = ${active}, updated_at = now() WHERE entry_id = ${row.entry_id as string}`.execute(trx);
      await this.audit(trx, cid, { actor, action: active ? 'ENTRY_ACTIVATED' : 'ENTRY_DEACTIVATED', entryId: row.entry_id as string, reason });
      return true;
    });
    if (changed) await invalidateEntry(this.d.cache, this.d.env, key);
    return this.findEntry(key);
  }

  // ------------------------------------------------------------------ versions and lifecycle
  async getVersion(versionId: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    const r = await this.read(() => sql<Row>`${VERSION_SELECT} WHERE v.version_id = ${versionId}`.execute(this.d.database.db));
    if (!r.rows[0]) throw new ContentError('NOT_FOUND', 'version not found', { versionId });
    return mapVersion(r.rows[0]);
  }

  /**
   * Creates a DRAFT version. The text is validated against the entry's variables and content type (including a dry render with the variable
   * examples) before anything is written. Version numbers are max+1 per holder (entry, locale, scope), serialized by the entry row lock.
   */
  async createVersion(entryKey: string, req: CreateVersionInput, actor: string): Promise<ContentVersion> {
    const locale = normalizeLocale(req.locale);
    const scopeType = parseWith<ContentScopeType>(ScopeTypeSchema, req.scopeType ?? 'PLATFORM', 'scopeType');
    const scopeRef = req.scopeRef ?? null;
    if ((scopeType === 'PLATFORM') !== (scopeRef === null))
      throw invalid(scopeType === 'PLATFORM' ? 'PLATFORM scope takes no scopeRef' : `${scopeType} scope requires a scopeRef`, { reason: 'SCOPE_REF' });
    if (scopeRef !== null && !SCOPE_REF.test(scopeRef)) throw invalid('scopeRef is not valid', { reason: 'INVALID_FIELD', field: 'scopeRef' });
    const reason = requireText(req.reason, 'reason', 1000);
    if (typeof req.body !== 'string' || req.body.length === 0) throw invalid('body must not be empty', { reason: 'INVALID_FIELD', field: 'body' });
    const proposedFrom = req.effectiveFrom !== undefined ? parseInstant(req.effectiveFrom, 'effectiveFrom') : undefined;
    const proposedTo = req.effectiveTo ? parseInstant(req.effectiveTo, 'effectiveTo') : null;
    await this.checkScopeReference(scopeType, scopeRef);
    const entry = await this.findEntry(entryKey);
    // Entry contract (type, variables) is immutable, so the (potentially heavy) validation runs before the lock is taken.
    validateTemplate(req.body, entry.variables, entry.contentType);
    const cid = getCorrelationId() ?? randomUUID();
    const id = await this.tx(async (trx) => {
      const locked = (
        await sql<Row>`SELECT is_active, max_scope_type, approval_policy FROM content.entries WHERE entry_id = ${entry.entryId} FOR UPDATE`.execute(trx)
      ).rows[0]!;
      if (!(locked.is_active as boolean)) throw new ContentError('INVALID_STATE', 'the entry is inactive and accepts no new versions', { key: entryKey });
      const ranks = await sql<{
        scope_type: string;
        rank: number;
      }>`SELECT scope_type, rank FROM configuration.scope_levels WHERE scope_type IN (${scopeType}, ${locked.max_scope_type as string})`.execute(trx);
      const rank = (t: string) => Number(ranks.rows.find((x) => x.scope_type === t)?.rank);
      if (rank(scopeType) > rank(locked.max_scope_type as string))
        throw new ContentError('SCOPE_NOT_ALLOWED', `scope ${scopeType} is more specific than ${entryKey} allows`, {
          key: entryKey,
          scopeType,
          allowed: locked.max_scope_type,
        });
      const known = await sql`SELECT 1 FROM content.locales WHERE locale = ${locale}`.execute(trx);
      if (!known.rows.length) throw new ContentError('LOCALE_NOT_FOUND', 'the locale is not registered', { locale });
      const now = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t;
      const from = proposedFrom ?? now;
      if (from.getTime() < now.getTime() - 5000)
        throw invalid('effectiveFrom cannot be in the past; corrections apply going forward', { reason: 'EFFECTIVE_IN_PAST' });
      if (proposedTo && proposedTo <= from) throw invalid('effectiveTo must be after effectiveFrom', { reason: 'EFFECTIVE_RANGE' });
      const next = (
        await sql<{ n: number }>`SELECT coalesce(max(version), 0) + 1 AS n FROM content.versions
          WHERE entry_id = ${entry.entryId} AND locale = ${locale} AND scope_type = ${scopeType} AND scope_ref IS NOT DISTINCT FROM ${scopeRef}`.execute(trx)
      ).rows[0]!.n;
      const v = (
        await sql<{
          version_id: string;
        }>`INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, approval_policy, effective_from, effective_to, reason, created_by)
          VALUES (${entry.entryId}, ${locale}, ${scopeType}, ${scopeRef}, ${next}, ${req.body}, ${locked.approval_policy as string}, ${from}, ${proposedTo}, ${reason}, ${actor})
          RETURNING version_id`.execute(trx)
      ).rows[0]!;
      await this.audit(trx, cid, { actor, action: 'VERSION_DRAFTED', entryId: entry.entryId, versionId: v.version_id, reason });
      return v.version_id;
    });
    return this.getVersion(id);
  }

  /** Locks the entry row, then the version row (the global lock order), and returns the version as it is under the lock. */
  private async lockVersion(trx: Trx, versionId: string): Promise<LockedVersion> {
    requireUuid(versionId, 'version');
    const pre = await sql<{ entry_id: string }>`SELECT entry_id FROM content.versions WHERE version_id = ${versionId}`.execute(trx);
    if (!pre.rows[0]) throw new ContentError('NOT_FOUND', 'version not found', { versionId });
    await sql`SELECT 1 FROM content.entries WHERE entry_id = ${pre.rows[0].entry_id} FOR UPDATE`.execute(trx);
    const r = await sql<Row>`SELECT v.*, e.key AS entry_key, e.content_type, e.is_active AS entry_active
      FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE v.version_id = ${versionId} FOR UPDATE OF v`.execute(trx);
    const row = r.rows[0];
    if (!row) throw new ContentError('NOT_FOUND', 'version not found', { versionId });
    return { ...mapVersion(row), contentType: row.content_type as ContentType, entryActive: row.entry_active as boolean };
  }
  private need(v: ContentVersion, ...states: VersionStatus[]): void {
    if (!states.includes(v.status)) throw new ContentError('INVALID_STATE', `version is ${v.status}; expected ${states.join(' or ')}`, { status: v.status });
  }
  private setStatus(trx: Trx, versionId: string, status: VersionStatus) {
    return sql`UPDATE content.versions SET status = ${status}, updated_at = now() WHERE version_id = ${versionId}`.execute(trx);
  }
  private eventOf(v: ContentVersion, extra: Partial<EventVersion> = {}): EventVersion {
    return {
      versionId: v.versionId,
      entryKey: v.entryKey,
      locale: v.locale,
      scopeType: v.scopeType,
      scopeRef: v.scopeRef,
      version: v.version,
      effectiveFrom: v.effectiveFrom,
      ...extra,
    };
  }

  /** DRAFT -> IN_REVIEW, or straight to APPROVED when the entry policy is NONE. Only the author may submit. */
  async submit(versionId: string, actor: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const v = await this.lockVersion(trx, versionId);
      this.need(v, 'DRAFT');
      if (v.createdBy !== actor) throw new ContentError('FORBIDDEN_APPROVER', 'only the author can submit a draft');
      if (!v.entryActive) throw new ContentError('INVALID_STATE', 'the entry is inactive', { key: v.entryKey });
      const auto = v.approvalPolicy === 'NONE';
      await this.setStatus(trx, versionId, auto ? 'APPROVED' : 'IN_REVIEW');
      await this.audit(trx, cid, { actor, action: 'VERSION_SUBMITTED', entryId: v.entryId, versionId, reason: v.reason });
      if (auto) {
        await this.audit(trx, cid, { actor, action: 'VERSION_APPROVED', entryId: v.entryId, versionId, reason: 'approval policy NONE' });
        await this.event(trx, cid, CONTENT_EVENTS.versionApproved, this.eventOf(v), actor);
      }
    });
    return this.getVersion(versionId);
  }

  /** IN_REVIEW -> APPROVED. Under SECOND_APPROVER (always for legal documents) the author cannot approve: refused here and by the database. */
  async approve(versionId: string, actor: string, comment?: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const v = await this.lockVersion(trx, versionId);
      this.need(v, 'IN_REVIEW');
      if (v.approvalPolicy === 'SECOND_APPROVER' && v.createdBy === actor)
        throw new ContentError('FORBIDDEN_APPROVER', 'the author cannot approve their own version when a second approver is required');
      await sql`INSERT INTO content.version_approvals (version_id, approver, decision, comment) VALUES (${versionId}, ${actor}, 'APPROVE', ${comment ?? null})`.execute(
        trx,
      );
      await this.setStatus(trx, versionId, 'APPROVED');
      await this.audit(trx, cid, { actor, action: 'VERSION_APPROVED', entryId: v.entryId, versionId, reason: comment ?? null });
      await this.event(trx, cid, CONTENT_EVENTS.versionApproved, this.eventOf(v), actor);
    });
    return this.getVersion(versionId);
  }

  async reject(versionId: string, actor: string, comment?: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const v = await this.lockVersion(trx, versionId);
      this.need(v, 'IN_REVIEW');
      await sql`INSERT INTO content.version_approvals (version_id, approver, decision, comment) VALUES (${versionId}, ${actor}, 'REJECT', ${comment ?? null})`.execute(
        trx,
      );
      await this.setStatus(trx, versionId, 'REJECTED');
      await this.audit(trx, cid, { actor, action: 'VERSION_REJECTED', entryId: v.entryId, versionId, reason: comment ?? null });
    });
    return this.getVersion(versionId);
  }

  /** Withdraws a version before publication (DRAFT, IN_REVIEW or APPROVED). Only the author may cancel. A published version is corrected with a later one. */
  async cancel(versionId: string, actor: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const v = await this.lockVersion(trx, versionId);
      this.need(v, 'DRAFT', 'IN_REVIEW', 'APPROVED');
      if (v.createdBy !== actor) throw new ContentError('FORBIDDEN_APPROVER', 'only the author can cancel a version');
      await this.setStatus(trx, versionId, 'CANCELLED');
      await this.audit(trx, cid, { actor, action: 'VERSION_CANCELLED', entryId: v.entryId, versionId, reason: v.reason });
    });
    return this.getVersion(versionId);
  }

  /**
   * APPROVED -> SCHEDULED (starts later) or PUBLISHED (starts now). Timeline rules (all under the entry lock, so two publications of one holder
   * serialize): start = max(proposed start, now); a HIGHER-numbered version of the holder already published makes this one stale (CONFLICT);
   * an open-ended head must have started before `start` and is closed at `start`; a head with an explicit end must end at or before `start`;
   * an explicit end must be after `start`. A published version is never withdrawn.
   */
  async publish(versionId: string, actor: string): Promise<ContentVersion> {
    requireUuid(versionId, 'version');
    // The stored reference is re-validated (it may have been retired since the draft). The check runs before the transaction so that no lock is
    // held while the validator does its own I/O; every other state error is still raised under the locks below.
    if (this.d.scopeReferences) {
      const pre = await this.getVersion(versionId);
      if (pre.status === 'APPROVED') await this.checkScopeReference(pre.scopeType, pre.scopeRef);
    }
    const cid = getCorrelationId() ?? randomUUID();
    const touched = await this.tx(async (trx) => {
      const v = await this.lockVersion(trx, versionId);
      this.need(v, 'APPROVED');
      if (!v.entryActive) throw new ContentError('INVALID_STATE', 'the entry is inactive', { key: v.entryKey });
      const head = (
        await sql<Row>`SELECT version_id, version, effective_from, effective_to FROM content.versions
          WHERE entry_id = ${v.entryId} AND locale = ${v.locale} AND scope_type = ${v.scopeType} AND scope_ref IS NOT DISTINCT FROM ${v.scopeRef} AND ${HOLDER_PUBLISHED}
          ORDER BY version DESC LIMIT 1 FOR UPDATE`.execute(trx)
      ).rows[0];
      const now = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t;
      const start = v.effectiveFrom > now ? v.effectiveFrom : now;
      if (head) {
        const headFrom = head.effective_from as Date;
        const headTo = (head.effective_to as Date | null) ?? null;
        if ((head.version as number) > v.version)
          throw new ContentError('CONFLICT', 'a later version of this locale and scope is already published; this version is stale', {
            latestVersion: head.version,
          });
        if (headTo === null) {
          if (start <= headFrom)
            throw new ContentError('CONFLICT', 'the new version must start after the latest version of this locale and scope', {
              latestStart: headFrom.toISOString(),
            });
          await sql`UPDATE content.versions SET effective_to = ${start}, updated_at = now() WHERE version_id = ${head.version_id as string}`.execute(trx);
        } else if (start < headTo)
          throw new ContentError('CONFLICT', 'the new version overlaps the explicit end of the latest version', { latestEnd: headTo.toISOString() });
      }
      if (v.effectiveTo && v.effectiveTo <= start) throw new ContentError('CONFLICT', 'the requested end is not after the effective start');
      const immediate = start <= now;
      // An older SCHEDULED version whose start has already passed was in force (resolution never waits for the job) but the job has not run yet:
      // activate each in version order, exactly as the job would, so its audit and events exist, and only then supersede. Otherwise it would go
      // SCHEDULED -> SUPERSEDED without a trace of ever having been effective.
      if (immediate) await this.activateDueOlder(trx, cid, v, now);
      // effective_from may only be RAISED (the guard trigger); keep the stored value when the proposal is still in the future.
      await sql`UPDATE content.versions SET status = ${immediate ? 'PUBLISHED' : 'SCHEDULED'}, effective_from = coalesce(${start > v.effectiveFrom ? start : null}::timestamptz, effective_from), updated_at = now()
        WHERE version_id = ${versionId}`.execute(trx);
      const previousVersionId = (head?.version_id as string | undefined) ?? null;
      await this.audit(trx, cid, { actor, action: 'VERSION_PUBLISHED', entryId: v.entryId, versionId, previousVersionId, reason: v.reason });
      const ev = this.eventOf(v, { effectiveFrom: start, previousVersionId });
      if (immediate) {
        await this.audit(trx, cid, { actor, action: 'VERSION_ACTIVATED', entryId: v.entryId, versionId, previousVersionId });
        await this.supersede(trx, cid, v, actor, await this.olderPublished(trx, v));
        await this.eventPublished(trx, cid, { ...ev, bodySha256: v.bodySha256 }, v.contentType, actor, 'user');
      } else await this.event(trx, cid, CONTENT_EVENTS.versionScheduled, ev, actor);
      return v.entryKey;
    });
    await invalidateEntry(this.d.cache, this.d.env, touched);
    return this.getVersion(versionId);
  }

  /** Older published (or due-scheduled) versions of the holder, highest first, row-locked. */
  private async olderPublished(trx: Trx, v: ContentVersion): Promise<string[]> {
    const older = await sql<{ version_id: string }>`SELECT version_id FROM content.versions
      WHERE entry_id = ${v.entryId} AND locale = ${v.locale} AND scope_type = ${v.scopeType} AND scope_ref IS NOT DISTINCT FROM ${v.scopeRef}
        AND status IN ('PUBLISHED', 'SCHEDULED') AND version < ${v.version} ORDER BY version DESC FOR UPDATE`.execute(trx);
    return older.rows.map((o) => o.version_id);
  }
  /** Marks the given older versions SUPERSEDED, with audit. */
  private async supersede(trx: Trx, cid: string, v: ContentVersion, actor: string, olderIds: string[]): Promise<void> {
    for (const id of olderIds) {
      await this.setStatus(trx, id, 'SUPERSEDED');
      await this.audit(trx, cid, {
        actor,
        action: 'VERSION_SUPERSEDED',
        entryId: v.entryId,
        versionId: id,
        reason: `superseded by version ${v.version}`,
      });
    }
  }

  /**
   * SCHEDULED -> PUBLISHED for one locked version row (state, audit, supersession of the versions it replaces, events). The single implementation
   * behind the activation job and behind an immediate publication that finds due-but-not-yet-activated predecessors. Returns the entry key.
   */
  private async activateRow(trx: Trx, cid: string, row: Row): Promise<string> {
    const actor = 'system:content-activation';
    const v = mapVersion(row);
    await this.setStatus(trx, v.versionId, 'PUBLISHED');
    const older = await this.olderPublished(trx, v);
    const previousVersionId = older[0] ?? null;
    await this.audit(trx, cid, {
      actor,
      action: 'VERSION_ACTIVATED',
      entryId: v.entryId,
      versionId: v.versionId,
      previousVersionId,
      reason: 'scheduled activation',
    });
    await this.supersede(trx, cid, v, actor, older);
    await this.eventPublished(
      trx,
      cid,
      { ...this.eventOf(v, { previousVersionId }), bodySha256: v.bodySha256 },
      row.content_type as ContentType,
      actor,
      'system',
    );
    return v.entryKey;
  }

  /** Activates the SCHEDULED predecessors of `v` (same holder, lower version) whose start is at or before `now`, lowest version first. */
  private async activateDueOlder(trx: Trx, cid: string, v: ContentVersion, now: Date): Promise<void> {
    const due = await sql<Row>`SELECT v.*, e.key AS entry_key, e.content_type FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id
      WHERE v.entry_id = ${v.entryId} AND v.locale = ${v.locale} AND v.scope_type = ${v.scopeType} AND v.scope_ref IS NOT DISTINCT FROM ${v.scopeRef}
        AND v.status = 'SCHEDULED' AND v.version < ${v.version} AND v.effective_from <= ${now} ORDER BY v.version FOR UPDATE OF v`.execute(trx);
    for (const row of due.rows) await this.activateRow(trx, cid, row);
  }

  /**
   * SCHEDULED -> PUBLISHED for versions whose start has passed (state, audit, supersession, events, cache invalidation). Idempotent and safe to
   * run concurrently: entries that another transaction is working on are skipped (SKIP LOCKED) and picked up by the next run. Resolution never
   * depends on this running on time; it only advances the workflow state and notifies.
   */
  async activateDue(limit = 100): Promise<number> {
    const keys = new Set<string>();
    const cid = getCorrelationId() ?? randomUUID();
    const n = await this.tx(async (trx) => {
      const due = await sql<{ version_id: string; entry_id: string }>`SELECT version_id, entry_id FROM content.versions
        WHERE status = 'SCHEDULED' AND effective_from <= clock_timestamp() ORDER BY effective_from, version_id LIMIT ${limit}`.execute(trx);
      let count = 0;
      for (const c of due.rows) {
        const entry = await sql`SELECT 1 FROM content.entries WHERE entry_id = ${c.entry_id} FOR UPDATE SKIP LOCKED`.execute(trx);
        if (!entry.rows.length) continue; // another transaction holds the entry; the next run activates it
        const r = await sql<Row>`SELECT v.*, e.key AS entry_key, e.content_type FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id
          WHERE v.version_id = ${c.version_id} AND v.status = 'SCHEDULED' AND v.effective_from <= clock_timestamp() FOR UPDATE OF v`.execute(trx);
        if (!r.rows[0]) continue; // already activated
        keys.add(await this.activateRow(trx, cid, r.rows[0]));
        count++;
      }
      return count;
    });
    for (const k of keys) await invalidateEntry(this.d.cache, this.d.env, k);
    return n;
  }

  // ------------------------------------------------------------------ resolution
  /**
   * Resolves many entries in one batched read through the cache and last-known-good policy. Keys without usable content are reported in
   * `missing` (ENTRY_NOT_FOUND or NO_CONTENT); the call itself fails only when the database is unavailable and no safe LKG exists.
   */
  async resolveMany(keys: string[], opts: ResolveOptions): Promise<ResolveManyResult> {
    const locale = normalizeLocale(opts.locale);
    const requested = normalizeContext(opts.context);
    const context = (await this.effectiveContext(opts.includeInternal === false ? await this.publicContext(requested) : requested)).context;
    const unique = [...new Set(keys)];
    const r = await resolveWithPolicy({
      keys: unique,
      locale,
      ctx: context,
      at: opts.at,
      cache: this.d.cache,
      env: this.d.env,
      cacheTtlSeconds: this.cacheTtl,
      lkgMaxAgeSeconds: this.lkgMax,
      load: (ks) => resolveBatch(this.d.database.db, ks, { locale, context }, opts.at),
    });
    if (opts.includeInternal === false) {
      // INTERNAL entries are indistinguishable from unknown keys: whether they resolved (live or from the cache) or have no effective content.
      for (const [k, item] of [...r.resolved]) {
        if (item.sensitivity !== 'INTERNAL') continue;
        r.resolved.delete(k);
        r.sources.delete(k);
        r.missing.set(k, 'ENTRY_NOT_FOUND');
      }
      for (const k of r.internalMissing) r.missing.set(k, 'ENTRY_NOT_FOUND');
    }
    return { items: r.resolved, sources: r.sources, missing: r.missing, at: opts.at ?? new Date() };
  }

  /** One entry. Throws ENTRY_NOT_FOUND or NO_CONTENT (there is no code fallback by design). */
  async resolve(key: string, opts: ResolveOptions): Promise<ResolvedContent> {
    const r = await this.resolveMany([key], opts);
    const item = r.items.get(key);
    if (item) return item;
    const code = r.missing.get(key) ?? 'NO_CONTENT';
    throw new ContentError(code, code === 'ENTRY_NOT_FOUND' ? 'content entry not found' : 'no content is effective for the entry in the requested locale', {
      key,
      locale: opts.locale,
    });
  }

  /** Resolves and renders one entry. */
  async render(key: string, opts: ResolveOptions & { variables?: Record<string, unknown>; timeZone?: string }): Promise<RenderedContent> {
    return renderResolved(await this.resolve(key, opts), opts.variables, { timeZone: opts.timeZone });
  }

  /**
   * Batched resolve + render. The returned items carry versionId, resolvedLocale and bodySha256 so a notification service can persist the exact
   * version it used. A caller error in the variables (missing, unknown or invalid) is a TEMPLATE_ERROR for the whole call.
   */
  async resolveRendered(keys: string[], opts: RenderManyOptions): Promise<RenderManyResult> {
    const r = await this.resolveMany(keys, opts);
    const items = new Map<string, RenderedContent>();
    for (const [k, resolved] of r.items) items.set(k, renderResolved(resolved, opts.variables?.[k], { timeZone: opts.timeZone }));
    return { items, sources: r.sources, missing: r.missing, at: r.at };
  }

  // ------------------------------------------------------------------ snapshots
  /**
   * Immutable record of exactly which versions applied. Always authoritative: reads the database, never the cache or LKG. For copy that must
   * be reproducible later (accepted legal text, disclosed financial copy, transactional messages), not for routine UI labels.
   */
  async createSnapshot(
    args: { keys: string[]; locale: string; context?: ContentContext; purpose: string; at?: Date },
    actor: string,
  ): Promise<ContentSnapshot> {
    const locale = normalizeLocale(args.locale);
    const purpose = requireText(args.purpose, 'purpose', 200);
    const keys = [...new Set(args.keys)];
    if (!keys.length) throw invalid('a snapshot needs at least one key', { reason: 'INVALID_FIELD', field: 'keys' });
    if (args.at !== undefined && (!(args.at instanceof Date) || Number.isNaN(args.at.getTime())))
      throw invalid('at is not a valid instant', { reason: 'INVALID_FIELD', field: 'at' });
    const requestContext = normalizeContext(args.context);
    const derived = await this.effectiveContext(requestContext);
    const id = await this.tx(async (trx) => {
      let context = derived.context;
      // A DERIVED market default that is not an ACTIVE locale was not used by resolution (the chain skips it), so the snapshot must not claim it.
      // (An explicitly supplied marketDefaultLocale is recorded as given, exactly as before.)
      if (derived.derived && context.marketDefaultLocale !== undefined) {
        const live = await sql`SELECT 1 FROM content.locales WHERE locale = ${context.marketDefaultLocale} AND is_active`.execute(trx);
        if (!live.rows.length) context = requestContext;
      }
      if (args.at) {
        // A snapshot records what APPLIED. A future instant is only a prediction (a later-published, earlier-starting successor would falsify it).
        const dbNow = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t;
        if (args.at.getTime() > dbNow.getTime() + SNAPSHOT_FUTURE_TOLERANCE_MS)
          throw invalid('a snapshot cannot be taken for an instant in the future', { reason: 'AT_IN_FUTURE', field: 'at' });
      }
      const batch = await resolveBatch(trx, keys, { locale, context }, args.at);
      if (batch.unknown.length) throw new ContentError('ENTRY_NOT_FOUND', 'unknown or inactive content entry', { keys: batch.unknown });
      if (batch.missing.length)
        throw new ContentError('NO_CONTENT', 'no content is effective for the entry in the requested locale', { keys: batch.missing.map((m) => m.key) });
      const s = (
        await sql<{ snapshot_id: string }>`INSERT INTO content.snapshots (evaluated_at, requested_locale, context, purpose, created_by)
          VALUES (${batch.at}, ${locale}, ${JSON.stringify(context)}::jsonb, ${purpose}, ${actor}) RETURNING snapshot_id`.execute(trx)
      ).rows[0]!;
      for (const r of batch.resolved.values())
        await sql`INSERT INTO content.snapshot_items (snapshot_id, entry_id, version_id) VALUES (${s.snapshot_id}, ${r.entryId}, ${r.versionId})`.execute(trx);
      return s.snapshot_id;
    });
    return this.getSnapshot(id);
  }

  async getSnapshot(id: string): Promise<ContentSnapshot> {
    requireUuid(id, 'snapshot');
    const s = (await this.read(() => sql<Row>`SELECT * FROM content.snapshots WHERE snapshot_id = ${id}`.execute(this.d.database.db))).rows[0];
    if (!s) throw new ContentError('NOT_FOUND', 'snapshot not found', { id });
    const items = await this.read(() =>
      sql<Row>`SELECT e.key, e.entry_id, e.content_type, e.sensitivity, e.criticality, ${ENTRY_VARIABLES_SQL} AS variables,
        v.locale, v.scope_type, v.scope_ref, v.version_id, v.version, v.body, v.body_sha256, v.effective_from
      FROM content.snapshot_items si
      JOIN content.versions v ON v.version_id = si.version_id
      JOIN content.entries e ON e.entry_id = si.entry_id
     WHERE si.snapshot_id = ${id} ORDER BY e.key`.execute(this.d.database.db),
    );
    return {
      snapshotId: s.snapshot_id as string,
      evaluatedAt: s.evaluated_at as Date,
      requestedLocale: s.requested_locale as string,
      context: s.context as ContentContext,
      purpose: s.purpose as string,
      createdBy: s.created_by as string,
      createdAt: s.created_at as Date,
      items: items.rows.map((r) => ({
        key: r.key as string,
        entryId: r.entry_id as string,
        contentType: r.content_type as ContentType,
        sensitivity: r.sensitivity as ContentSensitivity,
        criticality: r.criticality as Criticality,
        requestedLocale: s.requested_locale as string,
        resolvedLocale: r.locale as string,
        version: r.version as number,
        versionId: r.version_id as string,
        sourceScope: r.scope_type as ContentScopeType,
        scopeRef: (r.scope_ref as string | null) ?? null,
        effectiveFrom: r.effective_from as Date,
        body: r.body as string,
        bodySha256: r.body_sha256 as string,
        variables: mapVariables(r.variables),
      })),
    };
  }
}
