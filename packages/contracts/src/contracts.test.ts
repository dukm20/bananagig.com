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
