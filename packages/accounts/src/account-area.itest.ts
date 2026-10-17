// Integration tests of the account area registry reader (ACC-001): the real AccountAreaService over a real, freshly migrated PostgreSQL database (migration 0014 with its
// seeded section matrix and guard triggers). Every behaviour is asserted against the rows the registry holds.
//
// Three databases keep the tests honest and independent: `iso` is only READ (the seeded lists, the query budget, the access path and the concurrency checks), `work`
// is the registry the role-driven scenarios change (a section only the PROVIDER sees, a reorder, a retirement; every scenario restores the seeded state), and
// `corrupt` is a scratch copy in which a CHECK constraint is dropped so that a registry the database would never accept can be offered to the service.
//
// Defence in depth: the guards of migration 0014 make some states impossible (an enabled row of a section that is not ACTIVE). The service still filters on the section
// status and on the role status itself, so those states are CRAFTED by disabling the user triggers in a committed transaction (as the table owner, in these test
// databases only) and the service must still not offer the section. A filter that only the guards enforce would pass every other test.
//
// Races are real (parallel service calls on separate pool connections while another connection flips a row). The statement count of every call is read from the
// `onQuery` hook of the Database the service uses.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountSectionDto } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { createIsolatedDatabase, createTestPool, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { AccountAreaService } from './account-area';
import { AccountError } from './errors';

// ---------------------------------------------------------------- environments
type Pool = ReturnType<typeof createTestPool>;
/** A dedicated connection of the test pool (the overload without a callback). */
const acquire = (e: { pool: Pool }) => e.pool.connect();
type Client = Awaited<ReturnType<typeof acquire>>;
interface Env {
  iso: IsolatedDatabase;
  db: Database;
  pool: Pool;
  service: AccountAreaService;
  /** Every statement the service sent through its Database, in order. */
  statements: { sql: string }[];
}
async function buildEnv(): Promise<Env> {
  const iso = await createIsolatedDatabase();
  const statements: { sql: string }[] = [];
  // the `tests` pool policy holds 5 connections; the races below keep 30 reads in flight
  const db = createDatabase(iso.url, {
    role: 'tests',
    overrides: { poolMax: 40, connectionTimeoutMs: 30_000 },
    onQuery: (e) => statements.push({ sql: e.sql }),
  });
  return { iso, db, pool: createTestPool(iso.url, 10), service: new AccountAreaService({ database: db }), statements };
}
async function closeEnv(e: Env | undefined): Promise<void> {
  await e?.db.close();
  await e?.pool.end();
  await e?.iso.drop();
}
let reading: Env; // only read
let work: Env; // changed by the role-driven scenarios, restored after each
let corrupt: Env; // a CHECK constraint is dropped here
beforeAll(async () => {
  [reading, work, corrupt] = await Promise.all([buildEnv(), buildEnv(), buildEnv()]);
});
afterAll(async () => {
  await Promise.all([closeEnv(reading), closeEnv(work), closeEnv(corrupt)]);
});

// ---------------------------------------------------------------- expectations
const SIX = ['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES'] as const;
const ROUTES: Record<string, string> = {
  PROFILE: '/account/profile',
  CONTACT_VERIFICATION: '/account/contact',
  SECURITY: '/account/security',
  LANGUAGE_REGION: '/account/language-region',
  PRIVACY_DATA: '/account/privacy',
  ROLES: '/account/roles',
};
const LABELS: Record<string, string> = {
  PROFILE: 'account.area.section.profile',
  CONTACT_VERIFICATION: 'account.area.section.contact_verification',
  SECURITY: 'account.area.section.security',
  LANGUAGE_REGION: 'account.area.section.language_region',
  PRIVACY_DATA: 'account.area.section.privacy_data',
  ROLES: 'account.area.section.roles',
};
const seededSection = (code: string): AccountSectionDto => ({
  code,
  route: ROUTES[code]!,
  labelContentKey: `${LABELS[code]}.label`,
  descriptionContentKey: `${LABELS[code]}.description`,
});
const SEEDED_LIST: AccountSectionDto[] = SIX.map(seededSection);
const codes = (sections: AccountSectionDto[]): string[] => sections.map((s) => s.code);

// ---------------------------------------------------------------- fixtures
const q = async <T = Record<string, unknown>>(e: Env, text: string, params: unknown[] = []): Promise<T[]> => (await e.pool.query(text, params)).rows as T[];
const roleIdOf = async (e: Env, code: string): Promise<string> =>
  (await q<{ role_id: string }>(e, 'SELECT role_id FROM identity.roles WHERE code = $1', [code]))[0]!.role_id;
const KEY = 'account.area.section.profile.label';
let seq = 0;
/** Adds a section and one matrix row per role (disabled unless a role is listed). Test sections use positions in 100..9000 and never a seeded position. */
async function addSection(
  e: Env,
  o: {
    code?: string;
    status?: string;
    enabledFor?: Partial<Record<'CUSTOMER' | 'PROVIDER', number>>;
    disabled?: Partial<Record<'CUSTOMER' | 'PROVIDER', number>>;
  },
): Promise<string> {
  const n = ++seq;
  const code = o.code ?? `PROVIDER_ONLY_TEST_${n}`;
  await e.pool.query(
    'INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES ($1, $2, $3, NULL, $4)',
    [code, `/account/test-${n}-${code.toLowerCase().replace(/_/g, '-')}`.slice(0, 48), KEY, o.status ?? 'ACTIVE'],
  );
  for (const [role, order] of Object.entries(o.enabledFor ?? {}))
    await e.pool.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
      code,
      await roleIdOf(e, role),
      order,
    ]);
  for (const [role, order] of Object.entries(o.disabled ?? {}))
    await e.pool.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, false, $3)', [
      code,
      await roleIdOf(e, role),
      order,
    ]);
  return code;
}
let posSeq = 1000;
/** A position no other test section uses (rows are never deleted, so a position that a test took stays taken). */
const nextPos = (): number => ++posSeq;
const SEEDED_MENU: [string, boolean, number][] = [
  ['PROFILE', true, 10],
  ['CONTACT_VERIFICATION', true, 20],
  ['SECURITY', true, 30],
  ['LANGUAGE_REGION', true, 40],
  ['PRIVACY_DATA', true, 50],
  ['ROLES', true, 60],
  ['NOTIFICATIONS', false, 70],
  ['CLOSE_ACCOUNT', false, 80],
];
/**
 * Puts the registry back to the seeded state: roles ACTIVE, the triggers back on, test sections switched off and retired, seeded sections ACTIVE/PLANNED with the seeded
 * flags and positions (two phases through the free positions 9001..9008 so that no intermediate state breaks the unique key). Rows the tests added stay (rows are never
 * deleted) but nothing shows them, and they keep clear of the positions 10..80 and 9001..9008.
 */
async function restore(e: Env): Promise<void> {
  const c = await acquire(e);
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE identity.account_sections ENABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.account_section_roles ENABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.roles ENABLE TRIGGER USER');
    await c.query("UPDATE identity.roles SET status = 'ACTIVE', updated_at = now() WHERE status <> 'ACTIVE'");
    const seeded = SEEDED_MENU.map(([code]) => code);
    await c.query('UPDATE identity.account_section_roles SET enabled = false WHERE NOT (section_code = ANY($1::text[]))', [seeded]);
    await c.query('UPDATE identity.account_section_roles SET enabled = false WHERE section_code = ANY($1::text[])', [seeded]);
    await c.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE NOT (section_code = ANY($1::text[])) AND status <> 'INACTIVE'", [seeded]);
    for (const [code, , order] of SEEDED_MENU)
      await c.query('UPDATE identity.account_section_roles SET display_order = $2 WHERE section_code = $1', [code, 9000 + order / 10]);
    for (const [code, enabled, order] of SEEDED_MENU) {
      await c.query('UPDATE identity.account_sections SET status = $2 WHERE section_code = $1', [code, enabled ? 'ACTIVE' : 'PLANNED']);
      await c.query('UPDATE identity.account_section_roles SET display_order = $2, enabled = $3 WHERE section_code = $1', [code, order, enabled]);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
/** Runs statements with the user triggers of both registry tables off, committed (so another connection sees the crafted state) and back on afterwards. */
async function withoutGuards<T>(e: Env, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await acquire(e);
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE identity.account_sections DISABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.account_section_roles DISABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.roles DISABLE TRIGGER USER');
    const r = await fn(c);
    await c.query('ALTER TABLE identity.account_sections ENABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.account_section_roles ENABLE TRIGGER USER');
    await c.query('ALTER TABLE identity.roles ENABLE TRIGGER USER');
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
/** Counts the statements the service sends while `fn` runs. */
async function counting<T>(e: Env, fn: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const before = e.statements.length;
  const result = await fn();
  return { result, statements: e.statements.slice(before).map((s) => s.sql) };
}
const fails = async (p: Promise<unknown>): Promise<AccountError> => {
  const err = await rejection(p);
  expect(err, 'the call was expected to be rejected').toBeInstanceOf(AccountError);
  return err as AccountError;
};

// ====================================================================== the seeded registry
describe('sectionsOf: the seeded registry', () => {
  it('gives CUSTOMER exactly the six shared sections in menu order, with route and content keys', async () => {
    expect(await reading.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST);
  });

  it('gives PROVIDER exactly the same six shared sections today (no role-specific capability exists yet)', async () => {
    expect(await reading.service.sectionsOf('PROVIDER')).toEqual(SEEDED_LIST);
  });

  it('never offers a PLANNED section (NOTIFICATIONS, CLOSE_ACCOUNT) to any role: the two are switched off and not ACTIVE', async () => {
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      const found = codes(await reading.service.sectionsOf(role));
      expect(found).not.toContain('NOTIFICATIONS');
      expect(found).not.toContain('CLOSE_ACCOUNT');
      expect(found).toHaveLength(6);
    }
  });

  it('answers [] for a null role without sending a statement', async () => {
    const { result, statements } = await counting(reading, () => reading.service.sectionsOf(null));
    expect(result).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('answers [] for a role the registry does not know, for the role in another case and for the empty string (a role code is matched exactly)', async () => {
    for (const role of ['ADMIN', 'customer', 'Customer', 'PROVIDER ', ' PROVIDER', '', 'CUSTOMER\n', 'CUSTOMER%', 'CUST%', '%', '_USTOMER', 'C'.repeat(5000)]) {
      expect(await reading.service.sectionsOf(role), JSON.stringify(role.slice(0, 20))).toEqual([]);
    }
  });

  it('treats an injection-looking role as plain data: [] back, the tables and the roles untouched, the answer for a real role unchanged', async () => {
    const before = {
      roles: await q(reading, 'SELECT code, status FROM identity.roles ORDER BY code'),
      matrix: (await q<{ n: number }>(reading, 'SELECT count(*)::int AS n FROM identity.account_section_roles'))[0]!.n,
      sections: (await q<{ n: number }>(reading, 'SELECT count(*)::int AS n FROM identity.account_sections'))[0]!.n,
    };
    const hostile = [
      "CUSTOMER' OR '1'='1",
      "' OR 1=1 --",
      "CUSTOMER'; DROP TABLE identity.account_section_roles; --",
      "CUSTOMER'; UPDATE identity.account_section_roles SET enabled = false; --",
      '$1',
      'CUSTOMER" OR "1"="1',
      "CUSTOMER') UNION SELECT section_code, route_path, label_content_key, description_content_key FROM identity.account_sections --",
    ];
    for (const role of hostile) expect(await reading.service.sectionsOf(role), role).toEqual([]);
    expect(await reading.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST);
    expect({
      roles: await q(reading, 'SELECT code, status FROM identity.roles ORDER BY code'),
      matrix: (await q<{ n: number }>(reading, 'SELECT count(*)::int AS n FROM identity.account_section_roles'))[0]!.n,
      sections: (await q<{ n: number }>(reading, 'SELECT count(*)::int AS n FROM identity.account_sections'))[0]!.n,
    }).toEqual(before);
  });

  it('refuses a role string the database cannot store (a NUL character) with a typed error that does not carry the driver text', async () => {
    const err = await rejection(reading.service.sectionsOf(`CUSTOMER${String.fromCharCode(0)}x`));
    expect(err).toBeInstanceOf(AccountError);
    expect((err as AccountError).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify([(err as AccountError).message, (err as AccountError).details])).not.toMatch(/byte sequence|0x00|encoding/i);
  });

  it('returns plain objects with exactly four keys, no database id, no status and no timestamp', async () => {
    for (const s of await reading.service.sectionsOf('CUSTOMER')) {
      expect(Object.keys(s).sort()).toEqual(['code', 'descriptionContentKey', 'labelContentKey', 'route']);
      expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    }
  });
});

describe('the query budget: exactly ONE statement per call', () => {
  it('sectionsOf sends exactly one statement for a real role, the same one for an unknown role, and none for a null role', async () => {
    const real = await counting(reading, () => reading.service.sectionsOf('CUSTOMER'));
    expect(real.statements).toHaveLength(1);
    const unknown = await counting(reading, () => reading.service.sectionsOf('ADMIN'));
    expect(unknown.statements).toEqual(real.statements);
    expect((await counting(reading, () => reading.service.sectionsOf(null))).statements).toEqual([]);
  });

  it('navigation sends exactly one statement however many sections and roles there are, and none for a null active role', async () => {
    const roles = [
      { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' },
      { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' },
    ];
    const contacts = { emailVerified: true, phoneVerified: true, contactsVerified: true };
    const withRole = await counting(reading, () => reading.service.navigation({ activeRole: 'PROVIDER', roles, contacts }));
    expect(withRole.statements).toHaveLength(1);
    expect(withRole.result).toEqual({ activeRole: 'PROVIDER', roles, sections: SEEDED_LIST, contacts });
    const none = await counting(reading, () => reading.service.navigation({ activeRole: null, roles, contacts }));
    expect(none.statements).toEqual([]);
    expect(none.result).toEqual({ activeRole: null, roles, sections: [], contacts });
  });

  it('assertSection sends exactly one statement whether it allows or denies, and none for a null role', async () => {
    expect((await counting(reading, () => reading.service.assertSection('CUSTOMER', 'PROFILE'))).statements).toHaveLength(1);
    expect((await counting(reading, () => rejection(reading.service.assertSection('CUSTOMER', 'NOTIFICATIONS')))).statements).toHaveLength(1);
    expect((await counting(reading, () => rejection(reading.service.assertSection(null, 'PROFILE')))).statements).toEqual([]);
  });

  it('adds nothing per section: the statement count is the same for the 6 seeded sections and for a role with 30 sections', async () => {
    const baseline = (await counting(work, () => work.service.sectionsOf('PROVIDER'))).statements.length;
    try {
      for (let i = 0; i < 24; i++) await addSection(work, { enabledFor: { PROVIDER: 200 + i } });
      const many = await counting(work, () => work.service.sectionsOf('PROVIDER'));
      expect(many.result).toHaveLength(30);
      expect(many.statements).toHaveLength(baseline);
      expect(many.statements).toHaveLength(1);
    } finally {
      await restore(work);
    }
  });

  it('sends a statement that is a read: no transaction, no write, no lock clause', async () => {
    const { statements } = await counting(reading, () => reading.service.sectionsOf('CUSTOMER'));
    expect(statements[0]).toMatch(/^\s*select\b/i);
    expect(statements[0]).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b|\binsert\b|\bupdate\b\s+identity|\bdelete\b/i);
  });

  it('does not wait for a writer: a registry row locked by an open transaction is read at once, in its committed state', async () => {
    const holder = await reading.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'PROFILE'");
      await holder.query("UPDATE identity.account_sections SET status = 'PLANNED' WHERE section_code = 'NOTIFICATIONS'");
      const started = Date.now();
      const sections = await Promise.race([
        reading.service.sectionsOf('CUSTOMER'),
        sleep(5000).then(() => {
          throw new Error('the read waited for a lock');
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(sections).toEqual(SEEDED_LIST); // the uncommitted switch-off is not visible
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await reading.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST);
  });
});

describe('the access path of the real statement', () => {
  it('uses uq_account_section_roles__role_order, the primary key of the sections and the unique key of the roles when sequential scans are off', async () => {
    const { statements } = await counting(reading, () => reading.service.sectionsOf('PROVIDER'));
    await reading.pool.query('ANALYZE identity.account_section_roles');
    const c = await reading.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = (await c.query(`EXPLAIN (COSTS OFF) ${statements[0]!}`, ['PROVIDER'])).rows.map((r) => r['QUERY PLAN'] as string).join('\n');
      expect(plan).toContain('uq_account_section_roles__role_order');
      expect(plan).toContain('pk_account_sections');
      expect(plan).toContain('uq_roles__code');
      expect(plan).not.toMatch(/Seq Scan/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

// ====================================================================== assertSection
describe('assertSection against the real registry', () => {
  it('allows every section of the menu of the role and refuses the PLANNED ones, an unknown code and codes in the wrong case, with the one SECTION_NOT_FOUND answer', async () => {
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      for (const code of SIX) await expect(reading.service.assertSection(role, code), `${role} ${code}`).resolves.toBeUndefined();
      for (const code of ['NOTIFICATIONS', 'CLOSE_ACCOUNT', 'ADMIN_PANEL', 'profile', 'Profile', '', ' PROFILE', 'PROFILE\n']) {
        const err = await fails(reading.service.assertSection(role, code));
        expect({ code: err.code, message: err.message, details: err.details }, `${role} ${JSON.stringify(code)}`).toEqual({
          code: 'SECTION_NOT_FOUND',
          message: 'the account section was not found',
          details: {},
        });
      }
    }
  });

  it('refuses every section for a null role and for a role the registry does not know', async () => {
    for (const role of [null, 'ADMIN', 'customer', ''])
      for (const code of SIX) expect((await fails(reading.service.assertSection(role, code))).code).toBe('SECTION_NOT_FOUND');
  });

  it('gives the same answer for a hidden section, a retired one, a planned one and one that never existed', async () => {
    try {
      const hidden = await addSection(work, { disabled: { CUSTOMER: nextPos() } });
      const retired = await addSection(work, { status: 'INACTIVE', disabled: { CUSTOMER: nextPos() } });
      const planned = await addSection(work, { status: 'PLANNED', disabled: { CUSTOMER: nextPos() } });
      const answers = [];
      for (const code of [hidden, retired, planned, 'NEVER_EXISTED']) {
        const err = await fails(work.service.assertSection('CUSTOMER', code));
        answers.push({ code: err.code, message: err.message, details: err.details });
      }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0]!.code).toBe('SECTION_NOT_FOUND');
    } finally {
      await restore(work);
    }
  });
});

// ====================================================================== the registry decides: role-driven sets, order, switches, retirement
describe('role-driven sets: the registry, not the code, decides what each role sees', () => {
  afterEach(async () => {
    await restore(work);
  });

  it('starts from the seeded lists (the restore of the other scenarios is complete)', async () => {
    expect(await work.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST);
    expect(await work.service.sectionsOf('PROVIDER')).toEqual(SEEDED_LIST);
  });

  it('shows a section enabled only for PROVIDER at position 25 to the PROVIDER between CONTACT_VERIFICATION and SECURITY, and never to the CUSTOMER', async () => {
    const code = await addSection(work, { code: 'PROVIDER_ONLY_TEST', enabledFor: { PROVIDER: 25 }, disabled: { CUSTOMER: 25 } });
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toEqual([
      'PROFILE',
      'CONTACT_VERIFICATION',
      code,
      'SECURITY',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      'ROLES',
    ]);
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([...SIX]);
    const inserted = (await work.service.sectionsOf('PROVIDER'))[2]!;
    expect(inserted).toEqual({ code, route: expect.stringMatching(/^\/account\/test-/), labelContentKey: KEY, descriptionContentKey: null });
    // the navigation of each role carries its own set; the account that holds both roles sees the set of the ACTIVE one
    const roles = [
      { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' },
      { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' },
    ];
    const contacts = { emailVerified: false, phoneVerified: false, contactsVerified: false };
    expect(codes((await work.service.navigation({ activeRole: 'PROVIDER', roles, contacts })).sections)).toContain(code);
    expect(codes((await work.service.navigation({ activeRole: 'CUSTOMER', roles, contacts })).sections)).not.toContain(code);
    await expect(work.service.assertSection('PROVIDER', code)).resolves.toBeUndefined();
    expect((await fails(work.service.assertSection('CUSTOMER', code))).code).toBe('SECTION_NOT_FOUND');
  });

  it('shows a customer-only section to the customer only', async () => {
    const code = await addSection(work, { code: 'CUSTOMER_ONLY_TEST', enabledFor: { CUSTOMER: 55 }, disabled: { PROVIDER: 55 } });
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([
      'PROFILE',
      'CONTACT_VERIFICATION',
      'SECURITY',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      code,
      'ROLES',
    ]);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toEqual([...SIX]);
  });

  it('follows a switch at once: enabling the section for the CUSTOMER shows it to the CUSTOMER on the very next call, switching it off hides it again', async () => {
    const code = await addSection(work, { code: 'SWITCHED_TEST', enabledFor: { PROVIDER: nextPos() }, disabled: { CUSTOMER: nextPos() } });
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).not.toContain(code);
    await work.pool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1', [code]);
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toContain(code);
    await work.pool.query(
      "UPDATE identity.account_section_roles SET enabled = false WHERE section_code = $1 AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER')",
      [code],
    );
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).not.toContain(code);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toContain(code);
  });

  it('hides a disabled row: PROFILE switched off for the CUSTOMER disappears for the CUSTOMER and stays for the PROVIDER', async () => {
    await work.pool.query(
      "UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'PROFILE' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER')",
    );
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual(['CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES']);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toEqual([...SIX]);
    expect((await fails(work.service.assertSection('CUSTOMER', 'PROFILE'))).code).toBe('SECTION_NOT_FOUND');
    await expect(work.service.assertSection('PROVIDER', 'PROFILE')).resolves.toBeUndefined();
  });

  it('shows a seeded PLANNED section once it is ACTIVE and enabled, and hides it again when it is switched off and set back to PLANNED', async () => {
    await work.pool.query("UPDATE identity.account_sections SET status = 'ACTIVE' WHERE section_code = 'NOTIFICATIONS'");
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).not.toContain('NOTIFICATIONS'); // ACTIVE but still disabled for every role
    await work.pool.query(
      "UPDATE identity.account_section_roles SET enabled = true WHERE section_code = 'NOTIFICATIONS' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER')",
    );
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([
      'PROFILE',
      'CONTACT_VERIFICATION',
      'SECURITY',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      'ROLES',
      'NOTIFICATIONS',
    ]);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).not.toContain('NOTIFICATIONS');
    await work.pool.query("UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'NOTIFICATIONS'");
    await work.pool.query("UPDATE identity.account_sections SET status = 'PLANNED' WHERE section_code = 'NOTIFICATIONS'");
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([...SIX]);
  });

  it('follows a reorder: swapping two positions changes the order of the menu for that role only', async () => {
    const customer = await roleIdOf(work, 'CUSTOMER');
    // PROFILE 10 <-> SECURITY 30 through a free position (the unique key (role, position) forbids a direct swap)
    await work.pool.query("UPDATE identity.account_section_roles SET display_order = 9999 WHERE section_code = 'PROFILE' AND role_id = $1", [customer]);
    await work.pool.query("UPDATE identity.account_section_roles SET display_order = 10 WHERE section_code = 'SECURITY' AND role_id = $1", [customer]);
    await work.pool.query("UPDATE identity.account_section_roles SET display_order = 30 WHERE section_code = 'PROFILE' AND role_id = $1", [customer]);
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([
      'SECURITY',
      'CONTACT_VERIFICATION',
      'PROFILE',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      'ROLES',
    ]);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toEqual([...SIX]);
  });

  it('orders by the position, not by the code, the insertion order or the last write: a section moved to the front and one moved to the back', async () => {
    const provider = await roleIdOf(work, 'PROVIDER');
    await work.pool.query("UPDATE identity.account_section_roles SET display_order = 5 WHERE section_code = 'ROLES' AND role_id = $1", [provider]);
    await work.pool.query("UPDATE identity.account_section_roles SET display_order = 9000 WHERE section_code = 'PROFILE' AND role_id = $1", [provider]);
    expect(codes(await work.service.sectionsOf('PROVIDER'))).toEqual([
      'ROLES',
      'CONTACT_VERIFICATION',
      'SECURITY',
      'LANGUAGE_REGION',
      'PRIVACY_DATA',
      'PROFILE',
    ]);
    // the heap order of the rows is now neither: the written rows were rewritten last
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).toEqual([...SIX]);
  });

  it('orders a long menu strictly by position, whatever order the rows were inserted in', async () => {
    const orders = Array.from({ length: 20 }, (_, i) => 120 + ((i * 7) % 20) * 3); // a shuffle of 20 distinct positions
    const added: string[] = [];
    for (const [i, order] of orders.entries()) added.push(await addSection(work, { code: `ORDERED_${i}`, enabledFor: { CUSTOMER: order } }));
    const menu = await work.service.sectionsOf('CUSTOMER');
    const expected = [
      ...SIX,
      ...added
        .map((c, i) => [c, orders[i]!] as const)
        .sort((a, b) => a[1] - b[1])
        .map(([c]) => c),
    ];
    expect(codes(menu)).toEqual(expected);
  });

  it("makes a retired section disappear: switched off for every role and set INACTIVE, it is in nobody's menu and assertSection refuses it", async () => {
    await work.pool.query("UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'ROLES'");
    await work.pool.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = 'ROLES'");
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      expect(codes(await work.service.sectionsOf(role))).toEqual(['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA']);
      expect((await fails(work.service.assertSection(role, 'ROLES'))).code).toBe('SECTION_NOT_FOUND');
    }
  });

  it('refuses to retire a role that still shows sections (ROLE_HAS_SECTIONS), and a role retired the legal way (rows off first) is offered nothing and comes back with its rows', async () => {
    const err = await rejection(work.pool.query("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE code = 'PROVIDER'"));
    expect(err).toMatchObject({ code: '23000', detail: 'identity_rule:ROLE_HAS_SECTIONS' });
    expect(await work.service.sectionsOf('PROVIDER')).toEqual(SEEDED_LIST); // the refused retirement changed nothing
    await work.pool.query(
      "UPDATE identity.account_section_roles SET enabled = false WHERE role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')",
    );
    await work.pool.query("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE code = 'PROVIDER'");
    expect(await work.service.sectionsOf('PROVIDER')).toEqual([]);
    expect((await fails(work.service.assertSection('PROVIDER', 'PROFILE'))).code).toBe('SECTION_NOT_FOUND');
    expect(await work.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST); // the other role is unaffected
  });

  it('does not offer a section for an INACTIVE role even though its rows are still enabled (a state the role trigger forbids; crafted with the guards bypassed): the role status is part of "available"', async () => {
    await withoutGuards(work, async (c) => {
      await c.query("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE code = 'PROVIDER'");
    });
    expect(await work.service.sectionsOf('PROVIDER')).toEqual([]);
    expect(
      (
        await q<{ n: number }>(
          work,
          "SELECT count(*)::int AS n FROM identity.account_section_roles sr JOIN identity.roles r ON r.role_id = sr.role_id WHERE r.code = 'PROVIDER' AND sr.enabled",
        )
      )[0]!.n,
    ).toBe(6);
    expect((await fails(work.service.assertSection('PROVIDER', 'PROFILE'))).code).toBe('SECTION_NOT_FOUND');
    expect(await work.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST); // the other role is unaffected
    await work.pool.query("UPDATE identity.roles SET status = 'ACTIVE', updated_at = now() WHERE code = 'PROVIDER'");
    expect(await work.service.sectionsOf('PROVIDER')).toEqual(SEEDED_LIST);
  });

  it('does not offer an enabled row of a section that is INACTIVE or PLANNED, a state the guards forbid and only a bypassed guard can leave behind (defence in depth)', async () => {
    const retired = await addSection(work, { code: 'CRAFTED_INACTIVE', enabledFor: { CUSTOMER: nextPos() } });
    const planned = await addSection(work, { code: 'CRAFTED_PLANNED', enabledFor: { CUSTOMER: nextPos(), PROVIDER: nextPos() } });
    await withoutGuards(work, async (c) => {
      await c.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = $1", [retired]);
      await c.query("UPDATE identity.account_sections SET status = 'PLANNED' WHERE section_code = $1", [planned]);
    });
    // the crafted state really is the forbidden one
    expect(
      await q(
        work,
        "SELECT sr.section_code FROM identity.account_section_roles sr JOIN identity.account_sections s ON s.section_code = sr.section_code WHERE sr.enabled AND s.status <> 'ACTIVE' ORDER BY 1",
      ),
    ).toEqual([{ section_code: 'CRAFTED_INACTIVE' }, { section_code: 'CRAFTED_PLANNED' }, { section_code: 'CRAFTED_PLANNED' }]);
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      const menu = codes(await work.service.sectionsOf(role));
      expect(menu).toEqual([...SIX]);
      expect((await fails(work.service.assertSection(role, retired))).code).toBe('SECTION_NOT_FOUND');
      expect((await fails(work.service.assertSection(role, planned))).code).toBe('SECTION_NOT_FOUND');
    }
  });

  it('two sections at one position of a role are refused by the unique key, so a menu is never ordered ambiguously', async () => {
    await addSection(work, { code: 'FIRST_AT_70', enabledFor: { CUSTOMER: 710 } });
    const second = rejection(addSection(work, { code: 'SECOND_AT_70', enabledFor: { CUSTOMER: 710 } }));
    expect(((await second) as { constraint?: string }).constraint).toBe('uq_account_section_roles__role_order');
    // the section row of the failed attempt exists without a matrix row: it is not offered
    expect(codes(await work.service.sectionsOf('CUSTOMER'))).not.toContain('SECOND_AT_70');
  });
});

// ====================================================================== a corrupted registry
describe('a corrupted registry is refused, never half-offered', () => {
  it('refuses a stored route that violates the shape (the CHECK dropped in a scratch database) with UNAVAILABLE REGISTRY_INVALID for sectionsOf, navigation and assertSection, and offers none of the sections', async () => {
    await corrupt.pool.query('ALTER TABLE identity.account_sections DROP CONSTRAINT ck_account_sections__route_path_format');
    await corrupt.pool.query("UPDATE identity.account_sections SET route_path = '/account/Not A Route' WHERE section_code = 'SECURITY'");
    const roles = [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }];
    const contacts = { emailVerified: false, phoneVerified: false, contactsVerified: false };
    for (const attempt of [
      () => corrupt.service.sectionsOf('CUSTOMER'),
      () => corrupt.service.navigation({ activeRole: 'CUSTOMER', roles, contacts }),
      () => corrupt.service.assertSection('CUSTOMER', 'PROFILE'),
      () => corrupt.service.assertSection('CUSTOMER', 'SECURITY'),
    ]) {
      const err = await fails(attempt());
      expect({ code: err.code, message: err.message, details: err.details }).toEqual({
        code: 'UNAVAILABLE',
        message: 'the account area registry is not valid',
        details: { reason: 'REGISTRY_INVALID' },
      });
      expect(err.message + JSON.stringify(err.details)).not.toContain('Not A Route');
    }
    // a role whose menu does not contain the broken row is unaffected
    await corrupt.pool.query(
      "UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'SECURITY' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')",
    );
    expect(codes(await corrupt.service.sectionsOf('PROVIDER'))).toEqual(['PROFILE', 'CONTACT_VERIFICATION', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES']);
    // a broken route of a section nobody shows does not matter either: the registry is read for the role's menu only
    await corrupt.pool.query("UPDATE identity.account_section_roles SET enabled = false WHERE section_code = 'SECURITY'");
    expect(codes(await corrupt.service.sectionsOf('CUSTOMER'))).toEqual(['PROFILE', 'CONTACT_VERIFICATION', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES']);
  });
});

// ====================================================================== concurrency
describe('concurrency: parallel readers see one consistent registry', () => {
  it('returns the identical list to 30 parallel sectionsOf calls (and to 30 parallel navigations), over several rounds', async () => {
    const roles = [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }];
    const contacts = { emailVerified: true, phoneVerified: false, contactsVerified: false };
    for (let round = 0; round < 4; round++) {
      const lists = await Promise.all(Array.from({ length: 30 }, (_, i) => reading.service.sectionsOf(i % 2 === 0 ? 'CUSTOMER' : 'PROVIDER')));
      for (const list of lists) expect(list).toEqual(SEEDED_LIST);
      const navs = await Promise.all(Array.from({ length: 30 }, () => reading.service.navigation({ activeRole: 'CUSTOMER', roles, contacts })));
      for (const nav of navs) expect(nav).toEqual({ activeRole: 'CUSTOMER', roles, sections: SEEDED_LIST, contacts });
    }
  });

  it("gives parallel callers independent copies (a caller that edits its list does not change another caller's list)", async () => {
    const [a, b] = await Promise.all([reading.service.sectionsOf('CUSTOMER'), reading.service.sectionsOf('CUSTOMER')]);
    a[0]!.code = 'CHANGED';
    a.pop();
    expect(b).toEqual(SEEDED_LIST);
    expect(await reading.service.sectionsOf('CUSTOMER')).toEqual(SEEDED_LIST);
  });

  it('never returns a half-switched menu: while a connection flips a row on and off, every one of 60 parallel reads is exactly the full list or the full list without that section', async () => {
    const without = SIX.filter((c) => c !== 'SECURITY');
    let flipping = true;
    const provider = await roleIdOf(work, 'PROVIDER');
    const flipper = (async () => {
      for (let i = 0; flipping; i++) {
        await work.pool.query("UPDATE identity.account_section_roles SET enabled = $2 WHERE section_code = 'SECURITY' AND role_id = $1", [
          provider,
          i % 2 === 0,
        ]);
      }
    })();
    try {
      const results: string[][] = [];
      for (let round = 0; round < 3; round++) {
        results.push(...(await Promise.all(Array.from({ length: 20 }, () => work.service.sectionsOf('PROVIDER')))).map(codes));
      }
      expect(results).toHaveLength(60);
      for (const menu of results) expect([[...SIX], [...without]], JSON.stringify(menu)).toContainEqual(menu);
    } finally {
      flipping = false;
      await flipper;
      await restore(work);
    }
    expect(await work.service.sectionsOf('PROVIDER')).toEqual(SEEDED_LIST);
  });

  it('keeps reading while a section is retired and brought back by another connection: no read fails, none sees a retired section with a switched-on row', async () => {
    const code = await addSection(work, { code: 'FLICKER_TEST', enabledFor: { CUSTOMER: 410 } });
    let flipping = true;
    const flipper = (async () => {
      for (let i = 0; flipping; i++) {
        await work.pool.query('UPDATE identity.account_section_roles SET enabled = false WHERE section_code = $1', [code]);
        await work.pool.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = $1", [code]);
        await work.pool.query("UPDATE identity.account_sections SET status = 'ACTIVE' WHERE section_code = $1", [code]);
        await work.pool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1', [code]);
      }
    })();
    try {
      for (let round = 0; round < 3; round++) {
        const menus = (await Promise.all(Array.from({ length: 20 }, () => work.service.sectionsOf('CUSTOMER')))).map(codes);
        for (const menu of menus) expect([[...SIX], [...SIX, code]], JSON.stringify(menu)).toContainEqual(menu);
      }
    } finally {
      flipping = false;
      await flipper;
      await restore(work);
    }
  });

  it('leaves no lock, no idle-in-transaction session and no leaked connection behind after the reads', async () => {
    await Promise.all(Array.from({ length: 30 }, () => reading.service.sectionsOf('CUSTOMER')));
    expect(
      (
        await q<{ n: number }>(
          reading,
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND (state LIKE 'idle in transaction%' OR wait_event_type = 'Lock')",
        )
      )[0]!.n,
    ).toBe(0);
    expect(reading.db.poolStats().waiting).toBe(0);
  });
});
