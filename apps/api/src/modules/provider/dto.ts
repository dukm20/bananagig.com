// Provider registration API shaping and error mapping (PRO-001). Every mapper builds the response field by field: the service already shapes its view, but the API never relies
// on that alone. Nothing here carries a contact, a legal text, a name or a document: the steps carry statuses, owners and content KEYS (the web resolves the wording).
import {
  OnboardingStep as OnboardingStepSchema,
  providerErrorKey,
  providerStepLabelKey,
  providerStepStatusKey,
  type OnboardingStepDto,
  type ProviderErrorCode,
  type ProviderRegistrationDto,
  type ProviderRegistrationStateDto,
  type ProviderRequirementsDto,
} from '@bananagig/contracts';
import { ProviderError, type RegistrationState, type RegistrationView, type Requirements } from '@bananagig/provider';
import { AppError } from '../../errors';

export function registrationDto(v: RegistrationView): ProviderRegistrationDto {
  return {
    providerRegistrationId: v.providerRegistrationId,
    attempt: v.attempt,
    status: v.status,
    revision: v.revision,
    marketCode: v.marketCode,
    serviceTypeCodes: [...v.serviceTypeCodes],
    createdAt: v.createdAt,
    completedAt: v.completedAt,
    cancelledAt: v.cancelledAt,
  };
}
export function stateDto(s: RegistrationState): ProviderRegistrationStateDto {
  return { providerRole: s.providerRole, registration: s.registration ? registrationDto(s.registration) : null };
}
export function requirementsDto(r: Requirements): ProviderRequirementsDto {
  return {
    providerRole: r.providerRole,
    registration: r.registration ? registrationDto(r.registration) : null,
    steps: r.steps.map((s): OnboardingStepDto => ({
      step: s.step,
      status: s.status,
      owner: s.owner,
      labelKey: providerStepLabelKey(s.step),
      statusKey: providerStepStatusKey(s.status),
      ...(s.detail ? { detail: { ...s.detail } } : {}),
    })),
    overall: {
      registrationComplete: r.overall.registrationComplete,
      registrationReady: r.overall.registrationReady,
      blockedBy: [...r.overall.blockedBy],
      goLive: { evaluated: false, eligible: false },
    },
  };
}

/**
 * The ONLY service details that reach a client: an ALLOW-list of short machine tokens (`reason`, `field`, `retryable`), the open step names, the service type codes that are not
 * offered (at most 20) and the configured bounds. Anything else a future service change might put in `details` (a cause, SQL, a value) is dropped here.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const STEP = new Set<string>(OnboardingStepSchema.options);
export function safeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reason', 'field', 'step'] as const) {
    const v = details[key];
    if (typeof v === 'string' && SAFE_TOKEN.test(v.slice(0, 64))) out[key] = v.slice(0, 64);
  }
  if (details.retryable === true) out.retryable = true;
  if (Array.isArray(details.steps)) {
    const steps = details.steps.filter((s): s is string => typeof s === 'string' && STEP.has(s));
    if (steps.length > 0) out.steps = steps;
  }
  if (Array.isArray(details.codes)) {
    const codes = details.codes.filter((c): c is string => typeof c === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(c)).slice(0, 20);
    if (codes.length > 0) out.codes = codes;
  }
  for (const key of ['min', 'max'] as const) {
    const v = details[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000) out[key] = v;
  }
  return out;
}

const MESSAGES: Record<ProviderErrorCode, { category: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'DEPENDENCY'; message: string }> = {
  REGISTRATION_NOT_FOUND: { category: 'NOT_FOUND', message: 'The provider registration was not started' },
  REGISTRATION_NOT_IN_PROGRESS: { category: 'CONFLICT', message: 'The registration is no longer in progress' },
  ROLE_INACTIVE: { category: 'CONFLICT', message: 'The provider role is inactive' },
  ACCOUNT_NOT_ACTIVE: { category: 'CONFLICT', message: 'The account is not active' },
  PREREQUISITE_NOT_MET: { category: 'CONFLICT', message: 'A prerequisite step is not complete' },
  MARKET_NOT_ELIGIBLE: { category: 'VALIDATION', message: 'Provider registration is not open in that market' },
  MARKET_REQUIRED: { category: 'CONFLICT', message: 'Choose where you work first' },
  SERVICE_TYPE_NOT_ELIGIBLE: { category: 'VALIDATION', message: 'A selected service type is not available' },
  SERVICE_COUNT_OUT_OF_RANGE: { category: 'VALIDATION', message: 'The number of selected service types is outside the allowed range' },
  REGISTRATION_INCOMPLETE: { category: 'CONFLICT', message: 'Some registration steps are still open' },
  STALE_REGISTRATION: { category: 'CONFLICT', message: 'The registration changed since it was read' },
  VALIDATION_FAILED: { category: 'VALIDATION', message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', message: 'Provider registration is temporarily unavailable' },
};

/** Maps typed registration failures onto the standard API error model: fixed messages, a message KEY for the web, and allow-listed details. */
export function toAppError(err: unknown): never {
  if (!(err instanceof ProviderError)) throw err;
  const m = MESSAGES[err.code];
  const details = { ...safeDetails(err.details), messageKey: providerErrorKey(err.code) };
  if (err.code === 'UNAVAILABLE') throw new AppError('DEPENDENCY', 'PROVIDER_UNAVAILABLE', m.message, { messageKey: providerErrorKey(err.code) });
  throw new AppError(m.category, `PROVIDER_${err.code}`, m.message, details);
}
