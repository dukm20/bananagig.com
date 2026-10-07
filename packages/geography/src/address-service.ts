// The address service: country address formats (versioned, effective-dated, published once), administrative areas, the stateless validate and
// format operations used by every form, and persistence of the ONE canonical structured address.
//
// Rules this file keeps (docs/engineering/ADDRESSES.md, ADR-0023, ADR-0024):
//  - No country-specific code path: every behavior comes from the format records. The engine (address-engine.ts) is pure.
//  - Addresses are personal data: nothing here logs a value, an issue carries the property and a code only, errors carry no input, and persisted
//    addresses are returned only by getAddress (an in-process method for the owning domains), never by a public API.
//  - A stored address is immutable and references the exact format version it was validated with, so it is its own booking snapshot.
//  - Providers (autocomplete, geocoder, verification) are optional ports. A provider that fails or times out never fails the flow: manual entry
//    still validates against the country format and the address is stored UNVERIFIED (marked for review), never pretending to be geocoded.
//  - Format publication and area changes lock the country row first (one lock order, like GeographyService), write an audit row and an outbox
//    event in the same transaction and bump the cache generation after commit. Reads of PUBLISHED/ACTIVE data go through the shared cache.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ADDRESS_FIELD_PROPERTIES,
  ADDRESS_FIELD_TYPES,
  AddressFieldType,
  AddressInput,
  AddressInputType,
  AddressNormalizationRule,
  AdministrativeAreaType,
  CreateAddressFormatRequest,
  GEOGRAPHY_EVENTS,
  PublishAddressFormatRequest,
  UpsertAdministrativeAreasRequest,
  type AddressFormatDto,
  type AddressFormatFieldDto,
  type AddressIssueDto,
  type AddressValidationSource,
  type AddressValidationStatus,
  type AddressFormatPublishedPayload,
  type AdministrativeAreaDto,
  type AdministrativeAreaListDto,
  type AdministrativeAreasUpdatedPayload,
  type FormattedAddressDto,
  type GeoStatus,
  type NormalizedAddressDto,
  type UpsertAdministrativeAreasResultDto,
} from '@bananagig/contracts';
import type { ConfigCache } from '@bananagig/configuration';
import { sql, type Database, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import {
  administrativeAreaMode,
  codePointLength,
  formatAddressWithFormat,
  patternProblem,
  templateProblem,
  validateAddressAgainstFormat,
  validateFieldValue,
  type AddressFormatField,
  type AddressFormatModel,
  type AddressValidationOutcome,
  type AdministrativeAreaModel,
} from './address-engine';
import { isValidCoordinate, type AddressProviders, type GeocodeResult, type ProviderAddress } from './address-providers';
import { cachedRead, invalidateGeography, DEFAULT_GEO_CACHE_TTL_SECONDS } from './cache';
import { GeographyError } from './errors';
import type { ReadinessCheck } from './readiness';
import { mapDbError, requireReason } from './service';
import { isCountryCode } from './validation';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- public types
export interface AddressServiceDeps {
  database: Database;
  cache?: ConfigCache;
  env: string;
  cacheTtlSeconds?: number;
  cacheDeadlineMs?: number;
  /** Which provider serves a country (none configured: the manual path is used). */
  providers?: AddressProviders;
  /** Display name of a country in a locale (the content registry behind a port: geography never imports content). */
  countryNames?: (countryCode: string, locale: string) => Promise<string | null>;
  /** Deadline of every provider call (default 3000 ms). */
  providerTimeoutMs?: number;
  now?: () => Date;
}
export interface AddressReadOptions {
  /** Management view: any country status, drafts and inactive areas, never cached. The caller has already authorized it. */
  management?: boolean;
  /** Evaluation instant for the format's effective window (default: now). */
  at?: Date;
}
export interface AddressValidationResult {
  outcome: AddressValidationOutcome;
  format: AddressFormatModel;
}
export interface CreatedAddress {
  addressId: string;
  validationStatus: AddressValidationStatus;
  validationSource: AddressValidationSource;
  formatVersion: number;
  /** True when coordinates were stored. */
  located: boolean;
}
/** A persisted address as owning domains read it (in process). Raw input is returned only on request. */
export interface StoredAddress {
  addressId: string;
  address: NormalizedAddressDto;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  formattedAddress: string;
  validationStatus: AddressValidationStatus;
  validationSource: AddressValidationSource;
  providerCode: string | null;
  providerReference: string | null;
  formatVersion: number;
  createdAt: string;
  rawInput?: Record<string, unknown>;
}
export interface CreateAddressOptions {
  /** What the person submitted before normalization (default: the validated input). Preserved in raw_input. */
  rawInput?: Record<string, unknown>;
}

// ---------------------------------------------------------------- cache blob (public view: ACTIVE country, PUBLISHED formats, ACTIVE areas)
const FieldBlob = z.object({
  fieldType: AddressFieldType,
  displayOrder: z.number().int(),
  contentLabelKey: z.string(),
  required: z.boolean(),
  maxLength: z.number().int(),
  inputType: AddressInputType,
  validationPattern: z.string().nullable(),
  example: z.string().nullable(),
  autocomplete: z.string().nullable(),
  normalization: AddressNormalizationRule.nullable(),
});
const FormatBlob = z.object({
  addressFormatId: z.string(),
  countryCode: z.string(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'PUBLISHED']),
  displayTemplate: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  fields: z.array(FieldBlob),
});
const AreaBlob = z.object({
  administrativeAreaId: z.string(),
  code: z.string(),
  name: z.string(),
  type: AdministrativeAreaType,
  parentCode: z.string().nullable(),
  displayOrder: z.number().int().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
const DataBlob = z.object({
  countryId: z.string(),
  code: z.string(),
  status: z.enum(['PLANNED', 'ACTIVE', 'INACTIVE']),
  defaultLocale: z.string(),
  formats: z.array(FormatBlob),
  areas: z.array(AreaBlob),
});

interface CountryAddressData {
  countryId: string;
  code: string;
  status: GeoStatus;
  defaultLocale: string;
  formats: AddressFormatModel[];
  areas: AdministrativeAreaModel[];
}
const reviveData = (b: z.infer<typeof DataBlob>): CountryAddressData => ({
  ...b,
  formats: b.formats.map((f) => ({ ...f, effectiveFrom: new Date(f.effectiveFrom), effectiveTo: f.effectiveTo === null ? null : new Date(f.effectiveTo) })),
});

// ---------------------------------------------------------------- mappers (exported: the API layer shapes its DTOs with them)
const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const fieldFrom = (r: Row): AddressFormatField => ({
  fieldType: r.field_type as AddressFieldType,
  displayOrder: Number(r.display_order),
  contentLabelKey: r.content_label_key as string,
  required: r.required as boolean,
  maxLength: Number(r.max_length),
  inputType: r.input_type as AddressFormatField['inputType'],
  validationPattern: (r.validation_pattern as string | null) ?? null,
  example: (r.example_value as string | null) ?? null,
  autocomplete: (r.autocomplete_hint as string | null) ?? null,
  normalization: (r.normalization_rule as AddressFormatField['normalization']) ?? null,
});
const areaFrom = (r: Row): AdministrativeAreaModel => ({
  administrativeAreaId: r.administrative_area_id as string,
  code: r.code as string,
  name: r.name as string,
  type: r.area_type as AdministrativeAreaModel['type'],
  parentCode: (r.parent_code as string | null) ?? null,
  displayOrder: r.display_order === null || r.display_order === undefined ? null : Number(r.display_order),
  status: r.status as 'ACTIVE' | 'INACTIVE',
});

export function toAddressFormatFieldDto(f: AddressFormatField): AddressFormatFieldDto {
  return {
    fieldType: f.fieldType,
    property: ADDRESS_FIELD_PROPERTIES[f.fieldType],
    displayOrder: f.displayOrder,
    contentLabelKey: f.contentLabelKey,
    required: f.required,
    maxLength: f.maxLength,
    inputType: f.inputType,
    validationPattern: f.validationPattern,
    example: f.example,
    autocomplete: f.autocomplete,
    normalization: f.normalization,
  };
}
/** The read model for forms. Management callers also get status, template and period. */
export function toAddressFormatDto(format: AddressFormatModel, management: boolean): AddressFormatDto {
  return {
    countryCode: format.countryCode,
    version: format.version,
    fields: format.fields.map(toAddressFormatFieldDto),
    administrativeAreaMode: administrativeAreaMode(format),
    postalCodeExample: format.fields.find((f) => f.fieldType === 'POSTAL_CODE')?.example ?? null,
    ...(management
      ? {
          status: format.status,
          displayTemplate: format.displayTemplate,
          effectiveFrom: format.effectiveFrom.toISOString(),
          effectiveTo: format.effectiveTo ? format.effectiveTo.toISOString() : null,
        }
      : {}),
  };
}
export function toAdministrativeAreaDto(a: AdministrativeAreaModel, management: boolean): AdministrativeAreaDto {
  return {
    code: a.code,
    name: a.name,
    type: a.type,
    parentCode: a.parentCode,
    displayOrder: a.displayOrder,
    ...(management ? { status: a.status } : {}),
  };
}
/** Active areas in picker order: explicit order first, then by name. */
const byPickerOrder = (a: AdministrativeAreaModel, b: AdministrativeAreaModel): number =>
  (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name, 'en');

/** The format whose half-open window contains `at`. */
export function formatInEffect(formats: readonly AddressFormatModel[], at: Date): AddressFormatModel | null {
  return formats.find((f) => f.status === 'PUBLISHED' && f.effectiveFrom <= at && (f.effectiveTo === null || at < f.effectiveTo)) ?? null;
}

const issuesOf = (issues: AddressIssueDto[]) => issues.map(({ field, code, messageKey }) => ({ field, code, messageKey }));
const notFound = (code: string) => new GeographyError('COUNTRY_NOT_FOUND', 'the country is not registered', { code: String(code).slice(0, 8) });
const noFormat = (code: string) => new GeographyError('ADDRESS_FORMAT_NOT_FOUND', 'the country has no address format in effect', { code });

export class AddressService {
  private readonly ttl: number;

  constructor(private readonly d: AddressServiceDeps) {
    this.ttl = d.cacheTtlSeconds ?? DEFAULT_GEO_CACHE_TTL_SECONDS;
  }

  private nowDate(): Date {
    return this.d.now?.() ?? new Date();
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }

  // ------------------------------------------------------------------ loading
  private async loadData(code: string, management: boolean): Promise<CountryAddressData | null> {
    const db = this.d.database.db;
    const c = await sql<Row>`SELECT country_id, iso_alpha2, status, default_locale FROM geography.countries WHERE iso_alpha2 = ${code}`.execute(db);
    const country = c.rows[0];
    if (!country || (!management && country.status !== 'ACTIVE')) return null;
    const countryId = country.country_id as string;
    const formatRows = await sql<Row>`
      SELECT address_format_id, version, status, display_template, effective_from, effective_to
        FROM geography.address_formats WHERE country_id = ${countryId} AND (${management} OR status = 'PUBLISHED') ORDER BY version DESC`.execute(db);
    const ids = formatRows.rows.map((r) => r.address_format_id as string);
    const fieldRows = ids.length
      ? await sql<Row>`SELECT * FROM geography.address_format_fields WHERE address_format_id = ANY(${ids}::uuid[]) ORDER BY address_format_id, display_order`.execute(
          db,
        )
      : { rows: [] as Row[] };
    const formats: AddressFormatModel[] = formatRows.rows.map((r) => ({
      addressFormatId: r.address_format_id as string,
      countryCode: code,
      version: Number(r.version),
      status: r.status as 'DRAFT' | 'PUBLISHED',
      displayTemplate: r.display_template as string,
      effectiveFrom: r.effective_from as Date,
      effectiveTo: (r.effective_to as Date | null) ?? null,
      fields: fieldRows.rows.filter((f) => f.address_format_id === r.address_format_id).map(fieldFrom),
    }));
    const areaRows = await sql<Row>`
      SELECT a.administrative_area_id, a.code, a.name, a.area_type, a.status, a.display_order, p.code AS parent_code
        FROM geography.administrative_areas a LEFT JOIN geography.administrative_areas p ON p.administrative_area_id = a.parent_area_id
       WHERE a.country_id = ${countryId} AND (${management} OR a.status = 'ACTIVE') ORDER BY a.code`.execute(db);
    return {
      countryId,
      code,
      status: country.status as GeoStatus,
      defaultLocale: country.default_locale as string,
      formats,
      areas: areaRows.rows.map(areaFrom),
    };
  }

  /** The country's address data: ACTIVE countries only for the public view (cached, never negative), any status for management (never cached). */
  private async countryData(codeInput: string, management: boolean): Promise<CountryAddressData> {
    if (!isCountryCode(codeInput)) throw notFound(codeInput);
    const code = codeInput;
    if (management) {
      const data = await this.loadData(code, true).catch(mapDbError);
      if (!data) throw notFound(code);
      return data;
    }
    const { value } = await cachedRead<CountryAddressData>({
      cache: this.d.cache,
      env: this.d.env,
      what: `address:${code}`,
      ttlSeconds: this.ttl,
      deadlineMs: this.d.cacheDeadlineMs,
      load: () => this.loadData(code, false).catch(mapDbError),
      parse: (raw) => {
        const r = DataBlob.safeParse(raw);
        return r.success ? reviveData(r.data) : null;
      },
    });
    if (!value) throw notFound(code);
    return value;
  }

  // ------------------------------------------------------------------ reads
  /** The format in effect for a country (management also sees a country that is not ACTIVE). */
  async getAddressFormat(countryCode: string, options: AddressReadOptions = {}): Promise<AddressFormatModel> {
    const data = await this.countryData(countryCode, options.management === true);
    const format = formatInEffect(data.formats, options.at ?? this.nowDate());
    if (!format) throw noFormat(data.code);
    return format;
  }
  /** Every version of the country's format, newest first, drafts included (management). */
  async listAddressFormats(countryCode: string): Promise<AddressFormatModel[]> {
    return (await this.countryData(countryCode, true)).formats;
  }
  /** Areas in picker order (public: ACTIVE only) and the entry mode of the format in effect (NONE when the country has no format yet). */
  async listAdministrativeAreas(
    countryCode: string,
    options: AddressReadOptions = {},
  ): Promise<{ mode: AdministrativeAreaListDto['mode']; areas: AdministrativeAreaModel[] }> {
    const management = options.management === true;
    const data = await this.countryData(countryCode, management);
    const format = formatInEffect(data.formats, options.at ?? this.nowDate());
    const areas = (management ? data.areas : data.areas.filter((a) => a.status === 'ACTIVE')).slice().sort(byPickerOrder);
    return { mode: format ? administrativeAreaMode(format) : 'NONE', areas };
  }
  /** Whether the country has a PUBLISHED format in force at `at` (readiness check; a plain database read, never cached). */
  async hasEffectiveFormat(countryCode: string, at: Date = this.nowDate()): Promise<boolean> {
    const r = await sql<Row>`SELECT 1 FROM geography.address_formats f JOIN geography.countries c ON c.country_id = f.country_id
        WHERE c.iso_alpha2 = ${countryCode} AND f.status = 'PUBLISHED' AND f.effective_from <= ${at} AND (f.effective_to IS NULL OR ${at} < f.effective_to) LIMIT 1`
      .execute(this.d.database.db)
      .catch(mapDbError);
    return r.rows.length > 0;
  }

  // ------------------------------------------------------------------ validation and formatting (stateless)
  /** Validates and normalizes an address with the country's format in effect: the same rules every form renders. */
  async validateAddress(input: AddressInput, options: AddressReadOptions = {}): Promise<AddressValidationResult> {
    const parsed = AddressInput.safeParse(input);
    if (!parsed.success)
      throw new GeographyError('VALIDATION_FAILED', 'the address request is not well formed', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') })),
      });
    const data = await this.countryData(parsed.data.countryCode, options.management === true);
    const format = formatInEffect(data.formats, options.at ?? this.nowDate());
    if (!format) throw noFormat(data.code);
    return { outcome: validateAddressAgainstFormat(format, data.areas, parsed.data), format };
  }

  /**
   * Validates then formats an address with the central formatter. An invalid address is a VALIDATION_FAILED error whose details carry the issues
   * (property, code, message key) and nothing that was typed. `includeCountry` appends the country name in `locale` (default: the country's).
   */
  async formatAddress(
    input: AddressInput,
    options: AddressReadOptions & { locale?: string; includeCountry?: boolean } = {},
  ): Promise<{ address: NormalizedAddressDto; formatted: FormattedAddressDto }> {
    const { outcome, format } = await this.validateAddress(input, options);
    if (!outcome.valid || !outcome.address)
      throw new GeographyError('VALIDATION_FAILED', 'the address is not valid for the country', { issues: issuesOf(outcome.issues) });
    const locale = options.locale ?? (await this.countryData(format.countryCode, options.management === true)).defaultLocale;
    const countryName = options.includeCountry ? await this.resolveCountryName(format.countryCode, locale) : null;
    return { address: outcome.address, formatted: formatAddressWithFormat(format, outcome.address, { countryName }) };
  }

  /** Validates a postal code against the country's POSTAL_CODE field (service areas, zones and reports use the same rule as forms). */
  async validatePostalCode(
    countryCode: string,
    value: string,
    options: AddressReadOptions = {},
  ): Promise<{ ok: true; value: string } | { ok: false; code: string }> {
    const format = await this.getAddressFormat(countryCode, options);
    return validateFieldValue(format, 'POSTAL_CODE', value);
  }

  private async resolveCountryName(countryCode: string, locale: string): Promise<string | null> {
    if (!this.d.countryNames) return null;
    try {
      return await this.d.countryNames(countryCode, locale);
    } catch {
      log('warn', 'address country name could not be resolved', { country: countryCode });
      return null;
    }
  }

  // ------------------------------------------------------------------ providers
  private async callProvider<T>(provider: string, operation: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const ms = this.d.providerTimeoutMs ?? 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('provider timeout')), ms);
        }),
      ]);
      return { ok: true, value };
    } catch {
      // Never log the error text or any address data: a provider error can echo what was sent.
      log('warn', 'address provider unavailable', { provider, operation });
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Autocomplete suggestions from the country's provider; UNAVAILABLE (callers fall back to manual entry) when none is configured or it fails. */
  async suggestAddresses(countryCode: string, text: string, options: { locale?: string; limit?: number } = {}) {
    if (!isCountryCode(countryCode)) throw notFound(countryCode);
    const provider = this.d.providers?.autocomplete?.(countryCode);
    if (!provider) throw new GeographyError('UNAVAILABLE', 'address autocomplete is not available for the country', { reason: 'NO_AUTOCOMPLETE_PROVIDER' });
    const result = await this.callProvider(provider.code, 'suggest', () =>
      provider.suggest({ countryCode, text, locale: options.locale, limit: options.limit }),
    );
    if (!result.ok) throw new GeographyError('UNAVAILABLE', 'address autocomplete is temporarily unavailable', { reason: 'PROVIDER_UNAVAILABLE' });
    return result.value;
  }

  // ------------------------------------------------------------------ persistence (the canonical address)
  private async insertAddress(
    trx: Trx,
    p: {
      countryId: string;
      format: AddressFormatModel;
      outcome: AddressValidationOutcome;
      formatted: FormattedAddressDto;
      source: AddressValidationSource;
      status: AddressValidationStatus;
      provider?: { code: string; reference?: string | null };
      located?: { latitude: number; longitude: number } | null;
      timeZoneId?: string | null;
      rawInput: Record<string, unknown>;
    },
  ): Promise<string> {
    const a = p.outcome.address!;
    const raw = JSON.stringify(p.rawInput);
    // measured exactly like the CHECK (characters of the jsonb text, which adds spaces after ':' and ','), so the typed error always wins over the constraint
    const size = Number((await sql<Row>`SELECT length(${raw}::jsonb::text) AS n`.execute(trx)).rows[0]!.n);
    if (size > 4000) throw new GeographyError('VALIDATION_FAILED', 'the raw input is too large to store', { reason: 'RAW_INPUT_TOO_LARGE' });
    const point = p.located ? sql`ST_SetSRID(ST_MakePoint(${p.located.longitude}::float8, ${p.located.latitude}::float8), 4326)::geography` : sql`NULL`;
    const r = await sql<Row>`
      INSERT INTO geography.addresses (country_id, address_format_id, administrative_area_id, administrative_area_code, administrative_area_name, organization,
        address_line_1, address_line_2, dependent_locality, locality, postal_code, sorting_code, location, time_zone_id, formatted_address,
        validation_status, validation_source, provider_code, provider_reference, raw_input)
      VALUES (${p.countryId}, ${p.format.addressFormatId}, ${p.outcome.administrativeAreaId}, ${a.administrativeAreaCode}, ${a.administrativeAreaName}, ${a.organization},
        ${a.addressLine1}, ${a.addressLine2}, ${a.dependentLocality}, ${a.locality}, ${a.postalCode}, ${a.sortingCode}, ${point}, ${p.timeZoneId ?? null}, ${p.formatted.text},
        ${p.status}, ${p.source}, ${p.provider?.code ?? null}, ${p.provider?.reference ?? null}, ${raw}::jsonb)
      RETURNING address_id`.execute(trx);
    return r.rows[0]!.address_id as string;
  }

  private async timeZoneId(trx: Trx, ianaName: string | null | undefined, provider: string): Promise<string | null> {
    if (!ianaName) return null;
    const r = await sql<Row>`SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ${ianaName} AND status = 'ACTIVE'`.execute(trx);
    if (!r.rows[0]) {
      log('warn', 'address provider returned a time zone that is not registered and ACTIVE', { provider });
      return null;
    }
    return r.rows[0].time_zone_id as string;
  }

  private async persist(
    validated: AddressValidationResult,
    rawInput: Record<string, unknown>,
    flow: {
      source: AddressValidationSource;
      status: AddressValidationStatus;
      provider?: { code: string; reference?: string | null };
      geocode?: GeocodeResult | null;
    },
  ): Promise<CreatedAddress> {
    const { outcome, format } = validated;
    if (!outcome.valid || !outcome.address)
      throw new GeographyError('VALIDATION_FAILED', 'the address is not valid for the country', { issues: issuesOf(outcome.issues) });
    const formatted = formatAddressWithFormat(format, outcome.address);
    const geo = flow.geocode && isValidCoordinate(flow.geocode.latitude, flow.geocode.longitude) ? flow.geocode : null;
    const addressId = await this.tx(async (trx) => {
      const countryId = (await sql<Row>`SELECT country_id FROM geography.countries WHERE iso_alpha2 = ${format.countryCode}`.execute(trx)).rows[0]
        ?.country_id as string | undefined;
      if (!countryId) throw notFound(format.countryCode);
      const timeZoneId = geo ? await this.timeZoneId(trx, geo.timeZone, flow.provider?.code ?? 'unknown') : null;
      return this.insertAddress(trx, {
        countryId,
        format,
        outcome,
        formatted,
        source: flow.source,
        status: flow.status,
        provider: flow.provider,
        located: geo ? { latitude: geo.latitude, longitude: geo.longitude } : null,
        timeZoneId,
        rawInput,
      });
    });
    return { addressId, validationStatus: flow.status, validationSource: flow.source, formatVersion: format.version, located: geo !== null };
  }

  /**
   * Manual entry: validated against the country format, raw input preserved, stored UNVERIFIED (marked for review, SV-10.06) with source MANUAL and
   * no coordinates. This is also the fallback of every provider flow, so entry works when no provider is available.
   */
  async createManualAddress(input: AddressInput, options: CreateAddressOptions = {}): Promise<CreatedAddress> {
    const validated = await this.validateAddress(input);
    return this.persist(validated, options.rawInput ?? { ...input }, { source: 'MANUAL', status: 'UNVERIFIED' });
  }

  /**
   * A selected autocomplete suggestion: the provider resolves it to structured fields, which are validated against the country format like any
   * other input, then stored with source AUTOCOMPLETE and status FORMAT_VALID (a selection is not verification and carries no coordinates).
   * UNAVAILABLE when no provider is configured or it fails, so the caller falls back to createManualAddress.
   */
  async createAddressFromAutocomplete(req: { countryCode: string; suggestionId: string; locale?: string; query?: string }): Promise<CreatedAddress> {
    if (!isCountryCode(req.countryCode)) throw notFound(req.countryCode);
    const provider = this.d.providers?.autocomplete?.(req.countryCode);
    if (!provider) throw new GeographyError('UNAVAILABLE', 'address autocomplete is not available for the country', { reason: 'NO_AUTOCOMPLETE_PROVIDER' });
    const call = await this.callProvider<ProviderAddress | null>(provider.code, 'resolve', () =>
      provider.resolve(req.suggestionId, { countryCode: req.countryCode, locale: req.locale }),
    );
    if (!call.ok) throw new GeographyError('UNAVAILABLE', 'address autocomplete is temporarily unavailable', { reason: 'PROVIDER_UNAVAILABLE' });
    // a provider that ANSWERS "unknown suggestion" (null) is a caller error, not an outage
    const resolved = call.value;
    if (!resolved || resolved.address.countryCode !== req.countryCode)
      throw new GeographyError('VALIDATION_FAILED', 'the suggestion could not be used', { reason: 'UNKNOWN_SUGGESTION' });
    const validated = await this.validateAddress(resolved.address);
    return this.persist(
      validated,
      { provider: provider.code, suggestionId: req.suggestionId, ...(req.query ? { query: req.query } : {}), fields: { ...resolved.address } },
      {
        source: 'AUTOCOMPLETE',
        status: 'FORMAT_VALID',
        provider: { code: provider.code, reference: resolved.providerReference ?? req.suggestionId },
      },
    );
  }

  /**
   * Validates, then asks the country's geocoder for coordinates and a time zone. Located: source GEOCODER, status GEOCODED, one authoritative
   * geography point, the time zone stored as a reference to a registered ACTIVE zone (an unknown zone is dropped). Not located (no provider, provider
   * down, address not found, unusable coordinates): the address is stored exactly like a manual one (UNVERIFIED, MANUAL, no coordinates).
   */
  async geocodeAndCreateAddress(input: AddressInput, options: CreateAddressOptions = {}): Promise<CreatedAddress> {
    const validated = await this.validateAddress(input);
    const rawInput = options.rawInput ?? { ...input };
    const provider = this.d.providers?.geocoder?.(validated.format.countryCode);
    const outcomeAddress = validated.outcome.address;
    if (provider && outcomeAddress) {
      const call = await this.callProvider(provider.code, 'geocode', () => provider.geocode(outcomeAddress));
      const result = call.ok ? call.value : null;
      if (result && isValidCoordinate(result.latitude, result.longitude)) {
        return this.persist(validated, rawInput, {
          source: 'GEOCODER',
          status: 'GEOCODED',
          provider: { code: provider.code, reference: result.providerReference ?? null },
          geocode: result,
        });
      }
    }
    return this.persist(validated, rawInput, { source: 'MANUAL', status: 'UNVERIFIED' });
  }

  // ------------------------------------------------------------------ reading persisted addresses (in-process; never exposed by a public API)
  async getAddress(addressId: string, options: { includeRawInput?: boolean } = {}): Promise<StoredAddress | null> {
    if (!z.string().uuid().safeParse(addressId).success) return null;
    const r = await sql<Row>`
      SELECT a.address_id, c.iso_alpha2, f.version AS format_version, a.organization, a.address_line_1, a.address_line_2, a.dependent_locality, a.locality,
             a.administrative_area_code, a.administrative_area_name, a.postal_code, a.sorting_code, a.formatted_address, a.validation_status, a.validation_source,
             a.provider_code, a.provider_reference, a.created_at, a.raw_input, t.iana_name,
             CASE WHEN a.location IS NULL THEN NULL ELSE ST_Y(a.location::geometry) END AS latitude,
             CASE WHEN a.location IS NULL THEN NULL ELSE ST_X(a.location::geometry) END AS longitude
        FROM geography.addresses a
        JOIN geography.countries c ON c.country_id = a.country_id
        JOIN geography.address_formats f ON f.address_format_id = a.address_format_id
        LEFT JOIN geography.time_zones t ON t.time_zone_id = a.time_zone_id
       WHERE a.address_id = ${addressId}`
      .execute(this.d.database.db)
      .catch(mapDbError);
    const row = r.rows[0];
    if (!row) return null;
    return {
      addressId: row.address_id as string,
      address: {
        countryCode: row.iso_alpha2 as string,
        organization: (row.organization as string | null) ?? null,
        addressLine1: row.address_line_1 as string,
        addressLine2: (row.address_line_2 as string | null) ?? null,
        dependentLocality: (row.dependent_locality as string | null) ?? null,
        locality: (row.locality as string | null) ?? null,
        administrativeAreaCode: (row.administrative_area_code as string | null) ?? null,
        administrativeAreaName: (row.administrative_area_name as string | null) ?? null,
        postalCode: (row.postal_code as string | null) ?? null,
        sortingCode: (row.sorting_code as string | null) ?? null,
      },
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      timeZone: (row.iana_name as string | null) ?? null,
      formattedAddress: row.formatted_address as string,
      validationStatus: row.validation_status as AddressValidationStatus,
      validationSource: row.validation_source as AddressValidationSource,
      providerCode: (row.provider_code as string | null) ?? null,
      providerReference: (row.provider_reference as string | null) ?? null,
      formatVersion: Number(row.format_version),
      createdAt: iso(row.created_at),
      ...(options.includeRawInput ? { rawInput: row.raw_input as Record<string, unknown> } : {}),
    };
  }

  /** Renders a stored address with the format VERSION it was validated with (never today's format), optionally with the country line. */
  async formatStoredAddress(addressId: string, options: { locale?: string; includeCountry?: boolean } = {}): Promise<FormattedAddressDto | null> {
    const stored = await this.getAddress(addressId);
    if (!stored) return null;
    const rows = await sql<Row>`SELECT f.address_format_id, f.version, f.status, f.display_template, f.effective_from, f.effective_to
        FROM geography.addresses a JOIN geography.address_formats f ON f.address_format_id = a.address_format_id WHERE a.address_id = ${addressId}`
      .execute(this.d.database.db)
      .catch(mapDbError);
    const f = rows.rows[0]!;
    const format: AddressFormatModel = {
      addressFormatId: f.address_format_id as string,
      countryCode: stored.address.countryCode,
      version: Number(f.version),
      status: f.status as 'DRAFT' | 'PUBLISHED',
      displayTemplate: f.display_template as string,
      effectiveFrom: f.effective_from as Date,
      effectiveTo: (f.effective_to as Date | null) ?? null,
      fields: [],
    };
    const locale = options.locale ?? (await this.countryData(stored.address.countryCode, true)).defaultLocale;
    const countryName = options.includeCountry ? await this.resolveCountryName(stored.address.countryCode, locale) : null;
    return formatAddressWithFormat(format, stored.address, { countryName });
  }

  // ------------------------------------------------------------------ management: formats
  private audit(
    trx: Trx,
    cid: string,
    a: { actor: string; action: string; countryId?: string; addressFormatId?: string; changes?: Record<string, unknown>; reason: string },
  ) {
    return sql`INSERT INTO geography.audit_events (actor, action, country_id, address_format_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.countryId ?? null}, ${a.addressFormatId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason}, ${cid})`.execute(
      trx,
    );
  }

  /** Locks the country row (the owner of version allocation, publication order and area changes) and returns its id. */
  private async lockCountry(trx: Trx, code: string): Promise<string> {
    if (!isCountryCode(code)) throw notFound(code);
    const locked = await sql<Row>`SELECT 1 FROM geography.countries WHERE iso_alpha2 = ${code} FOR UPDATE`.execute(trx);
    if (locked.rows.length === 0) throw notFound(code);
    return (await sql<Row>`SELECT country_id FROM geography.countries WHERE iso_alpha2 = ${code}`.execute(trx)).rows[0]!.country_id as string;
  }

  /** Creates a DRAFT format version. Fields are written in array order. Nothing is public until it is published. */
  async createFormatDraft(countryCode: string, request: unknown, actor: string): Promise<AddressFormatModel> {
    const parsed = CreateAddressFormatRequest.safeParse(request);
    if (!parsed.success)
      throw new GeographyError('VALIDATION_FAILED', 'the address format request is not well formed', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const req = parsed.data;
    const problem = (field: string, reason: string, message: string) => new GeographyError('VALIDATION_FAILED', message, { reason, field });
    const types = req.fields.map((f) => f.fieldType);
    if (new Set(types).size !== types.length) throw problem('fields', 'DUPLICATE_FIELD', 'a field type may appear once in a format');
    const line1 = req.fields.find((f) => f.fieldType === 'ADDRESS_LINE_1');
    if (!line1 || !line1.required) throw problem('fields', 'ADDRESS_LINE_1_REQUIRED', 'a format needs a required ADDRESS_LINE_1');
    const tp = templateProblem(req.displayTemplate, types);
    if (tp) throw problem('displayTemplate', 'INVALID_TEMPLATE', `the display template ${tp}`);
    req.fields.forEach((f, i) => {
      const at = `fields.${i}`;
      if (f.inputType === 'LOOKUP' && (f.fieldType !== 'ADMINISTRATIVE_AREA' || f.validationPattern || f.normalization))
        throw problem(at, 'INVALID_LOOKUP_FIELD', 'only ADMINISTRATIVE_AREA can be a LOOKUP, without a pattern or normalization');
      if (f.validationPattern) {
        const pp = patternProblem(f.validationPattern);
        if (pp) throw problem(`${at}.validationPattern`, 'UNSAFE_PATTERN', `the validation pattern ${pp}`);
        if (f.example && !new RegExp(`^(?:${f.validationPattern})$`, 'u').test(f.example))
          throw problem(`${at}.example`, 'EXAMPLE_DOES_NOT_MATCH', 'the example does not match the validation pattern');
      }
      if (f.example && codePointLength(f.example) > f.maxLength)
        throw problem(`${at}.example`, 'EXAMPLE_TOO_LONG', 'the example is longer than the maximum length');
    });
    const reason = requireReason(req.reason);
    const cid = getCorrelationId() ?? randomUUID();
    const at = this.nowDate();
    const version = await this.tx(async (trx) => {
      const countryId = await this.lockCountry(trx, countryCode);
      const next = Number(
        (await sql<Row>`SELECT coalesce(max(version), 0) + 1 AS v FROM geography.address_formats WHERE country_id = ${countryId}`.execute(trx)).rows[0]!.v,
      );
      const from = req.effectiveFrom ? new Date(req.effectiveFrom) : at;
      const created = await sql<Row>`INSERT INTO geography.address_formats (country_id, version, status, display_template, effective_from)
        VALUES (${countryId}, ${next}, 'DRAFT', ${req.displayTemplate}, ${from}) RETURNING address_format_id`.execute(trx);
      const formatId = created.rows[0]!.address_format_id as string;
      for (const [i, f] of req.fields.entries()) {
        await sql`INSERT INTO geography.address_format_fields (address_format_id, field_type, display_order, content_label_key, required, max_length, input_type,
            validation_pattern, example_value, autocomplete_hint, normalization_rule)
          VALUES (${formatId}, ${f.fieldType}, ${i + 1}, ${f.contentLabelKey}, ${f.required}, ${f.maxLength}, ${f.inputType}, ${f.validationPattern ?? null},
            ${f.example ?? null}, ${f.autocomplete ?? null}, ${f.normalization ?? null})`.execute(trx);
      }
      await this.audit(trx, cid, { actor, action: 'ADDRESS_FORMAT_DRAFTED', addressFormatId: formatId, changes: { version: [null, next] }, reason });
      return next;
    });
    return (await this.countryData(countryCode, true)).formats.find((f) => f.version === version)!;
  }

  /**
   * Publishes a DRAFT: it becomes immutable and starts at max(draft start, requested start, now). The format that is open-ended at that moment is
   * closed at the new start in the same transaction (the database also refuses overlapping periods). Idempotent for an already published version.
   * Publications of one country serialize on the country row, so concurrent publications cannot interleave.
   */
  async publishFormat(countryCode: string, version: number, request: unknown, actor: string): Promise<AddressFormatModel> {
    const parsed = PublishAddressFormatRequest.safeParse(request);
    if (!parsed.success)
      throw new GeographyError('VALIDATION_FAILED', 'the publication request is not well formed', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (!Number.isInteger(version) || version < 1)
      throw new GeographyError('ADDRESS_FORMAT_NOT_FOUND', 'the address format version does not exist', { version });
    const reason = requireReason(parsed.data.reason);
    const cid = getCorrelationId() ?? randomUUID();
    const changed = await this.tx(async (trx) => {
      const countryId = await this.lockCountry(trx, countryCode);
      const locked = await sql<Row>`SELECT 1 FROM geography.address_formats WHERE country_id = ${countryId} AND version = ${version} FOR UPDATE`.execute(trx);
      if (locked.rows.length === 0)
        throw new GeographyError('ADDRESS_FORMAT_NOT_FOUND', 'the address format version does not exist', { code: countryCode, version });
      const row = (
        await sql<Row>`SELECT address_format_id, status, effective_from FROM geography.address_formats WHERE country_id = ${countryId} AND version = ${version}`.execute(
          trx,
        )
      ).rows[0]!;
      if (row.status === 'PUBLISHED') return null;
      const clock = (await sql<Row>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t as Date;
      const candidates = [row.effective_from as Date, parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : clock, clock];
      const start = new Date(Math.max(...candidates.map((d) => d.getTime())));
      const lockedOpen =
        await sql<Row>`SELECT address_format_id FROM geography.address_formats WHERE country_id = ${countryId} AND status = 'PUBLISHED' AND effective_to IS NULL ORDER BY version FOR UPDATE`.execute(
          trx,
        );
      const open = lockedOpen.rows[0]
        ? (
            await sql<Row>`SELECT address_format_id, effective_from FROM geography.address_formats WHERE address_format_id = ${lockedOpen.rows[0].address_format_id as string}`.execute(
              trx,
            )
          ).rows[0]!
        : null;
      if (open) {
        if ((open.effective_from as Date).getTime() >= start.getTime())
          throw new GeographyError('CONFLICT', 'the new format must start after the format currently in force', {
            reason: 'START_NOT_AFTER_CURRENT',
            retryable: true,
          });
        await sql`UPDATE geography.address_formats SET effective_to = ${start}, updated_at = now() WHERE address_format_id = ${open.address_format_id as string}`.execute(
          trx,
        );
      }
      await sql`UPDATE geography.address_formats SET status = 'PUBLISHED', effective_from = ${start}, updated_at = now() WHERE address_format_id = ${row.address_format_id as string}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'ADDRESS_FORMAT_PUBLISHED',
        addressFormatId: row.address_format_id as string,
        changes: { status: ['DRAFT', 'PUBLISHED'], effectiveFrom: [iso(row.effective_from), start.toISOString()] },
        reason,
      });
      const payload: AddressFormatPublishedPayload = { countryCode, version, effectiveFrom: start.toISOString() };
      await insertOutboxEvent(trx, {
        aggregateType: 'geography_address_format',
        aggregateId: row.address_format_id as string,
        eventType: GEOGRAPHY_EVENTS.addressFormatPublished,
        actorType: 'user',
        actorId: actor,
        correlationId: cid,
        payload,
      });
      return true;
    });
    if (changed) await invalidateGeography(this.d.cache, this.d.env, this.d.cacheDeadlineMs);
    const found = (await this.countryData(countryCode, true)).formats.find((f) => f.version === version);
    if (!found) throw new GeographyError('ADDRESS_FORMAT_NOT_FOUND', 'the address format version does not exist', { code: countryCode, version });
    return found;
  }

  // ------------------------------------------------------------------ management: administrative areas
  /**
   * Creates the areas that do not exist and updates name, type, display order and activity of the ones that do (a parent can only be set when an
   * area is created). Rows are never deleted. The last ACTIVE area cannot be retired while a published format has a LOOKUP field. Writes nothing
   * (no audit row, no event) when nothing changes.
   */
  async upsertAdministrativeAreas(countryCode: string, request: unknown, actor: string): Promise<UpsertAdministrativeAreasResultDto> {
    const parsed = UpsertAdministrativeAreasRequest.safeParse(request);
    if (!parsed.success)
      throw new GeographyError('VALIDATION_FAILED', 'the administrative areas request is not well formed', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const codes = parsed.data.areas.map((a) => a.code);
    if (new Set(codes).size !== codes.length)
      throw new GeographyError('VALIDATION_FAILED', 'an area code may appear once per request', { reason: 'DUPLICATE_AREA_CODE' });
    const reason = requireReason(parsed.data.reason);
    const cid = getCorrelationId() ?? randomUUID();
    const result = await this.tx(async (trx) => {
      const countryId = await this.lockCountry(trx, countryCode);
      const existingRows = (
        await sql<Row>`SELECT a.administrative_area_id, a.code, a.name, a.area_type, a.status, a.display_order, p.code AS parent_code
          FROM geography.administrative_areas a LEFT JOIN geography.administrative_areas p ON p.administrative_area_id = a.parent_area_id WHERE a.country_id = ${countryId}`.execute(
          trx,
        )
      ).rows;
      const byCode = new Map(existingRows.map((r) => [r.code as string, areaFrom(r)]));
      const added: string[] = [];
      const updated: string[] = [];
      for (const item of parsed.data.areas) {
        const before = byCode.get(item.code);
        const status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        if (!before) {
          let parentId: string | null = null;
          if (item.parentCode) {
            const parent = byCode.get(item.parentCode);
            if (!parent)
              throw new GeographyError('VALIDATION_FAILED', 'the parent area does not exist in the country (list it before its children)', {
                reason: 'UNKNOWN_PARENT_AREA',
                field: 'parentCode',
              });
            parentId = parent.administrativeAreaId;
          }
          const ins = await sql<Row>`INSERT INTO geography.administrative_areas (country_id, code, name, area_type, status, parent_area_id, display_order)
            VALUES (${countryId}, ${item.code}, ${item.name}, ${item.type}, ${status}, ${parentId}, ${item.displayOrder ?? null}) RETURNING administrative_area_id`.execute(
            trx,
          );
          byCode.set(item.code, {
            administrativeAreaId: ins.rows[0]!.administrative_area_id as string,
            code: item.code,
            name: item.name,
            type: item.type,
            parentCode: item.parentCode ?? null,
            displayOrder: item.displayOrder ?? null,
            status,
          });
          added.push(item.code);
          continue;
        }
        if (item.parentCode !== undefined && (item.parentCode ?? null) !== before.parentCode)
          throw new GeographyError('VALIDATION_FAILED', 'the parent of an existing area cannot change', { reason: 'PARENT_IMMUTABLE', field: 'parentCode' });
        const nextStatus = item.active === undefined ? before.status : status;
        const nextOrder = item.displayOrder === undefined ? before.displayOrder : item.displayOrder;
        if (before.name === item.name && before.type === item.type && before.status === nextStatus && before.displayOrder === nextOrder) continue;
        await sql`UPDATE geography.administrative_areas SET name = ${item.name}, area_type = ${item.type}, status = ${nextStatus}, display_order = ${nextOrder}, updated_at = now()
          WHERE administrative_area_id = ${before.administrativeAreaId}`.execute(trx);
        byCode.set(item.code, { ...before, name: item.name, type: item.type, status: nextStatus, displayOrder: nextOrder });
        updated.push(item.code);
      }
      if (added.length + updated.length === 0) return { added: 0, updated: 0, changed: false };
      if (![...byCode.values()].some((a) => a.status === 'ACTIVE')) {
        const lookup =
          await sql<Row>`SELECT 1 FROM geography.address_formats f JOIN geography.address_format_fields x ON x.address_format_id = f.address_format_id
          WHERE f.country_id = ${countryId} AND f.status = 'PUBLISHED' AND x.input_type = 'LOOKUP' LIMIT 1`.execute(trx);
        if (lookup.rows.length > 0)
          throw new GeographyError('INVALID_STATE', 'a published address format needs at least one ACTIVE area to choose from', { reason: 'AREAS_IN_USE' });
      }
      await this.audit(trx, cid, { actor, action: 'COUNTRY_ADMINISTRATIVE_AREAS_UPDATED', countryId, changes: { added, updated }, reason });
      const payload: AdministrativeAreasUpdatedPayload = { countryCode, added: added.length, updated: updated.length };
      await insertOutboxEvent(trx, {
        aggregateType: 'geography_country',
        aggregateId: countryId,
        eventType: GEOGRAPHY_EVENTS.administrativeAreasUpdated,
        actorType: 'user',
        actorId: actor,
        correlationId: cid,
        payload,
      });
      return { added: added.length, updated: updated.length, changed: true };
    });
    if (result.changed) await invalidateGeography(this.d.cache, this.d.env, this.d.cacheDeadlineMs);
    return { countryCode, added: result.added, updated: result.updated };
  }
}

/** Readiness check for the market activation checklist: the market country has an address format in force (no country-specific rule). */
export function createAddressFormatReadinessCheck(service: AddressService): ReadinessCheck {
  return {
    code: 'ADDRESS_FORMAT',
    description: 'The market country has a published address format in force',
    evaluate: async (ctx) => {
      const ok = await service.hasEffectiveFormat(ctx.country.code, ctx.at);
      return {
        passed: ok,
        detail: ok ? `country ${ctx.country.code} has an address format in force` : `country ${ctx.country.code} has no address format in force`,
      };
    },
  };
}

export { ADDRESS_FIELD_TYPES };
