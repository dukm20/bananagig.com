// Contract-conforming stand-in for the content endpoints of the API (the real API is exercised by `pnpm smoke` and its own tests).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CORRELATION_HEADER, ResolveContentRequest, ResolveManyContentRequest, type LocaleDto, type ResolvedContentDto } from '@bananagig/contracts';

export interface StubEntry {
  value: string;
  format?: 'text' | 'html';
  contentType?: ResolvedContentDto['contentType'];
}
export type StubCatalog = Record<string, Record<string, StubEntry>>;
export interface StubCall {
  path: string;
  body: unknown;
  correlationId: string | undefined;
}

export interface ContentStub {
  baseUrl: string;
  /** Content resolve calls (POST). The locale list endpoint is counted separately in `localeCalls`, so resolve assertions stay about copy. */
  calls: StubCall[];
  /** Number of GET /api/v1/content/locales requests received (answered or not). */
  localeCalls: number;
  /**
   * What the public locale list returns (the API returns active locales only to public callers; the stub returns this list verbatim).
   * undefined: the endpoint is not served (404), which exercises the negotiation fallback. 'fail' answers 503.
   */
  locales: LocaleDto[] | 'fail' | undefined;
  /** 'down' answers 503 with the standard error envelope. */
  mode: 'up' | 'down';
  catalog: StubCatalog;
  close(): Promise<void>;
}

const PLATFORM_DEFAULT = 'en-US';

function chainFor(requested: string): string[] {
  return [...new Set([requested, requested.split('-')[0]!, PLATFORM_DEFAULT])];
}

function resolve(key: string, requested: string, catalog: StubCatalog): ResolvedContentDto | undefined {
  const chain = chainFor(requested).filter((l) => catalog[l] !== undefined);
  const locale = chain.find((l) => catalog[l]![key] !== undefined);
  if (!locale) return undefined;
  const entry = catalog[locale]![key]!;
  return {
    key,
    contentType: entry.contentType ?? 'UI_LABEL',
    requestedLocale: requested,
    resolvedLocale: locale,
    fallback: { applied: locale !== requested, chain },
    version: 1,
    versionId: '00000000-0000-4000-8000-000000000001',
    sourceScope: 'PLATFORM',
    scopeRef: null,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    bodySha256: 'a'.repeat(64),
    format: entry.format ?? 'text',
    value: entry.value,
  };
}

export async function startContentStub(catalog: StubCatalog): Promise<ContentStub> {
  const stub: ContentStub = { baseUrl: '', calls: [], localeCalls: 0, locales: undefined, mode: 'up', catalog, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
      let body: unknown;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      const isLocaleList = req.method === 'GET' && req.url === '/api/v1/content/locales';
      if (isLocaleList) stub.localeCalls++;
      else stub.calls.push({ path: req.url ?? '', body, correlationId });
      res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, correlationId ?? 'stub-correlation');
      const fail = (status: number, code: string, category: string): void => {
        res.statusCode = status;
        res.end(JSON.stringify({ error: { code, category, message: code, correlationId: correlationId ?? 'stub-correlation' } }));
      };
      if (stub.mode === 'down') return fail(503, 'UNAVAILABLE', 'DEPENDENCY');
      if (isLocaleList) {
        if (stub.locales === 'fail') return fail(503, 'UNAVAILABLE', 'DEPENDENCY');
        if (stub.locales === undefined) return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
        res.end(JSON.stringify({ data: stub.locales, meta: { correlationId: correlationId ?? 'stub-correlation' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/content/resolve') {
        const parsed = ResolveContentRequest.safeParse(body);
        if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
        const dto = resolve(parsed.data.key, parsed.data.locale, stub.catalog);
        if (!dto) return fail(404, 'ENTRY_NOT_FOUND', 'NOT_FOUND');
        res.end(JSON.stringify({ data: dto, meta: { correlationId: correlationId ?? 'stub-correlation' } }));
      } else if (req.method === 'POST' && req.url === '/api/v1/content/resolve-many') {
        const parsed = ResolveManyContentRequest.safeParse(body);
        if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
        const items = parsed.data.keys.flatMap((k) => resolve(k, parsed.data.locale, stub.catalog) ?? []);
        res.end(JSON.stringify({ data: { evaluatedAt: new Date().toISOString(), items }, meta: { correlationId: correlationId ?? 'stub-correlation' } }));
      } else {
        fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return stub;
}

/** Registry copy with wording that differs from any literal that could be hardcoded in the app, so tests prove the text came from the registry. */
export const REGISTRY_COPY: StubCatalog = {
  'en-US': {
    'brand.name': { value: 'BananaGig' },
    'brand.tagline': { value: 'Registry tagline (en-US)' },
    'system.home.initialized': { value: 'Registry initialized message', contentType: 'PLAIN_TEXT' },
    'common.action.sign_in': { value: 'Registry sign in' },
    'common.action.sign_out': { value: 'Registry sign out' },
    'session.status.signed_in': { value: 'Registry signed in' },
    'session.status.signed_out': { value: 'Registry signed out' },
    'session.error.login_failed': { value: 'Registry login failed', contentType: 'PLAIN_TEXT' },
  },
};
