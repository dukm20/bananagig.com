// Public contracts of the shared ACCOUNT AREA (ACC-001, docs/engineering/ACCOUNT_AREA.md): the section vocabulary, the navigation read model, the read models of
// the sections that compose other domains, the partial profile update and the managed copy keys. One framework for every persona: the sections a person sees are
// DATA (the registry identity.account_sections and identity.account_section_roles) selected by the ACTIVE application role of the request, never a list in code.
// Nothing here carries a token, a subject, a session id, an address, a number or a legal-history detail.
import { z } from 'zod';
import { AccountProfileDto, AccountRoleDto, RoleCode, publicDisplayName } from './account';
import { Locale } from './content';
import { AccountEmailSummaryDto } from './email';
import { IanaTimeZone } from './geography';
import { envelope } from './envelope';
import { AccountPhoneSummaryDto, ContactsVerificationDto } from './phone';

// ---------------------------------------------------------------- vocabulary
/** The registry code of a section: stable, upper case, immutable (migration 0014 CHECK). */
export const SECTION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const AccountSectionCode = z.string().regex(SECTION_CODE_PATTERN);
export type AccountSectionCode = z.infer<typeof AccountSectionCode>;
/**
 * The sections the CODE knows how to serve (each has a guarded endpoint or a page). The registry decides who sees them; a code is added here by the checkpoint that
 * builds the section, together with its registry row.
 */
export const ACCOUNT_SECTIONS = {
  profile: 'PROFILE',
  contactVerification: 'CONTACT_VERIFICATION',
  security: 'SECURITY',
  notifications: 'NOTIFICATIONS',
  languageRegion: 'LANGUAGE_REGION',
  privacyData: 'PRIVACY_DATA',
  roles: 'ROLES',
  closeAccount: 'CLOSE_ACCOUNT',
} as const;
export const ACCOUNT_SECTION_STATUSES = ['ACTIVE', 'PLANNED', 'INACTIVE'] as const;
export const AccountSectionStatus = z.enum(ACCOUNT_SECTION_STATUSES);
export type AccountSectionStatus = z.infer<typeof AccountSectionStatus>;
/** The web path of a section page (migration 0014 CHECK): its own URL under /account. */
export const SECTION_ROUTE_PATTERN = /^\/account\/[a-z][a-z0-9-]{1,39}$/;
/** The account area home. */
export const ACCOUNT_AREA_HOME = '/account';

// ---------------------------------------------------------------- managed copy (CFG-002)
/** Every content key the account area itself reads (seeded by migration 0014; the section labels and descriptions are keys of the REGISTRY rows). */
export const ACCOUNT_AREA_COPY = {
  title: 'account.area.title',
  navLabel: 'account.area.nav.label',
  navBack: 'account.area.nav.back',
  skipLink: 'account.area.skip_link',
  overviewIntro: 'account.area.overview.intro',
  overviewEmpty: 'account.area.overview.empty',
  activeRole: 'account.area.active_role',
  unavailable: 'account.area.unavailable',
  sectionUnavailable: 'account.area.section_unavailable',
  noticeSaved: 'account.area.notice.saved',
  noticeUnchanged: 'account.area.notice.unchanged',
  errorSaveFailed: 'account.area.error.save_failed',
  errorInvalidChoice: 'account.area.error.invalid_choice',
  actionSave: 'account.area.action.save',
  defaultOption: 'account.area.default_option',
  profileFirstName: 'account.area.profile.first_name',
  profileLastName: 'account.area.profile.last_name',
  profilePublicLabel: 'account.area.profile.public_label',
  profilePublicHint: 'account.area.profile.public_hint',
  profileEmpty: 'account.area.profile.empty',
  contactEmail: 'account.area.contact.email',
  contactPhone: 'account.area.contact.phone',
  contactNotAdded: 'account.area.contact.not_added',
  contactPendingNote: 'account.area.contact.pending_note',
  contactAllVerified: 'account.area.contact.all_verified',
  contactNotAllVerified: 'account.area.contact.not_all_verified',
  contactVerifyEmail: 'account.area.contact.verify_email',
  securityMfa: 'account.area.security.mfa',
  securityMfaOn: 'account.area.security.mfa_on',
  securityMfaOff: 'account.area.security.mfa_off',
  securityMfaUnknown: 'account.area.security.mfa_unknown',
  securitySessions: 'account.area.security.sessions',
  securityBrowser: 'account.area.security.browser',
  securityBrowserTrusted: 'account.area.security.browser_trusted',
  securityBrowserNotTrusted: 'account.area.security.browser_not_trusted',
  securityOpen: 'account.area.security.open',
  languageLocale: 'account.area.language.locale',
  languageTimeZone: 'account.area.language.time_zone',
  privacyConsents: 'account.area.privacy.consents',
  privacyOutstanding: 'account.area.privacy.outstanding',
  privacyOpenConsents: 'account.area.privacy.open_consents',
  privacyDownload: 'account.area.privacy.download',
  privacyDownloadUnavailable: 'account.area.privacy.download_unavailable',
  rolesHeld: 'account.area.roles.held',
  rolesCurrent: 'account.area.roles.current',
  rolesSwitch: 'account.area.roles.switch',
  rolesSingle: 'account.area.roles.single',
  rolesSwitchFailed: 'account.area.roles.switch_failed',
} as const;
export type AccountAreaCopyKey = (typeof ACCOUNT_AREA_COPY)[keyof typeof ACCOUNT_AREA_COPY];
/** The label and description keys of a SEEDED section, by code (the registry rows reference exactly these; a later section brings its own). */
export const accountSectionLabelKey = (code: string): string => `account.area.section.${code.toLowerCase()}.label`;
export const accountSectionDescriptionKey = (code: string): string => `account.area.section.${code.toLowerCase()}.description`;

// ---------------------------------------------------------------- navigation read model
export const AccountSectionDto = z.object({
  code: AccountSectionCode,
  /** The page of the section: /account/<slug>. */
  route: z.string().regex(SECTION_ROUTE_PATTERN),
  /** Content keys (CFG-002): the menu entry and heading, and the one-line description. Resolve them with the content API. */
  labelContentKey: z.string(),
  descriptionContentKey: z.string().nullable(),
});
export type AccountSectionDto = z.infer<typeof AccountSectionDto>;
/** What the account area needs to draw itself, in one read: no per-section request exists. */
export const AccountNavigationDto = z.object({
  /** The role this request acts as (validated), or null when the account holds no usable role. The section set belongs to this role. */
  activeRole: z.string().nullable(),
  /** The ACTIVE roles of the account (the role switcher). */
  roles: z.array(AccountRoleDto),
  /** The enabled sections of the active role, in menu order. Empty when there is no active role. */
  sections: z.array(AccountSectionDto),
  /** Whether the email and the phone are verified (DERIVED, nothing stored). */
  contacts: ContactsVerificationDto,
});
export type AccountNavigationDto = z.infer<typeof AccountNavigationDto>;
export const AccountNavigationResponse = envelope(AccountNavigationDto);

// ---------------------------------------------------------------- profile and language/region (PROFILE, LANGUAGE_REGION)
/** The caller's OWN profile in the account area: the editable fields and the name other people see (derived, never stored). */
export const AccountProfileViewDto = z.object({
  profile: AccountProfileDto.extend({ displayName: z.string() }).nullable(),
});
export type AccountProfileViewDto = z.infer<typeof AccountProfileViewDto>;
export const AccountProfileViewResponse = envelope(AccountProfileViewDto);
/** Builds the view from the stored profile: the public display name is derived on read. */
export const toAccountProfileView = (profile: AccountProfileDto | null): AccountProfileViewDto => ({
  profile: profile === null ? null : { ...profile, displayName: publicDisplayName(profile.firstName, profile.lastName) },
});

/** The profile fields owned by each section: the names by PROFILE, the locale and time zone by LANGUAGE_REGION. */
export const PROFILE_FIELD_SECTIONS = {
  firstName: ACCOUNT_SECTIONS.profile,
  lastName: ACCOUNT_SECTIONS.profile,
  preferredLocale: ACCOUNT_SECTIONS.languageRegion,
  timeZone: ACCOUNT_SECTIONS.languageRegion,
} as const;
/**
 * Changes the PRESENT fields only (omitted = unchanged; null clears the optional locale and time zone). At least one field is required. A profile that does not exist
 * yet is created only when both names are given (the row needs them). `PUT /account/profile` stays the full replace.
 */
export const PatchProfileRequest = z
  .object({
    firstName: z.string().max(500).optional(),
    lastName: z.string().max(500).optional(),
    preferredLocale: Locale.nullable().optional(),
    timeZone: IanaTimeZone.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchProfileRequest = z.infer<typeof PatchProfileRequest>;
export const ProfilePatchedDto = z.object({
  /** False when the values already were what the request asked for (nothing written). */
  changed: z.boolean(),
  profile: AccountProfileDto.extend({ displayName: z.string() }),
});
export type ProfilePatchedDto = z.infer<typeof ProfilePatchedDto>;
export const ProfilePatchedResponse = envelope(ProfilePatchedDto);

// ---------------------------------------------------------------- contact and verification (CONTACT_VERIFICATION)
/** The masked email and phone states and the derived summary: the SAME values as GET /account/me, composed, never a second copy. */
export const ContactVerificationSectionDto = z.object({
  email: AccountEmailSummaryDto,
  phone: AccountPhoneSummaryDto,
  contacts: ContactsVerificationDto,
});
export type ContactVerificationSectionDto = z.infer<typeof ContactVerificationSectionDto>;
export const ContactVerificationSectionResponse = envelope(ContactVerificationSectionDto);

// ---------------------------------------------------------------- security summary (SECURITY)
/** A light summary of ID-004 for the section page; the security centre (/security) stays the place to act. */
export const SecuritySummaryDto = z.object({
  mfa: z.object({
    /** False when the identity provider could not be asked: `enabled` then means "unknown". */
    available: z.boolean(),
    /** An authenticator app is configured. */
    enabled: z.boolean(),
  }),
  /** The application sessions that are registered and not revoked (not reconciled with the identity provider, so it can include one that already ended there). */
  activeSessionCount: z.number().int().nonnegative(),
  /** The browser of this request is trusted right now. */
  currentBrowserTrusted: z.boolean(),
});
export type SecuritySummaryDto = z.infer<typeof SecuritySummaryDto>;
export const SecuritySummaryResponse = envelope(SecuritySummaryDto);

// ---------------------------------------------------------------- privacy and data (PRIVACY_DATA)
/** What the privacy section shows: whether the required agreements are accepted (counts only, no document or history) and the data-download contract. */
export const PrivacySummaryDto = z.object({
  consents: z.object({
    /** The locale the requirements were evaluated in. */
    locale: z.string(),
    /** Every REQUIRED purpose is accepted. */
    satisfied: z.boolean(),
    /** How many REQUIRED purposes are not accepted. */
    outstandingCount: z.number().int().nonnegative(),
  }),
  /** The data-download contract that a later checkpoint fills in (DEBT-0045): false until the export exists. */
  dataDownload: z.object({ available: z.boolean() }),
});
export type PrivacySummaryDto = z.infer<typeof PrivacySummaryDto>;
export const PrivacySummaryResponse = envelope(PrivacySummaryDto);

// ---------------------------------------------------------------- roles (ROLES)
export const AccountRolesSectionDto = z.object({
  /** The ACTIVE roles the account holds. */
  roles: z.array(AccountRoleDto),
  activeRole: z.string().nullable(),
  primaryRole: z.string().nullable(),
  /** The roles the caller can switch to (every held role except the active one): switching never creates a new login. */
  switchableTo: z.array(RoleCode),
});
export type AccountRolesSectionDto = z.infer<typeof AccountRolesSectionDto>;
export const AccountRolesSectionResponse = envelope(AccountRolesSectionDto);
