import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0009 creates the identity schema (roles, accounts, account_roles, external_identities, account_status_history, account_profiles,
// account_audit_events), their guard triggers and the deferred status-history trigger, and seeds the two roles and 17 content entries. These tests drive the
// REAL tables with raw SQL: the seeded state from zero, every CHECK/UNIQUE/FK/PK by constraint name, every guard rule (SQLSTATE 23000, DETAIL
// identity_rule:<KEY>), the deferred trigger at COMMIT, and the shape of the schema (no credentials, contacts, addresses or country-specific columns).
// Service behaviour is covered in packages/accounts (accounts.itest.ts).
let iso: IsolatedDatabase;
let pool: pg.Pool;
let seq = 0;
let CUSTOMER: string;
let PROVIDER: string;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = new pg.Pool({ connectionString: iso.url, max: 10 });
  CUSTOMER = (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER'"))[0]!.role_id;
  PROVIDER = (await q<{ role_id: string }>("SELECT role_id FROM identity.roles WHERE code = 'PROVIDER'"))[0]!.role_id;
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

// ---------------------------------------------------------------- helpers
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}
/** The failure of a statement (the test fails when the statement succeeds). */
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** The violated constraint of a rejected statement. */
const constraintOf = async (p: Promise<unknown>): Promise<string | undefined> => (await fail(p)).constraint;
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL identity_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `identity_rule:${key}` });
};
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const uniq = (): string => `${++seq}-${randomUUID().slice(0, 8)}`;

/** Runs the callback in one transaction on its own connection: COMMIT on success (a deferred trigger may fail right there), ROLLBACK on any failure. */
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
/**
 * Runs `prep` statements and then `text` inside a transaction that is ALWAYS rolled back. Used to reach a CHECK or foreign key that a guard trigger (or a
 * sibling CHECK) would report first: the prep disables the user triggers of one table, or drops the shadowing constraint, for this transaction only.
 */
async function isolated(prep: string[], text: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const p of prep) await c.query(p);
    await c.query(text, params);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const noTriggers = (table: string): string[] => [`ALTER TABLE ${table} DISABLE TRIGGER USER`];

/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}

// ---------------------------------------------------------------- fixtures (committed, valid, one per test)
const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED'] as const;
type AccountStatus = (typeof STATUSES)[number];
type MemberStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE';

/** A new role (reference row) with a unique valid code, optionally INACTIVE (nobody holds it, so the guard allows it). */
async function makeRole(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<{ roleId: string; code: string }> {
  const code = `TR${++seq}`;
  const r = await q<{ role_id: string }>(
    "INSERT INTO identity.roles (code, name_content_key, status) VALUES ($1, 'identity.role.customer.name', 'ACTIVE') RETURNING role_id",
    [code],
  );
  if (status === 'INACTIVE') await run("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE role_id = $1", [r[0]!.role_id]);
  return { roleId: r[0]!.role_id, code };
}
const historyRow = (c: pg.PoolClient | pg.Pool, accountId: string, from: string | null, to: string) =>
  c.query(
    "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2::text, $3::text, NULL, 'test', 'test-correlation')",
    [accountId, from, to],
  );
/** An account in its creation state (PENDING or ACTIVE) with the creation history row, in one transaction (the deferred trigger demands both). */
async function makeAccount(status: 'PENDING' | 'ACTIVE' = 'ACTIVE'): Promise<string> {
  return inTx(async (c) => {
    const r = await c.query('INSERT INTO identity.accounts (status) VALUES ($1) RETURNING account_id', [status]);
    const id = r.rows[0].account_id as string;
    await historyRow(c, id, null, status);
    return id;
  });
}
/** Moves an account to another status together with its history row (the service does the same in one transaction). */
async function setStatus(accountId: string, to: AccountStatus): Promise<void> {
  await inTx(async (c) => {
    const from = (await c.query('SELECT status FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0].status as string;
    await c.query(
      "UPDATE identity.accounts SET status = $2::text, closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() END, updated_at = now() WHERE account_id = $1",
      [accountId, to],
    );
    await historyRow(c, accountId, from, to);
  });
}
/** An account in the given status, reached along a legal path (no role is held, so it can be closed). */
async function accountIn(status: AccountStatus): Promise<string> {
  if (status === 'PENDING') return makeAccount('PENDING');
  const id = await makeAccount('ACTIVE');
  if (status === 'SUSPENDED' || status === 'CLOSURE_REQUESTED') await setStatus(id, status);
  if (status === 'CLOSED') {
    await setStatus(id, 'SUSPENDED');
    await setStatus(id, 'CLOSED');
  }
  return id;
}
const statusOf = async (accountId: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM identity.accounts WHERE account_id = $1', [accountId]))[0]!.status;
const primaryOf = async (accountId: string): Promise<string | null> =>
  (await q<{ primary_role_id: string | null }>('SELECT primary_role_id FROM identity.accounts WHERE account_id = $1', [accountId]))[0]!.primary_role_id;
const addMembership = (accountId: string, roleId: string, status: 'PENDING' | 'ACTIVE' = 'ACTIVE') =>
  run(
    "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, $3::text, CASE WHEN $3::text = 'ACTIVE' THEN now() END, 'test', 'SYSTEM')",
    [accountId, roleId, status],
  );
const setMembership = (accountId: string, roleId: string, to: MemberStatus) =>
  run(
    `UPDATE identity.account_roles SET status = $3::text,
       activated_at = CASE WHEN $3::text = 'PENDING' THEN NULL WHEN $3::text = 'ACTIVE' THEN now() ELSE activated_at END,
       deactivated_at = CASE WHEN $3::text = 'INACTIVE' THEN now() ELSE NULL END, updated_at = now() WHERE account_id = $1 AND role_id = $2`,
    [accountId, roleId, to],
  );
const memberStatusOf = async (accountId: string, roleId: string): Promise<string | undefined> =>
  (await q<{ status: string }>('SELECT status FROM identity.account_roles WHERE account_id = $1 AND role_id = $2', [accountId, roleId]))[0]?.status;
/** A membership in the wanted state, reached along a legal path (the account has no primary role). */
async function membershipIn(accountId: string, roleId: string, status: MemberStatus): Promise<void> {
  await addMembership(accountId, roleId, status === 'PENDING' ? 'PENDING' : 'ACTIVE');
  if (status === 'INACTIVE') await setMembership(accountId, roleId, 'INACTIVE');
}
const setPrimary = (accountId: string, roleId: string | null) =>
  run('UPDATE identity.accounts SET primary_role_id = $2, updated_at = now() WHERE account_id = $1', [accountId, roleId]);
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const link = (accountId: string, subject = `sub-${uniq()}`, issuer = ISSUER): Promise<string> =>
  q<{ external_identity_id: string }>(
    "INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject) VALUES ($1, 'KEYCLOAK', $2, $3) RETURNING external_identity_id",
    [accountId, issuer, subject],
  ).then((r) => r[0]!.external_identity_id);
const insertProfile = (accountId: string, first = 'Ana', last = 'Martin', locale: string | null = null, zone: string | null = null) =>
  run('INSERT INTO identity.account_profiles (account_id, first_name, last_name, preferred_locale, time_zone_id) VALUES ($1, $2, $3, $4, $5)', [
    accountId,
    first,
    last,
    locale,
    zone,
  ]);
const insertAudit = (accountId: string, action: string, roleId: string | null = null, changes: string | null = null, actor = 'test') =>
  q<{ audit_event_id: string }>(
    'INSERT INTO identity.account_audit_events (actor, action, account_id, role_id, changes, correlation_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING audit_event_id',
    [actor, action, accountId, roleId, changes, 'test-correlation'],
  ).then((r) => r[0]!.audit_event_id);
const zoneId = async (iana: string): Promise<string> =>
  (await q<{ time_zone_id: string }>('SELECT time_zone_id FROM geography.time_zones WHERE iana_name = $1', [iana]))[0]!.time_zone_id;

// ====================================================================== migration from zero
const SEEDED_COPY: [key: string, body: string][] = [
  ['identity.role.customer.name', 'Customer'],
  ['identity.role.provider.name', 'Provider'],
  ['account.status.pending', 'Pending'],
  ['account.status.active', 'Active'],
  ['account.status.suspended', 'Suspended'],
  ['account.status.closure_requested', 'Closure requested'],
  ['account.status.closed', 'Closed'],
  ['session.account.id', 'Account'],
  ['session.account.status', 'Account status'],
  ['session.account.roles', 'Application roles'],
  ['session.account.active_role', 'Active role'],
  ['session.account.unavailable', 'Account details are unavailable.'],
  ['account.error.name_required', 'Enter a name.'],
  ['account.error.name_too_long', 'This name is too long.'],
  ['account.error.name_invalid_characters', 'This name contains characters that are not allowed.'],
  ['account.error.suspended', 'This account is suspended.'],
  ['account.error.closed', 'This account is closed.'],
];
const TABLES = ['account_audit_events', 'account_profiles', 'account_roles', 'account_status_history', 'accounts', 'external_identities', 'roles'].sort();

describe('migration 0009 from zero', () => {
  it('creates exactly the seven identity tables and nothing else that stores data', async () => {
    const tables = await q<{ table_name: string; table_type: string }>(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'identity'",
    );
    expect(tables.map((r) => [r.table_name, r.table_type]).sort()).toEqual(TABLES.map((t) => [t, 'BASE TABLE']));
    expect(await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).toEqual([
      { relname: 'account_status_history_history_seq_seq' },
    ]);
  });

  it('seeds the CUSTOMER and PROVIDER roles ACTIVE, with name keys that exist as PUBLISHED en-US content', async () => {
    const roles = await q<{ code: string; status: string; name_content_key: string; body: string; version_status: string }>(
      `SELECT r.code, r.status, r.name_content_key, v.body, v.status AS version_status FROM identity.roles r
         JOIN content.entries e ON e.key = r.name_content_key JOIN content.versions v ON v.entry_id = e.entry_id AND v.locale = 'en-US' ORDER BY r.code`,
    );
    expect(roles).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE', name_content_key: 'identity.role.customer.name', body: 'Customer', version_status: 'PUBLISHED' },
      { code: 'PROVIDER', status: 'ACTIVE', name_content_key: 'identity.role.provider.name', body: 'Provider', version_status: 'PUBLISHED' },
    ]);
    expect(await count('identity.roles')).toBe(2);
  });

  it('seeds exactly the 17 account shell content entries with their en-US text, each through the real lifecycle (one PUBLISHED PLATFORM version, five audit rows)', async () => {
    const entries = await q<{ key: string }>(
      "SELECT DISTINCT e.key FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE a.correlation_id = 'seed-0009'",
    );
    expect(entries.map((r) => r.key).sort()).toEqual(SEEDED_COPY.map(([k]) => k).sort());
    const rows = await q<{ key: string; body: string; status: string; locale: string; scope_type: string; version: number; n: string }>(
      `SELECT e.key, v.body, v.status, v.locale, v.scope_type, v.version, (SELECT count(*) FROM content.audit_events a WHERE a.entry_id = e.entry_id) AS n
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = ANY($1)`,
      [SEEDED_COPY.map(([k]) => k)],
    );
    const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1);
    expect(rows.sort(byKey)).toEqual(
      SEEDED_COPY.map(([key, body]) => ({ key, body, status: 'PUBLISHED', locale: 'en-US', scope_type: 'PLATFORM', version: 1, n: '5' })).sort(byKey),
    );
  });

  it('seeds no account, identity, membership, history, audit or outbox row (accounts appear with the first authenticated request)', async () => {
    for (const t of ['accounts', 'account_roles', 'external_identities', 'account_status_history', 'account_profiles', 'account_audit_events'])
      expect(await count(`identity.${t}`), t).toBe(0);
    expect(await count('integration.outbox_events', "event_type LIKE 'bananagig.identity.%'")).toBe(0);
  });
});

// ====================================================================== constraints
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });
const newRole = (code: string, key = 'identity.role.customer.name', status = 'ACTIVE') =>
  run('INSERT INTO identity.roles (code, name_content_key, status) VALUES ($1, $2, $3)', [code, key, status]);
const insertIdentity = (accountId: string, o: { type?: string; issuer?: string; subject?: string } = {}) =>
  run('INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject) VALUES ($1, $2, $3, $4)', [
    accountId,
    o.type ?? 'KEYCLOAK',
    o.issuer ?? ISSUER,
    o.subject ?? `sub-${uniq()}`,
  ]);
const insertHistory = (accountId: string, o: { from?: string | null; to?: string; reason?: string | null; actor?: string } = {}) =>
  run('INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)', [
    accountId,
    o.from === undefined ? 'ACTIVE' : o.from,
    o.to ?? 'SUSPENDED',
    o.reason === undefined ? null : o.reason,
    o.actor ?? 'test',
    'test-correlation',
  ]);
const NAME_CHARS_REJECTED: [string, string][] = [
  ['SOH (control)', ch(0x01)],
  ['TAB inside the name', ch(0x09)],
  ['LINE FEED inside the name', ch(0x0a)],
  ['DEL', ch(0x7f)],
  ['NEL (C1 control)', ch(0x85)],
  ['APC (C1 control)', ch(0x9f)],
  ['LEFT-TO-RIGHT EMBEDDING', ch(0x202a)],
  ['RIGHT-TO-LEFT OVERRIDE', ch(0x202e)],
  ['LEFT-TO-RIGHT ISOLATE', ch(0x2066)],
  ['POP DIRECTIONAL ISOLATE', ch(0x2069)],
];

const CONSTRAINT_CASES: ConstraintCase[] = [
  // ---- roles
  bad('pk_roles', 'a duplicate role_id', () =>
    run("INSERT INTO identity.roles (role_id, code, name_content_key) VALUES ($1, 'XPK1', 'identity.role.customer.name')", [CUSTOMER]),
  ),
  bad('uq_roles__code', 'a duplicate code', () => newRole('CUSTOMER')),
  bad('fk_roles__name_content_key', 'a content key that does not exist', () => newRole('XFK1', 'identity.role.missing.name')),
  bad('ck_roles__code_format', 'a lower-case code', () => newRole('customer')),
  bad('ck_roles__code_format', 'a code starting with a digit', () => newRole('1ABC')),
  bad('ck_roles__code_format', 'a one-character code', () => newRole('A')),
  bad('ck_roles__code_format', 'a 31-character code', () => newRole('A'.repeat(31))),
  bad('ck_roles__code_format', 'a code with a space', () => newRole('MY ROLE')),
  bad('ck_roles__name_content_key_format', 'a key that is not a dotted lower-case content key', () => newRole('XKF1', 'Not A Key')),
  bad('ck_roles__status', 'an unknown status', () => newRole('XST1', 'identity.role.customer.name', 'DELETED')),

  // ---- accounts
  bad('pk_accounts', 'a duplicate account_id', async () =>
    run("INSERT INTO identity.accounts (account_id, status) VALUES ($1, 'ACTIVE')", [await makeAccount()]),
  ),
  bad('ck_accounts__closed_at', 'closed_at on an account that is not CLOSED (insert)', () =>
    run("INSERT INTO identity.accounts (status, closed_at) VALUES ('PENDING', now())"),
  ),
  bad('ck_accounts__closed_at', 'closed_at on a transition to SUSPENDED', async () =>
    run("UPDATE identity.accounts SET status = 'SUSPENDED', closed_at = now() WHERE account_id = $1", [await makeAccount()]),
  ),
  bad('ck_accounts__closed_at', 'status CLOSED without closed_at', async () =>
    run("UPDATE identity.accounts SET status = 'CLOSED' WHERE account_id = $1", [await makeAccount('PENDING')]),
  ),
  bad('ck_accounts__status', 'an unknown status (insert, triggers off)', () =>
    isolated(noTriggers('identity.accounts'), "INSERT INTO identity.accounts (status) VALUES ('BOGUS')"),
  ),
  bad('ck_accounts__status', 'an unknown status (update, triggers off)', async () => {
    const a = await makeAccount();
    await isolated(noTriggers('identity.accounts'), "UPDATE identity.accounts SET status = 'BOGUS' WHERE account_id = $1", [a]);
  }),
  bad('fk_accounts__primary_role', 'a primary role the new account does not hold (triggers off)', () =>
    isolated(noTriggers('identity.accounts'), "INSERT INTO identity.accounts (status, primary_role_id) VALUES ('ACTIVE', $1)", [CUSTOMER]),
  ),
  bad('fk_accounts__primary_role', 'a primary role held only by ANOTHER account (triggers off)', async () => {
    const other = await makeAccount();
    await addMembership(other, CUSTOMER);
    const a = await makeAccount();
    await isolated(noTriggers('identity.accounts'), 'UPDATE identity.accounts SET primary_role_id = $2 WHERE account_id = $1', [a, CUSTOMER]);
  }),

  // ---- account_roles
  bad('pk_account_roles', 'a second membership row for the same account and role', async () => {
    const a = await makeAccount();
    await addMembership(a, CUSTOMER);
    await addMembership(a, CUSTOMER);
  }),
  bad('pk_account_roles', 'a PENDING duplicate of an ACTIVE membership', async () => {
    const a = await makeAccount();
    await addMembership(a, PROVIDER);
    await addMembership(a, PROVIDER, 'PENDING');
  }),
  bad('fk_account_roles__account_id', 'an account that does not exist', () => addMembership(randomUUID(), CUSTOMER)),
  bad('fk_account_roles__role_id', 'a role that does not exist (triggers off)', async () =>
    isolated(
      noTriggers('identity.account_roles'),
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), 'test', 'SYSTEM')",
      [await makeAccount(), randomUUID()],
    ),
  ),
  bad(
    'ck_account_roles__status',
    'an unknown status (the lifecycle check, which names the same rule, is dropped for this transaction; triggers off)',
    async () =>
      isolated(
        [...noTriggers('identity.account_roles'), 'ALTER TABLE identity.account_roles DROP CONSTRAINT ck_account_roles__lifecycle'],
        "INSERT INTO identity.account_roles (account_id, role_id, status, granted_by, grant_source) VALUES ($1, $2, 'BOGUS', 'test', 'SYSTEM')",
        [await makeAccount(), CUSTOMER],
      ),
  ),
  bad('ck_account_roles__lifecycle', 'an unknown status (reported by the lifecycle check, which sorts first)', async () =>
    isolated(
      noTriggers('identity.account_roles'),
      "INSERT INTO identity.account_roles (account_id, role_id, status, granted_by, grant_source) VALUES ($1, $2, 'BOGUS', 'test', 'SYSTEM')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__lifecycle', 'PENDING with activated_at', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'PENDING', now(), 'test', 'SYSTEM')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__lifecycle', 'ACTIVE without activated_at', async () =>
    run("INSERT INTO identity.account_roles (account_id, role_id, status, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', 'test', 'SYSTEM')", [
      await makeAccount(),
      CUSTOMER,
    ]),
  ),
  bad('ck_account_roles__lifecycle', 'ACTIVE with deactivated_at', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, deactivated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), now(), 'test', 'SYSTEM')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__lifecycle', 'deactivation without deactivated_at', async () => {
    const a = await makeAccount();
    await addMembership(a, CUSTOMER);
    await run("UPDATE identity.account_roles SET status = 'INACTIVE' WHERE account_id = $1 AND role_id = $2", [a, CUSTOMER]);
  }),
  bad('ck_account_roles__grant_source', 'an unknown grant source', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), 'test', 'HACK')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__granted_by', 'an empty granted_by', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), '', 'SYSTEM')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__granted_by', 'a blank granted_by', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), '   ', 'SYSTEM')",
      [await makeAccount(), CUSTOMER],
    ),
  ),
  bad('ck_account_roles__granted_by', 'a 201-character granted_by', async () =>
    run(
      "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), $3, 'SYSTEM')",
      [await makeAccount(), CUSTOMER, 'a'.repeat(201)],
    ),
  ),

  // ---- external_identities
  bad('pk_external_identities', 'a duplicate external_identity_id', async () => {
    const a = await makeAccount();
    const id = await link(a);
    await run(
      "INSERT INTO identity.external_identities (external_identity_id, account_id, provider_type, issuer, provider_subject) VALUES ($1, $2, 'KEYCLOAK', $3, $4)",
      [id, a, ISSUER, `s-${uniq()}`],
    );
  }),
  bad('uq_external_identities__provider_issuer_subject', 'the same (provider, issuer, subject) twice on one account', async () => {
    const a = await makeAccount();
    await link(a, 'dup-subject-1');
    await link(a, 'dup-subject-1');
  }),
  bad('uq_external_identities__provider_issuer_subject', 'the same (provider, issuer, subject) on a second account', async () => {
    const subject = `shared-${uniq()}`;
    await link(await makeAccount(), subject);
    await link(await makeAccount(), subject);
  }),
  bad('fk_external_identities__account_id', 'an account that does not exist', () => insertIdentity(randomUUID())),
  bad('ck_external_identities__provider_type', 'a provider type other than KEYCLOAK', async () => insertIdentity(await makeAccount(), { type: 'GOOGLE' })),
  bad('ck_external_identities__issuer', 'an empty issuer', async () => insertIdentity(await makeAccount(), { issuer: '' })),
  bad('ck_external_identities__issuer', 'a blank issuer', async () => insertIdentity(await makeAccount(), { issuer: '   ' })),
  bad('ck_external_identities__issuer', 'a 513-character issuer', async () => insertIdentity(await makeAccount(), { issuer: `https://${'a'.repeat(505)}` })),
  bad('ck_external_identities__issuer', 'an issuer with a control character', async () =>
    insertIdentity(await makeAccount(), { issuer: `https://auth${ch(0x01)}.example` }),
  ),
  bad('ck_external_identities__issuer', 'an issuer with a line break', async () =>
    insertIdentity(await makeAccount(), { issuer: `https://auth.example${ch(0x0a)}` }),
  ),
  bad('ck_external_identities__issuer', 'an issuer with DEL', async () => insertIdentity(await makeAccount(), { issuer: `https://auth${ch(0x7f)}.example` })),
  bad('ck_external_identities__subject', 'an empty subject', async () => insertIdentity(await makeAccount(), { subject: '' })),
  bad('ck_external_identities__subject', 'a blank subject', async () => insertIdentity(await makeAccount(), { subject: '  ' })),
  bad('ck_external_identities__subject', 'a 256-character subject', async () => insertIdentity(await makeAccount(), { subject: 's'.repeat(256) })),
  bad('ck_external_identities__subject', 'a subject with a control character', async () => insertIdentity(await makeAccount(), { subject: `sub${ch(0x1f)}x` })),
  bad('ck_external_identities__subject', 'a subject with a tab', async () => insertIdentity(await makeAccount(), { subject: `sub${ch(0x09)}x` })),
  bad('ck_external_identities__subject', 'a subject with DEL', async () => insertIdentity(await makeAccount(), { subject: `sub${ch(0x7f)}x` })),

  // ---- account_status_history
  bad('pk_account_status_history', 'a duplicate status_history_id', async () => {
    const a = await makeAccount();
    const id = (await q<{ status_history_id: string }>('SELECT status_history_id FROM identity.account_status_history WHERE account_id = $1', [a]))[0]!
      .status_history_id;
    await run(
      "INSERT INTO identity.account_status_history (status_history_id, account_id, from_status, to_status, actor, correlation_id) VALUES ($1, $2, 'ACTIVE', 'SUSPENDED', 'test', 'c')",
      [id, a],
    );
  }),
  bad('uq_account_status_history__seq', 'an explicit history_seq that is already used', async () => {
    const a = await makeAccount();
    const seqNo = (await q<{ history_seq: string }>('SELECT history_seq FROM identity.account_status_history WHERE account_id = $1', [a]))[0]!.history_seq;
    await run(
      "INSERT INTO identity.account_status_history (history_seq, account_id, from_status, to_status, actor, correlation_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'ACTIVE', 'SUSPENDED', 'test', 'c')",
      [seqNo, a],
    );
  }),
  bad('fk_account_status_history__account_id', 'an account that does not exist', () => insertHistory(randomUUID())),
  bad('ck_account_status_history__from_status', 'an unknown from_status', async () => insertHistory(await makeAccount(), { from: 'BOGUS' })),
  bad('ck_account_status_history__to_status', 'an unknown to_status', async () => insertHistory(await makeAccount(), { to: 'BOGUS' })),
  bad('ck_account_status_history__changed', 'from_status equal to to_status', async () => insertHistory(await makeAccount(), { from: 'ACTIVE', to: 'ACTIVE' })),
  bad('ck_account_status_history__reason', 'an empty reason', async () => insertHistory(await makeAccount(), { reason: '' })),
  bad('ck_account_status_history__reason', 'a blank reason', async () => insertHistory(await makeAccount(), { reason: '   ' })),
  bad('ck_account_status_history__reason', 'a 1001-character reason', async () => insertHistory(await makeAccount(), { reason: 'r'.repeat(1001) })),
  bad('ck_account_status_history__actor', 'an empty actor', async () => insertHistory(await makeAccount(), { actor: '' })),
  bad('ck_account_status_history__actor', 'a blank actor', async () => insertHistory(await makeAccount(), { actor: '  ' })),
  bad('ck_account_status_history__actor', 'a 201-character actor', async () => insertHistory(await makeAccount(), { actor: 'a'.repeat(201) })),

  // ---- account_profiles
  bad('pk_account_profiles', 'a second profile for the same account (one row at most)', async () => {
    const a = await makeAccount();
    await insertProfile(a);
    await insertProfile(a, 'Bo', 'Li');
  }),
  bad('fk_account_profiles__account_id', 'an account that does not exist', () => insertProfile(randomUUID())),
  bad('fk_account_profiles__preferred_locale', 'a locale that is not registered', async () => insertProfile(await makeAccount(), 'Ana', 'Martin', 'xx-YY')),
  bad('fk_account_profiles__time_zone_id', 'a time zone that is not registered', async () =>
    insertProfile(await makeAccount(), 'Ana', 'Martin', null, randomUUID()),
  ),
  bad('ck_account_profiles__first_name', 'an empty first name', async () => insertProfile(await makeAccount(), '')),
  bad('ck_account_profiles__first_name', 'a 51-character first name', async () => insertProfile(await makeAccount(), 'a'.repeat(51))),
  bad('ck_account_profiles__first_name', 'a 51-code-point first name made of emoji', async () => insertProfile(await makeAccount(), ch(0x1f600).repeat(51))),
  bad('ck_account_profiles__first_name', 'a leading space', async () => insertProfile(await makeAccount(), ' Ana')),
  bad('ck_account_profiles__first_name', 'a trailing space', async () => insertProfile(await makeAccount(), 'Ana ')),
  bad('ck_account_profiles__first_name', 'a leading tab', async () => insertProfile(await makeAccount(), `${ch(0x09)}Ana`)),
  bad('ck_account_profiles__first_name', 'a trailing line break', async () => insertProfile(await makeAccount(), `Ana${ch(0x0a)}`)),
  ...NAME_CHARS_REJECTED.map(([label, c]) =>
    bad('ck_account_profiles__first_name', `a first name with ${label}`, async () => insertProfile(await makeAccount(), `An${c}a`)),
  ),
  bad('ck_account_profiles__last_name', 'an empty last name', async () => insertProfile(await makeAccount(), 'Ana', '')),
  bad('ck_account_profiles__last_name', 'a 51-character last name', async () => insertProfile(await makeAccount(), 'Ana', 'm'.repeat(51))),
  bad('ck_account_profiles__last_name', 'a leading space', async () => insertProfile(await makeAccount(), 'Ana', ' Martin')),
  bad('ck_account_profiles__last_name', 'a trailing space', async () => insertProfile(await makeAccount(), 'Ana', 'Martin ')),
  ...NAME_CHARS_REJECTED.map(([label, c]) =>
    bad('ck_account_profiles__last_name', `a last name with ${label}`, async () => insertProfile(await makeAccount(), 'Ana', `Mar${c}tin`)),
  ),

  // ---- account_audit_events
  bad('pk_account_audit_events', 'a duplicate audit_event_id', async () => {
    const a = await makeAccount();
    const id = await insertAudit(a, 'ACCOUNT_CREATED');
    await run(
      "INSERT INTO identity.account_audit_events (audit_event_id, actor, action, account_id, correlation_id) VALUES ($1, 'test', 'ACCOUNT_CREATED', $2, 'c')",
      [id, a],
    );
  }),
  bad('fk_account_audit_events__account_id', 'an account that does not exist', () => insertAudit(randomUUID(), 'ACCOUNT_CREATED')),
  bad('fk_account_audit_events__role_id', 'a role that does not exist', async () => insertAudit(await makeAccount(), 'ROLE_GRANTED', randomUUID())),
  bad('ck_account_audit_events__action', 'an unknown action', async () => insertAudit(await makeAccount(), 'LOGIN')),
  bad('ck_account_audit_events__action', 'a status action (status changes are the history table)', async () =>
    insertAudit(await makeAccount(), 'ACCOUNT_STATUS_CHANGED'),
  ),
  bad('ck_account_audit_events__role', 'ROLE_GRANTED without a role', async () => insertAudit(await makeAccount(), 'ROLE_GRANTED')),
  bad('ck_account_audit_events__role', 'ROLE_ACTIVATED without a role', async () => insertAudit(await makeAccount(), 'ROLE_ACTIVATED')),
  bad('ck_account_audit_events__role', 'ROLE_DEACTIVATED without a role', async () => insertAudit(await makeAccount(), 'ROLE_DEACTIVATED')),
  bad('ck_account_audit_events__role', 'ACCOUNT_CREATED with a role', async () => insertAudit(await makeAccount(), 'ACCOUNT_CREATED', CUSTOMER)),
  bad('ck_account_audit_events__role', 'PRIMARY_ROLE_CHANGED with a role (only the ROLE_ actions name one)', async () =>
    insertAudit(await makeAccount(), 'PRIMARY_ROLE_CHANGED', CUSTOMER),
  ),
  bad('ck_account_audit_events__role', 'PROFILE_UPDATED with a role', async () => insertAudit(await makeAccount(), 'PROFILE_UPDATED', PROVIDER)),
  bad('ck_account_audit_events__changes_object', 'changes that is a JSON array', async () =>
    insertAudit(await makeAccount(), 'PROFILE_UPDATED', null, '["firstName"]'),
  ),
  bad('ck_account_audit_events__changes_object', 'changes that is a JSON string', async () =>
    insertAudit(await makeAccount(), 'PROFILE_UPDATED', null, '"firstName"'),
  ),
  bad('ck_account_audit_events__changes_object', 'changes that is a JSON number', async () => insertAudit(await makeAccount(), 'PROFILE_UPDATED', null, '1')),
  bad('ck_account_audit_events__changes_object', 'changes that is a JSON null value (not SQL NULL)', async () =>
    insertAudit(await makeAccount(), 'PROFILE_UPDATED', null, 'null'),
  ),
  bad('ck_account_audit_events__actor', 'an empty actor', async () => insertAudit(await makeAccount(), 'ACCOUNT_CREATED', null, null, '')),
  bad('ck_account_audit_events__actor', 'a blank actor', async () => insertAudit(await makeAccount(), 'ACCOUNT_CREATED', null, null, '   ')),
  bad('ck_account_audit_events__actor', 'a 201-character actor', async () => insertAudit(await makeAccount(), 'ACCOUNT_CREATED', null, null, 'a'.repeat(201))),
];

describe('table constraints reject bad data, by constraint name', () => {
  it.each(CONSTRAINT_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    expect(await constraintOf(attempt())).toBe(constraint);
  });

  it('covers every primary key, unique, foreign key and check constraint of the identity schema (and names no constraint that does not exist)', async () => {
    const catalog = await q<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')`,
    );
    expect(catalog.length).toBe(44);
    expect([...new Set(CONSTRAINT_CASES.map((c) => c.constraint))].sort()).toEqual(catalog.map((r) => r.conname).sort());
  });

  it('accepts the boundary values the checks allow (names of 1 and 50 characters, 50 emoji, locale and time zone by reference, 200-character actors)', async () => {
    const zone = await zoneId('America/Denver');
    await insertProfile(await makeAccount(), 'A', 'M');
    await insertProfile(await makeAccount(), 'a'.repeat(50), 'm'.repeat(50));
    await insertProfile(await makeAccount(), ch(0x1f600).repeat(50), ch(0x1f680).repeat(50));
    await insertProfile(await makeAccount(), "Jean-Luc O'Brien", 'Garc' + ch(0xed) + 'a ' + ch(0xa0) + 'Ruiz', 'en-US', zone);
    const changed = await makeAccount();
    await inTx(async (c) => {
      await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [changed]);
      await c.query(
        'INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [changed, 'ACTIVE', 'SUSPENDED', 'r'.repeat(1000), 'a'.repeat(200), 'test-correlation'],
      );
    });
    await newRole(`X${'A'.repeat(29)}`);
    await newRole('XA');
    const a = await makeAccount();
    await insertIdentity(a, { issuer: `https://${'i'.repeat(504)}`, subject: 's'.repeat(255) });
    expect(await count('identity.external_identities', 'account_id = $1', [a])).toBe(1);
  });
});

// ====================================================================== guards: roles
describe('role guards', () => {
  it('refuses to delete a role, seeded or not (NOT_DELETABLE)', async () => {
    await expectRule(run('DELETE FROM identity.roles WHERE role_id = $1', [CUSTOMER]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM identity.roles WHERE role_id = $1', [(await makeRole()).roleId]), 'NOT_DELETABLE');
    expect(await count('identity.roles', "code IN ('CUSTOMER', 'PROVIDER')")).toBe(2);
  });

  it('keeps role_id, code and created_at immutable (IMMUTABLE_IDENTITY) while the name key, status and updated_at may change', async () => {
    const { roleId, code } = await makeRole();
    await expectRule(run("UPDATE identity.roles SET code = 'RENAMED' WHERE role_id = $1", [roleId]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE identity.roles SET role_id = $2 WHERE role_id = $1', [roleId, randomUUID()]), 'IMMUTABLE_IDENTITY');
    await expectRule(run("UPDATE identity.roles SET created_at = now() - interval '1 day' WHERE role_id = $1", [roleId]), 'IMMUTABLE_IDENTITY');
    await run("UPDATE identity.roles SET name_content_key = 'identity.role.provider.name', updated_at = now() WHERE role_id = $1", [roleId]);
    expect(await q('SELECT code, name_content_key FROM identity.roles WHERE role_id = $1', [roleId])).toEqual([
      { code, name_content_key: 'identity.role.provider.name' },
    ]);
  });

  it('refuses to deactivate a role while an account holds it ACTIVE or PENDING (ROLE_IN_USE) and allows it when nobody does', async () => {
    const { roleId } = await makeRole();
    const holder = await makeAccount();
    const deactivate = () => run("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE role_id = $1", [roleId]);
    await membershipIn(holder, roleId, 'ACTIVE');
    await expectRule(deactivate(), 'ROLE_IN_USE');
    // one INACTIVE holder does not help while another holds it ACTIVE
    const other = await makeAccount();
    await membershipIn(other, roleId, 'INACTIVE');
    await expectRule(deactivate(), 'ROLE_IN_USE');
    await setMembership(holder, roleId, 'INACTIVE');
    await deactivate(); // only INACTIVE memberships remain
    expect(await q('SELECT status FROM identity.roles WHERE role_id = $1', [roleId])).toEqual([{ status: 'INACTIVE' }]);
    // an INACTIVE role can be activated again, with or without holders
    await run("UPDATE identity.roles SET status = 'ACTIVE', updated_at = now() WHERE role_id = $1", [roleId]);
    expect(await q('SELECT status FROM identity.roles WHERE role_id = $1', [roleId])).toEqual([{ status: 'ACTIVE' }]);
  });

  it('counts a PENDING membership as holding the role', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await membershipIn(a, roleId, 'PENDING');
    await expectRule(run("UPDATE identity.roles SET status = 'INACTIVE' WHERE role_id = $1", [roleId]), 'ROLE_IN_USE');
    await setMembership(a, roleId, 'INACTIVE');
    await run("UPDATE identity.roles SET status = 'INACTIVE' WHERE role_id = $1", [roleId]);
  });

  it('allows a role nobody holds to be deactivated, including a seeded one in a rolled-back transaction', async () => {
    const { roleId } = await makeRole();
    await run("UPDATE identity.roles SET status = 'INACTIVE' WHERE role_id = $1", [roleId]);
    await isolated(
      [],
      "UPDATE identity.roles SET status = 'INACTIVE' WHERE code = 'PROVIDER' AND NOT EXISTS (SELECT 1 FROM identity.account_roles WHERE role_id = $1)",
      [PROVIDER],
    );
    expect(await q("SELECT status FROM identity.roles WHERE code = 'PROVIDER'")).toEqual([{ status: 'ACTIVE' }]);
  });
});

// ====================================================================== guards: accounts
const ALLOWED_ACCOUNT_TRANSITIONS: [AccountStatus, AccountStatus][] = [
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
const FORBIDDEN_ACCOUNT_TRANSITIONS: [AccountStatus, AccountStatus][] = [
  ['PENDING', 'SUSPENDED'],
  ['PENDING', 'CLOSURE_REQUESTED'],
  ['ACTIVE', 'PENDING'],
  ['ACTIVE', 'CLOSED'],
  ['SUSPENDED', 'PENDING'],
  ['CLOSURE_REQUESTED', 'PENDING'],
  ['CLOSURE_REQUESTED', 'SUSPENDED'],
];

describe('account guards', () => {
  it('partitions the 20 ordered status pairs into 9 allowed, 7 forbidden and 4 that leave CLOSED', () => {
    const pairs = STATUSES.flatMap((f) => STATUSES.filter((t) => t !== f).map((t) => `${f}>${t}`));
    expect(pairs).toHaveLength(20);
    const covered = [...ALLOWED_ACCOUNT_TRANSITIONS, ...FORBIDDEN_ACCOUNT_TRANSITIONS, ...STATUSES.filter((s) => s !== 'CLOSED').map((s) => ['CLOSED', s])].map(
      ([f, t]) => `${f}>${t}`,
    );
    expect(covered.sort()).toEqual(pairs.sort());
  });

  it('starts only PENDING or ACTIVE and without a primary role (ACCOUNT_INITIAL_STATE)', async () => {
    for (const s of ['SUSPENDED', 'CLOSURE_REQUESTED'])
      await expectRule(run('INSERT INTO identity.accounts (status) VALUES ($1)', [s]), 'ACCOUNT_INITIAL_STATE');
    await expectRule(run("INSERT INTO identity.accounts (status, closed_at) VALUES ('CLOSED', now())"), 'ACCOUNT_INITIAL_STATE');
    await expectRule(run("INSERT INTO identity.accounts (status, primary_role_id) VALUES ('ACTIVE', $1)", [CUSTOMER]), 'ACCOUNT_INITIAL_STATE');
    await expectRule(run("INSERT INTO identity.accounts (status, primary_role_id) VALUES ('PENDING', $1)", [PROVIDER]), 'ACCOUNT_INITIAL_STATE');
    // the two valid initial states (each with its history row)
    expect(await statusOf(await makeAccount('PENDING'))).toBe('PENDING');
    expect(await statusOf(await makeAccount('ACTIVE'))).toBe('ACTIVE');
  });

  it.each(ALLOWED_ACCOUNT_TRANSITIONS)(
    'allows %s -> %s (with its history row in the same transaction), setting closed_at only for CLOSED',
    async (from, to) => {
      const a = await accountIn(from);
      await setStatus(a, to);
      expect(await q('SELECT status, closed_at IS NOT NULL AS closed FROM identity.accounts WHERE account_id = $1', [a])).toEqual([
        { status: to, closed: to === 'CLOSED' },
      ]);
      const last = await q('SELECT from_status, to_status FROM identity.account_status_history WHERE account_id = $1 ORDER BY history_seq DESC LIMIT 1', [a]);
      expect(last).toEqual([{ from_status: from, to_status: to }]);
    },
  );

  it.each(FORBIDDEN_ACCOUNT_TRANSITIONS)('refuses %s -> %s (ACCOUNT_STATUS_TRANSITION) and leaves the account and its history untouched', async (from, to) => {
    const a = await accountIn(from);
    const rows = await count('identity.account_status_history', 'account_id = $1', [a]);
    await expectRule(setStatus(a, to), 'ACCOUNT_STATUS_TRANSITION');
    expect(await statusOf(a)).toBe(from);
    expect(await count('identity.account_status_history', 'account_id = $1', [a])).toBe(rows);
  });

  it.each([...STATUSES])('CLOSED is terminal: CLOSED -> %s is refused (ACCOUNT_CLOSED)', async (to) => {
    const a = await accountIn('CLOSED');
    await expectRule(setStatus(a, to), 'ACCOUNT_CLOSED');
    expect(await statusOf(a)).toBe('CLOSED');
  });

  it('refuses ANY update of a CLOSED account, even one that does not touch the status (ACCOUNT_CLOSED)', async () => {
    const a = await accountIn('CLOSED');
    await expectRule(run('UPDATE identity.accounts SET updated_at = now() WHERE account_id = $1', [a]), 'ACCOUNT_CLOSED');
    await expectRule(run('UPDATE identity.accounts SET primary_role_id = NULL WHERE account_id = $1', [a]), 'ACCOUNT_CLOSED');
    await expectRule(run('UPDATE identity.accounts SET closed_at = NULL WHERE account_id = $1', [a]), 'ACCOUNT_CLOSED');
  });

  it('keeps account_id and created_at immutable (IMMUTABLE_IDENTITY) and allows updated_at on a live account', async () => {
    const a = await makeAccount();
    await expectRule(run('UPDATE identity.accounts SET account_id = $2 WHERE account_id = $1', [a, randomUUID()]), 'IMMUTABLE_IDENTITY');
    await expectRule(run("UPDATE identity.accounts SET created_at = now() - interval '1 day' WHERE account_id = $1", [a]), 'IMMUTABLE_IDENTITY');
    await run('UPDATE identity.accounts SET updated_at = now() WHERE account_id = $1', [a]);
  });

  it('refuses to delete an account (NOT_DELETABLE), whatever its status', async () => {
    for (const s of STATUSES) await expectRule(run('DELETE FROM identity.accounts WHERE account_id = $1', [await accountIn(s)]), 'NOT_DELETABLE');
  });

  it('refuses to close an account that still holds an active role or a primary role (ACCOUNT_HAS_ACTIVE_ROLES) and allows it once both are gone', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, roleId);
    await setPrimary(a, roleId);
    await setStatus(a, 'SUSPENDED');
    await expectRule(setStatus(a, 'CLOSED'), 'ACCOUNT_HAS_ACTIVE_ROLES'); // primary and active membership
    await setPrimary(a, null);
    await expectRule(setStatus(a, 'CLOSED'), 'ACCOUNT_HAS_ACTIVE_ROLES'); // active membership alone
    await setMembership(a, roleId, 'INACTIVE');
    await setStatus(a, 'CLOSED');
    expect(await statusOf(a)).toBe('CLOSED');
    expect(await memberStatusOf(a, roleId)).toBe('INACTIVE');
  });

  it('counts a PENDING membership as an open role for closure', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, roleId, 'PENDING');
    await setStatus(a, 'SUSPENDED');
    await expectRule(setStatus(a, 'CLOSED'), 'ACCOUNT_HAS_ACTIVE_ROLES');
    await setMembership(a, roleId, 'INACTIVE');
    await setStatus(a, 'CLOSED');
  });

  it('lets the primary role name only an ACTIVE membership of the SAME account (PRIMARY_ROLE_NOT_ACTIVE) and clearing it is always allowed', async () => {
    const { roleId: r1 } = await makeRole();
    const { roleId: r2 } = await makeRole();
    const { roleId: r3 } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, r1);
    await addMembership(a, r2, 'PENDING');
    await membershipIn(a, r3, 'INACTIVE');
    const otherAccount = await makeAccount();
    const { roleId: foreign } = await makeRole();
    await addMembership(otherAccount, foreign);
    await expectRule(setPrimary(a, r2), 'PRIMARY_ROLE_NOT_ACTIVE'); // PENDING
    await expectRule(setPrimary(a, r3), 'PRIMARY_ROLE_NOT_ACTIVE'); // INACTIVE
    await expectRule(setPrimary(a, foreign), 'PRIMARY_ROLE_NOT_ACTIVE'); // held by another account only
    await expectRule(setPrimary(a, randomUUID()), 'PRIMARY_ROLE_NOT_ACTIVE'); // no such role
    expect(await primaryOf(a)).toBeNull();
    await setPrimary(a, r1);
    expect(await primaryOf(a)).toBe(r1);
    await setPrimary(a, null);
    expect(await primaryOf(a)).toBeNull();
    await setPrimary(a, null); // clearing an empty primary is a no-op
  });

  it('moves the primary role between ACTIVE memberships of the account and keeps the row consistent', async () => {
    const a = await makeAccount();
    await addMembership(a, CUSTOMER);
    await addMembership(a, PROVIDER);
    await setPrimary(a, CUSTOMER);
    await setPrimary(a, PROVIDER);
    expect(await primaryOf(a)).toBe(PROVIDER);
  });
});

// ====================================================================== guards: memberships
describe('membership guards (account_roles)', () => {
  it('refuses an INACTIVE role at insert, for ACTIVE and PENDING memberships alike (ROLE_NOT_ACTIVE)', async () => {
    const { roleId } = await makeRole('INACTIVE');
    const a = await makeAccount();
    await expectRule(addMembership(a, roleId, 'ACTIVE'), 'ROLE_NOT_ACTIVE');
    await expectRule(addMembership(a, roleId, 'PENDING'), 'ROLE_NOT_ACTIVE');
    expect(await count('identity.account_roles', 'account_id = $1', [a])).toBe(0);
  });

  it('refuses a CLOSED account at insert (ACCOUNT_CLOSED) and accepts every other account status', async () => {
    const { roleId } = await makeRole();
    await expectRule(addMembership(await accountIn('CLOSED'), roleId), 'ACCOUNT_CLOSED');
    await expectRule(addMembership(await accountIn('CLOSED'), roleId, 'PENDING'), 'ACCOUNT_CLOSED');
    for (const s of ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'] as const) {
      const a = await accountIn(s);
      await addMembership(a, roleId);
      expect(await memberStatusOf(a, roleId)).toBe('ACTIVE');
    }
  });

  it('starts only PENDING or ACTIVE (ROLE_STATUS_TRANSITION)', async () => {
    const a = await makeAccount();
    await expectRule(
      run(
        "INSERT INTO identity.account_roles (account_id, role_id, status, deactivated_at, granted_by, grant_source) VALUES ($1, $2, 'INACTIVE', now(), 'test', 'SYSTEM')",
        [a, CUSTOMER],
      ),
      'ROLE_STATUS_TRANSITION',
    );
    expect(await count('identity.account_roles', 'account_id = $1', [a])).toBe(0);
  });

  it.each<[MemberStatus, MemberStatus]>([
    ['PENDING', 'ACTIVE'],
    ['PENDING', 'INACTIVE'],
    ['ACTIVE', 'INACTIVE'],
    ['INACTIVE', 'ACTIVE'],
  ])('allows %s -> %s', async (from, to) => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await membershipIn(a, roleId, from);
    await setMembership(a, roleId, to);
    expect(await memberStatusOf(a, roleId)).toBe(to);
  });

  it.each<[MemberStatus, MemberStatus]>([
    ['ACTIVE', 'PENDING'],
    ['INACTIVE', 'PENDING'],
  ])('refuses %s -> %s (ROLE_STATUS_TRANSITION), so a deactivated membership cannot go back to pending', async (from, to) => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await membershipIn(a, roleId, from);
    await expectRule(setMembership(a, roleId, to), 'ROLE_STATUS_TRANSITION');
    expect(await memberStatusOf(a, roleId)).toBe(from);
  });

  it('lets a membership keep its status while its grant details change', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await membershipIn(a, roleId, 'PENDING');
    await run("UPDATE identity.account_roles SET granted_by = 'someone', grant_source = 'ADMIN', updated_at = now() WHERE account_id = $1 AND role_id = $2", [
      a,
      roleId,
    ]);
    expect(await q('SELECT status, granted_by, grant_source FROM identity.account_roles WHERE account_id = $1', [a])).toEqual([
      { status: 'PENDING', granted_by: 'someone', grant_source: 'ADMIN' },
    ]);
  });

  it('refuses to deactivate the primary membership (PRIMARY_ROLE_IN_USE) until the primary role is moved or cleared', async () => {
    const { roleId: r1 } = await makeRole();
    const { roleId: r2 } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, r1);
    await addMembership(a, r2);
    await setPrimary(a, r1);
    await expectRule(setMembership(a, r1, 'INACTIVE'), 'PRIMARY_ROLE_IN_USE');
    expect(await memberStatusOf(a, r1)).toBe('ACTIVE');
    await setMembership(a, r2, 'INACTIVE'); // not the primary: allowed
    await setPrimary(a, null);
    await setMembership(a, r1, 'INACTIVE');
    expect(await memberStatusOf(a, r1)).toBe('INACTIVE');
  });

  it('refuses to reactivate a membership whose role is INACTIVE (ROLE_NOT_ACTIVE) or whose account is CLOSED (ACCOUNT_CLOSED)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await membershipIn(a, roleId, 'INACTIVE');
    await run("UPDATE identity.roles SET status = 'INACTIVE' WHERE role_id = $1", [roleId]);
    await expectRule(setMembership(a, roleId, 'ACTIVE'), 'ROLE_NOT_ACTIVE');
    await run("UPDATE identity.roles SET status = 'ACTIVE' WHERE role_id = $1", [roleId]);
    await setStatus(a, 'SUSPENDED');
    await setStatus(a, 'CLOSED');
    await expectRule(setMembership(a, roleId, 'ACTIVE'), 'ACCOUNT_CLOSED');
    expect(await memberStatusOf(a, roleId)).toBe('INACTIVE');
  });

  it('keeps the membership identity (account and role) immutable (IMMUTABLE_IDENTITY)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, roleId);
    await expectRule(
      run('UPDATE identity.account_roles SET account_id = $3 WHERE account_id = $1 AND role_id = $2', [a, roleId, await makeAccount()]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(run('UPDATE identity.account_roles SET role_id = $3 WHERE account_id = $1 AND role_id = $2', [a, roleId, CUSTOMER]), 'IMMUTABLE_IDENTITY');
  });

  it('refuses to delete a membership (NOT_DELETABLE), whatever its status', async () => {
    for (const s of ['PENDING', 'ACTIVE', 'INACTIVE'] as const) {
      const { roleId } = await makeRole();
      const a = await makeAccount();
      await membershipIn(a, roleId, s);
      await expectRule(run('DELETE FROM identity.account_roles WHERE account_id = $1', [a]), 'NOT_DELETABLE');
    }
  });

  it('makes a duplicate membership impossible (the primary key), lets two accounts hold one role and one account hold both application roles', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    await addMembership(a, CUSTOMER);
    await addMembership(a, PROVIDER); // one account, both roles
    await addMembership(b, CUSTOMER); // two accounts, one role
    expect(await constraintOf(addMembership(a, CUSTOMER))).toBe('pk_account_roles');
    expect(await constraintOf(addMembership(a, CUSTOMER, 'PENDING'))).toBe('pk_account_roles');
    expect(
      await q('SELECT r.code, m.status FROM identity.account_roles m JOIN identity.roles r USING (role_id) WHERE m.account_id = $1 ORDER BY r.code', [a]),
    ).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'ACTIVE' },
    ]);
    expect(await count('identity.account_roles', 'role_id = $1 AND account_id = ANY($2)', [CUSTOMER, [a, b]])).toBe(2);
  });
});

// ====================================================================== guards: external identities
describe('external identity guards', () => {
  it('links one identity to exactly one account: the same (provider, issuer, subject) cannot be linked twice or to a second account', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    const subject = `one-${uniq()}`;
    await link(a, subject);
    expect(await constraintOf(link(b, subject))).toBe('uq_external_identities__provider_issuer_subject');
    expect(await constraintOf(link(a, subject))).toBe('uq_external_identities__provider_issuer_subject');
    expect(await count('identity.external_identities', 'provider_subject = $1', [subject])).toBe(1);
  });

  it('treats the key verbatim: another issuer, another subject, another case or a trailing space is a different identity', async () => {
    const subject = `case-${uniq()}`;
    const a = await makeAccount();
    await link(a, subject);
    await link(await makeAccount(), subject, 'https://other.example/realms/x');
    await link(await makeAccount(), subject.toUpperCase());
    await link(await makeAccount(), `${subject} `);
    await link(await makeAccount(), `${subject}2`);
    expect(
      await count('identity.external_identities', 'lower(btrim(provider_subject)) = $1 OR provider_subject = $2', [subject.toLowerCase(), `${subject}2`]),
    ).toBe(5);
  });

  it('lets one account hold several identities (no unique key on account_id: social federation and a second login arrive as new links)', async () => {
    const a = await makeAccount();
    await link(a);
    await link(a);
    expect(await count('identity.external_identities', 'account_id = $1', [a])).toBe(2);
  });

  it('allows only last_seen_at to change (IMMUTABLE_IDENTITY for every other column, so an identity can never be re-pointed)', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    const id = await link(a);
    await run("UPDATE identity.external_identities SET last_seen_at = now() + interval '1 minute' WHERE external_identity_id = $1", [id]);
    const changes: [string, unknown][] = [
      ['account_id', b],
      ['provider_type', 'KEYCLOAK'],
      ['issuer', 'https://elsewhere.example'],
      ['provider_subject', 'someone-else'],
      ['created_at', new Date(0)],
      ['external_identity_id', randomUUID()],
    ];
    for (const [column, value] of changes) {
      // provider_type is set to the SAME value in a statement that also changes the subject, so the guard (not a check) reports it
      const set = column === 'provider_type' ? "provider_type = 'KEYCLOAK', provider_subject = 'x-changed'" : `${column} = $2`;
      const params = column === 'provider_type' ? [id] : [id, value];
      await expectRule(run(`UPDATE identity.external_identities SET ${set} WHERE external_identity_id = $1`, params), 'IMMUTABLE_IDENTITY');
    }
    expect(await q('SELECT account_id FROM identity.external_identities WHERE external_identity_id = $1', [id])).toEqual([{ account_id: a }]);
  });

  it('refuses to delete an identity link (NOT_DELETABLE)', async () => {
    const id = await link(await makeAccount());
    await expectRule(run('DELETE FROM identity.external_identities WHERE external_identity_id = $1', [id]), 'NOT_DELETABLE');
  });

  it('refuses a link to a CLOSED account (ACCOUNT_CLOSED) but still lets a closed account identity be seen (last_seen_at)', async () => {
    const a = await makeAccount();
    const id = await link(a);
    await setStatus(a, 'SUSPENDED');
    await setStatus(a, 'CLOSED');
    await expectRule(link(a), 'ACCOUNT_CLOSED');
    await run('UPDATE identity.external_identities SET last_seen_at = now() WHERE external_identity_id = $1', [id]);
    // every live status accepts a link
    for (const s of ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED'] as const) await link(await accountIn(s));
  });
});

// ====================================================================== guards: profiles
describe('profile guards', () => {
  it('keeps a profile one-to-one with its account (the account_id key)', async () => {
    const a = await makeAccount();
    await insertProfile(a);
    expect(await constraintOf(insertProfile(a, 'Bo', 'Li'))).toBe('pk_account_profiles');
    expect(await count('identity.account_profiles', 'account_id = $1', [a])).toBe(1);
  });

  it('refuses a profile for a CLOSED account (ACCOUNT_CLOSED) and refuses to change one once its account is CLOSED', async () => {
    await expectRule(insertProfile(await accountIn('CLOSED')), 'ACCOUNT_CLOSED');
    const a = await makeAccount();
    await insertProfile(a);
    await run("UPDATE identity.account_profiles SET first_name = 'Bo', updated_at = now() WHERE account_id = $1", [a]);
    await setStatus(a, 'SUSPENDED');
    await run("UPDATE identity.account_profiles SET first_name = 'Cy', updated_at = now() WHERE account_id = $1", [a]); // suspended accounts are not CLOSED
    await setStatus(a, 'CLOSED');
    await expectRule(run("UPDATE identity.account_profiles SET first_name = 'Di' WHERE account_id = $1", [a]), 'ACCOUNT_CLOSED');
    expect(await q('SELECT first_name FROM identity.account_profiles WHERE account_id = $1', [a])).toEqual([{ first_name: 'Cy' }]);
  });

  it('refuses to delete a profile (NOT_DELETABLE) and keeps account_id and created_at immutable (IMMUTABLE_IDENTITY)', async () => {
    const a = await makeAccount();
    await insertProfile(a);
    await expectRule(run('DELETE FROM identity.account_profiles WHERE account_id = $1', [a]), 'NOT_DELETABLE');
    await expectRule(run('UPDATE identity.account_profiles SET account_id = $2 WHERE account_id = $1', [a, await makeAccount()]), 'IMMUTABLE_IDENTITY');
    await expectRule(run("UPDATE identity.account_profiles SET created_at = now() - interval '1 day' WHERE account_id = $1", [a]), 'IMMUTABLE_IDENTITY');
  });

  it('stores the locale and the time zone by reference (content.locales and geography.time_zones)', async () => {
    const a = await makeAccount();
    const zone = await zoneId('America/Chicago');
    await insertProfile(a, 'Ana', 'Martin', 'en-US', zone);
    expect(
      await q(
        'SELECT p.preferred_locale, z.iana_name FROM identity.account_profiles p JOIN geography.time_zones z ON z.time_zone_id = p.time_zone_id WHERE p.account_id = $1',
        [a],
      ),
    ).toEqual([{ preferred_locale: 'en-US', iana_name: 'America/Chicago' }]);
    await run('UPDATE identity.account_profiles SET preferred_locale = NULL, time_zone_id = NULL, updated_at = now() WHERE account_id = $1', [a]);
    expect(await q('SELECT preferred_locale, time_zone_id FROM identity.account_profiles WHERE account_id = $1', [a])).toEqual([
      { preferred_locale: null, time_zone_id: null },
    ]);
  });
});

// ====================================================================== immutable history and audit
describe('append-only tables', () => {
  it('refuses UPDATE and DELETE on every column of the status history (ROW_IMMUTABLE)', async () => {
    const a = await makeAccount();
    const id = (await q<{ status_history_id: string }>('SELECT status_history_id FROM identity.account_status_history WHERE account_id = $1', [a]))[0]!
      .status_history_id;
    const updates = [
      "reason = 'edited'",
      "actor = 'someone'",
      "to_status = 'SUSPENDED'",
      "from_status = 'ACTIVE'",
      "correlation_id = 'x'",
      'occurred_at = now()',
      `account_id = '${randomUUID()}'`,
      `status_history_id = '${randomUUID()}'`,
    ];
    for (const set of updates) await expectRule(run(`UPDATE identity.account_status_history SET ${set} WHERE status_history_id = $1`, [id]), 'ROW_IMMUTABLE');
    await expectRule(run('UPDATE identity.account_status_history SET reason = reason WHERE account_id = $1', [a]), 'ROW_IMMUTABLE'); // even a no-op rewrite
    await expectRule(run('DELETE FROM identity.account_status_history WHERE status_history_id = $1', [id]), 'ROW_IMMUTABLE');
    expect(await q('SELECT from_status, to_status, actor FROM identity.account_status_history WHERE status_history_id = $1', [id])).toEqual([
      { from_status: null, to_status: 'ACTIVE', actor: 'test' },
    ]);
  });

  it('refuses UPDATE and DELETE on every column of the audit trail (ROW_IMMUTABLE)', async () => {
    const a = await makeAccount();
    const id = await insertAudit(a, 'ROLE_GRANTED', CUSTOMER, '{"status":[null,"ACTIVE"]}');
    const updates = [
      "actor = 'someone'",
      "action = 'ACCOUNT_CREATED'",
      'role_id = NULL',
      "changes = '{}'::jsonb",
      "reason = 'edited'",
      "correlation_id = 'x'",
      'occurred_at = now()',
    ];
    for (const set of updates) await expectRule(run(`UPDATE identity.account_audit_events SET ${set} WHERE audit_event_id = $1`, [id]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM identity.account_audit_events WHERE audit_event_id = $1', [id]), 'ROW_IMMUTABLE');
    expect(await q('SELECT action, changes FROM identity.account_audit_events WHERE audit_event_id = $1', [id])).toEqual([
      { action: 'ROLE_GRANTED', changes: { status: [null, 'ACTIVE'] } },
    ]);
  });

  it('refuses a bulk UPDATE or DELETE across all rows too', async () => {
    await makeAccount();
    await expectRule(run("UPDATE identity.account_status_history SET actor = 'x'"), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM identity.account_status_history'), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM identity.account_audit_events'), 'ROW_IMMUTABLE');
  });
});

// ====================================================================== deferred status history trigger
describe('status history is checked at COMMIT (deferred constraint trigger)', () => {
  it('fails an account insert without a history row at COMMIT, and leaves nothing behind', async () => {
    const before = await count('identity.accounts');
    await expectRule(
      inTx(async (c) => {
        await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE')");
      }),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await count('identity.accounts')).toBe(before);
  });

  it('succeeds when the history row is written in the same transaction (both initial states)', async () => {
    for (const s of ['PENDING', 'ACTIVE'] as const) {
      const a = await makeAccount(s);
      expect(await q('SELECT from_status, to_status, actor FROM identity.account_status_history WHERE account_id = $1', [a])).toEqual([
        { from_status: null, to_status: s, actor: 'test' },
      ]);
    }
  });

  it('fails a status update without a matching history row at COMMIT, and the status stays what it was', async () => {
    const a = await makeAccount();
    await expectRule(
      inTx((c) => c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [a])),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await statusOf(a)).toBe('ACTIVE');
    expect(await count('identity.account_status_history', 'account_id = $1', [a])).toBe(1);
  });

  it('succeeds when the status update and its history row are in one transaction', async () => {
    const a = await makeAccount();
    await setStatus(a, 'SUSPENDED');
    expect(await statusOf(a)).toBe('SUSPENDED');
  });

  it('fails when the newest history row names another status than the account, or belongs to another account', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    await expectRule(
      inTx(async (c) => {
        await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [a]);
        await historyRow(c, a, 'ACTIVE', 'CLOSURE_REQUESTED');
      }),
      'STATUS_HISTORY_MISMATCH',
    );
    await expectRule(
      inTx(async (c) => {
        await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [a]);
        await historyRow(c, b, 'ACTIVE', 'SUSPENDED');
      }),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await statusOf(a)).toBe('ACTIVE');
    expect(await statusOf(b)).toBe('ACTIVE');
  });

  it('does not require a history row for an update that does not touch the status', async () => {
    const a = await makeAccount();
    await inTx((c) => c.query('UPDATE identity.accounts SET updated_at = now() WHERE account_id = $1', [a]));
  });

  it('can be forced early with SET CONSTRAINTS ... IMMEDIATE (the error then surfaces at that statement, not at COMMIT)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE')");
      const e = (await rejection(c.query('SET CONSTRAINTS identity.trg_accounts__status_history IMMEDIATE'))) as PgFailure | undefined;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:STATUS_HISTORY_MISMATCH' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('orders history rows by history_seq inside one transaction: rows written in order pass, the same rows written out of order fail', async () => {
    const createWithTwoRows = (order: 'in-order' | 'out-of-order') =>
      inTx(async (c) => {
        const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0].account_id as string;
        if (order === 'in-order') {
          await historyRow(c, id, null, 'PENDING');
          await historyRow(c, id, 'PENDING', 'ACTIVE');
        } else {
          await historyRow(c, id, 'PENDING', 'ACTIVE');
          await historyRow(c, id, null, 'PENDING');
        }
        return id;
      });
    const a = await createWithTwoRows('in-order');
    const rows = await q<{ history_seq: string; to_status: string; occurred_at: Date }>(
      'SELECT history_seq, to_status, occurred_at FROM identity.account_status_history WHERE account_id = $1 ORDER BY history_seq',
      [a],
    );
    expect(rows.map((r) => r.to_status)).toEqual(['PENDING', 'ACTIVE']);
    expect(BigInt(rows[1]!.history_seq) > BigInt(rows[0]!.history_seq)).toBe(true);
    expect(rows[1]!.occurred_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.occurred_at.getTime());
    // same account status, same rows, but the newest row (by history_seq) is now PENDING
    await expectRule(createWithTwoRows('out-of-order'), 'STATUS_HISTORY_MISMATCH');
  });

  it('judges the newest row at COMMIT: a stale last row fails', async () => {
    const a = await makeAccount();
    await expectRule(
      inTx(async (c) => {
        // the status stays ACTIVE, but the last row written says SUSPENDED
        await c.query("UPDATE identity.accounts SET status = 'ACTIVE', updated_at = now() WHERE account_id = $1", [a]);
        await historyRow(c, a, 'ACTIVE', 'SUSPENDED');
      }),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await statusOf(a)).toBe('ACTIVE');
  });

  // The deferred trigger compares the newest history row with the CURRENT account row at commit (it first compared with NEW of each queued event, which
  // refused a transaction that passes through a transient status; found by this test and fixed in migration 0009).
  it('refuses a stray history row that no status change explains, at COMMIT (the history trigger, not only the account trigger)', async () => {
    const a = await makeAccount();
    // the account stays ACTIVE and the new row says ACTIVE -> SUSPENDED: it neither continues the history to the current status nor matches it
    await expectRule(
      inTx((c) => historyRow(c, a, 'ACTIVE', 'SUSPENDED')),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await count('identity.account_status_history', 'account_id = $1', [a])).toBe(1);
  });

  it('refuses a history row whose from_status does not continue the previous row (a gap in the history), at COMMIT', async () => {
    const a = await makeAccount();
    await expectRule(
      inTx(async (c) => {
        await c.query("UPDATE identity.accounts SET status = 'CLOSURE_REQUESTED', updated_at = now() WHERE account_id = $1", [a]);
        // the previous row ended in ACTIVE, so this row cannot start from SUSPENDED
        await historyRow(c, a, 'SUSPENDED', 'CLOSURE_REQUESTED');
      }),
      'STATUS_HISTORY_MISMATCH',
    );
    expect(await statusOf(a)).toBe('ACTIVE');
  });

  it('accepts a transaction that passes through a transient status when the final status equals the newest history row', async () => {
    const a = await makeAccount();
    await inTx(async (c) => {
      await c.query("UPDATE identity.accounts SET status = 'SUSPENDED', updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(c, a, 'ACTIVE', 'SUSPENDED');
      await c.query("UPDATE identity.accounts SET status = 'ACTIVE', updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(c, a, 'SUSPENDED', 'ACTIVE');
    });
    expect(await statusOf(a)).toBe('ACTIVE');
  });
});

// ====================================================================== database-level races (the guards alone, without the service)
describe('guards under concurrency (two real transactions)', () => {
  it('a primary role change that commits first makes the concurrent deactivation of that membership fail (PRIMARY_ROLE_IN_USE)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, roleId);
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query('UPDATE identity.accounts SET primary_role_id = $2, updated_at = now() WHERE account_id = $1', [a, roleId]);
      const second = rejection(setMembership(a, roleId, 'INACTIVE'));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:PRIMARY_ROLE_IN_USE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await memberStatusOf(a, roleId)).toBe('ACTIVE');
    expect(await primaryOf(a)).toBe(roleId);
  });

  it('a deactivation that commits first makes the concurrent primary role change fail (PRIMARY_ROLE_NOT_ACTIVE)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    await addMembership(a, roleId);
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE identity.account_roles SET status = 'INACTIVE', deactivated_at = now() WHERE account_id = $1 AND role_id = $2", [a, roleId]);
      const second = rejection(setPrimary(a, roleId));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:PRIMARY_ROLE_NOT_ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await memberStatusOf(a, roleId)).toBe('INACTIVE');
    expect(await primaryOf(a)).toBeNull();
  });

  it('closing an account that commits first makes a concurrent role grant fail (ACCOUNT_CLOSED)', async () => {
    const { roleId } = await makeRole();
    const a = await accountIn('SUSPENDED');
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE identity.accounts SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE account_id = $1", [a]);
      await historyRow(t1, a, 'SUSPENDED', 'CLOSED');
      const second = rejection(addMembership(a, roleId));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_CLOSED' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await count('identity.account_roles', 'account_id = $1', [a])).toBe(0);
  });

  it('a role grant that commits first makes a concurrent closure fail (ACCOUNT_HAS_ACTIVE_ROLES)', async () => {
    const { roleId } = await makeRole();
    const a = await accountIn('SUSPENDED');
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query(
        "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), 'test', 'SYSTEM')",
        [a, roleId],
      );
      const second = rejection(setStatus(a, 'CLOSED'));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ACCOUNT_HAS_ACTIVE_ROLES' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await statusOf(a)).toBe('SUSPENDED');
    expect(await memberStatusOf(a, roleId)).toBe('ACTIVE');
  });

  it('a role deactivation that commits first makes a concurrent grant of that role fail (ROLE_NOT_ACTIVE)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE role_id = $1", [roleId]);
      const second = rejection(addMembership(a, roleId));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ROLE_NOT_ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await count('identity.account_roles', 'account_id = $1', [a])).toBe(0);
  });

  it('a grant that commits first makes a concurrent role deactivation fail (ROLE_IN_USE)', async () => {
    const { roleId } = await makeRole();
    const a = await makeAccount();
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query(
        "INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) VALUES ($1, $2, 'ACTIVE', now(), 'test', 'SYSTEM')",
        [a, roleId],
      );
      const second = rejection(run("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE role_id = $1", [roleId]));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, detail: e?.detail }).toEqual({ code: '23000', detail: 'identity_rule:ROLE_IN_USE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await q('SELECT status FROM identity.roles WHERE role_id = $1', [roleId])).toEqual([{ status: 'ACTIVE' }]);
  });

  it('two sessions linking the same identity: the second fails with the unique key once the first commits', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    const subject = `race-${uniq()}`;
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject) VALUES ($1, 'KEYCLOAK', $2, $3)", [
        a,
        ISSUER,
        subject,
      ]);
      const second = rejection(link(b, subject));
      await lockWaiters(1);
      await t1.query('COMMIT');
      const e = (await second) as PgFailure;
      expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23505', constraint: 'uq_external_identities__provider_issuer_subject' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
    }
    expect(await q('SELECT account_id FROM identity.external_identities WHERE provider_subject = $1', [subject])).toEqual([{ account_id: a }]);
  });

  it('a losing account creation rolls back with its link, leaving no orphan account (account, history and link are one transaction)', async () => {
    const owner = await makeAccount();
    const subject = `orphan-${uniq()}`;
    await link(owner, subject);
    const accountsBefore = await count('identity.accounts');
    const historyBefore = await count('identity.account_status_history');
    const e = await fail(
      inTx(async (c) => {
        const r = await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id");
        const id = r.rows[0].account_id as string;
        await historyRow(c, id, null, 'ACTIVE');
        await c.query("INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject) VALUES ($1, 'KEYCLOAK', $2, $3)", [
          id,
          ISSUER,
          subject,
        ]);
      }),
    );
    expect(e.constraint).toBe('uq_external_identities__provider_issuer_subject');
    expect(await count('identity.accounts')).toBe(accountsBefore);
    expect(await count('identity.account_status_history')).toBe(historyBefore);
    expect(await count('identity.external_identities', 'provider_subject = $1', [subject])).toBe(1);
  });
});

// ====================================================================== shape of the schema
const EXPECTED_COLUMNS: Record<string, string[]> = {
  account_audit_events: ['audit_event_id', 'occurred_at', 'actor', 'action', 'account_id', 'role_id', 'changes', 'reason', 'correlation_id'],
  account_profiles: ['account_id', 'first_name', 'last_name', 'preferred_locale', 'time_zone_id', 'created_at', 'updated_at'],
  account_roles: ['account_id', 'role_id', 'status', 'granted_at', 'activated_at', 'deactivated_at', 'granted_by', 'grant_source', 'updated_at'],
  account_status_history: ['status_history_id', 'history_seq', 'account_id', 'from_status', 'to_status', 'reason', 'actor', 'occurred_at', 'correlation_id'],
  accounts: ['account_id', 'status', 'primary_role_id', 'created_at', 'updated_at', 'closed_at'],
  external_identities: ['external_identity_id', 'account_id', 'provider_type', 'issuer', 'provider_subject', 'created_at', 'last_seen_at'],
  roles: ['role_id', 'code', 'name_content_key', 'status', 'created_at', 'updated_at'],
};
const schemaColumns = async (): Promise<{ table_name: string; column_name: string; data_type: string }[]> =>
  q("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'identity' ORDER BY table_name, ordinal_position");

describe('schema shape: Keycloak owns credentials, contacts and addresses are later checkpoints, nothing is country-specific', () => {
  it('has exactly the documented columns on every table', async () => {
    const byTable: Record<string, string[]> = {};
    for (const c of await schemaColumns()) (byTable[c.table_name] ??= []).push(c.column_name);
    expect(byTable).toEqual(EXPECTED_COLUMNS);
  });

  it('has no column named like a credential, token, password, MFA factor, secret, session, email, phone or address', async () => {
    const forbidden =
      /(credential|passw|secret|token|mfa|otp|totp|session|cookie|jwt|api_?key|private_?key|hash|salt|email|phone|mobile|address|street|city|postal|zip)/i;
    const offenders = (await schemaColumns()).filter((c) => forbidden.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
    expect(offenders).toEqual([]);
  });

  it('has no column typed like a stored secret or contact (only uuid, text, timestamptz, bigint and jsonb)', async () => {
    const types = [...new Set((await schemaColumns()).map((c) => c.data_type))].sort();
    expect(types).toEqual(['bigint', 'jsonb', 'text', 'timestamp with time zone', 'uuid']);
  });

  it('has no country-, currency- or US-specific column (and no column holds a state, ZIP, SSN or dialing code)', async () => {
    const usSpecific = /(country|currency|iso_|(^|_)us(_|$)|usa|dialing|fips|ssn|zip|postal|state_code|(^|_)state(_|$)|region)/i;
    const offenders = (await schemaColumns()).filter((c) => usSpecific.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
    expect(offenders).toEqual([]);
  });

  it('stores the Keycloak subject only in external_identities, never on the account', async () => {
    const holders = (await schemaColumns()).filter((c) => /subject|sub$|keycloak/i.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
    expect(holders).toEqual(['external_identities.provider_subject']);
  });

  it('documents the personal-data tables in the catalog (table comments exist for all seven tables)', async () => {
    const rows = await q<{ relname: string; comment: string | null }>(
      "SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'r'",
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(TABLES);
    for (const r of rows) expect(r.comment, r.relname).toBeTruthy();
  });
});
