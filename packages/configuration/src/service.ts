// The configuration registry service: definitions, change workflow, publication, activation, resolution and snapshots.
// Transaction boundaries live here. Events go through the transactional outbox, never directly to NATS.
import { randomUUID } from 'node:crypto';
import {
  CONFIGURATION_EVENTS,
  SCOPE_TYPES,
  type ApprovalPolicy,
  type ChangeState,
  type ConfigContext,
  type CreateChangeRequest,
  type CreateParameterRequest,
  type Criticality,
  type DataType,
  type ScopeType,
  type Sensitivity,
} from '@bananagig/contracts';
import { sql, type Database, type Trx } from '@bananagig/database';
import { getCorrelationId } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { invalidateParameter, resolveWithPolicy, type ConfigCache, type Source } from './cache';
import { ConfigurationError } from './errors';
import { assertComplete, resolveBatch, type Resolved } from './resolver';
import { validateDefinitionRules, validateValue } from './values';

type Row = Record<string, unknown>;

export interface Parameter {
  parameterId: string;
  key: string;
  dataType: DataType;
  unit: string | null;
  description: string;
  ownerRole: string;
  validationRules: Record<string, unknown>;
  sensitivity: Sensitivity;
  approvalPolicy: ApprovalPolicy;
  criticality: Criticality;
  isRequired: boolean;
  isActive: boolean;
  allowedScopes: ScopeType[];
  createdAt: Date;
  updatedAt: Date;
}
export interface ChangeRequest {
  changeRequestId: string;
  parameterId: string;
  parameterKey: string;
  sensitivity: Sensitivity;
  scopeType: ScopeType;
  scopeRef: string | null;
  proposedValue: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
  requestedBy: string;
  approvalPolicy: ApprovalPolicy;
  state: ChangeState;
  version: number | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface Snapshot {
  snapshotId: string;
  evaluatedAt: Date;
  context: ConfigContext;
  purpose: string;
  createdBy: string;
  createdAt: Date;
  items: Resolved[];
}

export interface ServiceDeps {
  database: Database;
  cache?: ConfigCache;
  env: string;
  cacheTtlSeconds?: number;
  lkgMaxAgeSeconds?: number;
  /** DEV/TEST only: permits `devtest.*` parameter keys. Must be false in production. */
  allowTestKeys?: boolean;
}

const mapParameter = (r: Row): Parameter => ({
  parameterId: r.parameter_id as string,
  key: r.key as string,
  dataType: r.data_type as DataType,
  unit: (r.unit as string | null) ?? null,
  description: r.description as string,
  ownerRole: r.owner_role as string,
  validationRules: r.validation_rules as Record<string, unknown>,
  sensitivity: r.sensitivity as Sensitivity,
  approvalPolicy: r.approval_policy as ApprovalPolicy,
  criticality: r.criticality as Criticality,
  isRequired: r.is_required as boolean,
  isActive: r.is_active as boolean,
  allowedScopes: ((r.allowed_scopes as string[] | null) ?? []) as ScopeType[],
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});
const mapChange = (r: Row): ChangeRequest => ({
  changeRequestId: r.change_request_id as string,
  parameterId: r.parameter_id as string,
  parameterKey: r.key as string,
  sensitivity: r.sensitivity as Sensitivity,
  scopeType: r.scope_type as ScopeType,
  scopeRef: (r.scope_ref as string | null) ?? null,
  proposedValue: r.proposed_value,
  effectiveFrom: r.effective_from as Date,
  effectiveTo: (r.effective_to as Date | null) ?? null,
  reason: r.reason as string,
  requestedBy: r.requested_by as string,
  approvalPolicy: r.approval_policy as ApprovalPolicy,
  state: r.state as ChangeState,
  version: (r.version as number | null) ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

/** Translates database constraint failures into typed errors. */
function mapDbError(err: unknown): never {
  if (err instanceof ConfigurationError) throw err;
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === '23P01')
    throw new ConfigurationError('CONFLICT', 'the value period overlaps an existing version for this scope', { constraint: e.constraint });
  if (e.code === '23505')
    throw new ConfigurationError('CONFLICT', 'a conflicting record already exists (duplicate key, version or decision)', { constraint: e.constraint });
  if (e.code === '23000' && /own change/.test(e.message ?? ''))
    throw new ConfigurationError('FORBIDDEN_APPROVER', 'the requester cannot approve their own change when a second approver is required');
  if (e.code === '23000') throw new ConfigurationError('INVALID_STATE', 'the operation violates an immutability or workflow rule');
  throw err;
}

const CHANGE_SELECT = sql`SELECT cr.*, p.key, p.sensitivity, vv.version
  FROM configuration.change_requests cr
  JOIN configuration.parameters p ON p.parameter_id = cr.parameter_id
  LEFT JOIN configuration.value_versions vv ON vv.version_id = cr.value_version_id`;

export class ConfigurationService {
  private readonly cacheTtl: number;
  private readonly lkgMax: number;

  constructor(private readonly d: ServiceDeps) {
    this.cacheTtl = d.cacheTtlSeconds ?? 30;
    this.lkgMax = d.lkgMaxAgeSeconds ?? 86_400;
  }

  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  private audit(
    trx: Trx,
    a: {
      actor: string;
      action: string;
      parameterId: string;
      changeRequestId?: string;
      oldVersionId?: string | null;
      newVersionId?: string | null;
      reason?: string | null;
    },
  ) {
    return sql`INSERT INTO configuration.audit_events (actor, action, parameter_id, change_request_id, old_version_id, new_version_id, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.parameterId}, ${a.changeRequestId ?? null}, ${a.oldVersionId ?? null}, ${a.newVersionId ?? null}, ${a.reason ?? null}, ${getCorrelationId() ?? randomUUID()})`.execute(
      trx,
    );
  }
  private event(
    trx: Trx,
    type: string,
    cr: { changeRequestId: string; parameterKey: string; scopeType: ScopeType; scopeRef: string | null; effectiveFrom: Date },
    actor: string,
    version?: number,
  ) {
    return insertOutboxEvent(trx, {
      aggregateType: 'configuration_change_request',
      aggregateId: cr.changeRequestId,
      eventType: type,
      actorType: 'user',
      actorId: actor,
      correlationId: getCorrelationId() ?? randomUUID(),
      payload: {
        changeRequestId: cr.changeRequestId,
        parameterKey: cr.parameterKey,
        scopeType: cr.scopeType,
        scopeRef: cr.scopeRef,
        effectiveFrom: cr.effectiveFrom.toISOString(),
        ...(version !== undefined ? { version } : {}),
      },
    });
  }

  // ------------------------------------------------------------------ definitions
  async createParameter(req: CreateParameterRequest, actor: string): Promise<Parameter> {
    if (req.key.startsWith('devtest.') && !this.d.allowTestKeys)
      throw new ConfigurationError('VALIDATION_FAILED', 'devtest.* keys are DEV/TEST only and not allowed in this environment');
    const rules = validateDefinitionRules(req.dataType, req.validationRules);
    const scopes = [...new Set<ScopeType>(['PLATFORM', ...req.allowedOverrideScopes])].sort((a, b) => SCOPE_TYPES.indexOf(a) - SCOPE_TYPES.indexOf(b));
    const id = await this.tx(async (trx) => {
      const r = await sql<{
        parameter_id: string;
      }>`INSERT INTO configuration.parameters (key, data_type, unit, description, owner_role, validation_rules, sensitivity, approval_policy, criticality, is_required, created_by)
        VALUES (${req.key}, ${req.dataType}, ${req.unit ?? null}, ${req.description}, ${req.ownerRole}, ${JSON.stringify(rules)}::jsonb, ${req.sensitivity ?? 'INTERNAL'}, ${req.approvalPolicy}, ${req.criticality ?? 'STANDARD'}, ${req.isRequired ?? true}, ${actor})
        RETURNING parameter_id`.execute(trx);
      const parameterId = r.rows[0]!.parameter_id;
      for (const s of scopes) await sql`INSERT INTO configuration.parameter_scopes (parameter_id, scope_type) VALUES (${parameterId}, ${s})`.execute(trx);
      await this.audit(trx, { actor, action: 'PARAMETER_CREATED', parameterId, reason: 'parameter definition created' });
      return parameterId;
    });
    return (await this.getParameterById(id))!;
  }

  private async getParameterById(id: string): Promise<Parameter | undefined> {
    const r = await sql<Row>`${PARAM_SELECT} WHERE p.parameter_id = ${id} GROUP BY p.parameter_id`.execute(this.d.database.db);
    return r.rows[0] ? mapParameter(r.rows[0]) : undefined;
  }
  async getParameter(key: string): Promise<Parameter> {
    const r = await sql<Row>`${PARAM_SELECT} WHERE p.key = ${key} GROUP BY p.parameter_id`.execute(this.d.database.db);
    if (!r.rows[0]) throw new ConfigurationError('PARAMETER_NOT_FOUND', 'configuration parameter not found', { key });
    return mapParameter(r.rows[0]);
  }
  async listParameters(): Promise<Parameter[]> {
    const r = await sql<Row>`${PARAM_SELECT} GROUP BY p.parameter_id ORDER BY p.key`.execute(this.d.database.db);
    return r.rows.map(mapParameter);
  }

  // ------------------------------------------------------------------ change requests
  async createChangeRequest(req: CreateChangeRequest, actor: string): Promise<ChangeRequest> {
    const p = await this.getParameter(req.parameterKey);
    if (!p.isActive) throw new ConfigurationError('PARAMETER_NOT_FOUND', 'configuration parameter is inactive', { key: p.key });
    if (!p.allowedScopes.includes(req.scopeType))
      throw new ConfigurationError('SCOPE_NOT_ALLOWED', `scope ${req.scopeType} is not an allowed override level for ${p.key}`, {
        key: p.key,
        scopeType: req.scopeType,
        allowed: p.allowedScopes,
      });
    if ((req.scopeType === 'PLATFORM') !== (req.scopeRef == null))
      throw new ConfigurationError(
        'VALIDATION_FAILED',
        req.scopeType === 'PLATFORM' ? 'PLATFORM scope takes no scopeRef' : `${req.scopeType} scope requires a scopeRef`,
      );
    const value = validateValue(p, req.value);
    const id = await this.tx(async (trx) => {
      const now = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t;
      const from = req.effectiveFrom ? new Date(req.effectiveFrom) : now;
      const to = req.effectiveTo ? new Date(req.effectiveTo) : null;
      if (from.getTime() < now.getTime() - 5000)
        throw new ConfigurationError('VALIDATION_FAILED', 'effectiveFrom cannot be in the past; corrections apply going forward');
      if (to && to <= from) throw new ConfigurationError('VALIDATION_FAILED', 'effectiveTo must be after effectiveFrom');
      const r = await sql<{
        change_request_id: string;
      }>`INSERT INTO configuration.change_requests (parameter_id, scope_type, scope_ref, proposed_value, effective_from, effective_to, reason, requested_by, approval_policy)
        VALUES (${p.parameterId}, ${req.scopeType}, ${req.scopeRef ?? null}, ${JSON.stringify(value)}::jsonb, ${from}, ${to}, ${req.reason}, ${actor}, ${p.approvalPolicy}) RETURNING change_request_id`.execute(
        trx,
      );
      await this.audit(trx, { actor, action: 'CHANGE_DRAFTED', parameterId: p.parameterId, changeRequestId: r.rows[0]!.change_request_id, reason: req.reason });
      return r.rows[0]!.change_request_id;
    });
    return this.getChangeRequest(id);
  }

  async getChangeRequest(id: string): Promise<ChangeRequest> {
    const r = await sql<Row>`${CHANGE_SELECT} WHERE cr.change_request_id = ${id}`.execute(this.d.database.db);
    if (!r.rows[0]) throw new ConfigurationError('NOT_FOUND', 'change request not found', { id });
    return mapChange(r.rows[0]);
  }
  async listChangeRequests(f: { state?: ChangeState; parameterKey?: string } = {}): Promise<ChangeRequest[]> {
    const r =
      await sql<Row>`${CHANGE_SELECT} WHERE (${f.state ?? null}::text IS NULL OR cr.state = ${f.state ?? null}) AND (${f.parameterKey ?? null}::text IS NULL OR p.key = ${f.parameterKey ?? null}) ORDER BY cr.created_at DESC LIMIT 200`.execute(
        this.d.database.db,
      );
    return r.rows.map(mapChange);
  }

  /** Locks the request row for the duration of the transaction (serializes approval, rejection, cancellation and publication). */
  private async lockChange(trx: Trx, id: string): Promise<ChangeRequest> {
    const r =
      await sql<Row>`SELECT cr.*, p.key, p.sensitivity, NULL::integer AS version FROM configuration.change_requests cr JOIN configuration.parameters p ON p.parameter_id = cr.parameter_id WHERE cr.change_request_id = ${id} FOR UPDATE OF cr`.execute(
        trx,
      );
    if (!r.rows[0]) throw new ConfigurationError('NOT_FOUND', 'change request not found', { id });
    return mapChange(r.rows[0]);
  }
  private setState(trx: Trx, id: string, state: ChangeState) {
    return sql`UPDATE configuration.change_requests SET state = ${state}, updated_at = now() WHERE change_request_id = ${id}`.execute(trx);
  }
  private need(cr: ChangeRequest, ...states: ChangeState[]): void {
    if (!states.includes(cr.state))
      throw new ConfigurationError('INVALID_STATE', `change request is ${cr.state}; expected ${states.join(' or ')}`, { state: cr.state });
  }

  /** DRAFT -> PENDING_APPROVAL (or APPROVED when the parameter policy is NONE). Only the requester may submit. */
  async submit(id: string, actor: string): Promise<ChangeRequest> {
    await this.tx(async (trx) => {
      const cr = await this.lockChange(trx, id);
      this.need(cr, 'DRAFT');
      if (cr.requestedBy !== actor) throw new ConfigurationError('FORBIDDEN_APPROVER', 'only the requester can submit a draft');
      const auto = cr.approvalPolicy === 'NONE';
      await this.setState(trx, id, auto ? 'APPROVED' : 'PENDING_APPROVAL');
      await this.audit(trx, { actor, action: 'CHANGE_SUBMITTED', parameterId: cr.parameterId, changeRequestId: id, reason: cr.reason });
      await this.event(trx, CONFIGURATION_EVENTS.changeRequested, cr, actor);
      if (auto) {
        await this.audit(trx, { actor, action: 'CHANGE_APPROVED', parameterId: cr.parameterId, changeRequestId: id, reason: 'approval policy NONE' });
        await this.event(trx, CONFIGURATION_EVENTS.changeApproved, cr, actor);
      }
    });
    return this.getChangeRequest(id);
  }

  async approve(id: string, actor: string, comment?: string): Promise<ChangeRequest> {
    await this.tx(async (trx) => {
      const cr = await this.lockChange(trx, id);
      this.need(cr, 'PENDING_APPROVAL');
      if (cr.approvalPolicy === 'SECOND_APPROVER' && cr.requestedBy === actor)
        throw new ConfigurationError('FORBIDDEN_APPROVER', 'the requester cannot approve their own change when a second approver is required');
      await sql`INSERT INTO configuration.change_approvals (change_request_id, approver, decision, comment) VALUES (${id}, ${actor}, 'APPROVE', ${comment ?? null})`.execute(
        trx,
      );
      await this.setState(trx, id, 'APPROVED');
      await this.audit(trx, { actor, action: 'CHANGE_APPROVED', parameterId: cr.parameterId, changeRequestId: id, reason: comment });
      await this.event(trx, CONFIGURATION_EVENTS.changeApproved, cr, actor);
    });
    return this.getChangeRequest(id);
  }

  async reject(id: string, actor: string, comment?: string): Promise<ChangeRequest> {
    await this.tx(async (trx) => {
      const cr = await this.lockChange(trx, id);
      this.need(cr, 'PENDING_APPROVAL');
      await sql`INSERT INTO configuration.change_approvals (change_request_id, approver, decision, comment) VALUES (${id}, ${actor}, 'REJECT', ${comment ?? null})`.execute(
        trx,
      );
      await this.setState(trx, id, 'REJECTED');
      await this.audit(trx, { actor, action: 'CHANGE_REJECTED', parameterId: cr.parameterId, changeRequestId: id, reason: comment });
      await this.event(trx, CONFIGURATION_EVENTS.changeRejected, cr, actor);
    });
    return this.getChangeRequest(id);
  }

  /** Withdraws a request before it is published. A published (scheduled or active) change is corrected with a later version, never cancelled. */
  async cancel(id: string, actor: string): Promise<ChangeRequest> {
    await this.tx(async (trx) => {
      const cr = await this.lockChange(trx, id);
      this.need(cr, 'DRAFT', 'PENDING_APPROVAL', 'APPROVED');
      if (cr.requestedBy !== actor) throw new ConfigurationError('FORBIDDEN_APPROVER', 'only the requester can cancel a change request');
      await this.setState(trx, id, 'CANCELLED');
      await this.audit(trx, { actor, action: 'CHANGE_CANCELLED', parameterId: cr.parameterId, changeRequestId: id });
    });
    return this.getChangeRequest(id);
  }

  /**
   * APPROVED -> SCHEDULED (effective later) or ACTIVE (effective now): creates the immutable version, closes the previous
   * open-ended version at the new start, and writes audit + outbox events in the same transaction.
   * Timeline rule: a new version must start AFTER the latest version of the same (parameter, scope); if the requested start has
   * already passed (slow approval) the version starts at publication time. A published version is never withdrawn.
   */
  async publish(id: string, actor: string): Promise<ChangeRequest> {
    const touched = await this.tx(async (trx) => {
      const cr = await this.lockChange(trx, id);
      this.need(cr, 'APPROVED');
      const p = await this.getParameter(cr.parameterKey);
      if (!p.isActive) throw new ConfigurationError('PARAMETER_NOT_FOUND', 'configuration parameter is inactive', { key: p.key });
      validateValue(p, cr.proposedValue);
      await sql`INSERT INTO configuration.parameter_values (parameter_id, scope_type, scope_ref) VALUES (${cr.parameterId}, ${cr.scopeType}, ${cr.scopeRef}) ON CONFLICT (parameter_id, scope_type, scope_ref) DO NOTHING`.execute(
        trx,
      );
      const holder = (
        await sql<{
          parameter_value_id: string;
        }>`SELECT parameter_value_id FROM configuration.parameter_values WHERE parameter_id = ${cr.parameterId} AND scope_type = ${cr.scopeType} AND scope_ref IS NOT DISTINCT FROM ${cr.scopeRef} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0]!;
      const head = (
        await sql<Row>`SELECT version_id, version, effective_from, effective_to FROM configuration.value_versions WHERE parameter_value_id = ${holder.parameter_value_id} ORDER BY version DESC LIMIT 1`.execute(
          trx,
        )
      ).rows[0];
      const now = (await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx)).rows[0]!.t;
      const start = cr.effectiveFrom > now ? cr.effectiveFrom : now;
      if (head) {
        const headFrom = head.effective_from as Date;
        const headTo = (head.effective_to as Date | null) ?? null;
        if (headTo === null) {
          if (start <= headFrom)
            throw new ConfigurationError(
              'CONFLICT',
              'the new version must start after the latest version of this scope (a later change is already published)',
              { latestStart: headFrom.toISOString() },
            );
          await sql`UPDATE configuration.value_versions SET effective_to = ${start} WHERE version_id = ${head.version_id as string}`.execute(trx);
        } else if (start < headTo)
          throw new ConfigurationError('CONFLICT', 'the new version overlaps the explicit end of the latest version', { latestEnd: headTo.toISOString() });
      }
      if (cr.effectiveTo && cr.effectiveTo <= start) throw new ConfigurationError('CONFLICT', 'the requested end is not after the effective start');
      const ver = (
        await sql<{
          version_id: string;
        }>`INSERT INTO configuration.value_versions (parameter_value_id, version, value, effective_from, effective_to, reason, created_by)
        VALUES (${holder.parameter_value_id}, ${((head?.version as number | undefined) ?? 0) + 1}, ${JSON.stringify(cr.proposedValue)}::jsonb, ${start}, ${cr.effectiveTo}, ${cr.reason}, ${cr.requestedBy}) RETURNING version_id`.execute(
          trx,
        )
      ).rows[0]!;
      const immediate = start <= now;
      await sql`UPDATE configuration.change_requests SET state = ${immediate ? 'ACTIVE' : 'SCHEDULED'}, value_version_id = ${ver.version_id}, updated_at = now() WHERE change_request_id = ${id}`.execute(
        trx,
      );
      const versionNo = ((head?.version as number | undefined) ?? 0) + 1;
      await this.audit(trx, {
        actor,
        action: 'CHANGE_PUBLISHED',
        parameterId: cr.parameterId,
        changeRequestId: id,
        oldVersionId: (head?.version_id as string | undefined) ?? null,
        newVersionId: ver.version_id,
        reason: cr.reason,
      });
      const ev = { ...cr, effectiveFrom: start };
      if (immediate) {
        await this.audit(trx, { actor, action: 'CHANGE_ACTIVATED', parameterId: cr.parameterId, changeRequestId: id, newVersionId: ver.version_id });
        await this.event(trx, CONFIGURATION_EVENTS.activated, ev, actor, versionNo);
        if (head) await this.supersedePrevious(trx, head.version_id as string, actor, cr.parameterId);
      } else await this.event(trx, CONFIGURATION_EVENTS.scheduled, ev, actor, versionNo);
      return cr.parameterKey;
    });
    await invalidateParameter(this.d.cache, this.d.env, touched);
    return this.getChangeRequest(id);
  }

  private async supersedePrevious(trx: Trx, previousVersionId: string, actor: string, parameterId: string): Promise<void> {
    const prev = (
      await sql<Row>`SELECT change_request_id, state FROM configuration.change_requests WHERE value_version_id = ${previousVersionId} FOR UPDATE`.execute(trx)
    ).rows[0];
    if (prev && (prev.state === 'ACTIVE' || prev.state === 'SCHEDULED')) {
      await this.setState(trx, prev.change_request_id as string, 'SUPERSEDED');
      await this.audit(trx, {
        actor,
        action: 'CHANGE_SUPERSEDED',
        parameterId,
        changeRequestId: prev.change_request_id as string,
        oldVersionId: previousVersionId,
      });
    }
  }

  /**
   * Marks SCHEDULED changes whose version is now effective as ACTIVE (state, audit, event, supersede, cache invalidation).
   * Idempotent and safe to run concurrently (SKIP LOCKED). Resolution never depends on this running on time: it uses the
   * effective timestamps directly; this only advances the workflow state and notifies.
   */
  async activateDue(limit = 100): Promise<number> {
    const keys = new Set<string>();
    const n = await this.tx(async (trx) => {
      const due =
        await sql<Row>`SELECT cr.change_request_id, cr.parameter_id, cr.scope_type, cr.scope_ref, cr.requested_by, p.key, vv.version, vv.version_id, vv.effective_from, vv.parameter_value_id
        FROM configuration.change_requests cr
        JOIN configuration.value_versions vv ON vv.version_id = cr.value_version_id
        JOIN configuration.parameters p ON p.parameter_id = cr.parameter_id
       WHERE cr.state = 'SCHEDULED' AND vv.effective_from <= clock_timestamp()
       ORDER BY vv.effective_from, cr.change_request_id LIMIT ${limit} FOR UPDATE OF cr SKIP LOCKED`.execute(trx);
      for (const r of due.rows) {
        const id = r.change_request_id as string;
        await this.setState(trx, id, 'ACTIVE');
        await this.audit(trx, {
          actor: r.requested_by as string,
          action: 'CHANGE_ACTIVATED',
          parameterId: r.parameter_id as string,
          changeRequestId: id,
          newVersionId: r.version_id as string,
          reason: 'scheduled activation',
        });
        await this.event(
          trx,
          CONFIGURATION_EVENTS.activated,
          {
            changeRequestId: id,
            parameterKey: r.key as string,
            scopeType: r.scope_type as ScopeType,
            scopeRef: (r.scope_ref as string | null) ?? null,
            effectiveFrom: r.effective_from as Date,
          },
          'system:configuration-activation',
          r.version as number,
        );
        const prior = (
          await sql<Row>`SELECT version_id FROM configuration.value_versions WHERE parameter_value_id = ${r.parameter_value_id as string} AND version = ${(r.version as number) - 1}`.execute(
            trx,
          )
        ).rows[0];
        if (prior) await this.supersedePrevious(trx, prior.version_id as string, 'system:configuration-activation', r.parameter_id as string);
        keys.add(r.key as string);
      }
      return due.rows.length;
    });
    for (const k of keys) await invalidateParameter(this.d.cache, this.d.env, k);
    return n;
  }

  // ------------------------------------------------------------------ resolution and snapshots
  /** Resolves many parameters in one batched read, through the cache and last-known-good policy. */
  async resolveMany(
    keys: string[],
    ctx: ConfigContext = {},
    opts: { at?: Date } = {},
  ): Promise<{ values: Map<string, Resolved>; sources: Map<string, Source>; at: Date }> {
    const r = await resolveWithPolicy({
      keys: [...new Set(keys)],
      ctx,
      at: opts.at,
      cache: this.d.cache,
      env: this.d.env,
      cacheTtlSeconds: this.cacheTtl,
      lkgMaxAgeSeconds: this.lkgMax,
      load: (ks) => resolveBatch(this.d.database.db, ks, ctx, opts.at),
    });
    return { values: r.resolved, sources: r.sources, at: opts.at ?? new Date() };
  }
  /** Convenience for consumers: the typed value of one required parameter. Throws a typed ConfigurationError, never a code default. */
  async value<T = unknown>(key: string, ctx: ConfigContext = {}): Promise<T> {
    return (await this.resolveMany([key], ctx)).values.get(key)!.value as T;
  }

  /** Immutable record of exactly which versions applied. Always authoritative: reads the database, never the cache or LKG. */
  async createSnapshot(args: { keys: string[]; context: ConfigContext; purpose: string; at?: Date }, actor: string): Promise<Snapshot> {
    const id = await this.tx(async (trx) => {
      const batch = await resolveBatch(trx, [...new Set(args.keys)], args.context, args.at);
      assertComplete(batch);
      const s = (
        await sql<{
          snapshot_id: string;
        }>`INSERT INTO configuration.snapshots (evaluated_at, context, purpose, created_by) VALUES (${batch.at}, ${JSON.stringify(args.context)}::jsonb, ${args.purpose}, ${actor}) RETURNING snapshot_id`.execute(
          trx,
        )
      ).rows[0]!;
      for (const r of batch.resolved.values())
        await sql`INSERT INTO configuration.snapshot_items (snapshot_id, parameter_id, version_id) VALUES (${s.snapshot_id}, ${r.parameterId}, ${r.versionId})`.execute(
          trx,
        );
      return s.snapshot_id;
    });
    return this.getSnapshot(id);
  }
  async getSnapshot(id: string): Promise<Snapshot> {
    const s = (await sql<Row>`SELECT * FROM configuration.snapshots WHERE snapshot_id = ${id}`.execute(this.d.database.db)).rows[0];
    if (!s) throw new ConfigurationError('NOT_FOUND', 'snapshot not found', { id });
    const items =
      await sql<Row>`SELECT p.key, p.parameter_id, p.data_type, p.sensitivity, p.criticality, pv.scope_type, pv.scope_ref, vv.version_id, vv.version, vv.value, vv.effective_from, vv.effective_to
      FROM configuration.snapshot_items si
      JOIN configuration.parameters p ON p.parameter_id = si.parameter_id
      JOIN configuration.value_versions vv ON vv.version_id = si.version_id
      JOIN configuration.parameter_values pv ON pv.parameter_value_id = vv.parameter_value_id
     WHERE si.snapshot_id = ${id} ORDER BY p.key`.execute(this.d.database.db);
    return {
      snapshotId: s.snapshot_id as string,
      evaluatedAt: s.evaluated_at as Date,
      context: s.context as ConfigContext,
      purpose: s.purpose as string,
      createdBy: s.created_by as string,
      createdAt: s.created_at as Date,
      items: items.rows.map((r) => ({
        key: r.key as string,
        parameterId: r.parameter_id as string,
        dataType: r.data_type as DataType,
        sensitivity: r.sensitivity as Sensitivity,
        criticality: r.criticality as Criticality,
        value: r.value,
        sourceScope: r.scope_type as ScopeType,
        scopeRef: (r.scope_ref as string | null) ?? null,
        version: r.version as number,
        versionId: r.version_id as string,
        effectiveFrom: r.effective_from as Date,
        effectiveTo: (r.effective_to as Date | null) ?? null,
      })),
    };
  }
}

const PARAM_SELECT = sql`SELECT p.*, coalesce(array_agg(ps.scope_type ORDER BY sl.rank) FILTER (WHERE ps.scope_type IS NOT NULL), '{}') AS allowed_scopes
  FROM configuration.parameters p
  LEFT JOIN configuration.parameter_scopes ps ON ps.parameter_id = p.parameter_id
  LEFT JOIN configuration.scope_levels sl ON sl.scope_type = ps.scope_type`;
