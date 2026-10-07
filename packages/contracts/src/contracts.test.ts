import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ERROR_CODES,
  CONTENT_EVENTS,
  CONTENT_OWNER_ROLES,
  CONTENT_SCOPE_TYPES,
  CONTENT_TYPES,
  ContentContext,
  ContentEventPayload,
  ContentKey,
  ContentSnapshotDto,
  CreateContentSnapshotRequest,
  CreateEntryRequest,
  CreateVersionRequest,
  ERROR_CATEGORIES,
  ERROR_STATUS,
  ErrorResponse,
  EVENT_TYPE_PATTERN,
  EventEnvelope,
  LegalDocumentPublishedPayload,
  LOCALE_PATTERN,
  Locale,
  MARKUP_CONTENT_TYPES,
  PUBLISHED_STATUSES,
  LocaleDto,
  RegisterLocaleRequest,
  ResolveContentRequest,
  ResolvedContentDto,
  ResolveManyContentRequest,
  SetActiveRequest,
  SystemInfoResponse,
  VariableDefinition,
  VariableName,
  VARIABLE_TYPES,
  canonicalizeLocale,
  isSafeCorrelationId,
  CountryAlpha3,
  CountryCode,
  CountryDto,
  CountryEventPayload,
  CountryNumeric,
  CreateCountryRequest,
  CreateMarketRequest,
  CurrencyCode,
  CurrencyDto,
  DATE_FORMAT_CODES,
  DISTANCE_UNITS,
  DateFormatCode,
  DialingCode,
  DistanceUnit,
  GEOGRAPHY_ERROR_CODES,
  GEOGRAPHY_EVENTS,
  GEO_STATUSES,
  GeoActivationRequest,
  GeoStatus,
  IanaTimeZone,
  MarketCode,
  MarketDefaultsDto,
  MarketDto,
  MarketEventPayload,
  MarketReadinessDto,
  TIME_FORMAT_CODES,
  TimeFormatCode,
  TimeZoneDto,
  UpdateCountryRequest,
  UpdateMarketRequest,
  WEEKDAYS,
  Weekday,
} from './index';

const event = () => ({
  eventId: randomUUID(),
  eventType: 'bananagig.infra.ping.v1',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'corr-12345678',
  causationId: null,
  actor: { type: 'system', id: null },
  aggregateType: 'infra',
  aggregateId: 'x',
  payload: {},
});

describe('contracts', () => {
  it('validates the event envelope and rejects malformed event types', () => {
    expect(EventEnvelope.safeParse(event()).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...event(), eventType: 'booking.created' }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...event(), eventId: 'nope' }).success).toBe(false);
  });
  it('validates error and system-info responses', () => {
    expect(ErrorResponse.safeParse({ error: { code: 'X', category: 'INTERNAL', message: 'm', correlationId: 'c' } }).success).toBe(true);
    expect(ErrorResponse.safeParse({ error: { code: 'X', category: 'BOGUS', message: 'm', correlationId: 'c' } }).success).toBe(false);
    const ok = { data: { service: 's', environment: 'test', version: '1', apiVersion: 'v1', serverTime: 't', uptimeSeconds: 1 }, meta: { correlationId: 'c' } };
    expect(SystemInfoResponse.safeParse(ok).success).toBe(true);
  });
  it('maps every error category to a status', () => {
    for (const c of ERROR_CATEGORIES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });
  it('accepts only safe correlation ids', () => {
    expect(isSafeCorrelationId('abc-12345678')).toBe(true);
    expect(isSafeCorrelationId('short')).toBe(false);
    expect(isSafeCorrelationId('has space and \n newline')).toBe(false);
  });
});

describe('content contracts', () => {
  describe('content keys', () => {
    it.each(['brand.name', 'common.action.sign_in', 'a.b', 'shell.home_page.title2', 'devtest.t1.x'])('accepts %s', (k) => {
      expect(ContentKey.safeParse(k).success).toBe(true);
    });
    it.each([
      '',
      'brand',
      'Brand.name',
      'brand..name',
      '.brand.name',
      'brand.name.',
      'brand.1name',
      '1brand.name',
      'brand.na-me',
      'brand name.x',
      'brand.name\n',
      'brand.nämé',
      `a.${'b'.repeat(160)}`,
    ])('rejects %j', (k) => {
      expect(ContentKey.safeParse(k).success).toBe(false);
    });
    it('allows exactly 160 characters', () => {
      expect(ContentKey.safeParse(`a.${'b'.repeat(158)}`).success).toBe(true);
    });
  });

  describe('locales', () => {
    it.each(['en', 'en-US', 'es-MX', 'es-419', 'zh-Hant', 'zh-Hant-TW', 'fil', 'ast-ES'])('accepts the canonical locale %s', (l) => {
      expect(LOCALE_PATTERN.test(l)).toBe(true);
      expect(Locale.safeParse(l).success).toBe(true);
      expect(canonicalizeLocale(l)).toBe(l);
    });
    it.each([
      '',
      'e',
      'english',
      'en_US',
      'EN-US',
      'en-us',
      'en-US-',
      '-en',
      'en--US',
      'en-US-POSIX',
      'zh-hant-TW',
      'en-US-x-private',
      'en US',
      'en-U',
      'en-USA',
      'e1-US',
    ])('rejects the non-canonical or unsupported locale %j', (l) => {
      expect(Locale.safeParse(l).success).toBe(false);
    });
    it.each([
      ['EN-us', 'en-US'],
      ['en-us', 'en-US'],
      ['ZH-hant-tw', 'zh-Hant-TW'],
      ['zh-HANT', 'zh-Hant'],
      ['ES-419', 'es-419'],
      ['en', 'en'],
    ])('canonicalizes %s to %s', (input, expected) => {
      expect(canonicalizeLocale(input)).toBe(expected);
      expect(Locale.safeParse(expected).success).toBe(true);
    });
    it.each(['en_US', '', 'e', 'en-', '-US', 'en-US-POSIX', 'en-US-x', 'en--US', 'en-U1', 'a-b-c-d', ' en-US', 'en-US ', 'en-US\n', 'en\u0000'])(
      'canonicalizeLocale returns null for %j (underscores, padding and control characters are rejected, not repaired)',
      (input) => {
        expect(canonicalizeLocale(input)).toBeNull();
      },
    );
    it('returns null for non-string input', () => {
      for (const v of [null, undefined, 5, {}, ['en-US']]) expect(canonicalizeLocale(v)).toBeNull();
    });
    it('bounds the locale length', () => {
      expect(Locale.safeParse('abc-Abcd-123').success).toBe(true);
      expect(Locale.safeParse(`${'a'.repeat(21)}`).success).toBe(false);
    });
  });

  describe('vocabularies', () => {
    it('keeps the closed sets used by the database CHECKs', () => {
      expect([...CONTENT_SCOPE_TYPES]).toEqual(['PLATFORM', 'COUNTRY', 'MARKET']);
      expect([...CONTENT_OWNER_ROLES]).toEqual(['CONTENT', 'LEGAL', 'SUPPORT', 'MARKETING']);
      expect([...PUBLISHED_STATUSES]).toEqual(['SCHEDULED', 'PUBLISHED', 'SUPERSEDED']);
      expect([...VARIABLE_TYPES].sort()).toEqual(['COUNT', 'DATE', 'DATETIME', 'MONEY', 'NUMBER', 'PERSON_DISPLAY_NAME', 'STRING', 'TIME', 'URL']);
    });
    it('lists markup types as a subset of the content types, and LEGAL is one of them', () => {
      for (const t of MARKUP_CONTENT_TYPES) expect(CONTENT_TYPES).toContain(t);
      expect(MARKUP_CONTENT_TYPES).toContain('LEGAL');
      expect(MARKUP_CONTENT_TYPES).not.toContain('UI_LABEL');
    });
    it('has a unique typed error code list', () => {
      expect(new Set(CONTENT_ERROR_CODES).size).toBe(CONTENT_ERROR_CODES.length);
      expect(CONTENT_ERROR_CODES).toContain('NO_CONTENT');
    });
  });

  describe('variables', () => {
    it('accepts snake_case variable names only', () => {
      for (const n of ['name', 'first_name', 'a1']) expect(VariableName.safeParse(n).success).toBe(true);
      for (const n of ['Name', '1a', 'first-name', '', 'a b', 'x'.repeat(61)]) expect(VariableName.safeParse(n).success).toBe(false);
    });
    it('defaults a variable to required with piiClass NONE', () => {
      expect(VariableDefinition.parse({ name: 'city', type: 'STRING', description: 'City', example: 'Austin' })).toMatchObject({
        required: true,
        piiClass: 'NONE',
      });
      expect(VariableDefinition.safeParse({ name: 'city', type: 'WIDGET', description: 'City', example: 'x' }).success).toBe(false);
      expect(VariableDefinition.safeParse({ name: 'city', type: 'STRING', description: '', example: 'x' }).success).toBe(false);
    });
  });

  describe('request schemas', () => {
    const entry = { key: 'brand.name', contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'd' };
    it('applies create-entry defaults', () => {
      expect(CreateEntryRequest.parse(entry)).toMatchObject({ sensitivity: 'PUBLIC', maxScopeType: 'PLATFORM', variables: [] });
      const parsed = CreateEntryRequest.parse(entry);
      expect(parsed.criticality).toBeUndefined(); // derived by the service from the content type
      expect(parsed.approvalPolicy).toBeUndefined();
      expect(parsed.fallbackPolicy).toBeUndefined();
    });
    it('validates create-entry', () => {
      expect(CreateEntryRequest.safeParse({ ...entry, contentType: 'VIDEO' }).success).toBe(false);
      expect(CreateEntryRequest.safeParse({ ...entry, ownerRole: 'ENGINEERING' }).success).toBe(false);
      expect(CreateEntryRequest.safeParse({ ...entry, sensitivity: 'SECRET' }).success).toBe(false);
      expect(CreateEntryRequest.safeParse({ ...entry, maxScopeType: 'GIG' }).success).toBe(false);
      expect(CreateEntryRequest.safeParse({ ...entry, key: 'Bad Key' }).success).toBe(false);
      expect(CreateEntryRequest.safeParse({ ...entry, description: '' }).success).toBe(false);
      expect(
        CreateEntryRequest.safeParse({
          ...entry,
          variables: Array.from({ length: 31 }, (_, i) => ({ name: `v${i}`, type: 'STRING', description: 'd', example: 'x' })),
        }).success,
      ).toBe(false);
    });
    it('applies create-version defaults and bounds', () => {
      const v = { locale: 'en-US', body: 'text', reason: 'r' };
      expect(CreateVersionRequest.parse(v).scopeType).toBe('PLATFORM');
      expect(CreateVersionRequest.safeParse({ ...v, body: '' }).success).toBe(false);
      expect(CreateVersionRequest.safeParse({ ...v, body: 'x'.repeat(200001) }).success).toBe(false);
      expect(CreateVersionRequest.safeParse({ ...v, body: 'x'.repeat(200000) }).success).toBe(true);
      expect(CreateVersionRequest.safeParse({ ...v, locale: 'en_US' }).success).toBe(false);
      expect(CreateVersionRequest.safeParse({ ...v, scopeType: 'MARKET', scopeRef: 'us-ca' }).success).toBe(true);
      expect(CreateVersionRequest.safeParse({ ...v, scopeType: 'MARKET', scopeRef: 'has space' }).success).toBe(false);
      expect(CreateVersionRequest.safeParse({ ...v, effectiveFrom: '2026-06-01T00:00:00Z' }).success).toBe(true);
      expect(CreateVersionRequest.safeParse({ ...v, effectiveFrom: '2026-06-01T00:00:00+02:00', effectiveTo: null }).success).toBe(true);
      expect(CreateVersionRequest.safeParse({ ...v, effectiveFrom: '2026-06-01' }).success).toBe(false);
      expect(CreateVersionRequest.safeParse({ ...v, effectiveFrom: '2026-06-01T00:00:00' }).success).toBe(false); // an instant needs an offset
      expect(CreateVersionRequest.safeParse({ ...v, reason: '' }).success).toBe(false);
    });
    it('accepts an optional display name when registering a locale and rejects blank or oversized ones', () => {
      expect(RegisterLocaleRequest.parse({ locale: 'es-US', reason: 'r' }).displayName).toBeUndefined();
      expect(RegisterLocaleRequest.parse({ locale: 'es-US', reason: 'r', displayName: '  Spanish (US)  ' }).displayName).toBe('Spanish (US)');
      expect(RegisterLocaleRequest.safeParse({ locale: 'es-US', reason: 'r', displayName: '   ' }).success).toBe(false);
      expect(RegisterLocaleRequest.safeParse({ locale: 'es-US', reason: 'r', displayName: '' }).success).toBe(false);
      expect(RegisterLocaleRequest.safeParse({ locale: 'es-US', reason: 'r', displayName: 'x'.repeat(101) }).success).toBe(false);
      expect(RegisterLocaleRequest.safeParse({ locale: 'es-US', reason: 'r', displayName: 5 }).success).toBe(false);
      for (const displayName of ['Name\u0000Tail', 'line\nbreak', 'abc\u202Edef', 'abc\u2067def', 'abc\uD800', 'abc\uDC00', '\u00A0\u200B']) {
        expect(RegisterLocaleRequest.safeParse({ locale: 'es-US', reason: 'r', displayName }).success).toBe(false);
      }
    });
    it('LocaleDto carries the display name and the derived language, script and region', () => {
      const full = {
        locale: 'zh-Hant-TW',
        displayName: 'Chinese (Traditional, Taiwan)',
        language: 'zh',
        script: 'Hant',
        region: 'TW',
        isActive: false,
        isPlatformDefault: false,
      };
      expect(LocaleDto.parse(full)).toEqual(full);
      expect(LocaleDto.parse({ ...full, locale: 'fil', language: 'fil', script: null, region: null }).script).toBeNull();
      for (const missing of ['displayName', 'language', 'script', 'region'] as const) {
        const { [missing]: _omitted, ...rest } = full;
        expect(LocaleDto.safeParse(rest).success).toBe(false);
      }
    });
    it('registers locales inactive by default and requires a reason', () => {
      expect(RegisterLocaleRequest.parse({ locale: 'es-US', reason: 'r' }).active).toBe(false);
      expect(RegisterLocaleRequest.safeParse({ locale: 'es-US' }).success).toBe(false);
      expect(SetActiveRequest.safeParse({ active: true, reason: 'r' }).success).toBe(true);
      expect(SetActiveRequest.safeParse({ active: 'true', reason: 'r' }).success).toBe(false);
      expect(SetActiveRequest.safeParse({ active: true }).success).toBe(false);
    });
    it('defaults the resolution context to empty and rejects unknown context fields', () => {
      expect(ResolveContentRequest.parse({ key: 'a.b', locale: 'en-US' }).context).toEqual({});
      expect(ResolveManyContentRequest.parse({ keys: ['a.b'], locale: 'en-US' }).context).toEqual({});
      expect(ContentContext.safeParse({ country: 'US', market: 'us-ca', marketDefaultLocale: 'es-US' }).success).toBe(true);
      expect(ContentContext.safeParse({ galaxy: 'x' }).success).toBe(false);
      expect(ContentContext.safeParse({ marketDefaultLocale: 'es_US' }).success).toBe(false);
      expect(ContentContext.safeParse({ market: '' }).success).toBe(false);
    });
    it('validates resolve requests', () => {
      expect(ResolveContentRequest.safeParse({ key: 'a.b', locale: 'en-US', at: '2026-01-01T00:00:00Z', includeTemplate: true }).success).toBe(true);
      expect(ResolveContentRequest.safeParse({ key: 'a.b', locale: 'en-US', at: 'yesterday' }).success).toBe(false);
      expect(ResolveContentRequest.safeParse({ key: 'a', locale: 'en-US' }).success).toBe(false);
      expect(ResolveContentRequest.safeParse({ key: 'a.b', locale: 'en-US', variables: { Bad: 1 } }).success).toBe(false);
      expect(
        ResolveContentRequest.safeParse({
          key: 'a.b',
          locale: 'en-US',
          variables: { count: 3, price: { amount_minor: 1999, currency: 'USD' } },
          timeZone: 'America/Chicago',
        }).success,
      ).toBe(true);
      expect(ResolveManyContentRequest.safeParse({ keys: [], locale: 'en-US' }).success).toBe(false);
      expect(ResolveManyContentRequest.safeParse({ keys: Array.from({ length: 100 }, (_, i) => `a.k${i}`), locale: 'en-US' }).success).toBe(true);
      expect(ResolveManyContentRequest.safeParse({ keys: Array.from({ length: 101 }, (_, i) => `a.k${i}`), locale: 'en-US' }).success).toBe(false);
      expect(ResolveManyContentRequest.safeParse({ keys: ['a.b'], locale: 'en-US', variables: { 'a.b': { x: 'y' }, 'Bad Key': {} } }).success).toBe(false);
    });
    it('validates snapshot requests', () => {
      expect(CreateContentSnapshotRequest.parse({ keys: ['a.b'], locale: 'en-US', purpose: 'consent' }).context).toEqual({});
      expect(CreateContentSnapshotRequest.safeParse({ keys: ['a.b'], locale: 'en-US' }).success).toBe(false);
      expect(CreateContentSnapshotRequest.safeParse({ keys: ['a.b'], locale: 'en-US', purpose: 'x'.repeat(201) }).success).toBe(false);
    });
  });

  describe('response shapes', () => {
    const resolvedItem = {
      key: 'a.b',
      contentType: 'UI_LABEL',
      requestedLocale: 'en-US',
      resolvedLocale: 'en-US',
      fallback: { applied: false, chain: ['en-US'] },
      version: 1,
      versionId: 'v',
      sourceScope: 'PLATFORM',
      scopeRef: null,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      bodySha256: 'a'.repeat(64),
      format: 'text',
      value: 'x',
    };
    it('keeps effectiveTo (nullable) on the resolved DTO (the API returns null to callers without content-read)', () => {
      expect(ResolvedContentDto.safeParse(resolvedItem).success).toBe(true);
      expect(ResolvedContentDto.safeParse({ ...resolvedItem, effectiveTo: '2026-02-01T00:00:00.000Z' }).success).toBe(true);
    });
    it('has no effectiveTo on snapshot items: it changes when a successor is published, so a read-back would not be byte-stable', () => {
      const item = ContentSnapshotDto.shape.items.element;
      expect(Object.keys(item.shape)).not.toContain('effectiveTo');
      expect(Object.keys(item.shape)).toEqual(
        expect.arrayContaining(['effectiveFrom', 'version', 'versionId', 'bodySha256', 'body', 'sourceScope', 'resolvedLocale']),
      );
    });
  });

  describe('events', () => {
    const payload = {
      versionId: '6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111',
      entryKey: 'legal.terms',
      locale: 'en-US',
      scopeType: 'PLATFORM',
      scopeRef: null,
      version: 3,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    };
    it('names the four events in the bananagig.<domain>.<event>.v<n> convention', () => {
      expect(Object.values(CONTENT_EVENTS)).toHaveLength(4);
      for (const t of Object.values(CONTENT_EVENTS)) {
        expect(EVENT_TYPE_PATTERN.test(t), t).toBe(true);
        expect(t.startsWith('bananagig.content.')).toBe(true);
      }
      expect(CONTENT_EVENTS).toMatchObject({
        versionApproved: 'bananagig.content.version-approved.v1',
        versionScheduled: 'bananagig.content.version-scheduled.v1',
        versionPublished: 'bananagig.content.version-published.v1',
        legalDocumentPublished: 'bananagig.content.legal-document-published.v1',
      });
    });
    it('accepts identifier-only payloads, with an optional previous version', () => {
      expect(ContentEventPayload.safeParse(payload).success).toBe(true);
      expect(ContentEventPayload.safeParse({ ...payload, previousVersionId: null }).success).toBe(true);
      expect(ContentEventPayload.safeParse({ ...payload, previousVersionId: 'abc' }).success).toBe(true);
      expect(ContentEventPayload.safeParse({ ...payload, scopeType: 'WORLD' }).success).toBe(false);
      expect(ContentEventPayload.safeParse({ ...payload, version: 1.5 }).success).toBe(false);
      expect(ContentEventPayload.safeParse({ versionId: payload.versionId }).success).toBe(false);
    });
    it('has no field that could carry copy text', () => {
      const fields = Object.keys(ContentEventPayload.shape);
      for (const forbidden of ['body', 'text', 'value', 'template', 'content', 'comment', 'reason']) expect(fields).not.toContain(forbidden);
    });
    it('requires the checksum on legal-document-published', () => {
      expect(LegalDocumentPublishedPayload.safeParse(payload).success).toBe(false);
      expect(LegalDocumentPublishedPayload.safeParse({ ...payload, bodySha256: 'a'.repeat(64) }).success).toBe(true);
    });
    it('fits inside the event envelope', () => {
      const env = {
        eventId: randomUUID(),
        eventType: CONTENT_EVENTS.versionPublished,
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-12345678',
        causationId: null,
        actor: { type: 'user', id: 'admin-a' },
        aggregateType: 'content_version',
        aggregateId: payload.versionId,
        payload,
      };
      expect(EventEnvelope.safeParse(env).success).toBe(true);
    });
  });
});

describe('geography contracts', () => {
  const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

  describe('codes', () => {
    it('accepts upper-case ISO 3166-1 alpha-2 country codes only (the canonical COUNTRY scope reference)', () => {
      for (const good of ['US', 'ZZ', 'CA']) expect(ok(CountryCode, good)).toBe(true);
      for (const bad of ['us', 'Us', 'USA', 'U', '', 'U1', '1U', ' US', 'US ', 'U-', 'ÜS']) expect(ok(CountryCode, bad), bad).toBe(false);
    });
    it('validates alpha-3, numeric, currency and dialing codes', () => {
      expect(ok(CountryAlpha3, 'USA')).toBe(true);
      for (const bad of ['us', 'USAA', 'US', 'U1A']) expect(ok(CountryAlpha3, bad), bad).toBe(false);
      expect(ok(CountryNumeric, '840')).toBe(true);
      for (const bad of ['84', '8400', 'abc', '08 ']) expect(ok(CountryNumeric, bad), bad).toBe(false);
      expect(ok(CurrencyCode, 'USD')).toBe(true);
      for (const bad of ['usd', 'US', 'USDD', 'U$D']) expect(ok(CurrencyCode, bad), bad).toBe(false);
      for (const good of ['+1', '+44', '+1684', '+999']) expect(ok(DialingCode, good), good).toBe(true);
      for (const bad of ['1', '+', '+12345', '+1a', '001', '+ 1']) expect(ok(DialingCode, bad), bad).toBe(false);
    });
    it('accepts lower-case kebab market codes of at most 60 characters (the canonical MARKET scope reference)', () => {
      for (const good of ['la-oc', 'us-sf', 'devtest-m1', 'a', 'a1', 'new-york-city', 'x'.repeat(60)]) expect(ok(MarketCode, good), good).toBe(true);
      for (const bad of ['LA-OC', 'La-Oc', 'la_oc', '-la', 'la-', 'la--oc', '1la', '', 'la oc', 'la.oc', 'x'.repeat(61)])
        expect(ok(MarketCode, bad), bad).toBe(false);
    });
    it('accepts IANA time zone identifiers and rejects offsets and malformed names (existence in the tz database is checked by the service and the database)', () => {
      for (const good of ['America/Los_Angeles', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+5', 'Asia/Tokyo'])
        expect(ok(IanaTimeZone, good), good).toBe(true);
      for (const bad of ['', '+05:00', '/UTC', 'America//Denver', 'America/', 'Los Angeles', '1/2', 'a'.repeat(65)])
        expect(ok(IanaTimeZone, bad), bad).toBe(false);
    });
  });

  describe('enumerations', () => {
    it('exposes the normalized vocabularies', () => {
      expect([...GEO_STATUSES]).toEqual(['PLANNED', 'ACTIVE', 'INACTIVE']);
      expect([...DISTANCE_UNITS]).toEqual(['MILES', 'KILOMETERS']);
      expect([...WEEKDAYS]).toEqual(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);
      expect([...DATE_FORMAT_CODES]).toEqual(['MDY', 'DMY', 'YMD']);
      expect([...TIME_FORMAT_CODES]).toEqual(['12_HOUR', '24_HOUR']);
    });
    it('rejects anything outside them (case sensitive)', () => {
      for (const [schema, good, bad] of [
        [GeoStatus, 'ACTIVE', 'active'],
        [DistanceUnit, 'MILES', 'miles'],
        [DistanceUnit, 'KILOMETERS', 'KM'],
        [Weekday, 'SUNDAY', 'Sunday'],
        [DateFormatCode, 'YMD', 'ISO'],
        [TimeFormatCode, '24_HOUR', '24'],
      ] as const) {
        expect(ok(schema, good)).toBe(true);
        expect(ok(schema, bad), String(bad)).toBe(false);
      }
    });
  });

  describe('requests', () => {
    const country = {
      code: 'ZZ',
      alpha3: 'ZZZ',
      numeric: '999',
      displayNameContentKey: 'geography.country.zz.name',
      dialingCode: '+999',
      defaultCurrencyCode: 'USD',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      timeZones: ['America/Denver'],
      distanceUnit: 'MILES',
      firstDayOfWeek: 'SUNDAY',
      dateFormat: 'MDY',
      timeFormat: '12_HOUR',
      reason: 'new market',
    };
    const market = {
      code: 'la-oc',
      name: 'LA & OC',
      countryCode: 'US',
      defaultLocale: 'en-US',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'launch',
    };

    it('CreateCountryRequest is strict and validates every field', () => {
      expect(ok(CreateCountryRequest, country)).toBe(true);
      expect(ok(CreateCountryRequest, { ...country, extra: 1 })).toBe(false);
      expect(ok(CreateCountryRequest, { ...country, status: 'ACTIVE' })).toBe(false);
      for (const key of Object.keys(country)) {
        const { [key]: _omitted, ...rest } = country as Record<string, unknown>;
        expect(ok(CreateCountryRequest, rest), `missing ${key}`).toBe(false);
      }
      for (const bad of [
        { code: 'zz' },
        { alpha3: 'ZZ' },
        { numeric: '99' },
        { displayNameContentKey: 'Not A Key' },
        { dialingCode: '999' },
        { defaultCurrencyCode: 'usd' },
        { defaultLocale: 'en_US' },
        { supportedLocales: [] },
        { supportedLocales: ['en_US'] },
        { timeZones: [] },
        { timeZones: ['+05:00'] },
        { distanceUnit: 'FURLONGS' },
        { firstDayOfWeek: 'Monday' },
        { dateFormat: 'DD/MM' },
        { timeFormat: '36_HOUR' },
        { reason: '' },
        { reason: 'x'.repeat(1001) },
      ])
        expect(ok(CreateCountryRequest, { ...country, ...bad }), JSON.stringify(bad)).toBe(false);
    });

    it('UpdateCountryRequest changes the provided fields only: ISO codes are identity, unknown fields and a missing reason are rejected', () => {
      expect(ok(UpdateCountryRequest, { dialingCode: '+1', reason: 'r' })).toBe(true);
      expect(ok(UpdateCountryRequest, { reason: 'r' })).toBe(true);
      for (const bad of [
        { dialingCode: '+1' },
        { code: 'US', reason: 'r' },
        { alpha3: 'USA', reason: 'r' },
        { numeric: '840', reason: 'r' },
        { status: 'ACTIVE', reason: 'r' },
        { distanceUnit: 'MI', reason: 'r' },
      ])
        expect(ok(UpdateCountryRequest, bad), JSON.stringify(bad)).toBe(false);
    });

    it('CreateMarketRequest is strict; supportedLocales and the effective window are optional; dates need an offset', () => {
      expect(ok(CreateMarketRequest, market)).toBe(true);
      expect(
        ok(CreateMarketRequest, {
          ...market,
          supportedLocales: ['en-US', 'es-US'],
          effectiveFrom: '2026-01-01T00:00:00Z',
          effectiveTo: '2027-01-01T00:00:00+01:00',
        }),
      ).toBe(true);
      expect(ok(CreateMarketRequest, { ...market, effectiveTo: null })).toBe(true);
      for (const bad of [
        { extra: 1 },
        { status: 'ACTIVE' },
        { code: 'LA-OC' },
        { code: 'la_oc' },
        { name: '' },
        { name: 'x'.repeat(121) },
        { countryCode: 'us' },
        { currencyCode: 'usd' },
        { defaultTimeZone: '+05:00' },
        { effectiveFrom: 'yesterday' },
        { effectiveFrom: '2026-01-01T00:00:00' },
        { effectiveTo: '2026-13-01T00:00:00Z' },
        { supportedLocales: [] },
        { reason: '' },
      ])
        expect(ok(CreateMarketRequest, { ...market, ...bad }), JSON.stringify(bad)).toBe(false);
      for (const key of ['code', 'name', 'countryCode', 'defaultLocale', 'currencyCode', 'defaultTimeZone', 'reason']) {
        const { [key]: _omitted, ...rest } = market as Record<string, unknown>;
        expect(ok(CreateMarketRequest, rest), `missing ${key}`).toBe(false);
      }
    });

    it('UpdateMarketRequest: code and country are identity; effectiveTo may be cleared with null', () => {
      expect(ok(UpdateMarketRequest, { name: 'New', reason: 'r' })).toBe(true);
      expect(ok(UpdateMarketRequest, { effectiveTo: null, reason: 'r' })).toBe(true);
      for (const bad of [
        { name: 'New' },
        { code: 'x', reason: 'r' },
        { countryCode: 'US', reason: 'r' },
        { status: 'ACTIVE', reason: 'r' },
        { effectiveFrom: null, reason: 'r' },
        { name: '', reason: 'r' },
      ])
        expect(ok(UpdateMarketRequest, bad), JSON.stringify(bad)).toBe(false);
    });

    it('GeoActivationRequest needs a boolean and a reason and nothing else', () => {
      expect(ok(GeoActivationRequest, { active: true, reason: 'r' })).toBe(true);
      expect(ok(GeoActivationRequest, { active: false, reason: 'r' })).toBe(true);
      for (const bad of [
        { active: true },
        { reason: 'r' },
        { active: 'true', reason: 'r' },
        { active: true, reason: '' },
        { active: true, reason: 'r', extra: 1 },
      ])
        expect(ok(GeoActivationRequest, bad), JSON.stringify(bad)).toBe(false);
    });

    describe('administrator free text (market name and every reason)', () => {
      // Each case is built from escapes so the test file itself contains no invisible characters.
      const rejected: [string, string][] = [
        ['NUL', 'before\u0000after'],
        ['newline', 'line one\nline two'],
        ['carriage return', 'a\rb'],
        ['tab', 'a\tb'],
        ['escape', 'a\u001Bb'],
        ['DEL', 'a\u007Fb'],
        ['C1 NEL', 'a\u0085b'],
        ['C1 upper bound', 'a\u009Fb'],
        ['bidi override RLO', 'abc\u202Edef'],
        ['bidi embedding LRE', 'abc\u202Adef'],
        ['bidi isolate LRI', 'abc\u2066def'],
        ['bidi isolate PDI', 'abc\u2069def'],
        ['lone high surrogate', 'abc\uD800def'],
        ['lone low surrogate', 'abc\uDC00def'],
        ['high surrogate at the end', 'abc\uD83D'],
        ['blank', '   '],
        ['NBSP only', '\u00A0\u00A0'],
        ['mixed whitespace only', ' \u00A0\u2003\u3000 '],
        ['zero-width space only', '\u200B'],
        ['byte order mark only', '\uFEFF'],
      ];
      const accepted: [string, string][] = [
        ['plain', 'LA & OC'],
        ['accented', 'São Paulo'],
        ['German', 'Zürich Altstadt'],
        ['CJK', '東京'],
        ['Arabic with LRM', '\u0645\u0635\u0631\u200E'],
        ['emoji (a valid surrogate pair)', 'Beach \uD83C\uDFD6\uFE0F'],
        ['inner punctuation and spaces', "Winston-Salem, N.C. (O'Brien's)"],
        ['one visible character among blanks', ' \u00A0x\u00A0 '],
      ];
      const fields: [string, (v: string) => unknown, { safeParse(v: unknown): { success: boolean } }][] = [
        ['CreateMarketRequest.name', (v) => ({ ...market, name: v }), CreateMarketRequest],
        ['CreateMarketRequest.reason', (v) => ({ ...market, reason: v }), CreateMarketRequest],
        ['UpdateMarketRequest.name', (v) => ({ name: v, reason: 'r' }), UpdateMarketRequest],
        ['UpdateMarketRequest.reason', (v) => ({ name: 'New', reason: v }), UpdateMarketRequest],
        ['CreateCountryRequest.reason', (v) => ({ ...country, reason: v }), CreateCountryRequest],
        ['UpdateCountryRequest.reason', (v) => ({ dialingCode: '+1', reason: v }), UpdateCountryRequest],
        ['GeoActivationRequest.reason', (v) => ({ active: true, reason: v }), GeoActivationRequest],
      ];
      it.each(fields)('%s rejects control, bidirectional, surrogate and blank values', (_name, build, schema) => {
        for (const [label, value] of rejected) expect(ok(schema, build(value)), label).toBe(false);
      });
      it.each(fields)('%s still accepts ordinary text in any script', (_name, build, schema) => {
        for (const [label, value] of accepted) expect(ok(schema, build(value)), label).toBe(true);
      });
      it('keeps the length limits (1 to 120 for the name, 1 to 1000 for a reason)', () => {
        expect(ok(CreateMarketRequest, { ...market, name: 'x'.repeat(120) })).toBe(true);
        expect(ok(CreateMarketRequest, { ...market, name: 'x'.repeat(121) })).toBe(false);
        expect(ok(GeoActivationRequest, { active: true, reason: 'x'.repeat(1000) })).toBe(true);
        expect(ok(GeoActivationRequest, { active: true, reason: 'x'.repeat(1001) })).toBe(false);
        expect(ok(GeoActivationRequest, { active: true, reason: '' })).toBe(false);
      });
      it('reports a message that never echoes the rejected value', () => {
        const r = CreateMarketRequest.safeParse({ ...market, name: 'SECRET-SENTINEL\u0000' });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).not.toContain('SECRET-SENTINEL');
      });
    });
  });

  describe('read models', () => {
    it('keep the management-only fields optional so the public view is a valid subset', () => {
      const publicCountry = {
        code: 'US',
        alpha3: 'USA',
        numeric: '840',
        displayNameContentKey: 'geography.country.us.name',
        dialingCode: '+1',
        defaultCurrencyCode: 'USD',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
        timeZones: ['America/Denver'],
        distanceUnit: 'MILES',
        firstDayOfWeek: 'SUNDAY',
        dateFormat: 'MDY',
        timeFormat: '12_HOUR',
      };
      expect(ok(CountryDto, publicCountry)).toBe(true);
      expect(ok(CountryDto, { ...publicCountry, status: 'ACTIVE', createdAt: 'x', updatedAt: 'y' })).toBe(true);
      expect(ok(CountryDto, { ...publicCountry, status: 'DELETED' })).toBe(false);
      expect(ok(CountryDto, { ...publicCountry, distanceUnit: 'FEET' })).toBe(false);
      const publicMarket = {
        code: 'la-oc',
        name: 'LA & OC',
        countryCode: 'US',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
        currencyCode: 'USD',
        defaultTimeZone: 'America/Los_Angeles',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      };
      expect(ok(MarketDto, publicMarket)).toBe(true);
      expect(ok(MarketDto, { ...publicMarket, status: 'PLANNED' })).toBe(true);
      expect(ok(MarketDto, { ...publicMarket, effectiveTo: undefined })).toBe(false); // null, not absent
      expect(ok(CurrencyDto, { code: 'USD', numericCode: '840', minorUnitDigits: 2, displayName: 'US Dollar', symbol: '$' })).toBe(true);
      expect(ok(CurrencyDto, { code: 'XTS', numericCode: '963', minorUnitDigits: 2, displayName: 'Test', symbol: null })).toBe(true);
      expect(ok(CurrencyDto, { code: 'USD', numericCode: '840', minorUnitDigits: 5, displayName: 'x', symbol: null })).toBe(false); // 0 to 4 digits
      expect(ok(CurrencyDto, { code: 'USD', numericCode: '840', minorUnitDigits: -1, displayName: 'x', symbol: null })).toBe(false);
      expect(ok(TimeZoneDto, { ianaName: 'America/Denver' })).toBe(true);
    });
    it('market defaults and readiness have fixed shapes', () => {
      const defaults = {
        market: { code: 'la-oc', name: 'LA & OC', countryCode: 'US' },
        country: { code: 'US', dialingCode: '+1' },
        currency: { code: 'USD', minorUnitDigits: 2, symbol: '$' },
        locale: 'en-US',
        supportedLocales: ['en-US'],
        timeZone: 'America/Los_Angeles',
        distanceUnit: 'MILES',
        firstDayOfWeek: 'SUNDAY',
        dateFormat: 'MDY',
        timeFormat: '12_HOUR',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      };
      expect(ok(MarketDefaultsDto, defaults)).toBe(true);
      expect(ok(MarketDefaultsDto, { ...defaults, timeFormat: 'AM_PM' })).toBe(false);
      expect(
        ok(MarketReadinessDto, { market: 'la-oc', ready: false, checks: [{ code: 'COUNTRY_ACTIVE', passed: false, detail: 'country US is PLANNED' }] }),
      ).toBe(true);
      expect(ok(MarketReadinessDto, { market: 'la-oc', ready: true, checks: [{ code: 'X', passed: 'yes', detail: 'd' }] })).toBe(false);
    });
  });

  describe('events', () => {
    it('names the six events bananagig.geography.<event>.v1', () => {
      expect(GEOGRAPHY_EVENTS).toEqual({
        countryActivated: 'bananagig.geography.country-activated.v1',
        countryDeactivated: 'bananagig.geography.country-deactivated.v1',
        marketCreated: 'bananagig.geography.market-created.v1',
        marketActivated: 'bananagig.geography.market-activated.v1',
        marketDeactivated: 'bananagig.geography.market-deactivated.v1',
        marketDefaultsChanged: 'bananagig.geography.market-defaults-changed.v1',
      });
      for (const type of Object.values(GEOGRAPHY_EVENTS)) expect(EVENT_TYPE_PATTERN.test(type), type).toBe(true);
    });
    it('carry identifiers only: country events need the country code; market events the market and country codes', () => {
      expect(ok(CountryEventPayload, { countryCode: 'ZZ' })).toBe(true);
      expect(ok(CountryEventPayload, {})).toBe(false);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc', countryCode: 'US' })).toBe(true);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc' })).toBe(false);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc', countryCode: 'US', changedFields: ['defaultLocale'], cause: 'MARKET' })).toBe(true);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc', countryCode: 'US', changedFields: ['distanceUnit'], cause: 'COUNTRY' })).toBe(true);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc', countryCode: 'US', cause: 'USER' })).toBe(false);
      expect(ok(MarketEventPayload, { marketCode: 'la-oc', countryCode: 'US', changedFields: [1] })).toBe(false);
    });
    it('have no field that could carry values, names or reasons', () => {
      const fields = [...Object.keys(CountryEventPayload.shape), ...Object.keys(MarketEventPayload.shape)];
      for (const forbidden of ['reason', 'name', 'value', 'values', 'locale', 'currencyCode', 'timeZone', 'actor']) expect(fields).not.toContain(forbidden);
    });
    it('fit inside the event envelope', () => {
      const env = (eventType: string, aggregateType: string, payload: unknown) => ({
        eventId: randomUUID(),
        eventType,
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        correlationId: 'corr-12345678',
        causationId: null,
        actor: { type: 'user', id: 'admin-a' },
        aggregateType,
        aggregateId: randomUUID(),
        payload,
      });
      expect(EventEnvelope.safeParse(env(GEOGRAPHY_EVENTS.countryActivated, 'geography_country', { countryCode: 'ZZ' })).success).toBe(true);
      expect(
        EventEnvelope.safeParse(
          env(GEOGRAPHY_EVENTS.marketDefaultsChanged, 'geography_market', {
            marketCode: 'la-oc',
            countryCode: 'US',
            changedFields: ['currencyCode'],
            cause: 'MARKET',
          }),
        ).success,
      ).toBe(true);
    });
  });

  it('lists the typed geography error codes', () => {
    expect([...GEOGRAPHY_ERROR_CODES].sort()).toEqual(
      [
        'COUNTRY_NOT_FOUND',
        'MARKET_NOT_FOUND',
        'CURRENCY_NOT_FOUND',
        'TIME_ZONE_NOT_FOUND',
        'LOCALE_NOT_FOUND',
        'VALIDATION_FAILED',
        'CONFLICT',
        'INVALID_STATE',
        'NOT_READY',
        'UNAVAILABLE',
      ].sort(),
    );
  });
});
