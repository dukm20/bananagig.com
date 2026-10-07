import type { CountryDto, CurrencyDto, MarketDefaultsDto, MarketDto, MarketReadinessDto, TimeZoneDto } from '@bananagig/contracts';
import { GeographyError } from '@bananagig/geography';
import { AppError } from '../../errors';

// Every mapper builds the response field by field. The service already shapes its public view, but the API never relies on that alone: the
// management-only fields (status, timestamps) are added only when the route authorized the management view, and audit or actor fields and
// readiness internals have no mapping at all, so they cannot leak by accident.

export const currencyDto = (c: CurrencyDto, management: boolean): CurrencyDto => ({
  code: c.code,
  numericCode: c.numericCode,
  minorUnitDigits: c.minorUnitDigits,
  displayName: c.displayName,
  symbol: c.symbol,
  ...(management && c.status !== undefined ? { status: c.status } : {}),
});

export const timeZoneDto = (t: TimeZoneDto, management: boolean): TimeZoneDto => ({
  ianaName: t.ianaName,
  ...(management && t.status !== undefined ? { status: t.status } : {}),
});

export const countryDto = (c: CountryDto, management: boolean): CountryDto => ({
  code: c.code,
  alpha3: c.alpha3,
  numeric: c.numeric,
  displayNameContentKey: c.displayNameContentKey,
  dialingCode: c.dialingCode,
  defaultCurrencyCode: c.defaultCurrencyCode,
  defaultLocale: c.defaultLocale,
  supportedLocales: [...c.supportedLocales],
  timeZones: [...c.timeZones],
  distanceUnit: c.distanceUnit,
  firstDayOfWeek: c.firstDayOfWeek,
  dateFormat: c.dateFormat,
  timeFormat: c.timeFormat,
  ...(management
    ? {
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
      }
    : {}),
});

export const marketDto = (m: MarketDto, management: boolean): MarketDto => ({
  code: m.code,
  name: m.name,
  countryCode: m.countryCode,
  defaultLocale: m.defaultLocale,
  supportedLocales: [...m.supportedLocales],
  currencyCode: m.currencyCode,
  defaultTimeZone: m.defaultTimeZone,
  effectiveFrom: m.effectiveFrom,
  // A planned retirement is management information: the public view never discloses it (always null), exactly like content versions.
  effectiveTo: management ? m.effectiveTo : null,
  ...(management
    ? {
        ...(m.status !== undefined ? { status: m.status } : {}),
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
        ...(m.updatedAt !== undefined ? { updatedAt: m.updatedAt } : {}),
      }
    : {}),
});

/** `management` is true only for callers that may also read PLANNED/INACTIVE markets (geography-read); everyone else gets effectiveTo null. */
export const marketDefaultsDto = (d: MarketDefaultsDto, management: boolean): MarketDefaultsDto => ({
  market: { code: d.market.code, name: d.market.name, countryCode: d.market.countryCode },
  country: { code: d.country.code, dialingCode: d.country.dialingCode },
  currency: { code: d.currency.code, minorUnitDigits: d.currency.minorUnitDigits, symbol: d.currency.symbol },
  locale: d.locale,
  supportedLocales: [...d.supportedLocales],
  timeZone: d.timeZone,
  distanceUnit: d.distanceUnit,
  firstDayOfWeek: d.firstDayOfWeek,
  dateFormat: d.dateFormat,
  timeFormat: d.timeFormat,
  effectiveFrom: d.effectiveFrom,
  effectiveTo: management ? d.effectiveTo : null,
});

/** Management only (geography-read). */
export const readinessDto = (r: MarketReadinessDto): MarketReadinessDto => ({
  market: r.market,
  ready: r.ready,
  checks: r.checks.map((c) => ({ code: c.code, passed: c.passed, detail: c.detail })),
});

/**
 * Maps typed geography failures onto the standard API error model. The AppError code is `GEOGRAPHY_<GeographyError code>`. GeographyError
 * details hold identifiers, field names and machine-readable reasons only; the constraint name and any driver cause are dropped here as well
 * (defense in depth), and database outages are reported generically.
 */
export function toAppError(err: unknown): never {
  if (!(err instanceof GeographyError)) throw err;
  const { cause: _cause, constraint: _constraint, ...details } = err.details;
  const code = `GEOGRAPHY_${err.code}`;
  switch (err.code) {
    case 'COUNTRY_NOT_FOUND':
    case 'MARKET_NOT_FOUND':
    case 'CURRENCY_NOT_FOUND':
    case 'TIME_ZONE_NOT_FOUND':
    case 'LOCALE_NOT_FOUND':
      throw new AppError('NOT_FOUND', code, err.message, details);
    case 'VALIDATION_FAILED':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'CONFLICT':
    case 'INVALID_STATE':
    case 'NOT_READY':
      throw new AppError('CONFLICT', code, err.message, details);
    case 'UNAVAILABLE':
      throw new AppError('DEPENDENCY', code, 'The geography registry is temporarily unavailable');
  }
}
