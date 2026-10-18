import type { GigErrorCode } from '@bananagig/contracts';

/**
 * Typed Gig failure. `details` holds identifiers (codes, field keys, reasons, counts) and nothing the provider typed: no title, pitch, description or text value, no SQL.
 */
export class GigError extends Error {
  constructor(
    public readonly code: GigErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GigError';
  }
}
