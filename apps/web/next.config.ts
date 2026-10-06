import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Standalone tracing must see workspace packages, so trace from the repo root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@bananagig/contracts', '@bananagig/config', '@bananagig/observability'],
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/sdk-logs',
    '@opentelemetry/resources',
    'prom-client',
  ],
  poweredByHeader: false,
  typedRoutes: true,
};
export default config;
