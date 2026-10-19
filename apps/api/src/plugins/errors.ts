import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CORRELATION_HEADER, ERROR_STATUS, profileErrorKey, type ErrorCategory, type ErrorResponse } from '@bananagig/contracts';
import { log, resolveCorrelationId } from '@bananagig/observability';
import { AppError } from '../errors';

const body = (req: { correlationId: string }, category: ErrorCategory, code: string, message: string, details?: Record<string, unknown>): ErrorResponse => ({
  error: { code, category, message, correlationId: req.correlationId, ...(details ? { details } : {}) },
});

/**
 * Everything under /api/v1/account, /api/v1/auth, /api/v1/provider (the provider registration of the caller) and /api/v1/providers (the public profile: its errors are never stored, and its photo sets its own revalidation policy on success) concerns one person's sessions, contacts or credentials (or is a reset request): every response there, errors
 * included, is `Cache-Control: no-store`. The routes set it in an onRequest hook, but router-level failures and unknown paths never reach a route hook, so the error
 * paths set it here from the URL.
 */
const NO_STORE_PREFIXES = ['/api/v1/account', '/api/v1/auth', '/api/v1/provider', '/api/v1/providers', '/api/v1/admin/trust'];
export const isNoStorePath = (url: string): boolean => {
  const path = (url.split(/[?#]/)[0] ?? '').toLowerCase();
  return NO_STORE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
};
/** The two public profile routes: the opaque id is one path segment. */
const PUBLIC_PROFILE_PATH = /^\/api\/v1\/providers\/[^/]+(?:\/photo)?$/;
const noStoreFor = (req: { url: string }, reply: FastifyReply): void => {
  if (isNoStorePath(req.url)) void reply.header('cache-control', 'no-store');
};

/**
 * Fastify `frameworkErrors` handler: failures raised by the ROUTER before any hook runs (a malformed URL component, a path parameter longer
 * than maxParamLength). Without it Fastify answers with its own non-standard JSON body. No onRequest hook has run yet, so the correlation id is
 * resolved here the same way the correlation plugin does.
 */
export const frameworkErrors = (err: FastifyError, req: FastifyRequest, reply: FastifyReply): void => {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
  const code = err.code === 'FST_ERR_MAX_PARAM_LENGTH' ? 'PATH_PARAMETER_TOO_LONG' : 'BAD_URL';
  const message = code === 'BAD_URL' ? 'The request URL is not valid' : 'A path parameter exceeds the maximum allowed length';
  noStoreFor(req, reply);
  // PRO-002: on the PUBLIC profile routes an id the router refuses (too long, or a malformed percent-escape) is "not a profile id" like any other malformed id: the same 404 (a 400 would tell it apart)
  if (PUBLIC_PROFILE_PATH.test((req.url.split(/[?#]/)[0] ?? '').toLowerCase()))
    return void reply
      .header(CORRELATION_HEADER, correlationId)
      .status(ERROR_STATUS.NOT_FOUND)
      .send(body({ correlationId }, 'NOT_FOUND', 'PROFILE_NOT_FOUND', 'The profile was not found', { messageKey: profileErrorKey('PROFILE_NOT_FOUND') }));
  void reply
    .header(CORRELATION_HEADER, correlationId)
    .status(ERROR_STATUS.VALIDATION)
    .send(body({ correlationId }, 'VALIDATION', code, message));
};

/** Maps every failure to the standard error envelope. Stack traces are logged, never returned. */
export const errorPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.setNotFoundHandler((req, reply) => {
    noStoreFor(req, reply);
    reply.status(404).send(body(req, 'NOT_FOUND', 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`));
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    noStoreFor(req, reply);
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.status).send(body(req, err.category, err.code, err.message, err.details));
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply.status(400).send(
        body(req, 'VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
          issues: fe.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        }),
      );
    }
    if (fe.statusCode === 429) return reply.status(429).send(body(req, 'RATE_LIMIT', 'RATE_LIMITED', 'Too many requests'));
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send(body(req, 'VALIDATION', 'BAD_REQUEST', 'Bad request'));
    }
    log('error', 'unhandled error', { error: fe.message, stack: fe.stack });
    return reply.status(ERROR_STATUS.INTERNAL).send(body(req, 'INTERNAL', 'INTERNAL_ERROR', 'An unexpected error occurred'));
  });
});
