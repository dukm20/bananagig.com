import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ERROR_STATUS, type ErrorCategory, type ErrorResponse } from '@bananagig/contracts';
import { log } from '@bananagig/observability';
import { AppError } from '../errors';

const body = (req: { correlationId: string }, category: ErrorCategory, code: string, message: string, details?: Record<string, unknown>): ErrorResponse => ({
  error: { code, category, message, correlationId: req.correlationId, ...(details ? { details } : {}) },
});

/** Maps every failure to the standard error envelope. Stack traces are logged, never returned. */
export const errorPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(body(req, 'NOT_FOUND', 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`));
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
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
