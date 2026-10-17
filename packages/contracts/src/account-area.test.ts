// Unit tests of the shared account area contracts (ACC-001): the section vocabulary and the two patterns (which must be EXACTLY the CHECKs of migration 0014), the
// read models (what a good payload looks like, what a bad one is, and that nothing outside the contract can ride along), the strict partial profile update (nothing is
// coerced, nothing unknown is accepted, null only where it clears an optional value), the derived display name, the field to section map that the API authorizes with, and
// the parity of the managed copy keys with the keys migration 0014 seeds (compared as a SET in both directions, so a key added on one side only fails).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentKey } from './content';
import { publicDisplayName } from './account';
import {
  ACCOUNT_AREA_COPY,
  ACCOUNT_AREA_HOME,
  ACCOUNT_SECTIONS,
  ACCOUNT_SECTION_STATUSES,
  AccountNavigationDto,
  AccountNavigationResponse,
  AccountProfileViewDto,
  AccountProfileViewResponse,
  AccountRolesSectionDto,
  AccountRolesSectionResponse,
  AccountSectionCode,
  AccountSectionDto,
  AccountSectionStatus,
  ContactVerificationSectionDto,
  ContactVerificationSectionResponse,
  PROFILE_FIELD_SECTIONS,
  PatchProfileRequest,
  PrivacySummaryDto,
  PrivacySummaryResponse,
  ProfilePatchedDto,
  ProfilePatchedResponse,
  SECTION_CODE_PATTERN,
  SECTION_ROUTE_PATTERN,
  SecuritySummaryDto,
  SecuritySummaryResponse,
  accountSectionDescriptionKey,
  accountSectionLabelKey,
  toAccountProfileView,
} from './account-area';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0014_account_area.sql', import.meta.url)), 'utf8');

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const COMBINING_ACUTE = cp(0x301);
const GRIN = cp(0x1f600);

// ---------------------------------------------------------------- zod shape walker (same technique as consent.test.ts / security.test.ts)
type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown };
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;
function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  if ((def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) return unwrap(def.innerType);
  return schema;
}
/** Every property name at every depth of a schema. */
function allKeys(schema: unknown): string[] {
  const def = defOf(unwrap(schema));
  if (def.type === 'object' && def.shape) return Object.entries(def.shape).flatMap(([key, child]) => [key, ...allKeys(child)]);
  if (def.type === 'array' && def.element) return allKeys(def.element);
  return [];
}
const shapeKeys = (schema: unknown): string[] => Object.keys(defOf(schema).shape ?? {}).sort();

// ---------------------------------------------------------------- fixtures
const META = { correlationId: 'corr-1' };
const wrap = (data: unknown) => ({ data, meta: META });
const ISO = '2026-10-16T12:00:00.000Z';
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };
const SECTION = {
  code: 'PROFILE',
  route: '/account/profile',
  labelContentKey: 'account.area.section.profile.label',
  descriptionContentKey: 'account.area.section.profile.description',
};
const SECTION_NO_DESCRIPTION = { ...SECTION, code: 'ROLES', route: '/account/roles', descriptionContentKey: null };
const EMAIL_NONE = { emailVerificationStatus: 'NONE', primary: null, pending: null };
const PHONE_NONE = { phoneVerificationStatus: 'NONE', primary: null, pending: null };
const EMAIL_VERIFIED = {
  emailVerificationStatus: 'VERIFIED',
  primary: { maskedEmail: 'a***@example.test', verifiedAt: ISO, source: 'USER_ENTERED' },
  pending: null,
};
const PHONE_PENDING = {
  phoneVerificationStatus: 'NONE',
  primary: null,
  pending: { maskedPhone: '+1 *** *** 0123', countryCode: 'US', purpose: 'INITIAL_PHONE', status: 'PENDING', lastSentAt: ISO, expiresAt: ISO },
};
const CONTACTS = { emailVerified: false, phoneVerified: false, contactsVerified: false };
const NAVIGATION = { activeRole: 'CUSTOMER', roles: [CUSTOMER, PROVIDER], sections: [SECTION, SECTION_NO_DESCRIPTION], contacts: CONTACTS };
const PROFILE = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
const SECURITY = { mfa: { available: true, enabled: false }, activeSessionCount: 2, currentBrowserTrusted: true };
const PRIVACY = { consents: { locale: 'en-US', satisfied: false, outstandingCount: 2 }, dataDownload: { available: false } };
const ROLES = { roles: [CUSTOMER, PROVIDER], activeRole: 'CUSTOMER', primaryRole: 'CUSTOMER', switchableTo: ['PROVIDER'] };

// ====================================================================== vocabulary
describe('section vocabulary', () => {
  it('the section codes are exactly the eight sections of migration 0014, in this order', () => {
    expect(ACCOUNT_SECTIONS).toEqual({
      profile: 'PROFILE',
      contactVerification: 'CONTACT_VERIFICATION',
      security: 'SECURITY',
      notifications: 'NOTIFICATIONS',
      languageRegion: 'LANGUAGE_REGION',
      privacyData: 'PRIVACY_DATA',
      roles: 'ROLES',
      closeAccount: 'CLOSE_ACCOUNT',
    });
    expect(Object.keys(ACCOUNT_SECTIONS)).toEqual([
      'profile',
      'contactVerification',
      'security',
      'notifications',
      'languageRegion',
      'privacyData',
      'roles',
      'closeAccount',
    ]);
  });
  it('every section code is a valid registry code', () => {
    for (const code of Object.values(ACCOUNT_SECTIONS)) expect(AccountSectionCode.safeParse(code).success, code).toBe(true);
  });
  it('the section statuses are ACTIVE, PLANNED, INACTIVE (the CHECK of the table) and nothing else', () => {
    expect([...ACCOUNT_SECTION_STATUSES]).toEqual(['ACTIVE', 'PLANNED', 'INACTIVE']);
    for (const s of ['ACTIVE', 'PLANNED', 'INACTIVE']) expect(AccountSectionStatus.safeParse(s).success, s).toBe(true);
    for (const s of ['active', 'RETIRED', '', 'ENABLED', 1, null, undefined]) expect(AccountSectionStatus.safeParse(s).success, String(s)).toBe(false);
    expect(migration).toContain("CHECK (status IN ('ACTIVE', 'PLANNED', 'INACTIVE'))");
  });
  it('the area home is /account', () => {
    expect(ACCOUNT_AREA_HOME).toBe('/account');
  });
});

describe('SECTION_CODE_PATTERN (the CHECK ck_account_sections__section_code_format)', () => {
  it('is the same regular expression as the migration CHECK', () => {
    const check = /ck_account_sections__section_code_format CHECK \(section_code ~ '([^']+)'\)/.exec(migration)?.[1];
    expect(check).toBeDefined();
    expect(SECTION_CODE_PATTERN.source).toBe(check);
  });
  it.each(['PROFILE', 'AB', 'A1', 'A_B', 'CONTACT_VERIFICATION', 'A_', 'X9', `A${'B'.repeat(39)}`])('accepts %s', (code) => {
    expect(SECTION_CODE_PATTERN.test(code), code).toBe(true);
    expect(AccountSectionCode.safeParse(code).success, code).toBe(true);
  });
  const rejected: [string, string][] = [
    ['one character', 'A'],
    ['41 characters', `A${'B'.repeat(40)}`],
    ['lower case', 'profile'],
    ['mixed case', 'Profile'],
    ['leading digit', '1ABC'],
    ['leading underscore', '_AB'],
    ['hyphen', 'AB-C'],
    ['space', 'AB C'],
    ['trailing newline', 'AB\n'],
    ['leading newline', '\nAB'],
    ['dot', 'AB.CD'],
    ['slash', 'AB/CD'],
    ['accented letter', `A${cp(0xc9)}`],
    ['full-width letters', cp(0xff21, 0xff22)],
    ['empty', ''],
    ['null byte', 'AB\u0000'],
  ];
  it.each(rejected)('rejects %s', (_label, code) => {
    expect(SECTION_CODE_PATTERN.test(code), JSON.stringify(code)).toBe(false);
    expect(AccountSectionCode.safeParse(code).success, JSON.stringify(code)).toBe(false);
  });
  it('rejects every non-string', () => {
    for (const v of [null, undefined, 1, true, [], {}, ['PROFILE']]) expect(AccountSectionCode.safeParse(v).success, String(v)).toBe(false);
  });
});

describe('SECTION_ROUTE_PATTERN (the CHECK ck_account_sections__route_path_format)', () => {
  it('is the same regular expression as the migration CHECK', () => {
    const check = /ck_account_sections__route_path_format CHECK \(route_path ~ '([^']+)'\)/.exec(migration)?.[1];
    expect(check).toBeDefined();
    expect(SECTION_ROUTE_PATTERN.source.replaceAll('\\/', '/')).toBe(check);
  });
  it.each([
    '/account/profile',
    '/account/contact',
    '/account/language-region',
    '/account/privacy',
    '/account/ab',
    '/account/a1',
    '/account/a-',
    `/account/a${'b'.repeat(39)}`,
  ])('accepts %s', (route) => {
    expect(SECTION_ROUTE_PATTERN.test(route), route).toBe(true);
  });
  const rejected: [string, string][] = [
    ['the area home', '/account'],
    ['no slug', '/account/'],
    ['a one-character slug', '/account/a'],
    ['a 41-character slug', `/account/a${'b'.repeat(40)}`],
    ['an upper-case slug', '/account/Profile'],
    ['a leading digit', '/account/1ab'],
    ['a leading hyphen', '/account/-ab'],
    ['an underscore', '/account/ab_c'],
    ['a second segment', '/account/ab/cd'],
    ['a trailing slash', '/account/ab/'],
    ['an upper-case prefix', '/Account/ab'],
    ['no leading slash', 'account/ab'],
    ['a query', '/account/ab?x=1'],
    ['a fragment', '/account/ab#x'],
    ['a dot segment', '/account/../x'],
    ['an absolute url', 'http://evil.example/account/ab'],
    ['a protocol-relative url', '//evil.example/account/ab'],
    ['a trailing newline', '/account/ab\n'],
    ['a percent escape', '/account/a%2fb'],
    ['another prefix', '/admin/profile'],
    ['empty', ''],
  ];
  it.each(rejected)('rejects %s', (_label, route) => {
    expect(SECTION_ROUTE_PATTERN.test(route), JSON.stringify(route)).toBe(false);
    expect(AccountSectionDto.safeParse({ ...SECTION, route }).success, JSON.stringify(route)).toBe(false);
  });
});

// ====================================================================== read models
describe('AccountSectionDto', () => {
  it('parses a section with and without a description key, and returns exactly the four fields', () => {
    expect(AccountSectionDto.parse(SECTION)).toEqual(SECTION);
    expect(AccountSectionDto.parse(SECTION_NO_DESCRIPTION)).toEqual(SECTION_NO_DESCRIPTION);
    expect(shapeKeys(AccountSectionDto)).toEqual(['code', 'descriptionContentKey', 'labelContentKey', 'route']);
  });
  it('rejects a missing field (each of the four, the description must be present as null)', () => {
    for (const k of Object.keys(SECTION)) {
      const copy: Record<string, unknown> = { ...SECTION };
      delete copy[k];
      expect(AccountSectionDto.safeParse(copy).success, k).toBe(false);
    }
  });
  it('rejects a wrong type in each field', () => {
    for (const [k, v] of [
      ['code', 1],
      ['code', null],
      ['code', 'profile'],
      ['route', null],
      ['route', 5],
      ['route', 'profile'],
      ['labelContentKey', null],
      ['labelContentKey', 7],
      ['descriptionContentKey', 7],
      ['descriptionContentKey', undefined],
    ] as const)
      expect(AccountSectionDto.safeParse({ ...SECTION, [k]: v }).success, `${k}=${String(v)}`).toBe(false);
  });
  it('strips (never returns) a field outside the contract', () => {
    const out = AccountSectionDto.parse({ ...SECTION, enabled: true, displayOrder: 10, status: 'ACTIVE', roleId: 'x' });
    expect(out).toEqual(SECTION);
  });
});

describe('AccountNavigationDto', () => {
  it('parses a full navigation and keeps the order of the sections and of the roles', () => {
    const out = AccountNavigationDto.parse(NAVIGATION);
    expect(out).toEqual(NAVIGATION);
    expect(out.sections.map((s) => s.code)).toEqual(['PROFILE', 'ROLES']);
    const reversed = AccountNavigationDto.parse({ ...NAVIGATION, sections: [...NAVIGATION.sections].reverse() });
    expect(reversed.sections.map((s) => s.code)).toEqual(['ROLES', 'PROFILE']);
  });
  it('parses an account with no usable role: activeRole null, no roles, no sections', () => {
    const none = { activeRole: null, roles: [], sections: [], contacts: CONTACTS };
    expect(AccountNavigationDto.parse(none)).toEqual(none);
  });
  it('has exactly activeRole, roles, sections and contacts', () => {
    expect(shapeKeys(AccountNavigationDto)).toEqual(['activeRole', 'contacts', 'roles', 'sections']);
  });
  it('rejects a missing field', () => {
    for (const k of ['activeRole', 'roles', 'sections', 'contacts']) {
      const copy: Record<string, unknown> = { ...NAVIGATION };
      delete copy[k];
      expect(AccountNavigationDto.safeParse(copy).success, k).toBe(false);
    }
  });
  it('rejects wrong types: a string section list, a section that is not an object, an undefined active role, a partial contacts summary', () => {
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, sections: 'PROFILE' }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, sections: ['PROFILE'] }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, sections: [{ ...SECTION, route: 'x' }] }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, roles: ['CUSTOMER'] }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, activeRole: undefined }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, activeRole: 5 }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, contacts: { emailVerified: true } }).success).toBe(false);
    expect(AccountNavigationDto.safeParse({ ...NAVIGATION, contacts: { ...CONTACTS, emailVerified: 'yes' } }).success).toBe(false);
  });
  it('strips a token, subject, session id or account id that is added to the payload, at the top level and inside a section or a role', () => {
    const polluted = {
      ...NAVIGATION,
      accountId: 'a',
      token: 't',
      sub: 's',
      sessionId: 'x',
      sections: [{ ...SECTION, roleId: 'r', enabled: true }],
      roles: [{ ...CUSTOMER, status: 'ACTIVE', roleId: 'r' }],
    };
    const out = AccountNavigationDto.parse(polluted);
    expect(out).toEqual({ ...NAVIGATION, sections: [SECTION], roles: [CUSTOMER] });
    expect(JSON.stringify(out)).not.toMatch(/token|sessionId|accountId|roleId|"sub"/);
  });
  it('the response is the standard envelope, and an envelope without meta or data is refused', () => {
    expect(AccountNavigationResponse.parse(wrap(NAVIGATION))).toEqual(wrap(NAVIGATION));
    expect(AccountNavigationResponse.safeParse({ data: NAVIGATION }).success).toBe(false);
    expect(AccountNavigationResponse.safeParse({ meta: META }).success).toBe(false);
  });
});

describe('AccountProfileViewDto', () => {
  const view = { profile: { ...PROFILE, displayName: 'Ana M.' } };
  it('parses a profile with its derived display name, and a null profile before a name was given', () => {
    expect(AccountProfileViewDto.parse(view)).toEqual(view);
    expect(AccountProfileViewDto.parse({ profile: null })).toEqual({ profile: null });
    expect(AccountProfileViewResponse.parse(wrap(view))).toEqual(wrap(view));
  });
  it('requires the display name and every profile field (the locale and time zone as null when unset)', () => {
    for (const k of ['firstName', 'lastName', 'preferredLocale', 'timeZone', 'displayName']) {
      const profile: Record<string, unknown> = { ...view.profile };
      delete profile[k];
      expect(AccountProfileViewDto.safeParse({ profile }).success, k).toBe(false);
    }
    expect(AccountProfileViewDto.safeParse({}).success).toBe(false);
    expect(AccountProfileViewDto.safeParse({ profile: { ...view.profile, preferredLocale: null, timeZone: null } }).success).toBe(true);
  });
  it('rejects wrong types', () => {
    for (const [k, v] of [
      ['firstName', 1],
      ['lastName', null],
      ['displayName', null],
      ['displayName', 5],
      ['preferredLocale', 5],
      ['timeZone', false],
    ] as const)
      expect(AccountProfileViewDto.safeParse({ profile: { ...view.profile, [k]: v } }).success, `${k}=${String(v)}`).toBe(false);
  });
});

describe('toAccountProfileView (the public display name is DERIVED on read, never stored)', () => {
  it('returns null for no profile', () => {
    expect(toAccountProfileView(null)).toEqual({ profile: null });
  });
  it('adds displayName = publicDisplayName(first, last) and keeps the four stored fields untouched', () => {
    expect(toAccountProfileView(PROFILE)).toEqual({ profile: { ...PROFILE, displayName: 'Ana M.' } });
    expect(toAccountProfileView({ ...PROFILE, preferredLocale: null, timeZone: null }).profile).toEqual({
      firstName: 'Ana',
      lastName: 'Martinez',
      preferredLocale: null,
      timeZone: null,
      displayName: 'Ana M.',
    });
  });
  it('does not mutate the stored profile it was given', () => {
    const stored = { ...PROFILE };
    toAccountProfileView(stored);
    expect(stored).toEqual(PROFILE);
    expect(stored).not.toHaveProperty('displayName');
  });
  it.each([
    ['Ana', 'Martinez'],
    ['Ana', 'martinez'],
    ['Madonna', 'Cher'],
    ['Ana', 'de la Cruz'],
    ['  Ana \t Maria ', '\n  martinez '],
    ['Ana', '   '],
    ['Ana', `${cp(0xe9)}lodie`],
    ['Ana', `e${COMBINING_ACUTE}lodie`],
    ['Ana', `${cp(0x10428)}x`],
    ['Ana', `${GRIN}smith`],
    [`${cp(0xc9)}lodie`, 'Zhang'],
  ])('derives the display name exactly like publicDisplayName(%j, %j)', (first, last) => {
    const view = toAccountProfileView({ firstName: first, lastName: last, preferredLocale: null, timeZone: null });
    expect(view.profile!.displayName).toBe(publicDisplayName(first, last));
  });
  it('never exposes the full last name in the display name', () => {
    for (const last of ['Martinez', 'Smith-Jones', 'de la Cruz', `${GRIN}smith`]) {
      const shown = toAccountProfileView({ ...PROFILE, lastName: last }).profile!.displayName;
      expect(shown, last).not.toContain(last);
      expect(shown.endsWith('.')).toBe(true);
    }
  });
  it('its result satisfies the view contract', () => {
    expect(AccountProfileViewDto.safeParse(toAccountProfileView(PROFILE)).success).toBe(true);
    expect(AccountProfileViewDto.safeParse(toAccountProfileView(null)).success).toBe(true);
  });
});

describe('ProfilePatchedDto', () => {
  const patched = { changed: true, profile: { ...PROFILE, displayName: 'Ana M.' } };
  it('parses a changed and an unchanged result', () => {
    expect(ProfilePatchedDto.parse(patched)).toEqual(patched);
    expect(ProfilePatchedDto.parse({ ...patched, changed: false })).toEqual({ ...patched, changed: false });
    expect(ProfilePatchedResponse.parse(wrap(patched))).toEqual(wrap(patched));
  });
  it('requires `changed` as a boolean and a non-null profile with its display name', () => {
    expect(ProfilePatchedDto.safeParse({ profile: patched.profile }).success).toBe(false);
    expect(ProfilePatchedDto.safeParse({ ...patched, changed: 'true' }).success).toBe(false);
    expect(ProfilePatchedDto.safeParse({ ...patched, changed: 1 }).success).toBe(false);
    expect(ProfilePatchedDto.safeParse({ changed: true, profile: null }).success).toBe(false);
    expect(ProfilePatchedDto.safeParse({ changed: true, profile: PROFILE }).success).toBe(false);
  });
});

describe('ContactVerificationSectionDto', () => {
  const section = { email: EMAIL_VERIFIED, phone: PHONE_PENDING, contacts: { emailVerified: true, phoneVerified: false, contactsVerified: false } };
  it('parses masked states and the derived summary, and returns them unchanged', () => {
    expect(ContactVerificationSectionDto.parse(section)).toEqual(section);
    const empty = { email: EMAIL_NONE, phone: PHONE_NONE, contacts: CONTACTS };
    expect(ContactVerificationSectionDto.parse(empty)).toEqual(empty);
    expect(ContactVerificationSectionResponse.parse(wrap(section))).toEqual(wrap(section));
    expect(shapeKeys(ContactVerificationSectionDto)).toEqual(['contacts', 'email', 'phone']);
  });
  it('rejects a missing email, phone or contacts block and a wrong status', () => {
    for (const k of ['email', 'phone', 'contacts']) {
      const copy: Record<string, unknown> = { ...section };
      delete copy[k];
      expect(ContactVerificationSectionDto.safeParse(copy).success, k).toBe(false);
    }
    expect(ContactVerificationSectionDto.safeParse({ ...section, email: { ...EMAIL_VERIFIED, emailVerificationStatus: 'MAYBE' } }).success).toBe(false);
    expect(
      ContactVerificationSectionDto.safeParse({ ...section, phone: { ...PHONE_PENDING, pending: { ...PHONE_PENDING.pending, status: 'DONE' } } }).success,
    ).toBe(false);
    expect(ContactVerificationSectionDto.safeParse({ ...section, email: 'a@example.test' }).success).toBe(false);
  });
  it('strips an unmasked address or number that is added next to the masked one', () => {
    const polluted = {
      ...section,
      email: { ...EMAIL_VERIFIED, primary: { ...EMAIL_VERIFIED.primary, email: 'ana@example.test' }, address: 'ana@example.test' },
      phone: { ...PHONE_PENDING, e164: '+12025550123' },
    };
    const out = ContactVerificationSectionDto.parse(polluted);
    expect(JSON.stringify(out)).not.toContain('ana@example.test');
    expect(JSON.stringify(out)).not.toContain('+12025550123');
    expect(out).toEqual(section);
  });
});

describe('SecuritySummaryDto', () => {
  it('parses the summary and has exactly mfa{available, enabled}, activeSessionCount and currentBrowserTrusted', () => {
    expect(SecuritySummaryDto.parse(SECURITY)).toEqual(SECURITY);
    expect(SecuritySummaryResponse.parse(wrap(SECURITY))).toEqual(wrap(SECURITY));
    expect(shapeKeys(SecuritySummaryDto)).toEqual(['activeSessionCount', 'currentBrowserTrusted', 'mfa']);
    expect(shapeKeys(defOf(SecuritySummaryDto).shape!.mfa)).toEqual(['available', 'enabled']);
  });
  it('accepts a provider outage (available false) and no session', () => {
    expect(SecuritySummaryDto.safeParse({ ...SECURITY, mfa: { available: false, enabled: false }, activeSessionCount: 0 }).success).toBe(true);
  });
  it('rejects a negative, fractional, string or missing session count and wrong types elsewhere', () => {
    for (const n of [-1, 1.5, '2', null, Number.NaN, Number.POSITIVE_INFINITY, undefined])
      expect(SecuritySummaryDto.safeParse({ ...SECURITY, activeSessionCount: n }).success, String(n)).toBe(false);
    expect(SecuritySummaryDto.safeParse({ ...SECURITY, mfa: { available: true } }).success).toBe(false);
    expect(SecuritySummaryDto.safeParse({ ...SECURITY, mfa: { available: 'yes', enabled: false } }).success).toBe(false);
    expect(SecuritySummaryDto.safeParse({ ...SECURITY, mfa: true }).success).toBe(false);
    expect(SecuritySummaryDto.safeParse({ ...SECURITY, currentBrowserTrusted: 1 }).success).toBe(false);
    expect(SecuritySummaryDto.safeParse({ mfa: SECURITY.mfa, activeSessionCount: 1 }).success).toBe(false);
  });
  it('strips session ids, device ids and secrets', () => {
    const out = SecuritySummaryDto.parse({ ...SECURITY, sessions: [{ id: 'x' }], sessionId: 'x', deviceId: 'd', secret: 's', recoveryCodes: ['1'] });
    expect(out).toEqual(SECURITY);
  });
});

describe('PrivacySummaryDto (counts only: no document, history or purpose)', () => {
  it('parses the summary and has exactly consents{locale, satisfied, outstandingCount} and dataDownload{available}', () => {
    expect(PrivacySummaryDto.parse(PRIVACY)).toEqual(PRIVACY);
    expect(PrivacySummaryResponse.parse(wrap(PRIVACY))).toEqual(wrap(PRIVACY));
    expect(shapeKeys(PrivacySummaryDto)).toEqual(['consents', 'dataDownload']);
    expect(shapeKeys(defOf(PrivacySummaryDto).shape!.consents)).toEqual(['locale', 'outstandingCount', 'satisfied']);
    expect(shapeKeys(defOf(PrivacySummaryDto).shape!.dataDownload)).toEqual(['available']);
  });
  it('rejects a negative, fractional or missing count, and wrong types', () => {
    for (const n of [-1, 0.5, '1', null, undefined])
      expect(PrivacySummaryDto.safeParse({ ...PRIVACY, consents: { ...PRIVACY.consents, outstandingCount: n } }).success, String(n)).toBe(false);
    expect(PrivacySummaryDto.safeParse({ ...PRIVACY, consents: { ...PRIVACY.consents, satisfied: 'no' } }).success).toBe(false);
    expect(PrivacySummaryDto.safeParse({ ...PRIVACY, consents: { ...PRIVACY.consents, locale: null } }).success).toBe(false);
    expect(PrivacySummaryDto.safeParse({ ...PRIVACY, dataDownload: {} }).success).toBe(false);
    expect(PrivacySummaryDto.safeParse({ consents: PRIVACY.consents }).success).toBe(false);
  });
  it('strips purpose codes, documents, hashes, versions and events even when they are supplied', () => {
    const out = PrivacySummaryDto.parse({
      consents: {
        ...PRIVACY.consents,
        outstanding: ['TERMS_OF_SERVICE'],
        requirements: [{ purposeCode: 'TERMS_OF_SERVICE' }],
        document: { versionId: 'v', bodySha256: 'h' },
        history: [{ eventType: 'ACCEPTED' }],
      },
      dataDownload: { available: false, url: 'https://x.example/export' },
    });
    expect(out).toEqual(PRIVACY);
  });
});

describe('AccountRolesSectionDto', () => {
  it('parses the roles, the active and preferred role and the switch targets', () => {
    expect(AccountRolesSectionDto.parse(ROLES)).toEqual(ROLES);
    expect(AccountRolesSectionResponse.parse(wrap(ROLES))).toEqual(wrap(ROLES));
    expect(shapeKeys(AccountRolesSectionDto)).toEqual(['activeRole', 'primaryRole', 'roles', 'switchableTo']);
  });
  it('parses an account with no role (null roles, nothing to switch to)', () => {
    const none = { roles: [], activeRole: null, primaryRole: null, switchableTo: [] };
    expect(AccountRolesSectionDto.parse(none)).toEqual(none);
  });
  it('rejects a switch target that is not a role code, a non-array and a missing field', () => {
    for (const v of [['provider'], ['P'], [1], 'PROVIDER', null])
      expect(AccountRolesSectionDto.safeParse({ ...ROLES, switchableTo: v }).success, JSON.stringify(v)).toBe(false);
    for (const k of Object.keys(ROLES)) {
      const copy: Record<string, unknown> = { ...ROLES };
      delete copy[k];
      expect(AccountRolesSectionDto.safeParse(copy).success, k).toBe(false);
    }
    expect(AccountRolesSectionDto.safeParse({ ...ROLES, activeRole: undefined }).success).toBe(false);
  });
});

describe('no read model can carry a token, a subject, a session id or legal text', () => {
  const FORBIDDEN =
    /token|subject|^sub$|^sid$|sessionid|applicationsession|keycloak|issuer|password|secret|bodysha|^body$|legaltext|^text$|hash|document|versionid|purposecode|eventtype|history|accountid|e164|^address$/i;
  const dtos: [string, unknown][] = [
    ['AccountSectionDto', AccountSectionDto],
    ['AccountNavigationDto', AccountNavigationDto],
    ['AccountProfileViewDto', AccountProfileViewDto],
    ['ProfilePatchedDto', ProfilePatchedDto],
    ['SecuritySummaryDto', SecuritySummaryDto],
    ['PrivacySummaryDto', PrivacySummaryDto],
    ['AccountRolesSectionDto', AccountRolesSectionDto],
  ];
  it.each(dtos)('%s has no property that names a credential, an identifier of the login or the legal record', (_name, schema) => {
    for (const key of allKeys(schema)) expect(key, key).not.toMatch(FORBIDDEN);
  });
  it('the contact section carries only the masked fields of the email and phone domains (no raw address or number property)', () => {
    const keys = allKeys(ContactVerificationSectionDto);
    expect(keys.filter((k) => /masked/i.test(k)).sort()).toEqual(['maskedEmail', 'maskedEmail', 'maskedPhone', 'maskedPhone']);
    for (const key of keys) expect(key, key).not.toMatch(FORBIDDEN);
    expect(keys).not.toContain('email_address');
  });
  it('every response schema is the envelope {data, meta}', () => {
    for (const r of [
      AccountNavigationResponse,
      AccountProfileViewResponse,
      ProfilePatchedResponse,
      ContactVerificationSectionResponse,
      SecuritySummaryResponse,
      PrivacySummaryResponse,
      AccountRolesSectionResponse,
    ])
      expect(shapeKeys(r)).toEqual(['data', 'meta']);
  });
});

// ====================================================================== PatchProfileRequest
describe('PatchProfileRequest (strict partial update)', () => {
  const ok = (v: unknown) => PatchProfileRequest.safeParse(v).success;
  it.each<[string, unknown]>([
    ['first name only', { firstName: 'Ana' }],
    ['last name only', { lastName: 'Martinez' }],
    ['both names', { firstName: 'Ana', lastName: 'Martinez' }],
    ['locale only', { preferredLocale: 'es-US' }],
    ['time zone only', { timeZone: 'America/Los_Angeles' }],
    ['locale and time zone', { preferredLocale: 'en-US', timeZone: 'UTC' }],
    ['null clears the locale', { preferredLocale: null }],
    ['null clears the time zone', { timeZone: null }],
    ['null clears both', { preferredLocale: null, timeZone: null }],
    ['all four', { firstName: 'Ana', lastName: 'M', preferredLocale: 'en-US', timeZone: 'Europe/Paris' }],
    ['a name at the 500-character contract maximum', { firstName: 'a'.repeat(500) }],
    ['an empty name (the service, not the contract, owns the 1-50 rule)', { firstName: '' }],
    ['a script and region locale', { preferredLocale: 'zh-Hant-TW' }],
  ])('accepts %s', (_label, body) => {
    expect(ok(body), JSON.stringify(body)).toBe(true);
  });
  it('returns exactly the present fields: an absent field stays absent (it is not turned into null or undefined)', () => {
    const out = PatchProfileRequest.parse({ firstName: 'Ana' });
    expect(out).toEqual({ firstName: 'Ana' });
    expect(Object.keys(out)).toEqual(['firstName']);
    expect(Object.keys(PatchProfileRequest.parse({ timeZone: null }))).toEqual(['timeZone']);
    expect(PatchProfileRequest.parse({ timeZone: null }).timeZone).toBeNull();
  });
  it('does not trim or otherwise transform a value (normalization belongs to the service)', () => {
    expect(PatchProfileRequest.parse({ firstName: '  Ana  ' })).toEqual({ firstName: '  Ana  ' });
  });
  it.each<[string, unknown]>([
    ['the empty object (at least one field is required)', {}],
    ['an unknown property', { nickname: 'x' }],
    ['an account id alone', { accountId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11' }],
    ['an account id next to a valid field', { firstName: 'Ana', accountId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11' }],
    ['a role', { firstName: 'Ana', role: 'PROVIDER' }],
    ['a section list', { firstName: 'Ana', sections: ['PROFILE'] }],
    ['snake_case names', { first_name: 'Ana' }],
    ['a differently cased name', { FirstName: 'Ana' }],
    ['a numeric first name', { firstName: 1 }],
    ['a boolean first name', { firstName: true }],
    ['an array first name', { firstName: ['Ana'] }],
    ['an object first name', { firstName: { value: 'Ana' } }],
    ['a null first name (names cannot be cleared)', { firstName: null }],
    ['a null last name', { lastName: null }],
    ['a name above 500 characters', { firstName: 'a'.repeat(501) }],
    ['a numeric locale', { preferredLocale: 1 }],
    ['a locale with an underscore', { preferredLocale: 'en_US' }],
    ['a lower-case region', { preferredLocale: 'en-us' }],
    ['an upper-case language', { preferredLocale: 'EN-US' }],
    ['an empty locale', { preferredLocale: '' }],
    ['a locale above 20 characters', { preferredLocale: 'en-US-x-aaaaaaaaaaaaaaaa' }],
    ['a numeric time zone', { timeZone: 5 }],
    ['an empty time zone', { timeZone: '' }],
    ['a time zone with a space', { timeZone: 'America/Los Angeles' }],
    ['a time zone above 64 characters', { timeZone: `A/${'b'.repeat(70)}` }],
    ['a time zone with a double slash', { timeZone: 'America//Chicago' }],
    ['a boolean time zone', { timeZone: false }],
    ['a null body', null],
    ['an array body', [{ firstName: 'Ana' }]],
    ['a string body', 'firstName'],
    ['a number body', 1],
    ['a boolean body', true],
  ])('rejects %s', (_label, body) => {
    expect(ok(body), JSON.stringify(body)).toBe(false);
  });
  it('rejects an own "__proto__" key from JSON (prototype pollution probe), alone or next to a valid field', () => {
    expect(ok(JSON.parse('{"__proto__":{"firstName":"Ana"}}'))).toBe(false);
    expect(ok(JSON.parse('{"firstName":"Ana","__proto__":{"x":1}}'))).toBe(false);
    expect(ok(JSON.parse('{"firstName":"Ana","constructor":{"x":1}}'))).toBe(false);
  });
  it('coerces nothing: numeric and boolean strings and numbers are not names, locales or zones', () => {
    for (const v of [1, 0, 1e3, true, false, '1e3'.length])
      for (const field of ['firstName', 'lastName', 'preferredLocale', 'timeZone']) expect(ok({ [field]: v }), `${field}=${String(v)}`).toBe(false);
  });
  it('the keys of the contract are exactly the four patchable fields', () => {
    expect(shapeKeys(PatchProfileRequest)).toEqual(['firstName', 'lastName', 'preferredLocale', 'timeZone']);
  });
});

describe('PROFILE_FIELD_SECTIONS (what the API authorizes a field with)', () => {
  it('maps the names to PROFILE and the locale and time zone to LANGUAGE_REGION', () => {
    expect(PROFILE_FIELD_SECTIONS).toEqual({
      firstName: 'PROFILE',
      lastName: 'PROFILE',
      preferredLocale: 'LANGUAGE_REGION',
      timeZone: 'LANGUAGE_REGION',
    });
  });
  it('covers EVERY field the patch accepts, and only those', () => {
    const patchable = shapeKeys(PatchProfileRequest);
    expect(Object.keys(PROFILE_FIELD_SECTIONS).sort()).toEqual(patchable);
  });
  it('every mapped section is one of the known section codes', () => {
    const known = new Set<string>(Object.values(ACCOUNT_SECTIONS));
    for (const [field, code] of Object.entries(PROFILE_FIELD_SECTIONS)) expect(known.has(code), field).toBe(true);
  });
});

// ====================================================================== managed copy: parity with migration 0014
describe('ACCOUNT_AREA_COPY', () => {
  const values = Object.values(ACCOUNT_AREA_COPY);
  /** Every content key that migration 0014 seeds in its VALUES list (ord, content_type, key, ...). */
  const seededKeys = [...migration.matchAll(/\(\d+,\s+'(?:UI_LABEL|PLAIN_TEXT)',\s+'(account\.area\.[a-z0-9_.]+)'/g)].map((m) => m[1]!);
  const sectionSeeded = seededKeys.filter((k) => k.startsWith('account.area.section.'));
  const shellSeeded = seededKeys.filter((k) => !k.startsWith('account.area.section.'));

  it('reads the migration (the parsing itself is not silently empty): 64 distinct seeded keys, 16 of them section keys', () => {
    expect(seededKeys).toHaveLength(64);
    expect(new Set(seededKeys).size).toBe(64);
    expect(sectionSeeded).toHaveLength(16);
    expect(shellSeeded).toHaveLength(48);
  });
  it('has unique keys (no two names for one key)', () => {
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(Object.keys(ACCOUNT_AREA_COPY)).size).toBe(Object.keys(ACCOUNT_AREA_COPY).length);
  });
  it('every key is a well-formed content key (the pattern of the roles table CHECK and of ContentKey) under account.area.', () => {
    const pattern = new RegExp(
      /ck_roles__name_content_key_format CHECK \(name_content_key ~ '([^']+)'\)/.exec(
        readFileSync(fileURLToPath(new URL('../../../db/migrations/0009_identity_accounts.sql', import.meta.url)), 'utf8'),
      )?.[1] ?? '(unreadable)',
    );
    expect(pattern.source).not.toBe('(unreadable)');
    for (const k of values) {
      expect(k, k).toMatch(pattern);
      expect(ContentKey.safeParse(k).success, k).toBe(true);
      expect(k.startsWith('account.area.'), k).toBe(true);
      expect(k.startsWith('account.area.section.'), `${k} is a section key, those belong to the registry rows`).toBe(false);
    }
  });
  it('is EXACTLY the set of shell and page keys the migration seeds (compared both ways)', () => {
    const inCode = new Set<string>(values);
    const inMigration = new Set(shellSeeded);
    const missingFromMigration = [...inCode].filter((k) => !inMigration.has(k));
    const missingFromCode = [...inMigration].filter((k) => !inCode.has(k));
    expect(missingFromMigration, 'keys the code reads but migration 0014 does not seed').toEqual([]);
    expect(missingFromCode, 'keys migration 0014 seeds but the code does not name').toEqual([]);
    expect(values).toHaveLength(48);
  });
  it('the section label and description keys are the keys of the registry rows, and only those', () => {
    const registry = [
      ...migration.matchAll(/^\s+\('([A-Z_]+)',\s+'(\/account\/[a-z-]+)',\s+'([a-z0-9_.]+)',\s+'([a-z0-9_.]+)',\s+'(ACTIVE|PLANNED|INACTIVE)'\)/gm),
    ];
    expect(registry).toHaveLength(8);
    const fromRegistry = new Set(registry.flatMap((m) => [m[3]!, m[4]!]));
    expect(fromRegistry).toEqual(new Set(sectionSeeded));
  });
});

describe('accountSectionLabelKey / accountSectionDescriptionKey', () => {
  const registryRows = [
    ...migration.matchAll(/^\s+\('([A-Z_]+)',\s+'(\/account\/[a-z-]+)',\s+'([a-z0-9_.]+)',\s+'([a-z0-9_.]+)',\s+'(ACTIVE|PLANNED|INACTIVE)'\)/gm),
  ].map((m) => ({ code: m[1]!, route: m[2]!, label: m[3]!, description: m[4]!, status: m[5]! }));

  it('reads the eight registry rows of the migration', () => {
    expect(registryRows.map((r) => r.code)).toEqual([
      'PROFILE',
      'CONTACT_VERIFICATION',
      'SECURITY',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      'ROLES',
      'NOTIFICATIONS',
      'CLOSE_ACCOUNT',
    ]);
  });
  it('produce, for every seeded section, exactly the label and description key of its registry row', () => {
    for (const r of registryRows) {
      expect(accountSectionLabelKey(r.code), r.code).toBe(r.label);
      expect(accountSectionDescriptionKey(r.code), r.code).toBe(r.description);
    }
  });
  it('the seeded sections are exactly the codes of ACCOUNT_SECTIONS', () => {
    expect(registryRows.map((r) => r.code).sort()).toEqual(Object.values(ACCOUNT_SECTIONS).sort());
  });
  it('every seeded route and code satisfies the contract patterns, and the registry statuses are valid', () => {
    for (const r of registryRows) {
      expect(SECTION_CODE_PATTERN.test(r.code), r.code).toBe(true);
      expect(SECTION_ROUTE_PATTERN.test(r.route), r.route).toBe(true);
      expect(AccountSectionStatus.safeParse(r.status).success, r.status).toBe(true);
      expect(ContentKey.safeParse(r.label).success).toBe(true);
    }
  });
  it('lower-cases the code and puts it between account.area.section. and .label / .description', () => {
    expect(accountSectionLabelKey('LANGUAGE_REGION')).toBe('account.area.section.language_region.label');
    expect(accountSectionDescriptionKey('LANGUAGE_REGION')).toBe('account.area.section.language_region.description');
  });
  it('the seeded registry routes are unique and the planned sections are the two the spec names', () => {
    expect(new Set(registryRows.map((r) => r.route)).size).toBe(registryRows.length);
    expect(registryRows.filter((r) => r.status === 'PLANNED').map((r) => r.code)).toEqual(['NOTIFICATIONS', 'CLOSE_ACCOUNT']);
  });
});

describe('the contract is a zod object per read model (guards the helper used above)', () => {
  it('walks a nested array of objects', () => {
    expect(allKeys(z.object({ a: z.array(z.object({ b: z.string().nullable() })) }))).toEqual(['a', 'b']);
  });
});
