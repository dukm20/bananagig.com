// Deterministic, batched content resolution (docs/engineering/CONTENT.md). One scope hierarchy (configuration.scope_levels), one locale chain per entry.
// Precedence: chain position FIRST (an exact-locale version beats any fallback-locale version), then scope specificity within the same locale.
// Resolution reads only published versions of ACTIVE locales and never depends on the activation job.
import { sql, type DatabaseSchema, type Kysely } from '@bananagig/database';
import {
  canonicalizeLocale,
  type ContentContext,
  type ContentScopeType,
  type ContentSensitivity,
  type ContentType,
  type Criticality,
  type FallbackPolicy,
  type PiiClass,
  type VariableDefinitionDto,
  type VariableType,
} from '@bananagig/contracts';
import { ContentError } from './errors';
import { buildFallbackChain } from './locale';

export interface ResolvedContent {
  key: string;
  entryId: string;
  contentType: ContentType;
  sensitivity: ContentSensitivity;
  criticality: Criticality;
  /** The locale the caller asked for (canonical). */
  requestedLocale: string;
  /** The locale of the version that won. */
  resolvedLocale: string;
  /** `applied` is true when resolvedLocale differs from requestedLocale; `chain` is the ACTIVE locales considered, in order, for this entry's policy. */
  fallback: { applied: boolean; chain: string[] };
  version: number;
  versionId: string;
  sourceScope: ContentScopeType;
  scopeRef: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Template source (never executed; rendered by renderResolved). */
  body: string;
  bodySha256: string;
  variables: VariableDefinitionDto[];
}

/** A published version that is effective at the evaluation instant, with the rank of its scope level. */
export interface Candidate {
  versionId: string;
  version: number;
  locale: string;
  scopeType: ContentScopeType;
  scopeRef: string | null;
  /** configuration.scope_levels.rank: higher is more specific. */
  rank: number;
  body: string;
  bodySha256: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** Strict canonicalization for caller input: surrounding whitespace is not tolerated (contracts' canonicalizeLocale trims). */
export function normalizeLocale(tag: unknown, what = 'locale'): string {
  const canonical = typeof tag === 'string' && tag === tag.trim() ? canonicalizeLocale(tag) : null;
  if (!canonical) throw new ContentError('VALIDATION_FAILED', `${what} is not a supported BCP 47 locale tag`, { reason: 'INVALID_LOCALE', field: what });
  return canonical;
}

/** Canonicalizes marketDefaultLocale and drops undefined members, so equal contexts hash and compare equal. */
export function normalizeContext(context: ContentContext | undefined): ContentContext {
  const out: ContentContext = {};
  if (!context) return out;
  if (context.country !== undefined) out.country = context.country;
  if (context.market !== undefined) out.market = context.market;
  if (context.marketDefaultLocale !== undefined) out.marketDefaultLocale = normalizeLocale(context.marketDefaultLocale, 'marketDefaultLocale');
  return out;
}

/** (scope type, reference) pairs present in a context. PLATFORM needs no reference and always applies. */
export function contextScopePairs(ctx: ContentContext): { types: string[]; refs: string[] } {
  const types: string[] = [];
  const refs: string[] = [];
  if (ctx.country !== undefined) {
    types.push('COUNTRY');
    refs.push(ctx.country);
  }
  if (ctx.market !== undefined) {
    types.push('MARKET');
    refs.push(ctx.market);
  }
  return { types, refs };
}

/**
 * The winning candidate for one entry: lowest chain position, then highest scope rank. Ties cannot occur for one holder (exclusion
 * constraint) nor across scope levels (distinct ranks); the final tie-breakers (higher version, then versionId) only keep it deterministic.
 * Candidates whose locale is not in the chain are ignored.
 */
export function selectCandidate<C extends Candidate>(chain: readonly string[], candidates: readonly C[]): C | undefined {
  let best: C | undefined;
  let bestPos = Infinity;
  for (const c of candidates) {
    const pos = chain.indexOf(c.locale);
    if (pos < 0) continue;
    if (
      !best ||
      pos < bestPos ||
      (pos === bestPos &&
        (c.rank > best.rank || (c.rank === best.rank && (c.version > best.version || (c.version === best.version && c.versionId > best.versionId)))))
    ) {
      best = c;
      bestPos = pos;
    }
  }
  return best;
}

export interface MissingEntry {
  key: string;
  entryId: string;
  criticality: Criticality;
  /** Carried so callers without INTERNAL visibility can report an entry with no effective content exactly like an unknown key. */
  sensitivity: ContentSensitivity;
}
export interface BatchResult {
  resolved: Map<string, ResolvedContent>;
  /** Active entries with no version effective at `at` in any locale of their chain (a definitive "no content"; never served from LKG). */
  missing: MissingEntry[];
  /** Keys that do not exist or are inactive (indistinguishable on purpose). */
  unknown: string[];
  /** Earliest instant after `at` at which any applicable published version starts or ends: the result is valid until then. */
  nextChangeAt: Date | null;
  at: Date;
  /**
   * Whether the answer may be written to the resolution cache and last-known-good store. False when the cache key space would not be bounded by
   * operator-controlled data: the requested locale (or the market default locale) is not an ACTIVE locale, or a supplied country/market reference
   * matched no published version of the requested entries. Such requests are still answered correctly, from the database, every time.
   */
  cacheable: boolean;
}
export interface ResolveInput {
  /** Canonical requested locale. */
  locale: string;
  context: ContentContext;
}

type Row = Record<string, unknown>;

/** The entry's typed placeholders as a jsonb array (alias `e` must be content.entries). */
export const ENTRY_VARIABLES_SQL = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('name', v.name, 'type', v.var_type, 'required', v.is_required, 'description', v.description, 'example', v.example_value, 'piiClass', v.pii_class) ORDER BY v.name), '[]'::jsonb)
  FROM content.entry_variables v WHERE v.entry_id = e.entry_id)`;

export function mapVariables(raw: unknown): VariableDefinitionDto[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return ((list as Row[] | null) ?? []).map((v) => ({
    name: v.name as string,
    type: v.type as VariableType,
    required: v.required as boolean,
    description: v.description as string,
    example: v.example,
    piiClass: v.piiClass as PiiClass,
  }));
}

/** Resolves many keys in at most 3 queries (entries, candidates, next boundary), independent of the number of keys. */
export async function resolveBatch(db: Kysely<DatabaseSchema>, keys: string[], input: ResolveInput, atInput?: Date): Promise<BatchResult> {
  if (!keys.length) return { resolved: new Map(), missing: [], unknown: [], nextChangeAt: null, at: atInput ?? new Date(), cacheable: false };
  const requested = normalizeLocale(input.locale, 'locale');
  const { types, refs } = contextScopePairs(input.context);
  const entries = await sql<Row>`
    SELECT req.key AS requested_key, e.entry_id, e.content_type, e.sensitivity, e.criticality, e.fallback_policy, e.is_active,
           ${ENTRY_VARIABLES_SQL} AS variables,
           (SELECT coalesce(array_agg(l.locale), '{}') FROM content.locales l WHERE l.is_active) AS active_locales,
           (SELECT l.locale FROM content.locales l WHERE l.is_platform_default) AS platform_default,
           NOT EXISTS (
             SELECT 1 FROM unnest(${types}::text[], ${refs}::text[]) AS c(t, r)
              WHERE NOT EXISTS (
                SELECT 1 FROM content.versions cv JOIN content.entries ce ON ce.entry_id = cv.entry_id
                 WHERE ce.key = ANY(${keys}::text[]) AND cv.scope_type = c.t AND cv.scope_ref = c.r AND cv.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED'))
           ) AS context_matched,
           clock_timestamp() AS db_now
      FROM unnest(${keys}::text[]) AS req(key) LEFT JOIN content.entries e ON e.key = req.key`.execute(db);
  const at = atInput ?? (entries.rows[0]?.db_now as Date | undefined) ?? new Date();
  const platformDefault = (entries.rows[0]?.platform_default as string | null | undefined) ?? null;
  // "Exactly one platform default locale" is a database invariant (guard_locales + the unique index). If it is ever violated the last leg of every
  // fallback chain would silently disappear, so fail loudly instead of guessing.
  if (platformDefault === null)
    throw new ContentError('UNAVAILABLE', 'no platform default locale is configured; content cannot be resolved', { reason: 'NO_PLATFORM_DEFAULT' });
  const unknown = entries.rows.filter((r) => r.entry_id === null || !(r.is_active as boolean)).map((r) => r.requested_key as string);
  const active = entries.rows.filter((r) => r.entry_id !== null && (r.is_active as boolean));
  const activeLocales = new Set((entries.rows[0]?.active_locales as string[] | null) ?? []);
  const marketDefault = input.context.marketDefaultLocale;
  const cacheable =
    activeLocales.has(requested) && (marketDefault === undefined || activeLocales.has(marketDefault)) && entries.rows[0]?.context_matched === true;
  if (!active.length) return { resolved: new Map(), missing: [], unknown, nextChangeAt: null, at, cacheable };

  const chains = new Map<string, string[]>();
  const wanted = new Set<string>();
  for (const r of active) {
    const chain = buildFallbackChain({
      requested,
      policy: r.fallback_policy as FallbackPolicy,
      marketDefaultLocale: input.context.marketDefaultLocale,
      platformDefault,
      active: activeLocales,
    });
    chains.set(r.requested_key as string, chain);
    for (const l of chain) wanted.add(l);
  }
  const ids = active.map((r) => r.entry_id as string);
  const locales = [...wanted];
  const applicable = sql`(v.scope_type = 'PLATFORM' OR EXISTS (SELECT 1 FROM unnest(${types}::text[], ${refs}::text[]) AS c(t, r) WHERE c.t = v.scope_type AND c.r = v.scope_ref))`;

  const byEntry = new Map<string, Candidate[]>();
  let nextChangeAt: Date | null = null;
  if (locales.length) {
    const cands = await sql<Row>`
      SELECT v.entry_id, v.locale, v.scope_type, v.scope_ref, sl.rank, v.version_id, v.version, v.body, v.body_sha256, v.effective_from, v.effective_to
        FROM content.versions v
        JOIN content.locales l ON l.locale = v.locale AND l.is_active
        JOIN configuration.scope_levels sl ON sl.scope_type = v.scope_type
       WHERE v.entry_id = ANY(${ids}::uuid[]) AND v.locale = ANY(${locales}::text[])
         AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED') AND ${applicable}
         AND v.effective_from <= ${at} AND (v.effective_to IS NULL OR v.effective_to > ${at})`.execute(db);
    for (const r of cands.rows) {
      const list = byEntry.get(r.entry_id as string) ?? [];
      list.push({
        versionId: r.version_id as string,
        version: r.version as number,
        locale: r.locale as string,
        scopeType: r.scope_type as ContentScopeType,
        scopeRef: (r.scope_ref as string | null) ?? null,
        rank: Number(r.rank),
        body: r.body as string,
        bodySha256: r.body_sha256 as string,
        effectiveFrom: r.effective_from as Date,
        effectiveTo: (r.effective_to as Date | null) ?? null,
      });
      byEntry.set(r.entry_id as string, list);
    }
    const boundary = await sql<{ t: Date | null }>`
      SELECT min(t) AS t FROM (
        SELECT v.effective_from AS t FROM content.versions v JOIN content.locales l ON l.locale = v.locale AND l.is_active
         WHERE v.entry_id = ANY(${ids}::uuid[]) AND v.locale = ANY(${locales}::text[]) AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')
           AND ${applicable} AND v.effective_from > ${at}
        UNION ALL
        SELECT v.effective_to FROM content.versions v JOIN content.locales l ON l.locale = v.locale AND l.is_active
         WHERE v.entry_id = ANY(${ids}::uuid[]) AND v.locale = ANY(${locales}::text[]) AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')
           AND ${applicable} AND v.effective_to > ${at}) b`.execute(db);
    nextChangeAt = boundary.rows[0]?.t ?? null;
  }

  const resolved = new Map<string, ResolvedContent>();
  const missing: MissingEntry[] = [];
  for (const r of active) {
    const key = r.requested_key as string;
    const chain = chains.get(key)!;
    const entryId = r.entry_id as string;
    const win = selectCandidate(chain, byEntry.get(entryId) ?? []);
    if (!win) {
      missing.push({ key, entryId, criticality: r.criticality as Criticality, sensitivity: r.sensitivity as ContentSensitivity });
      continue;
    }
    resolved.set(key, {
      key,
      entryId,
      contentType: r.content_type as ContentType,
      sensitivity: r.sensitivity as ContentSensitivity,
      criticality: r.criticality as Criticality,
      requestedLocale: requested,
      resolvedLocale: win.locale,
      fallback: { applied: win.locale !== requested, chain },
      version: win.version,
      versionId: win.versionId,
      sourceScope: win.scopeType,
      scopeRef: win.scopeRef,
      effectiveFrom: win.effectiveFrom,
      effectiveTo: win.effectiveTo,
      body: win.body,
      bodySha256: win.bodySha256,
      variables: mapVariables(r.variables),
    });
  }
  return { resolved, missing, unknown, nextChangeAt, at, cacheable };
}
