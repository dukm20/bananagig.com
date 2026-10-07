// Integration tests: real PostgreSQL (isolated, migrated database) and, where noted, real Valkey (pnpm dev:deps).
import { Redis } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIGURATION_EVENTS, SCOPE_TYPES, type CreateParameterRequest, type ScopeType } from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  ConfigurationError,
  ConfigurationService,
  MemoryConfigCache,
  ValkeyConfigCache,
  type ScopeReferenceCheck,
  type ScopeReferenceValidator,
} from './index';

let iso: IsolatedDatabase;
let svc: ConfigurationService;
let seq = 0;
const A = 'user-a';
const B = 'user-b';
const key = (name = 'x') => `devtest.t${++seq}.${name}`;
const code = async (p: Promise<unknown>) => ((await rejection(p)) as ConfigurationError | undefined)?.code;
const dbCode = async (q: Promise<unknown>) => ((await rejection(q)) as { code?: string } | undefined)?.code;
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);

const ALL_SCOPES: ScopeType[] = ['COUNTRY', 'MARKET', 'CATEGORY', 'PLAN', 'PROVIDER', 'GIG', 'DROP'];
const param = (k: string, over: Partial<CreateParameterRequest> = {}): CreateParameterRequest => ({
  key: k,
  dataType: 'INTEGER',
  description: 'neutral test parameter',
  ownerRole: 'platform',
  approvalPolicy: 'NONE',
  allowedOverrideScopes: ALL_SCOPES,
  ...over,
});
/** create -> submit -> (approve) -> publish. Returns the final change request. */
async function setValue(
  s: ConfigurationService,
  k: string,
  scopeType: ScopeType,
  scopeRef: string | null,
  value: unknown,
  o: { from?: Date; to?: Date; policy?: 'NONE' | 'SECOND' } = {},
) {
  const cr = await s.createChangeRequest(
    { parameterKey: k, scopeType, scopeRef, value, effectiveFrom: o.from?.toISOString(), effectiveTo: o.to?.toISOString(), reason: 'integration test' },
    A,
  );
  const submitted = await s.submit(cr.changeRequestId, A);
  if (submitted.state === 'PENDING_APPROVAL') await s.approve(cr.changeRequestId, B);
  return s.publish(cr.changeRequestId, A);
}
/** Runs fn against a dedicated database: activateDue() acts on ALL due changes, so these tests must not share state. */
async function withFreshService(fn: (s: ConfigurationService, d: IsolatedDatabase) => Promise<void>) {
  const fresh = await createIsolatedDatabase();
  try {
    await fn(new ConfigurationService({ database: fresh.database, env: 'test', allowTestKeys: true }), fresh);
  } finally {
    await fresh.drop();
  }
}
const outbox = (type: string) =>
  q<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM integration.outbox_events WHERE event_type = $1 ORDER BY created_at', [type]);

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  svc = new ConfigurationService({ database: iso.database, env: 'test', allowTestKeys: true, cacheTtlSeconds: 30 });
});
afterAll(async () => iso.drop());

describe('schema and definitions', () => {
  it('has the configuration schema with all tables and the canonical scope hierarchy', async () => {
    const tables = (await q<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'configuration' ORDER BY 1")).map(
      (r) => r.t,
    );
    expect(tables).toEqual([
      'audit_events',
      'change_approvals',
      'change_requests',
      'parameter_scopes',
      'parameter_values',
      'parameters',
      'scope_levels',
      'snapshot_items',
      'snapshots',
      'value_versions',
    ]);
    const levels = (await q<{ scope_type: string; rank: number }>('SELECT scope_type, rank FROM configuration.scope_levels ORDER BY rank')).map(
      (r) => r.scope_type,
    );
    expect(levels).toEqual([...SCOPE_TYPES]);
  });
  it('creates typed parameters; PLATFORM is always an allowed scope; keys are unique', async () => {
    const k = key();
    const p = await svc.createParameter(param(k, { allowedOverrideScopes: ['MARKET'] }), A);
    expect(p).toMatchObject({
      key: k,
      dataType: 'INTEGER',
      sensitivity: 'INTERNAL',
      criticality: 'STANDARD',
      isRequired: true,
      allowedScopes: ['PLATFORM', 'MARKET'],
    });
    expect(await code(svc.createParameter(param(k), A))).toBe('CONFLICT');
  });
  it('rejects devtest keys outside dev/test, malformed keys and incoherent rules', async () => {
    const prod = new ConfigurationService({ database: iso.database, env: 'production', allowTestKeys: false });
    expect(await code(prod.createParameter(param(key()), A))).toBe('VALIDATION_FAILED');
    expect(
      await dbCode(
        q(
          "INSERT INTO configuration.parameters (key, data_type, description, owner_role, approval_policy, created_by) VALUES ('BadKey', 'INTEGER', 'd', 'o', 'NONE', 'u')",
        ),
      ),
    ).toBe('23514');
    expect(await code(svc.createParameter(param(key(), { dataType: 'ENUM' }), A))).toBe('VALIDATION_FAILED');
  });
  it('maps database CHECK violations to VALIDATION_FAILED and preserves the constraint name', async () => {
    const error = (await rejection(svc.createParameter(param(key(), { ownerRole: 'Bad Role' }), A))) as ConfigurationError;
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { constraint: 'ck_parameters__owner_role_format' },
    });
  });
  it('a parameter cannot be overridden at a scope it does not allow', async () => {
    const k = key();
    await svc.createParameter(param(k, { allowedOverrideScopes: ['MARKET'] }), A);
    expect(await code(svc.createChangeRequest({ parameterKey: k, scopeType: 'GIG', scopeRef: 'g1', value: 1, reason: 'x' }, A))).toBe('SCOPE_NOT_ALLOWED');
    // and the database refuses it independently of the service
    const id = (await q<{ parameter_id: string }>('SELECT parameter_id FROM configuration.parameters WHERE key = $1', [k]))[0]!.parameter_id;
    expect(await dbCode(q("INSERT INTO configuration.parameter_values (parameter_id, scope_type, scope_ref) VALUES ($1, 'GIG', 'g1')", [id]))).toBe('23503');
  });
  it('scope references: PLATFORM takes none, others require a well-formed one', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    expect(await code(svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', scopeRef: 'x', value: 1, reason: 'r' }, A))).toBe('VALIDATION_FAILED');
    expect(await code(svc.createChangeRequest({ parameterKey: k, scopeType: 'MARKET', value: 1, reason: 'r' }, A))).toBe('VALIDATION_FAILED');
  });
  it('every data type validates on write', async () => {
    const cases: [CreateParameterRequest['dataType'], unknown, unknown][] = [
      ['STRING', 'abc', 5],
      ['INTEGER', 3, 3.5],
      ['DECIMAL', '1.25', 1.25],
      ['BOOLEAN', true, 'yes'],
      ['DURATION', { amount: 2, unit: 'HOURS' }, 'PT2H'],
      ['MONEY', { amount_minor: 500, currency: 'USD' }, { amount_minor: 5.5, currency: 'USD' }],
      ['JSON', { a: 1 }, undefined],
    ];
    for (const [dataType, good, bad] of cases) {
      const k = key();
      await svc.createParameter(param(k, { dataType }), A);
      await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: good, reason: 'r' }, A);
      expect(await code(svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: bad, reason: 'r' }, A)), dataType).toBe('VALIDATION_FAILED');
    }
  });
});

describe('resolution', () => {
  it('returns the platform value, and the market override only for that market', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 10);
    await setValue(svc, k, 'MARKET', 'us-ca', 20);
    const inMarket = (await svc.resolveMany([k], { market: 'us-ca' })).values.get(k)!;
    expect(inMarket).toMatchObject({ value: 20, sourceScope: 'MARKET', scopeRef: 'us-ca', version: 1 });
    expect((await svc.resolveMany([k], { market: 'us-ny' })).values.get(k)).toMatchObject({ value: 10, sourceScope: 'PLATFORM', scopeRef: null });
    expect((await svc.resolveMany([k], {})).values.get(k)?.value).toBe(10);
  });
  it('the most specific level wins across the whole hierarchy', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const ctx = { country: 'us', market: 'us-ca', category: 'plumbing', plan: 'pro', provider: 'prov-1', gig: 'gig-1', drop: 'drop-1' };
    await setValue(svc, k, 'PLATFORM', null, 0);
    let expected = 0;
    for (const [i, s] of ALL_SCOPES.entries()) {
      await setValue(svc, k, s, ctx[s.toLowerCase() as keyof typeof ctx], i + 1);
      expected = i + 1;
      expect((await svc.resolveMany([k], ctx)).values.get(k), s).toMatchObject({ value: expected, sourceScope: s });
    }
    // a context without the specific levels falls back to the next most specific that applies
    expect((await svc.resolveMany([k], { country: 'us', market: 'us-ca' })).values.get(k)?.sourceScope).toBe('MARKET');
  });
  it('batches: constant query count regardless of the number of parameters', async () => {
    let queries = 0;
    const counting = await createIsolatedDatabase({ database: { onQuery: () => queries++ } });
    try {
      const s = new ConfigurationService({ database: counting.database, env: 'test', allowTestKeys: true });
      const keys: string[] = [];
      for (let i = 0; i < 20; i++) {
        const k = `devtest.batch.p${i}`;
        keys.push(k);
        await s.createParameter(param(k), A);
        await setValue(s, k, 'PLATFORM', null, i);
      }
      queries = 0;
      const r = await s.resolveMany(keys, { market: 'm' });
      expect(r.values.size).toBe(20);
      expect(queries).toBeLessThanOrEqual(3);
    } finally {
      await counting.drop();
    }
  });
  it('a required parameter without an effective value is a typed NO_VALUE error (no code constant is ever returned)', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    expect(await code(svc.resolveMany([k], {}))).toBe('NO_VALUE');
    await setValue(svc, k, 'MARKET', 'only-here', 5);
    expect(await code(svc.resolveMany([k], { market: 'elsewhere' }))).toBe('NO_VALUE'); // exists, but not for this context
    expect(await code(svc.resolveMany(['devtest.nope.missing'], {}))).toBe('PARAMETER_NOT_FOUND');
  });
  it('an optional parameter without a value is simply absent', async () => {
    const k = key();
    await svc.createParameter(param(k, { isRequired: false }), A);
    expect((await svc.resolveMany([k], {})).values.has(k)).toBe(false);
    const err = (await rejection(svc.value(k))) as ConfigurationError;
    expect(err).toMatchObject({ code: 'NO_VALUE', details: { key: k } });
  });
  it('a value whose period has ended no longer resolves (no stale fallback)', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 7, { to: new Date(Date.now() + 1200) });
    expect((await svc.resolveMany([k], {})).values.get(k)?.value).toBe(7);
    await sleep(1400);
    expect(await code(svc.resolveMany([k], {}))).toBe('NO_VALUE');
  });
});

describe('effective dating and versions', () => {
  it('a scheduled value takes over at its effective time without any job running', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1);
    const sched = await setValue(svc, k, 'PLATFORM', null, 2, { from: new Date(Date.now() + 1500) });
    expect(sched.state).toBe('SCHEDULED');
    expect((await svc.resolveMany([k], {})).values.get(k)?.value).toBe(1);
    expect((await svc.resolveMany([k], {}, { at: new Date(Date.now() + 3000) })).values.get(k)).toMatchObject({ value: 2, version: 2 });
    await sleep(1700);
    expect((await svc.resolveMany([k], {})).values.get(k)).toMatchObject({ value: 2, version: 2 }); // resolver uses timestamps; the job has NOT run
    expect((await svc.getChangeRequest(sched.changeRequestId)).state).toBe('SCHEDULED');
  });
  it('scheduled activation advances workflow state, is idempotent, supersedes the previous change and emits one event', () =>
    withFreshService(async (s, fresh) => {
      const k = key();
      await s.createParameter(param(k), A);
      const first = await setValue(s, k, 'PLATFORM', null, 1);
      const sched = await setValue(s, k, 'PLATFORM', null, 2, { from: new Date(Date.now() + 1200) });
      expect(await s.activateDue()).toBe(0); // not yet due
      await sleep(1400);
      expect(await s.activateDue()).toBe(1);
      expect(await s.activateDue()).toBe(0); // idempotent
      expect((await s.getChangeRequest(sched.changeRequestId)).state).toBe('ACTIVE');
      expect((await s.getChangeRequest(first.changeRequestId)).state).toBe('SUPERSEDED');
      const events = await fresh.database.query<{ payload_json: Record<string, unknown>; actor_type: string }>(
        'SELECT payload_json, actor_type FROM integration.outbox_events WHERE event_type = $1',
        [CONFIGURATION_EVENTS.activated],
      );
      expect(events.filter((e) => e.payload_json.changeRequestId === sched.changeRequestId)).toMatchObject([{ actor_type: 'system' }]);
    }));
  it('concurrent activation runs activate each change exactly once', () =>
    withFreshService(async (s, fresh) => {
      const k = key();
      await s.createParameter(param(k), A);
      await setValue(s, k, 'PLATFORM', null, 1);
      const sched = await setValue(s, k, 'PLATFORM', null, 2, { from: new Date(Date.now() + 1000) });
      await sleep(1200);
      const total = (await Promise.all([s.activateDue(), s.activateDue(), s.activateDue()])).reduce((x, y) => x + y, 0);
      expect(total).toBe(1);
      const events = await fresh.database.query<{ payload_json: Record<string, unknown> }>(
        'SELECT payload_json FROM integration.outbox_events WHERE event_type = $1',
        [CONFIGURATION_EVENTS.activated],
      );
      expect(events.filter((e) => e.payload_json.changeRequestId === sched.changeRequestId)).toHaveLength(1);
    }));
  it('versions increase per scope, close their predecessor and never overlap', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    for (const v of [1, 2, 3]) await setValue(svc, k, 'PLATFORM', null, v);
    const rows = await q<{ version: number; effective_from: Date; effective_to: Date | null }>(
      'SELECT vv.version, vv.effective_from, vv.effective_to FROM configuration.value_versions vv JOIN configuration.parameter_values pv USING (parameter_value_id) JOIN configuration.parameters p USING (parameter_id) WHERE p.key = $1 ORDER BY vv.version',
      [k],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0]!.effective_to?.getTime()).toBe(rows[1]!.effective_from.getTime());
    expect(rows[1]!.effective_to?.getTime()).toBe(rows[2]!.effective_from.getTime());
    expect(rows[2]!.effective_to).toBeNull();
  });
  it('the database rejects overlapping periods for one scope (exclusion constraint)', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1);
    const holder = (
      await q<{ parameter_value_id: string }>(
        'SELECT pv.parameter_value_id FROM configuration.parameter_values pv JOIN configuration.parameters p USING (parameter_id) WHERE p.key = $1',
        [k],
      )
    )[0]!.parameter_value_id;
    expect(
      await dbCode(
        q(
          "INSERT INTO configuration.value_versions (parameter_value_id, version, value, effective_from, reason, created_by) VALUES ($1, 99, '5', now() + interval '1 day', 'overlap', 'u')",
          [holder],
        ),
      ),
    ).toBe('23P01');
    expect(
      await dbCode(
        q(
          "INSERT INTO configuration.value_versions (parameter_value_id, version, value, effective_from, effective_to, reason, created_by) VALUES ($1, 100, '5', now(), now() - interval '1 hour', 'bad range', 'u')",
          [holder],
        ),
      ),
    ).toBe('23514');
  });
  it('the service refuses a version that does not start after the latest one', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1, { from: new Date(Date.now() + 60_000) }); // head starts in the future
    expect(await code(setValue(svc, k, 'PLATFORM', null, 2))).toBe('CONFLICT'); // would start now, before the head
    expect((await svc.resolveMany([k], {}, { at: new Date(Date.now() + 120_000) })).values.get(k)?.value).toBe(1);
  });
  it('published history is immutable: no edit, no delete, and the end date can be set only once', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1);
    await setValue(svc, k, 'PLATFORM', null, 2);
    const v1 = (
      await q<{ version_id: string }>(
        'SELECT vv.version_id FROM configuration.value_versions vv JOIN configuration.parameter_values pv USING (parameter_value_id) JOIN configuration.parameters p USING (parameter_id) WHERE p.key = $1 AND vv.version = 1',
        [k],
      )
    )[0]!.version_id;
    expect(await dbCode(q("UPDATE configuration.value_versions SET value = '999' WHERE version_id = $1", [v1]))).toBe('23000');
    expect(await dbCode(q("UPDATE configuration.value_versions SET reason = 'edited' WHERE version_id = $1", [v1]))).toBe('23000');
    expect(await dbCode(q("UPDATE configuration.value_versions SET effective_to = effective_to + interval '1 hour' WHERE version_id = $1", [v1]))).toBe(
      '23000',
    ); // already closed
    expect(await dbCode(q('DELETE FROM configuration.value_versions WHERE version_id = $1', [v1]))).toBe('23000');
    expect((await svc.resolveMany([k], {}, { at: new Date(Date.now() - 1) })).values.size).toBeLessThanOrEqual(1);
  });
  it('definitions are protected: identity cannot change, nothing is deleted; audit, approvals and snapshots are append-only', async () => {
    const k = key();
    const p = await svc.createParameter(param(k), A);
    expect(await dbCode(q("UPDATE configuration.parameters SET key = 'devtest.renamed.key' WHERE parameter_id = $1", [p.parameterId]))).toBe('23000');
    expect(await dbCode(q("UPDATE configuration.parameters SET data_type = 'STRING' WHERE parameter_id = $1", [p.parameterId]))).toBe('23000');
    expect(await dbCode(q('DELETE FROM configuration.parameters WHERE parameter_id = $1', [p.parameterId]))).toBe('23000');
    expect(await dbCode(q("UPDATE configuration.audit_events SET actor = 'someone-else'"))).toBe('23000');
    expect(await dbCode(q('DELETE FROM configuration.audit_events'))).toBe('23000');
  });
});

describe('change request workflow and approval', () => {
  const draft = async (policy: CreateParameterRequest['approvalPolicy'], over: Partial<CreateParameterRequest> = {}) => {
    const k = key();
    await svc.createParameter(param(k, { approvalPolicy: policy, ...over }), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'workflow test' }, A);
    return { k, cr };
  };
  it('NONE: submit approves automatically; publish makes it ACTIVE', async () => {
    const { cr } = await draft('NONE');
    expect(cr.state).toBe('DRAFT');
    expect((await svc.submit(cr.changeRequestId, A)).state).toBe('APPROVED');
    const done = await svc.publish(cr.changeRequestId, A);
    expect(done).toMatchObject({ state: 'ACTIVE', version: 1 });
  });
  it('SECOND_APPROVER: the requester cannot approve their own change; another approver can', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    expect((await svc.submit(cr.changeRequestId, A)).state).toBe('PENDING_APPROVAL');
    expect(await code(svc.approve(cr.changeRequestId, A))).toBe('FORBIDDEN_APPROVER');
    expect((await svc.getChangeRequest(cr.changeRequestId)).state).toBe('PENDING_APPROVAL');
    expect((await svc.approve(cr.changeRequestId, B)).state).toBe('APPROVED');
  });
  it('the database independently refuses a self-approval row for SECOND_APPROVER', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    await svc.submit(cr.changeRequestId, A);
    expect(
      await dbCode(q("INSERT INTO configuration.change_approvals (change_request_id, approver, decision) VALUES ($1, $2, 'APPROVE')", [cr.changeRequestId, A])),
    ).toBe('23000');
  });
  it('OWNER_APPROVAL: one approval is enough and the requester may be the owner', async () => {
    const { cr } = await draft('OWNER_APPROVAL');
    await svc.submit(cr.changeRequestId, A);
    expect((await svc.approve(cr.changeRequestId, A)).state).toBe('APPROVED');
  });
  it('rejection is terminal; approving or publishing afterwards fails', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    await svc.submit(cr.changeRequestId, A);
    expect((await svc.reject(cr.changeRequestId, B, 'not now')).state).toBe('REJECTED');
    expect(await code(svc.approve(cr.changeRequestId, B))).toBe('INVALID_STATE');
    expect(await code(svc.publish(cr.changeRequestId, A))).toBe('INVALID_STATE');
    expect(await code(svc.cancel(cr.changeRequestId, A))).toBe('INVALID_STATE');
  });
  it('cancellation works before publication only, and only for the requester', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    expect(await code(svc.cancel(cr.changeRequestId, B))).toBe('FORBIDDEN_APPROVER');
    expect((await svc.cancel(cr.changeRequestId, A)).state).toBe('CANCELLED');
    expect(await code(svc.submit(cr.changeRequestId, A))).toBe('INVALID_STATE');
    const { cr: cr2 } = await draft('NONE');
    await svc.submit(cr2.changeRequestId, A);
    await svc.publish(cr2.changeRequestId, A);
    expect(await code(svc.cancel(cr2.changeRequestId, A))).toBe('INVALID_STATE'); // published history is never withdrawn
  });
  it('steps cannot be skipped: publish needs approval, approve needs submission', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    expect(await code(svc.publish(cr.changeRequestId, A))).toBe('INVALID_STATE');
    expect(await code(svc.approve(cr.changeRequestId, B))).toBe('INVALID_STATE');
    expect(await dbCode(q("UPDATE configuration.change_requests SET state = 'ACTIVE' WHERE change_request_id = $1", [cr.changeRequestId]))).toBe('23000'); // illegal transition blocked by the database too
  });
  it('change request content is frozen once it leaves DRAFT', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    await svc.submit(cr.changeRequestId, A);
    expect(await dbCode(q("UPDATE configuration.change_requests SET proposed_value = '999' WHERE change_request_id = $1", [cr.changeRequestId]))).toBe('23000');
  });
  it('a change approved after its requested start becomes effective at publication, never in the past', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const cr = await svc.createChangeRequest(
      { parameterKey: k, scopeType: 'PLATFORM', value: 1, effectiveFrom: new Date(Date.now() + 500).toISOString(), reason: 'late approval' },
      A,
    );
    await svc.submit(cr.changeRequestId, A);
    await sleep(800);
    const published = await svc.publish(cr.changeRequestId, A);
    expect(published.state).toBe('ACTIVE');
    const v = (await svc.resolveMany([k], {})).values.get(k)!;
    expect(v.effectiveFrom.getTime()).toBeGreaterThan(published.effectiveFrom.getTime());
  });
  it('lists change requests by state', async () => {
    const { cr } = await draft('SECOND_APPROVER');
    await svc.submit(cr.changeRequestId, A);
    expect((await svc.listChangeRequests({ state: 'PENDING_APPROVAL' })).some((c) => c.changeRequestId === cr.changeRequestId)).toBe(true);
  });
});

describe('concurrency', () => {
  it('two approvers racing: exactly one approval is recorded', async () => {
    const k = key();
    await svc.createParameter(param(k, { approvalPolicy: 'SECOND_APPROVER' }), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'race' }, A);
    await svc.submit(cr.changeRequestId, A);
    const results = await Promise.all([rejection(svc.approve(cr.changeRequestId, B)), rejection(svc.approve(cr.changeRequestId, 'user-c'))]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(results.filter(Boolean).every((e) => ['INVALID_STATE', 'CONFLICT'].includes((e as ConfigurationError).code))).toBe(true);
    expect(
      Number((await q<{ n: string }>('SELECT count(*) AS n FROM configuration.change_approvals WHERE change_request_id = $1', [cr.changeRequestId]))[0]!.n),
    ).toBe(1);
  });
  it('approve racing reject: one decision wins, the other fails, state stays consistent', async () => {
    const k = key();
    await svc.createParameter(param(k, { approvalPolicy: 'SECOND_APPROVER' }), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'race' }, A);
    await svc.submit(cr.changeRequestId, A);
    const results = await Promise.all([rejection(svc.approve(cr.changeRequestId, B)), rejection(svc.reject(cr.changeRequestId, 'user-c'))]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    const final = (await svc.getChangeRequest(cr.changeRequestId)).state;
    expect(['APPROVED', 'REJECTED']).toContain(final);
    expect(
      Number((await q<{ n: string }>('SELECT count(*) AS n FROM configuration.change_approvals WHERE change_request_id = $1', [cr.changeRequestId]))[0]!.n),
    ).toBe(1);
  });
  it('publishing the same change twice concurrently creates one version', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'race' }, A);
    await svc.submit(cr.changeRequestId, A);
    const results = await Promise.all([
      rejection(svc.publish(cr.changeRequestId, A)),
      rejection(svc.publish(cr.changeRequestId, A)),
      rejection(svc.publish(cr.changeRequestId, A)),
    ]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(
      Number(
        (
          await q<{ n: string }>(
            'SELECT count(*) AS n FROM configuration.value_versions vv JOIN configuration.parameter_values pv USING (parameter_value_id) JOIN configuration.parameters p USING (parameter_id) WHERE p.key = $1',
            [k],
          )
        )[0]!.n,
      ),
    ).toBe(1);
  });
  it('many concurrent publications to one scope: unique contiguous versions, a gap-free closed chain, no overlap', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const crs = [];
    for (let i = 0; i < 8; i++) {
      const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: i, reason: `race ${i}` }, A);
      await svc.submit(cr.changeRequestId, A);
      crs.push(cr);
    }
    const results = await Promise.all(crs.map((c) => rejection(svc.publish(c.changeRequestId, A))));
    const ok = results.filter((r) => r === undefined).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    for (const e of results.filter(Boolean)) expect(['CONFLICT']).toContain((e as ConfigurationError).code);
    const rows = await q<{ version: number; effective_from: Date; effective_to: Date | null }>(
      'SELECT vv.version, vv.effective_from, vv.effective_to FROM configuration.value_versions vv JOIN configuration.parameter_values pv USING (parameter_value_id) JOIN configuration.parameters p USING (parameter_id) WHERE p.key = $1 ORDER BY vv.version',
      [k],
    );
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: ok }, (_, i) => i + 1));
    rows.slice(0, -1).forEach((r, i) => expect(r.effective_to?.getTime()).toBe(rows[i + 1]!.effective_from.getTime()));
    expect(rows.at(-1)!.effective_to).toBeNull();
  });
});

describe('snapshots', () => {
  it('records the exact versions used and stays unchanged after configuration changes', async () => {
    const [k1, k2] = [key('a'), key('b')];
    for (const k of [k1, k2]) await svc.createParameter(param(k), A);
    await setValue(svc, k1, 'PLATFORM', null, 100);
    await setValue(svc, k2, 'PLATFORM', null, 200);
    await setValue(svc, k2, 'MARKET', 'us-ca', 201);
    const snap = await svc.createSnapshot({ keys: [k1, k2], context: { market: 'us-ca' }, purpose: 'integration test' }, A);
    expect(snap.items.map((i) => [i.key, i.value, i.sourceScope, i.version])).toEqual(
      [
        [k1, 100, 'PLATFORM', 1],
        [k2, 201, 'MARKET', 1],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(snap.items.every((i) => i.effectiveFrom instanceof Date)).toBe(true);
    // configuration changes afterwards
    await setValue(svc, k1, 'PLATFORM', null, 101);
    await setValue(svc, k2, 'MARKET', 'us-ca', 999);
    expect((await svc.resolveMany([k1, k2], { market: 'us-ca' })).values.get(k1)?.value).toBe(101);
    // the snapshot still shows the old values and versions
    const again = await svc.getSnapshot(snap.snapshotId);
    expect(again.items.map((i) => [i.key, i.value, i.version])).toEqual(snap.items.map((i) => [i.key, i.value, i.version]));
    expect(again.context).toEqual({ market: 'us-ca' });
  });
  it('is immutable at the database level', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1);
    const snap = await svc.createSnapshot({ keys: [k], context: {}, purpose: 'immutability' }, A);
    expect(await dbCode(q("UPDATE configuration.snapshots SET purpose = 'x' WHERE snapshot_id = $1", [snap.snapshotId]))).toBe('23000');
    expect(await dbCode(q('DELETE FROM configuration.snapshot_items WHERE snapshot_id = $1', [snap.snapshotId]))).toBe('23000');
    expect(await dbCode(q('DELETE FROM configuration.snapshots WHERE snapshot_id = $1', [snap.snapshotId]))).toBe('23000');
  });
  it('fails without creating anything when a required value is missing', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const before = Number((await q<{ n: string }>('SELECT count(*) AS n FROM configuration.snapshots'))[0]!.n);
    expect(await code(svc.createSnapshot({ keys: [k], context: {}, purpose: 'no value' }, A))).toBe('NO_VALUE');
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM configuration.snapshots'))[0]!.n)).toBe(before);
  });
  it('a snapshot at an explicit time records the value effective then', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    await setValue(svc, k, 'PLATFORM', null, 1);
    await setValue(svc, k, 'PLATFORM', null, 2, { from: new Date(Date.now() + 60_000) });
    const future = await svc.createSnapshot({ keys: [k], context: {}, purpose: 'what-if', at: new Date(Date.now() + 120_000) }, A);
    expect(future.items[0]).toMatchObject({ value: 2, version: 2 });
  });
});

describe('cache and last-known-good (integration)', () => {
  it('a publication invalidates cached values immediately', async () => {
    const cache = new MemoryConfigCache();
    const cached = new ConfigurationService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const k = key();
    await cached.createParameter(param(k), A);
    await setValue(cached, k, 'PLATFORM', null, 1);
    expect((await cached.resolveMany([k], {})).sources.get(k)).toBe('db');
    expect((await cached.resolveMany([k], {})).sources.get(k)).toBe('cache');
    await setValue(cached, k, 'PLATFORM', null, 2);
    const r = await cached.resolveMany([k], {});
    expect(r.values.get(k)?.value).toBe(2);
    expect(r.sources.get(k)).toBe('db');
  });
  it('the database stays authoritative when the cache is unavailable (real Valkey client pointed at a dead port)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const s = new ConfigurationService({ database: db(), cache: new ValkeyConfigCache(dead), env: 'test', allowTestKeys: true });
    const k = key();
    await s.createParameter(param(k), A);
    await setValue(s, k, 'PLATFORM', null, 42);
    const r = await s.resolveMany([k], {});
    expect(r.values.get(k)?.value).toBe(42);
    expect(r.sources.get(k)).toBe('db');
    dead.disconnect();
  });
  it('works with a real Valkey: cache hit, then invalidation after publication', async () => {
    const url = process.env.VALKEY_ITEST_URL ?? 'redis://127.0.0.1:16379';
    const redis = new Redis(url, { maxRetriesPerRequest: 1 });
    try {
      await redis.ping();
    } catch {
      redis.disconnect();
      return; // Valkey not reachable in this environment; the in-memory tests cover the logic
    }
    const s = new ConfigurationService({ database: db(), cache: new ValkeyConfigCache(redis), env: `itest${Date.now()}`, allowTestKeys: true });
    const k = key();
    await s.createParameter(param(k), A);
    await setValue(s, k, 'PLATFORM', null, 1);
    await s.resolveMany([k], {});
    expect((await s.resolveMany([k], {})).sources.get(k)).toBe('cache');
    await setValue(s, k, 'PLATFORM', null, 2);
    expect((await s.resolveMany([k], {})).values.get(k)?.value).toBe(2);
    redis.disconnect();
  });
  it('serves last-known-good for STANDARD parameters during a database outage, and fails typed for CRITICAL ones', async () => {
    const cache = new MemoryConfigCache();
    const healthy = new ConfigurationService({ database: db(), cache, env: 'test', allowTestKeys: true });
    const [std, crit] = [key('std'), key('crit')];
    await healthy.createParameter(param(std), A);
    await healthy.createParameter(param(crit, { criticality: 'CRITICAL' }), A);
    await setValue(healthy, std, 'PLATFORM', null, 5);
    await setValue(healthy, crit, 'PLATFORM', null, 6);
    await healthy.resolveMany([std], {});
    await healthy.resolveMany([crit], {});
    for (const k of [...cache.data.keys()].filter((x) => x.includes(':v1:'))) cache.data.delete(k); // force a database read
    const brokenDb = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 500 } });
    const outage = new ConfigurationService({ database: brokenDb, cache, env: 'test', allowTestKeys: true });
    const r = await outage.resolveMany([std], {});
    expect(r.values.get(std)?.value).toBe(5);
    expect(r.sources.get(std)).toBe('lkg');
    expect(await code(outage.resolveMany([crit], {}))).toBe('UNAVAILABLE');
    expect(await code(outage.resolveMany([std, crit], {}))).toBe('UNAVAILABLE');
    await brokenDb.close();
  });
});

describe('audit, events and sensitivity', () => {
  it('records every mutation with actor, action, versions, reason and correlation id', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    const cr = await runWithCorrelation('corr-cfg-audit-1', async () => {
      const c = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'audit me' }, A);
      await svc.submit(c.changeRequestId, A);
      return svc.publish(c.changeRequestId, A);
    });
    const rows = await q<{ actor: string; action: string; correlation_id: string; reason: string | null; new_version_id: string | null }>(
      'SELECT actor, action, correlation_id, reason, new_version_id FROM configuration.audit_events WHERE change_request_id = $1 ORDER BY occurred_at, audit_event_id',
      [cr.changeRequestId],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['CHANGE_DRAFTED', 'CHANGE_SUBMITTED', 'CHANGE_APPROVED', 'CHANGE_PUBLISHED', 'CHANGE_ACTIVATED']),
    );
    expect(rows.every((r) => r.actor === A && r.correlation_id === 'corr-cfg-audit-1')).toBe(true);
    expect(rows.find((r) => r.action === 'CHANGE_PUBLISHED')?.new_version_id).toBeTruthy();
    expect(
      (
        await q(
          'SELECT 1 FROM configuration.audit_events WHERE parameter_id = (SELECT parameter_id FROM configuration.parameters WHERE key = $1) AND action = $2',
          [k, 'PARAMETER_CREATED'],
        )
      ).length,
    ).toBe(1);
  });
  it('sensitive values stay out of audit rows and event payloads', async () => {
    const k = key();
    await svc.createParameter(param(k, { dataType: 'STRING', sensitivity: 'SENSITIVE', approvalPolicy: 'NONE' }), A);
    const cr = await setValue(svc, k, 'PLATFORM', null, 'super-secret-sentinel-value');
    const audit = JSON.stringify(await q('SELECT * FROM configuration.audit_events WHERE change_request_id = $1', [cr.changeRequestId]));
    const events = JSON.stringify(
      await q("SELECT payload_json FROM integration.outbox_events WHERE payload_json->>'changeRequestId' = $1", [cr.changeRequestId]),
    );
    expect(audit).not.toContain('super-secret-sentinel-value');
    expect(events).not.toContain('super-secret-sentinel-value');
    expect((await svc.resolveMany([k], {})).values.get(k)?.sensitivity).toBe('SENSITIVE'); // internal callers get the value and the flag; the API redacts
  });
  it('writes configuration events through the transactional outbox, one per transition', async () => {
    const k = key();
    await svc.createParameter(param(k, { approvalPolicy: 'SECOND_APPROVER' }), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'events' }, A);
    await svc.submit(cr.changeRequestId, A);
    await svc.approve(cr.changeRequestId, B);
    await svc.publish(cr.changeRequestId, A);
    const forRequest = await q<{ event_type: string; payload_json: Record<string, unknown>; published_at: Date | null; correlation_id: string }>(
      "SELECT event_type, payload_json, published_at, correlation_id FROM integration.outbox_events WHERE payload_json->>'changeRequestId' = $1 ORDER BY created_at",
      [cr.changeRequestId],
    );
    expect(forRequest.map((e) => e.event_type)).toEqual([
      CONFIGURATION_EVENTS.changeRequested,
      CONFIGURATION_EVENTS.changeApproved,
      CONFIGURATION_EVENTS.activated,
    ]);
    expect(forRequest[0]!.payload_json).toMatchObject({ parameterKey: k, scopeType: 'PLATFORM', scopeRef: null });
    expect(JSON.stringify(forRequest)).not.toMatch(/"value"/); // identifiers only
    const sched = await svc.createChangeRequest(
      { parameterKey: k, scopeType: 'PLATFORM', value: 2, effectiveFrom: new Date(Date.now() + 60_000).toISOString(), reason: 'sched' },
      A,
    );
    await svc.submit(sched.changeRequestId, A);
    await svc.approve(sched.changeRequestId, B);
    await svc.publish(sched.changeRequestId, A);
    expect((await outbox(CONFIGURATION_EVENTS.scheduled)).some((e) => e.payload_json.changeRequestId === sched.changeRequestId)).toBe(true);
    const rej = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 3, reason: 'reject me' }, A);
    await svc.submit(rej.changeRequestId, A);
    await svc.reject(rej.changeRequestId, B, 'no');
    expect((await outbox(CONFIGURATION_EVENTS.changeRejected)).some((e) => e.payload_json.changeRequestId === rej.changeRequestId)).toBe(true);
  });
  it('state change, audit rows and outbox events commit or roll back together', async () => {
    const k = key();
    await svc.createParameter(param(k, { approvalPolicy: 'SECOND_APPROVER' }), A);
    const cr = await svc.createChangeRequest({ parameterKey: k, scopeType: 'PLATFORM', value: 1, reason: 'atomic' }, A);
    const count = async (t: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))[0]!.n);
    const [auditBefore, outboxBefore] = [await count('configuration.audit_events'), await count('integration.outbox_events')];
    await rejection(
      db().transaction(async () => {
        await svc.submit(cr.changeRequestId, A);
        throw new Error('business transaction fails after the service call');
      }),
    );
    expect((await svc.getChangeRequest(cr.changeRequestId)).state).toBe('DRAFT');
    expect(await count('configuration.audit_events')).toBe(auditBefore);
    expect(await count('integration.outbox_events')).toBe(outboxBefore);
    await svc.submit(cr.changeRequestId, A);
    expect(await count('integration.outbox_events')).toBe(outboxBefore + 1);
    expect(await count('configuration.audit_events')).toBe(auditBefore + 1);
  });
});

// ---------------------------------------------------------------- GEO-001: COUNTRY/MARKET scope reference validation (fake geography)
describe('scope reference validator port (GEO-001): fake validator over real PostgreSQL', () => {
  let mode: 'ok' | 'retired' | 'down' = 'ok';
  const calls: [ScopeType, string][] = [];
  /** Accepts COUNTRY US and MARKET la-oc only; `mode` simulates a retired reference or an outage. */
  const validator: ScopeReferenceValidator = {
    validate: async (t, r): Promise<ScopeReferenceCheck> => {
      calls.push([t, r]);
      if (mode === 'down') throw new Error('geography unavailable');
      if (mode === 'retired') return { valid: false, reason: 'INACTIVE' };
      return (t === 'COUNTRY' && r === 'US') || (t === 'MARKET' && r === 'la-oc') ? { valid: true } : { valid: false, reason: 'NOT_FOUND' };
    },
  };
  let guarded: ConfigurationService;
  const crCount = async (k: string) =>
    Number(
      (
        await q<{ n: string }>(
          'SELECT count(*) AS n FROM configuration.change_requests cr JOIN configuration.parameters p ON p.parameter_id = cr.parameter_id WHERE p.key = $1',
          [k],
        )
      )[0]!.n,
    );
  const draft = (k: string, scopeType: ScopeType, scopeRef: string | null) => ({ parameterKey: k, scopeType, scopeRef, value: 5, reason: 'geo test' });
  beforeAll(() => {
    guarded = new ConfigurationService({ database: db(), env: 'test', allowTestKeys: true, scopeReferences: validator });
  });

  it('createChangeRequest accepts valid COUNTRY and MARKET references and refuses unknown ones without writing', async () => {
    mode = 'ok';
    const k = key();
    await guarded.createParameter(param(k), A);
    expect((await guarded.createChangeRequest(draft(k, 'COUNTRY', 'US'), A)).scopeRef).toBe('US');
    expect((await guarded.createChangeRequest(draft(k, 'MARKET', 'la-oc'), A)).scopeRef).toBe('la-oc');
    const e = (await rejection(guarded.createChangeRequest(draft(k, 'COUNTRY', 'us'), A))) as ConfigurationError;
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'the scope reference is not valid',
      details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'COUNTRY', check: 'NOT_FOUND' },
    });
    expect(await crCount(k)).toBe(2);
  });
  it('PLATFORM and non-geography scopes: PLATFORM is never validated; the validator decides the rest (the service has no opinion)', async () => {
    mode = 'ok';
    const k = key();
    await guarded.createParameter(param(k), A);
    calls.length = 0;
    expect((await guarded.createChangeRequest(draft(k, 'PLATFORM', null), A)).scopeType).toBe('PLATFORM');
    expect(calls).toEqual([]);
    expect(await code(guarded.createChangeRequest(draft(k, 'GIG', 'some-gig'), A))).toBe('VALIDATION_FAILED'); // this fake only knows geography
    expect(calls).toEqual([['GIG', 'some-gig']]);
  });
  it('publish re-validates the stored reference: a retired reference blocks publication, nothing is published, and it works again once valid', async () => {
    mode = 'ok';
    const k = key();
    await guarded.createParameter(param(k), A);
    const cr = await guarded.createChangeRequest(draft(k, 'MARKET', 'la-oc'), A);
    await guarded.submit(cr.changeRequestId, A);
    mode = 'retired';
    const e = (await rejection(guarded.publish(cr.changeRequestId, A))) as ConfigurationError;
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SCOPE_REFERENCE_INVALID', scopeType: 'MARKET', check: 'INACTIVE' } });
    expect((await guarded.getChangeRequest(cr.changeRequestId)).state).toBe('APPROVED');
    expect(
      Number(
        (
          await q<{ n: string }>(
            'SELECT count(*) AS n FROM configuration.value_versions vv JOIN configuration.parameter_values pv ON pv.parameter_value_id = vv.parameter_value_id JOIN configuration.parameters p ON p.parameter_id = pv.parameter_id WHERE p.key = $1',
            [k],
          )
        )[0]!.n,
      ),
    ).toBe(0);
    mode = 'ok';
    expect((await guarded.publish(cr.changeRequestId, A)).state).toBe('ACTIVE');
    expect((await guarded.value<number>(k, {}).catch(() => null)) ?? null).toBeNull(); // MARKET value does not apply without that market in the context
    expect(await guarded.value<number>(k, { market: 'la-oc' })).toBe(5);
  });
  it('a validator outage fails writes closed as UNAVAILABLE and leaves no trace', async () => {
    mode = 'ok';
    const k = key();
    await guarded.createParameter(param(k), A);
    const cr = await guarded.createChangeRequest(draft(k, 'COUNTRY', 'US'), A);
    await guarded.submit(cr.changeRequestId, A);
    mode = 'down';
    expect(await rejection(guarded.createChangeRequest(draft(k, 'COUNTRY', 'US'), A))).toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'SCOPE_REFERENCE_UNAVAILABLE', scopeType: 'COUNTRY' },
    });
    expect(await code(guarded.publish(cr.changeRequestId, A))).toBe('UNAVAILABLE');
    expect(await crCount(k)).toBe(1);
    expect((await guarded.getChangeRequest(cr.changeRequestId)).state).toBe('APPROVED');
    mode = 'ok';
  });
  it('without a validator the same database accepts any scope reference (unchanged behaviour)', async () => {
    const k = key();
    await svc.createParameter(param(k), A);
    expect((await svc.createChangeRequest(draft(k, 'COUNTRY', 'anything'), A)).scopeRef).toBe('anything');
  });
});
