// Public contracts of the geography registry (docs/engineering/GEOGRAPHY.md): countries, currencies, time zones, markets and the
// data-driven defaults derived from them. Reference data only: no addresses, no tax or payment configuration.
import { z } from 'zod';
import { Locale } from './content';
import { envelope } from './envelope';
import { adminText } from './text';
export { adminText, containsForbiddenText } from './text';

// ---------------------------------------------------------------- codes
/** ISO 3166-1 alpha-2, upper case. This is also the canonical COUNTRY scope reference used by configuration and content. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
export const CountryAlpha3 = z.string().regex(/^[A-Z]{3}$/);
export const CountryNumeric = z.string().regex(/^[0-9]{3}$/);
/** ISO 4217 alpha code, upper case. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const CurrencyNumeric = z.string().regex(/^[0-9]{3}$/);
/** Market code: lower-case kebab (la-oc). This is also the canonical MARKET scope reference used by configuration and content. */
export const MarketCode = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
/** IANA time zone identifier (America/Los_Angeles). Offsets are never an identity. The database additionally requires the name to exist in its tz database. */
export const IanaTimeZone = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/);
export const DialingCode = z.string().regex(/^[+][0-9]{1,4}$/);

// ---------------------------------------------------------------- enumerations (normalized codes, rendered with Intl by consumers)
export const GEO_STATUSES = ['PLANNED', 'ACTIVE', 'INACTIVE'] as const;
export const GeoStatus = z.enum(GEO_STATUSES);
export type GeoStatus = z.infer<typeof GeoStatus>;
export const DISTANCE_UNITS = ['MILES', 'KILOMETERS'] as const;
export const DistanceUnit = z.enum(DISTANCE_UNITS);
export type DistanceUnit = z.infer<typeof DistanceUnit>;
export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;
/** Order of the date parts: month-day-year, day-month-year, year-month-day. */
export const DATE_FORMAT_CODES = ['MDY', 'DMY', 'YMD'] as const;
export const DateFormatCode = z.enum(DATE_FORMAT_CODES);
export type DateFormatCode = z.infer<typeof DateFormatCode>;
export const TIME_FORMAT_CODES = ['12_HOUR', '24_HOUR'] as const;
export const TimeFormatCode = z.enum(TIME_FORMAT_CODES);
export type TimeFormatCode = z.infer<typeof TimeFormatCode>;

// ---------------------------------------------------------------- read models
// Fields marked "management only" are returned only to callers with the geography-read client role; anonymous callers see ACTIVE data only.
export const CurrencyDto = z.object({
  code: z.string(),
  numericCode: z.string(),
  minorUnitDigits: z.number().int().min(0).max(4),
  displayName: z.string(),
  symbol: z.string().nullable(),
  /** management only */
  status: GeoStatus.optional(),
});
export type CurrencyDto = z.infer<typeof CurrencyDto>;

export const TimeZoneDto = z.object({ ianaName: z.string(), status: GeoStatus.optional() });
export type TimeZoneDto = z.infer<typeof TimeZoneDto>;

export const CountryDto = z.object({
  code: z.string(),
  alpha3: z.string(),
  numeric: z.string(),
  /** Content key of the managed display name; resolve it with the content API. */
  displayNameContentKey: z.string(),
  dialingCode: z.string(),
  defaultCurrencyCode: z.string(),
  defaultLocale: z.string(),
  supportedLocales: z.array(z.string()),
  timeZones: z.array(z.string()),
  distanceUnit: DistanceUnit,
  firstDayOfWeek: Weekday,
  dateFormat: DateFormatCode,
  timeFormat: TimeFormatCode,
  /** management only */
  status: GeoStatus.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CountryDto = z.infer<typeof CountryDto>;

export const MarketDto = z.object({
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  defaultLocale: z.string(),
  supportedLocales: z.array(z.string()),
  currencyCode: z.string(),
  defaultTimeZone: z.string(),
  effectiveFrom: z.string(),
  /** Planned retirement. Management only: the PUBLIC view always returns null (a closed period would disclose an unannounced retirement). */
  effectiveTo: z.string().nullable(),
  /** management only */
  status: GeoStatus.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type MarketDto = z.infer<typeof MarketDto>;

/** Everything a consumer needs to render or price for a market, resolved from data with no code fallback. */
export const MarketDefaultsDto = z.object({
  market: z.object({ code: z.string(), name: z.string(), countryCode: z.string() }),
  country: z.object({ code: z.string(), dialingCode: z.string() }),
  currency: z.object({ code: z.string(), minorUnitDigits: z.number().int(), symbol: z.string().nullable() }),
  locale: z.string(),
  supportedLocales: z.array(z.string()),
  timeZone: z.string(),
  distanceUnit: DistanceUnit,
  firstDayOfWeek: Weekday,
  dateFormat: DateFormatCode,
  timeFormat: TimeFormatCode,
  effectiveFrom: z.string(),
  /** Planned retirement. Management only: null in the public view (see MarketDto). */
  effectiveTo: z.string().nullable(),
});
export type MarketDefaultsDto = z.infer<typeof MarketDefaultsDto>;

/** Result of the extensible readiness checks that gate market activation (management only). */
export const ReadinessCheckResult = z.object({ code: z.string(), passed: z.boolean(), detail: z.string() });
export const MarketReadinessDto = z.object({ market: z.string(), ready: z.boolean(), checks: z.array(ReadinessCheckResult) });
export type MarketReadinessDto = z.infer<typeof MarketReadinessDto>;

// ---------------------------------------------------------------- management requests
const reason = adminText(1000);
const marketName = adminText(120);
const locales = z.array(Locale).min(1).max(30);
const zones = z.array(IanaTimeZone).min(1).max(40);
const contentKey = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/);

/** Creates the country as PLANNED. Activation is a separate step (the links must exist first). */
export const CreateCountryRequest = z
  .object({
    code: CountryCode,
    alpha3: CountryAlpha3,
    numeric: CountryNumeric,
    displayNameContentKey: contentKey,
    dialingCode: DialingCode,
    defaultCurrencyCode: CurrencyCode,
    defaultLocale: Locale,
    supportedLocales: locales,
    timeZones: zones,
    distanceUnit: DistanceUnit,
    firstDayOfWeek: Weekday,
    dateFormat: DateFormatCode,
    timeFormat: TimeFormatCode,
    reason,
  })
  .strict();
export type CreateCountryRequest = z.infer<typeof CreateCountryRequest>;

/** Changes the provided fields only (ISO codes are identity and cannot change). Set fields replace the existing set. */
export const UpdateCountryRequest = z
  .object({
    displayNameContentKey: contentKey.optional(),
    dialingCode: DialingCode.optional(),
    defaultCurrencyCode: CurrencyCode.optional(),
    defaultLocale: Locale.optional(),
    supportedLocales: locales.optional(),
    timeZones: zones.optional(),
    distanceUnit: DistanceUnit.optional(),
    firstDayOfWeek: Weekday.optional(),
    dateFormat: DateFormatCode.optional(),
    timeFormat: TimeFormatCode.optional(),
    reason,
  })
  .strict();
export type UpdateCountryRequest = z.infer<typeof UpdateCountryRequest>;

export const GeoActivationRequest = z.object({ active: z.boolean(), reason }).strict();
export type GeoActivationRequest = z.infer<typeof GeoActivationRequest>;

/** Creates the market as PLANNED. */
export const CreateMarketRequest = z
  .object({
    code: MarketCode,
    name: marketName,
    countryCode: CountryCode,
    defaultLocale: Locale,
    /** Defaults to [defaultLocale]. Every locale must be supported by the country. */
    supportedLocales: locales.optional(),
    currencyCode: CurrencyCode,
    defaultTimeZone: IanaTimeZone,
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveTo: z.string().datetime({ offset: true }).nullish(),
    reason,
  })
  .strict();
export type CreateMarketRequest = z.infer<typeof CreateMarketRequest>;

export const UpdateMarketRequest = z
  .object({
    name: marketName.optional(),
    defaultLocale: Locale.optional(),
    supportedLocales: locales.optional(),
    currencyCode: CurrencyCode.optional(),
    defaultTimeZone: IanaTimeZone.optional(),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveTo: z.string().datetime({ offset: true }).nullable().optional(),
    reason,
  })
  .strict();
export type UpdateMarketRequest = z.infer<typeof UpdateMarketRequest>;

// ---------------------------------------------------------------- responses
export const CountryResponse = envelope(CountryDto);
export const CountryListResponse = envelope(z.array(CountryDto));
export const MarketResponse = envelope(MarketDto);
export const MarketListResponse = envelope(z.array(MarketDto));
export const MarketDefaultsResponse = envelope(MarketDefaultsDto);
export const MarketReadinessResponse = envelope(MarketReadinessDto);
export const CurrencyListResponse = envelope(z.array(CurrencyDto));
export const TimeZoneListResponse = envelope(z.array(TimeZoneDto));

// ---------------------------------------------------------------- events (published through the transactional outbox)
export const GEOGRAPHY_EVENTS = {
  countryActivated: 'bananagig.geography.country-activated.v1',
  countryDeactivated: 'bananagig.geography.country-deactivated.v1',
  marketCreated: 'bananagig.geography.market-created.v1',
  marketActivated: 'bananagig.geography.market-activated.v1',
  marketDeactivated: 'bananagig.geography.market-deactivated.v1',
  marketDefaultsChanged: 'bananagig.geography.market-defaults-changed.v1',
  addressFormatPublished: 'bananagig.geography.address-format-published.v1',
  administrativeAreasUpdated: 'bananagig.geography.administrative-areas-updated.v1',
} as const;
/** Identifiers only. */
export const CountryEventPayload = z.object({ countryCode: z.string() });
export type CountryEventPayload = z.infer<typeof CountryEventPayload>;
export const MarketEventPayload = z.object({
  marketCode: z.string(),
  countryCode: z.string(),
  /** For market-defaults-changed: the NAMES of the changed fields (never values), and the reason the defaults changed. */
  changedFields: z.array(z.string()).optional(),
  cause: z.enum(['MARKET', 'COUNTRY']).optional(),
});
export type MarketEventPayload = z.infer<typeof MarketEventPayload>;

/** Typed geography error codes (mapped to the standard API error model by the API layer). */
export const GEOGRAPHY_ERROR_CODES = [
  'COUNTRY_NOT_FOUND',
  'ADDRESS_FORMAT_NOT_FOUND',
  'MARKET_NOT_FOUND',
  'CURRENCY_NOT_FOUND',
  'TIME_ZONE_NOT_FOUND',
  'LOCALE_NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'INVALID_STATE',
  'NOT_READY',
  'UNAVAILABLE',
] as const;
export type GeographyErrorCode = (typeof GEOGRAPHY_ERROR_CODES)[number];
