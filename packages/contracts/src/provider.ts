// Public contracts of the provider registration (PRO-001, docs/engineering/PROVIDER_REGISTRATION.md). A provider is NOT a second account: one BananaGig account holds the
// application roles CUSTOMER and PROVIDER (ID-001), and provider registration is provider-domain state about that account. Three concepts stay separate:
//   1. the application ROLE (identity.account_roles: PENDING / ACTIVE / INACTIVE): may this account act as PROVIDER?
//   2. the provider REGISTRATION (this module): where is the account in onboarding?
//   3. GO-LIVE eligibility (PRO-003, not here): can the provider receive marketplace work?
// Nothing here carries an email, a phone, a name, an address or a legal text: contact and consent state are read from their owners and never copied.
import { z } from 'zod';
import { CatalogCode } from './catalog';
import { envelope } from './envelope';
import { GEO_STATUSES, MarketCode } from './geography';

// ---------------------------------------------------------------- vocabularies
/**
 * IN_PROGRESS -> COMPLETED (submit, server-validated) | CANCELLED. COMPLETED and CANCELLED are terminal; a cancelled account restarts as a NEW attempt (history kept). There is
 * deliberately no SUBMITTED state: nothing reviews a submission yet, so it would be a state nothing can reach (adding it later is a CHECK change).
 */
export const PROVIDER_REGISTRATION_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export const ProviderRegistrationStatus = z.enum(PROVIDER_REGISTRATION_STATUSES);
export type ProviderRegistrationStatus = z.infer<typeof ProviderRegistrationStatus>;
export const isProviderRegistrationTransitionAllowed = (from: ProviderRegistrationStatus, to: ProviderRegistrationStatus): boolean =>
  from === 'IN_PROGRESS' && (to === 'COMPLETED' || to === 'CANCELLED');

/** The PROVIDER membership of the account as the registration sees it: NONE (no membership) or the ID-001 membership status. It is NOT a second source of truth. */
export const PROVIDER_ROLE_STATES = ['NONE', 'PENDING', 'ACTIVE', 'INACTIVE'] as const;
export const ProviderRoleState = z.enum(PROVIDER_ROLE_STATES);
export type ProviderRoleState = z.infer<typeof ProviderRoleState>;

/** The onboarding steps, in order. Only MARKET and SERVICES are persisted by PRO-001; the others are DERIVED from the domain that owns them. */
export const ONBOARDING_STEPS = ['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES', 'VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS'] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;
/** The steps PRO-001 owns or composes from existing domains: registration can complete when each is COMPLETE or NOT_REQUIRED. */
export const REGISTRATION_STEPS = ['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES'] as const;
/** The steps of future domains (TRUST-001, SUB, PRO-002, CAT-003): reported, never required for registration, never persisted here. */
export const FUTURE_STEPS = ['VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS'] as const;

export const ONBOARDING_STEP_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'NOT_AVAILABLE', 'NOT_REQUIRED'] as const;
export const OnboardingStepStatus = z.enum(ONBOARDING_STEP_STATUSES);
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatus>;
/** A step that no longer stands in the way of submitting. */
export const isStepSatisfied = (s: OnboardingStepStatus): boolean => s === 'COMPLETE' || s === 'NOT_REQUIRED';

// ---------------------------------------------------------------- managed content keys (CFG-002)
export const providerStepLabelKey = (step: OnboardingStep): string => `provider.registration.step.${step.toLowerCase()}.label`;
export const providerStepStatusKey = (status: OnboardingStepStatus): string => `provider.registration.step_status.${status.toLowerCase()}`;
export const providerRegistrationStatusKey = (status: ProviderRegistrationStatus): string => `provider.registration.status.${status.toLowerCase()}`;
export const providerRoleStateKey = (state: ProviderRoleState): string => `provider.registration.role.${state.toLowerCase()}`;
export const providerErrorKey = (code: ProviderErrorCode): string => `provider.registration.error.${code.toLowerCase()}`;

// ---------------------------------------------------------------- policy (configuration, never code)
export const PROVIDER_POLICY_KEYS = {
  requireVerifiedEmail: 'provider.registration.require_verified_email',
  requireVerifiedPhone: 'provider.registration.require_verified_phone',
  marketStatusesAllowed: 'provider.registration.market_statuses_allowed',
  minServiceTypes: 'provider.registration.min_service_types',
  maxServiceTypes: 'provider.registration.max_service_types',
} as const;
/** Structural ceiling of the service type list of one request/registration (the configured maximum must not exceed it). */
export const PROVIDER_SERVICE_TYPES_CEILING = 50;
export const ProviderRegistrationPolicy = z
  .object({
    requireVerifiedEmail: z.boolean(),
    requireVerifiedPhone: z.boolean(),
    marketStatusesAllowed: z.array(z.enum(GEO_STATUSES)).min(1).max(GEO_STATUSES.length),
    minServiceTypes: z.number().int().min(0).max(PROVIDER_SERVICE_TYPES_CEILING),
    maxServiceTypes: z.number().int().min(1).max(PROVIDER_SERVICE_TYPES_CEILING),
  })
  .strict()
  .refine((p) => p.minServiceTypes <= p.maxServiceTypes, { message: 'min_service_types must not exceed max_service_types' })
  .refine((p) => new Set(p.marketStatusesAllowed).size === p.marketStatusesAllowed.length, { message: 'market statuses must be unique' });
export type ProviderRegistrationPolicy = z.infer<typeof ProviderRegistrationPolicy>;

// ---------------------------------------------------------------- requests (strict; the account is the caller's, never in a body or path)
const expectedRevision = z.number().int().min(1).max(2_147_483_647);
export const StartProviderRegistrationRequest = z.object({}).strict();
export type StartProviderRegistrationRequest = z.infer<typeof StartProviderRegistrationRequest>;
/** `expectedRevision`, when present, must be the revision last read (a different one is 409 STALE_REGISTRATION). */
export const SelectProviderMarketRequest = z.object({ marketCode: MarketCode, expectedRevision: expectedRevision.optional() }).strict();
export type SelectProviderMarketRequest = z.infer<typeof SelectProviderMarketRequest>;
/** Replaces the WHOLE set of selected service types (service type codes of the catalogue). */
export const ReplaceProviderServicesRequest = z
  .object({
    serviceTypeCodes: z.array(CatalogCode).max(PROVIDER_SERVICE_TYPES_CEILING),
    expectedRevision: expectedRevision.optional(),
  })
  .strict()
  .refine((r) => new Set(r.serviceTypeCodes).size === r.serviceTypeCodes.length, { message: 'service types must be unique', path: ['serviceTypeCodes'] });
export type ReplaceProviderServicesRequest = z.infer<typeof ReplaceProviderServicesRequest>;
export const SubmitProviderRegistrationRequest = z.object({ expectedRevision }).strict();
export type SubmitProviderRegistrationRequest = z.infer<typeof SubmitProviderRegistrationRequest>;
/** Cancelling takes no input: free text would end up in the immutable audit trail. */
export const CancelProviderRegistrationRequest = z.object({}).strict();
export type CancelProviderRegistrationRequest = z.infer<typeof CancelProviderRegistrationRequest>;
export const ProviderRequirementsQuery = z.object({ locale: z.string().min(2).max(35).optional() }).strict();

// ---------------------------------------------------------------- read models
export const ProviderRegistrationDto = z.object({
  providerRegistrationId: z.string(),
  /** 1, 2, 3 ... per account: a cancelled attempt is kept and a restart is the next number. */
  attempt: z.number().int(),
  status: ProviderRegistrationStatus,
  /** Concurrency token of the selections (bumped by every change while IN_PROGRESS). */
  revision: z.number().int(),
  marketCode: z.string().nullable(),
  serviceTypeCodes: z.array(z.string()),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type ProviderRegistrationDto = z.infer<typeof ProviderRegistrationDto>;
export const ProviderRegistrationStateDto = z.object({
  providerRole: ProviderRoleState,
  /** The latest attempt (any status), or null when the account never started. */
  registration: ProviderRegistrationDto.nullable(),
});
export type ProviderRegistrationStateDto = z.infer<typeof ProviderRegistrationStateDto>;
export const ProviderRegistrationStateResponse = envelope(ProviderRegistrationStateDto);

/** Small, typed facts about a step (identifiers and counts only; never an address, a number or a document). */
export const OnboardingStepDetailDto = z
  .object({
    email: z.enum(['VERIFIED', 'NOT_VERIFIED', 'NOT_REQUIRED']).optional(),
    phone: z.enum(['VERIFIED', 'NOT_VERIFIED', 'NOT_REQUIRED']).optional(),
    outstandingPurposes: z.array(z.string()).optional(),
    marketCode: z.string().optional(),
    selected: z.number().int().optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    notOffered: z.array(z.string()).optional(),
  })
  .strict();
export type OnboardingStepDetailDto = z.infer<typeof OnboardingStepDetailDto>;
export const OnboardingStepDto = z.object({
  step: OnboardingStep,
  status: OnboardingStepStatus,
  /** The checkpoint or domain that owns the state: PRO-001 steps are composed from their owners, future steps belong to later checkpoints. */
  owner: z.string(),
  labelKey: z.string(),
  statusKey: z.string(),
  detail: OnboardingStepDetailDto.optional(),
});
export type OnboardingStepDto = z.infer<typeof OnboardingStepDto>;
export const ProviderRequirementsDto = z.object({
  providerRole: ProviderRoleState,
  registration: ProviderRegistrationDto.nullable(),
  steps: z.array(OnboardingStepDto),
  overall: z.object({
    /** The registration is COMPLETED. */
    registrationComplete: z.boolean(),
    /** Every step PRO-001 owns or composes is COMPLETE or NOT_REQUIRED: the registration can be submitted. */
    registrationReady: z.boolean(),
    /** The steps that stand in the way of submitting. */
    blockedBy: z.array(OnboardingStep),
    /** Go-Live is PRO-003's: never true here. */
    goLive: z.object({ evaluated: z.literal(false), eligible: z.literal(false) }),
  }),
});
export type ProviderRequirementsDto = z.infer<typeof ProviderRequirementsDto>;
export const ProviderRequirementsResponse = envelope(ProviderRequirementsDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers only)
export const PROVIDER_EVENTS = {
  registrationStarted: 'bananagig.provider.registration-started.v1',
  registrationCompleted: 'bananagig.provider.registration-completed.v1',
  registrationCancelled: 'bananagig.provider.registration-cancelled.v1',
} as const;
export const ProviderRegistrationEventPayload = z.object({ accountId: z.string(), providerRegistrationId: z.string(), attempt: z.number().int() });
export type ProviderRegistrationEventPayload = z.infer<typeof ProviderRegistrationEventPayload>;
export const ProviderRegistrationCompletedPayload = ProviderRegistrationEventPayload.extend({
  marketCode: z.string(),
  serviceTypeCodes: z.array(z.string()),
});
export type ProviderRegistrationCompletedPayload = z.infer<typeof ProviderRegistrationCompletedPayload>;

// ---------------------------------------------------------------- errors
export const PROVIDER_ERROR_CODES = [
  'REGISTRATION_NOT_FOUND',
  'REGISTRATION_NOT_IN_PROGRESS',
  'ROLE_INACTIVE',
  'ACCOUNT_NOT_ACTIVE',
  'PREREQUISITE_NOT_MET',
  'MARKET_NOT_ELIGIBLE',
  'MARKET_REQUIRED',
  'SERVICE_TYPE_NOT_ELIGIBLE',
  'SERVICE_COUNT_OUT_OF_RANGE',
  'REGISTRATION_INCOMPLETE',
  'STALE_REGISTRATION',
  'VALIDATION_FAILED',
  'CONFLICT',
  'UNAVAILABLE',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];
