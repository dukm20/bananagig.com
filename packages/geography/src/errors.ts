import type { GeographyErrorCode } from '@bananagig/contracts';

/**
 * Typed geography failure. `details` holds identifiers (codes, field names, constraint names) and machine-readable reasons only; it never
 * carries secrets, driver messages, SQL or other internals.
 */
export class GeographyError extends Error {
  constructor(
    public readonly code: GeographyErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GeographyError';
  }
}

const CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Whether an error means "the database could not answer" (connection failure, pool exhaustion, timeout, server shutdown). Typed errors,
 * programming errors and SQL-level rejections (data, integrity, syntax classes) are NOT outages.
 */
export function isDatabaseOutage(err: unknown): boolean {
  if (err instanceof GeographyError) return false;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (CONNECTIVITY_CODES.has(code) || /^(08|53|57|58)[0-9A-Z]{3}$/.test(code))) return true;
  if (typeof code === 'string' && /^(22|23|25|40|42)[0-9A-Z]{3}$/.test(code)) return false;
  return err instanceof Error && /connect|connection|timeout|timed out|terminat|socket|ECONN/i.test(err.message);
}
