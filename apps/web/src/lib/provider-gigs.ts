// Shared helpers of the provider Gig pages (CAT-003): the registry keys of the page copy, the closed error and notice lists, a chunked content batch and a tolerant loader.
// Everything a page shows comes from the registry or from the API; the only literals here are identifiers (keys, words, paths).
import { redirect } from 'next/navigation';
import { GIG_ERROR_CODES, gigErrorKey, gigWireCode, type GigErrorCode } from '@bananagig/contracts';
import { ApiError } from './api-client';
import { isSessionRevokedError } from './auth/handlers';
import { getContentMany, renderContent, type ContentValue } from './content';

/** `provider.gig.<suffix>` */
export const gigKey = (suffix: string): string => `provider.gig.${suffix}`;

/** `?error=GIG_<code>` words -> the registry key of the message (the API's code is `GIG_<code>`; a few read `GIG_NOT_FOUND`). */
export const GIG_ERROR_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  GIG_ERROR_CODES.map((c) => [gigWireCode(c), gigErrorKey(c as GigErrorCode)]),
);
/** What any other error word says: the generic "unavailable" message of the registry, never the word itself. */
export const GENERIC_GIG_ERROR_KEY = gigErrorKey('UNAVAILABLE');
/** The notice word -> the registry key of its message. */
export const GIG_NOTICE_KEYS: Readonly<Record<string, string>> = {
  created: gigKey('notice.created'),
  saved: gigKey('notice.saved'),
  published: gigKey('notice.published'),
  draft_created: gigKey('notice.draft_created'),
  retired: gigKey('notice.retired'),
};

export const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most keys one content call may carry (the contract's limit). */
const CONTENT_BATCH = 100;

/** The registry copy of the given keys (several calls when there are more than one call may carry). A key the registry cannot serve is absent. */
export async function gigCopy(keys: readonly string[]): Promise<(key: string | null | undefined) => ReturnType<typeof renderContent>> {
  const unique = [...new Set(keys)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CONTENT_BATCH) chunks.push(unique.slice(i, i + CONTENT_BATCH));
  const copy: Record<string, ContentValue | undefined> = Object.assign({}, ...(await Promise.all(chunks.map((c) => getContentMany(c)))));
  return (key) => (key ? renderContent(copy[key]) : null);
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; status: number };
/** Runs an API read: a revoked session leaves for /auth/revoked, an API failure is `{ ok: false }`, anything else is a bug and is thrown. */
export async function loadGig<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (isSessionRevokedError(err)) redirect('/auth/revoked');
    if (!(err instanceof ApiError)) throw err;
    return { ok: false, status: err.status };
  }
}

/** `2026-10-17`: a fixed, unambiguous rendering of a date (no locale words). */
export const day = (iso: string | null): string => (iso === null || Number.isNaN(new Date(iso).getTime()) ? '' : new Date(iso).toISOString().slice(0, 10));
