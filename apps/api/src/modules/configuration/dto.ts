import type { ChangeRequestDto, ParameterDto, ResolvedValueDto, SnapshotDto } from '@bananagig/contracts';
import { ConfigurationError, redactValue, type ChangeRequest, type Parameter, type Resolved, type Snapshot } from '@bananagig/configuration';
import { AppError } from '../../errors';

const iso = (d: Date): string => d.toISOString();

export const parameterDto = (p: Parameter): ParameterDto => ({
  ...p,
  unit: p.unit,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
  parameterId: p.parameterId,
});

/** SENSITIVE values are never returned by the ordinary read API: value is null and `redacted` is true. */
export const resolvedDto = (r: Resolved): ResolvedValueDto => ({
  key: r.key,
  parameterId: r.parameterId,
  ...redactValue(r.sensitivity, r.value),
  sourceScope: r.sourceScope,
  scopeRef: r.scopeRef,
  version: r.version,
  effectiveFrom: iso(r.effectiveFrom),
});

export const snapshotDto = (s: Snapshot): SnapshotDto => ({
  snapshotId: s.snapshotId,
  evaluatedAt: iso(s.evaluatedAt),
  context: s.context,
  purpose: s.purpose,
  createdAt: iso(s.createdAt),
  items: s.items.map(resolvedDto),
});

export const changeRequestDto = (c: ChangeRequest): ChangeRequestDto => {
  const { value, redacted } = redactValue(c.sensitivity, c.proposedValue);
  return {
    changeRequestId: c.changeRequestId,
    parameterKey: c.parameterKey,
    scopeType: c.scopeType,
    scopeRef: c.scopeRef,
    proposedValue: value,
    redacted,
    effectiveFrom: iso(c.effectiveFrom),
    effectiveTo: c.effectiveTo ? iso(c.effectiveTo) : null,
    reason: c.reason,
    requestedBy: c.requestedBy,
    approvalPolicy: c.approvalPolicy,
    state: c.state,
    version: c.version,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
};

/** Maps typed configuration failures onto the standard API error model. Driver causes are never exposed. */
export function toAppError(err: unknown): never {
  if (!(err instanceof ConfigurationError)) throw err;
  const { cause: _cause, ...details } = err.details;
  switch (err.code) {
    case 'PARAMETER_NOT_FOUND':
    case 'NOT_FOUND':
      throw new AppError('NOT_FOUND', 'CONFIGURATION_NOT_FOUND', err.message, details);
    case 'NO_VALUE':
      throw new AppError('NOT_FOUND', 'CONFIGURATION_VALUE_NOT_FOUND', err.message, details);
    case 'VALIDATION_FAILED':
    case 'SCOPE_NOT_ALLOWED':
      throw new AppError(
        'VALIDATION',
        err.code === 'SCOPE_NOT_ALLOWED' ? 'CONFIGURATION_SCOPE_NOT_ALLOWED' : 'CONFIGURATION_VALIDATION_FAILED',
        err.message,
        details,
      );
    case 'CONFLICT':
    case 'INVALID_STATE':
      throw new AppError('CONFLICT', err.code === 'CONFLICT' ? 'CONFIGURATION_CONFLICT' : 'CONFIGURATION_INVALID_STATE', err.message, details);
    case 'FORBIDDEN_APPROVER':
      throw new AppError('AUTHORIZATION', 'CONFIGURATION_FORBIDDEN_APPROVER', err.message);
    case 'UNAVAILABLE':
      throw new AppError('DEPENDENCY', 'CONFIGURATION_UNAVAILABLE', 'The configuration registry is temporarily unavailable');
  }
}
