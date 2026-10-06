import { ERROR_STATUS, type ErrorCategory } from '@bananagig/contracts';

/** Throw from handlers/services to produce a standardized error response. Business error codes arrive with features. */
export class AppError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    /** Extra response headers, e.g. WWW-Authenticate on 401. */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
  get status(): number {
    return ERROR_STATUS[this.category];
  }
}
