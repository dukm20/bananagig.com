// The Gig Template service (CAT-002): the PLATFORM-OWNED, versioned structure a provider later builds a Gig from. Transaction boundaries live here. Events go through the transactional
// outbox, in the same transaction as the change.
//
// Visibility: like the catalogue, the service never reads roles. `management` reads show every status, the revision and the content keys, need no public market and bypass the cache; the
// PUBLIC view needs a public market (the MarketGate), a service type that is ACTIVE and public in it (enabled, under an enabled ACTIVE category), an ACTIVE template enabled in the market
// and its ACTIVE version. Nothing here holds or returns display text: names, labels and help are content keys, resolved by the content registry in the API layer.
//
// Concurrency: the database guards decide (status machines, frozen versions, contiguous numbers, one draft and one active version per template). Every version operation takes the TEMPLATE row
// FOR UPDATE first and then the VERSION row (bare single-table statements; READ COMMITTED re-checks only the locked row after a wait). A draft carries a revision: a replace or a publish names
// the revision the administrator read, so a stale draft is refused (STALE_DRAFT) instead of overwriting or publishing someone else's change. The cache generation is bumped AFTER commit.
import { randomUUID } from 'node:crypto';
import {
  AREA_MODES,
  CATALOG_TEST_CODE_PREFIX,
  CatalogStatusRequest,
  CreateGigTemplateRequest,
  CreateGigTemplateVersionRequest,
  GIG_TEMPLATE_EVENTS,
  GigTemplateVersionRetireRequest,
  MarketCode,
  PRICING_MODELS,
  PublishGigTemplateVersionRequest,
  ReplaceGigTemplateDraftRequest,
  SetMarketGigTemplateAvailabilityRequest,
  UpdateGigTemplateRequest,
  gigTemplateDescriptionKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldHelpKey,
  gigTemplateFieldLabelKey,
  gigTemplateInstructionsKey,
  gigTemplateOptionLabelKey,
  type AreaMode,
  type GigTemplateAvailabilityEventPayload,
  type GigTemplateEventPayload,
  type GigTemplateFieldBehavior,
  type GigTemplateFieldType,
  type GigTemplateMarketAvailabilityDto,
  type GigTemplatePublishedPayload,
  type GigTemplateRequirementType,
  type GigTemplateSection,
  type PricingModel,
} from '@bananagig/contracts';
import { sql, TransactionOptionError, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { cachedRead, invalidateCatalog, DEFAULT_CATALOG_CACHE_TTL_SECONDS, type ReadSource } from './cache';
import { CatalogError } from './errors';
import { invalid, mapDbError, parseInput, status, type CatalogServiceDeps } from './service';
import {
  GigTemplateSnapshotSchema,
  fieldView,
  versionSummaryView,
  type GigTemplateFieldDetailView,
  type GigTemplateFieldOptionView,
  type GigTemplateFieldView,
  type GigTemplateRequirementView,
  type GigTemplateSnapshot,
  type GigTemplateVersionDetailView,
  type GigTemplateVersionSummaryView,
  type GigTemplateVersionView,
  type GigTemplateView,
} from './gig-template-types';
import type { PublicMarket } from './types';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

/** The canonical, comparable and writable form of a version definition (the request after parsing, or the stored rows): what a draft is made of. */
export interface CanonField {
  fieldKey: string;
  fieldType: GigTemplateFieldType;
  section: GigTemplateSection;
  behavior: GigTemplateFieldBehavior;
  customerVisible: boolean;
  withHelp: boolean;
  withDefaultText: boolean;
  minLength: number | null;
  maxLength: number | null;
  minNumber: number | null;
  maxNumber: number | null;
  defaultNumber: number | null;
  defaultBoolean: boolean | null;
  minItems: number | null;
  maxItems: number | null;
  options: { optionCode: string; isDefault: boolean }[];
}
export interface CanonRequirement {
  requirementType: GigTemplateRequirementType;
  referenceCode: string | null;
}
export interface Canon {
  duration: { min: number | null; max: number | null; suggested: number | null };
  pricing: PricingModel[];
  area: AreaMode[];
  fields: CanonField[];
  requirements: CanonRequirement[];
}

const MAX_MISSING_KEYS_REPORTED = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The database stores 4 decimals: normalize like it does, so a definition is equal to what was stored (float noise such as 0.30000000000000004 is not a change). */
const round4 = (v: number | undefined): number | null => (v === undefined ? null : Math.round(v * 10_000) / 10_000);
const reqId = (r: CanonRequirement): string => `${r.requirementType}:${r.referenceCode ?? ''}`;

/** The canonical form of a parsed replace request (fixed order of models, requirements by identity; the field order is the display order). */
export function canonFromRequest(b: ReplaceGigTemplateDraftRequest): Canon {
  return {
    duration: { min: b.duration?.minMinutes ?? null, max: b.duration?.maxMinutes ?? null, suggested: b.duration?.suggestedMinutes ?? null },
    pricing: PRICING_MODELS.filter((m) => b.pricingModels.includes(m)),
    area: AREA_MODES.filter((m) => b.areaModes.includes(m)),
    fields: b.fields.map((f) => ({
      fieldKey: f.fieldKey,
      fieldType: f.fieldType,
      section: f.section,
      behavior: f.behavior,
      customerVisible: f.customerVisible,
      withHelp: f.withHelp,
      withDefaultText: f.withDefaultText,
      minLength: f.minLength ?? null,
      maxLength: f.maxLength ?? null,
      minNumber: round4(f.minNumber),
      maxNumber: round4(f.maxNumber),
      defaultNumber: round4(f.defaultNumber),
      defaultBoolean: f.defaultBoolean ?? null,
      minItems: f.minItems ?? null,
      maxItems: f.maxItems ?? null,
      options: f.options.map((o) => ({ optionCode: o.optionCode, isDefault: o.isDefault })),
    })),
    requirements: sortRequirements(b.requirements.map((q) => ({ requirementType: q.requirementType, referenceCode: q.referenceCode ?? null }))),
  };
}
const sortRequirements = (list: CanonRequirement[]): CanonRequirement[] => [...list].sort((a, b) => (reqId(a) < reqId(b) ? -1 : reqId(a) > reqId(b) ? 1 : 0));

function canonFromStored(version: Row, fields: GigTemplateFieldView[], requirements: GigTemplateRequirementView[]): Canon {
  return {
    duration: {
      min: version.min_duration_minutes === null ? null : Number(version.min_duration_minutes),
      max: version.max_duration_minutes === null ? null : Number(version.max_duration_minutes),
      suggested: version.suggested_duration_minutes === null ? null : Number(version.suggested_duration_minutes),
    },
    pricing: PRICING_MODELS.filter((m) => pricingFlag(version, m)),
    area: AREA_MODES.filter((m) => areaFlag(version, m)),
    fields: fields.map((f) => ({
      fieldKey: f.fieldKey,
      fieldType: f.fieldType,
      section: f.section,
      behavior: f.behavior,
      customerVisible: f.customerVisible,
      withHelp: f.helpContentKey !== null,
      withDefaultText: f.defaultContentKey !== null,
      minLength: f.minLength,
      maxLength: f.maxLength,
      minNumber: f.minNumber,
      maxNumber: f.maxNumber,
      defaultNumber: f.defaultNumber,
      defaultBoolean: f.defaultBoolean,
      minItems: f.minItems,
      maxItems: f.maxItems,
      options: f.options.map((o) => ({ optionCode: o.optionCode, isDefault: o.isDefault })),
    })),
    requirements: sortRequirements(requirements.map((q) => ({ requirementType: q.requirementType, referenceCode: q.referenceCode }))),
  };
}
const pricingFlag = (r: Row, m: PricingModel): boolean =>
  m === 'FIXED'
    ? r.pricing_fixed === true
    : m === 'FIXED_WITH_VARIANTS'
      ? r.pricing_fixed_with_variants === true
      : m === 'BUNDLE_ELIGIBLE'
        ? r.pricing_bundle_eligible === true
        : m === 'DROP_ELIGIBLE'
          ? r.pricing_drop_eligible === true
          : r.pricing_add_ons === true;
const areaFlag = (r: Row, m: AreaMode): boolean =>
  m === 'RADIUS' ? r.area_radius === true : m === 'POSTAL_CODES' ? r.area_postal_codes === true : r.area_polygon === true;

/** Identifiers only: what changed between two definitions, for the audit trail (never copy). */
export function diffCanon(a: Canon, b: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (JSON.stringify(a.duration) !== JSON.stringify(b.duration)) out.duration = [a.duration, b.duration];
  if (JSON.stringify(a.pricing) !== JSON.stringify(b.pricing)) out.pricingModels = [a.pricing, b.pricing];
  if (JSON.stringify(a.area) !== JSON.stringify(b.area)) out.areaModes = [a.area, b.area];
  const before = new Map(a.fields.map((f, i) => [f.fieldKey, JSON.stringify({ ...f, order: i })]));
  const after = new Map(b.fields.map((f, i) => [f.fieldKey, JSON.stringify({ ...f, order: i })]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  if (added.length || removed.length || changed.length) out.fields = { added, removed, changed };
  const ra = new Set(a.requirements.map(reqId));
  const rb = new Set(b.requirements.map(reqId));
  const rAdded = [...rb].filter((k) => !ra.has(k));
  const rRemoved = [...ra].filter((k) => !rb.has(k));
  if (rAdded.length || rRemoved.length) out.requirements = { added: rAdded, removed: rRemoved };
  return out;
}

/** Every content key a definition references (the labels, help, default texts and option labels of the template `code`). */
export function contentKeysOf(code: string, c: Canon): string[] {
  const keys: string[] = [];
  for (const f of c.fields) {
    keys.push(gigTemplateFieldLabelKey(code, f.fieldKey));
    if (f.withHelp) keys.push(gigTemplateFieldHelpKey(code, f.fieldKey));
    if (f.withDefaultText) keys.push(gigTemplateFieldDefaultKey(code, f.fieldKey));
    for (const o of f.options) keys.push(gigTemplateOptionLabelKey(code, f.fieldKey, o.optionCode));
  }
  return keys;
}

/** The PUBLIC shape of a template: identity, copy keys, order and the ACTIVE version's structure; no status, availability flag, revision, timestamp or other version. */
function toPublicTemplate(t: GigTemplateView): GigTemplateView {
  const v = t.activeVersion;
  return {
    gigTemplateId: t.gigTemplateId,
    code: t.code,
    serviceTypeCode: t.serviceTypeCode,
    categoryCode: t.categoryCode,
    nameContentKey: t.nameContentKey,
    descriptionContentKey: t.descriptionContentKey,
    instructionsContentKey: t.instructionsContentKey,
    displayOrder: t.displayOrder,
    activeVersion: v
      ? {
          gigTemplateVersionId: v.gigTemplateVersionId,
          versionNumber: v.versionNumber,
          duration: { minMinutes: v.duration.minMinutes, maxMinutes: v.duration.maxMinutes, suggestedMinutes: v.duration.suggestedMinutes },
          pricingModels: [...v.pricingModels],
          areaModes: [...v.areaModes],
          fieldCount: v.fieldCount,
          fields: v.fields,
          requirements: v.requirements,
        }
      : null,
  };
}

const normalizeVersionNumber = (n: unknown): number => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647)
    throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', { code: String(n).slice(0, 16) });
  return n;
};

const templateSelect = sql`SELECT t.gig_template_id, t.code, st.code AS service_type_code, c.code AS category_code, t.name_content_key, t.description_content_key, t.instructions_content_key,
       t.status, t.created_at, t.updated_at`;
const templateFrom = sql`FROM catalog.gig_templates t
  JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
  JOIN catalog.categories c ON c.category_id = st.category_id`;

export class GigTemplateService {
  private readonly ttl: number;

  constructor(private readonly d: CatalogServiceDeps) {
    this.ttl = d.cacheTtlSeconds ?? DEFAULT_CATALOG_CACHE_TTL_SECONDS;
  }

  private get db() {
    return this.d.database.db;
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  private snapshotRead<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true }).catch(mapDbError);
  }
  /**
   * Management reads in ONE consistent snapshot (a read-only REPEATABLE READ transaction), so a version is never shown with the rows of a later revision. Called inside a caller's
   * transaction (the service then joins it, like every other operation) a different isolation level is refused by the database layer: the read joins the caller's transaction instead.
   */
  private async consistentRead<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    try {
      return await this.d.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true });
    } catch (err) {
      if (err instanceof TransactionOptionError) return this.d.database.transaction(fn).catch(mapDbError);
      return mapDbError(err);
    }
  }
  private invalidate(): Promise<void> {
    return invalidateCatalog(this.d.cache, this.d.env, this.d.cacheDeadlineMs);
  }
  /** Repeats an idempotent availability change ONCE when it lost a race (same policy as the catalogue availability). */
  private async retryOnRace<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CatalogError && err.code === 'CONFLICT' && err.details.reason === 'CONCURRENT_UPDATE') return fn();
      throw err;
    }
  }

  // ================================================================== public reads (the market must be public)
  private async publicMarketOrThrow(marketCode: string): Promise<PublicMarket> {
    if (!MarketCode.safeParse(marketCode).success)
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code: String(marketCode).slice(0, 64) });
    const market = await this.d.markets.publicMarket(marketCode);
    if (!market) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code: marketCode });
    return market;
  }

  /**
   * The public Gig Templates of a market, in the market's order, each with its ACTIVE version: the market must be public, the service type ACTIVE and public in it, the template ACTIVE and
   * enabled in the market. Cached by market and catalogue generation (the same counter as the taxonomy, so a service type or category change also invalidates it).
   */
  async getMarketGigTemplates(marketCode: string): Promise<{ market: PublicMarket; templates: GigTemplateView[]; source: ReadSource }> {
    const market = await this.publicMarketOrThrow(marketCode);
    const { value, source } = await cachedRead<GigTemplateSnapshot>({
      cache: this.d.cache,
      env: this.d.env,
      what: `gt:market:${market.code}`,
      ttlSeconds: this.ttl,
      deadlineMs: this.d.cacheDeadlineMs,
      load: () => this.loadPublicSnapshot(market.code),
      parse: (raw) => {
        const r = GigTemplateSnapshotSchema.safeParse(raw);
        // rebuilt field by field: whatever a poisoned entry carries beyond the public shape (status, revision, timestamps, other versions) never reaches a public answer
        return r.success ? { templates: r.data.templates.map(toPublicTemplate) } : null;
      },
    });
    return { market, templates: value.templates, source };
  }

  async listGigTemplatesForMarket(
    marketCode: string,
    opts: { serviceTypeCode?: string } = {},
  ): Promise<{ market: PublicMarket; templates: GigTemplateView[] }> {
    const r = await this.getMarketGigTemplates(marketCode);
    return {
      market: r.market,
      templates: opts.serviceTypeCode === undefined ? r.templates : r.templates.filter((t) => t.serviceTypeCode === opts.serviceTypeCode),
    };
  }

  async getGigTemplateForMarket(marketCode: string, code: string): Promise<{ market: PublicMarket; template: GigTemplateView }> {
    const r = await this.getMarketGigTemplates(marketCode);
    const template = r.templates.find((t) => t.code === code);
    if (!template) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not available', { code: String(code).slice(0, 64) });
    return { market: r.market, template };
  }

  private loadPublicSnapshot(marketCode: string): Promise<GigTemplateSnapshot> {
    return this.snapshotRead(async (trx) => {
      const rows = (
        await sql<Row>`SELECT t.gig_template_id, t.code, st.code AS service_type_code, c.code AS category_code, t.name_content_key, t.description_content_key, t.instructions_content_key,
               mgt.display_order, v.*
          FROM catalog.market_gig_templates mgt
          JOIN geography.markets m ON m.market_id = mgt.market_id
          JOIN catalog.gig_templates t ON t.gig_template_id = mgt.gig_template_id
          JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
          JOIN catalog.categories c ON c.category_id = st.category_id
          JOIN catalog.market_service_types mst ON mst.market_id = mgt.market_id AND mst.service_type_id = st.service_type_id
          JOIN catalog.market_categories mc ON mc.market_id = mgt.market_id AND mc.category_id = st.category_id
          JOIN catalog.gig_template_versions v ON v.gig_template_id = t.gig_template_id AND v.status = 'ACTIVE'
         WHERE m.code = ${marketCode} AND mgt.enabled AND t.status = 'ACTIVE' AND st.status = 'ACTIVE' AND c.status = 'ACTIVE' AND mst.enabled AND mc.enabled
         ORDER BY mgt.display_order`.execute(trx)
      ).rows;
      const structure = await this.loadStructure(
        trx,
        rows.map((r) => r.gig_template_version_id as string),
      );
      return {
        templates: rows.map((r) => {
          const s = structure.get(r.gig_template_version_id as string)!;
          return {
            gigTemplateId: r.gig_template_id as string,
            code: r.code as string,
            serviceTypeCode: r.service_type_code as string,
            categoryCode: r.category_code as string,
            nameContentKey: r.name_content_key as string,
            descriptionContentKey: (r.description_content_key as string | null) ?? null,
            instructionsContentKey: (r.instructions_content_key as string | null) ?? null,
            displayOrder: Number(r.display_order),
            activeVersion: { ...versionSummaryView(r, s.fields.length, false), fields: s.fields, requirements: s.requirements },
          };
        }),
      };
    });
  }

  // ================================================================== shared reads
  /** The fields (with options) and requirements of the given versions, in display order. */
  private async loadStructure(
    ex: Executor,
    versionIds: string[],
  ): Promise<Map<string, { fields: GigTemplateFieldView[]; requirements: GigTemplateRequirementView[] }>> {
    const out = new Map<string, { fields: GigTemplateFieldView[]; requirements: GigTemplateRequirementView[] }>();
    for (const id of versionIds) out.set(id, { fields: [], requirements: [] });
    if (versionIds.length === 0) return out;
    const fieldRows = (
      await sql<Row>`SELECT f.* FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = ANY(${versionIds}::uuid[]) ORDER BY f.gig_template_version_id, f.display_order`.execute(
        ex,
      )
    ).rows;
    const optionRows =
      fieldRows.length === 0
        ? []
        : (
            await sql<Row>`SELECT o.* FROM catalog.gig_template_field_options o WHERE o.gig_template_field_id = ANY(${fieldRows.map((f) => f.gig_template_field_id as string)}::uuid[])
              ORDER BY o.gig_template_field_id, o.display_order`.execute(ex)
          ).rows;
    const optionsOf = new Map<string, GigTemplateFieldOptionView[]>();
    for (const o of optionRows) {
      const list = optionsOf.get(o.gig_template_field_id as string) ?? [];
      list.push({
        optionCode: o.option_code as string,
        labelContentKey: o.label_content_key as string,
        isDefault: o.is_default === true,
        displayOrder: Number(o.display_order),
      });
      optionsOf.set(o.gig_template_field_id as string, list);
    }
    for (const f of fieldRows) out.get(f.gig_template_version_id as string)!.fields.push(fieldView(f, optionsOf.get(f.gig_template_field_id as string) ?? []));
    const reqRows = (
      await sql<Row>`SELECT q.* FROM catalog.gig_template_requirements q WHERE q.gig_template_version_id = ANY(${versionIds}::uuid[])
        ORDER BY q.gig_template_version_id, q.requirement_type COLLATE "C", q.reference_code COLLATE "C" NULLS FIRST`.execute(ex)
    ).rows;
    for (const q of reqRows)
      out
        .get(q.gig_template_version_id as string)!
        .requirements.push({ requirementType: q.requirement_type as GigTemplateRequirementType, referenceCode: (q.reference_code as string | null) ?? null });
    return out;
  }

  /**
   * ONE exact version with its template, service type and category facts, in a single consistent snapshot (CAT-003: a Gig keeps the version it was built from, whatever its status).
   * A malformed or unknown id is GIG_TEMPLATE_VERSION_NOT_FOUND.
   */
  async getGigTemplateVersionById(gigTemplateVersionId: string): Promise<GigTemplateVersionDetailView> {
    if (typeof gigTemplateVersionId !== 'string' || !UUID.test(gigTemplateVersionId))
      throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', {});
    return this.consistentRead(async (trx) => {
      const view = await this.detailOfVersion(trx, sql`v.gig_template_version_id = ${gigTemplateVersionId}`);
      if (!view) throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', {});
      return view;
    });
  }

  /**
   * The structure a new Gig starts from, by template code: the ACTIVE version when there is one, otherwise the newest version that is not a DRAFT (so a caller can say WHY the template
   * cannot be used). GIG_TEMPLATE_NOT_FOUND when the code is unknown or the template has no published version at all.
   */
  async getGigTemplateStructure(code: string): Promise<GigTemplateVersionDetailView> {
    return this.consistentRead(async (trx) => {
      const view = await this.detailOfVersion(
        trx,
        sql`t.code = ${code} AND v.status <> 'DRAFT'`,
        sql`ORDER BY (v.status = 'ACTIVE') DESC, v.version_number DESC LIMIT 1`,
      );
      if (!view) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code: String(code).slice(0, 64) });
      return view;
    });
  }

  /** Whether the template is enabled in the market now (the availability row only; the caller decides what else must hold). An unknown market or template is false. */
  async isGigTemplateEnabledInMarket(marketCode: string, gigTemplateId: string): Promise<boolean> {
    if (!MarketCode.safeParse(marketCode).success || typeof gigTemplateId !== 'string' || !UUID.test(gigTemplateId)) return false;
    const r = await sql<Row>`SELECT mgt.enabled FROM catalog.market_gig_templates mgt JOIN geography.markets m ON m.market_id = mgt.market_id
       WHERE m.code = ${marketCode} AND mgt.gig_template_id = ${gigTemplateId}`.execute(this.db);
    return r.rows[0]?.enabled === true;
  }

  private async detailOfVersion(
    ex: Executor,
    where: ReturnType<typeof sql>,
    tail: ReturnType<typeof sql> = sql``,
  ): Promise<GigTemplateVersionDetailView | null> {
    const row = (
      await sql<Row>`SELECT v.*, t.gig_template_id AS template_id, t.code, t.status AS template_status, t.name_content_key, t.description_content_key, t.instructions_content_key,
             st.code AS service_type_code, st.status AS service_type_status, c.code AS category_code
        FROM catalog.gig_template_versions v
        JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
        JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
        JOIN catalog.categories c ON c.category_id = st.category_id
       WHERE ${where} ${tail}`.execute(ex)
    ).rows[0];
    if (!row) return null;
    const versionId = row.gig_template_version_id as string;
    const s = (await this.loadStructure(ex, [versionId])).get(versionId)!;
    const ids = new Map(
      (
        await sql<Row>`SELECT gig_template_field_id, field_key FROM catalog.gig_template_fields WHERE gig_template_version_id = ${versionId}`.execute(ex)
      ).rows.map((f) => [f.field_key as string, f.gig_template_field_id as string]),
    );
    const fields: GigTemplateFieldDetailView[] = s.fields.map((f) => ({ ...f, gigTemplateFieldId: ids.get(f.fieldKey)! }));
    return {
      gigTemplateId: row.template_id as string,
      code: row.code as string,
      templateStatus: status(row.template_status),
      serviceTypeCode: row.service_type_code as string,
      serviceTypeStatus: status(row.service_type_status),
      categoryCode: row.category_code as string,
      nameContentKey: row.name_content_key as string,
      descriptionContentKey: (row.description_content_key as string | null) ?? null,
      instructionsContentKey: (row.instructions_content_key as string | null) ?? null,
      version: versionSummaryView(row, fields.length, true),
      fields,
      requirements: s.requirements,
    };
  }

  private async marketIdOf(ex: Executor, marketCode: string): Promise<string> {
    if (!MarketCode.safeParse(marketCode).success)
      throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(marketCode).slice(0, 64) });
    const r = await sql<Row>`SELECT market_id FROM geography.markets WHERE code = ${marketCode}`.execute(ex);
    const id = r.rows[0]?.market_id as string | undefined;
    if (!id) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: marketCode });
    return id;
  }

  // ================================================================== management reads (every status; never cached)
  /** Every Gig Template (any status), optionally of one service type, with its availability in a market (any market status) when `marketCode` is given. */
  async listGigTemplates(opts: { serviceTypeCode?: string; marketCode?: string } = {}): Promise<GigTemplateView[]> {
    return this.consistentRead(async (trx) => {
      const marketId = opts.marketCode === undefined ? undefined : await this.marketIdOf(trx, opts.marketCode);
      const rows = (
        await sql<Row>`${templateSelect}, mgt.enabled AS market_enabled, mgt.display_order AS market_order
          ${templateFrom}
          LEFT JOIN catalog.market_gig_templates mgt ON mgt.gig_template_id = t.gig_template_id AND mgt.market_id = ${marketId ?? null}
         WHERE (${opts.serviceTypeCode ?? null}::text IS NULL OR st.code = ${opts.serviceTypeCode ?? null})
         ORDER BY ${marketId === undefined ? sql`t.code COLLATE "C"` : sql`mgt.display_order NULLS LAST, t.code COLLATE "C"`}`.execute(trx)
      ).rows;
      return this.assembleManagement(trx, rows, marketId !== undefined, false);
    });
  }

  async getGigTemplate(code: string, opts: { marketCode?: string } = {}): Promise<GigTemplateView> {
    return this.consistentRead(async (trx) => {
      const marketId = opts.marketCode === undefined ? undefined : await this.marketIdOf(trx, opts.marketCode);
      const rows = (
        await sql<Row>`${templateSelect}, mgt.enabled AS market_enabled, mgt.display_order AS market_order
          ${templateFrom}
          LEFT JOIN catalog.market_gig_templates mgt ON mgt.gig_template_id = t.gig_template_id AND mgt.market_id = ${marketId ?? null}
         WHERE t.code = ${code}`.execute(trx)
      ).rows;
      if (rows.length === 0) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code: String(code).slice(0, 64) });
      return (await this.assembleManagement(trx, rows, marketId !== undefined, true))[0]!;
    });
  }

  /** The full structure of ONE version of a template (any status), with the content keys and the revision. */
  async getGigTemplateVersion(code: string, versionNumber: number): Promise<GigTemplateVersionView> {
    const n = normalizeVersionNumber(versionNumber);
    return this.consistentRead(async (trx) => {
      const row = (
        await sql<Row>`SELECT v.* FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
         WHERE t.code = ${code} AND v.version_number = ${n}`.execute(trx)
      ).rows[0];
      if (!row) {
        const exists = (await sql<Row>`SELECT 1 AS ok FROM catalog.gig_templates WHERE code = ${code}`.execute(trx)).rows[0];
        if (!exists) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code: String(code).slice(0, 64) });
        throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', { code: String(code).slice(0, 64) });
      }
      const s = (await this.loadStructure(trx, [row.gig_template_version_id as string])).get(row.gig_template_version_id as string)!;
      return { ...versionSummaryView(row, s.fields.length, true), fields: s.fields, requirements: s.requirements };
    });
  }

  private async assembleManagement(ex: Executor, rows: Row[], withMarket: boolean, detail: boolean): Promise<GigTemplateView[]> {
    const ids = rows.map((r) => r.gig_template_id as string);
    if (ids.length === 0) return [];
    const versionRows = (
      await sql<Row>`SELECT v.*, (SELECT count(*) FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = v.gig_template_version_id) AS field_count
        FROM catalog.gig_template_versions v WHERE v.gig_template_id = ANY(${ids}::uuid[]) AND (${detail} OR v.status = 'ACTIVE') ORDER BY v.gig_template_id, v.version_number DESC`.execute(
        ex,
      )
    ).rows;
    const active = versionRows.filter((v) => v.status === 'ACTIVE');
    const structure = await this.loadStructure(
      ex,
      active.map((v) => v.gig_template_version_id as string),
    );
    return rows.map((r): GigTemplateView => {
      const mine = versionRows.filter((v) => v.gig_template_id === r.gig_template_id);
      const act = mine.find((v) => v.status === 'ACTIVE');
      const s = act ? structure.get(act.gig_template_version_id as string)! : undefined;
      return {
        gigTemplateId: r.gig_template_id as string,
        code: r.code as string,
        serviceTypeCode: r.service_type_code as string,
        categoryCode: r.category_code as string,
        nameContentKey: r.name_content_key as string,
        descriptionContentKey: (r.description_content_key as string | null) ?? null,
        instructionsContentKey: (r.instructions_content_key as string | null) ?? null,
        displayOrder: withMarket && r.market_order !== null ? Number(r.market_order) : null,
        status: status(r.status),
        ...(withMarket ? { enabled: r.market_enabled === true } : {}),
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
        activeVersion: act && s ? { ...versionSummaryView(act, s.fields.length, true), fields: s.fields, requirements: s.requirements } : null,
        ...(detail ? { versions: mine.map((v) => versionSummaryView(v, Number(v.field_count), true)) } : {}),
      };
    });
  }

  // ================================================================== management: shared helpers
  private audit(
    trx: Trx,
    cid: string,
    a: {
      actor: string;
      action: string;
      gigTemplateId: string;
      gigTemplateVersionId?: string;
      marketId?: string;
      changes?: Record<string, unknown>;
      reason: string;
    },
  ) {
    return sql`INSERT INTO catalog.audit_events (actor, action, gig_template_id, gig_template_version_id, market_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.gigTemplateId}, ${a.gigTemplateVersionId ?? null}, ${a.marketId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason}, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, type: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, actor: string) {
    return insertOutboxEvent(trx, { aggregateType, aggregateId, eventType: type, actorType: 'user', actorId: actor, correlationId: cid, payload });
  }
  private gateTestCode(code: string): void {
    if (code.startsWith(CATALOG_TEST_CODE_PREFIX) && this.d.allowTestKeys !== true)
      throw invalid('test codes are not allowed in this environment', { reason: 'TEST_KEY_NOT_ALLOWED', field: 'code' });
  }

  /** Locks ONE template by code with a bare statement and reads it. */
  private async lockTemplate(trx: Trx, code: string, lock: 'update' | 'share' = 'update') {
    const locked =
      lock === 'update'
        ? await sql<Row>`SELECT gig_template_id FROM catalog.gig_templates WHERE code = ${code} FOR UPDATE`.execute(trx)
        : await sql<Row>`SELECT gig_template_id FROM catalog.gig_templates WHERE code = ${code} FOR SHARE`.execute(trx);
    const id = locked.rows[0]?.gig_template_id as string | undefined;
    if (!id) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code: String(code).slice(0, 64) });
    const r = (
      await sql<Row>`SELECT t.status, t.service_type_id, st.code AS service_type_code, t.description_content_key, t.instructions_content_key
        FROM catalog.gig_templates t JOIN catalog.service_types st ON st.service_type_id = t.service_type_id WHERE t.gig_template_id = ${id}`.execute(trx)
    ).rows[0]!;
    return {
      id,
      code,
      status: status(r.status),
      serviceTypeId: r.service_type_id as string,
      serviceTypeCode: r.service_type_code as string,
      descriptionContentKey: (r.description_content_key as string | null) ?? null,
      instructionsContentKey: (r.instructions_content_key as string | null) ?? null,
    };
  }
  /** Locks ONE version of a (locked) template and reads it. */
  private async lockVersion(trx: Trx, templateId: string, versionNumber: number, code: string) {
    const locked =
      await sql<Row>`SELECT gig_template_version_id FROM catalog.gig_template_versions WHERE gig_template_id = ${templateId} AND version_number = ${versionNumber} FOR UPDATE`.execute(
        trx,
      );
    const id = locked.rows[0]?.gig_template_version_id as string | undefined;
    if (!id) throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', { code: String(code).slice(0, 64) });
    const row = (await sql<Row>`SELECT * FROM catalog.gig_template_versions WHERE gig_template_version_id = ${id}`.execute(trx)).rows[0]!;
    return { id, row, status: row.status as string, revision: Number(row.revision), versionNumber };
  }

  // ================================================================== management: templates
  async createGigTemplate(input: unknown, actor: string): Promise<GigTemplateView> {
    const body = parseInput(CreateGigTemplateRequest, input);
    this.gateTestCode(body.code);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const locked = await sql<Row>`SELECT service_type_id FROM catalog.service_types WHERE code = ${body.serviceTypeCode} FOR SHARE`.execute(trx);
      const serviceTypeId = locked.rows[0]?.service_type_id as string | undefined;
      if (!serviceTypeId)
        throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code: String(body.serviceTypeCode).slice(0, 64) });
      const inserted = await sql<Row>`INSERT INTO catalog.gig_templates (service_type_id, code, description_content_key, instructions_content_key)
        VALUES (${serviceTypeId}, ${body.code}, ${body.withDescription ? gigTemplateDescriptionKey(body.code) : null}, ${body.withInstructions ? gigTemplateInstructionsKey(body.code) : null})
        RETURNING gig_template_id`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_CREATED',
        gigTemplateId: inserted.rows[0]!.gig_template_id as string,
        changes: {
          status: [null, 'DRAFT'],
          serviceTypeCode: [null, body.serviceTypeCode],
          withDescription: [null, body.withDescription === true],
          withInstructions: [null, body.withInstructions === true],
        },
        reason: body.reason,
      });
    });
    return this.getGigTemplate(body.code);
  }

  async updateGigTemplate(code: string, input: unknown, actor: string): Promise<GigTemplateView> {
    const body = parseInput(UpdateGigTemplateRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const description = body.withDescription === undefined ? t.descriptionContentKey : body.withDescription ? gigTemplateDescriptionKey(code) : null;
      const instructions = body.withInstructions === undefined ? t.instructionsContentKey : body.withInstructions ? gigTemplateInstructionsKey(code) : null;
      const changes: Record<string, [boolean, boolean]> = {};
      if (description !== t.descriptionContentKey) changes.withDescription = [t.descriptionContentKey !== null, description !== null];
      if (instructions !== t.instructionsContentKey) changes.withInstructions = [t.instructionsContentKey !== null, instructions !== null];
      if (Object.keys(changes).length === 0) return false;
      await sql`UPDATE catalog.gig_templates SET description_content_key = ${description}, instructions_content_key = ${instructions} WHERE gig_template_id = ${t.id}`.execute(
        trx,
      );
      await this.audit(trx, cid, { actor, action: 'GIG_TEMPLATE_UPDATED', gigTemplateId: t.id, changes, reason: body.reason });
      return true;
    });
    if (changed) await this.invalidate();
    return this.getGigTemplate(code);
  }

  /**
   * Sets the status of the template identity. Retiring discards an open DRAFT version first (audited) and closes the ACTIVE version (the database does it; the audit row says so): the
   * versions are kept. A repeat of the current status changes nothing.
   */
  async setGigTemplateStatus(code: string, input: unknown, actor: string): Promise<GigTemplateView> {
    const body = parseInput(CatalogStatusRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      if (t.status === body.status) return false;
      if (body.status === 'RETIRED') {
        const draft = (
          await sql<Row>`SELECT gig_template_version_id, version_number FROM catalog.gig_template_versions WHERE gig_template_id = ${t.id} AND status = 'DRAFT' FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (draft) {
          await sql`UPDATE catalog.gig_template_versions SET status = 'RETIRED' WHERE gig_template_version_id = ${draft.gig_template_version_id as string}`.execute(
            trx,
          );
          await this.audit(trx, cid, {
            actor,
            action: 'GIG_TEMPLATE_VERSION_RETIRED',
            gigTemplateId: t.id,
            gigTemplateVersionId: draft.gig_template_version_id as string,
            changes: { status: ['DRAFT', 'RETIRED'], versionNumber: [Number(draft.version_number), Number(draft.version_number)], because: 'TEMPLATE_RETIRED' },
            reason: body.reason,
          });
        }
      }
      const active =
        body.status === 'RETIRED'
          ? (
              await sql<Row>`SELECT gig_template_version_id, version_number FROM catalog.gig_template_versions WHERE gig_template_id = ${t.id} AND status = 'ACTIVE' FOR UPDATE`.execute(
                trx,
              )
            ).rows[0]
          : undefined;
      await sql`UPDATE catalog.gig_templates SET status = ${body.status} WHERE gig_template_id = ${t.id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_STATUS_CHANGED',
        gigTemplateId: t.id,
        changes: { status: [t.status, body.status] },
        reason: body.reason,
      });
      if (active)
        await this.audit(trx, cid, {
          actor,
          action: 'GIG_TEMPLATE_VERSION_RETIRED',
          gigTemplateId: t.id,
          gigTemplateVersionId: active.gig_template_version_id as string,
          changes: {
            status: ['ACTIVE', 'RETIRED'],
            versionNumber: [Number(active.version_number), Number(active.version_number)],
            because: 'TEMPLATE_RETIRED',
          },
          reason: body.reason,
        });
      const payload: GigTemplateEventPayload = { gigTemplateCode: code, serviceTypeCode: t.serviceTypeCode };
      if (body.status === 'ACTIVE') await this.event(trx, cid, GIG_TEMPLATE_EVENTS.activated, 'catalog_gig_template', t.id, payload, actor);
      else if (body.status === 'RETIRED') await this.event(trx, cid, GIG_TEMPLATE_EVENTS.retired, 'catalog_gig_template', t.id, payload, actor);
      else if (t.status === 'ACTIVE') await this.event(trx, cid, GIG_TEMPLATE_EVENTS.deactivated, 'catalog_gig_template', t.id, payload, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getGigTemplate(code);
  }

  // ================================================================== management: versions
  /** Content entries that do not exist yet (a field cannot reference copy that is not there). */
  private async assertContentExists(trx: Trx, keys: string[]): Promise<void> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return;
    const found = new Set((await sql<Row>`SELECT key FROM content.entries WHERE key = ANY(${unique}::text[])`.execute(trx)).rows.map((r) => r.key as string));
    const missing = unique.filter((k) => !found.has(k));
    if (missing.length > 0)
      throw invalid('some content entries of the template do not exist: create them in the content registry first', {
        reason: 'CONTENT_ENTRY_MISSING',
        contentKeys: missing.slice(0, MAX_MISSING_KEYS_REPORTED),
      });
  }

  /** Replaces the children and the scalar columns of a DRAFT with `canon` (the caller holds the template and the version locks and bumps `revision` itself). */
  private async writeCanon(trx: Trx, templateCode: string, versionId: string, canon: Canon, bumpRevision: boolean): Promise<void> {
    await sql`DELETE FROM catalog.gig_template_field_options WHERE gig_template_field_id IN (SELECT gig_template_field_id FROM catalog.gig_template_fields WHERE gig_template_version_id = ${versionId})`.execute(
      trx,
    );
    await sql`DELETE FROM catalog.gig_template_fields WHERE gig_template_version_id = ${versionId}`.execute(trx);
    await sql`DELETE FROM catalog.gig_template_requirements WHERE gig_template_version_id = ${versionId}`.execute(trx);
    await this.assertContentExists(trx, contentKeysOf(templateCode, canon));
    for (const [i, f] of canon.fields.entries()) {
      const inserted = await sql<Row>`INSERT INTO catalog.gig_template_fields
          (gig_template_version_id, field_key, field_type, section, behavior, customer_visible, display_order, label_content_key, help_content_key, default_content_key,
           min_length, max_length, min_number, max_number, default_number, default_boolean, min_items, max_items)
        VALUES (${versionId}, ${f.fieldKey}, ${f.fieldType}, ${f.section}, ${f.behavior}, ${f.customerVisible}, ${i + 1}, ${gigTemplateFieldLabelKey(templateCode, f.fieldKey)},
                ${f.withHelp ? gigTemplateFieldHelpKey(templateCode, f.fieldKey) : null}, ${f.withDefaultText ? gigTemplateFieldDefaultKey(templateCode, f.fieldKey) : null},
                ${f.minLength}, ${f.maxLength}, ${f.minNumber}, ${f.maxNumber}, ${f.defaultNumber}, ${f.defaultBoolean}, ${f.minItems}, ${f.maxItems})
        RETURNING gig_template_field_id`.execute(trx);
      const fieldId = inserted.rows[0]!.gig_template_field_id as string;
      for (const [j, o] of f.options.entries())
        await sql`INSERT INTO catalog.gig_template_field_options (gig_template_field_id, option_code, label_content_key, is_default, display_order)
          VALUES (${fieldId}, ${o.optionCode}, ${gigTemplateOptionLabelKey(templateCode, f.fieldKey, o.optionCode)}, ${o.isDefault}, ${j + 1})`.execute(trx);
    }
    for (const q of canon.requirements)
      await sql`INSERT INTO catalog.gig_template_requirements (gig_template_version_id, requirement_type, reference_code) VALUES (${versionId}, ${q.requirementType}, ${q.referenceCode})`.execute(
        trx,
      );
    const has = <T>(list: readonly T[], m: T): boolean => list.includes(m);
    await sql`UPDATE catalog.gig_template_versions SET
        min_duration_minutes = ${canon.duration.min}, max_duration_minutes = ${canon.duration.max}, suggested_duration_minutes = ${canon.duration.suggested},
        pricing_fixed = ${has(canon.pricing, 'FIXED')}, pricing_fixed_with_variants = ${has(canon.pricing, 'FIXED_WITH_VARIANTS')},
        pricing_bundle_eligible = ${has(canon.pricing, 'BUNDLE_ELIGIBLE')}, pricing_drop_eligible = ${has(canon.pricing, 'DROP_ELIGIBLE')},
        pricing_add_ons = ${has(canon.pricing, 'ADD_ONS')},
        area_radius = ${has(canon.area, 'RADIUS')}, area_postal_codes = ${has(canon.area, 'POSTAL_CODES')}, area_polygon = ${has(canon.area, 'POLYGON')},
        revision = revision + ${bumpRevision ? 1 : 0}
      WHERE gig_template_version_id = ${versionId}`.execute(trx);
  }

  /** The stored canonical definition of a version (read inside the caller's transaction). */
  private async storedCanon(trx: Trx, versionRow: Row): Promise<Canon> {
    const s = (await this.loadStructure(trx, [versionRow.gig_template_version_id as string])).get(versionRow.gig_template_version_id as string)!;
    return canonFromStored(versionRow, s.fields, s.requirements);
  }

  /** Creates the next DRAFT (highest number + 1), optionally starting from the structure of an existing version. At most one draft per template. */
  async createGigTemplateVersion(code: string, input: unknown, actor: string): Promise<GigTemplateVersionView> {
    const body = parseInput(CreateGigTemplateVersionRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const number = await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      if (t.status === 'RETIRED') throw new CatalogError('INVALID_STATE', 'a RETIRED Gig Template accepts no new version', { reason: 'GIG_TEMPLATE_RETIRED' });
      const max = Number(
        (await sql<Row>`SELECT COALESCE(max(version_number), 0) AS n FROM catalog.gig_template_versions WHERE gig_template_id = ${t.id}`.execute(trx)).rows[0]!
          .n,
      );
      let canon: Canon | undefined;
      if (body.copyFromVersion !== undefined) {
        const source = (
          await sql<Row>`SELECT * FROM catalog.gig_template_versions WHERE gig_template_id = ${t.id} AND version_number = ${body.copyFromVersion}`.execute(trx)
        ).rows[0];
        if (!source) throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version to copy is not registered', { code: String(code).slice(0, 64) });
        canon = await this.storedCanon(trx, source);
      }
      const inserted =
        await sql<Row>`INSERT INTO catalog.gig_template_versions (gig_template_id, version_number) VALUES (${t.id}, ${max + 1}) RETURNING gig_template_version_id`.execute(
          trx,
        );
      const versionId = inserted.rows[0]!.gig_template_version_id as string;
      if (canon) await this.writeCanon(trx, code, versionId, canon, false);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_VERSION_CREATED',
        gigTemplateId: t.id,
        gigTemplateVersionId: versionId,
        changes: { versionNumber: [null, max + 1], status: [null, 'DRAFT'], copiedFromVersion: [null, body.copyFromVersion ?? null] },
        reason: body.reason,
      });
      return max + 1;
    });
    return this.getGigTemplateVersion(code, number);
  }

  /**
   * Replaces the WHOLE definition of the DRAFT in one atomic change. `expectedRevision` is the revision the administrator last read: a different one is STALE_DRAFT (nothing is written).
   * A definition equal to the stored one changes nothing (no revision bump, no audit row).
   */
  async replaceGigTemplateDraft(code: string, versionNumber: number, input: unknown, actor: string): Promise<GigTemplateVersionView> {
    const n = normalizeVersionNumber(versionNumber);
    const body = parseInput(ReplaceGigTemplateDraftRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const v = await this.lockVersion(trx, t.id, n, code);
      if (v.status !== 'DRAFT') throw new CatalogError('INVALID_STATE', 'only a DRAFT version can change', { reason: 'VERSION_NOT_DRAFT' });
      if (v.revision !== body.expectedRevision)
        throw new CatalogError('CONFLICT', 'the draft changed since it was read: read it again', { reason: 'STALE_DRAFT' });
      const before = await this.storedCanon(trx, v.row);
      const after = canonFromRequest(body);
      const diff = diffCanon(before, after);
      if (Object.keys(diff).length === 0) return;
      await this.writeCanon(trx, code, v.id, after, true);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_VERSION_CHANGED',
        gigTemplateId: t.id,
        gigTemplateVersionId: v.id,
        changes: { revision: [v.revision, v.revision + 1], ...diff },
        reason: body.reason,
      });
    });
    return this.getGigTemplateVersion(code, n);
  }

  /**
   * Publishes the DRAFT: it becomes the ACTIVE version, freezes with all its rows and supersedes the previous ACTIVE version (the database does both). Needs an ACTIVE template and service
   * type, at least one field and every content key published. `expectedRevision` must be the draft's current revision (STALE_DRAFT otherwise). Publishing an already ACTIVE version with the
   * same revision is a no-op (a repeat after a lost response).
   */
  async publishGigTemplateVersion(code: string, versionNumber: number, input: unknown, actor: string): Promise<GigTemplateVersionView> {
    const n = normalizeVersionNumber(versionNumber);
    const body = parseInput(PublishGigTemplateVersionRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const v = await this.lockVersion(trx, t.id, n, code);
      if (v.status === 'ACTIVE' && v.revision === body.expectedRevision) return false;
      if (v.status !== 'DRAFT') throw new CatalogError('INVALID_STATE', 'only a DRAFT version can be published', { reason: 'VERSION_NOT_DRAFT' });
      if (v.revision !== body.expectedRevision)
        throw new CatalogError('CONFLICT', 'the draft changed since it was read: read it again', { reason: 'STALE_DRAFT' });
      if (t.status !== 'ACTIVE')
        throw new CatalogError('INVALID_STATE', 'a version can be published only while its Gig Template is ACTIVE', { reason: 'GIG_TEMPLATE_NOT_ACTIVE' });
      const canon = await this.storedCanon(trx, v.row);
      // name the copy that is not published yet (the database guard is the backstop and says only that something is missing)
      const keys = [
        (await sql<Row>`SELECT name_content_key FROM catalog.gig_templates WHERE gig_template_id = ${t.id}`.execute(trx)).rows[0]!.name_content_key as string,
      ];
      if (t.descriptionContentKey) keys.push(t.descriptionContentKey);
      if (t.instructionsContentKey) keys.push(t.instructionsContentKey);
      keys.push(...contentKeysOf(code, canon));
      const missing = (
        await sql<Row>`SELECT k FROM unnest(${[...new Set(keys)]}::text[]) AS k WHERE NOT catalog.content_is_published(k) ORDER BY k COLLATE "C"`.execute(trx)
      ).rows.map((r) => r.k as string);
      if (missing.length > 0)
        throw new CatalogError('INVALID_STATE', 'some copy of the template is not published in the platform default locale', {
          reason: 'CONTENT_NOT_PUBLISHED',
          contentKeys: missing.slice(0, MAX_MISSING_KEYS_REPORTED),
        });
      const previous = (
        await sql<Row>`SELECT version_number FROM catalog.gig_template_versions WHERE gig_template_id = ${t.id} AND status = 'ACTIVE'`.execute(trx)
      ).rows[0];
      await sql`UPDATE catalog.gig_template_versions SET status = 'ACTIVE' WHERE gig_template_version_id = ${v.id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_VERSION_PUBLISHED',
        gigTemplateId: t.id,
        gigTemplateVersionId: v.id,
        changes: {
          status: ['DRAFT', 'ACTIVE'],
          versionNumber: [n, n],
          supersedesVersion: [null, previous ? Number(previous.version_number) : null],
          fieldCount: [null, canon.fields.length],
        },
        reason: body.reason,
      });
      const payload: GigTemplatePublishedPayload = { gigTemplateCode: code, serviceTypeCode: t.serviceTypeCode, versionNumber: n, gigTemplateVersionId: v.id };
      await this.event(trx, cid, GIG_TEMPLATE_EVENTS.published, 'catalog_gig_template', t.id, payload, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getGigTemplateVersion(code, n);
  }

  /**
   * Discards a DRAFT (status RETIRED: the row, its number and its rows stay). A published version is never withdrawn on its own: pause the template (INACTIVE) or retire it, which closes the
   * ACTIVE version and keeps the history. A repeat on a discarded draft changes nothing.
   */
  async retireGigTemplateVersion(code: string, versionNumber: number, input: unknown, actor: string): Promise<GigTemplateVersionView> {
    const n = normalizeVersionNumber(versionNumber);
    const body = parseInput(GigTemplateVersionRetireRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    await this.tx(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const v = await this.lockVersion(trx, t.id, n, code);
      if (v.status === 'RETIRED') return;
      if (v.status !== 'DRAFT') throw new CatalogError('INVALID_STATE', 'only a DRAFT version can be discarded', { reason: 'ONLY_DRAFT_CAN_BE_DISCARDED' });
      await sql`UPDATE catalog.gig_template_versions SET status = 'RETIRED' WHERE gig_template_version_id = ${v.id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'GIG_TEMPLATE_VERSION_RETIRED',
        gigTemplateId: t.id,
        gigTemplateVersionId: v.id,
        changes: { status: ['DRAFT', 'RETIRED'], versionNumber: [n, n] },
        reason: body.reason,
      });
    });
    return this.getGigTemplateVersion(code, n);
  }

  // ================================================================== management: market availability
  /**
   * Sets whether a template is offered in a market and its position among the market's templates. `displayOrder` is required when the row does not exist yet. A market of any status can be
   * prepared; the template need not be ACTIVE yet (a RETIRED one cannot be enabled). A repeat that changes nothing writes nothing.
   */
  async setMarketGigTemplateAvailability(marketCode: string, code: string, input: unknown, actor: string): Promise<GigTemplateMarketAvailabilityDto> {
    const body = parseInput(SetMarketGigTemplateAvailabilityRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const result = await this.retryOnRace(() =>
      this.tx(async (trx) => {
        const marketId = await this.marketIdOf(trx, marketCode);
        const t = await this.lockTemplate(trx, code, 'share');
        const lockedRow =
          await sql<Row>`SELECT 1 AS ok FROM catalog.market_gig_templates WHERE market_id = ${marketId} AND gig_template_id = ${t.id} FOR UPDATE`.execute(trx);
        const existing = lockedRow.rows[0]
          ? (
              await sql<Row>`SELECT enabled, display_order FROM catalog.market_gig_templates WHERE market_id = ${marketId} AND gig_template_id = ${t.id}`.execute(
                trx,
              )
            ).rows[0]
          : undefined;
        let displayOrder = body.displayOrder;
        if (!existing) {
          if (displayOrder === undefined)
            throw invalid('displayOrder is required when the Gig Template is not yet part of the market', {
              reason: 'DISPLAY_ORDER_REQUIRED',
              field: 'displayOrder',
            });
          await sql`INSERT INTO catalog.market_gig_templates (market_id, gig_template_id, enabled, display_order) VALUES (${marketId}, ${t.id}, ${body.enabled}, ${displayOrder})`.execute(
            trx,
          );
        } else {
          displayOrder = displayOrder ?? Number(existing.display_order);
          if ((existing.enabled === true) === body.enabled && displayOrder === Number(existing.display_order))
            return { changed: false, dto: { marketCode, code, enabled: body.enabled, displayOrder } };
          await sql`UPDATE catalog.market_gig_templates SET enabled = ${body.enabled}, display_order = ${displayOrder} WHERE market_id = ${marketId} AND gig_template_id = ${t.id}`.execute(
            trx,
          );
        }
        await this.audit(trx, cid, {
          actor,
          action: 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED',
          gigTemplateId: t.id,
          marketId,
          changes: {
            enabled: [existing ? existing.enabled === true : null, body.enabled],
            displayOrder: [existing ? Number(existing.display_order) : null, displayOrder],
          },
          reason: body.reason,
        });
        const payload: GigTemplateAvailabilityEventPayload = { marketCode, gigTemplateCode: code, enabled: body.enabled };
        await this.event(trx, cid, GIG_TEMPLATE_EVENTS.availabilityChanged, 'catalog_market_availability', marketId, payload, actor);
        return { changed: true, dto: { marketCode, code, enabled: body.enabled, displayOrder: displayOrder as number } };
      }),
    );
    if (result.changed) await this.invalidate();
    return result.dto;
  }
}

export type {
  GigTemplateFieldDetailView,
  GigTemplateVersionDetailView,
  GigTemplateFieldView,
  GigTemplateRequirementView,
  GigTemplateVersionSummaryView,
  GigTemplateVersionView,
  GigTemplateView,
};
