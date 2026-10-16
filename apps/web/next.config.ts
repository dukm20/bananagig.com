import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Clickjacking protection (ID-005 security review): no page of the app may be framed by any site, same-site included, because several pages act on ONE click
 * (accept a legal document, trust a browser, sign out everywhere). Deliberately only these two headers: the app has no full CSP yet. The modern header and its
 * legacy equivalent are both sent for browsers that only know one of them.
 */
export const FRAME_PROTECTION_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
] as const;
export const frameProtection: NonNullable<NextConfig['headers']> = async () => [
  { source: '/:path*', headers: FRAME_PROTECTION_HEADERS.map((h) => ({ ...h })) },
];

const config: NextConfig = {
  output: 'standalone',
  // Standalone tracing must see workspace packages, so trace from the repo root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@bananagig/contracts', '@bananagig/config', '@bananagig/observability', '@bananagig/identity'],
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/sdk-logs',
    '@opentelemetry/resources',
    'prom-client',
    'iovalkey',
  ],
  poweredByHeader: false,
  typedRoutes: true,
  headers: frameProtection,
};
export default config;
