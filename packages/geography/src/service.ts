// The geography registry service: currencies, time zones, countries and markets (reference data with data-driven defaults), market
// readiness, and the audited management operations. Transaction boundaries live here. Events go through the transactional outbox.
//
// Visibility: the service never reads roles. Callers decide: `management: true` (or `includeInactive: true` for market defaults) shows every
// status plus the management-only fields and bypasses the cache; the default is the public view (ACTIVE data only, public fields only).
// ONE lock order everywhere (deadlock freedom): the markets of the country first (market_id order: FOR UPDATE for the market being changed,
// FOR SHARE for all markets of a country that is being changed), then the country row (FOR UPDATE, or FOR SHARE when only read), then the
// currency, time zone and locale rows (FOR SHARE). A deactivation needs the row lock of the dependency, so it serializes with a concurrent
// activation that holds a share lock on it: exactly one wins and the other sees the committed state. Cache generations are bumped only AFTER commit.
// Rows are LOCKED with a bare single-table statement and READ by a second statement: in READ COMMITTED a `SELECT ... JOIN ... FOR UPDATE OF t`
// re-evaluates only the locked row after a lock wait; joined and ARRAY(subselect) columns would keep the old snapshot (stale audit diffs, spurious
// 404/409). Removing a link a market still uses is pre-checked with plain reads BEFORE any delete (the foreign key would lock the market row in
// the opposite order). The one inversion left is inherent: a raw SQL time zone deactivation locks the zone row first (see the migration), so it
// can deadlock with a market activation; PostgreSQL aborts one side and the service maps 40P01/40001 to a retryable CONFLICT (CONCURRENT_UPDATE).
import { randomUUID } from 'node:crypto';
import {
  CountryDto as CountryDtoSchema,
  CreateCountryRequest,
  CreateMarketRequest,
  CurrencyDto as CurrencyDtoSchema,
  GEOGRAPHY_EVENTS,
  MarketDefaultsDto as MarketDefaultsDtoSchema,
  MarketDto as MarketDtoSchema,
  TimeZoneDto as TimeZoneDtoSchema,
  UpdateCountryRequest,
  UpdateMarketRequest,
  canonicalizeLocale,
  type CountryDto,
  type CountryEventPayload,
  type CurrencyDto,
  type GeoStatus,
  type MarketDefaultsDto,
  type MarketDto,
  type MarketEventPayload,
  type MarketReadinessDto,
  type TimeZoneDto,
} from '@bananagig/contracts';
import type { ConfigCache } from '@bananagig/configuration';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { cachedRead, invalidateGeography, DEFAULT_GEO_CACHE_TTL_SECONDS, type ReadSource } from './cache';
import { GeographyError, isDatabaseOutage } from './errors';
import { defaultReadinessRegistry, toReadinessDto, type ReadinessContext, type ReadinessRegistry, type ReadinessReport } from './readiness';
import { invalid, isCountryCode, isMarketCode, requireAssignedCountryCode, requireIanaTimeZone, requireInstant } from './validation';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

// ---------------------------------------------------------------- public types
export interface ServiceDeps {
  database: Database;
  cache?: ConfigCache;
  env: string;
  /** Cache entry lifetime (default 300 s: reference data changes rarely and every change bumps the generation). */
  cacheTtlSeconds?: number;
  /** Deadline of each cache call (default 250 ms). */
  cacheDeadlineMs?: number;
  /** DEV/TEST only: permits `devtest-*` market codes and the test country ZZ. Must be false in production. */
  allowTestKeys?: boolean;
  /** Readiness registry (default: the process-wide registry with the four built-ins plus whatever other checkpoints registered). */
  readiness?: ReadinessRegistry;
  /** Clock (tests). */
  now?: () => Date;
}
export interface ReadOptions {
  /** Management view: every status, management-only fields, never cached. The caller has already authorized it. */
  management?: boolean;
}
export interface MarketListOptions extends ReadOptions {
  countryCode?: string;
}
export interface ActiveMarketsOptions {
  countryCode?: string;
  /** Evaluation instant for the effective window (default: now). */
  at?: Date;
}
export interface MarketDefaultsOptions {
  /** Evaluation instant for the effective window (default: now). Ignored with includeInactive. */
  at?: Date;
  /** Management view: PLANNED and INACTIVE markets (outside their window too) resolve; never cached. */
  includeInactive?: boolean;
}

// ---------------------------------------------------------------- errors
const REASON_MESSAGES: Record<string, string> = {
  COUNTRY_NOT_ACTIVE: 'the country is not ACTIVE',
  CURRENCY_NOT_ACTIVE: 'the currency is not ACTIVE',
  LOCALE_NOT_ACTIVE: 'the default locale is not an ACTIVE locale',
  TIME_ZONE_NOT_ACTIVE: 'the time zone is not ACTIVE',
};
/** The machine-readable key the migration puts in the DETAIL of every guard failure: exactly `geography_rule:<KEY>`. */
const RULE_DETAIL = /^geography_rule:([A-Z][A-Z_]*)$/;
export function guardRuleOf(detail: unknown): string | undefined {
  return typeof detail === 'string' ? RULE_DETAIL.exec(detail)?.[1] : undefined;
}
/** Translates a guard rule key (never message text: messages contain user-chosen codes) into a typed error. */
function guardError(rule: string | undefined): GeographyError {
  switch (rule) {
    case 'COUNTRY_NOT_ACTIVE':
    case 'CURRENCY_NOT_ACTIVE':
    case 'TIME_ZONE_NOT_ACTIVE':
    case 'LOCALE_NOT_ACTIVE':
      return new GeographyError('INVALID_STATE', `cannot be activated: ${REASON_MESSAGES[rule]}`, { reason: rule });
    case 'NO_ACTIVE_TIME_ZONE':
      return new GeographyError('INVALID_STATE', 'cannot be activated: the country has no ACTIVE time zone', { reason: rule });
    case 'COUNTRY_HAS_ACTIVE_MARKETS':
      return new GeographyError('INVALID_STATE', 'the country has ACTIVE markets; deactivate them first', { reason: rule });
    case 'CURRENCY_IN_USE':
    case 'TIME_ZONE_IN_USE':
    case 'LOCALE_IS_ACTIVE_DEFAULT':
      return new GeographyError('INVALID_STATE', 'cannot be deactivated while an ACTIVE country or market depends on it', { reason: 'IN_USE', rule });
    case 'LINKS_PROTECTED':
      return new GeographyError('INVALID_STATE', 'the locales and time zones of an ACTIVE country cannot be removed; deactivate the country first', {
        reason: 'LINKS_FROZEN',
      });
    case 'PLANNED_IS_INITIAL':
      return new GeographyError('INVALID_STATE', 'PLANNED is the initial status and cannot be set again', { reason: rule });
    case 'IMMUTABLE_IDENTITY':
    case 'NOT_DELETABLE':
    case 'ROW_IMMUTABLE':
      return new GeographyError('INVALID_STATE', 'the record is immutable (identity fields cannot change and rows are never deleted)', { reason: 'IMMUTABLE' });
    case 'NOT_IANA':
      return new GeographyError('TIME_ZONE_NOT_FOUND', 'the time zone is not a known IANA time zone', { reason: 'UNKNOWN_IANA_ZONE' });
    default:
      return new GeographyError('INVALID_STATE', 'the operation violates a geography integrity rule');
  }
}
/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed, clear messages (no driver text, no SQL, no table
 * names). Guard (trigger) failures are classified by `error.detail` (`geography_rule:<KEY>`), constraint failures by SQLSTATE and constraint name.
 */
export function mapDbError(err: unknown): never {
  if (err instanceof GeographyError) throw err;
  const e = err as { code?: string; detail?: string; constraint?: string };
  const constraint = e.constraint;
  // Deadlock, serialization failure, or lock timeout: retry the request as a concurrent update.
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03')
    throw new GeographyError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
      reason: 'CONCURRENT_UPDATE',
      retryable: true,
    });
  // NUL bytes (22021) and \u0000 in JSON (22P05) cannot be stored in text or jsonb
  if (e.code === '22021' || e.code === '22P05')
    throw new GeographyError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23P01') throw new GeographyError('CONFLICT', 'the change conflicts with an existing record', { constraint });
  if (e.code === '23505') {
    const what = constraint?.includes('markets') ? 'a market with this code already exists' : 'a record with this identity already exists';
    throw new GeographyError('CONFLICT', constraint?.startsWith('uq_countries') ? 'a country with this ISO code already exists' : what, { constraint });
  }
  if (e.code === '23514') {
    const message = constraint === 'ck_markets__effective_range' ? 'effectiveTo must be after effectiveFrom' : 'the operation violates a geography constraint';
    throw new GeographyError('VALIDATION_FAILED', message, { constraint });
  }
  if (e.code === '23502') throw new GeographyError('VALIDATION_FAILED', 'a required field is missing', { constraint });
  if (e.code === '23503') {
    if (constraint === 'fk_countries__default_currency_code' || constraint === 'fk_markets__currency_code')
      throw new GeographyError('CURRENCY_NOT_FOUND', 'the currency is not registered', { constraint });
    if (constraint === 'fk_country_locales__locale') throw new GeographyError('LOCALE_NOT_FOUND', 'the locale is not registered', { constraint });
    if (constraint === 'fk_country_time_zones__time_zone_id')
      throw new GeographyError('TIME_ZONE_NOT_FOUND', 'the time zone is not registered', { constraint });
    if (constraint === 'fk_market_locales__country_locale' || constraint === 'fk_markets__country_time_zone' || constraint === 'fk_markets__default_locale')
      throw new GeographyError('INVALID_STATE', 'a locale or time zone that a market still uses cannot be removed or must be supported by the country', {
        reason: 'IN_USE',
        constraint,
      });
    throw new GeographyError('VALIDATION_FAILED', 'a referenced record does not exist or is still in use', { constraint });
  }
  if (e.code === '23000') throw guardError(guardRuleOf(e.detail));
  if (isDatabaseOutage(err)) {
    log('error', 'geography database unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw new GeographyError('UNAVAILABLE', 'the geography database is unavailable');
  }
  throw err;
}

// ---------------------------------------------------------------- pure helpers (exported for tests)
const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const isoOrNull = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));
const sorted = (v: unknown): string[] => (Array.isArray(v) ? ([...v] as string[]).sort() : []);

export function mapCurrency(r: Row, management: boolean): CurrencyDto {
  return {
    code: r.currency_code as string,
    numericCode: r.numeric_code as string,
    minorUnitDigits: Number(r.minor_unit_digits),
    displayName: r.display_name as string,
    symbol: (r.symbol as string | null) ?? null,
    ...(management ? { status: r.status as GeoStatus } : {}),
  };
}
export function mapTimeZone(r: Row, management: boolean): TimeZoneDto {
  return { ianaName: r.iana_name as string, ...(management ? { status: r.status as GeoStatus } : {}) };
}
export function mapCountry(r: Row, management: boolean): CountryDto {
  return {
    code: r.iso_alpha2 as string,
    alpha3: r.iso_alpha3 as string,
    numeric: r.iso_numeric as string,
    displayNameContentKey: r.display_name_content_key as string,
    dialingCode: r.dialing_code as string,
    defaultCurrencyCode: r.default_currency_code as string,
    defaultLocale: r.default_locale as string,
    supportedLocales: sorted(r.supported_locales),
    timeZones: sorted(r.time_zones),
    distanceUnit: r.distance_unit as CountryDto['distanceUnit'],
    firstDayOfWeek: r.first_day_of_week as CountryDto['firstDayOfWeek'],
    dateFormat: r.date_format_code as CountryDto['dateFormat'],
    timeFormat: r.time_format_code as CountryDto['timeFormat'],
    ...(management ? { status: r.status as GeoStatus, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : {}),
  };
}
export function mapMarket(r: Row, management: boolean): MarketDto {
  return {
    code: r.code as string,
    name: r.name as string,
    countryCode: r.country_code as string,
    defaultLocale: r.default_locale as string,
    supportedLocales: sorted(r.supported_locales),
    currencyCode: r.currency_code as string,
    defaultTimeZone: r.default_time_zone as string,
    effectiveFrom: iso(r.effective_from),
    effectiveTo: isoOrNull(r.effective_to),
    ...(management ? { status: r.status as GeoStatus, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : {}),
  };
}

/**
 * Assembles the data-driven defaults of a market. The country supplies the format settings (single source), the market its locale,
 * currency and time zone. There is NO code fallback: every part must come from a row, otherwise a typed error is raised.
 * With `requireActive` (the public view) every dependency must also be ACTIVE (the database guards make anything else impossible; this
 * is the defense in depth).
 */
export function buildMarketDefaults(r: Row, requireActive: boolean): MarketDefaultsDto {
  const code = r.code as string;
  if (r.country_code === null || r.country_code === undefined)
    throw new GeographyError('COUNTRY_NOT_FOUND', 'the country of the market is not registered', { market: code });
  if (r.currency_code === null || r.currency_code === undefined)
    throw new GeographyError('CURRENCY_NOT_FOUND', 'the currency of the market is not registered', { market: code });
  if (r.time_zone === null || r.time_zone === undefined)
    throw new GeographyError('TIME_ZONE_NOT_FOUND', 'the time zone of the market is not registered', { market: code });
  if (requireActive) {
    const bad =
      r.country_status !== 'ACTIVE'
        ? 'COUNTRY_NOT_ACTIVE'
        : r.currency_status !== 'ACTIVE'
          ? 'CURRENCY_NOT_ACTIVE'
          : r.time_zone_status !== 'ACTIVE'
            ? 'TIME_ZONE_NOT_ACTIVE'
            : null;
    if (bad) throw new GeographyError('INVALID_STATE', `the market cannot be resolved: ${REASON_MESSAGES[bad]}`, { market: code, reason: bad });
  }
  return {
    market: { code, name: r.name as string, countryCode: r.country_code as string },
    country: { code: r.country_code as string, dialingCode: r.dialing_code as string },
    currency: { code: r.currency_code as string, minorUnitDigits: Number(r.minor_unit_digits), symbol: (r.symbol as string | null) ?? null },
    locale: r.default_locale as string,
    supportedLocales: sorted(r.supported_locales),
    timeZone: r.time_zone as string,
    distanceUnit: r.distance_unit as MarketDefaultsDto['distanceUnit'],
    firstDayOfWeek: r.first_day_of_week as MarketDefaultsDto['firstDayOfWeek'],
    dateFormat: r.date_format_code as MarketDefaultsDto['dateFormat'],
    timeFormat: r.time_format_code as MarketDefaultsDto['timeFormat'],
    effectiveFrom: iso(r.effective_from),
    effectiveTo: isoOrNull(r.effective_to),
  };
}

/** The market is in effect at `at`: the half-open window [effectiveFrom, effectiveTo) contains it. */
export function inEffect(w: { effectiveFrom: string; effectiveTo: string | null }, at: Date): boolean {
  return new Date(w.effectiveFrom).getTime() <= at.getTime() && (w.effectiveTo === null || at.getTime() < new Date(w.effectiveTo).getTime());
}

/** Field-level diff `{field: [old, new]}` over the named fields (sets compare as sorted lists). Unchanged fields are omitted. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    const a = before[f];
    const b = after[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = [a ?? null, b ?? null];
  }
  return out;
}

const BUILT_IN_REASONS: Record<string, string> = {
  COUNTRY_ACTIVE: 'COUNTRY_NOT_ACTIVE',
  CURRENCY_ACTIVE: 'CURRENCY_NOT_ACTIVE',
  LOCALE_ACTIVE: 'LOCALE_NOT_ACTIVE',
  TIME_ZONE_ACTIVE: 'TIME_ZONE_NOT_ACTIVE',
};
/**
 * Raises the typed error for a readiness report that does not allow activation.
 *  - a failing built-in dependency check (country, currency, locale, time zone) -> INVALID_STATE with details.reason (COUNTRY_NOT_ACTIVE, ...)
 *  - otherwise a failing required registered check -> NOT_READY
 * details.checks lists every failing required check (code, detail).
 */
export function assertReadyForActivation(market: string, report: ReadinessReport): void {
  const failing = report.checks.filter((c) => !c.passed && c.required);
  if (!failing.length) return;
  const checks = failing.map(({ code, detail }) => ({ code, detail }));
  const builtIn = failing.find((c) => BUILT_IN_REASONS[c.code]);
  if (builtIn)
    throw new GeographyError('INVALID_STATE', `market ${market} cannot be activated: ${builtIn.detail}`, {
      market,
      reason: BUILT_IN_REASONS[builtIn.code],
      checks,
    });
  throw new GeographyError('NOT_READY', `market ${market} is not ready for activation`, { market, checks });
}

interface SchemaLike<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; code: string }[] } };
}
function requestFailure(err: { issues: { path: PropertyKey[]; code: string }[] }): GeographyError {
  // paths and issue codes only: never the submitted values
  const issues = err.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
  return invalid(`the request is not valid${issues[0] ? ` (${issues[0].path || 'body'})` : ''}`, { reason: 'INVALID_REQUEST', issues });
}
function parseRequest<T>(schema: SchemaLike<T>, input: unknown, localeFields: readonly string[], setFields: readonly string[]): T {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('the request must be an object', { reason: 'INVALID_REQUEST' });
  const o: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  // tolerate casing of locale tags (en-us -> en-US) and de-duplicate sets; everything else is validated strictly
  for (const f of localeFields) if (typeof o[f] === 'string') o[f] = canonicalizeLocale(o[f]) ?? o[f];
  for (const f of setFields)
    if (Array.isArray(o[f]))
      o[f] = [...new Set((o[f] as unknown[]).map((x) => (typeof x === 'string' && f === 'supportedLocales' ? (canonicalizeLocale(x) ?? x) : x)))];
  const r = schema.safeParse(o);
  if (!r.success) throw requestFailure(r.error);
  return r.data;
}
const requireReason = (reason: unknown): string => {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000)
    throw invalid('reason must be a non-blank string of at most 1000 characters', { reason: 'INVALID_FIELD', field: 'reason' });
  return reason;
};

// ---------------------------------------------------------------- SQL
const countrySelect = (
  management: boolean,
) => sql`SELECT c.country_id, c.iso_alpha2, c.iso_alpha3, c.iso_numeric, c.display_name_content_key, c.status, c.dialing_code,
    c.default_currency_code, c.default_locale, c.distance_unit, c.first_day_of_week, c.date_format_code, c.time_format_code, c.created_at, c.updated_at,
    ARRAY(SELECT cl.locale FROM geography.country_locales cl WHERE cl.country_id = c.country_id AND (${management} OR EXISTS (SELECT 1 FROM content.locales l WHERE l.locale = cl.locale AND l.is_active)) ORDER BY cl.locale) AS supported_locales,
    ARRAY(SELECT t.iana_name FROM geography.country_time_zones cz JOIN geography.time_zones t ON t.time_zone_id = cz.time_zone_id
           WHERE cz.country_id = c.country_id AND (${management} OR t.status = 'ACTIVE') ORDER BY t.iana_name) AS time_zones
  FROM geography.countries c`;
const marketSelect = (
  management: boolean,
) => sql`SELECT m.market_id, m.code, m.name, m.country_id, m.status, m.default_locale, m.currency_code, m.default_time_zone_id,
    m.effective_from, m.effective_to, m.created_at, m.updated_at, c.iso_alpha2 AS country_code, tz.iana_name AS default_time_zone,
    ARRAY(SELECT ml.locale FROM geography.market_locales ml WHERE ml.market_id = m.market_id AND (${management} OR EXISTS (SELECT 1 FROM content.locales l WHERE l.locale = ml.locale AND l.is_active)) ORDER BY ml.locale) AS supported_locales
  FROM geography.markets m
  JOIN geography.countries c ON c.country_id = m.country_id
  JOIN geography.time_zones tz ON tz.time_zone_id = m.default_time_zone_id`;
const defaultsSelect = (management: boolean) => sql`SELECT m.code, m.name, m.status, m.default_locale, m.effective_from, m.effective_to,
    c.iso_alpha2 AS country_code, c.dialing_code, c.status AS country_status, c.distance_unit, c.first_day_of_week, c.date_format_code, c.time_format_code,
    cur.currency_code, cur.minor_unit_digits, cur.symbol, cur.status AS currency_status,
    tz.iana_name AS time_zone, tz.status AS time_zone_status,
    ARRAY(SELECT ml.locale FROM geography.market_locales ml WHERE ml.market_id = m.market_id AND (${management} OR EXISTS (SELECT 1 FROM content.locales l WHERE l.locale = ml.locale AND l.is_active)) ORDER BY ml.locale) AS supported_locales
  FROM geography.markets m
  LEFT JOIN geography.countries c ON c.country_id = m.country_id
  LEFT JOIN geography.currencies cur ON cur.currency_code = m.currency_code
  LEFT JOIN geography.time_zones tz ON tz.time_zone_id = m.default_time_zone_id`;

const COUNTRY_FIELDS = [
  'displayNameContentKey',
  'dialingCode',
  'defaultCurrencyCode',
  'defaultLocale',
  'supportedLocales',
  'timeZones',
  'distanceUnit',
  'firstDayOfWeek',
  'dateFormat',
  'timeFormat',
] as const;
const COUNTRY_FORMAT_FIELDS = ['distanceUnit', 'firstDayOfWeek', 'dateFormat', 'timeFormat'] as const;
const MARKET_FIELDS = ['name', 'defaultLocale', 'supportedLocales', 'currencyCode', 'defaultTimeZone', 'effectiveFrom', 'effectiveTo'] as const;
const MARKET_DEFAULT_FIELDS = ['defaultLocale', 'currencyCode', 'defaultTimeZone'] as const;

type DtoSchema<T> = { safeParse(v: unknown): { success: boolean; data?: T } };
const dtoOne =
  <T>(s: DtoSchema<T>) =>
  (raw: unknown): T | null => {
    const r = s.safeParse(raw);
    return r.success ? (r.data as T) : null;
  };
const dtoList =
  <T>(s: DtoSchema<T>) =>
  (raw: unknown): T[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: T[] = [];
    for (const x of raw) {
      const r = s.safeParse(x);
      if (!r.success) return null;
      out.push(r.data as T);
    }
    return out;
  };

export class GeographyService {
  private readonly ttl: number;
  private readonly readiness: ReadinessRegistry;

  constructor(private readonly d: ServiceDeps) {
    this.ttl = d.cacheTtlSeconds ?? DEFAULT_GEO_CACHE_TTL_SECONDS;
    this.readiness = d.readiness ?? defaultReadinessRegistry;
  }

  private get db(): Executor {
    return this.d.database.db;
  }
  private nowDate(): Date {
    return this.d.now?.() ?? new Date();
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch(mapDbError);
  }
  private cached<T>(what: string, load: () => Promise<T | null>, parse: (raw: unknown) => T | null): Promise<{ value: T | null; source: ReadSource }> {
    return cachedRead<T>({
      cache: this.d.cache,
      env: this.d.env,
      what,
      ttlSeconds: this.ttl,
      deadlineMs: this.d.cacheDeadlineMs,
      load: () => this.read(load),
      parse,
    });
  }
  private invalidate(): Promise<void> {
    return invalidateGeography(this.d.cache, this.d.env, this.d.cacheDeadlineMs);
  }

  // ================================================================== currencies
  async listCurrencies(opts: ReadOptions = {}): Promise<CurrencyDto[]> {
    const management = opts.management === true;
    const load = async () =>
      (
        await sql<Row>`SELECT currency_code, numeric_code, minor_unit_digits, display_name, symbol, status FROM geography.currencies
        WHERE (${management} OR status = 'ACTIVE') ORDER BY currency_code`.execute(this.db)
      ).rows.map((r) => mapCurrency(r, management));
    if (management) return this.read(load);
    return (await this.cached('currencies', load, dtoList(CurrencyDtoSchema))).value ?? [];
  }

  async getCurrency(code: string, opts: ReadOptions = {}): Promise<CurrencyDto> {
    const management = opts.management === true;
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code))
      throw new GeographyError('CURRENCY_NOT_FOUND', 'the currency is not registered', { code: String(code).slice(0, 8) });
    const load = async () => {
      const r = await sql<Row>`SELECT currency_code, numeric_code, minor_unit_digits, display_name, symbol, status FROM geography.currencies
        WHERE currency_code = ${code} AND (${management} OR status = 'ACTIVE')`.execute(this.db);
      return r.rows[0] ? mapCurrency(r.rows[0], management) : null;
    };
    const v = management ? await this.read(load) : (await this.cached(`currency:${code}`, load, dtoOne(CurrencyDtoSchema))).value;
    if (!v) throw new GeographyError('CURRENCY_NOT_FOUND', 'the currency is not registered', { code });
    return v;
  }

  // ================================================================== time zones
  async listTimeZones(opts: ReadOptions = {}): Promise<TimeZoneDto[]> {
    const management = opts.management === true;
    const load = async () =>
      (
        await sql<Row>`SELECT iana_name, status FROM geography.time_zones WHERE (${management} OR status = 'ACTIVE') ORDER BY iana_name`.execute(this.db)
      ).rows.map((r) => mapTimeZone(r, management));
    if (management) return this.read(load);
    return (await this.cached('timezones', load, dtoList(TimeZoneDtoSchema))).value ?? [];
  }

  // ================================================================== countries
  /**
   * Reads one country with its link sets. With `lock` the row is first locked by a BARE single-table statement and then read by a second statement
   * (a new snapshot, so after any lock wait every column and every ARRAY(subselect) shows the committed state; see the header).
   */
  private async loadCountry(ex: Executor, code: string, opts: { management: boolean; lock?: 'update' | 'share' }): Promise<Row | undefined> {
    if (opts.lock) {
      const lock = opts.lock === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`;
      const locked =
        await sql<Row>`SELECT 1 AS ok FROM geography.countries WHERE iso_alpha2 = ${code} AND (${opts.management} OR status = 'ACTIVE') ${lock}`.execute(ex);
      if (!locked.rows[0]) return undefined;
    }
    const r = await sql<Row>`${countrySelect(opts.management)} WHERE c.iso_alpha2 = ${code} AND (${opts.management} OR c.status = 'ACTIVE')`.execute(ex);
    return r.rows[0];
  }

  /**
   * The lock order for changing a country: the markets of the country first (market_id order, FOR SHARE: any concurrent market change waits),
   * then the country row FOR UPDATE, then the fresh read. The country id is immutable, so the unlocked lookup of it is safe.
   */
  private async loadCountryForChange(trx: Trx, code: string): Promise<Row | undefined> {
    const id = (await sql<Row>`SELECT country_id FROM geography.countries WHERE iso_alpha2 = ${code}`.execute(trx)).rows[0]?.country_id as string | undefined;
    if (!id) return undefined;
    await sql`SELECT 1 FROM geography.markets WHERE country_id = ${id} ORDER BY market_id FOR SHARE`.execute(trx);
    return this.loadCountry(trx, code, { management: true, lock: 'update' });
  }

  async getCountry(code: string, opts: ReadOptions = {}): Promise<CountryDto> {
    const management = opts.management === true;
    if (!isCountryCode(code)) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: String(code).slice(0, 8) });
    const load = async () => {
      const row = await this.loadCountry(this.db, code, { management });
      return row ? mapCountry(row, management) : null;
    };
    const v = management ? await this.read(load) : (await this.cached(`country:${code}`, load, dtoOne(CountryDtoSchema))).value;
    if (!v) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code });
    return v;
  }

  /** Public view: ACTIVE countries only, public fields only (cached). */
  async getActiveCountries(): Promise<CountryDto[]> {
    const load = async () =>
      (await sql<Row>`${countrySelect(false)} WHERE c.status = 'ACTIVE' ORDER BY c.iso_alpha2`.execute(this.db)).rows.map((r) => mapCountry(r, false));
    return (await this.cached('countries', load, dtoList(CountryDtoSchema))).value ?? [];
  }

  async listCountries(opts: ReadOptions = {}): Promise<CountryDto[]> {
    if (opts.management !== true) return this.getActiveCountries();
    return this.read(async () => (await sql<Row>`${countrySelect(true)} ORDER BY c.iso_alpha2`.execute(this.db)).rows.map((r) => mapCountry(r, true)));
  }

  // ================================================================== markets
  /** Reads one market. With `lock` the row is locked FOR UPDATE by a bare statement first, then read (the joined columns must be fresh; see the header). */
  private async loadMarket(ex: Executor, code: string, opts: { management: boolean; lock?: boolean }): Promise<Row | undefined> {
    if (opts.lock) {
      const locked =
        await sql<Row>`SELECT 1 AS ok FROM geography.markets WHERE code = ${code} AND (${opts.management} OR status = 'ACTIVE') FOR UPDATE`.execute(ex);
      if (!locked.rows[0]) return undefined;
    }
    const r = await sql<Row>`${marketSelect(opts.management)} WHERE m.code = ${code} AND (${opts.management} OR m.status = 'ACTIVE')`.execute(ex);
    return r.rows[0];
  }

  async getMarket(code: string, opts: ReadOptions & { at?: Date } = {}): Promise<MarketDto> {
    const management = opts.management === true;
    if (!isMarketCode(code)) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(code).slice(0, 64) });
    const load = async () => {
      const row = await this.loadMarket(this.db, code, { management });
      return row ? mapMarket(row, management) : null;
    };
    const v = management ? await this.read(load) : (await this.cached(`market:${code}`, load, dtoOne(MarketDtoSchema))).value;
    // public callers see a market only while it is in effect (the window is evaluated here, never cached)
    if (!v || (!management && !inEffect(v, opts.at ?? this.nowDate()))) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code });
    return v;
  }

  /** Public view: ACTIVE markets that are in effect at `at` (default now), optionally of one country. */
  async getActiveMarkets(opts: ActiveMarketsOptions = {}): Promise<MarketDto[]> {
    if (opts.countryCode !== undefined && !isCountryCode(opts.countryCode)) return [];
    const load = async () =>
      (await sql<Row>`${marketSelect(false)} WHERE m.status = 'ACTIVE' ORDER BY m.code`.execute(this.db)).rows.map((r) => mapMarket(r, false));
    const all = (await this.cached('markets', load, dtoList(MarketDtoSchema))).value ?? [];
    const at = opts.at ?? this.nowDate();
    return all.filter((m) => (opts.countryCode === undefined || m.countryCode === opts.countryCode) && inEffect(m, at));
  }

  async listMarkets(opts: MarketListOptions = {}): Promise<MarketDto[]> {
    if (opts.management !== true) return this.getActiveMarkets({ countryCode: opts.countryCode });
    if (opts.countryCode !== undefined && !isCountryCode(opts.countryCode)) return [];
    return this.read(async () =>
      (
        await sql<Row>`${marketSelect(true)} WHERE (${opts.countryCode ?? null}::text IS NULL OR c.iso_alpha2 = ${opts.countryCode ?? null}) ORDER BY m.code`.execute(
          this.db,
        )
      ).rows.map((r) => mapMarket(r, true)),
    );
  }

  /**
   * Everything a consumer needs to render or price for a market, from data only (no code fallback: a missing market, country, currency or
   * time zone is a typed error). The public view requires an ACTIVE market in effect at `at`; `includeInactive` is the management view.
   */
  async resolveMarketDefaults(code: string, opts: MarketDefaultsOptions = {}): Promise<MarketDefaultsDto> {
    if (!isMarketCode(code)) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(code).slice(0, 64) });
    const includeInactive = opts.includeInactive === true;
    const load = async () => {
      const r = await sql<Row>`${defaultsSelect(includeInactive)} WHERE m.code = ${code} AND (${includeInactive} OR m.status = 'ACTIVE')`.execute(this.db);
      return r.rows[0] ? buildMarketDefaults(r.rows[0], !includeInactive) : null;
    };
    const v = includeInactive ? await this.read(load) : (await this.cached(`defaults:${code}`, load, dtoOne(MarketDefaultsDtoSchema))).value;
    if (!v || (!includeInactive && !inEffect(v, opts.at ?? this.nowDate())))
      throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code });
    return v;
  }

  /** Management only: the extensible readiness checks evaluated against the market's current dependencies. Never cached. */
  async getMarketReadiness(code: string): Promise<MarketReadinessDto> {
    if (!isMarketCode(code)) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(code).slice(0, 64) });
    return this.read(async () => {
      const market = await this.loadMarket(this.db, code, { management: true });
      if (!market) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code });
      const report = await this.readiness.evaluate(await this.readinessContext(this.db, market, false));
      return toReadinessDto(code, report);
    });
  }

  /** Loads the dependencies of a market row (optionally under share locks, in the fixed order country, currency, time zone, locale). */
  private async readinessContext(ex: Executor, m: Row, lock: boolean): Promise<ReadinessContext> {
    const share = lock ? sql`FOR SHARE` : sql``;
    const country = (await sql<Row>`SELECT iso_alpha2, status FROM geography.countries WHERE country_id = ${m.country_id as string} ${share}`.execute(ex))
      .rows[0];
    const currency = (
      await sql<Row>`SELECT currency_code, status FROM geography.currencies WHERE currency_code = ${m.currency_code as string} ${share}`.execute(ex)
    ).rows[0];
    const zone = (
      await sql<Row>`SELECT iana_name, status FROM geography.time_zones WHERE time_zone_id = ${m.default_time_zone_id as string} ${share}`.execute(ex)
    ).rows[0];
    const locale = (await sql<Row>`SELECT locale, is_active FROM content.locales WHERE locale = ${m.default_locale as string} ${share}`.execute(ex)).rows[0];
    return {
      market: {
        code: m.code as string,
        status: m.status as GeoStatus,
        countryCode: m.country_code as string,
        defaultLocale: m.default_locale as string,
        currencyCode: m.currency_code as string,
        defaultTimeZone: m.default_time_zone as string,
      },
      country: { code: m.country_code as string, status: (country?.status as GeoStatus | undefined) ?? 'INACTIVE' },
      currency: { code: m.currency_code as string, status: (currency?.status as GeoStatus | undefined) ?? 'INACTIVE' },
      locale: { tag: m.default_locale as string, isActive: locale?.is_active === true },
      timeZone: { ianaName: m.default_time_zone as string, status: (zone?.status as GeoStatus | undefined) ?? 'INACTIVE' },
      at: this.nowDate(),
    };
  }

  // ================================================================== management: shared helpers
  private audit(
    trx: Trx,
    cid: string,
    a: { actor: string; action: string; countryId?: string; marketId?: string; changes?: Record<string, unknown>; reason: string },
  ) {
    return sql`INSERT INTO geography.audit_events (actor, action, country_id, market_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.countryId ?? null}, ${a.marketId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason}, ${cid})`.execute(
      trx,
    );
  }
  private countryEvent(trx: Trx, cid: string, type: string, countryId: string, countryCode: string, actor: string) {
    const payload: CountryEventPayload = { countryCode };
    return insertOutboxEvent(trx, {
      aggregateType: 'geography_country',
      aggregateId: countryId,
      eventType: type,
      actorType: 'user',
      actorId: actor,
      correlationId: cid,
      payload,
    });
  }
  private marketEvent(trx: Trx, cid: string, type: string, marketId: string, payload: MarketEventPayload, actor: string) {
    return insertOutboxEvent(trx, {
      aggregateType: 'geography_market',
      aggregateId: marketId,
      eventType: type,
      actorType: 'user',
      actorId: actor,
      correlationId: cid,
      payload,
    });
  }

  private async requireCurrency(trx: Trx, code: string, field: string): Promise<GeoStatus> {
    const r = await sql<Row>`SELECT status FROM geography.currencies WHERE currency_code = ${code} FOR SHARE`.execute(trx);
    if (!r.rows[0]) throw new GeographyError('CURRENCY_NOT_FOUND', 'the currency is not registered', { code, field });
    return r.rows[0].status as GeoStatus;
  }
  private async requireLocalesRegistered(trx: Trx, locales: string[]): Promise<Map<string, boolean>> {
    const r = await sql<Row>`SELECT locale, is_active FROM content.locales WHERE locale = ANY(${locales}::text[])`.execute(trx);
    const found = new Map(r.rows.map((x) => [x.locale as string, x.is_active === true]));
    const missing = locales.filter((l) => !found.has(l));
    if (missing.length) throw new GeographyError('LOCALE_NOT_FOUND', 'a locale is not registered in the content registry', { locales: missing });
    return found;
  }
  private async requireContentKey(trx: Trx, key: string): Promise<void> {
    const r = await sql<Row>`SELECT 1 AS ok FROM content.entries WHERE key = ${key}`.execute(trx);
    if (!r.rows[0]) throw invalid('displayNameContentKey does not name a content entry', { reason: 'CONTENT_KEY_NOT_FOUND', field: 'displayNameContentKey' });
  }
  /**
   * Registers the time zones the registry does not know yet as PLANNED (the database verifies each NEW name against its tz database). Only the
   * missing names are inserted: the guard trigger fires for every proposed row, even one that ON CONFLICT then discards. Sorted: no deadlocks.
   * ON CONFLICT DO NOTHING stays for a concurrent registration of the same name.
   */
  private async registerTimeZones(trx: Trx, zones: string[]): Promise<void> {
    const known = await sql<Row>`SELECT iana_name FROM geography.time_zones WHERE iana_name = ANY(${zones}::text[])`.execute(trx);
    const have = new Set(known.rows.map((r) => r.iana_name as string));
    const missing = zones.filter((z) => !have.has(z)).sort();
    if (!missing.length) return;
    await sql`INSERT INTO geography.time_zones (iana_name) SELECT z FROM unnest(${missing}::text[]) AS z ORDER BY z ON CONFLICT (iana_name) DO NOTHING`.execute(
      trx,
    );
  }
  /** Refuses to remove a time zone or locale link that a market of the country still uses (plain reads, before any delete). */
  private async assertLinksNotInUse(trx: Trx, countryId: string, locales: string[], zones: string[]): Promise<void> {
    const usedZones = zones.length
      ? (
          await sql<Row>`SELECT DISTINCT t.iana_name FROM geography.markets m JOIN geography.time_zones t ON t.time_zone_id = m.default_time_zone_id
            WHERE m.country_id = ${countryId} AND t.iana_name = ANY(${zones}::text[]) ORDER BY t.iana_name`.execute(trx)
        ).rows.map((r) => r.iana_name as string)
      : [];
    const usedLocales = locales.length
      ? (
          await sql<Row>`SELECT DISTINCT ml.locale FROM geography.market_locales ml
            WHERE ml.country_id = ${countryId} AND ml.locale = ANY(${locales}::text[]) ORDER BY ml.locale`.execute(trx)
        ).rows.map((r) => r.locale as string)
      : [];
    if (usedZones.length || usedLocales.length)
      throw new GeographyError('INVALID_STATE', 'a time zone or locale that a market of this country still uses cannot be removed', {
        reason: 'IN_USE',
        timeZones: usedZones,
        locales: usedLocales,
      });
  }
  private async zoneStatuses(trx: Trx, zones: string[]): Promise<Map<string, GeoStatus>> {
    const r = await sql<Row>`SELECT iana_name, status FROM geography.time_zones WHERE iana_name = ANY(${zones}::text[]) FOR SHARE`.execute(trx);
    return new Map(r.rows.map((x) => [x.iana_name as string, x.status as GeoStatus]));
  }
  private gateTestKeys(kind: 'country' | 'market', isTest: boolean): void {
    if (isTest && !this.d.allowTestKeys)
      throw invalid(
        kind === 'country'
          ? 'the test country ZZ is DEV/TEST only and not allowed in this environment'
          : 'devtest-* market codes are DEV/TEST only and not allowed in this environment',
        {
          reason: 'TEST_KEY',
        },
      );
  }
  private currentZones(r: Row): string[] {
    return sorted(r.time_zones);
  }

  // ================================================================== management: countries
  /** Creates the country as PLANNED with its locale and time-zone links (unknown valid time zones are registered as PLANNED). Activation is separate. */
  async createCountry(input: unknown, actor: string): Promise<CountryDto> {
    const req = parseRequest(CreateCountryRequest, input, ['defaultLocale'], ['supportedLocales', 'timeZones']);
    this.gateTestKeys('country', req.code === 'ZZ');
    if (req.code !== 'ZZ') requireAssignedCountryCode(req.code, 'code'); // ZZ is the DEV/TEST code: allowed only through the gate above
    const cid = getCorrelationId() ?? randomUUID();
    const locales = [...new Set(req.supportedLocales)].sort();
    const zones = [...new Set(req.timeZones.map((z) => requireIanaTimeZone(z, 'timeZones')))].sort();
    if (!locales.includes(req.defaultLocale))
      throw invalid('defaultLocale must be one of supportedLocales', { reason: 'INVALID_FIELD', field: 'defaultLocale' });
    await this.tx(async (trx) => {
      await this.requireCurrency(trx, req.defaultCurrencyCode, 'defaultCurrencyCode');
      await this.requireLocalesRegistered(trx, locales);
      await this.requireContentKey(trx, req.displayNameContentKey);
      await this.registerTimeZones(trx, zones);
      const ins =
        await sql<Row>`INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code,
          default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
        VALUES (${req.code}, ${req.alpha3}, ${req.numeric}, ${req.displayNameContentKey}, 'PLANNED', ${req.dialingCode}, ${req.defaultCurrencyCode}, ${req.defaultLocale},
          ${req.distanceUnit}, ${req.firstDayOfWeek}, ${req.dateFormat}, ${req.timeFormat}) RETURNING country_id`.execute(trx);
      const countryId = ins.rows[0]!.country_id as string;
      for (const l of locales) await sql`INSERT INTO geography.country_locales (country_id, locale) VALUES (${countryId}, ${l})`.execute(trx);
      await sql`INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT ${countryId}, time_zone_id FROM geography.time_zones WHERE iana_name = ANY(${zones}::text[])`.execute(
        trx,
      );
      const changes: Record<string, unknown> = {
        displayNameContentKey: [null, req.displayNameContentKey],
        dialingCode: [null, req.dialingCode],
        defaultCurrencyCode: [null, req.defaultCurrencyCode],
        defaultLocale: [null, req.defaultLocale],
        supportedLocales: [null, locales],
        timeZones: [null, zones],
        distanceUnit: [null, req.distanceUnit],
        firstDayOfWeek: [null, req.firstDayOfWeek],
        dateFormat: [null, req.dateFormat],
        timeFormat: [null, req.timeFormat],
        status: [null, 'PLANNED'],
      };
      await this.audit(trx, cid, { actor, action: 'COUNTRY_CREATED', countryId, changes, reason: requireReason(req.reason) });
    });
    await this.invalidate();
    return this.getCountry(req.code, { management: true });
  }

  /** Changes the provided fields. supportedLocales and timeZones REPLACE the existing sets. A request that changes nothing writes nothing. */
  async updateCountry(code: string, input: unknown, actor: string): Promise<CountryDto> {
    if (!isCountryCode(code)) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: String(code).slice(0, 8) });
    const req = parseRequest(UpdateCountryRequest, input, ['defaultLocale'], ['supportedLocales', 'timeZones']);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const row = await this.loadCountryForChange(trx, code);
      if (!row) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code });
      const before = mapCountry(row, true);
      const next = {
        displayNameContentKey: req.displayNameContentKey ?? before.displayNameContentKey,
        dialingCode: req.dialingCode ?? before.dialingCode,
        defaultCurrencyCode: req.defaultCurrencyCode ?? before.defaultCurrencyCode,
        defaultLocale: req.defaultLocale ?? before.defaultLocale,
        supportedLocales: req.supportedLocales ? [...new Set(req.supportedLocales)].sort() : before.supportedLocales,
        timeZones: req.timeZones ? [...new Set(req.timeZones.map((z) => requireIanaTimeZone(z, 'timeZones')))].sort() : before.timeZones,
        distanceUnit: req.distanceUnit ?? before.distanceUnit,
        firstDayOfWeek: req.firstDayOfWeek ?? before.firstDayOfWeek,
        dateFormat: req.dateFormat ?? before.dateFormat,
        timeFormat: req.timeFormat ?? before.timeFormat,
      };
      const changes = diffFields(before, next, COUNTRY_FIELDS);
      if (!Object.keys(changes).length) return false;
      if (!next.supportedLocales.includes(next.defaultLocale))
        throw invalid('defaultLocale must be one of supportedLocales', { reason: 'INVALID_FIELD', field: 'defaultLocale' });
      const active = before.status === 'ACTIVE';
      if (changes.displayNameContentKey) await this.requireContentKey(trx, next.displayNameContentKey);
      if (changes.defaultCurrencyCode) {
        const status = await this.requireCurrency(trx, next.defaultCurrencyCode, 'defaultCurrencyCode');
        if (active && status !== 'ACTIVE')
          throw new GeographyError('INVALID_STATE', 'the default currency of an ACTIVE country must be ACTIVE', { reason: 'CURRENCY_NOT_ACTIVE' });
      }
      const localeState = await this.requireLocalesRegistered(trx, next.supportedLocales);
      if (active && changes.defaultLocale && localeState.get(next.defaultLocale) !== true)
        throw new GeographyError('INVALID_STATE', 'the default locale of an ACTIVE country must be an ACTIVE locale', { reason: 'LOCALE_NOT_ACTIVE' });
      const removedLocales = before.supportedLocales.filter((l) => !next.supportedLocales.includes(l));
      const removedZones = before.timeZones.filter((z) => !next.timeZones.includes(z));
      if (active && (removedLocales.length || removedZones.length))
        throw new GeographyError('INVALID_STATE', 'the locales and time zones of an ACTIVE country cannot be removed; deactivate the country first', {
          reason: 'LINKS_FROZEN',
        });
      // typed IN_USE before anything is written (the foreign keys would only answer after locking market rows in the opposite order)
      if (removedLocales.length || removedZones.length) await this.assertLinksNotInUse(trx, row.country_id as string, removedLocales, removedZones);
      if (changes.timeZones) {
        await this.registerTimeZones(trx, next.timeZones);
        if (active) {
          const statuses = await this.zoneStatuses(trx, next.timeZones);
          if (![...statuses.values()].includes('ACTIVE'))
            throw new GeographyError('INVALID_STATE', 'an ACTIVE country needs at least one ACTIVE time zone', { reason: 'NO_ACTIVE_TIME_ZONE' });
        }
      }
      const countryId = row.country_id as string;
      // new links first, then the country row (the default-locale foreign key is deferred), then the removed links
      for (const l of next.supportedLocales.filter((x) => !before.supportedLocales.includes(x)))
        await sql`INSERT INTO geography.country_locales (country_id, locale) VALUES (${countryId}, ${l}) ON CONFLICT DO NOTHING`.execute(trx);
      await sql`INSERT INTO geography.country_time_zones (country_id, time_zone_id)
        SELECT ${countryId}, time_zone_id FROM geography.time_zones WHERE iana_name = ANY(${next.timeZones}::text[]) ON CONFLICT DO NOTHING`.execute(trx);
      await sql`UPDATE geography.countries SET display_name_content_key = ${next.displayNameContentKey}, dialing_code = ${next.dialingCode},
          default_currency_code = ${next.defaultCurrencyCode}, default_locale = ${next.defaultLocale}, distance_unit = ${next.distanceUnit},
          first_day_of_week = ${next.firstDayOfWeek}, date_format_code = ${next.dateFormat}, time_format_code = ${next.timeFormat}, updated_at = now()
        WHERE country_id = ${countryId}`.execute(trx);
      if (removedLocales.length)
        await sql`DELETE FROM geography.country_locales WHERE country_id = ${countryId} AND locale = ANY(${removedLocales}::text[])`.execute(trx);
      if (removedZones.length)
        await sql`DELETE FROM geography.country_time_zones WHERE country_id = ${countryId}
          AND time_zone_id IN (SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ANY(${removedZones}::text[]))`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'COUNTRY_UPDATED', countryId, changes, reason: requireReason(req.reason) });
      const formatChanged = COUNTRY_FORMAT_FIELDS.filter((f) => changes[f]);
      if (formatChanged.length) {
        const markets = await sql<Row>`SELECT market_id, code FROM geography.markets WHERE country_id = ${countryId} ORDER BY code`.execute(trx);
        for (const m of markets.rows)
          await this.marketEvent(
            trx,
            cid,
            GEOGRAPHY_EVENTS.marketDefaultsChanged,
            m.market_id as string,
            { marketCode: m.code as string, countryCode: code, changedFields: [...formatChanged], cause: 'COUNTRY' },
            actor,
          );
      }
      return true;
    });
    if (changed) await this.invalidate();
    return this.getCountry(code, { management: true });
  }

  /**
   * Activates (from PLANNED or INACTIVE) or deactivates (from PLANNED or ACTIVE, to INACTIVE) a country; PLANNED is the initial status only and is never
   * written back. IDEMPOTENT: when the country is already in the requested state nothing is written (no audit row, no event). Retiring a PLANNED country
   * (PLANNED to INACTIVE) is audited but emits NO country-deactivated event: the country was never ACTIVE, so no consumer ever saw it. The service
   * checks the dependencies first for clear typed errors; the database triggers are the safety net.
   */
  async setCountryActive(code: string, active: boolean, reasonInput: string, actor: string): Promise<CountryDto> {
    if (!isCountryCode(code)) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: String(code).slice(0, 8) });
    const reason = requireReason(reasonInput);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const row = await this.loadCountryForChange(trx, code);
      if (!row) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code });
      const status = row.status as GeoStatus;
      const countryId = row.country_id as string;
      if (active) {
        if (status === 'ACTIVE') return false;
        const cur = await sql<Row>`SELECT status FROM geography.currencies WHERE currency_code = ${row.default_currency_code as string} FOR SHARE`.execute(trx);
        if (cur.rows[0]?.status !== 'ACTIVE')
          throw new GeographyError('INVALID_STATE', 'the default currency of the country is not ACTIVE', { country: code, reason: 'CURRENCY_NOT_ACTIVE' });
        const loc = await sql<Row>`SELECT is_active FROM content.locales WHERE locale = ${row.default_locale as string} FOR SHARE`.execute(trx);
        if (loc.rows[0]?.is_active !== true)
          throw new GeographyError('INVALID_STATE', 'the default locale of the country is not an ACTIVE locale', {
            country: code,
            reason: 'LOCALE_NOT_ACTIVE',
          });
        const zones = await sql<Row>`SELECT t.status FROM geography.country_time_zones cz JOIN geography.time_zones t ON t.time_zone_id = cz.time_zone_id
          WHERE cz.country_id = ${countryId} FOR SHARE OF t`.execute(trx);
        if (!zones.rows.some((z) => z.status === 'ACTIVE'))
          throw new GeographyError('INVALID_STATE', 'the country has no ACTIVE time zone', { country: code, reason: 'NO_ACTIVE_TIME_ZONE' });
        await sql`UPDATE geography.countries SET status = 'ACTIVE', updated_at = now() WHERE country_id = ${countryId}`.execute(trx);
        await this.audit(trx, cid, { actor, action: 'COUNTRY_ACTIVATED', countryId, changes: { status: [status, 'ACTIVE'] }, reason });
        await this.countryEvent(trx, cid, GEOGRAPHY_EVENTS.countryActivated, countryId, code, actor);
        return true;
      }
      if (status === 'INACTIVE') return false; // already retired
      const markets = await sql<Row>`SELECT code FROM geography.markets WHERE country_id = ${countryId} AND status = 'ACTIVE' ORDER BY code LIMIT 10`.execute(
        trx,
      );
      if (markets.rows.length)
        throw new GeographyError('INVALID_STATE', 'the country has ACTIVE markets; deactivate them first', {
          country: code,
          reason: 'COUNTRY_HAS_ACTIVE_MARKETS',
          markets: markets.rows.map((m) => m.code),
        });
      await sql`UPDATE geography.countries SET status = 'INACTIVE', updated_at = now() WHERE country_id = ${countryId}`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'COUNTRY_DEACTIVATED', countryId, changes: { status: [status, 'INACTIVE'] }, reason });
      if (status === 'ACTIVE') await this.countryEvent(trx, cid, GEOGRAPHY_EVENTS.countryDeactivated, countryId, code, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getCountry(code, { management: true });
  }

  // ================================================================== management: markets
  /** Validates the market's links against its country: locales and time zone must be supported by the country. */
  private checkAgainstCountry(country: CountryDto, v: { defaultLocale: string; supportedLocales: string[]; defaultTimeZone: string }): void {
    if (!v.supportedLocales.includes(v.defaultLocale))
      throw invalid('defaultLocale must be one of supportedLocales', { reason: 'INVALID_FIELD', field: 'defaultLocale' });
    const unsupported = v.supportedLocales.filter((l) => !country.supportedLocales.includes(l));
    if (unsupported.length)
      throw invalid('every market locale must be supported by the country', {
        reason: 'LOCALE_NOT_IN_COUNTRY',
        field: 'supportedLocales',
        locales: unsupported,
      });
    if (!country.timeZones.includes(v.defaultTimeZone))
      throw invalid('defaultTimeZone must be one of the time zones of the country', { reason: 'TIME_ZONE_NOT_IN_COUNTRY', field: 'defaultTimeZone' });
  }

  /** Creates the market as PLANNED. */
  async createMarket(input: unknown, actor: string): Promise<MarketDto> {
    const req = parseRequest(CreateMarketRequest, input, ['defaultLocale'], ['supportedLocales']);
    this.gateTestKeys('market', req.code.startsWith('devtest-'));
    const cid = getCorrelationId() ?? randomUUID();
    const locales = req.supportedLocales ? [...new Set(req.supportedLocales)].sort() : [req.defaultLocale];
    requireIanaTimeZone(req.defaultTimeZone, 'defaultTimeZone');
    // the service clock (not the database clock) is the default start: the window is evaluated with the same clock
    const effectiveFrom = req.effectiveFrom ? requireInstant(req.effectiveFrom, 'effectiveFrom') : this.nowDate();
    const effectiveTo = req.effectiveTo ? requireInstant(req.effectiveTo, 'effectiveTo') : null;
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime())
      throw invalid('effectiveTo must be after effectiveFrom', { reason: 'INVALID_FIELD', field: 'effectiveTo' });
    await this.tx(async (trx) => {
      const countryRow = await this.loadCountry(trx, req.countryCode, { management: true, lock: 'share' });
      if (!countryRow) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: req.countryCode });
      const country = mapCountry(countryRow, true);
      this.checkAgainstCountry(country, { defaultLocale: req.defaultLocale, supportedLocales: locales, defaultTimeZone: req.defaultTimeZone });
      await this.requireCurrency(trx, req.currencyCode, 'currencyCode');
      const ins =
        await sql<Row>`INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from, effective_to)
        VALUES (${req.code}, ${req.name}, ${countryRow.country_id as string}, 'PLANNED', ${req.defaultLocale}, ${req.currencyCode},
          (SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ${req.defaultTimeZone}), ${effectiveFrom}::timestamptz, ${effectiveTo}::timestamptz)
        RETURNING market_id, effective_from`.execute(trx);
      const marketId = ins.rows[0]!.market_id as string;
      for (const l of locales)
        await sql`INSERT INTO geography.market_locales (market_id, country_id, locale) VALUES (${marketId}, ${countryRow.country_id as string}, ${l})`.execute(
          trx,
        );
      const changes = {
        name: [null, req.name],
        defaultLocale: [null, req.defaultLocale],
        supportedLocales: [null, locales],
        currencyCode: [null, req.currencyCode],
        defaultTimeZone: [null, req.defaultTimeZone],
        effectiveFrom: [null, iso(ins.rows[0]!.effective_from)],
        effectiveTo: [null, effectiveTo ? effectiveTo.toISOString() : null],
        status: [null, 'PLANNED'],
      };
      await this.audit(trx, cid, { actor, action: 'MARKET_CREATED', marketId, changes, reason: requireReason(req.reason) });
      await this.marketEvent(trx, cid, GEOGRAPHY_EVENTS.marketCreated, marketId, { marketCode: req.code, countryCode: req.countryCode }, actor);
    });
    await this.invalidate();
    return this.getMarket(req.code, { management: true });
  }

  /**
   * Changes the provided fields (the market country and code are identity). supportedLocales REPLACES the set. A request that changes nothing
   * writes nothing. Changing the default locale, currency or time zone emits market-defaults-changed (field names only).
   */
  async updateMarket(code: string, input: unknown, actor: string): Promise<MarketDto> {
    if (!isMarketCode(code)) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(code).slice(0, 64) });
    const req = parseRequest(UpdateMarketRequest, input, ['defaultLocale'], ['supportedLocales']);
    if (req.defaultTimeZone !== undefined) requireIanaTimeZone(req.defaultTimeZone, 'defaultTimeZone');
    // instants are validated (years 1970 to 9999) and handed to the database as Date objects, never re-serialized ISO strings
    const fromDate = req.effectiveFrom ? requireInstant(req.effectiveFrom, 'effectiveFrom') : undefined;
    const toGiven = req.effectiveTo !== undefined;
    const toDate = req.effectiveTo ? requireInstant(req.effectiveTo, 'effectiveTo') : null;
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const row = await this.loadMarket(trx, code, { management: true, lock: true });
      if (!row) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code });
      const before = mapMarket(row, true);
      const next = {
        name: req.name ?? before.name,
        defaultLocale: req.defaultLocale ?? before.defaultLocale,
        supportedLocales: req.supportedLocales ? [...new Set(req.supportedLocales)].sort() : before.supportedLocales,
        currencyCode: req.currencyCode ?? before.currencyCode,
        defaultTimeZone: req.defaultTimeZone ?? before.defaultTimeZone,
        effectiveFrom: fromDate ? fromDate.toISOString() : before.effectiveFrom,
        effectiveTo: toGiven ? (toDate ? toDate.toISOString() : null) : before.effectiveTo,
      };
      const changes = diffFields(before, next, MARKET_FIELDS);
      if (!Object.keys(changes).length) return false;
      if (next.effectiveTo !== null && new Date(next.effectiveTo).getTime() <= new Date(next.effectiveFrom).getTime())
        throw invalid('effectiveTo must be after effectiveFrom', { reason: 'INVALID_FIELD', field: 'effectiveTo' });
      const countryRow = await this.loadCountry(trx, before.countryCode, { management: true, lock: 'share' });
      if (!countryRow) throw new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: before.countryCode });
      this.checkAgainstCountry(mapCountry(countryRow, true), next);
      const marketId = row.market_id as string;
      if (changes.currencyCode) await this.requireCurrency(trx, next.currencyCode, 'currencyCode');
      if (before.status === 'ACTIVE' && (changes.currencyCode || changes.defaultLocale || changes.defaultTimeZone)) {
        // an ACTIVE market must keep ACTIVE dependencies: check the NEW values before the trigger would refuse them
        const zone = await sql<Row>`SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ${next.defaultTimeZone}`.execute(trx);
        const probe = {
          ...row,
          currency_code: next.currencyCode,
          default_locale: next.defaultLocale,
          default_time_zone: next.defaultTimeZone,
          default_time_zone_id: zone.rows[0]?.time_zone_id,
        };
        assertReadyForActivation(code, await this.readiness.evaluate(await this.readinessContext(trx, probe, true)));
      }
      for (const l of next.supportedLocales.filter((x) => !before.supportedLocales.includes(x)))
        await sql`INSERT INTO geography.market_locales (market_id, country_id, locale) VALUES (${marketId}, ${row.country_id as string}, ${l})
          ON CONFLICT DO NOTHING`.execute(trx);
      // a window end that was not supplied keeps the stored value untouched (no round trip through a string)
      await sql`UPDATE geography.markets SET name = ${next.name}, default_locale = ${next.defaultLocale}, currency_code = ${next.currencyCode},
          default_time_zone_id = (SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ${next.defaultTimeZone}),
          effective_from = COALESCE(${fromDate ?? null}::timestamptz, effective_from),
          effective_to = CASE WHEN ${toGiven}::boolean THEN ${toDate}::timestamptz ELSE effective_to END, updated_at = now()
        WHERE market_id = ${marketId}`.execute(trx);
      const removed = before.supportedLocales.filter((l) => !next.supportedLocales.includes(l));
      if (removed.length) await sql`DELETE FROM geography.market_locales WHERE market_id = ${marketId} AND locale = ANY(${removed}::text[])`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'MARKET_UPDATED', marketId, changes, reason: requireReason(req.reason) });
      const defaultsChanged = MARKET_DEFAULT_FIELDS.filter((f) => changes[f]);
      if (defaultsChanged.length)
        await this.marketEvent(
          trx,
          cid,
          GEOGRAPHY_EVENTS.marketDefaultsChanged,
          marketId,
          { marketCode: code, countryCode: before.countryCode, changedFields: [...defaultsChanged], cause: 'MARKET' },
          actor,
        );
      return true;
    });
    if (changed) await this.invalidate();
    return this.getMarket(code, { management: true });
  }

  /**
   * Activates (from PLANNED or INACTIVE) or deactivates (from PLANNED or ACTIVE, to INACTIVE) a market; PLANNED is the initial status only and is never
   * written back. IDEMPOTENT: when the market is already in the requested state nothing is written (no audit row, no event), including when two callers
   * race. Retiring a PLANNED market (PLANNED to INACTIVE) is audited but emits NO market-deactivated event: it was never ACTIVE. Activation locks the
   * market and share-locks its dependencies, then runs every registered readiness check:
   *  - a built-in dependency failing (country, currency, locale or time zone not ACTIVE) -> INVALID_STATE, details.reason COUNTRY_NOT_ACTIVE ...
   *  - another required check failing -> NOT_READY with details.checks
   */
  async setMarketActive(code: string, active: boolean, reasonInput: string, actor: string): Promise<MarketDto> {
    if (!isMarketCode(code)) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code: String(code).slice(0, 64) });
    const reason = requireReason(reasonInput);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const row = await this.loadMarket(trx, code, { management: true, lock: true });
      if (!row) throw new GeographyError('MARKET_NOT_FOUND', 'the market is not registered', { code });
      const status = row.status as GeoStatus;
      const marketId = row.market_id as string;
      const payload: MarketEventPayload = { marketCode: code, countryCode: row.country_code as string };
      if (active) {
        if (status === 'ACTIVE') return false;
        assertReadyForActivation(code, await this.readiness.evaluate(await this.readinessContext(trx, row, true)));
        await sql`UPDATE geography.markets SET status = 'ACTIVE', updated_at = now() WHERE market_id = ${marketId}`.execute(trx);
        await this.audit(trx, cid, { actor, action: 'MARKET_ACTIVATED', marketId, changes: { status: [status, 'ACTIVE'] }, reason });
        await this.marketEvent(trx, cid, GEOGRAPHY_EVENTS.marketActivated, marketId, payload, actor);
        return true;
      }
      if (status === 'INACTIVE') return false; // already retired
      await sql`UPDATE geography.markets SET status = 'INACTIVE', updated_at = now() WHERE market_id = ${marketId}`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'MARKET_DEACTIVATED', marketId, changes: { status: [status, 'INACTIVE'] }, reason });
      if (status === 'ACTIVE') await this.marketEvent(trx, cid, GEOGRAPHY_EVENTS.marketDeactivated, marketId, payload, actor);
      return true;
    });
    if (changed) await this.invalidate();
    return this.getMarket(code, { management: true });
  }
}
