import type { ContentErrorCode } from '@bananagig/contracts';

/**
 * Typed content failure. Never carries copy text or variable values (they may be personal data): `details` holds identifiers,
 * positions and machine-readable reasons only. Template and variable problems use code TEMPLATE_ERROR with `details.reason`
 * (SYNTAX, FORBIDDEN_CHARACTER, LIMIT, UNKNOWN_VARIABLE, MISSING_REQUIRED_VARIABLE, INVALID_VARIABLE_VALUE, PLURAL_REQUIRES_COUNT,
 * UNSAFE_LINK, UNSAFE_HTML, CONTENT_TYPE_RULE).
 */
export class ContentError extends Error {
  constructor(
    public readonly code: ContentErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

/** Convenience for the many TEMPLATE_ERROR sites. */
export function templateError(reason: string, message: string, details: Record<string, unknown> = {}): ContentError {
  return new ContentError('TEMPLATE_ERROR', message, { reason, ...details });
}
