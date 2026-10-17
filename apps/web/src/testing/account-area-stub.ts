// Contract-conforming stand-in for the account area endpoints of the API (ACC-001), mounted on the content stub like account-stub.ts (the real API is exercised by its own
// integration tests and `pnpm smoke`). It behaves like the API where the web app depends on it: the bearer token is required, the role named in x-active-role must be an ACTIVE
// role of the account (403 ACCOUNT_ROLE_NOT_HELD otherwise), the section set belongs to the ACTING role, and a section-owned endpoint of a section the acting role does not have
// is a 404 ACCOUNT_SECTION_NOT_FOUND. Every response is parsed with its contract schema before it is sent, so a stale fixture fails here and not in a page.
import type http from 'node:http';
import {
  ACCOUNT_AREA_COPY,
  ACCOUNT_SECTIONS,
  CORRELATION_HEADER,
  EMAIL_VERIFICATION_STATUSES,
  PROFILE_ISSUE_CODES,
  AccountNavigationResponse,
  AccountResponse,
  AccountProfileViewResponse,
  AccountRolesSectionResponse,
  ContactVerificationSectionResponse,
  PatchProfileRequest,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  SecuritySummaryResponse,
  TimeZoneListResponse,
  accountSectionDescriptionKey,
  accountSectionLabelKey,
  emailStatusLabelKey,
  phoneStatusLabelKey,
  profileIssueMessageKey,
  publicDisplayName,
  toAccountProfileView,
  type AccountProfileDto,
  type AccountRoleDto,
  type AccountSectionDto,
  type ContactVerificationSectionDto,
  type PrivacySummaryDto,
  type SecuritySummaryDto,
  type TimeZoneDto,
} from '@bananagig/contracts';
import { CONSENTS_ALL_DONE_KEY } from '../lib/account-area';
import { CUSTOMER_ROLE, PROVIDER_ROLE, accountDto } from './account-stub';
import type { ContentStub, StubCatalog } from './content-stub';

export { CUSTOMER_ROLE, PROVIDER_ROLE };

const S = ACCOUNT_SECTIONS;
export const ROUTE_OF: Readonly<Record<string, string>> = {
  [S.profile]: '/account/profile',
  [S.contactVerification]: '/account/contact',
  [S.security]: '/account/security',
  [S.notifications]: '/account/notifications',
  [S.languageRegion]: '/account/language-region',
  [S.privacyData]: '/account/privacy',
  [S.roles]: '/account/roles',
  [S.closeAccount]: '/account/close',
};
/** A section as the navigation returns it (the keys of the seeded registry rows). */
export const section = (code: string): AccountSectionDto => ({
  code,
  route: ROUTE_OF[code]!,
  labelContentKey: accountSectionLabelKey(code),
  descriptionContentKey: accountSectionDescriptionKey(code),
});
/** The six sections the seed enables for both roles, in the seeded menu order. */
export const SEEDED_SECTIONS = [S.profile, S.contactVerification, S.security, S.languageRegion, S.privacyData, S.roles].map(section);

/** The marker text a key resolves to: no hardcoded string of the app can look like it, so a test proves every visible word came from the registry. */
export const marker = (key: string): string => `«${key}»`;
/** Marker copy for every key the account area can ask for (shell and page copy, the registry rows of all eight sections, role names, statuses, name errors). */
export const AREA_KEYS: readonly string[] = [
  ...Object.values(ACCOUNT_AREA_COPY),
  CONSENTS_ALL_DONE_KEY,
  ...Object.keys(ROUTE_OF).flatMap((code) => [accountSectionLabelKey(code), accountSectionDescriptionKey(code)]),
  CUSTOMER_ROLE.nameContentKey,
  PROVIDER_ROLE.nameContentKey,
  ...EMAIL_VERIFICATION_STATUSES.flatMap((s) => [emailStatusLabelKey(s), phoneStatusLabelKey(s)]),
  ...PROFILE_ISSUE_CODES.map(profileIssueMessageKey),
];
/** Keys whose copy has a variable; the stub does not render variables, so the marker names them (the request body proves what was sent). */
const VARIABLE_KEYS: Readonly<Record<string, string>> = {
  [ACCOUNT_AREA_COPY.activeRole]: '{role}',
  [ACCOUNT_AREA_COPY.rolesSwitch]: '{role}',
  [ACCOUNT_AREA_COPY.privacyOutstanding]: '{count}',
};
export const AREA_COPY: StubCatalog = {
  'en-US': Object.fromEntries(AREA_KEYS.map((k) => [k, { value: `${marker(k)}${VARIABLE_KEYS[k] ?? ''}`, contentType: 'PLAIN_TEXT' as const }])),
};

export const LOCALES = [
  { locale: 'en-US', displayName: 'English (United States)', language: 'en', script: null, region: 'US', isActive: true, isPlatformDefault: true },
  { locale: 'es-US', displayName: 'Espanol (Estados Unidos)', language: 'es', script: null, region: 'US', isActive: true, isPlatformDefault: false },
  { locale: 'fr-FR', displayName: 'Francais (France)', language: 'fr', script: null, region: 'FR', isActive: false, isPlatformDefault: false },
];
export const TIME_ZONES: TimeZoneDto[] = [{ ianaName: 'America/Los_Angeles' }, { ianaName: 'America/New_York' }];

export interface AreaCall {
  method: string;
  path: string;
  authorization: string | undefined;
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface ScriptedFailure {
  status: number;
  code: string;
  category: string;
  details?: Record<string, unknown>;
}
export interface AccountAreaStub {
  calls: AreaCall[];
  /** The ACTIVE roles the account holds (CUSTOMER first, the preferred role). */
  roles: AccountRoleDto[];
  /** The sections of each role in menu order (the registry matrix); a role without an entry has none. */
  sections: Record<string, AccountSectionDto[]>;
  profile: AccountProfileDto | null;
  contact: ContactVerificationSectionDto;
  security: SecuritySummaryDto;
  privacy: PrivacySummaryDto;
  timeZones: TimeZoneDto[];
  /** Scripted failures by `METHOD /path` (without the /api/v1 prefix and the query). */
  forced: Record<string, ScriptedFailure>;
  mode: 'up' | 'down';
  reset(): void;
}

const defaults = (): Pick<AccountAreaStub, 'roles' | 'sections' | 'profile' | 'contact' | 'security' | 'privacy' | 'timeZones' | 'forced' | 'mode'> => ({
  roles: [CUSTOMER_ROLE, PROVIDER_ROLE],
  sections: { CUSTOMER: [...SEEDED_SECTIONS], PROVIDER: [...SEEDED_SECTIONS] },
  profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null },
  contact: {
    email: {
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: 'a***@example.test', verifiedAt: '2026-02-03T04:05:06.000Z', source: 'USER_ENTERED' },
      pending: null,
    },
    phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null },
    contacts: { emailVerified: true, phoneVerified: false, contactsVerified: false },
  },
  security: { mfa: { available: true, enabled: true }, activeSessionCount: 3, currentBrowserTrusted: false },
  privacy: { consents: { locale: 'en-US', satisfied: false, outstandingCount: 2 }, dataDownload: { available: false } },
  timeZones: [...TIME_ZONES],
  forced: {},
  mode: 'up',
});

export function attachAccountAreaApi(stub: ContentStub): AccountAreaStub {
  const api: AccountAreaStub = {
    calls: [],
    ...defaults(),
    reset() {
      api.calls.length = 0;
      Object.assign(api, defaults());
    },
  };
  stub.locales = LOCALES;
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    const isArea = path.startsWith('/api/v1/account/') || path === '/api/v1/geography/time-zones';
    if (!isArea) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    const activeRole = req.headers['x-active-role'] as string | undefined;
    const authorization = req.headers.authorization;
    api.calls.push({ method: req.method ?? '', path, authorization, activeRole, body, correlationId });
    const cid = correlationId ?? 'stub-correlation';
    res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
    const fail = (status: number, code: string, category: string, details?: Record<string, unknown>): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code, category, message: code, correlationId: cid, ...(details ? { details } : {}) } }));
      return true;
    };
    const ok = (parse: (j: unknown) => unknown, data: unknown): boolean => {
      const json = { data, meta: { correlationId: cid } };
      try {
        parse(json); // the fixture must satisfy the contract
      } catch (err) {
        return fail(500, 'STUB_FIXTURE_VIOLATES_CONTRACT', 'INTERNAL', { issues: err instanceof Error ? err.message : 'unknown' });
      }
      res.end(JSON.stringify(json));
      return true;
    };
    const route = `${req.method ?? ''} ${path.slice('/api/v1'.length).split('?')[0]}`;
    const forced = api.forced[route];
    if (forced) return fail(forced.status, forced.code, forced.category, forced.details);
    if (route === 'GET /geography/time-zones') return ok(TimeZoneListResponse.parse, api.timeZones); // public: no token needed
    if (!authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.mode === 'down') return fail(503, 'ACCOUNT_UNAVAILABLE', 'DEPENDENCY');
    const held = (role: string | undefined): boolean => role === undefined || api.roles.some((r) => r.code === role);
    if (!held(activeRole)) return fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    const primary = api.roles[0]?.code ?? null;
    const acting = activeRole ?? primary;
    const mine = acting ? (api.sections[acting] ?? []) : [];
    const has = (...codes: string[]): boolean => codes.some((c) => mine.some((s) => s.code === c));
    const notFound = (): boolean => fail(404, 'ACCOUNT_SECTION_NOT_FOUND', 'NOT_FOUND');
    if (route === 'POST /account/active-role') {
      const role = (body as { role?: string } | undefined)?.role;
      if (typeof role !== 'string') return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      return held(role)
        ? ok(AccountResponse.parse, { ...accountDto(api.roles), activeRole: role })
        : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role });
    }
    if (route === 'GET /account/navigation')
      return ok(AccountNavigationResponse.parse, {
        activeRole: acting,
        roles: api.roles,
        sections: mine,
        contacts: api.contact.contacts,
      });
    if (route === 'GET /account/profile')
      return has(S.profile, S.languageRegion) ? ok(AccountProfileViewResponse.parse, toAccountProfileView(api.profile)) : notFound();
    if (route === 'PATCH /account/profile') {
      const parsed = PatchProfileRequest.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      const patch = parsed.data;
      const names = patch.firstName !== undefined || patch.lastName !== undefined;
      const prefs = patch.preferredLocale !== undefined || patch.timeZone !== undefined;
      if ((names && !has(S.profile)) || (prefs && !has(S.languageRegion))) return notFound();
      const before = api.profile;
      const next: AccountProfileDto = {
        firstName: patch.firstName?.trim() ?? before?.firstName ?? '',
        lastName: patch.lastName?.trim() ?? before?.lastName ?? '',
        preferredLocale: patch.preferredLocale !== undefined ? patch.preferredLocale : (before?.preferredLocale ?? null),
        timeZone: patch.timeZone !== undefined ? patch.timeZone : (before?.timeZone ?? null),
      };
      if (!before && (!next.firstName || !next.lastName)) return fail(400, 'ACCOUNT_VALIDATION_FAILED', 'VALIDATION', { reason: 'PROFILE_REQUIRED' });
      const issues = (['firstName', 'lastName'] as const).flatMap((field) =>
        patch[field] !== undefined && patch[field]!.trim() === '' ? [{ field, code: 'REQUIRED', messageKey: profileIssueMessageKey('REQUIRED') }] : [],
      );
      if (issues.length > 0) return fail(400, 'ACCOUNT_VALIDATION_FAILED', 'VALIDATION', { reason: 'INVALID_PROFILE', issues });
      if (patch.preferredLocale && !LOCALES.some((l) => l.isActive && l.locale === patch.preferredLocale))
        return fail(400, 'ACCOUNT_VALIDATION_FAILED', 'VALIDATION', { reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' });
      if (patch.timeZone && !api.timeZones.some((z) => z.ianaName === patch.timeZone))
        return fail(400, 'ACCOUNT_VALIDATION_FAILED', 'VALIDATION', { reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
      const changed = JSON.stringify(before) !== JSON.stringify(next);
      api.profile = next;
      return ok(ProfilePatchedResponse.parse, { changed, profile: { ...next, displayName: publicDisplayName(next.firstName, next.lastName) } });
    }
    if (route === 'GET /account/contact-verification')
      return has(S.contactVerification) ? ok(ContactVerificationSectionResponse.parse, api.contact) : notFound();
    if (route === 'GET /account/roles')
      return has(S.roles)
        ? ok(AccountRolesSectionResponse.parse, {
            roles: api.roles,
            activeRole: acting,
            primaryRole: primary,
            switchableTo: api.roles.map((r) => r.code).filter((c) => c !== acting),
          })
        : notFound();
    if (route === 'GET /account/security-summary') return has(S.security) ? ok(SecuritySummaryResponse.parse, api.security) : notFound();
    if (route === 'GET /account/privacy') return has(S.privacyData) ? ok(PrivacySummaryResponse.parse, api.privacy) : notFound();
    return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
  };
  return api;
}
