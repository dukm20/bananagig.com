// Typed, schema-validated process configuration. Fails fast at startup.
// Only infrastructure settings belong here; product values (fees, prices, windows) never do.
import { z } from 'zod';

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const url = z.string().url();
const port = z.coerce.number().int().min(1).max(65535);

const raw = z.object({
  NODE_ENV: z.enum(ENVIRONMENTS).default('development'),
  SERVICE_NAME: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: port.default(3000),
  APP_VERSION: z.string().default('0.0.0-dev'),
  GIT_SHA: z.string().default('dev'),
  BUILD_TIME: z.string().default('unknown'),
  DATABASE_URL: url.optional(),
  VALKEY_URL: url.optional(),
  NATS_URL: url.optional(),
  S3_ENDPOINT: url.optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('bananagig-dev'),
  S3_REGION: z.string().default('us-east-1'),
  OPENSEARCH_URL: url.optional(),
  FLAGD_HOST: z.string().optional(),
  FLAGD_PORT: port.default(8013),
  OTEL_EXPORTER_OTLP_ENDPOINT: url.optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.default(1025),
  MAIL_FROM: z.string().default('no-reply@bananagig.localhost'),
  KEYCLOAK_URL: url.optional(),
  API_INTERNAL_URL: url.optional(),
  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  // Database pool/telemetry overrides (defaults per role live in @bananagig/database POOL_POLICIES)
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).optional(),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  DB_SLOW_QUERY_MS: z.coerce.number().int().min(1).default(500),
  DB_LOG_SQL: z.enum(['true', 'false']).default('false'),
  // Transactional outbox relay (worker)
  OUTBOX_RELAY_ENABLED: z.enum(['true', 'false']).default('true'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).default(30000),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
});

// Localhost defaults are applied only outside production. Production must set everything explicitly.
const DEV_DEFAULTS = {
  DATABASE_URL: 'postgres://bananagig:bananagig_dev_only@localhost:5433/bananagig',
  VALKEY_URL: 'redis://localhost:6379',
  NATS_URL: 'nats://localhost:4222',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'bananagig_dev_access',
  S3_SECRET_KEY: 'bananagig_dev_only_secret',
  OPENSEARCH_URL: 'http://localhost:9200',
  FLAGD_HOST: 'localhost',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  SMTP_HOST: 'localhost',
  KEYCLOAK_URL: 'http://localhost:8081',
  API_INTERNAL_URL: 'http://localhost:3211',
} as const;

export interface AppConfig {
  env: Environment;
  serviceName: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
  version: { version: string; commit: string; buildTime: string };
  databaseUrl: string;
  valkeyUrl: string;
  natsUrl: string;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string };
  opensearchUrl: string;
  flagd: { host: string; port: number };
  otlpEndpoint: string;
  smtp: { host: string; port: number };
  mailFrom: string;
  keycloakUrl: string;
  apiInternalUrl: string;
  worker: { id: string; concurrency: number };
  db: { poolMax?: number; idleTimeoutMs?: number; connectionTimeoutMs?: number; statementTimeoutMs?: number; slowQueryMs: number; logSql: boolean };
  outbox: { enabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number; retentionDays: number };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export type Role = 'web' | 'api' | 'worker' | 'tool';
type DevKey = keyof typeof DEV_DEFAULTS;

/** Settings that must be explicit in production for each process role. Others are optional there. */
const ROLE_REQUIRED: Record<Role, DevKey[]> = {
  web: ['API_INTERNAL_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
  api: ['DATABASE_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
  worker: ['DATABASE_URL', 'NATS_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
  tool: [],
};

export interface LoadOptions {
  /** Default service name when SERVICE_NAME is unset. */
  service: string;
  /** Process role; decides which settings are mandatory in production. Defaults to the strictest set (all). */
  role?: Role;
  env?: Record<string, string | undefined>;
}

export function loadConfig(opts: LoadOptions): Readonly<AppConfig> {
  const source = { ...(opts.env ?? process.env) };
  // Treat empty strings as unset.
  for (const k of Object.keys(source)) if (source[k] === '') delete source[k];
  const parsed = raw.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const missing: string[] = [];
  const required = opts.role ? new Set<string>(ROLE_REQUIRED[opts.role]) : undefined; // undefined = everything
  const need = <K extends DevKey>(key: K): string => {
    const v = (e as Record<string, unknown>)[key] as string | undefined;
    if (v) return v;
    if (prod) {
      if (!required || required.has(key)) missing.push(`${key}: required in production`);
      return '';
    }
    return DEV_DEFAULTS[key];
  };
  const cfg: AppConfig = {
    env: e.NODE_ENV,
    serviceName: e.SERVICE_NAME ?? opts.service,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    version: { version: e.APP_VERSION, commit: e.GIT_SHA, buildTime: e.BUILD_TIME },
    databaseUrl: need('DATABASE_URL'),
    valkeyUrl: need('VALKEY_URL'),
    natsUrl: need('NATS_URL'),
    s3: { endpoint: need('S3_ENDPOINT'), accessKey: need('S3_ACCESS_KEY'), secretKey: need('S3_SECRET_KEY'), bucket: e.S3_BUCKET, region: e.S3_REGION },
    opensearchUrl: need('OPENSEARCH_URL'),
    flagd: { host: need('FLAGD_HOST'), port: e.FLAGD_PORT },
    otlpEndpoint: need('OTEL_EXPORTER_OTLP_ENDPOINT'),
    smtp: { host: need('SMTP_HOST'), port: e.SMTP_PORT },
    mailFrom: e.MAIL_FROM,
    keycloakUrl: need('KEYCLOAK_URL'),
    apiInternalUrl: need('API_INTERNAL_URL'),
    worker: { id: e.WORKER_ID ?? `${opts.service}-${process.pid}`, concurrency: e.WORKER_CONCURRENCY },
    db: {
      poolMax: e.DB_POOL_MAX,
      idleTimeoutMs: e.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: e.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      slowQueryMs: e.DB_SLOW_QUERY_MS,
      logSql: e.DB_LOG_SQL === 'true',
    },
    outbox: {
      enabled: e.OUTBOX_RELAY_ENABLED === 'true',
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
      retentionDays: e.OUTBOX_RETENTION_DAYS,
    },
  };
  if (missing.length) throw new ConfigError(missing);
  return Object.freeze(cfg);
}

const SECRET_KEYS = /secret|password|token|key/i;
/** Log-safe view: credentials in URLs and secret-looking keys are masked. */
export function redactConfig(cfg: AppConfig): Record<string, unknown> {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (SECRET_KEYS.test(key)) return '***';
      return v.replace(/(\/\/[^:/@]+):[^@]+@/, '$1:***@');
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(cfg) as Record<string, unknown>;
}
