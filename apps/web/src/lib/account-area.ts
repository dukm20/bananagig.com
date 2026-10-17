// Server-side loading of the shared ACCOUNT AREA (ACC-001, docs/engineering/ACCOUNT_AREA.md). The layout and every section page call `loadAccountArea()`; it is wrapped in React's
// `cache()`, so ONE request reads the session, the navigation (one API call) and the copy (ONE batch resolve) once, however many server components ask.
//
// What the area shows is DATA the API returns for the ACTIVE role of the session: the navigation lists the sections of that role (registry rows), their labels are content keys, and
// every visible word is registry copy (CFG-002: no hardcoded fallback; an unavailable key omits its element). The role is read from the SERVER session and sent as x-active-role; the
// API validates it on every request, so it is a hint, never authority. Nothing here puts a token, an account id or a session id into anything rendered.
import { cache, type ReactElement } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  ACCOUNT_AREA_COPY,
  EMAIL_VERIFICATION_STATUSES,
  PROFILE_ISSUE_CODES,
  emailStatusLabelKey,
  phoneStatusLabelKey,
  profileIssueMessageKey,
  type AccountNavigationDto,
  type AccountSectionDto,
} from '@bananagig/contracts';
import { ApiError } from './api-client';
import { forgetActiveRole, getSession, isSessionRevokedError } from './auth/handlers';
import { authDeps } from './auth/runtime';
import { getContent, getContentMany, renderContent, type ContentValue } from './content';
import { serverApi } from './server';

export const C = ACCOUNT_AREA_COPY;
/**
 * The copy that has a variable. It is NEVER part of the batch: the API fails a whole resolve-many call when a template lacks its variable (a TEMPLATE_ERROR), which would blank
 * the entire page. Each is resolved on its own with its value (the current role's name, a role to switch to, the number of agreements).
 */
export const VARIABLE_COPY_KEYS: readonly string[] = [C.activeRole, C.rolesSwitch, C.privacyOutstanding];
/** The consent copy the privacy section reuses for "every required agreement is accepted" (managed by ID-005, not an account area key). */
export const CONSENTS_ALL_DONE_KEY = 'account.consent.requirements.all_done';
/** The most keys one resolve-many call accepts (the API's limit); a longer list is split, which today's seeded area never needs. */
const BATCH_MAX = 100;
/** API refusals that mean the role remembered by the session is no longer an ACTIVE role of the account. */
const STALE_ROLE_CODES = new Set(['ACCOUNT_ROLE_NOT_HELD', 'ACCOUNT_ROLE_NOT_ACTIVE']);

/** The registry copy of the area, by content key. */
export interface Copy {
  /** The value as React children (an unavailable key is null: the caller omits the element). */
  node(key: string | null | undefined): ReactElement | string | null;
  /** The plain text of a text-format value, for attributes (`aria-label`); undefined when unavailable or markup. */
  plain(key: string | null | undefined): string | undefined;
  has(key: string | null | undefined): boolean;
}
export function copyOf(values: Record<string, ContentValue | undefined>): Copy {
  const get = (key: string | null | undefined): ContentValue | undefined => (key ? values[key] : undefined);
  return {
    node: (key) => renderContent(get(key)),
    plain: (key) => {
      const v = get(key);
      return v?.format === 'text' ? v.value : undefined;
    },
    has: (key) => get(key) !== undefined,
  };
}

/** Resolves keys in ONE batch call (split only above the API's limit). */
async function resolveCopy(keys: readonly string[]): Promise<Record<string, ContentValue | undefined>> {
  const unique = [...new Set(keys)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_MAX) chunks.push(unique.slice(i, i + BATCH_MAX));
  return Object.assign({}, ...(await Promise.all(chunks.map((c) => getContentMany(c)))));
}

/** Every key of the area that has no variable (see VARIABLE_COPY_KEYS): the shell and page copy, the name errors, the contact status labels, and the label and description of each section and the name of each role. */
export function areaCopyKeys(nav?: AccountNavigationDto): string[] {
  return [
    ...Object.values(C).filter((k) => !VARIABLE_COPY_KEYS.includes(k)),
    CONSENTS_ALL_DONE_KEY,
    ...PROFILE_ISSUE_CODES.map(profileIssueMessageKey),
    ...EMAIL_VERIFICATION_STATUSES.flatMap((s) => [emailStatusLabelKey(s), phoneStatusLabelKey(s)]),
    ...(nav?.sections.flatMap((s) => [s.labelContentKey, ...(s.descriptionContentKey ? [s.descriptionContentKey] : [])]) ?? []),
    ...(nav?.roles.map((r) => r.nameContentKey) ?? []),
  ];
}

export type AccountArea =
  | { kind: 'signed-out' }
  | { kind: 'revoked' }
  | { kind: 'unavailable'; copy: Copy }
  | {
      kind: 'ready';
      /** The API client call options of this request: the role the SESSION remembers (undefined after a stale one was forgotten). */
      call: { activeRole?: string };
      accessToken: string;
      nav: AccountNavigationDto;
      copy: Copy;
      /** "Current role: Customer" (the one copy with a variable, resolved after the role name is known), or null. */
      activeRoleLabel: ReactElement | string | null;
    };

/** One request's view of the area. Cached per request: the layout and the page share it. */
export const loadAccountArea = cache(async (): Promise<AccountArea> => {
  const d = authDeps();
  const session = await getSession((await headers()).get('cookie'), d);
  if (!session) return { kind: 'signed-out' };
  const api = serverApi(session.record.accessToken);
  let role = session.record.activeRole;
  let nav: AccountNavigationDto | undefined;
  for (let attempt = 0; attempt < 2 && !nav; attempt++) {
    try {
      nav = await api.getAccountNavigation({ activeRole: role });
    } catch (err) {
      // the API revoked this session (sign out everywhere, a removed browser): /auth/revoked re-checks and ends it through Keycloak (a page cannot clear a cookie)
      if (isSessionRevokedError(err)) return { kind: 'revoked' };
      if (!(err instanceof ApiError)) throw err;
      // a remembered role the account no longer holds is forgotten and the area is read again with the account's default role
      if (role && err.status === 403 && STALE_ROLE_CODES.has(err.code)) {
        await forgetActiveRole(session.id, d);
        role = undefined;
        continue;
      }
      break;
    }
  }
  if (!nav) return { kind: 'unavailable', copy: copyOf(await resolveCopy(areaCopyKeys())) };
  const copy = copyOf(await resolveCopy(areaCopyKeys(nav)));
  const current = nav.roles.find((r) => r.code === nav.activeRole);
  const roleName = current ? copy.plain(current.nameContentKey) : undefined;
  const activeRoleLabel = roleName ? renderContent(await getContent(C.activeRole, { variables: { role: roleName } })) : null;
  return { kind: 'ready', call: { activeRole: role }, accessToken: session.record.accessToken, nav, copy, activeRoleLabel };
});

/**
 * The area for a page: a signed-out browser goes to sign in (and comes back to the page), a revoked session to /auth/revoked. The result is `unavailable` (the shell shows the
 * message, the page renders nothing) or `ready`.
 */
export async function requireAccountArea(returnTo: string): Promise<Exclude<AccountArea, { kind: 'signed-out' } | { kind: 'revoked' }>> {
  const area = await loadAccountArea();
  if (area.kind === 'signed-out') redirect(`/auth/login?returnTo=${returnTo}`);
  if (area.kind === 'revoked') redirect('/auth/revoked');
  return area;
}

/** The section of `code` in the navigation the API returned for the active role; absent -> Next's not-found (the SERVER is the authority; the menu is only a view of it). */
export function sectionOrNotFound(area: Extract<AccountArea, { kind: 'ready' }>, code: string): AccountSectionDto {
  const section = area.nav.sections.find((s) => s.code === code);
  if (!section) notFound();
  return section;
}

/**
 * Runs one read of a section page. 404 ACCOUNT_SECTION_NOT_FOUND (the API says this role has no such section) is Next's not-found; a revoked session goes to /auth/revoked; any
 * other API failure is `undefined` ("unavailable": the page shows the message instead of the content).
 */
export async function readSection<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (isSessionRevokedError(err)) redirect('/auth/revoked');
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404 && err.code === 'ACCOUNT_SECTION_NOT_FOUND') notFound();
    return undefined;
  }
}

/** The first value of a query parameter (a repeated one is an array). */
export const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** `?saved=1` / `?unchanged=1` / `?error=<word>` -> the content key of the notice or error to show. Only the closed words below are mapped; anything else is ignored. */
export function feedbackKeys(
  query: { saved?: string | string[]; unchanged?: string | string[]; error?: string | string[] },
  errors: Readonly<Record<string, string>>,
): { notice?: string; error?: string } {
  const error = one(query.error);
  return {
    ...(one(query.saved) === '1' ? { notice: C.noticeSaved } : one(query.unchanged) === '1' ? { notice: C.noticeUnchanged } : {}),
    ...(error !== undefined && Object.hasOwn(errors, error) ? { error: errors[error] } : {}),
  };
}

/** The tab title of an account page: the section label (or the area title on the home page) from the registry, from the same cached read as the page. Nothing when it is unavailable. */
export async function accountMetadata(code?: string): Promise<Metadata> {
  const area = await loadAccountArea();
  if (area.kind !== 'ready') return {};
  const title = area.copy.plain(code ? area.nav.sections.find((s) => s.code === code)?.labelContentKey : C.title);
  return title ? { title } : {};
}
