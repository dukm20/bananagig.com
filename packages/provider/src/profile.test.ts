// Unit tests of the provider public profile (PRO-002) that need no database: the validation of the display name and the bio, the publishing prerequisites, the fail-closed policy parser,
// the translation of database guard and concurrency failures, the onboarding PROFILE step and the strict input validation that must happen BEFORE any statement or port is touched.
// Behaviour that needs real constraints, locks, the outbox, the audit trail and the projection is covered in profile.itest.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_ISSUE_REASONS, PROVIDER_PROFILE_POLICY_KEYS, type ProfileReadinessDto, type ProviderProfilePolicy } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import {
  DEFAULT_PROFILE_POLICY,
  ProfileError,
  ProviderError,
  ProviderProfileService,
  StaticProfilePolicyProvider,
  mapProfileDbError,
  parseProfilePolicy,
  profilePolicyKeys,
  profilePrerequisite,
} from './index';
import { checkProfileText, publishingIssues, validateProfileUpdate } from './profile-validate';

// every log call of the code under test is captured here (and nothing is printed)
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});
beforeEach(() => {
  logSink.lines.length = 0;
});

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const fail = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};
const asProfile = (e: unknown): ProfileError => {
  expect(e).toBeInstanceOf(ProfileError);
  return e as ProfileError;
};
const surface = (e: ProfileError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const POLICY: ProviderProfilePolicy = { ...DEFAULT_PROFILE_POLICY, displayNameMaxLength: 20, bioMaxLength: 50 };

// ====================================================================== text validation
describe('checkProfileText: the display name', () => {
  it('accepts a normal name, normalises NFC and collapses whitespace to one line', () => {
    expect(checkProfileText('displayName', 'Ada Wash Co', POLICY)).toEqual({ ok: true, value: 'Ada Wash Co' });
    expect(checkProfileText('displayName', '  Ada \n\t  Wash   Co  ', POLICY)).toEqual({ ok: true, value: 'Ada Wash Co' });
    expect(checkProfileText('displayName', 'Café Clean', POLICY)).toEqual({ ok: true, value: 'Café Clean' });
  });
  it('null clears the field', () => {
    expect(checkProfileText('displayName', null, POLICY)).toEqual({ ok: true, value: null });
    expect(checkProfileText('bio', null, POLICY)).toEqual({ ok: true, value: null });
  });
  it('blank text is DISPLAY_NAME_BLANK, never "cleared"', () => {
    for (const blank of ['', '   ', '\n\t ', '  '])
      expect(checkProfileText('displayName', blank, POLICY)).toEqual({ ok: false, issue: { reason: 'DISPLAY_NAME_BLANK', field: 'displayName' } });
  });
  it('the limit counts code points, not UTF-16 units, and is the configured one', () => {
    expect(checkProfileText('displayName', 'a'.repeat(20), POLICY).ok).toBe(true);
    expect(checkProfileText('displayName', 'a'.repeat(21), POLICY)).toEqual({ ok: false, issue: { reason: 'DISPLAY_NAME_TOO_LONG', field: 'displayName' } });
    expect(checkProfileText('displayName', '\u{1F34C}'.repeat(20), POLICY).ok).toBe(true);
    expect(checkProfileText('displayName', '\u{1F34C}'.repeat(21), POLICY).ok).toBe(false);
    expect(checkProfileText('displayName', 'a'.repeat(21), { ...POLICY, displayNameMaxLength: 21 }).ok).toBe(true);
  });
  it('refuses control, bidirectional-override and invisible characters and HTML-looking markup', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a‮b', 'a⁦b', 'a​b', 'a﻿b', 'a­b'])
      expect(checkProfileText('displayName', bad, POLICY), JSON.stringify(bad)).toEqual({
        ok: false,
        issue: { reason: 'DISPLAY_NAME_FORBIDDEN_CHARACTER', field: 'displayName' },
      });
    for (const html of ['<b>Ada</b>', 'Ada <script>', '<a href="x">x</a>'])
      expect(checkProfileText('displayName', html, POLICY)).toEqual({ ok: false, issue: { reason: 'DISPLAY_NAME_HTML_NOT_ALLOWED', field: 'displayName' } });
  });
});

describe('checkProfileText: the bio', () => {
  it('accepts multi-line text, keeps the line breaks and trims the outside', () => {
    expect(checkProfileText('bio', '  Line one\r\nLine two\n\nLine three  ', POLICY)).toEqual({ ok: true, value: 'Line one\nLine two\n\nLine three' });
  });
  it('blank text is BIO_BLANK; the limit and the characters follow the bio rules', () => {
    expect(checkProfileText('bio', '  \n ', POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_BLANK', field: 'bio' } });
    expect(checkProfileText('bio', 'a'.repeat(50), POLICY).ok).toBe(true);
    expect(checkProfileText('bio', 'a'.repeat(51), POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_TOO_LONG', field: 'bio' } });
    expect(checkProfileText('bio', 'a\u0000b', POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_FORBIDDEN_CHARACTER', field: 'bio' } });
    expect(checkProfileText('bio', 'see <img src=x>', POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_HTML_NOT_ALLOWED', field: 'bio' } });
  });
  it('every issue reason a text check can produce is in the contract', () => {
    const produced = new Set<string>();
    for (const field of ['displayName', 'bio'] as const)
      for (const raw of [' ', 'a'.repeat(999), 'a\u0000', '<b>x</b>']) {
        const r = checkProfileText(field, raw, POLICY);
        if (!r.ok) produced.add(r.issue.reason);
      }
    expect(produced.size).toBe(8);
    for (const reason of produced) expect(PROFILE_ISSUE_REASONS as readonly string[]).toContain(reason);
  });
  it('hostile text is bounded in time', () => {
    const big = { ...POLICY, bioMaxLength: 5000 };
    const started = Date.now();
    for (const raw of ['<'.repeat(20_000), ' '.repeat(20_000) + 'x', '́'.repeat(20_000), '<a'.repeat(10_000)]) checkProfileText('bio', raw, big);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('blank-looking text', () => {
  const blankLooking: [string, string][] = [
    ['Hangul choseong filler', '\u115F'],
    ['Hangul jungseong filler', '\u1160'],
    ['Hangul filler U+3164', '\u3164'],
    ['halfwidth Hangul filler', '\uFFA0'],
    ['Hangul fillers together', '\u115F\u1160\u3164\uFFA0'],
    ['combining grapheme joiner', '\u034F'],
    ['combining marks only', '\u1DC0\u1DC1\u0301'],
    ['Khmer inherent vowels', '\u17B4\u17B5'],
    ['variation selectors', '\uFE00\uFE0F'],
    ['Mongolian free variation selectors', '\u180B\u180C\u180D'],
    ['joiners only', '\u200D\u200C'],
    ['blank braille pattern', '\u2800'],
    ['mark after space', ' \u0301 '],
  ];
  it.each(blankLooking)('%s is blank, in both fields (never stored as a name or a bio)', (_n, text) => {
    for (const field of ['displayName', 'bio'] as const) {
      const r = checkProfileText(field, text, POLICY);
      expect(r.ok, `${field} ${JSON.stringify(text)}`).toBe(false);
      if (!r.ok) expect(['DISPLAY_NAME_BLANK', 'BIO_BLANK', 'DISPLAY_NAME_FORBIDDEN_CHARACTER', 'BIO_FORBIDDEN_CHARACTER']).toContain(r.issue.reason);
    }
  });
  it('the blank-looking characters that pass the shared normaliser are reported as BLANK specifically', () => {
    expect(checkProfileText('displayName', '\u0301\uFE0F', POLICY)).toEqual({ ok: false, issue: { reason: 'DISPLAY_NAME_BLANK', field: 'displayName' } });
    expect(checkProfileText('bio', '\u1DC0\u034F', POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_BLANK', field: 'bio' } });
    expect(checkProfileText('bio', '\uFE0F', POLICY)).toEqual({ ok: false, issue: { reason: 'BIO_BLANK', field: 'bio' } });
  });
  it('real text with marks, joiners and emoji is still accepted', () => {
    for (const ok of [
      'e\u0301',
      'Zo\u00eb',
      '\u4f60\u597d',
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      '\u2764\uFE0F',
      '1',
      '!',
      '\u0928\u092E\u0938\u094D\u0924\u0947',
    ])
      expect(checkProfileText('displayName', ok, POLICY).ok, JSON.stringify(ok)).toBe(true);
    expect(checkProfileText('bio', 'Line\n\u2764\uFE0F', POLICY).ok).toBe(true);
  });
});

describe('validateProfileUpdate', () => {
  it('only the fields the request names are part of the change', () => {
    expect(validateProfileUpdate({ displayName: ' Ada ' }, POLICY)).toEqual({ ok: true, change: { displayName: 'Ada' } });
    expect(validateProfileUpdate({ bio: null }, POLICY)).toEqual({ ok: true, change: { bio: null } });
    expect(validateProfileUpdate({ displayName: null, bio: 'hello' }, POLICY)).toEqual({ ok: true, change: { displayName: null, bio: 'hello' } });
    expect(validateProfileUpdate({}, POLICY)).toEqual({ ok: true, change: {} });
  });
  it('collects the issue of every bad field, by identifier only', () => {
    const r = validateProfileUpdate({ displayName: '   ', bio: 'x'.repeat(99) }, POLICY);
    expect(r).toEqual({
      ok: false,
      issues: [
        { reason: 'DISPLAY_NAME_BLANK', field: 'displayName' },
        { reason: 'BIO_TOO_LONG', field: 'bio' },
      ],
    });
  });
});

describe('publishingIssues', () => {
  const have = { publicNameAvailable: true, bioPresent: true, photoPresent: true };
  it('nothing is missing when everything is present', () => {
    expect(publishingIssues(have, { ...POLICY, bioRequired: true, photoRequired: true })).toEqual([]);
  });
  it('the bio and the photo are required only when the configuration says so; a public name always is', () => {
    const none = { publicNameAvailable: false, bioPresent: false, photoPresent: false };
    expect(publishingIssues(none, POLICY)).toEqual([{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }]);
    expect(publishingIssues(none, { ...POLICY, bioRequired: true })).toEqual([
      { reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' },
      { reason: 'BIO_REQUIRED', field: 'bio' },
    ]);
    expect(publishingIssues(none, { ...POLICY, bioRequired: true, photoRequired: true }).map((i) => i.reason)).toEqual([
      'PUBLIC_NAME_UNAVAILABLE',
      'BIO_REQUIRED',
      'PHOTO_REQUIRED',
    ]);
    expect(publishingIssues({ ...have, photoPresent: false }, { ...POLICY, photoRequired: true })).toEqual([{ reason: 'PHOTO_REQUIRED', field: 'photo' }]);
  });
});

// ====================================================================== policy
describe('the profile policy', () => {
  const good = {
    [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength]: 60,
    [PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength]: 1000,
    [PROVIDER_PROFILE_POLICY_KEYS.bioRequired]: false,
    [PROVIDER_PROFILE_POLICY_KEYS.photoRequired]: false,
    [PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes]: 2_097_152,
    [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes]: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'],
    [PROVIDER_PROFILE_POLICY_KEYS.publicRequiresMarketplaceEligibility]: false,
  };
  it('reads the seven keys and the seeded values equal the documented defaults', () => {
    expect([...profilePolicyKeys()].sort()).toEqual(Object.values(PROVIDER_PROFILE_POLICY_KEYS).sort());
    expect(profilePolicyKeys()).toHaveLength(7);
    expect(parseProfilePolicy(good)).toEqual(DEFAULT_PROFILE_POLICY);
  });
  it('fails closed on a missing value of any key', () => {
    for (const key of Object.values(PROVIDER_PROFILE_POLICY_KEYS)) {
      const missing: Record<string, unknown> = { ...good };
      delete missing[key];
      expect(asProfile(capture(() => parseProfilePolicy(missing)))).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
    }
  });
  it('fails closed on malformed, out-of-range and ceiling-breaking values', () => {
    const bad: [string, unknown][] = [
      [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength, 0],
      [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength, 101],
      [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength, '60'],
      [PROVIDER_PROFILE_POLICY_KEYS.displayNameMaxLength, 1.5],
      [PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength, 5001],
      [PROVIDER_PROFILE_POLICY_KEYS.bioMaxLength, -1],
      [PROVIDER_PROFILE_POLICY_KEYS.bioRequired, 'false'],
      [PROVIDER_PROFILE_POLICY_KEYS.photoRequired, 1],
      [PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes, 0],
      [PROVIDER_PROFILE_POLICY_KEYS.photoMaxFileSizeBytes, 26_214_401],
      [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes, 'IDENTITY'],
      [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes, ['NOT_A_TYPE']],
      [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes, ['IDENTITY', 'IDENTITY']],
      [PROVIDER_PROFILE_POLICY_KEYS.publicRequiresMarketplaceEligibility, null],
    ];
    for (const [key, value] of bad)
      expect(asProfile(capture(() => parseProfilePolicy({ ...good, [key]: value }))).code, `${key}=${JSON.stringify(value)}`).toBe('UNAVAILABLE');
  });
  it('an empty badge list is a valid policy (no badge is public)', () => {
    expect(parseProfilePolicy({ ...good, [PROVIDER_PROFILE_POLICY_KEYS.publicBadgeTypes]: [] }).publicBadgeTypes).toEqual([]);
  });
  it('the static provider counts reads and can fail', async () => {
    const p = new StaticProfilePolicyProvider(POLICY);
    expect(await p.policy()).toBe(POLICY);
    expect(p.reads).toBe(1);
    p.failure = new ProfileError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' });
    expect(asProfile(await fail(p.policy())).code).toBe('UNAVAILABLE');
  });
});

// ====================================================================== error translation
describe('mapProfileDbError', () => {
  const pg = (code: string, detail?: string) => Object.assign(new Error(`driver text SECRET-SQL ${code}`), { code, detail });
  const rule = (key: string) => pg('23000', `provider_rule:${key}`);
  const run = (e: unknown) => asProfile(capture(() => mapProfileDbError(e)));

  it('passes typed errors and non-errors through untouched', () => {
    const typed = new ProfileError('STALE_PROFILE', 'x');
    expect(capture(() => mapProfileDbError(typed))).toBe(typed);
    expect(capture(() => mapProfileDbError('plain'))).toBe('plain');
    expect(capture(() => mapProfileDbError(null))).toBeNull();
  });
  it('concurrency failures are a retryable CONFLICT', () => {
    for (const code of ['40P01', '40001', '55P03', '23505']) {
      const e = run(pg(code));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    }
  });
  it('guard rules map to the documented codes', () => {
    expect(run(rule('ACCOUNT_NOT_ACTIVE'))).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(run(rule('PROVIDER_NOT_ELIGIBLE'))).toMatchObject({ code: 'PROVIDER_NOT_ELIGIBLE' });
    expect(run(rule('REGISTRATION_NOT_COMPLETED'))).toMatchObject({ code: 'PROVIDER_NOT_ELIGIBLE' });
    expect(run(rule('ASSET_OWNER'))).toMatchObject({ code: 'MEDIA_NOT_FOUND', details: {} });
    expect(run(rule('ASSET_NOT_USABLE'))).toMatchObject({ code: 'MEDIA_REFUSED' });
    for (const r of ['ROW_IMMUTABLE', 'REVISION', 'NO_DELETE', 'WHATEVER_NEW'])
      expect(run(rule(r))).toMatchObject({ code: 'CONFLICT', details: { reason: r } });
    expect(run(pg('23000', 'no key here'))).toMatchObject({ code: 'CONFLICT', details: {} });
  });
  it('character errors, check violations and missing references are validation failures with fixed text', () => {
    expect(run(pg('22021'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'FORBIDDEN_CHARACTER' } });
    expect(run(pg('23514'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_VALUE' } });
    expect(run(pg('23502'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(run(pg('23503'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'REFERENCE_NOT_FOUND' } });
  });
  it('an outage is UNAVAILABLE with fixed text; the driver text never reaches the error or the log; a programming error is rethrown', () => {
    const e = run(pg('08006'));
    expect(e.code).toBe('UNAVAILABLE');
    expect(surface(e)).not.toContain('SECRET-SQL');
    expect(logSink.lines).toHaveLength(1);
    expect(logSink.lines[0]).not.toContain('SECRET-SQL');
    const bug = new TypeError('programming error');
    expect(capture(() => mapProfileDbError(bug))).toBe(bug);
  });
  it('the errors of the account port are translated', () => {
    expect(run(new ProviderError('UNAVAILABLE', 'x'))).toMatchObject({ code: 'UNAVAILABLE' });
    expect(run(new ProviderError('CONFLICT', 'x'))).toMatchObject({ code: 'CONFLICT', details: { retryable: true } });
    expect(run(new ProviderError('ACCOUNT_NOT_ACTIVE', 'x'))).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
  });
  it('no mapped error ever carries driver text, SQL or table names', () => {
    for (const code of ['40P01', '23000', '23503', '23514', '22021', '08006'])
      expect(surface(run(pg(code, 'provider_rule:SOMETHING')))).not.toMatch(/SECRET-SQL|provider\.|INSERT|SELECT/);
  });
});

// ====================================================================== the onboarding step
describe('profilePrerequisite', () => {
  const facts = (over: Partial<ProfileReadinessDto>): Pick<ProviderProfileService, 'getReadinessFacts'> => ({
    getReadinessFacts: async () => ({
      displayNamePresent: false,
      publicNameAvailable: true,
      bioPresent: false,
      profilePhotoPresent: false,
      hasPublishedGig: false,
      trustSummaryAvailable: false,
      profileComplete: false,
      visibility: null,
      ...over,
    }),
  });
  it('NOT_STARTED without a profile, IN_PROGRESS with an incomplete one, COMPLETE with a complete one; never BLOCKED or NOT_AVAILABLE', async () => {
    expect(await profilePrerequisite(facts({}))('a')).toEqual({ status: 'NOT_STARTED' });
    expect(await profilePrerequisite(facts({ visibility: 'PRIVATE' }))('a')).toEqual({ status: 'IN_PROGRESS' });
    expect(await profilePrerequisite(facts({ visibility: 'PUBLIC', profileComplete: false }))('a')).toEqual({ status: 'IN_PROGRESS' });
    expect(await profilePrerequisite(facts({ visibility: 'PRIVATE', profileComplete: true }))('a')).toEqual({ status: 'COMPLETE' });
    expect(await profilePrerequisite(facts({ visibility: 'PUBLIC', profileComplete: true }))('a')).toEqual({ status: 'COMPLETE' });
  });
  it('a profile that is complete but has no row cannot be COMPLETE', async () => {
    expect(await profilePrerequisite(facts({ profileComplete: true }))('a')).toEqual({ status: 'NOT_STARTED' });
  });
  it('asks for the facts of the given account only and does not hide a failure', async () => {
    const asked: string[] = [];
    await profilePrerequisite({
      getReadinessFacts: async (id) => (asked.push(id), facts({}).getReadinessFacts(id)),
    })('acc-9');
    expect(asked).toEqual(['acc-9']);
    const boom = new ProfileError('UNAVAILABLE', 'x');
    expect(await fail(profilePrerequisite({ getReadinessFacts: async () => Promise.reject(boom) })('a'))).toBe(boom);
  });
});

// ====================================================================== the service over untouchable collaborators
const SENTINEL = 'sentinel-reached';
function untouchable() {
  const touched: string[] = [];
  const trap = (what: string) => () => {
    touched.push(what);
    throw new Error(SENTINEL);
  };
  const database = {
    transaction: trap('transaction'),
    get db() {
      return trap('db')();
    },
    get inTransaction() {
      return false;
    },
  } as unknown as Database;
  const policy = new StaticProfilePolicyProvider(POLICY);
  const service = new ProviderProfileService({
    db: database,
    accounts: { facts: trap('accounts.facts'), grantRole: trap('accounts.grantRole') },
    names: { names: trap('names') },
    markets: { lookup: trap('markets') },
    trust: { publicBadgeTypes: trap('trust') },
    services: { forTemplateVersions: trap('services') },
    policy,
  });
  return { service, touched, policy };
}
const A = '11111111-1111-4111-8111-111111111111';

describe('input is validated before anything else is touched', () => {
  const invalid: [string, (s: ProviderProfileService) => Promise<unknown>][] = [
    ['updateProfile: no body', (s) => s.updateProfile(A, undefined)],
    ['updateProfile: no revision', (s) => s.updateProfile(A, { displayName: 'x' })],
    ['updateProfile: zero revision', (s) => s.updateProfile(A, { expectedRevision: 0, displayName: 'x' })],
    ['updateProfile: nothing to change', (s) => s.updateProfile(A, { expectedRevision: 1 })],
    ['updateProfile: client-supplied account', (s) => s.updateProfile(A, { expectedRevision: 1, displayName: 'x', accountId: A })],
    ['updateProfile: client-supplied visibility', (s) => s.updateProfile(A, { expectedRevision: 1, displayName: 'x', visibility: 'PUBLIC' })],
    ['updateProfile: client-supplied photo', (s) => s.updateProfile(A, { expectedRevision: 1, photoAssetId: A })],
    ['updateProfile: numeric name', (s) => s.updateProfile(A, { expectedRevision: 1, displayName: 5 })],
    ['updateProfile: text past the raw bound', (s) => s.updateProfile(A, { expectedRevision: 1, displayName: 'x'.repeat(401) })],
    ['setVisibility: no revision', (s) => s.setVisibility(A, { visibility: 'PUBLIC' })],
    ['setVisibility: unknown state', (s) => s.setVisibility(A, { expectedRevision: 1, visibility: 'SUSPENDED' })],
    ['setVisibility: extra field', (s) => s.setVisibility(A, { expectedRevision: 1, visibility: 'PUBLIC', publishedAt: 'now' })],
    ['setVisibility: no body', (s) => s.setVisibility(A, null)],
  ];
  it.each(invalid)('%s -> VALIDATION_FAILED (INVALID_REQUEST) and no statement, transaction or port', async (_name, call) => {
    const { service, touched } = untouchable();
    const e = asProfile(await fail(call(service)));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details.reason).toBe('INVALID_REQUEST');
    expect(touched).toEqual([]);
    expect(surface(e)).not.toContain(SENTINEL);
  });

  it('text that fails the configured rules is VALIDATION_FAILED with identifier-only issues, before any statement or port', async () => {
    const { service, touched, policy } = untouchable();
    const e = asProfile(await fail(service.updateProfile(A, { expectedRevision: 1, displayName: '   ', bio: 'SecretBioText <b>' })));
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        reason: 'PROFILE_INVALID',
        issues: [
          { reason: 'DISPLAY_NAME_BLANK', field: 'displayName' },
          { reason: 'BIO_HTML_NOT_ALLOWED', field: 'bio' },
        ],
      },
    });
    expect(surface(e)).not.toContain('SecretBioText');
    expect(policy.reads).toBe(1);
    expect(touched).toEqual([]);
  });

  it('an unreadable policy fails closed (UNAVAILABLE) before anything else, for the public read, the preview and an update', async () => {
    const { service, touched, policy } = untouchable();
    policy.failure = new ProfileError('UNAVAILABLE', 'the profile policy is not available', { reason: 'POLICY_INVALID' });
    for (const call of [
      () => service.getPublicProfile(A),
      () => service.getPublicPhotoTarget(A),
      () => service.getPreview(A),
      () => service.updateProfile(A, { expectedRevision: 1, displayName: 'x' }),
    ]) {
      const e = asProfile(await fail(call()));
      expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
    }
    expect(touched).toEqual([]);
  });

  it('a policy provider that throws something untyped is UNAVAILABLE and nothing of it leaks', async () => {
    const { service, touched, policy } = untouchable();
    policy.failure = new Error('SECRET-CONFIG-HOST down');
    const e = asProfile(await fail(service.getPublicProfile(A)));
    expect(e.code).toBe('UNAVAILABLE');
    expect(surface(e)).not.toContain('SECRET-CONFIG-HOST');
    expect(logSink.lines.join('\n')).not.toContain('SECRET-CONFIG-HOST');
    expect(touched).toEqual([]);
  });

  it('a malformed public id never reaches the database (the same null as an unknown one)', async () => {
    const { service, touched } = untouchable();
    for (const bad of ['', 'nope', '123', 'x'.repeat(1000), '11111111-1111-4111-8111-11111111111g', "' OR 1=1 --", '../../etc/passwd']) {
      expect(await service.getPublicProfile(bad)).toBeNull();
      expect(await service.getPublicPhotoTarget(bad)).toBeNull();
    }
    expect(touched).toEqual([]);
  });
});
