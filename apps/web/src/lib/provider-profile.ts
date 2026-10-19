// Shared helpers of the provider public profile pages (PRO-002): the registry keys of the page copy, the closed error, notice and issue lists, the display formats of a price and a
// duration, and a tolerant loader. Everything a page shows comes from the registry or from the API; the only literals here are identifiers (keys, words, paths).
import {
  GIG_MEDIA_REFUSAL_REASONS,
  PROFILE_ERROR_CODES,
  PROFILE_ISSUE_REASONS,
  profileErrorKey,
  profileWireCode,
  type GigPriceDto,
  type ProfileFieldName,
  type ProfileIssueReason,
} from '@bananagig/contracts';
import { redirect } from 'next/navigation';
import { ApiError } from './api-client';
import { isSessionRevokedError } from './auth/handlers';
import type { renderContent } from './content';
import { gigCopy } from './provider-gigs';

/**
 * The registry key of a page-copy path. The page's own `title` and `intro` live under `provider.profile.page.` (like `provider.gig.page.title`); every other group (`name.*`, `bio.*`,
 * `photo.*`, `visibility.*`, `readiness.*`, `preview.*`, `public.*`, `save`, `notice.*`) lives directly under `provider.profile.` (like `provider.gig.menu.*`), exactly as the
 * migration 0024 seeds them.
 */
export const profileKey = (path: string): string => (path === 'title' || path === 'intro' ? `provider.profile.page.${path}` : `provider.profile.${path}`);

/** `?error=<wire code>` words -> the registry key of the message (the API's `PROFILE_<code>`; a stale revision reads `STALE_PROFILE`). */
export const PROFILE_ERROR_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  PROFILE_ERROR_CODES.map((c) => [profileWireCode(c), profileErrorKey(c)]),
);
/** The closed list of error words a redirect may carry. */
export const PROFILE_API_ERROR_CODES: readonly string[] = PROFILE_ERROR_CODES.map((c) => profileWireCode(c));
export const PROFILE_GENERIC_ERROR = 'API_ERROR';
/** What any other error word says: the generic "unavailable" message of the registry, never the word itself. */
export const GENERIC_PROFILE_ERROR_KEY = profileErrorKey('UNAVAILABLE');
/** What a page says when it cannot load the provider's profile because the account is not an eligible provider yet (with a link to the registration, whose title is `REGISTRATION_TITLE_KEY`). */
export const PAGE_UNAVAILABLE_REGISTRATION_KEY = 'provider.profile.error.page_unavailable_registration';
export const REGISTRATION_TITLE_KEY = 'provider.registration.page.title';
/** The notice words of `/provider/profile?notice=` (the page maps each to a registry path and shows it only when the data proves it). */
export const PROFILE_NOTICES = ['created', 'saved', 'published', 'unpublished', 'photo_added', 'photo_removed'] as const;
export type ProfileNotice = (typeof PROFILE_NOTICES)[number];
/** The issue reasons a redirect may name (`&issue=<REASON>`, closed list) and the field each one is about (where the page links to). */
export const PROFILE_ISSUE_FIELD: Readonly<Record<ProfileIssueReason, ProfileFieldName>> = {
  DISPLAY_NAME_TOO_LONG: 'displayName',
  DISPLAY_NAME_BLANK: 'displayName',
  DISPLAY_NAME_FORBIDDEN_CHARACTER: 'displayName',
  DISPLAY_NAME_HTML_NOT_ALLOWED: 'displayName',
  BIO_TOO_LONG: 'bio',
  BIO_BLANK: 'bio',
  BIO_FORBIDDEN_CHARACTER: 'bio',
  BIO_HTML_NOT_ALLOWED: 'bio',
  BIO_REQUIRED: 'bio',
  PHOTO_REQUIRED: 'photo',
  PUBLIC_NAME_UNAVAILABLE: 'displayName',
};
export const isProfileIssueReason = (v: unknown): v is ProfileIssueReason => typeof v === 'string' && (PROFILE_ISSUE_REASONS as readonly string[]).includes(v);
export const isMediaRefusalReason = (v: unknown): v is (typeof GIG_MEDIA_REFUSAL_REASONS)[number] =>
  typeof v === 'string' && (GIG_MEDIA_REFUSAL_REASONS as readonly string[]).includes(v);

/** The page copy: `t(path)` serves a page-copy path, `k(key)` a full registry key (the contract's own keys: errors, issues, badges, labels). Absent copy is null. */
export interface ProfileText {
  t: (path: string) => ReturnType<typeof renderContent>;
  k: (key: string | null | undefined) => ReturnType<typeof renderContent>;
}

/** Loads the registry copy of the given page-copy paths and full keys, and returns the two accessors. */
export async function profileCopy(paths: readonly string[], keys: readonly (string | null | undefined)[] = []): Promise<ProfileText> {
  const text = await gigCopy([...paths.map(profileKey), ...keys.filter((k): k is string => typeof k === 'string' && k !== '')]);
  return { t: (path) => text(profileKey(path)), k: (key) => (key ? text(key) : null) };
}

/** Display locale of numbers (a presentation format, not copy; the registry copy is negotiated separately). */
const DISPLAY_LOCALE = 'en-US';
/**
 * A price for a customer: the base price in minor units as the currency's own notation (`12500 USD` -> `$125.00`). It formats ONE given amount and computes nothing else (no group
 * price, no discount, no total). An unknown currency code falls back to the plain amount and code.
 */
export function formatPrice(price: GigPriceDto): string {
  try {
    const digits = new Intl.NumberFormat(DISPLAY_LOCALE, { style: 'currency', currency: price.currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const major = price.amountMinor / 10 ** digits;
    return new Intl.NumberFormat(DISPLAY_LOCALE, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${price.amountMinor} ${price.currency}`;
  }
}
/** A duration in minutes in the platform's unit notation (`120` -> `120 minutes`); the unit word comes from Intl, not from this app. */
export function formatMinutes(minutes: number): string {
  try {
    return new Intl.NumberFormat(DISPLAY_LOCALE, { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(minutes);
  } catch {
    return String(minutes);
  }
}
/** The length of a text in characters (code points), the way the server counts it. */
export const charCount = (value: string | null): number => (value === null ? 0 : Array.from(value).length);

/** Why a read of the owner's profile or preview failed, in the words a page can act on. */
export type ProfileLoadFailure = 'registration' | 'public_name_unavailable' | 'unavailable';
/**
 * `registration`: 403 / 409 PROVIDER_NOT_ELIGIBLE (the account is not a registered provider yet: link to the registration). `public_name_unavailable`: PROFILE_INCOMPLETE naming
 * PUBLIC_NAME_UNAVAILABLE (the preview has no name to show: link to the name field). Everything else (an outage, an unexpected answer) is `unavailable`, the calm message.
 */
export function classifyProfileFailure(err: ApiError): ProfileLoadFailure {
  if ((err.status === 403 || err.status === 409) && (err.code === 'PROFILE_PROVIDER_NOT_ELIGIBLE' || err.code === 'PROVIDER_NOT_ELIGIBLE'))
    return 'registration';
  if (err.code === 'PROFILE_INCOMPLETE') {
    const issues = err.details?.issues;
    if (Array.isArray(issues) && issues.some((i) => i !== null && typeof i === 'object' && (i as Record<string, unknown>).reason === 'PUBLIC_NAME_UNAVAILABLE'))
      return 'public_name_unavailable';
  }
  return 'unavailable';
}
export type ProfileLoad<T> = { ok: true; value: T } | { ok: false; status: number; failure: ProfileLoadFailure };
/** Runs an API read: a revoked session leaves for /auth/revoked, an API failure is `{ ok: false }` with its classification, anything else is a bug and is thrown. */
export async function loadProfile<T>(read: () => Promise<T>): Promise<ProfileLoad<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (isSessionRevokedError(err)) redirect('/auth/revoked');
    if (!(err instanceof ApiError)) throw err;
    return { ok: false, status: err.status, failure: classifyProfileFailure(err) };
  }
}
