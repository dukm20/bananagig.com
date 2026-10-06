// Deterministic, batched configuration resolution. One scope hierarchy (configuration.scope_levels), no per-module chains.
import { sql, type DatabaseSchema, type Kysely } from '@bananagig/database';
import { SCOPE_TYPES, type ConfigContext, type Criticality, type DataType, type ScopeType, type Sensitivity } from '@bananagig/contracts';
import { ConfigurationError } from './errors';

export interface Resolved {
  key: string;
  parameterId: string;
  dataType: DataType;
  sensitivity: Sensitivity;
  criticality: Criticality;
  value: unknown;
  sourceScope: ScopeType;
  scopeRef: string | null;
  version: number;
  versionId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}
export interface Candidate extends Resolved {
  rank: number;
}

const CONTEXT_KEYS: Record<keyof ConfigContext, ScopeType> = {
  country: 'COUNTRY',
  market: 'MARKET',
  category: 'CATEGORY',
  plan: 'PLAN',
  provider: 'PROVIDER',
  gig: 'GIG',
  drop: 'DROP',
};

/** (scope type, reference) pairs present in a context. PLATFORM needs no reference and always applies. */
export function contextPairs(ctx: ConfigContext): { types: string[]; refs: string[] } {
  const entries = (Object.keys(CONTEXT_KEYS) as (keyof ConfigContext)[]).filter((k) => ctx[k] !== undefined);
  return { types: entries.map((k) => CONTEXT_KEYS[k]), refs: entries.map((k) => ctx[k] as string) };
}

/**
 * Picks the most specific candidate per key. Ranks come from the database hierarchy. Ties cannot occur for the same holder
 * (the exclusion constraint) and cannot occur across levels (distinct ranks); the tie-breakers exist only to stay deterministic.
 */
export function pickWinners(candidates: Candidate[]): Map<string, Resolved> {
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const cur = best.get(c.key);
    if (!cur || c.rank > cur.rank || (c.rank === cur.rank && (c.version > cur.version || (c.version === cur.version && c.versionId > cur.versionId))))
      best.set(c.key, c);
  }
  return new Map([...best].map(([k, { rank: _rank, ...r }]) => [k, r]));
}

export interface BatchResult {
  resolved: Map<string, Resolved>;
  /** Keys that exist and are active but have no value effective at `at` (required ones are reported by the caller). */
  missing: { key: string; parameterId: string; isRequired: boolean; criticality: Criticality }[];
  unknown: string[];
  /** Earliest instant after `at` at which any applicable value starts or ends: the result is valid until then. */
  nextChangeAt: Date | null;
  at: Date;
}

type Row = Record<string, unknown>;

/** Resolves many keys in 3 queries total (definitions, candidates, next boundary), independent of the number of keys. */
export async function resolveBatch(db: Kysely<DatabaseSchema>, keys: string[], ctx: ConfigContext, atInput?: Date): Promise<BatchResult> {
  const k = db;
  const { types, refs } = contextPairs(ctx);
  const defs = await sql<Row>`
    SELECT req.key AS requested_key, p.parameter_id, p.key, p.data_type, p.sensitivity, p.criticality, p.is_required, p.is_active, clock_timestamp() AS db_now
      FROM unnest(${keys}::text[]) AS req(key) LEFT JOIN configuration.parameters p ON p.key = req.key`.execute(k);
  const at = atInput ?? (defs.rows[0]?.db_now as Date) ?? new Date();
  const known = defs.rows.filter((r) => r.parameter_id !== null);
  const unknown = defs.rows.filter((r) => r.parameter_id === null).map((r) => r.requested_key as string);
  const active = known.filter((r) => r.is_active as boolean);
  const ids = active.map((r) => r.parameter_id as string);
  if (!ids.length)
    return { resolved: new Map(), missing: [], unknown: unknown.concat(known.filter((r) => !r.is_active).map((r) => r.key as string)), nextChangeAt: null, at };

  const applicable = sql`(pv.scope_type = 'PLATFORM' OR EXISTS (SELECT 1 FROM unnest(${types}::text[], ${refs}::text[]) AS c(t, r) WHERE c.t = pv.scope_type AND c.r = pv.scope_ref))`;
  const cands = await sql<Row>`
    SELECT p.parameter_id, p.key, p.data_type, p.sensitivity, p.criticality, sl.rank, pv.scope_type, pv.scope_ref,
           vv.version_id, vv.version, vv.value, vv.effective_from, vv.effective_to
      FROM configuration.parameters p
      JOIN configuration.parameter_values pv ON pv.parameter_id = p.parameter_id
      JOIN configuration.scope_levels sl ON sl.scope_type = pv.scope_type
      JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
     WHERE p.parameter_id = ANY(${ids}::uuid[]) AND ${applicable}
       AND vv.effective_from <= ${at} AND (vv.effective_to IS NULL OR vv.effective_to > ${at})`.execute(k);
  const resolved = pickWinners(
    cands.rows.map((r) => ({
      key: r.key as string,
      parameterId: r.parameter_id as string,
      dataType: r.data_type as DataType,
      sensitivity: r.sensitivity as Sensitivity,
      criticality: r.criticality as Criticality,
      value: r.value,
      sourceScope: r.scope_type as ScopeType,
      scopeRef: (r.scope_ref as string | null) ?? null,
      version: r.version as number,
      versionId: r.version_id as string,
      effectiveFrom: r.effective_from as Date,
      effectiveTo: (r.effective_to as Date | null) ?? null,
      rank: Number(r.rank),
    })),
  );
  const boundary = await sql<{ t: Date | null }>`
    SELECT min(t) AS t FROM (
      SELECT vv.effective_from AS t FROM configuration.parameter_values pv JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
       WHERE pv.parameter_id = ANY(${ids}::uuid[]) AND ${applicable} AND vv.effective_from > ${at}
      UNION ALL
      SELECT vv.effective_to FROM configuration.parameter_values pv JOIN configuration.value_versions vv ON vv.parameter_value_id = pv.parameter_value_id
       WHERE pv.parameter_id = ANY(${ids}::uuid[]) AND ${applicable} AND vv.effective_to > ${at}) b`.execute(k);
  const missing = active
    .filter((r) => !resolved.has(r.key as string))
    .map((r) => ({
      key: r.key as string,
      parameterId: r.parameter_id as string,
      isRequired: r.is_required as boolean,
      criticality: r.criticality as Criticality,
    }));
  return {
    resolved,
    missing,
    unknown: unknown.concat(known.filter((r) => !r.is_active).map((r) => r.key as string)),
    nextChangeAt: boundary.rows[0]?.t ?? null,
    at,
  };
}

/** Throws the typed error for unknown parameters and for required parameters without an effective value. */
export function assertComplete(r: BatchResult): void {
  if (r.unknown.length) throw new ConfigurationError('PARAMETER_NOT_FOUND', 'unknown or inactive configuration parameter(s)', { keys: r.unknown });
  const required = r.missing.filter((m) => m.isRequired);
  if (required.length)
    throw new ConfigurationError('NO_VALUE', 'no configuration value is effective for the required parameter(s); no code fallback exists by design', {
      keys: required.map((m) => m.key),
    });
}

export { SCOPE_TYPES };
