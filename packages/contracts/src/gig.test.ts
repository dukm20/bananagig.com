// Unit tests of the provider Gig contracts (CAT-003): the two state machines, the plain-text normaliser, the strict requests (no owner, no currency, no version), the policy bounds,
// the content key helpers and the event / error vocabularies.
import { describe, expect, it } from 'vitest';
import { EVENT_TYPE_PATTERN } from './index';
import {
  CreateGigRequest,
  GIG_ERROR_CODES,
  GIG_EVENTS,
  GIG_ISSUE_REASONS,
  GIG_PRICE_MINOR_CEILING,
  GIG_STATUSES,
  GIG_VERSION_STATUSES,
  GigDetailDto,
  GigReadinessDto,
  GigVersionParams,
  PROVIDER_GIG_POLICY_KEYS,
  ProviderGigPolicy,
  PublishGigRequest,
  RetireGigRequest,
  UpdateGigDraftRequest,
  gigErrorKey,
  gigIssueKey,
  gigStatusKey,
  gigVersionStatusKey,
  gigWireCode,
  isGigFieldTypeSupported,
  isGigStatusTransitionAllowed,
  isGigVersionStatusTransitionAllowed,
  normalizeProviderText,
  textLength,
} from './gig';

const draft = { expectedRevision: 1, title: 't', shortPitch: 'p', description: 'd', priceAmountMinor: 100, durationMinutes: 60, fieldValues: [] };

describe('state machines', () => {
  it('Gig: DRAFT -> ACTIVE|RETIRED, ACTIVE -> RETIRED, nothing else (RETIRED is terminal)', () => {
    const allowed = GIG_STATUSES.flatMap((a) => GIG_STATUSES.filter((b) => isGigStatusTransitionAllowed(a, b)).map((b) => `${a}>${b}`));
    expect(allowed.sort()).toEqual(['ACTIVE>RETIRED', 'DRAFT>ACTIVE', 'DRAFT>RETIRED']);
  });
  it('version: DRAFT -> PUBLISHED|RETIRED, PUBLISHED -> SUPERSEDED|RETIRED, nothing else', () => {
    const allowed = GIG_VERSION_STATUSES.flatMap((a) => GIG_VERSION_STATUSES.filter((b) => isGigVersionStatusTransitionAllowed(a, b)).map((b) => `${a}>${b}`));
    expect(allowed.sort()).toEqual(['DRAFT>PUBLISHED', 'DRAFT>RETIRED', 'PUBLISHED>RETIRED', 'PUBLISHED>SUPERSEDED']);
  });
});

describe('field type support matrix', () => {
  it('supports exactly the seven typed kinds; MONEY, MEDIA and the references are deferred', () => {
    for (const t of ['TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION']) expect(isGigFieldTypeSupported(t)).toBe(true);
    for (const t of ['MONEY', 'MEDIA', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE', 'nope']) expect(isGigFieldTypeSupported(t)).toBe(false);
  });
});

describe('normalizeProviderText', () => {
  it('normalises to NFC, trims, collapses single-line whitespace and keeps multi-line breaks', () => {
    expect(normalizeProviderText('é  x \n y ', { multiline: false })).toEqual({ ok: true, value: 'é x y' });
    expect(normalizeProviderText(' a\r\nb\rc ', { multiline: true })).toEqual({ ok: true, value: 'a\nb\nc' });
  });
  it('refuses control characters, bidi overrides, the BOM and unpaired surrogates', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u202Eb', 'a\u2066b', 'a\uFEFFb', 'a\u007Fb', 'a\u0085b', 'a\uD800b', 'a\uDC00b'])
      expect(normalizeProviderText(bad, { multiline: true })).toEqual({ ok: false, reason: 'FORBIDDEN_CHARACTER' });
    expect(normalizeProviderText('a\u0009b', { multiline: false })).toEqual({ ok: true, value: 'a b' });
  });
  it('refuses markup but accepts plain comparison text and emoji', () => {
    for (const html of ['<b>x</b>', '<script>alert(1)</script>', 'hi <img src=x onerror=1>', '<!-- c -->', '<?php', '</div>'])
      expect(normalizeProviderText(html, { multiline: true })).toEqual({ ok: false, reason: 'HTML_NOT_ALLOWED' });
    expect(normalizeProviderText('under 2 hours < 3 & 4 > 1', { multiline: false }).ok).toBe(true);
    expect(normalizeProviderText('Great clean \u{1F9F9}', { multiline: false }).ok).toBe(true);
  });
  it('refuses invisible text and treats text with nothing visible as empty', () => {
    for (const bad of ['\u200B', 'a\u200Bb', 'a\u2060b', 'a\u200Eb', 'a\u200Fb', 'a\u061Cb', 'a\u00ADb', 'a\u3164b', 'a\u2800b', 'a\u{E0041}b'])
      expect(normalizeProviderText(bad, { multiline: true })).toEqual({ ok: false, reason: 'FORBIDDEN_CHARACTER' });
    for (const blank of ['   ', '\u200D', '\u200C\u200D', ' \n ']) expect(normalizeProviderText(blank, { multiline: true })).toEqual({ ok: true, value: '' });
    expect(normalizeProviderText('\u{1F468}\u200D\u{1F469}', { multiline: false }).ok).toBe(true);
  });
  it('is linear on hostile input (no ReDoS)', () => {
    for (const hostile of ['a<' + ' '.repeat(80_000) + '1', '<' + '/'.repeat(80_000) + '1', 'a' + ' <'.repeat(40_000), '<' + ' \n'.repeat(40_000) + '1']) {
      const t0 = performance.now();
      normalizeProviderText(hostile, { multiline: true });
      normalizeProviderText(hostile, { multiline: false });
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
  it('counts code points, not UTF-16 units', () => {
    expect(textLength('\u{1F9F9}\u{1F9F9}')).toBe(2);
    expect('\u{1F9F9}\u{1F9F9}'.length).toBe(4);
  });
});

describe('requests are strict and carry no owner, version, status or currency', () => {
  it('create: a template code and an optional idempotency uuid only', () => {
    expect(CreateGigRequest.safeParse({ gigTemplateCode: 'house_cleaning' }).success).toBe(true);
    expect(CreateGigRequest.safeParse({ gigTemplateCode: 'house_cleaning', clientRequestId: 'x' }).success).toBe(false);
    for (const extra of ['accountId', 'status', 'gigTemplateVersionId', 'marketCode', 'serviceTypeCode', 'currency'])
      expect(CreateGigRequest.safeParse({ gigTemplateCode: 'house_cleaning', [extra]: 'x' }).success).toBe(false);
  });
  it('update: the whole content with a revision; no currency, status or version', () => {
    expect(UpdateGigDraftRequest.safeParse(draft).success).toBe(true);
    for (const extra of ['currency', 'priceCurrency', 'status', 'gigTemplateVersionId', 'accountId'])
      expect(UpdateGigDraftRequest.safeParse({ ...draft, [extra]: 'x' }).success).toBe(false);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, expectedRevision: 0 }).success).toBe(false);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, priceAmountMinor: 1.5 }).success).toBe(false);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, priceAmountMinor: GIG_PRICE_MINOR_CEILING }).success).toBe(true);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, priceAmountMinor: GIG_PRICE_MINOR_CEILING + 1 }).success).toBe(false);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, priceAmountMinor: -1 }).success).toBe(false);
    expect(UpdateGigDraftRequest.safeParse({ ...draft, durationMinutes: 0 }).success).toBe(false);
    const { title: _t, ...missing } = draft;
    expect(UpdateGigDraftRequest.safeParse(missing).success).toBe(false);
  });
  it('update: field values are typed scalars, unique by key, bounded in number', () => {
    const v = (fieldValues: unknown) => UpdateGigDraftRequest.safeParse({ ...draft, fieldValues }).success;
    expect(
      v([
        { fieldKey: 'a_b', value: 'x' },
        { fieldKey: 'cc', value: 3 },
        { fieldKey: 'dd', value: true },
        { fieldKey: 'ee', value: null },
      ]),
    ).toBe(true);
    expect(v([{ fieldKey: 'ab', value: { x: 1 } }])).toBe(false);
    expect(v([{ fieldKey: 'ab', value: 1.5 }])).toBe(false);
    expect(
      v([
        { fieldKey: 'ab', value: 'x' },
        { fieldKey: 'ab', value: 'y' },
      ]),
    ).toBe(false);
    expect(v([{ fieldKey: 'Bad Key', value: 'x' }])).toBe(false);
    expect(v([{ fieldKey: 'ab', value: 'x', extra: 1 }])).toBe(false);
    expect(v(Array.from({ length: 65 }, (_, i) => ({ fieldKey: `k${i}x`, value: 'x' })))).toBe(false);
  });
  it('publish needs a revision; retire takes nothing; version params are plain integers', () => {
    expect(PublishGigRequest.safeParse({ expectedRevision: 2 }).success).toBe(true);
    expect(PublishGigRequest.safeParse({}).success).toBe(false);
    expect(RetireGigRequest.safeParse({}).success).toBe(true);
    expect(RetireGigRequest.safeParse({ reason: 'x' }).success).toBe(false);
    const id = '8f14e45f-ceea-4f67-9a0d-0f2d3c1b2a10';
    expect(GigVersionParams.safeParse({ gigId: id, version: '12' }).success).toBe(true);
    for (const bad of ['0', '01', '-1', '1.5', '1e3', ' 1', '12345678901']) expect(GigVersionParams.safeParse({ gigId: id, version: bad }).success).toBe(false);
  });
});

describe('policy', () => {
  const ok = { maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 };
  it('accepts the bounded integers and nothing else', () => {
    expect(ProviderGigPolicy.safeParse(ok).success).toBe(true);
    expect(ProviderGigPolicy.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    for (const [k, v] of [
      ['maxActive', 0],
      ['maxActive', 501],
      ['maxDrafts', 0],
      ['titleMaxLength', 201],
      ['shortPitchMaxLength', 2001],
      ['descriptionMaxLength', 20001],
      ['titleMaxLength', 1.5],
      ['maxDrafts', '5'],
    ] as const)
      expect(ProviderGigPolicy.safeParse({ ...ok, [k]: v }).success).toBe(false);
  });
  it('the keys are the five provider.gig.* configuration keys', () => {
    expect(Object.values(PROVIDER_GIG_POLICY_KEYS).sort()).toEqual([
      'provider.gig.description.max_length',
      'provider.gig.max_active',
      'provider.gig.max_drafts',
      'provider.gig.short_pitch.max_length',
      'provider.gig.title.max_length',
    ]);
  });
});

describe('content keys, events and errors', () => {
  it('one managed key per enum value, lower case, under provider.gig.', () => {
    expect(GIG_STATUSES.map(gigStatusKey)).toEqual(['provider.gig.status.draft', 'provider.gig.status.active', 'provider.gig.status.retired']);
    expect(GIG_VERSION_STATUSES.map(gigVersionStatusKey)).toEqual([
      'provider.gig.version_status.draft',
      'provider.gig.version_status.published',
      'provider.gig.version_status.superseded',
      'provider.gig.version_status.retired',
    ]);
    for (const c of GIG_ERROR_CODES) expect(gigErrorKey(c)).toBe(`provider.gig.error.${c.toLowerCase()}`);
    for (const r of GIG_ISSUE_REASONS) expect(gigIssueKey(r)).toBe(`provider.gig.issue.${r.toLowerCase()}`);
    expect(GIG_ERROR_CODES).toHaveLength(15);
    expect(GIG_ISSUE_REASONS).toHaveLength(24);
  });
  it('events are versioned bananagig.provider.* types', () => {
    for (const t of Object.values(GIG_EVENTS)) expect(t).toMatch(EVENT_TYPE_PATTERN);
    expect(Object.values(GIG_EVENTS)).toEqual([
      'bananagig.provider.gig-created.v1',
      'bananagig.provider.gig-version-published.v1',
      'bananagig.provider.gig-retired.v1',
    ]);
  });
  it('the wire code never doubles the GIG_ prefix', () => {
    expect(gigWireCode('GIG_NOT_FOUND')).toBe('GIG_NOT_FOUND');
    expect(gigWireCode('STALE_DRAFT')).toBe('GIG_STALE_DRAFT');
    expect(new Set(GIG_ERROR_CODES.map(gigWireCode)).size).toBe(GIG_ERROR_CODES.length);
    for (const c of GIG_ERROR_CODES) expect(gigWireCode(c)).not.toMatch(/^GIG_GIG_/);
  });
  it('readiness cannot claim Go-Live', () => {
    const base = { hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 0 };
    expect(GigReadinessDto.safeParse({ ...base, goLive: { evaluated: false, eligible: false } }).success).toBe(true);
    expect(GigReadinessDto.safeParse({ ...base, goLive: { evaluated: true, eligible: true } }).success).toBe(false);
  });
  it('the Gig detail has no market, service type id, variants, add-ons or media', () => {
    const keys = JSON.stringify(Object.keys(GigDetailDto.shape.gig.shape));
    for (const forbidden of ['market', 'serviceTypeId', 'variants', 'addOns', 'media', 'accountId']) expect(keys).not.toContain(forbidden);
  });
});
