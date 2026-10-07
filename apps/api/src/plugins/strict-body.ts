// Strict request bodies. Fastify's Ajv runs with type coercion on (query strings need it), so a JSON body is coerced BEFORE a route's own schema sees
// it: {"active":1} becomes true, "1e3" becomes 1000. `strictBody` validates the RAW parsed body with the strict contract (zod) in a preValidation
// hook, ahead of Ajv, so a body is exactly the contract or it is rejected with the standard validation envelope. List it AFTER the authorization
// hook, so 401 and 403 still win over 400. The issues carry paths and fixed messages only: a rejected value is never echoed (a body may hold personal data).
import type { preValidationAsyncHookHandler } from 'fastify';
import type { ZodType } from 'zod';
import { AppError } from '../errors';

/** Parses a body with a contract schema; a failure is the standard VALIDATION_FAILED envelope (paths and messages, never values). */
export const parseBody = <T>(schema: ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
};

export const strictBody =
  <T>(schema: ZodType<T>): preValidationAsyncHookHandler =>
  async (req) => {
    parseBody(schema, req.body);
  };
