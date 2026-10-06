// Server-side access to registry-owned copy. The web app talks to the API only (never the database or the content package).
//
// BOOTSTRAP POLICY (docs/engineering/CONTENT.md, CFG-002): registry-owned copy NEVER falls back to a hardcoded literal.
// When the registry is unavailable (API down, key unknown, locale without content) these helpers return `undefined`
// and the caller omits the copy. The only static copy in the web app is the bootstrap set: the BananaGig wordmark
// (a proper noun), the generic error/not-found/loading shells, and the two authentication-control labels below: if the registry is
// down a signed-out user must still be able to start a login and a signed-in one to log out (operators recover through them).
// Nothing else may be added here without updating docs/engineering/CONTENT.md and docs/content/CONTENT_OWNERSHIP.md.
import { createElement, type ReactElement } from 'react';
import { headers } from 'next/headers';
import { log } from '@bananagig/observability';
import type { ContentContext, LocaleDto } from '@bananagig/contracts';
import { ApiError, type ApiClient } from './api-client';
import { negotiateAgainst, parseAcceptLanguage } from './locale';

/** The ENTIRE static copy of the web app for registry-owned strings (explicit bootstrap exception). */
export const BOOTSTRAP_COPY = { wordmark: 'BananaGig', signIn: 'Sign in', signOut: 'Sign out' } as const;
import { serverApi } from './server';

/**
 * Locale requested when the browser sent no usable Accept-Language. This is a request hint, not copy: every
 * CHAIN-policy entry falls back to the registry's platform default locale anyway.
 */
export const DEFAULT_REQUEST_LOCALE = 'en-US';

export interface ContentValue {
  /** 'text' values are plain text (React escapes them). 'html' values were sanitized by the API and are safe to inject. */
  format: 'text' | 'html';
  value: string;
}

export interface ContentOptions {
  /** Explicit locale (canonical). When omitted it is negotiated from the incoming request's Accept-Language header. */
  locale?: string;
  context?: ContentContext;
  variables?: Record<string, unknown>;
  timeZone?: string;
  /** Injection points for tests; production uses the request headers and the server API client. */
  acceptLanguage?: string | null;
  api?: Pick<ApiClient, 'resolveContent' | 'resolveManyContent'> & Partial<Pick<ApiClient, 'listContentLocales'>>;
}

/** How long the active locale list is reused (a locale activation takes at most this long to reach negotiation; it is not copy). */
export const ACTIVE_LOCALES_TTL_MS = 30_000;
let activeMemo: { at: number; locales: LocaleDto[] } | undefined;
let activeInflight: Promise<LocaleDto[] | undefined> | undefined;

/** Test hook: forgets the memoized active locale list. */
export function resetActiveLocalesMemo(): void {
  activeMemo = undefined;
  activeInflight = undefined;
}

/**
 * The active locales from the public API, memoized in-process for 30 s (concurrent callers share one fetch). Failures are NOT memoized and
 * never throw: undefined means "unknown", and the caller falls back to sending the top preference.
 */
async function activeLocales(api: NonNullable<ContentOptions['api']>): Promise<LocaleDto[] | undefined> {
  if (!api.listContentLocales) return undefined;
  if (activeMemo && Date.now() - activeMemo.at < ACTIVE_LOCALES_TTL_MS) return activeMemo.locales;
  const list = api.listContentLocales.bind(api);
  activeInflight ??= list()
    .then((all) => {
      const locales = all.filter((l) => l.isActive);
      activeMemo = { at: Date.now(), locales };
      return locales;
    })
    .catch((err: unknown) => {
      log('warn', 'active locale list unavailable, negotiating without it', {
        code: err instanceof ApiError ? err.code : 'CONTENT_REQUEST_FAILED',
        status: err instanceof ApiError ? err.status : undefined,
      });
      return undefined;
    })
    .finally(() => {
      activeInflight = undefined;
    });
  return activeInflight;
}

/**
 * The locale to request: an explicit option wins. Otherwise the first Accept-Language preference that is ACTIVE (or whose language is), so
 * `fr-FR, es-US;q=0.8` serves Spanish when fr is not active. When the active list cannot be fetched the top preference is sent (the API's
 * fallback chain still applies). When no preference is active the platform default locale is requested.
 */
async function locale(opts: ContentOptions, api: NonNullable<ContentOptions['api']>): Promise<string> {
  if (opts.locale) return opts.locale;
  const header = opts.acceptLanguage !== undefined ? opts.acceptLanguage : await headers().then((h) => h.get('accept-language'));
  const preferences = parseAcceptLanguage(header);
  if (preferences.length === 0) return DEFAULT_REQUEST_LOCALE;
  const active = await activeLocales(api);
  if (!active) return preferences[0]!;
  return (
    negotiateAgainst(
      preferences,
      active.map((l) => l.locale),
    ) ??
    active.find((l) => l.isPlatformDefault)?.locale ??
    DEFAULT_REQUEST_LOCALE
  );
}

function failed(keys: string[], err: unknown): void {
  // A missing key (404) is a configuration gap; anything else is the registry being unavailable. Both omit the copy.
  const code = err instanceof ApiError ? err.code : 'CONTENT_REQUEST_FAILED';
  log('warn', 'content unavailable, copy omitted', { keys, code, status: err instanceof ApiError ? err.status : undefined });
}

/** Resolves one PUBLIC entry for the request's locale. Returns undefined when the registry cannot serve it. */
export async function getContent(key: string, opts: ContentOptions = {}): Promise<ContentValue | undefined> {
  try {
    const api = opts.api ?? serverApi();
    const dto = await api.resolveContent({
      key,
      locale: await locale(opts, api),
      context: opts.context,
      variables: opts.variables,
      timeZone: opts.timeZone,
    });
    return { format: dto.format, value: dto.value };
  } catch (err) {
    failed([key], err);
    return undefined;
  }
}

/**
 * Resolves several PUBLIC entries in one API call (3 database queries server-side). The result is keyed by content
 * key and holds only the keys the registry served; an unavailable registry yields an empty object.
 */
export async function getContentMany(
  keys: readonly string[],
  opts: Omit<ContentOptions, 'variables'> & { variables?: Record<string, Record<string, unknown>> } = {},
): Promise<Record<string, ContentValue | undefined>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return {};
  try {
    const api = opts.api ?? serverApi();
    const res = await api.resolveManyContent({
      keys: unique,
      locale: await locale(opts, api),
      context: opts.context,
      variables: opts.variables,
      timeZone: opts.timeZone,
    });
    const out: Record<string, ContentValue | undefined> = {};
    for (const item of res.items) if (unique.includes(item.key)) out[item.key] = { format: item.format, value: item.value };
    return out;
  } catch (err) {
    failed(unique, err);
    return {};
  }
}

/**
 * Renders a registry value as React children. 'text' becomes an escaped text node. 'html' is injected as markup ONLY for
 * format html: the API sanitizes every markup render (allow-listed tags and attributes, validated link destinations),
 * so the string is safe to inject. Never pass a string from any other source here.
 */
export function renderContent(content: ContentValue | undefined): ReactElement | string | null {
  if (!content) return null;
  if (content.format === 'html') return createElement('div', { dangerouslySetInnerHTML: { __html: content.value } });
  return content.value;
}
