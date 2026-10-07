// Integration tests of the account service: real PostgreSQL (isolated, migrated database: migration 0009 seeds the CUSTOMER and PROVIDER roles and the
// account shell copy) and the real outbox table. Every behaviour is asserted against the rows it leaves: accounts, links, memberships, history, audit and
// outbox events. Races are real (parallel transactions, or two service calls queued behind a held account row lock so their order is deterministic).
// The raw rules of the schema itself are covered in packages/testing (identity-model.itest.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDENTITY_EVENTS, type AccountStatus } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { AccountError, AccountService, type AccountContext, type VerifiedIdentity } from './index';

let iso: IsolatedDatabase;
let bigDb: Database;
let svc: AccountService;
let seq = 0;
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const E = IDENTITY_EVENTS;
const SYSTEM = 'system:account-bootstrap';

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below need up to 25 requests in flight
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 28, connectionTimeoutMs: 20_000 } });
  svc = new AccountService({ database: bigDb });
});
afterAll(async () => {
  await bigDb?.close();
  await iso?.drop();
});

// ---------------------------------------------------------------- helpers
const err = async (p: Promise<unknown>) => (await rejection(p)) as AccountError | undefined;
const code = async (p: Promise<unknown>) => (await err(p))?.code;
const reason = async (p: Promise<unknown>) => (await err(p))?.details.reason;
/** The value, or the error the call failed with (races: both outcomes are legitimate, the final state is what matters). */
const settled = <T>(p: Promise<T>): Promise<T | AccountError> =>
  p.then(
    (v) => v,
    (e: unknown) => e as AccountError,
  );
const failedWith = (r: unknown): string | undefined => (r instanceof AccountError ? r.code : r instanceof Error ? `raw:${r.message}` : undefined);
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

const ident = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  providerType: 'KEYCLOAK',
  issuer: ISSUER,
  subject: randomUUID(),
  identityRoles: ['customer'],
  ...over,
});
/** A new account created through the real first-request path. */
async function newAccount(roles: string[] = ['customer'], over: Partial<VerifiedIdentity> = {}) {
  const identity = ident({ identityRoles: roles, ...over });
  const ctx = await svc.ensureAccountForIdentity(identity);
  return { identity, ctx, id: ctx.accountId };
}
/** A PENDING account (no service path creates one yet), with its creation history row, in one transaction. */
async function pendingAccount(): Promise<string> {
  const c = await db().pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('PENDING') RETURNING account_id")).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'PENDING', 'test', 'test')",
      [id],
    );
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const OP = { actor: 'admin:operator-1', reason: 'integration test' };
const STATUS_PATHS: Record<AccountStatus, AccountStatus[]> = {
  PENDING: [],
  ACTIVE: [],
  SUSPENDED: ['SUSPENDED'],
  CLOSURE_REQUESTED: ['CLOSURE_REQUESTED'],
  CLOSED: ['SUSPENDED', 'CLOSED'],
};
/** An account without roles in the wanted status, reached along a legal path. */
async function accountIn(status: AccountStatus, roles: string[] = []): Promise<string> {
  const id = status === 'PENDING' ? await pendingAccount() : (await newAccount(roles)).id;
  for (const step of STATUS_PATHS[status]) await svc.changeStatus(id, step, OP);
  return id;
}
/** A role created directly (the service has no role administration yet), with a unique valid code. */
async function makeRole(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<string> {
  const roleCode = `TR${++seq}`;
  await q("INSERT INTO identity.roles (code, name_content_key) VALUES ($1, 'identity.role.customer.name')", [roleCode]);
  if (status === 'INACTIVE') await q("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE code = $1", [roleCode]);
  return roleCode;
}

// row inspectors, by account
const memberships = (id: string) =>
  q<{ code: string; status: string; granted_by: string; grant_source: string; activated: boolean; deactivated: boolean }>(
    `SELECT r.code, m.status, m.granted_by, m.grant_source, m.activated_at IS NOT NULL AS activated, m.deactivated_at IS NOT NULL AS deactivated
       FROM identity.account_roles m JOIN identity.roles r USING (role_id) WHERE m.account_id = $1 ORDER BY r.code`,
    [id],
  );
const memberStatus = async (id: string, roleCode: string) => (await memberships(id)).find((m) => m.code === roleCode)?.status;
const accountRow = async (id: string) =>
  (
    await q<{ status: string; primary_code: string | null; closed: boolean }>(
      `SELECT a.status, r.code AS primary_code, a.closed_at IS NOT NULL AS closed FROM identity.accounts a LEFT JOIN identity.roles r ON r.role_id = a.primary_role_id WHERE a.account_id = $1`,
      [id],
    )
  )[0]!;
const audit = (id: string) =>
  q<{ action: string; actor: string; role: string | null; changes: Record<string, unknown> | null; reason: string | null; correlation_id: string }>(
    `SELECT a.action, a.actor, r.code AS role, a.changes, a.reason, a.correlation_id FROM identity.account_audit_events a LEFT JOIN identity.roles r USING (role_id)
      WHERE a.account_id = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [id],
  );
const history = (id: string) =>
  q<{ from_status: string | null; to_status: string; reason: string | null; actor: string; correlation_id: string }>(
    'SELECT from_status, to_status, reason, actor, correlation_id FROM identity.account_status_history WHERE account_id = $1 ORDER BY history_seq',
    [id],
  );
interface EventRow {
  event_type: string;
  aggregate_type: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
  payload_json: Record<string, unknown>;
}
const events = (id: string) =>
  q<EventRow>('SELECT event_type, aggregate_type, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events WHERE aggregate_id = $1', [
    id,
  ]);
const eventsOf = async (id: string, type: string) => (await events(id)).filter((e) => e.event_type === type);
const eventTypes = async (id: string) => (await events(id)).map((e) => e.event_type).sort();
const identities = (id: string) =>
  q<{ provider_type: string; issuer: string; provider_subject: string }>(
    'SELECT provider_type, issuer, provider_subject FROM identity.external_identities WHERE account_id = $1',
    [id],
  );
const IDENTITY_TABLES = ['roles', 'accounts', 'account_roles', 'external_identities', 'account_status_history', 'account_profiles', 'account_audit_events'];
/** Row counts of everything the service writes (the outbox only for identity events). */
async function world(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of IDENTITY_TABLES) out[t] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM identity.${t}`))[0]!.n;
  out.outbox = (await q<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.%'"))[0]!.n;
  return out;
}
/** Per-account row counts (identity tables and outbox) for "nothing was written" assertions. */
interface Footprint {
  memberships: number;
  audit: number;
  history: number;
  identities: number;
  profiles: number;
  events: number;
}
async function footprint(id: string): Promise<Footprint> {
  const n = async (text: string) => (await q<{ n: number }>(text, [id]))[0]!.n;
  return {
    memberships: await n('SELECT count(*)::int AS n FROM identity.account_roles WHERE account_id = $1'),
    audit: await n('SELECT count(*)::int AS n FROM identity.account_audit_events WHERE account_id = $1'),
    history: await n('SELECT count(*)::int AS n FROM identity.account_status_history WHERE account_id = $1'),
    identities: await n('SELECT count(*)::int AS n FROM identity.external_identities WHERE account_id = $1'),
    profiles: await n('SELECT count(*)::int AS n FROM identity.account_profiles WHERE account_id = $1'),
    events: await n('SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = $1::text'),
  };
}
/** The tables (identity schema and outbox) whose rows contain this text anywhere: where did a value end up? */
async function tablesContaining(needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const t of [...IDENTITY_TABLES.map((x) => `identity.${x}`), 'integration.outbox_events']) {
    const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} x WHERE strpos(x::text, $1) > 0`, [needle]);
    if (r[0]!.n > 0) found.push(t);
  }
  return found;
}
const MICROS = (col: string) => `(extract(epoch from ${col}) * 1000000)::bigint::text`;
const lastSeen = async (id: string): Promise<bigint> =>
  BigInt((await q<{ t: string }>(`SELECT ${MICROS('last_seen_at')} AS t FROM identity.external_identities WHERE account_id = $1`, [id]))[0]!.t);
const dbNow = async (): Promise<bigint> => BigInt((await q<{ t: string }>(`SELECT ${MICROS('clock_timestamp()')} AS t`))[0]!.t);
const updatedAt = async (table: 'accounts' | 'account_profiles', id: string): Promise<bigint> =>
  BigInt((await q<{ t: string }>(`SELECT ${MICROS('updated_at')} AS t FROM identity.${table} WHERE account_id = $1`, [id]))[0]!.t);

/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
/**
 * Runs service calls in a fixed order: a raw transaction holds the account row lock, the calls start one by one and queue behind it (every service
 * transaction takes that lock first), then the lock is released and they run in arrival order.
 */
async function inOrder(accountId: string, ...calls: (() => Promise<unknown>)[]): Promise<unknown[]> {
  const holder = await db().pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
    const running: Promise<unknown>[] = [];
    for (const call of calls) {
      running.push(settled(call()));
      await lockWaiters(running.length);
    }
    await holder.query('COMMIT');
    return await Promise.all(running);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}
/** The invariants that must hold after any interleaving (checked globally: every account of this database). */
async function expectInvariants(): Promise<void> {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.accounts a WHERE a.primary_role_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM identity.account_roles m WHERE m.account_id = a.account_id AND m.role_id = a.primary_role_id AND m.status = 'ACTIVE')`),
    'a primary role points at a membership that is not ACTIVE',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.accounts a WHERE a.status = 'CLOSED' AND (a.primary_role_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM identity.account_roles m WHERE m.account_id = a.account_id AND m.status IN ('PENDING', 'ACTIVE')))`),
    'a CLOSED account holds a role',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.accounts a WHERE a.status IS DISTINCT FROM
      (SELECT h.to_status FROM identity.account_status_history h WHERE h.account_id = a.account_id ORDER BY h.history_seq DESC LIMIT 1)`),
    'the status differs from the newest history row',
  ).toBe(0);
}
/** The history of an account is a chain: it starts from NULL and every row starts where the previous one ended. */
async function expectHistoryChain(id: string): Promise<void> {
  const rows = await history(id);
  expect(rows[0]!.from_status).toBeNull();
  rows.slice(1).forEach((r, i) => expect(r.from_status, `history row ${i + 1}`).toBe(rows[i]!.to_status));
  expect(rows.at(-1)!.to_status).toBe((await accountRow(id)).status);
  expect((await eventsOf(id, E.accountStatusChanged)).length).toBe(rows.length - 1); // creation writes no status-changed event
}

// ====================================================================== first authenticated request
describe('the first authenticated identity creates exactly one account', () => {
  it('creates an ACTIVE account with its link, creation history row, audit rows and outbox events (customer token)', async () => {
    const identity = ident();
    const before = await world();
    const ctx = await svc.ensureAccountForIdentity(identity);
    const id = ctx.accountId;
    expect(ctx).toMatchObject({
      status: 'ACTIVE',
      created: true,
      roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
      memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      primaryRole: 'CUSTOMER',
      activeRole: 'CUSTOMER',
      profile: null,
    });
    expect(ctx.createdAt).toBeInstanceOf(Date);
    expect(await accountRow(id)).toEqual({ status: 'ACTIVE', primary_code: 'CUSTOMER', closed: false });
    expect(await identities(id)).toEqual([{ provider_type: 'KEYCLOAK', issuer: ISSUER, provider_subject: identity.subject }]);

    const h = await history(id);
    expect(h).toEqual([
      { from_status: null, to_status: 'ACTIVE', reason: 'account created from the first verified identity', actor: SYSTEM, correlation_id: expect.any(String) },
    ]);

    const a = await audit(id);
    expect(a.map((x) => [x.action, x.role, x.changes])).toEqual([
      ['ACCOUNT_CREATED', null, { status: [null, 'ACTIVE'] }],
      ['EXTERNAL_IDENTITY_LINKED', null, { providerType: 'KEYCLOAK' }],
      ['ROLE_GRANTED', 'CUSTOMER', { status: [null, 'ACTIVE'], source: 'BOOTSTRAP' }],
      ['PRIMARY_ROLE_CHANGED', null, { primaryRole: [null, 'CUSTOMER'] }],
    ]);
    expect(a.every((x) => x.actor === SYSTEM)).toBe(true);

    expect(await eventTypes(id)).toEqual([E.accountCreated, E.accountRoleGranted, E.externalIdentityLinked].sort());
    const ev = await events(id);
    for (const e of ev)
      expect({ aggregate: e.aggregate_type, actorType: e.actor_type, actorId: e.actor_id }).toEqual({
        aggregate: 'identity_account',
        actorType: 'system',
        actorId: SYSTEM,
      });
    expect((await eventsOf(id, E.accountCreated))[0]!.payload_json).toEqual({ accountId: id, status: 'ACTIVE' });
    expect((await eventsOf(id, E.externalIdentityLinked))[0]!.payload_json).toEqual({ accountId: id, providerType: 'KEYCLOAK' });
    expect((await eventsOf(id, E.accountRoleGranted))[0]!.payload_json).toEqual({ accountId: id, roleCode: 'CUSTOMER', source: 'BOOTSTRAP' });
    expect(await eventsOf(id, E.accountStatusChanged)).toEqual([]); // creation is not a status change

    // one transaction, one correlation id across history, audit and events
    const correlation = new Set([...h.map((x) => x.correlation_id), ...a.map((x) => x.correlation_id), ...ev.map((x) => x.correlation_id)]);
    expect(correlation.size).toBe(1);

    const after = await world();
    expect(after).toEqual({
      ...before,
      accounts: before.accounts! + 1,
      account_roles: before.account_roles! + 1,
      external_identities: before.external_identities! + 1,
      account_status_history: before.account_status_history! + 1,
      account_audit_events: before.account_audit_events! + 4,
      outbox: before.outbox! + 3,
    });
  });

  it('never copies the Keycloak subject or issuer anywhere but the link row (history, audit, memberships and events carry identifiers only)', async () => {
    const identity = ident({ issuer: `https://issuer-${randomUUID()}.example/realms/needle`, identityRoles: ['customer', 'provider'] });
    const { accountId } = await svc.ensureAccountForIdentity(identity);
    expect(await tablesContaining(identity.subject)).toEqual(['identity.external_identities']);
    expect(await tablesContaining(identity.issuer)).toEqual(['identity.external_identities']);
    expect(await tablesContaining(accountId)).toEqual(expect.arrayContaining(['identity.accounts', 'integration.outbox_events']));
  });

  it('takes the correlation id of the request context for history, audit and events', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const { accountId } = await runWithCorrelation(correlationId, () => svc.ensureAccountForIdentity(ident()));
    const all = [...(await history(accountId)), ...(await audit(accountId)), ...(await events(accountId))].map((r) => r.correlation_id);
    expect(all.length).toBe(1 + 4 + 3);
    expect(new Set(all)).toEqual(new Set([correlationId]));
  });

  const BOOTSTRAP: { realm: string[]; roles: string[]; primary: string | null; note: string }[] = [
    { realm: ['customer'], roles: ['CUSTOMER'], primary: 'CUSTOMER', note: 'customer only' },
    { realm: ['provider'], roles: ['PROVIDER'], primary: 'PROVIDER', note: 'provider only (a provider-first sign-up is not also a customer)' },
    { realm: ['customer', 'provider'], roles: ['CUSTOMER', 'PROVIDER'], primary: 'CUSTOMER', note: 'both' },
    {
      realm: ['provider', 'customer'],
      roles: ['CUSTOMER', 'PROVIDER'],
      primary: 'CUSTOMER',
      note: 'both, in the other token order (the mapping decides the order)',
    },
    { realm: ['customer', 'customer', 'provider'], roles: ['CUSTOMER', 'PROVIDER'], primary: 'CUSTOMER', note: 'duplicates in the token' },
    { realm: [], roles: [], primary: null, note: 'no realm role' },
    { realm: ['admin', 'offline_access', 'uma_authorization', 'default-roles-bananagig'], roles: [], primary: null, note: 'only unknown realm roles' },
    { realm: ['admin', 'customer', 'offline_access'], roles: ['CUSTOMER'], primary: 'CUSTOMER', note: 'unknown realm roles next to a known one' },
    { realm: ['Customer', 'PROVIDER'], roles: [], primary: null, note: 'realm roles are matched exactly (case)' },
  ];
  it.each(BOOTSTRAP)('bootstraps the application roles from the realm roles once: $note', async ({ realm, roles, primary }) => {
    const { id, ctx } = await newAccount(realm);
    expect(ctx.status).toBe('ACTIVE');
    expect(ctx.created).toBe(true);
    expect(ctx.roles.map((r) => r.code)).toEqual(roles);
    expect(ctx.memberships.map((m) => [m.code, m.status])).toEqual(roles.map((r) => [r, 'ACTIVE']));
    expect(ctx.primaryRole).toBe(primary);
    expect(ctx.activeRole).toBe(primary); // the primary role is the active role until a request names another
    expect((await memberships(id)).map((m) => [m.code, m.status, m.granted_by, m.grant_source, m.activated, m.deactivated])).toEqual(
      roles.map((r) => [r, 'ACTIVE', SYSTEM, 'BOOTSTRAP', true, false]),
    );
    expect((await accountRow(id)).primary_code).toBe(primary);
    const granted = (await eventsOf(id, E.accountRoleGranted)).map((e) => e.payload_json);
    expect(granted).toHaveLength(roles.length);
    expect(granted.map((p) => p.roleCode).sort()).toEqual([...roles].sort());
    for (const p of granted) expect(p).toEqual({ accountId: id, roleCode: p.roleCode, source: 'BOOTSTRAP' });
    const actions = (await audit(id)).map((x) => x.action);
    expect(actions.filter((x) => x === 'ROLE_GRANTED')).toHaveLength(roles.length);
    expect(actions.filter((x) => x === 'PRIMARY_ROLE_CHANGED')).toHaveLength(primary ? 1 : 0);
    // the account always exists with its link and creation rows, even without a role
    expect(actions.slice(0, 2)).toEqual(['ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED']);
    expect(await history(id)).toHaveLength(1);
    expect(await eventsOf(id, E.accountCreated)).toHaveLength(1);
  });

  it('audits the bootstrap grants in mapping order (CUSTOMER first) with a single primary role change', async () => {
    const { id } = await newAccount(['provider', 'customer']);
    expect((await audit(id)).map((x) => [x.action, x.role])).toEqual([
      ['ACCOUNT_CREATED', null],
      ['EXTERNAL_IDENTITY_LINKED', null],
      ['ROLE_GRANTED', 'CUSTOMER'],
      ['PRIMARY_ROLE_CHANGED', null],
      ['ROLE_GRANTED', 'PROVIDER'],
    ]);
  });

  it('rejects an unusable verified identity before touching the database (typed, no identity value in the error)', async () => {
    const before = await world();
    const cases: [VerifiedIdentity, string][] = [
      [ident({ subject: '' }), 'subject'],
      [ident({ subject: '   ' }), 'subject'],
      [ident({ subject: 's'.repeat(256) }), 'subject'],
      [ident({ subject: `sub${ch(0x0a)}x` }), 'subject'],
      [ident({ issuer: '' }), 'issuer'],
      [ident({ issuer: `https://${'a'.repeat(505)}` }), 'issuer'],
      [ident({ issuer: `https://auth${ch(0x01)}.example` }), 'issuer'],
      [ident({ providerType: 'GOOGLE' as never }), 'providerType'],
    ];
    for (const [identity, field] of cases) {
      const e = await err(svc.ensureAccountForIdentity(identity));
      expect(e).toBeInstanceOf(AccountError);
      expect({ code: e!.code, reason: e!.details.reason, field: e!.details.field }).toEqual({ code: 'VALIDATION_FAILED', reason: 'INVALID_IDENTITY', field });
      expect(JSON.stringify({ m: e!.message, d: e!.details })).not.toContain(identity.subject.trim() || 'x-never');
    }
    expect(await world()).toEqual(before);
  });
});

// ====================================================================== repeated calls
describe('repeated first requests', () => {
  it('return the same account with created false and write nothing; the realm roles of LATER tokens are ignored', async () => {
    const { identity, id } = await newAccount(['customer']);
    const before = await footprint(id);
    const worldBefore = await world();
    for (const roles of [['customer'], ['provider'], [], ['customer', 'provider'], ['admin'], ['provider', 'customer']]) {
      const ctx = await svc.ensureAccountForIdentity({ ...identity, identityRoles: roles });
      expect(ctx.accountId).toBe(id);
      expect(ctx.created).toBe(false);
      expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']); // a later token without customer does not remove it, one with provider does not add it
      expect(ctx.primaryRole).toBe('CUSTOMER');
    }
    expect(await footprint(id)).toEqual(before);
    expect(await world()).toEqual(worldBefore);
    expect((await memberships(id)).map((m) => m.code)).toEqual(['CUSTOMER']);
  });

  it('ignore the roles of a later token also when the first token had none', async () => {
    const { identity, id } = await newAccount([]);
    const ctx = await svc.ensureAccountForIdentity({ ...identity, identityRoles: ['customer', 'provider'] });
    expect(ctx).toMatchObject({ accountId: id, created: false, roles: [], memberships: [], primaryRole: null, activeRole: null });
    expect(await memberships(id)).toEqual([]);
  });

  it('keep roles that the application changed since: a deactivated role stays deactivated when a token carries it again', async () => {
    const { identity, id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const ctx = await svc.ensureAccountForIdentity({ ...identity, identityRoles: ['customer', 'provider'] });
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']);
    expect(await memberStatus(id, 'PROVIDER')).toBe('INACTIVE');
  });
});

describe('last_seen_at', () => {
  const touching = (seconds: number) => new AccountService({ database: bigDb, lastSeenTouchSeconds: seconds });

  it('is touched on every call with an interval of 0', async () => {
    const s = touching(0);
    const identity = ident();
    const created = await s.ensureAccountForIdentity(identity);
    const l0 = await lastSeen(created.accountId);
    const t0 = await dbNow();
    await s.ensureAccountForIdentity(identity);
    const l1 = await lastSeen(created.accountId);
    await s.ensureAccountForIdentity(identity);
    const l2 = await lastSeen(created.accountId);
    const t1 = await dbNow();
    expect(l1 > l0).toBe(true);
    expect(l2 > l1).toBe(true);
    expect(l1 >= t0 && l2 <= t1).toBe(true); // the database clock, not the application clock
  });

  it('is left alone inside a large interval, and touched again once it is older than the interval (database clock)', async () => {
    const s = touching(3600);
    const identity = ident();
    const { accountId } = await s.ensureAccountForIdentity(identity);
    const created = await lastSeen(accountId);
    for (let i = 0; i < 3; i++) await s.ensureAccountForIdentity(identity);
    expect(await lastSeen(accountId)).toBe(created);
    await q("UPDATE identity.external_identities SET last_seen_at = now() - interval '2 hours' WHERE account_id = $1", [accountId]);
    const stale = await lastSeen(accountId);
    const t0 = await dbNow();
    await s.ensureAccountForIdentity(identity);
    const touched = await lastSeen(accountId);
    const t1 = await dbNow();
    expect(touched > stale && touched >= t0 && touched <= t1).toBe(true);
    await s.ensureAccountForIdentity(identity);
    expect(await lastSeen(accountId)).toBe(touched); // inside the interval again
  });

  it('uses 300 seconds by default and touches nothing but last_seen_at', async () => {
    const s = new AccountService({ database: bigDb });
    const { identity, id } = await newAccount();
    const worldBefore = await world();
    const rowBefore = await q(
      'SELECT external_identity_id, account_id, issuer, provider_subject, created_at FROM identity.external_identities WHERE account_id = $1',
      [id],
    );
    await q("UPDATE identity.external_identities SET last_seen_at = now() - interval '240 seconds' WHERE account_id = $1", [id]);
    const young = await lastSeen(id);
    await s.ensureAccountForIdentity(identity);
    expect(await lastSeen(id)).toBe(young);
    await q("UPDATE identity.external_identities SET last_seen_at = now() - interval '301 seconds' WHERE account_id = $1", [id]);
    const old = await lastSeen(id);
    await s.ensureAccountForIdentity(identity);
    expect(await lastSeen(id)).toBeGreaterThan(old);
    expect(
      await q('SELECT external_identity_id, account_id, issuer, provider_subject, created_at FROM identity.external_identities WHERE account_id = $1', [id]),
    ).toEqual(rowBefore);
    expect(await world()).toEqual(worldBefore);
  });

  it('a failing touch never fails the request: the context is returned and one warning (without the subject) is logged', async () => {
    await q(`CREATE FUNCTION public.block_touch_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'touch blocked for test'; END $$`);
    try {
      const s = touching(0);
      const identity = ident();
      const created = await s.ensureAccountForIdentity(identity);
      await q('CREATE TRIGGER zz_block_touch BEFORE UPDATE ON identity.external_identities FOR EACH ROW EXECUTE FUNCTION public.block_touch_for_test()');
      const before = await lastSeen(created.accountId);
      const out = captureOutput();
      let again: AccountContext;
      try {
        again = await s.ensureAccountForIdentity(identity); // the UPDATE fails, the request does not
      } finally {
        out.stop();
      }
      expect(again).toMatchObject({ accountId: created.accountId, created: false, status: 'ACTIVE' });
      expect(await lastSeen(created.accountId)).toBe(before);
      const warnings = out.lines.filter((l) => l.includes('account last_seen_at could not be updated')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: 'warn', message: 'account last_seen_at could not be updated' });
      expect(out.lines.join('\n')).not.toContain(identity.subject);
    } finally {
      await q('DROP TRIGGER IF EXISTS zz_block_touch ON identity.external_identities');
      await q('DROP FUNCTION IF EXISTS public.block_touch_for_test()');
    }
  });
});

// ====================================================================== concurrency of the first request
describe('parallel first requests', () => {
  async function race(n: number, roles: string[]) {
    const identity = ident({ identityRoles: roles });
    const before = await world();
    const results = await Promise.all(Array.from({ length: n }, () => svc.ensureAccountForIdentity(identity)));
    const id = results[0]!.accountId;
    expect(new Set(results.map((r) => r.accountId))).toEqual(new Set([id]));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const expectedRoles = roles.includes('customer') && roles.includes('provider') ? 2 : roles.length;
    // exactly one account, one identity row, one history row, one of each audit and event
    const after = await world();
    expect(after.accounts! - before.accounts!).toBe(1);
    expect(after.external_identities! - before.external_identities!).toBe(1);
    expect(after.account_status_history! - before.account_status_history!).toBe(1);
    expect(after.account_roles! - before.account_roles!).toBe(expectedRoles);
    expect(await identities(id)).toHaveLength(1);
    expect(await history(id)).toHaveLength(1);
    const actions = (await audit(id)).map((a) => a.action);
    expect(actions.filter((a) => a === 'ACCOUNT_CREATED')).toHaveLength(1);
    expect(actions.filter((a) => a === 'EXTERNAL_IDENTITY_LINKED')).toHaveLength(1);
    expect(actions.filter((a) => a === 'ROLE_GRANTED')).toHaveLength(expectedRoles);
    expect(actions.filter((a) => a === 'PRIMARY_ROLE_CHANGED')).toHaveLength(expectedRoles > 0 ? 1 : 0);
    expect(await eventsOf(id, E.accountCreated)).toHaveLength(1);
    expect(await eventsOf(id, E.externalIdentityLinked)).toHaveLength(1);
    expect(await eventsOf(id, E.accountRoleGranted)).toHaveLength(expectedRoles);
    expect((await accountRow(id)).primary_code).toBe(expectedRoles > 0 ? (roles.includes('customer') ? 'CUSTOMER' : 'PROVIDER') : null);
    // the losers rolled back completely: no account without a link was left behind
    expect(after.outbox! - before.outbox!).toBe(2 + expectedRoles);
    return id;
  }

  it.each([10, 10, 10, 25, 25, 25])(
    '%i parallel first requests for one identity create one account, and every caller gets it (exactly one created=true)',
    async (n) => {
      await race(n, ['customer']);
      await expectInvariants();
    },
  );

  it('keeps the bootstrap exact when both realm roles race: one membership per role, one grant event per role', async () => {
    await race(12, ['customer', 'provider']);
    await race(12, []);
    await race(12, ['provider']);
  });

  it('parallel first requests for DIFFERENT identities create distinct accounts', async () => {
    const identities20 = Array.from({ length: 20 }, () => ident());
    const before = await world();
    const results = await Promise.all(identities20.map((i) => svc.ensureAccountForIdentity(i)));
    expect(new Set(results.map((r) => r.accountId)).size).toBe(20);
    expect(results.every((r) => r.created)).toBe(true);
    const after = await world();
    expect(after.accounts! - before.accounts!).toBe(20);
    expect(after.external_identities! - before.external_identities!).toBe(20);
  });

  it('interleaved callers of several identities: one account per identity, one created=true per identity', async () => {
    const people = Array.from({ length: 8 }, () => ident());
    const calls = Array.from({ length: 4 }, () => people).flat(); // identity i appears four times, interleaved
    const before = await world();
    const results = await Promise.all(calls.map((i) => svc.ensureAccountForIdentity(i)));
    const bySubject = new Map<string, AccountContext[]>();
    calls.forEach((i, k) => bySubject.set(i.subject, [...(bySubject.get(i.subject) ?? []), results[k]!]));
    expect(bySubject.size).toBe(8);
    for (const rs of bySubject.values()) {
      expect(new Set(rs.map((r) => r.accountId)).size).toBe(1);
      expect(rs.filter((r) => r.created)).toHaveLength(1);
    }
    expect(new Set(results.map((r) => r.accountId)).size).toBe(8);
    expect((await world()).accounts! - before.accounts!).toBe(8);
    await expectInvariants();
  });
});

describe('identity keys', () => {
  it('maps the same subject under another issuer to another account, and the key is used verbatim (case, trailing space)', async () => {
    const subject = `s-${randomUUID()}`;
    const a = await svc.ensureAccountForIdentity(ident({ subject }));
    const sameAgain = await svc.ensureAccountForIdentity(ident({ subject }));
    const otherIssuer = await svc.ensureAccountForIdentity(ident({ subject, issuer: 'https://other.example/realms/bananagig' }));
    const upper = await svc.ensureAccountForIdentity(ident({ subject: subject.toUpperCase() }));
    const padded = await svc.ensureAccountForIdentity(ident({ subject: `${subject} ` }));
    expect(sameAgain.accountId).toBe(a.accountId);
    expect(sameAgain.created).toBe(false);
    const distinct = new Set([a, otherIssuer, upper, padded].map((c) => c.accountId));
    expect(distinct.size).toBe(4);
    expect([otherIssuer, upper, padded].every((c) => c.created)).toBe(true);
  });

  it('cannot link one identity to two accounts: a second creation path fails on the unique key and rolls back, leaving no orphan account', async () => {
    const { identity } = await newAccount();
    const before = await world();
    const c = await db().pool.connect();
    let failure: { code?: string; constraint?: string } | undefined;
    try {
      await c.query('BEGIN');
      const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0].account_id as string;
      await c.query(
        "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'ACTIVE', 'test', 'test')",
        [id],
      );
      await c.query("INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject) VALUES ($1, 'KEYCLOAK', $2, $3)", [
        id,
        identity.issuer,
        identity.subject,
      ]);
      await c.query('COMMIT');
    } catch (e) {
      failure = e as { code?: string; constraint?: string };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(failure).toMatchObject({ code: '23505', constraint: 'uq_external_identities__provider_issuer_subject' });
    expect(await world()).toEqual(before);
    expect(await svc.ensureAccountForIdentity(identity)).toMatchObject({ created: false });
  });
});

// ====================================================================== grantRole
describe('grantRole', () => {
  it('adds PROVIDER to an existing CUSTOMER account: both roles are active and the primary role is unchanged', async () => {
    const { id } = await newAccount(['customer']);
    const before = await world();
    const r = await svc.grantRole(id, 'PROVIDER', { actor: 'system:provider-onboarding', source: 'SYSTEM', reason: 'provider signup' });
    expect(r).toEqual({ changed: true, status: 'ACTIVE' });
    const ctx = await svc.getAccountContext(id);
    expect(ctx.roles.map((x) => x.code)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(ctx.primaryRole).toBe('CUSTOMER');
    expect(ctx.activeRole).toBe('CUSTOMER');
    expect(await memberships(id)).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE', granted_by: SYSTEM, grant_source: 'BOOTSTRAP', activated: true, deactivated: false },
      { code: 'PROVIDER', status: 'ACTIVE', granted_by: 'system:provider-onboarding', grant_source: 'SYSTEM', activated: true, deactivated: false },
    ]);
    const last = (await audit(id)).at(-1)!;
    expect(last).toMatchObject({
      action: 'ROLE_GRANTED',
      actor: 'system:provider-onboarding',
      role: 'PROVIDER',
      reason: 'provider signup',
      changes: { status: [null, 'ACTIVE'], source: 'SYSTEM' },
    });
    expect((await audit(id)).filter((a) => a.action === 'PRIMARY_ROLE_CHANGED')).toHaveLength(1); // only the bootstrap one
    const granted = (await eventsOf(id, E.accountRoleGranted)).find((e) => e.payload_json.roleCode === 'PROVIDER')!;
    expect(granted).toMatchObject({
      aggregate_type: 'identity_account',
      actor_type: 'system',
      actor_id: 'system:provider-onboarding',
      payload_json: { accountId: id, roleCode: 'PROVIDER', source: 'SYSTEM' },
    });
    const after = await world();
    expect(after.account_roles! - before.account_roles!).toBe(1);
    expect(after.account_audit_events! - before.account_audit_events!).toBe(1);
    expect(after.outbox! - before.outbox!).toBe(1);
  });

  it('records an administrator as a user actor', async () => {
    const { id } = await newAccount(['customer']);
    await svc.grantRole(id, 'PROVIDER', { actor: 'admin:operator-7', source: 'ADMIN' });
    expect((await eventsOf(id, E.accountRoleGranted)).find((e) => e.payload_json.roleCode === 'PROVIDER')).toMatchObject({
      actor_type: 'user',
      actor_id: 'admin:operator-7',
    });
  });

  it('makes the first active role the primary role (an account that started without roles)', async () => {
    const { id } = await newAccount([]);
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:test', source: 'SYSTEM' });
    expect(await accountRow(id)).toMatchObject({ primary_code: 'PROVIDER' });
    expect((await audit(id)).at(-1)).toMatchObject({ action: 'PRIMARY_ROLE_CHANGED', changes: { primaryRole: [null, 'PROVIDER'] } });
    await svc.grantRole(id, 'CUSTOMER', { actor: 'system:test', source: 'SYSTEM' });
    expect((await accountRow(id)).primary_code).toBe('PROVIDER'); // the second role does not take over
  });

  it('is idempotent: a second call changes nothing, writes no audit or outbox row and keeps the first grant details', async () => {
    const { id } = await newAccount(['customer']);
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:first', source: 'SYSTEM' });
    const before = await footprint(id);
    const worldBefore = await world();
    const again = await svc.grantRole(id, 'PROVIDER', { actor: 'admin:someone-else', source: 'ADMIN', reason: 'again' });
    expect(again).toEqual({ changed: false, status: 'ACTIVE' });
    expect(await svc.grantRole(id, 'CUSTOMER', { actor: 'system:x', source: 'SYSTEM' })).toEqual({ changed: false, status: 'ACTIVE' });
    expect(await footprint(id)).toEqual(before);
    expect(await world()).toEqual(worldBefore);
    expect((await memberships(id)).find((m) => m.code === 'PROVIDER')).toMatchObject({ granted_by: 'system:first', grant_source: 'SYSTEM' });
  });

  it('creates one membership, one ROLE_GRANTED audit row and one event for 20 parallel duplicate grants', async () => {
    const { id } = await newAccount(['customer']);
    const before = await footprint(id);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.grantRole(id, 'PROVIDER', { actor: `system:racer-${i}`, source: 'SYSTEM' })));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect((await memberships(id)).filter((m) => m.code === 'PROVIDER')).toHaveLength(1);
    const after = await footprint(id);
    expect(after.memberships - before.memberships).toBe(1);
    expect(after.audit - before.audit).toBe(1);
    expect(after.events - before.events).toBe(1);
    expect((await audit(id)).filter((a) => a.action === 'ROLE_GRANTED' && a.role === 'PROVIDER')).toHaveLength(1);
    expect((await eventsOf(id, E.accountRoleGranted)).filter((e) => e.payload_json.roleCode === 'PROVIDER')).toHaveLength(1);
    // the winner's actor is the recorded one
    const winner = (await memberships(id)).find((m) => m.code === 'PROVIDER')!.granted_by;
    expect(winner).toMatch(/^system:racer-\d+$/);
    expect((await audit(id)).at(-1)!.actor).toBe(winner);
  });

  it('parallel grants of both roles to a role-less account give both roles exactly once and exactly one primary role', async () => {
    const { id } = await newAccount([]);
    await Promise.all([
      ...Array.from({ length: 6 }, () => svc.grantRole(id, 'CUSTOMER', { actor: 'system:p', source: 'SYSTEM' })),
      ...Array.from({ length: 6 }, () => svc.grantRole(id, 'PROVIDER', { actor: 'system:p', source: 'SYSTEM' })),
    ]);
    expect((await memberships(id)).map((m) => [m.code, m.status])).toEqual([
      ['CUSTOMER', 'ACTIVE'],
      ['PROVIDER', 'ACTIVE'],
    ]);
    expect((await audit(id)).filter((a) => a.action === 'PRIMARY_ROLE_CHANGED')).toHaveLength(1);
    expect(['CUSTOMER', 'PROVIDER']).toContain((await accountRow(id)).primary_code);
    await expectInvariants();
  });

  it('grants a PENDING membership without an event or a primary role, and a later grant activates it', async () => {
    const { id } = await newAccount([]);
    const before = await footprint(id);
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'system:test', source: 'SYSTEM', pending: true })).toEqual({ changed: true, status: 'PENDING' });
    expect(await memberships(id)).toEqual([
      { code: 'PROVIDER', status: 'PENDING', granted_by: 'system:test', grant_source: 'SYSTEM', activated: false, deactivated: false },
    ]);
    expect((await audit(id)).at(-1)).toMatchObject({ action: 'ROLE_GRANTED', role: 'PROVIDER', changes: { status: [null, 'PENDING'], source: 'SYSTEM' } });
    expect(await eventsOf(id, E.accountRoleGranted)).toEqual([]); // the event describes an ACTIVE membership
    expect((await accountRow(id)).primary_code).toBeNull();
    const ctx = await svc.getAccountContext(id);
    expect({ roles: ctx.roles, memberships: ctx.memberships, activeRole: ctx.activeRole }).toEqual({
      roles: [],
      memberships: [{ code: 'PROVIDER', status: 'PENDING' }],
      activeRole: null,
    });
    expect(await code(svc.selectActiveRole(id, 'PROVIDER'))).toBe('ROLE_NOT_ACTIVE');
    // pending again: idempotent
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'system:test', source: 'SYSTEM', pending: true })).toEqual({ changed: false, status: 'PENDING' });
    expect((await footprint(id)).audit - before.audit).toBe(1);
    // activation
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'admin:approver', source: 'ADMIN', reason: 'approved' })).toEqual({ changed: true, status: 'ACTIVE' });
    expect(await memberships(id)).toEqual([
      { code: 'PROVIDER', status: 'ACTIVE', granted_by: 'admin:approver', grant_source: 'ADMIN', activated: true, deactivated: false },
    ]);
    expect(
      (await audit(id)).filter((a) => a.action === 'ROLE_ACTIVATED' || a.action === 'PRIMARY_ROLE_CHANGED').map((a) => [a.action, a.changes, a.reason]),
    ).toEqual([
      ['ROLE_ACTIVATED', { status: ['PENDING', 'ACTIVE'], source: 'ADMIN' }, 'approved'],
      ['PRIMARY_ROLE_CHANGED', { primaryRole: [null, 'PROVIDER'] }, 'approved'],
    ]);
    expect(await eventsOf(id, E.accountRoleGranted)).toHaveLength(1);
    expect((await accountRow(id)).primary_code).toBe('PROVIDER');
    // an ACTIVE membership stays ACTIVE when pending is asked again
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'system:test', source: 'SYSTEM', pending: true })).toEqual({ changed: false, status: 'ACTIVE' });
  });

  it('reactivates a deactivated membership: ROLE_ACTIVATED audit, granted_by and source updated, deactivated_at cleared, event emitted', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const before = await footprint(id);
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'admin:second', source: 'ADMIN', reason: 'came back' })).toEqual({ changed: true, status: 'ACTIVE' });
    expect((await memberships(id)).find((m) => m.code === 'PROVIDER')).toEqual({
      code: 'PROVIDER',
      status: 'ACTIVE',
      granted_by: 'admin:second',
      grant_source: 'ADMIN',
      activated: true,
      deactivated: false,
    });
    expect((await audit(id)).at(-1)).toMatchObject({
      action: 'ROLE_ACTIVATED',
      actor: 'admin:second',
      role: 'PROVIDER',
      reason: 'came back',
      changes: { status: ['INACTIVE', 'ACTIVE'], source: 'ADMIN' },
    });
    const after = await footprint(id);
    expect([after.memberships - before.memberships, after.audit - before.audit, after.events - before.events]).toEqual([0, 1, 1]);
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER'); // the account still has a primary role
  });

  it('restores the primary role when the reactivated role is the account only role', async () => {
    const { id } = await newAccount(['customer']);
    await svc.deactivateRole(id, 'CUSTOMER', OP);
    expect((await accountRow(id)).primary_code).toBeNull();
    await svc.grantRole(id, 'CUSTOMER', { actor: 'admin:back', source: 'ADMIN' });
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
    expect((await audit(id)).slice(-2).map((a) => a.action)).toEqual(['ROLE_ACTIVATED', 'PRIMARY_ROLE_CHANGED']);
  });

  it('refuses to send a deactivated membership back to PENDING (INVALID_STATE) and writes nothing', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const before = await footprint(id);
    const e = await err(svc.grantRole(id, 'PROVIDER', { actor: 'system:x', source: 'SYSTEM', pending: true }));
    expect({ code: e?.code, reason: e?.details.reason }).toEqual({ code: 'INVALID_STATE', reason: 'ROLE_STATUS_TRANSITION' });
    expect(await footprint(id)).toEqual(before);
    expect(await memberStatus(id, 'PROVIDER')).toBe('INACTIVE');
  });

  it('fails with typed errors and writes nothing: unknown role, inactive role, closed account, unknown account, bad arguments', async () => {
    const { id } = await newAccount(['customer']);
    const inactive = await makeRole('INACTIVE');
    const worldBefore = await world();
    const grant = (accountId: string, role: string, over: Record<string, unknown> = {}) =>
      svc.grantRole(accountId, role, { actor: 'system:test', source: 'SYSTEM', ...over } as never);
    expect(await code(grant(id, 'NOPE'))).toBe('ROLE_NOT_FOUND');
    expect(await code(grant(id, 'customer'))).toBe('ROLE_NOT_FOUND'); // codes are exact
    expect(await code(grant(id, inactive))).toBe('ROLE_NOT_ACTIVE');
    expect(await code(grant(randomUUID(), 'PROVIDER'))).toBe('NOT_FOUND');
    expect(await code(grant(id, 'PROVIDER', { actor: '   ' }))).toBe('VALIDATION_FAILED');
    expect(await code(grant(id, 'PROVIDER', { actor: undefined }))).toBe('VALIDATION_FAILED');
    expect(await code(grant(id, 'PROVIDER', { reason: '  ' }))).toBe('VALIDATION_FAILED');
    expect(await code(grant(id, 'PROVIDER', { source: 'HACK' }))).toBe('VALIDATION_FAILED'); // the CHECK constraint, mapped
    expect(await world()).toEqual(worldBefore);
    expect(await memberStatus(id, 'PROVIDER')).toBeUndefined();

    const closed = await accountIn('CLOSED');
    const closedWorld = await world();
    expect(await code(grant(closed, 'PROVIDER'))).toBe('CLOSED');
    expect(await reason(grant(closed, 'CUSTOMER'))).toBe('ACCOUNT_CLOSED');
    expect(await world()).toEqual(closedWorld);
    // a closed account that once held the role is refused too (reactivation)
    const wasCustomer = (await newAccount(['customer'])).id;
    await svc.changeStatus(wasCustomer, 'SUSPENDED', OP);
    await svc.changeStatus(wasCustomer, 'CLOSED', OP);
    expect(await memberStatus(wasCustomer, 'CUSTOMER')).toBe('INACTIVE');
    expect(await code(grant(wasCustomer, 'CUSTOMER'))).toBe('CLOSED');
    expect(await memberStatus(wasCustomer, 'CUSTOMER')).toBe('INACTIVE');
  });
});

// ====================================================================== deactivateRole
describe('deactivateRole', () => {
  it('deactivates a non-primary role: audit, event, primary role unchanged', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const before = await world();
    expect(await svc.deactivateRole(id, 'PROVIDER', { actor: 'admin:ops', reason: 'left the platform' })).toEqual({ changed: true });
    expect(await memberStatus(id, 'PROVIDER')).toBe('INACTIVE');
    expect((await memberships(id)).find((m) => m.code === 'PROVIDER')).toMatchObject({ activated: true, deactivated: true });
    expect((await audit(id)).at(-1)).toMatchObject({
      action: 'ROLE_DEACTIVATED',
      actor: 'admin:ops',
      role: 'PROVIDER',
      reason: 'left the platform',
      changes: { status: ['ACTIVE', 'INACTIVE'] },
    });
    const ev = (await eventsOf(id, E.accountRoleDeactivated)).map((e) => e.payload_json);
    expect(ev).toEqual([{ accountId: id, roleCode: 'PROVIDER' }]); // no source, no actor value in the payload
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
    const after = await world();
    expect([after.account_audit_events! - before.account_audit_events!, after.outbox! - before.outbox!]).toEqual([1, 1]);
    const ctx = await svc.getAccountContext(id);
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER']);
    expect(ctx.memberships.map((m) => [m.code, m.status])).toEqual([
      ['CUSTOMER', 'ACTIVE'],
      ['PROVIDER', 'INACTIVE'],
    ]);
  });

  it('is idempotent: a second call changes nothing', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const before = await footprint(id);
    const worldBefore = await world();
    expect(await svc.deactivateRole(id, 'PROVIDER', { actor: 'admin:other', reason: 'again' })).toEqual({ changed: false });
    expect(await footprint(id)).toEqual(before);
    expect(await world()).toEqual(worldBefore);
  });

  it('moves the primary role to the other active role, auditing the move before the deactivation', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'CUSTOMER', OP);
    expect((await accountRow(id)).primary_code).toBe('PROVIDER');
    expect((await audit(id)).slice(-2).map((a) => [a.action, a.role, a.changes])).toEqual([
      ['PRIMARY_ROLE_CHANGED', null, { primaryRole: ['CUSTOMER', 'PROVIDER'] }],
      ['ROLE_DEACTIVATED', 'CUSTOMER', { status: ['ACTIVE', 'INACTIVE'] }],
    ]);
    const ctx = await svc.getAccountContext(id);
    expect([ctx.primaryRole, ctx.activeRole]).toEqual(['PROVIDER', 'PROVIDER']);
  });

  it('moves the primary role to the role activated earliest among the others', async () => {
    const { id } = await newAccount(['customer']);
    const extra = await makeRole();
    await svc.grantRole(id, extra, { actor: 'system:t', source: 'SYSTEM' });
    await sleep(5);
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM' });
    await svc.deactivateRole(id, 'CUSTOMER', OP);
    expect((await accountRow(id)).primary_code).toBe(extra);
  });

  it('clears the primary role when no other role is active, and the account then has no active role', async () => {
    const { id } = await newAccount(['customer']);
    await svc.deactivateRole(id, 'CUSTOMER', OP);
    expect((await accountRow(id)).primary_code).toBeNull();
    expect((await audit(id)).slice(-2).map((a) => [a.action, a.changes])).toEqual([
      ['PRIMARY_ROLE_CHANGED', { primaryRole: ['CUSTOMER', null] }],
      ['ROLE_DEACTIVATED', { status: ['ACTIVE', 'INACTIVE'] }],
    ]);
    const ctx = await svc.getAccountContext(id);
    expect({ roles: ctx.roles, primaryRole: ctx.primaryRole, activeRole: ctx.activeRole }).toEqual({ roles: [], primaryRole: null, activeRole: null });
    // a PENDING membership is not an active role either
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM', pending: true });
    expect((await svc.getAccountContext(id)).activeRole).toBeNull();
  });

  it('deactivates a PENDING membership (PENDING -> INACTIVE), audits it and emits NO event (it was never announced as granted)', async () => {
    const { id } = await newAccount(['customer']);
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM', pending: true });
    expect(await svc.deactivateRole(id, 'PROVIDER', OP)).toEqual({ changed: true });
    expect((await audit(id)).at(-1)).toMatchObject({ action: 'ROLE_DEACTIVATED', changes: { status: ['PENDING', 'INACTIVE'] } });
    expect(await eventsOf(id, E.accountRoleDeactivated)).toHaveLength(0);
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
  });

  it('fails with ROLE_NOT_HELD for a role the account never held (valid or unknown code), NOT_FOUND for an unknown account, and writes nothing', async () => {
    const { id } = await newAccount(['customer']);
    const before = await footprint(id);
    expect(await code(svc.deactivateRole(id, 'PROVIDER', OP))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.deactivateRole(id, 'NOPE', OP))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.deactivateRole(randomUUID(), 'CUSTOMER', OP))).toBe('NOT_FOUND');
    expect(await code(svc.deactivateRole(id, 'CUSTOMER', { actor: '' }))).toBe('VALIDATION_FAILED');
    expect(await code(svc.deactivateRole(id, 'CUSTOMER', { actor: 'a', reason: ' ' }))).toBe('VALIDATION_FAILED');
    expect(await footprint(id)).toEqual(before);
    expect(await memberStatus(id, 'CUSTOMER')).toBe('ACTIVE');
  });
});

// ====================================================================== setPrimaryRole
describe('setPrimaryRole', () => {
  it('moves the primary role among ACTIVE memberships and audits it; the same value is a no-op', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const before = await footprint(id);
    expect(await svc.setPrimaryRole(id, 'CUSTOMER', OP)).toEqual({ changed: false });
    expect(await footprint(id)).toEqual(before);
    expect(await svc.setPrimaryRole(id, 'PROVIDER', { actor: 'account:self', reason: 'prefers provider' })).toEqual({ changed: true });
    expect((await accountRow(id)).primary_code).toBe('PROVIDER');
    expect((await audit(id)).at(-1)).toMatchObject({
      action: 'PRIMARY_ROLE_CHANGED',
      actor: 'account:self',
      reason: 'prefers provider',
      role: null,
      changes: { primaryRole: ['CUSTOMER', 'PROVIDER'] },
    });
    const ctx = await svc.getAccountContext(id);
    expect([ctx.primaryRole, ctx.activeRole]).toEqual(['PROVIDER', 'PROVIDER']);
    expect((await footprint(id)).events).toBe(before.events); // a preference change emits no event
  });

  it('accepts only ACTIVE memberships: PENDING and INACTIVE are ROLE_NOT_ACTIVE, a role never held (or unknown) is ROLE_NOT_HELD', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const extra = await makeRole();
    await svc.grantRole(id, extra, { actor: 'system:t', source: 'SYSTEM', pending: true });
    const before = await footprint(id);
    expect(await code(svc.setPrimaryRole(id, 'PROVIDER', OP))).toBe('ROLE_NOT_ACTIVE');
    expect(await code(svc.setPrimaryRole(id, extra, OP))).toBe('ROLE_NOT_ACTIVE');
    expect(await code(svc.setPrimaryRole(id, await makeRole(), OP))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.setPrimaryRole(id, 'NOPE', OP))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.setPrimaryRole(randomUUID(), 'CUSTOMER', OP))).toBe('NOT_FOUND');
    expect(await footprint(id)).toEqual(before);
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
  });

  it('clears the primary role with null (audited); the active role then needs a choice with two roles and is the only role with one', async () => {
    const both = await newAccount(['customer', 'provider']);
    expect(await svc.setPrimaryRole(both.id, null, OP)).toEqual({ changed: true });
    expect((await accountRow(both.id)).primary_code).toBeNull();
    expect((await audit(both.id)).at(-1)).toMatchObject({ action: 'PRIMARY_ROLE_CHANGED', changes: { primaryRole: ['CUSTOMER', null] } });
    const ctx = await svc.getAccountContext(both.id);
    expect([ctx.primaryRole, ctx.activeRole]).toEqual([null, null]);
    expect(await svc.setPrimaryRole(both.id, null, OP)).toEqual({ changed: false });
    const one = await newAccount(['provider']);
    await svc.setPrimaryRole(one.id, null, OP);
    const ctx1 = await svc.getAccountContext(one.id);
    expect([ctx1.primaryRole, ctx1.activeRole]).toEqual([null, 'PROVIDER']);
  });
});

// ====================================================================== races between role changes
describe('setPrimaryRole against deactivateRole of the same role', () => {
  it('in a fixed order, setPrimaryRole first: the primary role moves to PROVIDER and then back to CUSTOMER when PROVIDER is deactivated', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const [a, b] = await inOrder(
      id,
      () => svc.setPrimaryRole(id, 'PROVIDER', OP),
      () => svc.deactivateRole(id, 'PROVIDER', OP),
    );
    expect([a, b]).toEqual([{ changed: true }, { changed: true }]);
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
    expect(await memberStatus(id, 'PROVIDER')).toBe('INACTIVE');
    expect((await audit(id)).filter((x) => x.action === 'PRIMARY_ROLE_CHANGED').map((x) => x.changes)).toEqual([
      { primaryRole: [null, 'CUSTOMER'] },
      { primaryRole: ['CUSTOMER', 'PROVIDER'] },
      { primaryRole: ['PROVIDER', 'CUSTOMER'] },
    ]);
    await expectInvariants();
  });

  it('in a fixed order, deactivateRole first: setPrimaryRole is refused (ROLE_NOT_ACTIVE) and the primary role stays', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const [a, b] = await inOrder(
      id,
      () => svc.deactivateRole(id, 'PROVIDER', OP),
      () => svc.setPrimaryRole(id, 'PROVIDER', OP),
    );
    expect(a).toEqual({ changed: true });
    expect(failedWith(b)).toBe('ROLE_NOT_ACTIVE');
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
    await expectInvariants();
  });

  it('for the ONLY role of an account, in both fixed orders, the primary role is never left on an inactive membership', async () => {
    const x = await newAccount(['provider']);
    const [x1, x2] = await inOrder(
      x.id,
      () => svc.setPrimaryRole(x.id, 'PROVIDER', OP),
      () => svc.deactivateRole(x.id, 'PROVIDER', OP),
    );
    expect([x1, x2]).toEqual([{ changed: false }, { changed: true }]); // already primary, then deactivated and cleared
    expect(await accountRow(x.id)).toMatchObject({ primary_code: null });
    const y = await newAccount(['provider']);
    const [y1, y2] = await inOrder(
      y.id,
      () => svc.deactivateRole(y.id, 'PROVIDER', OP),
      () => svc.setPrimaryRole(y.id, 'PROVIDER', OP),
    );
    expect(y1).toEqual({ changed: true });
    expect(failedWith(y2)).toBe('ROLE_NOT_ACTIVE');
    expect(await accountRow(y.id)).toMatchObject({ primary_code: null });
    await expectInvariants();
  });

  it('never leaves a primary role pointing at an inactive membership over many unordered runs', async () => {
    const outcomes = new Set<string>();
    for (let run = 0; run < 40; run++) {
      const dual = run % 3 !== 0;
      const { id } = await newAccount(dual ? ['customer', 'provider'] : ['provider']);
      const target = dual && run % 5 === 0 ? 'CUSTOMER' : 'PROVIDER';
      const calls = [() => svc.setPrimaryRole(id, target, OP), () => svc.deactivateRole(id, target, OP)];
      if (run % 2 === 1) calls.reverse();
      const results = await Promise.all(calls.map((c) => settled(c())));
      for (const r of results) expect(['ROLE_NOT_ACTIVE', undefined], `unexpected failure ${failedWith(r)}`).toContain(failedWith(r));
      outcomes.add(results.map((r) => failedWith(r) ?? 'ok').join('/'));
      const row = await accountRow(id);
      expect(await memberStatus(id, target)).toBe('INACTIVE');
      if (row.primary_code !== null) expect(await memberStatus(id, row.primary_code)).toBe('ACTIVE');
    }
    await expectInvariants();
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('a grant racing a role deactivation and a primary change on the same account ends consistent over many runs', async () => {
    for (let run = 0; run < 20; run++) {
      const { id } = await newAccount(['customer']);
      const calls = [
        () => svc.grantRole(id, 'PROVIDER', { actor: 'system:r', source: 'SYSTEM' }),
        () => svc.setPrimaryRole(id, 'PROVIDER', OP),
        () => svc.deactivateRole(id, 'CUSTOMER', OP),
        () => svc.deactivateRole(id, 'PROVIDER', OP),
      ];
      if (run % 2 === 1) calls.reverse();
      const results = await Promise.all(calls.map((c) => settled(c())));
      for (const r of results) expect(['ROLE_NOT_ACTIVE', 'ROLE_NOT_HELD', undefined], `unexpected failure ${failedWith(r)}`).toContain(failedWith(r));
    }
    await expectInvariants();
  });
});

// ====================================================================== selecting the active role
describe('selectActiveRole', () => {
  it('switches CUSTOMER to PROVIDER for an account holding both: the same account, nothing written, nothing persisted', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const worldBefore = await world();
    const before = await footprint(id);
    const updated = await updatedAt('accounts', id);
    const switched = await svc.selectActiveRole(id, 'PROVIDER');
    expect(switched).toMatchObject({ accountId: id, status: 'ACTIVE', activeRole: 'PROVIDER', primaryRole: 'CUSTOMER', created: false });
    expect(switched.roles.map((r) => r.code)).toEqual(['CUSTOMER', 'PROVIDER']);
    const back = await svc.selectActiveRole(id, 'CUSTOMER');
    expect(back).toMatchObject({ accountId: id, activeRole: 'CUSTOMER' });
    expect(await world()).toEqual(worldBefore);
    expect(await footprint(id)).toEqual(before); // no audit, no outbox event
    expect(await updatedAt('accounts', id)).toBe(updated);
    // the next request that names no role resolves from the database again (the switch was not persisted)
    expect((await svc.getAccountContext(id)).activeRole).toBe('CUSTOMER');
    expect((await accountRow(id)).primary_code).toBe('CUSTOMER');
    // the same identity still maps to the same account after the switch (no new login, no new account)
    expect((await identities(id)).length).toBe(1);
  });

  it('returns the profile with the context', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin' }, { actor: 'account:self' });
    expect((await svc.selectActiveRole(id, 'PROVIDER')).profile).toEqual({ firstName: 'Ana', lastName: 'Martin', preferredLocale: null, timeZone: null });
  });

  it('refuses a role the account does not hold (ROLE_NOT_HELD) and a held but not active role (ROLE_NOT_ACTIVE), writing nothing', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.deactivateRole(id, 'PROVIDER', OP);
    const pending = await makeRole();
    await svc.grantRole(id, pending, { actor: 'system:t', source: 'SYSTEM', pending: true });
    const only = await newAccount(['customer']);
    const worldBefore = await world();
    expect(await code(svc.selectActiveRole(only.id, 'PROVIDER'))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.selectActiveRole(only.id, 'ADMIN'))).toBe('ROLE_NOT_HELD'); // well-formed code of a role nobody has
    expect(await code(svc.selectActiveRole(id, 'PROVIDER'))).toBe('ROLE_NOT_ACTIVE');
    expect(await code(svc.selectActiveRole(id, pending))).toBe('ROLE_NOT_ACTIVE');
    for (const bad of ['customer', '', 'X', 'CUSTOMER ', 'CUSTOMER\nPROVIDER']) {
      const e = await err(svc.selectActiveRole(id, bad));
      expect({ code: e?.code, reason: e?.details.reason }).toEqual({ code: 'ROLE_NOT_HELD', reason: 'INVALID_ROLE_CODE' });
    }
    expect(await code(svc.selectActiveRole(randomUUID(), 'CUSTOMER'))).toBe('NOT_FOUND');
    expect(await world()).toEqual(worldBefore);
  });

  it('validates a role named in requestedRole of ensureAccountForIdentity and getAccountContext the same way', async () => {
    const both = await newAccount(['customer', 'provider']);
    const only = await newAccount(['customer']);
    expect((await svc.ensureAccountForIdentity(both.identity, { requestedRole: 'PROVIDER' })).activeRole).toBe('PROVIDER');
    expect((await svc.ensureAccountForIdentity(both.identity, { requestedRole: null })).activeRole).toBe('CUSTOMER');
    expect(await code(svc.ensureAccountForIdentity(only.identity, { requestedRole: 'PROVIDER' }))).toBe('ROLE_NOT_HELD');
    expect(await code(svc.getAccountContext(only.id, { requestedRole: 'PROVIDER' }))).toBe('ROLE_NOT_HELD');
    await svc.deactivateRole(both.id, 'PROVIDER', OP);
    expect(await code(svc.ensureAccountForIdentity(both.identity, { requestedRole: 'PROVIDER' }))).toBe('ROLE_NOT_ACTIVE');
    expect(await code(svc.ensureAccountForIdentity(both.identity, { requestedRole: 'nonsense' }))).toBe('ROLE_NOT_HELD');
    expect((await svc.ensureAccountForIdentity(both.identity, { requestedRole: 'CUSTOMER' })).activeRole).toBe('CUSTOMER');
  });

  it('validates the requested role after provisioning: a first request naming a role the new account lacks is refused but the account exists', async () => {
    const identity = ident({ identityRoles: ['customer'] });
    expect(await code(svc.ensureAccountForIdentity(identity, { requestedRole: 'PROVIDER' }))).toBe('ROLE_NOT_HELD');
    const again = await svc.ensureAccountForIdentity(identity); // the account was created by the refused call
    expect(again.created).toBe(false);
    expect(await identities(again.accountId)).toHaveLength(1);
    const fresh = ident({ identityRoles: ['customer'] });
    expect(await svc.ensureAccountForIdentity(fresh, { requestedRole: 'CUSTOMER' })).toMatchObject({ created: true, activeRole: 'CUSTOMER' });
  });

  it('refuses a suspended account (SUSPENDED) like every other read of the context', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.changeStatus(id, 'SUSPENDED', OP);
    expect(await code(svc.selectActiveRole(id, 'PROVIDER'))).toBe('SUSPENDED');
  });
});

// ====================================================================== status machine
const ALLOWED: [AccountStatus, AccountStatus][] = [
  ['PENDING', 'ACTIVE'],
  ['PENDING', 'CLOSED'],
  ['ACTIVE', 'SUSPENDED'],
  ['ACTIVE', 'CLOSURE_REQUESTED'],
  ['SUSPENDED', 'ACTIVE'],
  ['SUSPENDED', 'CLOSURE_REQUESTED'],
  ['SUSPENDED', 'CLOSED'],
  ['CLOSURE_REQUESTED', 'ACTIVE'],
  ['CLOSURE_REQUESTED', 'CLOSED'],
];
const FORBIDDEN: [AccountStatus, AccountStatus][] = [
  ['PENDING', 'SUSPENDED'],
  ['PENDING', 'CLOSURE_REQUESTED'],
  ['ACTIVE', 'PENDING'],
  ['ACTIVE', 'CLOSED'],
  ['SUSPENDED', 'PENDING'],
  ['CLOSURE_REQUESTED', 'PENDING'],
  ['CLOSURE_REQUESTED', 'SUSPENDED'],
  ['CLOSED', 'PENDING'],
  ['CLOSED', 'ACTIVE'],
  ['CLOSED', 'SUSPENDED'],
  ['CLOSED', 'CLOSURE_REQUESTED'],
];
const ALL_STATUSES: AccountStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED'];

describe('changeStatus', () => {
  it('covers all 20 ordered status pairs', () => {
    const pairs = ALL_STATUSES.flatMap((f) => ALL_STATUSES.filter((t) => t !== f).map((t) => `${f}>${t}`));
    expect([...ALLOWED, ...FORBIDDEN].map(([f, t]) => `${f}>${t}`).sort()).toEqual(pairs.sort());
  });

  it.each(ALLOWED)(
    '%s -> %s writes ONE history row (from, to, reason, actor, correlation id) and one event, and sets closed_at only for CLOSED',
    async (from, to) => {
      const id = await accountIn(from);
      const before = await footprint(id);
      const updated = await updatedAt('accounts', id);
      const correlationId = `corr-${randomUUID()}`;
      const r = await runWithCorrelation(correlationId, () => svc.changeStatus(id, to, { actor: 'admin:operator-9', reason: 'because of a test' }));
      expect(r).toEqual({ changed: true, from });
      expect(await accountRow(id)).toMatchObject({ status: to, closed: to === 'CLOSED' });
      const after = await footprint(id);
      expect([after.history - before.history, after.events - before.events, after.audit - before.audit, after.memberships - before.memberships]).toEqual([
        1, 1, 0, 0,
      ]);
      expect((await history(id)).at(-1)).toEqual({
        from_status: from,
        to_status: to,
        reason: 'because of a test',
        actor: 'admin:operator-9',
        correlation_id: correlationId,
      });
      const ev = (await eventsOf(id, E.accountStatusChanged)).at(-1)!;
      expect(ev).toMatchObject({
        aggregate_type: 'identity_account',
        actor_type: 'user',
        actor_id: 'admin:operator-9',
        correlation_id: correlationId,
        payload_json: { accountId: id, fromStatus: from, toStatus: to },
      });
      expect(await updatedAt('accounts', id)).toBeGreaterThan(updated);
      await expectHistoryChain(id);
    },
  );

  it.each(FORBIDDEN)('%s -> %s is INVALID_STATE and writes nothing', async (from, to) => {
    const id = await accountIn(from);
    const before = await footprint(id);
    const row = await accountRow(id);
    const e = await err(svc.changeStatus(id, to, OP));
    expect({ code: e?.code, reason: e?.details.reason, from: e?.details.from, to: e?.details.to }).toEqual({
      code: 'INVALID_STATE',
      reason: 'ACCOUNT_STATUS_TRANSITION',
      from,
      to,
    });
    expect(await footprint(id)).toEqual(before);
    expect(await accountRow(id)).toEqual(row);
  });

  it.each(ALL_STATUSES)('is idempotent for the current status (%s): changed false, no history row, no event', async (status) => {
    const id = await accountIn(status);
    const before = await footprint(id);
    const updated = await updatedAt('accounts', id);
    expect(await svc.changeStatus(id, status, OP)).toEqual({ changed: false, from: status });
    expect(await footprint(id)).toEqual(before);
    expect(await updatedAt('accounts', id)).toBe(updated);
  });

  it('closing deactivates every role (ACTIVE and PENDING), clears the primary role (audited), audits each deactivation and announces the ACTIVE ones, all in the closure transaction', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const extra = await makeRole();
    await svc.grantRole(id, extra, { actor: 'system:t', source: 'SYSTEM', pending: true });
    await svc.changeStatus(id, 'SUSPENDED', OP);
    const before = await footprint(id);
    const correlationId = `corr-${randomUUID()}`;
    await runWithCorrelation(correlationId, () => svc.changeStatus(id, 'CLOSED', { actor: 'admin:closer', reason: 'user asked to close' }));
    expect(await accountRow(id)).toEqual({ status: 'CLOSED', primary_code: null, closed: true });
    expect((await memberships(id)).map((m) => [m.code, m.status, m.deactivated])).toEqual(
      [
        ['CUSTOMER', 'INACTIVE', true],
        ['PROVIDER', 'INACTIVE', true],
        [extra, 'INACTIVE', true],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    const newAudit = (await audit(id)).slice(before.audit);
    const deactivations = newAudit.filter((a) => a.action === 'ROLE_DEACTIVATED');
    expect(deactivations.map((a) => [a.role, a.actor, a.reason, a.correlation_id]).sort()).toEqual(
      ['CUSTOMER', 'PROVIDER', extra].sort().map((r) => [r, 'admin:closer', 'user asked to close', correlationId]),
    );
    expect(deactivations.find((a) => a.role === extra)!.changes).toEqual({ status: ['PENDING', 'INACTIVE'] });
    expect(deactivations.find((a) => a.role === 'CUSTOMER')!.changes).toEqual({ status: ['ACTIVE', 'INACTIVE'] });
    const newEvents = (await events(id)).filter((e) => e.correlation_id === correlationId);
    // the PENDING membership was never announced as granted, so its deactivation is not announced either
    expect(newEvents.map((e) => e.event_type).sort()).toEqual([E.accountRoleDeactivated, E.accountRoleDeactivated, E.accountStatusChanged].sort());
    expect(
      newEvents
        .filter((e) => e.event_type === E.accountRoleDeactivated)
        .map((e) => e.payload_json.roleCode)
        .sort(),
    ).toEqual(['CUSTOMER', 'PROVIDER']);
    // clearing the primary role is audited too
    expect(newAudit.filter((a) => a.action === 'PRIMARY_ROLE_CHANGED').map((a) => [a.actor, a.changes])).toEqual([
      ['admin:closer', { primaryRole: ['CUSTOMER', null] }],
    ]);
    expect(newEvents.find((e) => e.event_type === E.accountStatusChanged)!.payload_json).toEqual({
      accountId: id,
      fromStatus: 'SUSPENDED',
      toStatus: 'CLOSED',
    });
    expect((await history(id)).at(-1)).toMatchObject({
      from_status: 'SUSPENDED',
      to_status: 'CLOSED',
      reason: 'user asked to close',
      correlation_id: correlationId,
    });
    // reading it back
    const ctx = await svc.getAccountContext(id, { allowUnusable: true });
    expect({ status: ctx.status, roles: ctx.roles, primaryRole: ctx.primaryRole, activeRole: ctx.activeRole }).toEqual({
      status: 'CLOSED',
      roles: [],
      primaryRole: null,
      activeRole: null,
    });
    await expectInvariants();
  });

  it('closing without a reason records the default reason on the role audit rows and no reason on the history row', async () => {
    const { id } = await newAccount(['customer']);
    await svc.changeStatus(id, 'CLOSURE_REQUESTED', OP);
    await svc.changeStatus(id, 'CLOSED', { actor: 'system:closer' });
    expect((await audit(id)).at(-1)).toMatchObject({ action: 'ROLE_DEACTIVATED', reason: 'account closed', actor: 'system:closer' });
    expect((await history(id)).at(-1)).toMatchObject({ reason: null, actor: 'system:closer' });
    expect((await eventsOf(id, E.accountStatusChanged)).at(-1)).toMatchObject({ actor_type: 'system', actor_id: 'system:closer' });
  });

  it('closes a PENDING account that holds a PENDING membership', async () => {
    const id = await accountIn('PENDING');
    await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM', pending: true });
    await svc.changeStatus(id, 'CLOSED', OP);
    expect(await memberStatus(id, 'PROVIDER')).toBe('INACTIVE');
    expect((await accountRow(id)).status).toBe('CLOSED');
  });

  it('closes a membership that was deactivated and reactivated before', async () => {
    const { id } = await newAccount(['customer']);
    await svc.deactivateRole(id, 'CUSTOMER', OP);
    await svc.grantRole(id, 'CUSTOMER', { actor: 'system:t', source: 'SYSTEM' });
    await svc.changeStatus(id, 'SUSPENDED', OP);
    await svc.changeStatus(id, 'CLOSED', OP);
    expect(await accountRow(id)).toEqual({ status: 'CLOSED', primary_code: null, closed: true });
    expect(await memberStatus(id, 'CUSTOMER')).toBe('INACTIVE');
  });

  it('reopening from CLOSURE_REQUESTED clears nothing it should keep: roles and primary role stay, closed_at stays empty', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    await svc.changeStatus(id, 'CLOSURE_REQUESTED', OP);
    await svc.changeStatus(id, 'ACTIVE', OP);
    expect(await accountRow(id)).toEqual({ status: 'ACTIVE', primary_code: 'CUSTOMER', closed: false });
    expect((await memberships(id)).map((m) => m.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('rejects an unknown account (NOT_FOUND), an unknown status and bad arguments, writing nothing', async () => {
    const { id } = await newAccount();
    const before = await world();
    expect(await code(svc.changeStatus(randomUUID(), 'SUSPENDED', OP))).toBe('NOT_FOUND');
    expect(await code(svc.changeStatus(id, 'BOGUS' as never, OP))).toBe('INVALID_STATE');
    expect(await code(svc.changeStatus(id, 'SUSPENDED', { actor: '' }))).toBe('VALIDATION_FAILED');
    expect(await code(svc.changeStatus(id, 'SUSPENDED', { actor: 'a', reason: '   ' }))).toBe('VALIDATION_FAILED');
    expect(await code(svc.changeStatus(id, 'SUSPENDED', { actor: 'a', reason: 'r'.repeat(1001) }))).toBe('VALIDATION_FAILED');
    expect(await world()).toEqual(before);
  });
});

describe('what each status allows', () => {
  it('refuses a SUSPENDED account (ensureAccountForIdentity, getAccountContext) unless allowUnusable is set, and serves it again once reactivated', async () => {
    const { identity, id } = await newAccount(['customer', 'provider']);
    await svc.changeStatus(id, 'SUSPENDED', OP);
    const e = await err(svc.ensureAccountForIdentity(identity));
    expect({ code: e?.code, status: e?.details.status }).toEqual({ code: 'SUSPENDED', status: 'SUSPENDED' });
    expect(await code(svc.getAccountContext(id))).toBe('SUSPENDED');
    const ctx = await svc.ensureAccountForIdentity(identity, { allowUnusable: true });
    expect(ctx).toMatchObject({ accountId: id, status: 'SUSPENDED', created: false, primaryRole: 'CUSTOMER' });
    expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER', 'PROVIDER']); // a suspension keeps the roles
    expect((await svc.getAccountContext(id, { allowUnusable: true })).status).toBe('SUSPENDED');
    await svc.changeStatus(id, 'ACTIVE', OP);
    expect(await svc.ensureAccountForIdentity(identity)).toMatchObject({ accountId: id, status: 'ACTIVE', created: false });
  });

  it('keeps a CLOSURE_REQUESTED and a PENDING account usable', async () => {
    const closing = await newAccount(['customer']);
    await svc.changeStatus(closing.id, 'CLOSURE_REQUESTED', OP);
    expect(await svc.ensureAccountForIdentity(closing.identity)).toMatchObject({ accountId: closing.id, status: 'CLOSURE_REQUESTED' });
    const pending = await pendingAccount();
    expect((await svc.getAccountContext(pending)).status).toBe('PENDING');
  });

  it('maps a CLOSED account identity to that account and refuses it (CLOSED); it never creates a second account', async () => {
    const { identity, id } = await newAccount(['customer', 'provider']);
    await svc.changeStatus(id, 'SUSPENDED', OP);
    await svc.changeStatus(id, 'CLOSED', OP);
    const before = await world();
    for (let i = 0; i < 3; i++) {
      const e = await err(svc.ensureAccountForIdentity(identity));
      expect({ code: e?.code, status: e?.details.status }).toEqual({ code: 'CLOSED', status: 'CLOSED' });
    }
    expect(await code(svc.getAccountContext(id))).toBe('CLOSED');
    const after = await world();
    expect(after.accounts).toBe(before.accounts);
    expect(after.external_identities).toBe(before.external_identities);
    expect(after.account_status_history).toBe(before.account_status_history);
    expect(await svc.ensureAccountForIdentity(identity, { allowUnusable: true })).toMatchObject({
      accountId: id,
      status: 'CLOSED',
      roles: [],
      primaryRole: null,
      activeRole: null,
    });
  });

  it('refuses profile changes for a suspended or closed account', async () => {
    const s = await newAccount();
    await svc.changeStatus(s.id, 'SUSPENDED', OP);
    expect(await code(svc.upsertProfile(s.id, { firstName: 'Ana', lastName: 'Martin' }, { actor: 'account:self' }))).toBe('SUSPENDED');
    const c = await accountIn('CLOSED');
    expect(await code(svc.upsertProfile(c, { firstName: 'Ana', lastName: 'Martin' }, { actor: 'account:self' }))).toBe('CLOSED');
    expect((await footprint(s.id)).profiles + (await footprint(c)).profiles).toBe(0);
  });
});

describe('concurrent status changes', () => {
  it('suspend then request closure (fixed order): both are legal in that order and the history chain has three rows', async () => {
    const { id } = await newAccount([]);
    const [a, b] = await inOrder(
      id,
      () => svc.changeStatus(id, 'SUSPENDED', OP),
      () => svc.changeStatus(id, 'CLOSURE_REQUESTED', OP),
    );
    expect([a, b]).toEqual([
      { changed: true, from: 'ACTIVE' },
      { changed: true, from: 'SUSPENDED' },
    ]);
    expect((await history(id)).map((h) => [h.from_status, h.to_status])).toEqual([
      [null, 'ACTIVE'],
      ['ACTIVE', 'SUSPENDED'],
      ['SUSPENDED', 'CLOSURE_REQUESTED'],
    ]);
    await expectHistoryChain(id);
  });

  it('request closure then suspend (fixed order): the second is INVALID_STATE, the history has two rows', async () => {
    const { id } = await newAccount([]);
    const [a, b] = await inOrder(
      id,
      () => svc.changeStatus(id, 'CLOSURE_REQUESTED', OP),
      () => svc.changeStatus(id, 'SUSPENDED', OP),
    );
    expect(a).toEqual({ changed: true, from: 'ACTIVE' });
    expect(failedWith(b)).toBe('INVALID_STATE');
    expect((await accountRow(id)).status).toBe('CLOSURE_REQUESTED');
    await expectHistoryChain(id);
  });

  it('two closures of a suspended account: exactly one changes it, one history row and one event for the closure', async () => {
    const { id } = await newAccount(['customer']);
    await svc.changeStatus(id, 'SUSPENDED', OP);
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.changeStatus(id, 'CLOSED', OP)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await history(id)).filter((h) => h.to_status === 'CLOSED')).toHaveLength(1);
    expect((await eventsOf(id, E.accountStatusChanged)).filter((e) => e.payload_json.toStatus === 'CLOSED')).toHaveLength(1);
    expect((await audit(id)).filter((a) => a.action === 'ROLE_DEACTIVATED')).toHaveLength(1);
    await expectHistoryChain(id);
    await expectInvariants();
  });

  it('suspend and closure request racing without any ordering help end consistent with the history (many runs)', async () => {
    const seen = new Set<string>();
    for (let run = 0; run < 25; run++) {
      const { id } = await newAccount(['customer']);
      const calls = [
        () => svc.changeStatus(id, 'SUSPENDED', OP),
        () => svc.changeStatus(id, 'CLOSURE_REQUESTED', OP),
        () => svc.changeStatus(id, 'ACTIVE', OP),
      ];
      if (run % 2 === 1) calls.reverse();
      if (run % 3 === 2) calls.push(() => svc.changeStatus(id, 'SUSPENDED', OP));
      const results = await Promise.all(calls.map((c) => settled(c())));
      for (const r of results) expect(['INVALID_STATE', undefined], `unexpected failure ${failedWith(r)}`).toContain(failedWith(r));
      seen.add((await accountRow(id)).status);
      await expectHistoryChain(id);
    }
    expect(seen.size).toBeGreaterThan(0);
    await expectInvariants();
  });

  it('closing races granting a role: the closed account never keeps a role, whichever commits first', async () => {
    const first = await accountIn('SUSPENDED', ['customer']);
    const [g1, c1] = await inOrder(
      first,
      () => svc.grantRole(first, 'PROVIDER', { actor: 'system:r', source: 'SYSTEM' }),
      () => svc.changeStatus(first, 'CLOSED', OP),
    );
    expect(g1).toEqual({ changed: true, status: 'ACTIVE' });
    expect(c1).toEqual({ changed: true, from: 'SUSPENDED' });
    expect((await memberships(first)).map((m) => [m.code, m.status])).toEqual([
      ['CUSTOMER', 'INACTIVE'],
      ['PROVIDER', 'INACTIVE'],
    ]);
    const second = await accountIn('SUSPENDED', ['customer']);
    const [c2, g2] = await inOrder(
      second,
      () => svc.changeStatus(second, 'CLOSED', OP),
      () => svc.grantRole(second, 'PROVIDER', { actor: 'system:r', source: 'SYSTEM' }),
    );
    expect(c2).toEqual({ changed: true, from: 'SUSPENDED' });
    expect(failedWith(g2)).toBe('CLOSED');
    expect(await memberStatus(second, 'PROVIDER')).toBeUndefined();
    await expectInvariants();
  });

  it('closing races role changes without ordering help (many runs): no CLOSED account holds a role and every history chain is intact', async () => {
    for (let run = 0; run < 20; run++) {
      const id = await accountIn('SUSPENDED', ['customer']);
      const calls = [
        () => svc.grantRole(id, 'PROVIDER', { actor: 'system:r', source: 'SYSTEM' }),
        () => svc.changeStatus(id, 'CLOSED', OP),
        () => svc.setPrimaryRole(id, 'CUSTOMER', OP),
        () => svc.deactivateRole(id, 'CUSTOMER', OP),
      ];
      if (run % 2 === 1) calls.reverse();
      const results = await Promise.all(calls.map((c) => settled(c())));
      for (const r of results)
        expect(['CLOSED', 'ROLE_NOT_ACTIVE', 'ROLE_NOT_HELD', undefined], `unexpected failure ${failedWith(r)}`).toContain(failedWith(r));
      await expectHistoryChain(id);
    }
    await expectInvariants();
  });
});

// ====================================================================== atomicity
describe('atomicity: an outbox failure rolls the whole operation back', () => {
  beforeAll(async () => {
    // the outbox insert fails for an event whose correlation id says `fail-on:<event type>` (nothing else is affected)
    await q(`CREATE FUNCTION public.fail_outbox_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.correlation_id = 'fail-on:' || NEW.event_type THEN RAISE EXCEPTION 'injected outbox failure'; END IF;
        RETURN NEW;
      END $$`);
    await q('CREATE TRIGGER trg_fail_outbox_for_test BEFORE INSERT ON integration.outbox_events FOR EACH ROW EXECUTE FUNCTION public.fail_outbox_for_test()');
  });
  afterAll(async () => {
    await q('DROP TRIGGER IF EXISTS trg_fail_outbox_for_test ON integration.outbox_events');
    await q('DROP FUNCTION IF EXISTS public.fail_outbox_for_test()');
  });
  const failingOn = <T>(eventType: string, fn: () => Promise<T>) => runWithCorrelation(`fail-on:${eventType}`, fn);
  const injected = async (p: Promise<unknown>) => {
    const e = (await rejection(p)) as Error | undefined;
    expect(e, 'the operation was expected to fail').toBeDefined();
    expect(e!.message).toContain('injected outbox failure');
    expect(e).not.toBeInstanceOf(AccountError);
  };

  it.each([E.accountCreated, E.externalIdentityLinked, E.accountRoleGranted])(
    'a failing %s event leaves no account, link, history, audit, membership or event of the first request',
    async (eventType) => {
      const identity = ident({ identityRoles: ['customer', 'provider'] });
      const before = await world();
      await injected(failingOn(eventType, () => svc.ensureAccountForIdentity(identity)));
      expect(await world()).toEqual(before);
      expect(await tablesContaining(identity.subject)).toEqual([]);
      // nothing blocks the identity: the retry creates the account normally
      const ctx = await svc.ensureAccountForIdentity(identity);
      expect(ctx).toMatchObject({ created: true, status: 'ACTIVE' });
      expect(ctx.roles.map((r) => r.code)).toEqual(['CUSTOMER', 'PROVIDER']);
      expect(await history(ctx.accountId)).toHaveLength(1);
    },
  );

  it('a failing role-granted event leaves the membership, its audit rows and the primary role change unwritten', async () => {
    const { id } = await newAccount(['customer']);
    const before = await footprint(id);
    await injected(failingOn(E.accountRoleGranted, () => svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM' })));
    expect(await footprint(id)).toEqual(before);
    expect(await memberStatus(id, 'PROVIDER')).toBeUndefined();
    expect(await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM' })).toEqual({ changed: true, status: 'ACTIVE' });
  });

  it('a failing role-deactivated event keeps the membership active and the primary role in place', async () => {
    const { id } = await newAccount(['customer', 'provider']);
    const before = await footprint(id);
    await injected(failingOn(E.accountRoleDeactivated, () => svc.deactivateRole(id, 'CUSTOMER', OP)));
    expect(await footprint(id)).toEqual(before);
    expect(await accountRow(id)).toMatchObject({ primary_code: 'CUSTOMER' });
    expect(await memberStatus(id, 'CUSTOMER')).toBe('ACTIVE');
  });

  it.each([E.accountStatusChanged, E.accountRoleDeactivated])(
    'a failing %s event during a closure keeps the account SUSPENDED with its roles, primary role and history',
    async (eventType) => {
      const { id } = await newAccount(['customer', 'provider']);
      await svc.changeStatus(id, 'SUSPENDED', OP);
      const before = await footprint(id);
      const row = await accountRow(id);
      await injected(failingOn(eventType, () => svc.changeStatus(id, 'CLOSED', OP)));
      expect(await footprint(id)).toEqual(before);
      expect(await accountRow(id)).toEqual(row);
      expect((await memberships(id)).map((m) => m.status)).toEqual(['ACTIVE', 'ACTIVE']);
      await svc.changeStatus(id, 'CLOSED', OP); // the same closure works afterwards
      expect((await accountRow(id)).status).toBe('CLOSED');
      await expectInvariants();
    },
  );

  it('a failing status event keeps an ordinary status change unwritten (no history row without its event)', async () => {
    const { id } = await newAccount([]);
    const before = await footprint(id);
    await injected(failingOn(E.accountStatusChanged, () => svc.changeStatus(id, 'SUSPENDED', OP)));
    expect(await footprint(id)).toEqual(before);
    expect((await accountRow(id)).status).toBe('ACTIVE');
  });
});

// ====================================================================== profile
const NEEDLE_FIRST = `Zebraquartz${randomUUID().slice(0, 8)}`;
const NEEDLE_LAST = `Mollusk${randomUUID().slice(0, 8)}`;
const nameIssues = async (p: Promise<unknown>) => {
  const e = await err(p);
  expect(e).toBeInstanceOf(AccountError);
  expect({ code: e!.code, reason: e!.details.reason }).toEqual({ code: 'VALIDATION_FAILED', reason: 'INVALID_PROFILE' });
  return e!.details.issues as { field: string; code: string; messageKey: string }[];
};
const profileRow = async (id: string) =>
  (
    await q<{ first_name: string; last_name: string; preferred_locale: string | null; iana_name: string | null; zone_id: string | null }>(
      `SELECT p.first_name, p.last_name, p.preferred_locale, z.iana_name, p.time_zone_id AS zone_id FROM identity.account_profiles p
         LEFT JOIN geography.time_zones z ON z.time_zone_id = p.time_zone_id WHERE p.account_id = $1`,
      [id],
    )
  )[0];

describe('upsertProfile', () => {
  const SELF = { actor: 'account:self' };

  it('creates the profile, then updates it; the audit row names the changed fields and never a value', async () => {
    const { id } = await newAccount();
    const before = await footprint(id);
    const created = await svc.upsertProfile(id, { firstName: NEEDLE_FIRST, lastName: NEEDLE_LAST }, SELF);
    expect(created).toEqual({ changed: true, profile: { firstName: NEEDLE_FIRST, lastName: NEEDLE_LAST, preferredLocale: null, timeZone: null } });
    expect(await profileRow(id)).toEqual({ first_name: NEEDLE_FIRST, last_name: NEEDLE_LAST, preferred_locale: null, iana_name: null, zone_id: null });
    expect((await audit(id)).at(-1)).toMatchObject({
      action: 'PROFILE_UPDATED',
      actor: 'account:self',
      role: null,
      changes: { fields: ['firstName', 'lastName'] },
    });
    const stamp = await updatedAt('account_profiles', id);

    const renamed = await svc.upsertProfile(id, { firstName: NEEDLE_FIRST, lastName: 'Garcia' }, SELF);
    expect(renamed.changed).toBe(true);
    expect((await audit(id)).at(-1)).toMatchObject({ action: 'PROFILE_UPDATED', changes: { fields: ['lastName'] } });
    expect(await updatedAt('account_profiles', id)).toBeGreaterThan(stamp);
    expect((await profileRow(id))!.last_name).toBe('Garcia');

    const after = await footprint(id);
    expect([after.profiles - before.profiles, after.audit - before.audit, after.events - before.events]).toEqual([1, 2, 0]); // a profile write emits no event
    // the distinctive name is stored in the profile and NOWHERE else: not in audit changes, events or any other identity table
    expect(await tablesContaining(NEEDLE_FIRST)).toEqual(['identity.account_profiles']);
    expect(await tablesContaining(NEEDLE_LAST)).toEqual([]); // replaced by the update
    expect(JSON.stringify(await audit(id))).not.toContain(NEEDLE_FIRST);
    // read back through the context
    expect((await svc.getAccountContext(id, { includeProfile: true })).profile).toEqual({
      firstName: NEEDLE_FIRST,
      lastName: 'Garcia',
      preferredLocale: null,
      timeZone: null,
    });
    expect((await svc.getAccountContext(id)).profile).toBeNull();
  });

  it('is idempotent: an unchanged write returns changed false, writes no audit row and leaves updated_at alone', async () => {
    const { id } = await newAccount();
    await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US', timeZone: 'America/Denver' }, SELF);
    const before = await footprint(id);
    const stamp = await updatedAt('account_profiles', id);
    const same = await svc.upsertProfile(id, { firstName: ' Ana ', lastName: 'Martin', preferredLocale: 'en-us', timeZone: 'America/Denver' }, SELF);
    expect(same).toEqual({ changed: false, profile: { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US', timeZone: 'America/Denver' } });
    expect(await footprint(id)).toEqual(before);
    expect(await updatedAt('account_profiles', id)).toBe(stamp);
  });

  it('stores locale and time zone by reference (the zone id), returns the IANA name, and records only the changed field names', async () => {
    const { id } = await newAccount();
    await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin' }, SELF);
    const r = await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US', timeZone: 'America/Chicago' }, SELF);
    expect(r).toMatchObject({ changed: true, profile: { preferredLocale: 'en-US', timeZone: 'America/Chicago' } });
    const row = (await profileRow(id))!;
    expect(row).toMatchObject({ preferred_locale: 'en-US', iana_name: 'America/Chicago' });
    expect(row.zone_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await audit(id)).at(-1)!.changes).toEqual({ fields: ['preferredLocale', 'timeZone'] });
    expect((await svc.getAccountContext(id, { includeProfile: true })).profile).toMatchObject({ preferredLocale: 'en-US', timeZone: 'America/Chicago' });
    // another zone changes only the zone; leaving both out clears both
    await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US', timeZone: 'America/New_York' }, SELF);
    expect((await audit(id)).at(-1)!.changes).toEqual({ fields: ['timeZone'] });
    await svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin' }, SELF);
    expect((await audit(id)).at(-1)!.changes).toEqual({ fields: ['preferredLocale', 'timeZone'] });
    expect(await profileRow(id)).toMatchObject({ preferred_locale: null, iana_name: null, zone_id: null });
  });

  it('normalizes names (NFC, collapsed spaces, tabs and line breaks as spaces, zero-width characters removed) before storing and returning them', async () => {
    const { id } = await newAccount();
    const decomposed = `Jos${ch(0x65, 0x301)}`; // e + combining acute
    const r = await svc.upsertProfile(id, { firstName: `  ${decomposed}   Mar${ch(0x200b)}ia  `, lastName: `de${ch(0x09)}la${ch(0x0a)}  Cruz ` }, SELF);
    expect(r.profile).toMatchObject({ firstName: `Jos${ch(0xe9)} Maria`, lastName: 'de la Cruz' });
    expect(await profileRow(id)).toMatchObject({ first_name: `Jos${ch(0xe9)} Maria`, last_name: 'de la Cruz' });
    // the composed spelling of the same name is then "unchanged"
    expect((await svc.upsertProfile(id, { firstName: `Jos${ch(0xe9)} Maria`, lastName: 'de la Cruz' }, SELF)).changed).toBe(false);
  });

  it('accepts names of 1 and 50 characters, 50 emoji, other scripts and punctuation, and rejects 51', async () => {
    const { id } = await newAccount();
    for (const [first, last] of [
      ['A', 'B'],
      ['a'.repeat(50), 'b'.repeat(50)],
      [ch(0x1f600).repeat(50), ch(0x1f680).repeat(50)],
      ["Jean-Luc O'Brien", ch(0x674e)],
    ] as const)
      expect((await svc.upsertProfile(id, { firstName: first, lastName: last }, SELF)).profile).toMatchObject({ firstName: first, lastName: last });
    expect((await nameIssues(svc.upsertProfile(id, { firstName: ch(0x1f600).repeat(51), lastName: 'B' }, SELF))).map((i) => [i.field, i.code])).toEqual([
      ['firstName', 'TOO_LONG'],
    ]);
  });

  const INVALID: { label: string; first: unknown; last: unknown; issues: [string, string][] }[] = [
    { label: 'an empty first name', first: '', last: 'Martin', issues: [['firstName', 'REQUIRED']] },
    { label: 'a blank last name', first: 'Ana', last: '   ', issues: [['lastName', 'REQUIRED']] },
    { label: 'whitespace made of tabs and line breaks', first: `${ch(0x09, 0x0a)}`, last: 'Martin', issues: [['firstName', 'REQUIRED']] },
    { label: 'only zero-width characters', first: ch(0x200b, 0x2060), last: 'Martin', issues: [['firstName', 'REQUIRED']] },
    {
      label: 'missing values (not strings)',
      first: undefined,
      last: null,
      issues: [
        ['firstName', 'REQUIRED'],
        ['lastName', 'REQUIRED'],
      ],
    },
    { label: 'a number', first: 42, last: 'Martin', issues: [['firstName', 'REQUIRED']] },
    { label: 'a 51-character last name', first: 'Ana', last: 'm'.repeat(51), issues: [['lastName', 'TOO_LONG']] },
    { label: 'a control character', first: `An${ch(0x01)}a`, last: 'Martin', issues: [['firstName', 'INVALID_CHARACTERS']] },
    { label: 'a bidirectional override', first: 'Ana', last: `Mar${ch(0x202e)}tin`, issues: [['lastName', 'INVALID_CHARACTERS']] },
    { label: 'a bidirectional isolate', first: `${ch(0x2066)}Ana`, last: 'Martin', issues: [['firstName', 'INVALID_CHARACTERS']] },
    { label: 'a C1 control character', first: 'Ana', last: `Mar${ch(0x85)}tin`, issues: [['lastName', 'INVALID_CHARACTERS']] },
    { label: 'an unpaired surrogate', first: `An${String.fromCharCode(0xd800)}a`, last: 'Martin', issues: [['firstName', 'INVALID_CHARACTERS']] },
    {
      label: 'two bad names',
      first: 'a'.repeat(60),
      last: '',
      issues: [
        ['firstName', 'TOO_LONG'],
        ['lastName', 'REQUIRED'],
      ],
    },
  ];
  it.each(INVALID)('rejects $label with issues (field, code, message key) and writes nothing', async ({ first, last, issues }) => {
    const { id } = await newAccount();
    const before = await footprint(id);
    const worldBefore = await world();
    const e = await err(svc.upsertProfile(id, { firstName: first as string, lastName: last as string }, SELF));
    expect(e).toBeInstanceOf(AccountError);
    const got = e!.details.issues as { field: string; code: string; messageKey: string }[];
    expect(got.map((i) => [i.field, i.code])).toEqual(issues);
    for (const i of got) expect(i.messageKey).toBe(`account.error.name_${i.code.toLowerCase()}`);
    expect({ code: e!.code, reason: e!.details.reason }).toEqual({ code: 'VALIDATION_FAILED', reason: 'INVALID_PROFILE' });
    expect(await footprint(id)).toEqual(before);
    expect(await world()).toEqual(worldBefore);
  });

  it('keeps a rejected value out of the error (message, details, stack)', async () => {
    const { id } = await newAccount();
    const secretName = `${NEEDLE_FIRST}${ch(0x202e)}`;
    const e = await err(svc.upsertProfile(id, { firstName: secretName, lastName: NEEDLE_LAST.repeat(8) }, SELF));
    expect(e).toBeInstanceOf(AccountError);
    const text = JSON.stringify({ m: e!.message, d: e!.details, s: e!.stack, t: String(e) });
    expect(text).not.toContain(NEEDLE_FIRST);
    expect(text).not.toContain(NEEDLE_LAST);
  });

  it('rejects an unknown, inactive or malformed locale and an unknown or not-ACTIVE time zone, writing nothing', async () => {
    await q("INSERT INTO content.locales (locale, is_active) VALUES ('de-DE', false), ('es-MX', true)");
    await q("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Phoenix')"); // registered but PLANNED
    const { id } = await newAccount();
    const before = await footprint(id);
    const fields = { firstName: 'Ana', lastName: 'Martin' };
    const reasonOf = async (extra: Record<string, unknown>) => {
      const e = await err(svc.upsertProfile(id, { ...fields, ...extra }, SELF));
      expect(e?.code).toBe('VALIDATION_FAILED');
      return [e?.details.reason, e?.details.field];
    };
    expect(await reasonOf({ preferredLocale: 'fr-FR' })).toEqual(['UNKNOWN_LOCALE', 'preferredLocale']);
    expect(await reasonOf({ preferredLocale: 'de-DE' })).toEqual(['UNKNOWN_LOCALE', 'preferredLocale']); // registered, not active
    expect(await reasonOf({ preferredLocale: 'en_US' })).toEqual(['INVALID_FIELD', 'preferredLocale']);
    expect(await reasonOf({ preferredLocale: 'not a locale' })).toEqual(['INVALID_FIELD', 'preferredLocale']);
    expect(await reasonOf({ timeZone: 'Mars/Phobos' })).toEqual(['UNKNOWN_TIME_ZONE', 'timeZone']);
    expect(await reasonOf({ timeZone: 'america/denver' })).toEqual(['UNKNOWN_TIME_ZONE', 'timeZone']); // names are exact
    expect(await reasonOf({ timeZone: 'America/Phoenix' })).toEqual(['UNKNOWN_TIME_ZONE', 'timeZone']); // PLANNED
    expect(await footprint(id)).toEqual(before);
    // an ACTIVE locale registered later is accepted
    expect((await svc.upsertProfile(id, { ...fields, preferredLocale: 'es-mx' }, SELF)).profile.preferredLocale).toBe('es-MX');
  });

  it('fails for an unknown account (NOT_FOUND) and for a blank actor, writing nothing', async () => {
    const { id } = await newAccount();
    const before = await world();
    expect(await code(svc.upsertProfile(randomUUID(), { firstName: 'Ana', lastName: 'Martin' }, SELF))).toBe('NOT_FOUND');
    expect(await code(svc.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin' }, { actor: '  ' }))).toBe('VALIDATION_FAILED');
    expect(await world()).toEqual(before);
  });

  it('parallel identical writes create one profile row and one audit row; parallel different writes leave one of them and an audit row per change', async () => {
    const same = await newAccount();
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.upsertProfile(same.id, { firstName: 'Ana', lastName: 'Martin' }, SELF)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await footprint(same.id)).profiles).toBe(1);
    expect((await audit(same.id)).filter((a) => a.action === 'PROFILE_UPDATED')).toHaveLength(1);

    const diff = await newAccount();
    const names = Array.from({ length: 8 }, (_, i) => `Name${i}`);
    const out = await Promise.all(names.map((n) => svc.upsertProfile(diff.id, { firstName: n, lastName: 'Same' }, SELF)));
    expect(out.filter((r) => r.changed).length).toBeGreaterThanOrEqual(1);
    expect((await footprint(diff.id)).profiles).toBe(1);
    expect(names).toContain((await profileRow(diff.id))!.first_name);
    expect((await audit(diff.id)).filter((a) => a.action === 'PROFILE_UPDATED')).toHaveLength(out.filter((r) => r.changed).length);
  });
});

// ====================================================================== privacy of logs
function captureOutput() {
  const lines: string[] = [];
  const take = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(take));
  const sink = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never;
  spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(sink) as never, vi.spyOn(process.stderr, 'write').mockImplementation(sink) as never);
  return { lines, stop: () => spies.forEach((s) => s.mockRestore()) };
}

describe('privacy: nothing personal is logged', () => {
  it('bootstrap, grants, status changes, profile writes and every failure never put the subject, issuer, a name or a realm role in a log line, and errors carry none of them', async () => {
    const subject = `sub-${randomUUID()}`;
    const issuer = `https://issuer-${randomUUID()}.example/realms/privacy`;
    const unknownRole = `realm-role-${randomUUID()}`;
    const first = `Quillfeather${randomUUID().slice(0, 8)}`;
    const last = `Ostrichwool${randomUUID().slice(0, 8)}`;
    const identity = ident({ subject, issuer, identityRoles: ['customer', 'provider', unknownRole] });
    const needles = [subject, issuer, unknownRole, first, last, 'realm_access'];
    const touching = new AccountService({ database: bigDb, lastSeenTouchSeconds: 0 });
    const errors: unknown[] = [];
    const out = captureOutput();
    let id: string;
    try {
      const ctx = await svc.ensureAccountForIdentity(identity);
      id = ctx.accountId;
      await touching.ensureAccountForIdentity(identity);
      await svc.ensureAccountForIdentity(identity, { requestedRole: 'PROVIDER' });
      errors.push(await rejection(svc.ensureAccountForIdentity(identity, { requestedRole: 'ADMIN' })));
      errors.push(await rejection(svc.ensureAccountForIdentity({ ...identity, subject: `${subject}${ch(0x0a)}` })));
      errors.push(await rejection(svc.ensureAccountForIdentity({ ...identity, issuer: '' })));
      await svc.upsertProfile(id, { firstName: first, lastName: last, preferredLocale: 'en-US', timeZone: 'America/Denver' }, { actor: 'account:self' });
      await svc.upsertProfile(id, { firstName: first, lastName: last }, { actor: 'account:self' });
      errors.push(await rejection(svc.upsertProfile(id, { firstName: `${first}${ch(0x202e)}`, lastName: last.repeat(10) }, { actor: 'account:self' })));
      errors.push(await rejection(svc.upsertProfile(id, { firstName: first, lastName: last, timeZone: `Mars/${first}` }, { actor: 'account:self' })));
      await svc.getAccountContext(id, { includeProfile: true });
      await svc.selectActiveRole(id, 'CUSTOMER');
      await svc.grantRole(id, 'PROVIDER', { actor: 'system:t', source: 'SYSTEM' });
      errors.push(await rejection(svc.grantRole(id, unknownRole, { actor: 'system:t', source: 'SYSTEM' })));
      errors.push(await rejection(svc.deactivateRole(id, `NO_${first.toUpperCase()}`, OP)));
      errors.push(await rejection(svc.setPrimaryRole(id, 'ROLE_NEVER_HELD', OP)));
      await svc.deactivateRole(id, 'PROVIDER', OP);
      await svc.changeStatus(id, 'SUSPENDED', OP);
      errors.push(await rejection(svc.ensureAccountForIdentity(identity)));
      errors.push(await rejection(svc.changeStatus(id, 'PENDING', OP)));
      await svc.changeStatus(id, 'CLOSED', OP);
      errors.push(await rejection(svc.ensureAccountForIdentity(identity)));
      errors.push(await rejection(svc.upsertProfile(id, { firstName: first, lastName: last }, { actor: 'account:self' })));
      // the database cannot be reached: the one failure that logs
      const down = createDatabase('postgres://bananagig:none@127.0.0.1:1/none', { role: 'tests', overrides: { connectionTimeoutMs: 1000 } });
      try {
        errors.push(await rejection(new AccountService({ database: down }).ensureAccountForIdentity(identity)));
      } finally {
        await down.close();
      }
    } finally {
      out.stop();
    }
    const captured = out.lines.join('\n');
    for (const needle of needles) expect(captured.includes(needle), `"${needle}" must not appear in any log line`).toBe(false);
    // the realm role names (common words) are checked against the structured log lines only
    const logLines = out.lines.filter((l) => l.startsWith('{') && l.includes('"message"'));
    for (const word of ['customer', 'provider']) for (const l of logLines) expect(l.toLowerCase().includes(word), `"${word}" in ${l}`).toBe(false);
    // the capture works: the outage was logged, with the error class or SQLSTATE only (the driver message can echo statement text)
    const outage = logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.message === 'account database unavailable');
    expect(outage).toHaveLength(1);
    expect(outage[0]).toMatchObject({ level: 'error', code: 'ECONNREFUSED' });
    expect(
      Object.keys(outage[0]!).filter((k) => !['timestamp', 'level', 'service', 'environment', 'message', 'correlationId', 'traceId', 'spanId'].includes(k)),
    ).toEqual(['code']);
    // every failure is typed and carries no identity value, name or role string
    expect(errors.length).toBeGreaterThan(12);
    for (const e of errors) {
      expect(e).toBeInstanceOf(AccountError);
      const text = JSON.stringify({
        name: (e as AccountError).name,
        message: (e as AccountError).message,
        details: (e as AccountError).details,
        stack: (e as AccountError).stack,
        text: String(e),
      });
      for (const needle of needles) expect(text.includes(needle), `"${needle}" must not appear in an error`).toBe(false);
    }
    expect(errors.map((e) => (e as AccountError).code)).toEqual([
      'ROLE_NOT_HELD',
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
      'ROLE_NOT_FOUND',
      'ROLE_NOT_HELD',
      'ROLE_NOT_HELD',
      'SUSPENDED',
      'INVALID_STATE',
      'CLOSED',
      'CLOSED',
      'UNAVAILABLE',
    ]);
    // the only table that holds the subject and issuer is the link; the name only the profile
    expect(await tablesContaining(subject)).toEqual(['identity.external_identities']);
    expect(await tablesContaining(issuer)).toEqual(['identity.external_identities']);
    expect(await tablesContaining(first)).toEqual(['identity.account_profiles']);
    expect(await tablesContaining(unknownRole)).toEqual([]);
  });
});

describe('global invariants after everything above', () => {
  it('holds: every primary role is an ACTIVE membership, no CLOSED account holds a role, and every status equals its newest history row', async () => {
    await expectInvariants();
  });
});
