// Public contracts of the configuration registry (docs/engineering/CONFIGURATION.md). Operational values only: no secrets.
import { z } from 'zod';
import { envelope } from './envelope';

// ---------------------------------------------------------------- scope hierarchy
/** Canonical precedence, least to most specific. The database table configuration.scope_levels carries the same ranks (tested). */
export const SCOPE_TYPES = ['PLATFORM', 'COUNTRY', 'MARKET', 'CATEGORY', 'PLAN', 'PROVIDER', 'GIG', 'DROP'] as const;
export const ScopeType = z.enum(SCOPE_TYPES);
export type ScopeType = z.infer<typeof ScopeType>;
export const scopeRank = (s: ScopeType): number => SCOPE_TYPES.indexOf(s);

const scopeRef = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
/** Evaluation context: which scope instance applies at each level. PLATFORM always applies. */
export const ConfigContext = z
  .object({ country: scopeRef, market: scopeRef, category: scopeRef, plan: scopeRef, provider: scopeRef, gig: scopeRef, drop: scopeRef })
  .partial()
  .strict();
export type ConfigContext = z.infer<typeof ConfigContext>;

// ---------------------------------------------------------------- definitions
export const DATA_TYPES = ['STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION', 'MONEY', 'JSON'] as const;
export const DataType = z.enum(DATA_TYPES);
export type DataType = z.infer<typeof DataType>;
export const Sensitivity = z.enum(['PUBLIC', 'INTERNAL', 'SENSITIVE']);
export type Sensitivity = z.infer<typeof Sensitivity>;
export const ApprovalPolicy = z.enum(['NONE', 'OWNER_APPROVAL', 'SECOND_APPROVER']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;
export const Criticality = z.enum(['STANDARD', 'CRITICAL']);
export type Criticality = z.infer<typeof Criticality>;
export const CHANGE_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'REJECTED', 'SUPERSEDED', 'CANCELLED'] as const;
export const ChangeState = z.enum(CHANGE_STATES);
export type ChangeState = z.infer<typeof ChangeState>;

/** Canonical JSON encodings of typed values. DURATION is integer + unit (no calendar units: months/years are ambiguous). */
export const DURATION_UNITS = ['SECONDS', 'MINUTES', 'HOURS', 'DAYS'] as const;
export const DurationValue = z.object({ amount: z.number().int().nonnegative(), unit: z.enum(DURATION_UNITS) }).strict();
export const MoneyValue = z.object({ amount_minor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type DurationValue = z.infer<typeof DurationValue>;
export type MoneyValue = z.infer<typeof MoneyValue>;

/** Type-specific validation metadata. min/max use the canonical encoding of the parameter's type. */
export const ValidationRules = z
  .object({
    min: z.unknown(),
    max: z.unknown(),
    enum: z.array(z.string()).min(1),
    pattern: z.string().max(500),
    minLength: z.number().int().nonnegative(),
    maxLength: z.number().int().positive(),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    schema: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();
export type ValidationRules = z.infer<typeof ValidationRules>;

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/)
  .max(120);
export const CreateParameterRequest = z.object({
  key,
  dataType: DataType,
  unit: z.string().max(40).nullable().optional(),
  description: z.string().min(1).max(500),
  ownerRole: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  validationRules: ValidationRules.optional(),
  sensitivity: Sensitivity.optional(),
  approvalPolicy: ApprovalPolicy,
  criticality: Criticality.optional(),
  isRequired: z.boolean().optional(),
  /** Scope levels (besides PLATFORM, which is always allowed) at which this parameter may be overridden. */
  allowedOverrideScopes: z.array(ScopeType).default([]),
});
export type CreateParameterRequest = z.infer<typeof CreateParameterRequest>;

export const ParameterDto = z.object({
  parameterId: z.string(),
  key: z.string(),
  dataType: DataType,
  unit: z.string().nullable(),
  description: z.string(),
  ownerRole: z.string(),
  validationRules: z.record(z.string(), z.unknown()),
  sensitivity: Sensitivity,
  approvalPolicy: ApprovalPolicy,
  criticality: Criticality,
  isRequired: z.boolean(),
  isActive: z.boolean(),
  allowedScopes: z.array(ScopeType),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ParameterDto = z.infer<typeof ParameterDto>;

// ---------------------------------------------------------------- change requests
export const CreateChangeRequest = z.object({
  parameterKey: key,
  scopeType: ScopeType,
  scopeRef: scopeRef.nullish(),
  value: z.unknown(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveTo: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().min(1).max(1000),
});
export type CreateChangeRequest = z.infer<typeof CreateChangeRequest>;
export const DecisionRequest = z.object({ comment: z.string().max(1000).optional() });
export const ChangeRequestDto = z.object({
  changeRequestId: z.string(),
  parameterKey: z.string(),
  scopeType: ScopeType,
  scopeRef: z.string().nullable(),
  /** null (with redacted=true) for SENSITIVE parameters. */
  proposedValue: z.unknown().nullable(),
  redacted: z.boolean(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  reason: z.string(),
  requestedBy: z.string(),
  approvalPolicy: ApprovalPolicy,
  state: ChangeState,
  version: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeRequestDto = z.infer<typeof ChangeRequestDto>;

// ---------------------------------------------------------------- resolution and snapshots
export const ResolveRequest = z.object({
  keys: z.array(key).min(1).max(100),
  context: ConfigContext.default({}),
  at: z.string().datetime({ offset: true }).optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;
export const ResolvedValueDto = z.object({
  key: z.string(),
  parameterId: z.string(),
  value: z.unknown().nullable(),
  redacted: z.boolean(),
  sourceScope: ScopeType,
  scopeRef: z.string().nullable(),
  version: z.number().int(),
  effectiveFrom: z.string(),
});
export type ResolvedValueDto = z.infer<typeof ResolvedValueDto>;
export const ResolveResponse = envelope(z.object({ evaluatedAt: z.string(), values: z.array(ResolvedValueDto) }));
export const CreateSnapshotRequest = z.object({
  keys: z.array(key).min(1).max(100),
  context: ConfigContext.default({}),
  at: z.string().datetime({ offset: true }).optional(),
  purpose: z.string().min(1).max(200),
});
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequest>;
export const SnapshotDto = z.object({
  snapshotId: z.string(),
  evaluatedAt: z.string(),
  context: ConfigContext,
  purpose: z.string(),
  createdAt: z.string(),
  items: z.array(ResolvedValueDto),
});
export type SnapshotDto = z.infer<typeof SnapshotDto>;

export const ParameterResponse = envelope(ParameterDto);
export const ParameterListResponse = envelope(z.array(ParameterDto));
export const ChangeRequestResponse = envelope(ChangeRequestDto);
export const ChangeRequestListResponse = envelope(z.array(ChangeRequestDto));
export const SnapshotResponse = envelope(SnapshotDto);

// ---------------------------------------------------------------- events (published through the transactional outbox)
export const CONFIGURATION_EVENTS = {
  changeRequested: 'bananagig.configuration.change-requested.v1',
  changeApproved: 'bananagig.configuration.change-approved.v1',
  changeRejected: 'bananagig.configuration.change-rejected.v1',
  scheduled: 'bananagig.configuration.scheduled.v1',
  activated: 'bananagig.configuration.activated.v1',
} as const;
/** Payloads carry identifiers and metadata only, never values (values may be sensitive). */
export const ConfigurationEventPayload = z.object({
  changeRequestId: z.string(),
  parameterKey: z.string(),
  scopeType: ScopeType,
  scopeRef: z.string().nullable(),
  effectiveFrom: z.string(),
  version: z.number().int().optional(),
});
export type ConfigurationEventPayload = z.infer<typeof ConfigurationEventPayload>;

/** Typed configuration error codes (mapped to the standard API error model by the API layer). */
export const CONFIGURATION_ERROR_CODES = [
  'PARAMETER_NOT_FOUND',
  'NO_VALUE',
  'VALIDATION_FAILED',
  'SCOPE_NOT_ALLOWED',
  'CONFLICT',
  'INVALID_STATE',
  'FORBIDDEN_APPROVER',
  'NOT_FOUND',
  'UNAVAILABLE',
] as const;
export type ConfigurationErrorCode = (typeof CONFIGURATION_ERROR_CODES)[number];
