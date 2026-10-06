// Structured logging, tracing, metrics and request correlation shared by web, api and worker.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { isSafeCorrelationId } from '@bananagig/contracts';
import type { AppConfig } from '@bananagig/config';

// ---------- correlation ----------
interface CorrelationContext {
  correlationId: string;
}
const als = new AsyncLocalStorage<CorrelationContext>();

export const getCorrelationId = (): string | undefined => als.getStore()?.correlationId;
export const runWithCorrelation = <T>(correlationId: string, fn: () => T): T => als.run({ correlationId }, fn);
/** Accept an inbound id only if it matches the safe pattern; otherwise mint a UUID. */
export const resolveCorrelationId = (incoming: unknown): string => (isSafeCorrelationId(incoming) ? incoming : randomUUID());

// ---------- metrics ----------
export const metrics = new Registry();

// ---------- logging ----------
const LEVELS = { debug: 5, info: 9, warn: 13, error: 17 } as const;
type Level = keyof typeof LEVELS;
const REDACT = /pass(word)?|secret|token|authorization|cookie|card|cvv|api[-_]?key/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? '[REDACTED]' : redact(x, depth + 1)]));
}

let settings = { service: 'unknown', environment: 'development', level: 'info' as Level };

/** JSON line to stdout, mirrored to OTLP logs. Always includes correlation and trace identifiers when known. */
export function log(level: Level, message: string, attrs: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[settings.level]) return;
  const sc = trace.getActiveSpan()?.spanContext();
  const safe = redact(attrs) as Record<string, unknown>;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: settings.service,
    environment: settings.environment,
    message,
    correlationId: getCorrelationId(),
    traceId: sc?.traceId,
    spanId: sc?.spanId,
    ...safe,
  };
  console.log(JSON.stringify(record));
  logs.getLogger(settings.service).emit({
    severityNumber: LEVELS[level] as SeverityNumber,
    severityText: level.toUpperCase(),
    body: message,
    attributes: Object.fromEntries(
      Object.entries({ ...safe, correlationId: record.correlationId })
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, typeof x === 'object' ? JSON.stringify(x) : (x as string)]),
    ),
  });
}

// ---------- tracing ----------
let sdk: NodeSDK | undefined;

export function initObservability(cfg: Pick<AppConfig, 'serviceName' | 'env' | 'logLevel' | 'otlpEndpoint' | 'version'>): void {
  settings = { service: cfg.serviceName, environment: cfg.env, level: cfg.logLevel };
  collectDefaultMetrics({ register: metrics });
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': cfg.serviceName, 'service.version': cfg.version.version, 'deployment.environment.name': cfg.env }),
    traceExporter: new OTLPTraceExporter({ url: `${cfg.otlpEndpoint}/v1/traces` }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${cfg.otlpEndpoint}/v1/logs` }) })],
  });
  sdk.start();
}

export async function shutdownObservability(): Promise<void> {
  // Bounded: an unreachable collector must never block process exit.
  await Promise.race([sdk?.shutdown().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
  sdk = undefined;
}

/** Runs fn in a span tagged with the current correlation id. Returns the trace id with the result. */
export async function withSpan<T>(name: string, fn: () => Promise<T>, attrs: Record<string, string> = {}): Promise<{ result: T; traceId: string }> {
  return trace.getTracer(settings.service).startActiveSpan(name, async (span) => {
    const cid = getCorrelationId();
    if (cid) span.setAttribute('correlation.id', cid);
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    try {
      return { result: await fn(), traceId: span.spanContext().traceId };
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Telemetry hooks for @bananagig/database. Structural types keep this package free of a database dependency. */
export interface DbTelemetryOptions {
  slowQueryMs: number;
  logSql: boolean;
}
interface QueryEventLike {
  sql: string;
  durationMs: number;
  error?: unknown;
}
interface TransactionEventLike {
  durationMs: number;
  outcome: 'commit' | 'rollback';
  isolationLevel: string;
  readOnly: boolean;
}

const queryHistogram = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['operation'] as const,
  registers: [metrics],
});
const txHistogram = new Histogram({
  name: 'db_transaction_duration_seconds',
  help: 'Database transaction duration',
  labelNames: ['outcome'] as const,
  registers: [metrics],
});
const slowCounter = new Counter({ name: 'db_slow_queries_total', help: 'Queries slower than the configured threshold', registers: [metrics] });
const connErrors = new Counter({ name: 'db_connection_errors_total', help: 'Database connection-level errors', registers: [metrics] });

/** SQL text is never logged unless DB_LOG_SQL=true; otherwise only the operation keyword is recorded. */
export function createDbTelemetry(o: DbTelemetryOptions) {
  return {
    onQuery(e: QueryEventLike): void {
      const op = (e.sql.trimStart().split(/\s+/, 1)[0] ?? 'other').toLowerCase().replace(/[^a-z]/g, '') || 'other';
      queryHistogram.labels(op).observe(e.durationMs / 1000);
      const end = Date.now();
      const span = trace.getTracer(settings.service).startSpan('db.query', {
        startTime: end - e.durationMs,
        attributes: {
          'db.system': 'postgresql',
          'db.operation': op,
          'correlation.id': getCorrelationId() ?? '',
          ...(o.logSql ? { 'db.statement': e.sql.slice(0, 500) } : {}),
        },
      });
      if (e.error) span.setStatus({ code: SpanStatusCode.ERROR, message: String(e.error) });
      span.end(end);
      if (e.durationMs >= o.slowQueryMs) {
        slowCounter.inc();
        log('warn', 'slow query', {
          operation: op,
          durationMs: Math.round(e.durationMs),
          thresholdMs: o.slowQueryMs,
          ...(o.logSql ? { sql: e.sql.slice(0, 500) } : {}),
        });
      }
    },
    onTransaction(e: TransactionEventLike): void {
      txHistogram.labels(e.outcome).observe(e.durationMs / 1000);
    },
    onPoolError(err: Error): void {
      connErrors.inc();
      log('error', 'database connection error', { error: err.message });
    },
  };
}

/** Exposes pool utilisation as db_pool_connections{state} gauges, read at scrape time. */
export function registerPoolMetrics(pool: string, stats: () => { total: number; idle: number; waiting: number; max: number }): void {
  new Gauge({
    name: 'db_pool_connections',
    help: 'Database pool connections by state',
    labelNames: ['pool', 'state'] as const,
    registers: [metrics],
    collect() {
      const s = stats();
      this.labels(pool, 'total').set(s.total);
      this.labels(pool, 'idle').set(s.idle);
      this.labels(pool, 'waiting').set(s.waiting);
      this.labels(pool, 'max').set(s.max);
    },
  });
}
