import type { ConfigurationErrorCode } from '@bananagig/contracts';

/** Typed configuration failure. Never carries values (they may be sensitive); details hold identifiers and reasons only. */
export class ConfigurationError extends Error {
  constructor(
    public readonly code: ConfigurationErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
