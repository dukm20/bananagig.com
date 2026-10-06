import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CORRELATION_HEADER, ERROR_STATUS, type ErrorCategory, type ErrorResponse } from '@bananagig/contracts';
import { log, resolveCorrelationId } from '@bananagig/observability';
import { AppError } from '../errors';

const body = (req: { correlationId: string }, category: ErrorCategory, code: string, message: string, details?: Record<string, unknown>): ErrorResponse => ({
  error: { code, category, message, correlationId: req.correlationId, ...(details ? { details } : {}) },
});

/**
 * Fastify `frameworkErrors` handler: failures raised by the ROUTER before any hook runs (a malformed URL component, a path parameter longer
 * than maxParamLength). Without it Fastify answers with its own non-standard JSON body. No onRequest hook has run yet, so the correlation id is
 * resolved here the same way the correlation plugin does.
 */
export const frameworkErrors = (err: FastifyError, req: FastifyRequest, reply: FastifyReply): void => {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
  const code = err.code === 'FST_ERR_MAX_PARAM_LENGTH' ? 'PATH_PARAMETER_TOO_LONG' : 'BAD_URL';
  const message = code === 'BAD_URL' ? 'The request URL is not valid' : 'A path parameter exceeds the maximum allowed length';
  void reply
    .header(CORRELATION_HEADER, correlationId)
    .status(ERROR_STATUS.VALIDATION)
    .send(body({ correlationId }, 'VALIDATION', code, message));
};

/** Maps every failure to the standard error envelope. Stack traces are logged, never returned. */
export const errorPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(body(req, 'NOT_FOUND', 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`));
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
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
