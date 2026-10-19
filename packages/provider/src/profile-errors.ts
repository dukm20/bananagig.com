import type { ProfileErrorCode } from '@bananagig/contracts';

/**
 * Typed profile failure. `details` holds identifiers (codes, field names, reasons, counts) and nothing the provider typed: no display name, bio or photo fact, no SQL, no object key.
 */
export class ProfileError extends Error {
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}
