// Shared external/public contracts only: HTTP DTOs, error model, event envelope, protocol constants.
// Must not import any other workspace package. Never put database entities here.
import { z } from 'zod';

export const CORRELATION_HEADER = 'x-correlation-id';
export const API_PREFIX = '/api/v1';
export const API_VERSION = 'v1';

/** Accepted inbound correlation ids: 8-128 chars of [A-Za-z0-9._-]. Anything else is replaced. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
export const isSafeCorrelationId = (v: unknown): v is string => typeof v === 'string' && CORRELATION_ID_PATTERN.test(v);

// ---- error model ----
export const ERROR_CATEGORIES = ['VALIDATION', 'AUTHENTICATION', 'AUTHORIZATION', 'CONFLICT', 'NOT_FOUND', 'RATE_LIMIT', 'DEPENDENCY', 'INTERNAL'] as const;
export const ErrorCategory = z.enum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

/** HTTP status for each category. */
export const ERROR_STATUS: Record<ErrorCategory, number> = {
  VALIDATION: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT: 429,
  DEPENDENCY: 503,
  INTERNAL: 500,
};

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().describe('Stable machine-readable code, e.g. VALIDATION_FAILED'),
    category: ErrorCategory,
    message: z.string(),
    correlationId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ---- success envelope for /api/v1 ----
import { envelope } from './envelope';
export { envelope };

// ---- system DTOs ----
export const HealthResponse = z.object({ status: z.literal('ok'), service: z.string() });
export const ReadinessResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: z.string(),
  checks: z.record(z.string(), z.enum(['up', 'down'])),
});
export const VersionResponse = z.object({
  service: z.string(),
  version: z.string(),
  commit: z.string(),
  buildTime: z.string(),
  environment: z.enum(['development', 'test', 'production']),
});
export const SystemInfo = z.object({
  service: z.string(),
  environment: z.enum(['development', 'test', 'production']),
  version: z.string(),
  apiVersion: z.literal(API_VERSION),
  serverTime: z.string().describe('ISO-8601 UTC'),
  uptimeSeconds: z.number().int().nonnegative(),
});
export const SystemInfoResponse = envelope(SystemInfo);
export type SystemInfo = z.infer<typeof SystemInfo>;

// ---- identity (whoami) ----
export const AuthContext = z
  .enum(['web', 'admin', 'other'])
  .describe('Which identity context issued the token: normal web client, admin console client, or anything else');
export const WhoAmI = z.object({
  subject: z.string().describe('Immutable Keycloak subject (`sub`)'),
  clientId: z.string().describe('Client the token was issued to (`azp`)'),
  audience: z.array(z.string()),
  realmRoles: z.array(z.string()),
  authContext: AuthContext,
});
export const WhoAmIResponse = envelope(WhoAmI);
export type WhoAmI = z.infer<typeof WhoAmI>;
export type WhoAmIResponse = z.infer<typeof WhoAmIResponse>;
export type SystemInfoResponse = z.infer<typeof SystemInfoResponse>;
export type VersionResponse = z.infer<typeof VersionResponse>;

// ---- domain event envelope (see docs/events/asyncapi.yaml, docs/engineering/EVENT_CONVENTIONS.md) ----
export const EVENT_TYPE_PATTERN = /^bananagig\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9][0-9]*$/;
export const EventActor = z.object({ type: z.enum(['user', 'system', 'service']), id: z.string().nullable() });
export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().regex(EVENT_TYPE_PATTERN, 'bananagig.<domain>.<event>.v<version>'),
  eventVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  correlationId: z.string(),
  causationId: z.string().nullable(),
  actor: EventActor,
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Infrastructure self-test event only; not a product event. */
export const INFRA_PING_EVENT_TYPE = 'bananagig.infra.ping.v1';
export const INFRA_PING_QUEUE = 'infra.ping';

/** Metadata carried by background jobs so correlation survives the HTTP -> job hop. */
export const JobMeta = z.object({ correlationId: z.string() });
export type JobMeta = z.infer<typeof JobMeta>;
export * from './configuration';
export * from './content';
