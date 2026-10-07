import type { AccountErrorCode } from '@bananagig/contracts';

/**
 * Typed account failure. `details` holds identifiers (codes, field names, status names) and machine-readable reasons only; it never carries a
 * token, a Keycloak subject, a name, SQL or any other personal or internal value.
 */
export class AccountError extends Error {
  constructor(
    public readonly code: AccountErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AccountError';
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
 * Whether an error means "the database could not answer" (connection failure, pool exhaustion, timeout, server shutdown). Typed errors, programming
 * errors and SQL-level rejections (data, integrity, syntax classes) are NOT outages.
 */
export function isDatabaseOutage(err: unknown): boolean {
  if (err instanceof AccountError) return false;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (CONNECTIVITY_CODES.has(code) || /^(08|53|57|58)[0-9A-Z]{3}$/.test(code))) return true;
  if (typeof code === 'string' && /^(22|23|25|40|42)[0-9A-Z]{3}$/.test(code)) return false;
  return err instanceof Error && /connect|connection|timeout|timed out|terminat|socket|ECONN/i.test(err.message);
}
