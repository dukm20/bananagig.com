import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_AREA_COPY,
  ACCOUNT_SECTIONS,
  ACCOUNT_SECTION_STATUSES,
  accountSectionDescriptionKey,
  accountSectionLabelKey,
  SECTION_CODE_PATTERN,
  SECTION_ROUTE_PATTERN,
} from '../../contracts/src/account-area';
import { runMigrations } from '../../../scripts/lib/migrator.mjs';
import { ContentService } from '../../content/src/index';
import { createIsolatedDatabase, createTestPool, migrationsDir, rejection, sleep, type IsolatedDatabase } from './index';

// Migration 0014 adds the registry of the shared ACCOUNT AREA to the identity schema: identity.account_sections (one row per section: stable code, its own URL, the
// managed label and description, a lifecycle status) and identity.account_section_roles (which application role sees which section, whether it is enabled and in which
// order), two guard functions with their triggers (SQLSTATE 23000, DETAIL identity_rule:<KEY>), the seeded matrix of 8 sections x 2 roles and 64 managed copy entries
// published through the real content lifecycle. Nothing else changes. These tests drive the REAL tables with raw SQL on isolated databases: the exact shape (every
// column, constraint, index, trigger and function by name, nothing speculative), the seed, every CHECK, every guard rule with the exact failing statement, the
// foreign keys, the interleavings that matter under real concurrency (a mutation check on a scratch database proves the share lock is what makes them hold), the
// access path of the navigation query, the privacy shape and that no older table was altered. The service is covered in packages/accounts (account-area.itest.ts).
let iso: IsolatedDatabase; // mutated by the tests
let seed: IsolatedDatabase; // pristine: only the seed assertions read it
let pool: pg.Pool;
let racePool: pg.Pool;
let seedPool: pg.Pool;
let seq = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  seed = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 10);
  racePool = createTestPool(iso.url, 30);
  seedPool = createTestPool(seed.url, 4);
});
afterAll(async () => {
  await pool?.end();
  await racePool?.end();
  await seedPool?.end();
  await iso?.drop();
  await seed?.drop();
});

// ---------------------------------------------------------------- helpers
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const sq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await seedPool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params).then(() => undefined);
const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0]!.n;
interface PgFailure {
  code?: string;
  constraint?: string;
  detail?: string;
  column?: string;
  message: string;
}
/** The failure of a statement (the test fails when the statement succeeds). */
const fail = async (p: Promise<unknown>): Promise<PgFailure> => {
  const e = (await rejection(p)) as PgFailure | undefined;
  expect(e, 'the statement was expected to be rejected').toBeDefined();
  return e!;
};
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL identity_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `identity_rule:${key}` });
};
const expectNotNull = async (p: Promise<unknown>, column: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, column: e.column }).toEqual({ code: '23502', column });
};
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

type Db = pg.Pool | pg.PoolClient;

/** Opens a transaction on a connection of its own (the caller commits or rolls back and releases). */
async function openTx(from: pg.Pool = pool): Promise<pg.PoolClient> {
  const c = await from.connect();
  await c.query('BEGIN');
  return c;
}
const finish = async (c: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<void> => {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
};
/**
 * Runs `prep` statements and then `text` inside a transaction that is ALWAYS rolled back. Used to reach a foreign key that a guard trigger would report first: the
 * prep disables the user triggers of one table for this transaction only (foreign key triggers are internal and stay in force).
 */
async function isolated(prep: string[], text: string, params: unknown[] = [], from: pg.Pool = pool): Promise<void> {
  const c = await from.connect();
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

/** How many sessions of the database of this pool are blocked on a lock right now. */
const waitersOn = async (from: pg.Pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      )
    ).rows[0] as { n: number }
  ).n;
/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number, from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
async function noLockWaiters(from: pg.Pool = pool): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if ((await waitersOn(from)) === 0) return;
    await sleep(20);
  }
  throw new Error('sessions are still blocked on a lock');
}

// ---------------------------------------------------------------- catalog helpers
type ColumnShape = [name: string, type: string, nullable: boolean, defaultExpr: string | null];
const columnsOf = async (table: string, from: pg.Pool = pool): Promise<ColumnShape[]> =>
  (
    (
      await from.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = $1 ORDER BY ordinal_position",
        [table],
      )
    ).rows as { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  ).map((r) => [r.column_name, r.data_type, r.is_nullable === 'YES', r.column_default]);
const constraintsOf = async (
  table: string,
): Promise<{ conname: string; contype: string; confdeltype: string; confmatchtype: string; target: string | null; def: string }[]> =>
  (
    await pool.query(
      `SELECT conname, contype, confdeltype, confmatchtype, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass ORDER BY conname COLLATE "C"`,
      [table],
    )
  ).rows;
const indexesOf = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
  (await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname COLLATE "C"', ['identity', table]))
    .rows;
const triggersOf = async (table: string) =>
  q<{ tgname: string; def: string }>(
    'SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"',
    [table],
  );
const commentOn = async (table: string, column?: string): Promise<string | null> =>
  (
    (
      await pool.query(
        column
          ? 'SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c'
          : "SELECT obj_description($1::regclass, 'pg_class') AS c",
        column ? [table, column] : [table],
      )
    ).rows[0] as { c: string | null }
  ).c;
const vocab = (def: string): string[] => [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!);
const SECTIONS = 'identity.account_sections';
const MATRIX = 'identity.account_section_roles';

// ---------------------------------------------------------------- fixtures
const roleIds = new Map<string, string>();
async function roleId(code: string): Promise<string> {
  const cached = roleIds.get(code);
  if (cached) return cached;
  const id = ((await q<{ role_id: string }>('SELECT role_id FROM identity.roles WHERE code = $1', [code]))[0] ?? { role_id: '' }).role_id;
  roleIds.set(code, id);
  return id;
}
/** A content key that exists (any seeded managed entry): the registry rows of the tests point at it. */
const KEY = 'account.area.section.profile.label';
const DESC_KEY = 'account.area.section.profile.description';
interface NewSection {
  code?: string;
  route?: string;
  label?: string;
  description?: string | null;
  status?: string;
}
/** Inserts a section (a PLANNED one by default, like the column default) and returns its code. */
async function makeSection(o: NewSection = {}, from: Db = pool): Promise<string> {
  const n = ++seq;
  const code = o.code ?? `TST_${n}`;
  await from.query(
    'INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES ($1, $2, $3, $4, $5)',
    [code, o.route ?? `/account/tst-${n}`, o.label ?? KEY, o.description === undefined ? DESC_KEY : o.description, o.status ?? 'PLANNED'],
  );
  return code;
}
let orderSeq = 1000;
const nextOrder = (): number => ++orderSeq;
let roleSeq = 0;
/** A role of its own (the seeded roles stay untouched): ACTIVE unless asked otherwise. A role with no enabled row can be retired. */
async function newRole(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<string> {
  const code = `TESTROLE_${++roleSeq}`;
  await run("INSERT INTO identity.roles (code, name_content_key) VALUES ($1, 'identity.role.customer.name')", [code]);
  if (status === 'INACTIVE') await run("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now() WHERE code = $1", [code]);
  return code;
}
const setRoleStatus = (code: string, status: 'ACTIVE' | 'INACTIVE', from: Db = pool) =>
  from.query('UPDATE identity.roles SET status = $2, updated_at = now() WHERE code = $1', [code, status]);
/** Inserts a matrix row (disabled by default, with a fresh display order). */
async function makeRow(code: string, role: string, o: { enabled?: boolean; order?: number } = {}, from: Db = pool): Promise<number> {
  const order = o.order ?? nextOrder();
  await from.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, $3, $4)', [
    code,
    await roleId(role),
    o.enabled ?? false,
    order,
  ]);
  return order;
}
const setStatus = (code: string, status: string, from: Db = pool) =>
  from.query('UPDATE identity.account_sections SET status = $2 WHERE section_code = $1', [code, status]);
const setEnabled = async (code: string, role: string, enabled: boolean, from: Db = pool) =>
  from.query('UPDATE identity.account_section_roles SET enabled = $3 WHERE section_code = $1 AND role_id = $2', [code, await roleId(role), enabled]);
const sectionRow = async (code: string) =>
  (
    await q<{ status: string; updated_at: Date; created_at: Date }>(`SELECT status, updated_at, created_at FROM ${SECTIONS} WHERE section_code = $1`, [code])
  )[0]!;
const matrixRow = async (code: string, role: string) =>
  (
    await q<{ enabled: boolean; display_order: number; updated_at: Date; created_at: Date }>(
      `SELECT enabled, display_order, updated_at, created_at FROM ${MATRIX} WHERE section_code = $1 AND role_id = $2`,
      [code, await roleId(role)],
    )
  )[0]!;
/** An ACTIVE section that no role shows yet, with a disabled row for each of the two roles. */
async function activeSection(): Promise<string> {
  const code = await makeSection({ status: 'ACTIVE' });
  await makeRow(code, 'CUSTOMER');
  await makeRow(code, 'PROVIDER');
  return code;
}
/** The invariant of the registry: no ENABLED row belongs to a section that is not ACTIVE. */
const violations = (from: pg.Pool = pool) =>
  from
    .query(
      `SELECT sr.section_code FROM identity.account_section_roles sr JOIN identity.account_sections s ON s.section_code = sr.section_code WHERE sr.enabled AND s.status <> 'ACTIVE'`,
    )
    .then((r) => r.rows);

// ====================================================================== A. shape of the schema
const SECTION_COLUMNS: ColumnShape[] = [
  ['section_code', 'text', false, null],
  ['route_path', 'text', false, null],
  ['label_content_key', 'text', false, null],
  ['description_content_key', 'text', true, null],
  ['status', 'text', false, "'PLANNED'::text"],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['updated_at', 'timestamp with time zone', false, 'now()'],
];
const MATRIX_COLUMNS: ColumnShape[] = [
  ['section_code', 'text', false, null],
  ['role_id', 'uuid', false, null],
  ['enabled', 'boolean', false, 'false'],
  ['display_order', 'integer', false, null],
  ['created_at', 'timestamp with time zone', false, 'now()'],
  ['updated_at', 'timestamp with time zone', false, 'now()'],
];
const SECTION_CONSTRAINTS = [
  'c:ck_account_sections__description_content_key_format',
  'c:ck_account_sections__label_content_key_format',
  'c:ck_account_sections__route_path_format',
  'c:ck_account_sections__section_code_format',
  'c:ck_account_sections__status',
  'f:fk_account_sections__description_content_key',
  'f:fk_account_sections__label_content_key',
  'p:pk_account_sections',
  'u:uq_account_sections__route_path',
];
const MATRIX_CONSTRAINTS = [
  'c:ck_account_section_roles__display_order',
  'f:fk_account_section_roles__role_id',
  'f:fk_account_section_roles__section_code',
  'p:pk_account_section_roles',
  'u:uq_account_section_roles__role_order',
];
const KEY_REGEX = '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$';
const identityConstraintCount = async (from: pg.Pool = pool): Promise<number> =>
  (
    (
      await from.query(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'identity' AND c.contype IN ('p', 'u', 'f', 'c')",
      )
    ).rows[0] as { n: number }
  ).n;

describe('A. schema shape: a registry of account sections and of the sections each role sees, holding no personal data', () => {
  it('adds exactly two tables to the identity schema (seventeen in total) and no sequence, view, materialized view or partition', async () => {
    const tables = await q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'",
    );
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      'account_audit_events',
      'account_devices',
      'account_profiles',
      'account_roles',
      'account_section_roles',
      'account_sections',
      'account_status_history',
      'accounts',
      'application_sessions',
      'consent_events',
      'consent_purposes',
      'email_contacts',
      'email_verification_challenges',
      'external_identities',
      'phone_contacts',
      'phone_verification_challenges',
      'roles',
    ]);
    // the only sequence is still the history sequence of 0009: both new tables have natural keys
    expect(await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'S'")).toEqual([
      { relname: 'account_status_history_history_seq_seq' },
    ]);
    expect(
      await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind IN ('v', 'm', 'p')"),
    ).toEqual([]);
  });

  it('has exactly the documented columns, types, nullability and defaults on account_sections (the status defaults to PLANNED: a new section is never shown by accident)', async () => {
    expect(await columnsOf('account_sections')).toEqual(SECTION_COLUMNS);
  });

  it('has exactly the documented columns, types, nullability and defaults on account_section_roles (a new row is disabled: nothing is shown by accident)', async () => {
    expect(await columnsOf('account_section_roles')).toEqual(MATRIX_COLUMNS);
  });

  it('has exactly the documented constraints on account_sections (primary key, one unique, two foreign keys, five checks: 9)', async () => {
    const c = await constraintsOf(SECTIONS);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(SECTION_CONSTRAINTS);
    expect(c).toHaveLength(9);
  });

  it('has exactly the documented constraints on account_section_roles (primary key, one unique, two foreign keys, one check: 5)', async () => {
    const c = await constraintsOf(MATRIX);
    expect(c.map((r) => `${r.contype}:${r.conname}`)).toEqual(MATRIX_CONSTRAINTS);
    expect(c).toHaveLength(5);
  });

  it('brings the identity schema to 155 primary key, unique, foreign key and check constraints (141 before 0014 plus 9 + 5)', async () => {
    expect(await identityConstraintCount()).toBe(155);
    expect(141 + SECTION_CONSTRAINTS.length + MATRIX_CONSTRAINTS.length).toBe(155);
  });

  it('defines every constraint exactly as documented (the definition text, not only the name)', async () => {
    const defs = Object.fromEntries([...(await constraintsOf(SECTIONS)), ...(await constraintsOf(MATRIX))].map((r) => [r.conname, r.def]));
    expect(defs).toEqual({
      pk_account_sections: 'PRIMARY KEY (section_code)',
      uq_account_sections__route_path: 'UNIQUE (route_path)',
      fk_account_sections__label_content_key: 'FOREIGN KEY (label_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
      fk_account_sections__description_content_key: 'FOREIGN KEY (description_content_key) REFERENCES content.entries(key) ON DELETE RESTRICT',
      ck_account_sections__section_code_format: "CHECK ((section_code ~ '^[A-Z][A-Z0-9_]{1,39}$'::text))",
      ck_account_sections__route_path_format: "CHECK ((route_path ~ '^/account/[a-z][a-z0-9-]{1,39}$'::text))",
      ck_account_sections__label_content_key_format: `CHECK ((label_content_key ~ '${KEY_REGEX}'::text))`,
      ck_account_sections__description_content_key_format: `CHECK (((description_content_key IS NULL) OR (description_content_key ~ '${KEY_REGEX}'::text)))`,
      ck_account_sections__status: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'PLANNED'::text, 'INACTIVE'::text])))",
      pk_account_section_roles: 'PRIMARY KEY (section_code, role_id)',
      uq_account_section_roles__role_order: 'UNIQUE (role_id, display_order)',
      fk_account_section_roles__section_code: 'FOREIGN KEY (section_code) REFERENCES identity.account_sections(section_code) ON DELETE RESTRICT',
      fk_account_section_roles__role_id: 'FOREIGN KEY (role_id) REFERENCES identity.roles(role_id) ON DELETE RESTRICT',
      ck_account_section_roles__display_order: 'CHECK (((display_order >= 1) AND (display_order <= 9999)))',
    });
  });

  it('declares every foreign key ON DELETE RESTRICT with the default MATCH SIMPLE and the documented target; nothing in the identity schema cascades', async () => {
    const fks = [...(await constraintsOf(SECTIONS)), ...(await constraintsOf(MATRIX))].filter((r) => r.contype === 'f');
    expect(fks.map((r) => [r.conname, r.confdeltype, r.confmatchtype, r.target]).sort()).toEqual(
      [
        ['fk_account_sections__label_content_key', 'r', 's', 'content.entries'],
        ['fk_account_sections__description_content_key', 'r', 's', 'content.entries'],
        ['fk_account_section_roles__section_code', 'r', 's', 'identity.account_sections'],
        ['fk_account_section_roles__role_id', 'r', 's', 'identity.roles'],
      ].sort(),
    );
    expect(
      await q(
        "SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'identity' AND c.contype = 'f' AND c.confdeltype <> 'r'",
      ),
    ).toEqual([]);
  });

  it('CHECKs the status to exactly the contract list and the section code and route to the contract patterns, so the database and the API cannot drift', async () => {
    const status = (await constraintsOf(SECTIONS)).find((r) => r.conname === 'ck_account_sections__status')!.def;
    expect(vocab(status)).toEqual([...ACCOUNT_SECTION_STATUSES]);
    const defs = Object.fromEntries((await constraintsOf(SECTIONS)).map((r) => [r.conname, r.def]));
    expect(defs.ck_account_sections__section_code_format).toContain(SECTION_CODE_PATTERN.source);
    expect(defs.ck_account_sections__route_path_format).toContain(SECTION_ROUTE_PATTERN.source.replaceAll('\\/', '/'));
  });

  it('agrees with the contract patterns on a corpus of good and bad codes and routes (a differential test: the database regex and the JavaScript regex accept the same strings)', async () => {
    const codes = [
      'PROFILE',
      'AB',
      'A',
      '',
      'a1',
      'A_1',
      '1A',
      '_A',
      'A-B',
      'A B',
      `A${ch(0x0a)}`,
      `${ch(0x0a)}AB`,
      'A'.repeat(40),
      'A'.repeat(41),
      `A${ch(0xc9)}`,
      `A${ch(0xff21)}`,
      `AB${ch(0x200b)}`,
    ];
    const routes = [
      '/account/profile',
      '/account/ab',
      '/account/a-b',
      '/account/a1',
      '/account/x',
      '/account',
      '/account/',
      '/Account/x',
      '/account/a b',
      '/account/x/y',
      '/account/1ab',
      '/account/-ab',
      '/account/ab_c',
      '/account/AB',
      `/account/ab${ch(0x0a)}`,
      '/account/' + 'a'.repeat(40),
      '/account/' + 'a'.repeat(41),
      'account/profile',
      '/account/profile/',
      `/account/${ch(0xe9)}a`,
      `/account/a${ch(0xe9)}`,
      `/account/a${ch(0x200b)}b`,
    ];
    for (const c of codes) {
      const db = (await q<{ ok: boolean }>("SELECT $1::text ~ '^[A-Z][A-Z0-9_]{1,39}$' AS ok", [c]))[0]!.ok;
      expect(SECTION_CODE_PATTERN.test(c), JSON.stringify(c)).toBe(db);
    }
    for (const r of routes) {
      const db = (await q<{ ok: boolean }>("SELECT $1::text ~ '^/account/[a-z][a-z0-9-]{1,39}$' AS ok", [r]))[0]!.ok;
      expect(SECTION_ROUTE_PATTERN.test(r), JSON.stringify(r)).toBe(db);
    }
  });

  it('has exactly the documented indexes: the two keys of each table and the route key, and NO other index (the unique key (role_id, display_order) is the access path)', async () => {
    expect((await indexesOf('account_sections')).map((r) => r.indexname)).toEqual(['pk_account_sections', 'uq_account_sections__route_path']);
    const idx = await indexesOf('account_section_roles');
    expect(idx.map((r) => r.indexname)).toEqual(['pk_account_section_roles', 'uq_account_section_roles__role_order']);
    const def = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]));
    expect(def.pk_account_section_roles).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(section_code, role_id\)$/);
    expect(def.uq_account_section_roles__role_order).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(role_id, display_order\)$/);
    // no plain index, no partial index and no index on enabled, status, a timestamp or a content key anywhere on the two tables
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND tablename IN ('account_sections', 'account_section_roles') AND indexname !~ '^(pk|uq)_'",
      ),
    ).toEqual([]);
    expect(idx.concat(await indexesOf('account_sections')).filter((r) => / WHERE /.test(r.indexdef))).toEqual([]);
    expect(
      await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND indexdef ~ '(enabled|status|label_content_key|description_content_key|updated_at|created_at)' AND tablename LIKE 'account_section%'",
      ),
    ).toEqual([]);
  });

  it('wires the triggers: a row guard and a truncate trigger on each registry table, and one status trigger on identity.roles next to its older guard; none deferrable', async () => {
    const sections = await triggersOf(SECTIONS);
    expect(sections.map((t) => t.tgname)).toEqual(['trg_account_sections__guard', 'trg_account_sections__no_truncate']);
    expect(sections[0]!.def).toMatch(
      /BEFORE DELETE OR UPDATE ON identity\.account_sections FOR EACH ROW EXECUTE FUNCTION identity\.guard_account_sections\(\)$/,
    );
    expect(sections[1]!.def).toMatch(/BEFORE TRUNCATE ON identity\.account_sections FOR EACH STATEMENT EXECUTE FUNCTION identity\.forbid_mutation\(\)$/);
    const matrix = await triggersOf(MATRIX);
    expect(matrix.map((t) => t.tgname)).toEqual(['trg_account_section_roles__guard', 'trg_account_section_roles__no_truncate']);
    expect(matrix[0]!.def).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON identity\.account_section_roles FOR EACH ROW EXECUTE FUNCTION identity\.guard_account_section_roles\(\)$/,
    );
    expect(matrix[1]!.def).toMatch(/BEFORE TRUNCATE ON identity\.account_section_roles FOR EACH STATEMENT EXECUTE FUNCTION identity\.forbid_mutation\(\)$/);
    const roles = await triggersOf('identity.roles');
    expect(roles.map((t) => t.tgname)).toEqual(['trg_roles__account_sections', 'trg_roles__guard']);
    expect(roles[0]!.def).toMatch(/BEFORE UPDATE OF status ON identity\.roles FOR EACH ROW EXECUTE FUNCTION identity\.guard_roles_account_sections\(\)$/);
    expect(sections.concat(matrix, roles).filter((t) => /CONSTRAINT TRIGGER|DEFERRABLE/.test(t.def))).toEqual([]);
    // the registry tables have no AFTER trigger and no other statement trigger
    expect(sections.concat(matrix).filter((t) => /STATEMENT/.test(t.def) && !/BEFORE TRUNCATE/.test(t.def))).toEqual([]);
  });

  it('defines the three guards as plain plpgsql trigger functions, VOLATILE and not SECURITY DEFINER, with a comment each', async () => {
    expect(
      await q(
        `SELECT p.proname, l.lanname AS lang, p.prosecdef AS secdef, p.provolatile AS volatility, pg_get_function_result(p.oid) AS result,
                obj_description(p.oid, 'pg_proc') IS NOT NULL AS commented
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'identity' AND p.proname LIKE 'guard_%account_section%' ORDER BY 1`,
      ),
    ).toEqual([
      { proname: 'guard_account_section_roles', lang: 'plpgsql', secdef: false, volatility: 'v', result: 'trigger', commented: true },
      { proname: 'guard_account_sections', lang: 'plpgsql', secdef: false, volatility: 'v', result: 'trigger', commented: true },
      { proname: 'guard_roles_account_sections', lang: 'plpgsql', secdef: false, volatility: 'v', result: 'trigger', commented: true },
    ]);
    // no function other than the three guards was added to the identity schema (the truncate triggers reuse identity.forbid_mutation of 0009)
    expect(await q("SELECT proname FROM pg_proc WHERE pronamespace = 'identity'::regnamespace AND proname LIKE '%account_section%' ORDER BY 1")).toEqual([
      { proname: 'guard_account_section_roles' },
      { proname: 'guard_account_sections' },
      { proname: 'guard_roles_account_sections' },
    ]);
  });

  it('documents both tables and their meaningful columns in the catalog, and says that no personal data is stored', async () => {
    expect(await commentOn(SECTIONS)).toMatch(/No personal data\.$/);
    expect(await commentOn(MATRIX)).toMatch(/No personal data\.$/);
    for (const c of ['section_code', 'route_path', 'label_content_key', 'description_content_key', 'status'])
      expect(await commentOn(SECTIONS, c), c).toBeTruthy();
    for (const c of ['enabled', 'display_order']) expect(await commentOn(MATRIX, c), c).toBeTruthy();
  });

  it('did not alter any older object: every column, constraint, index, trigger, function and comment outside the two new tables equals the schema migrated to 0013, and no row of an older table changed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bananagig-mig-0013-'));
    const before = await createIsolatedDatabase({ migrate: false });
    const beforePool = createTestPool(before.url, 3);
    try {
      for (const f of readdirSync(migrationsDir()).filter((n) => /^00(0[1-9]|1[0-3])_.*\.sql$/.test(n)))
        copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
      expect(readdirSync(dir)).toHaveLength(13);
      await runMigrations({ url: before.url, dir });
      const a = await catalog(beforePool);
      const b = await catalog(pool);
      expect(b.columns).toEqual(a.columns);
      expect(b.constraints).toEqual(a.constraints);
      expect(b.indexes).toEqual(a.indexes);
      expect(b.triggers).toEqual(a.triggers);
      expect(b.functions).toEqual(a.functions);
      expect(b.comments).toEqual(a.comments);
      // the ONE addition to an older table: a second trigger on identity.roles (no column, constraint or index), and nothing else
      expect((await triggersOf('identity.roles')).map((t) => t.tgname)).toEqual(['trg_roles__account_sections', 'trg_roles__guard']);
      const rolesBefore = await beforePool.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'identity.roles'::regclass AND NOT tgisinternal ORDER BY 1");
      expect(rolesBefore.rows).toEqual([{ tgname: 'trg_roles__guard' }]);
      expect(b.columns.length).toBeGreaterThan(300); // the comparison is not vacuous
      expect(b.constraints.length).toBeGreaterThan(200);
      // data: the roles and everything outside the registry and the 64 managed entries are the same; the seed emits no outbox event and creates no account
      const rows = (from: pg.Pool) => from.query('SELECT code, name_content_key, status FROM identity.roles ORDER BY code').then((r) => r.rows);
      expect(await rows(pool)).toEqual(await rows(beforePool));
      const countsOf = async (from: pg.Pool) =>
        (
          await from.query(
            `SELECT (SELECT count(*)::int FROM identity.accounts) AS accounts, (SELECT count(*)::int FROM integration.outbox_events) AS outbox,
                    (SELECT count(*)::int FROM configuration.parameters) AS parameters, (SELECT count(*)::int FROM identity.account_audit_events) AS audit,
                    (SELECT count(*)::int FROM content.locales) AS locales, (SELECT count(*)::int FROM geography.time_zones) AS zones,
                    (SELECT count(*)::int FROM content.entries WHERE key NOT LIKE 'account.area.%') AS other_entries,
                    (SELECT count(*)::int FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key NOT LIKE 'account.area.%') AS other_versions`,
          )
        ).rows[0];
      expect(await countsOf(pool)).toEqual(await countsOf(beforePool));
      const total = (from: pg.Pool) =>
        from
          .query(
            'SELECT (SELECT count(*)::int FROM content.entries) AS entries, (SELECT count(*)::int FROM content.versions) AS versions, (SELECT count(*)::int FROM content.audit_events) AS audit',
          )
          .then((r) => r.rows[0] as { entries: number; versions: number; audit: number });
      const [x, y] = [await total(beforePool), await total(pool)];
      expect({ entries: y.entries - x.entries, versions: y.versions - x.versions, audit: y.audit - x.audit }).toEqual({
        entries: 64,
        versions: 64,
        audit: 320,
      });
    } finally {
      await beforePool.end();
      await before.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has the identity tables of 0009 with exactly their 0009 columns (plus the one column 0012 added to accounts): the registry is additive', async () => {
    expect(await columnsOf('accounts')).toEqual([
      ['account_id', 'uuid', false, 'gen_random_uuid()'],
      ['status', 'text', false, null],
      ['primary_role_id', 'uuid', true, null],
      ['created_at', 'timestamp with time zone', false, 'now()'],
      ['updated_at', 'timestamp with time zone', false, 'now()'],
      ['closed_at', 'timestamp with time zone', true, null],
      ['sessions_not_before', 'timestamp with time zone', true, null],
    ]);
    expect(await columnsOf('roles')).toEqual([
      ['role_id', 'uuid', false, 'gen_random_uuid()'],
      ['code', 'text', false, null],
      ['name_content_key', 'text', false, null],
      ['status', 'text', false, "'ACTIVE'::text"],
      ['created_at', 'timestamp with time zone', false, 'now()'],
      ['updated_at', 'timestamp with time zone', false, 'now()'],
    ]);
    expect(await columnsOf('account_profiles')).toEqual([
      ['account_id', 'uuid', false, null],
      ['first_name', 'text', false, null],
      ['last_name', 'text', false, null],
      ['preferred_locale', 'text', true, null],
      ['time_zone_id', 'uuid', true, null],
      ['created_at', 'timestamp with time zone', false, 'now()'],
      ['updated_at', 'timestamp with time zone', false, 'now()'],
    ]);
  });

  it('contains no ALTER, DROP, UPDATE or DELETE of an older object in the migration text, and creates only the two tables, the three guard functions and the five triggers', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(path.join(migrationsDir(), '0014_account_area.sql'), 'utf8');
    const body = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(body).not.toMatch(/\b(ALTER\s+TABLE|DROP\s|DELETE\s+FROM|CREATE\s+(UNIQUE\s+)?INDEX)\b/i);
    expect(body.replace(/BEFORE TRUNCATE/gi, '')).not.toMatch(/\bTRUNCATE\b/i); // the only TRUNCATE is the BEFORE TRUNCATE trigger event
    expect([...body.matchAll(/\bCREATE\s+(TABLE|FUNCTION|TRIGGER)\s+([\w.]+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)).toEqual([
      'TABLE identity.account_sections',
      'TABLE identity.account_section_roles',
      'FUNCTION identity.guard_account_sections',
      'TRIGGER trg_account_sections__guard',
      'FUNCTION identity.guard_account_section_roles',
      'TRIGGER trg_account_section_roles__guard',
      'FUNCTION identity.guard_roles_account_sections',
      'TRIGGER trg_roles__account_sections',
      'TRIGGER trg_account_sections__no_truncate',
      'TRIGGER trg_account_section_roles__no_truncate',
    ]);
    // every UPDATE in the file is the content lifecycle of the managed copy (the version DRAFT -> APPROVED -> PUBLISHED steps) and nothing else
    expect([...body.matchAll(/^\s*UPDATE\s+([a-z_]+\.[a-z_]+)/gim)].map((m) => m[1])).toEqual(['content.versions', 'content.versions']);
    expect([...body.matchAll(/\bINSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1]).sort()).toEqual(
      [
        'content.entries',
        'content.entry_variables',
        'content.audit_events',
        'content.versions',
        'content.audit_events',
        'content.audit_events',
        'content.audit_events',
        'content.audit_events',
        'identity.account_sections',
        'identity.account_section_roles',
      ].sort(),
    );
  });
});

/** A fingerprint of every object of the database that does NOT belong to the two new tables (compared before and after 0014). */
async function catalog(from: pg.Pool) {
  const isNew = "(t.relname IN ('account_sections', 'account_section_roles') AND n.nspname = 'identity')";
  const rows = async (text: string) => (await from.query(text)).rows.map((r) => JSON.stringify(r));
  return {
    columns: await rows(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND NOT (table_schema = 'identity' AND table_name IN ('account_sections', 'account_section_roles'))
        ORDER BY table_schema, table_name, ordinal_position`,
    ),
    constraints: await rows(
      `SELECT n.nspname, t.relname, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT ${isNew} ORDER BY n.nspname, t.relname, c.conname COLLATE "C"`,
    ),
    indexes: await rows(
      `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes t2 WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND NOT (schemaname = 'identity' AND tablename IN ('account_sections', 'account_section_roles'))
        ORDER BY schemaname, tablename, indexname COLLATE "C"`,
    ),
    triggers: await rows(
      `SELECT n.nspname, t.relname, g.tgname, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT g.tgisinternal AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT ${isNew} AND g.tgname <> 'trg_roles__account_sections' ORDER BY n.nspname, t.relname, g.tgname COLLATE "C"`,
    ),
    functions: await rows(
      `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src, p.provolatile, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('identity', 'content', 'configuration', 'geography', 'integration', 'public') AND p.proname NOT LIKE 'guard_account_section%' AND p.proname <> 'guard_roles_account_sections' AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY n.nspname, p.proname, args`,
    ),
    comments: await rows(
      `SELECT n.nspname, t.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class t ON t.oid = d.objoid AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname IN ('identity', 'content', 'configuration', 'geography', 'integration', 'public') AND NOT ${isNew} ORDER BY n.nspname, t.relname, d.objsubid`,
    ),
  };
}

// ====================================================================== B. the seed (read from a pristine database)
const SEEDED_SECTIONS: [code: string, route: string, status: string][] = [
  ['CLOSE_ACCOUNT', '/account/close', 'PLANNED'],
  ['CONTACT_VERIFICATION', '/account/contact', 'ACTIVE'],
  ['LANGUAGE_REGION', '/account/language-region', 'ACTIVE'],
  ['NOTIFICATIONS', '/account/notifications', 'PLANNED'],
  ['PRIVACY_DATA', '/account/privacy', 'ACTIVE'],
  ['PROFILE', '/account/profile', 'ACTIVE'],
  ['ROLES', '/account/roles', 'ACTIVE'],
  ['SECURITY', '/account/security', 'ACTIVE'],
];
const SEEDED_LABELS: Record<string, [label: string, description: string]> = {
  CLOSE_ACCOUNT: ['account.area.section.close_account.label', 'account.area.section.close_account.description'],
  CONTACT_VERIFICATION: ['account.area.section.contact_verification.label', 'account.area.section.contact_verification.description'],
  LANGUAGE_REGION: ['account.area.section.language_region.label', 'account.area.section.language_region.description'],
  NOTIFICATIONS: ['account.area.section.notifications.label', 'account.area.section.notifications.description'],
  PRIVACY_DATA: ['account.area.section.privacy_data.label', 'account.area.section.privacy_data.description'],
  PROFILE: ['account.area.section.profile.label', 'account.area.section.profile.description'],
  ROLES: ['account.area.section.roles.label', 'account.area.section.roles.description'],
  SECURITY: ['account.area.section.security.label', 'account.area.section.security.description'],
};
/** The menu of each role today: the same six shared sections, in steps of ten, then the two PLANNED sections switched off. */
const SEEDED_MENU: [code: string, enabled: boolean, order: number][] = [
  ['PROFILE', true, 10],
  ['CONTACT_VERIFICATION', true, 20],
  ['SECURITY', true, 30],
  ['LANGUAGE_REGION', true, 40],
  ['PRIVACY_DATA', true, 50],
  ['ROLES', true, 60],
  ['NOTIFICATIONS', false, 70],
  ['CLOSE_ACCOUNT', false, 80],
];
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

describe('B. the seed: eight sections, a 16-row matrix and 64 managed copy entries', () => {
  it('seeds exactly the eight sections with their exact route, status, label key and description key, and nothing else', async () => {
    const rows = await sq<{ section_code: string; route_path: string; label_content_key: string; description_content_key: string; status: string }>(
      `SELECT section_code, route_path, label_content_key, description_content_key, status FROM ${SECTIONS} ORDER BY section_code COLLATE "C"`,
    );
    expect(rows.map((r) => [r.section_code, r.route_path, r.status])).toEqual(SEEDED_SECTIONS);
    for (const r of rows) expect([r.label_content_key, r.description_content_key], r.section_code).toEqual(SEEDED_LABELS[r.section_code]);
    expect(rows).toHaveLength(8);
  });

  it('agrees with the contract: the section codes of the code are exactly the seeded ones and the helper keys give the seeded label and description keys', async () => {
    expect(Object.values(ACCOUNT_SECTIONS).sort()).toEqual(SEEDED_SECTIONS.map(([c]) => c));
    for (const [code, [label, description]] of Object.entries(SEEDED_LABELS)) {
      expect(accountSectionLabelKey(code), code).toBe(label);
      expect(accountSectionDescriptionKey(code), code).toBe(description);
    }
  });

  it('seeds six ACTIVE and two PLANNED sections, none INACTIVE, and a route under /account that is unique and never the area home', async () => {
    const rows = await sq<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM ${SECTIONS} GROUP BY status ORDER BY status`);
    expect(rows).toEqual([
      { status: 'ACTIVE', n: 6 },
      { status: 'PLANNED', n: 2 },
    ]);
    const routes = (await sq<{ route_path: string }>(`SELECT route_path FROM ${SECTIONS}`)).map((r) => r.route_path);
    expect(new Set(routes).size).toBe(8);
    expect(routes).not.toContain('/account');
  });

  it('seeds exactly 16 matrix rows: every section for CUSTOMER and PROVIDER with the exact enabled flag and display order (gaps of ten)', async () => {
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      const rows = await sq<{ section_code: string; enabled: boolean; display_order: number }>(
        `SELECT sr.section_code, sr.enabled, sr.display_order FROM ${MATRIX} sr JOIN identity.roles r ON r.role_id = sr.role_id WHERE r.code = $1 ORDER BY sr.display_order`,
        [role],
      );
      expect(
        rows.map((r) => [r.section_code, r.enabled, r.display_order]),
        role,
      ).toEqual(SEEDED_MENU);
    }
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${MATRIX}`))[0]!.n).toBe(16);
  });

  it('shows CUSTOMER and PROVIDER the same six sections today, enabled only for ACTIVE sections, and the two PLANNED ones for nobody', async () => {
    const visible = (role: string) =>
      sq<{ section_code: string }>(
        `SELECT sr.section_code FROM ${MATRIX} sr JOIN identity.roles r ON r.role_id = sr.role_id JOIN ${SECTIONS} s ON s.section_code = sr.section_code
          WHERE r.code = $1 AND sr.enabled AND s.status = 'ACTIVE' ORDER BY sr.display_order`,
        [role],
      );
    const expected = ['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES'].map((section_code) => ({ section_code }));
    expect(await visible('CUSTOMER')).toEqual(expected);
    expect(await visible('PROVIDER')).toEqual(expected);
    expect(await sq(`SELECT 1 FROM ${MATRIX} sr JOIN ${SECTIONS} s ON s.section_code = sr.section_code WHERE sr.enabled AND s.status <> 'ACTIVE'`)).toEqual([]);
  });

  it('seeds exactly the 64 account.area.* entries: the keys of the contract (48) plus the 8 section labels and 8 descriptions', async () => {
    const keys = (await sq<{ key: string }>(`SELECT key FROM content.entries WHERE key LIKE 'account.area.%' ORDER BY key COLLATE "C"`)).map((r) => r.key);
    const expected = [
      ...Object.values(ACCOUNT_AREA_COPY),
      ...Object.keys(SEEDED_LABELS).flatMap((c) => [accountSectionLabelKey(c), accountSectionDescriptionKey(c)]),
    ];
    expect(Object.values(ACCOUNT_AREA_COPY)).toHaveLength(48);
    expect(new Set(expected).size).toBe(64);
    expect(keys).toEqual([...expected].sort(cmp));
  });

  it('publishes every one of them through the content lifecycle: one PUBLISHED en-US PLATFORM version 1, open-ended, IN FORCE now, and nothing in another locale', async () => {
    const rows = await sq<{
      key: string;
      n: number;
      locale: string;
      scope_type: string;
      scope_ref: string | null;
      version: number;
      status: string;
      open: boolean;
      started: boolean;
      inforce: string;
      active: boolean;
    }>(
      `SELECT e.key, count(*) OVER (PARTITION BY e.entry_id)::int AS n, v.locale, v.scope_type, v.scope_ref, v.version, v.status, v.effective_to IS NULL AS open,
              v.effective_from <= now() AS started, identity.consent_version_state(v.version_id, e.entry_id, now()) AS inforce, e.is_active AS active
         FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.area.%'`,
    );
    expect(rows).toHaveLength(64);
    for (const r of rows) {
      expect(r, r.key).toEqual({
        key: r.key,
        n: 1,
        locale: 'en-US',
        scope_type: 'PLATFORM',
        scope_ref: null,
        version: 1,
        status: 'PUBLISHED',
        open: true,
        started: true,
        inforce: 'IN_FORCE',
        active: true,
      });
    }
  });

  it('resolves every content key the registry rows name to one of those published entries (a label and a description for each of the eight sections)', async () => {
    const rows = await sq<{ section_code: string; label_ok: boolean; desc_ok: boolean }>(
      `SELECT s.section_code,
              EXISTS (SELECT 1 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = s.label_content_key AND v.status = 'PUBLISHED' AND v.locale = 'en-US'
                        AND identity.consent_version_state(v.version_id, e.entry_id, now()) = 'IN_FORCE') AS label_ok,
              EXISTS (SELECT 1 FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = s.description_content_key AND v.status = 'PUBLISHED' AND v.locale = 'en-US'
                        AND identity.consent_version_state(v.version_id, e.entry_id, now()) = 'IN_FORCE') AS desc_ok
         FROM ${SECTIONS} s ORDER BY s.section_code COLLATE "C"`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) expect({ ...r }, r.section_code).toEqual({ section_code: r.section_code, label_ok: true, desc_ok: true });
  });

  it('resolves every key of the shell and page copy (ACCOUNT_AREA_COPY) to a published entry: a missing key would show a raw key on the page', async () => {
    const found = new Set(
      (
        await sq<{ key: string }>(
          `SELECT e.key FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE v.status = 'PUBLISHED' AND v.locale = 'en-US'`,
        )
      ).map((r) => r.key),
    );
    for (const [name, key] of Object.entries(ACCOUNT_AREA_COPY)) expect(found.has(key), `${name}: ${key}`).toBe(true);
  });

  it('gives section labels the UI_LABEL type and descriptions PLAIN_TEXT; every body is non-empty trimmed text', async () => {
    const rows = await sq<{ key: string; content_type: string; body: string }>(
      `SELECT e.key, e.content_type, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.area.%'`,
    );
    for (const r of rows) {
      expect(r.body, r.key).toBe(r.body.trim());
      expect(r.body.length, r.key).toBeGreaterThan(0);
      if (/^account\.area\.section\..*\.label$/.test(r.key)) expect(r.content_type, r.key).toBe('UI_LABEL');
      if (/^account\.area\.section\..*\.description$/.test(r.key)) expect(r.content_type, r.key).toBe('PLAIN_TEXT');
    }
    expect(rows.filter((r) => r.content_type === 'UI_LABEL').length + rows.filter((r) => r.content_type === 'PLAIN_TEXT').length).toBe(64);
  });

  it('declares exactly three typed variables, a role (STRING) twice and a count (COUNT) once, all required and PII class NONE, and every {placeholder} of a body is one of them', async () => {
    const vars = await sq<{ key: string; name: string; var_type: string; is_required: boolean; pii_class: string }>(
      `SELECT e.key, v.name, v.var_type, v.is_required, v.pii_class FROM content.entry_variables v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key LIKE 'account.area.%' ORDER BY e.key COLLATE "C"`,
    );
    expect(vars).toEqual([
      { key: 'account.area.active_role', name: 'role', var_type: 'STRING', is_required: true, pii_class: 'NONE' },
      { key: 'account.area.privacy.outstanding', name: 'count', var_type: 'COUNT', is_required: true, pii_class: 'NONE' },
      { key: 'account.area.roles.switch', name: 'role', var_type: 'STRING', is_required: true, pii_class: 'NONE' },
    ]);
    const bodies = await sq<{ key: string; body: string }>(
      `SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.area.%'`,
    );
    const declared = new Map<string, string[]>();
    for (const v of vars) declared.set(v.key, [...(declared.get(v.key) ?? []), v.name]);
    // a placeholder is `{name}` or the head of a plural construct `{name, plural, ...}`; the `#` and the branch braces of a plural are not variables
    for (const b of bodies)
      expect([...new Set([...b.body.matchAll(/\{\s*([a-z_]+)\s*[,}]/g)].map((m) => m[1]!))].sort(), b.key).toEqual((declared.get(b.key) ?? []).sort());
  });

  it("renders the privacy summary copy with the content registry's own renderer: singular for one agreement, plural for the others, from the seeded entry", async () => {
    const content = new ContentService({ database: seed.database, env: 'test' });
    const key = 'account.area.privacy.outstanding';
    const text = async (count: number) => (await content.render(key, { locale: 'en-US', variables: { count } })).value;
    expect(await text(1)).toBe('1 agreement needs your attention.');
    expect(await text(2)).toBe('2 agreements need your attention.');
    expect(await text(0)).toBe('0 agreements need your attention.');
    expect(await text(11)).toBe('11 agreements need your attention.');
    // the variable is required and typed: a missing or wrong-typed count is a template error, not a half-rendered sentence
    await expect(content.render(key, { locale: 'en-US', variables: {} })).rejects.toMatchObject({ code: 'TEMPLATE_ERROR' });
    await expect(content.render(key, { locale: 'en-US', variables: { count: 'two' } })).rejects.toMatchObject({ code: 'TEMPLATE_ERROR' });
    // the other two copies with a variable render their role name
    expect((await content.render('account.area.active_role', { locale: 'en-US', variables: { role: 'Provider' } })).value).toBe('Current role: Provider');
    expect((await content.render('account.area.roles.switch', { locale: 'en-US', variables: { role: 'Customer' } })).value).toBe('Switch to Customer');
  });

  it('writes the content audit trail exactly like the real workflow: five rows per entry, in order, by system:migration under the correlation seed-0014', async () => {
    const rows = await sq<{ action: string; actor: string; correlation_id: string; n: number }>(
      `SELECT a.action, a.actor, a.correlation_id, count(*)::int AS n FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key LIKE 'account.area.%'
        GROUP BY 1, 2, 3 ORDER BY 1`,
    );
    expect(rows).toEqual(
      ['ENTRY_CREATED', 'VERSION_ACTIVATED', 'VERSION_APPROVED', 'VERSION_DRAFTED', 'VERSION_PUBLISHED'].map((action) => ({
        action,
        actor: 'system:migration',
        correlation_id: 'seed-0014',
        n: 64,
      })),
    );
    const order = await sq<{ actions: string[] }>(
      `SELECT array_agg(a.action ORDER BY a.occurred_at, a.audit_event_id) AS actions FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key = 'account.area.title'`,
    );
    expect(order[0]!.actions).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
  });

  it('seeds the registry rows with consistent timestamps (created_at = updated_at, one transaction instant) and creates no account, audit row or outbox event', async () => {
    expect(await sq(`SELECT 1 FROM ${SECTIONS} WHERE created_at <> updated_at`)).toEqual([]);
    expect(await sq(`SELECT 1 FROM ${MATRIX} WHERE created_at <> updated_at`)).toEqual([]);
    expect(
      (
        await sq<{ n: number }>(
          `SELECT count(DISTINCT created_at)::int AS n FROM (SELECT created_at FROM ${SECTIONS} UNION ALL SELECT created_at FROM ${MATRIX}) t`,
        )
      )[0]!.n,
    ).toBe(1);
    expect((await sq<{ n: number }>('SELECT count(*)::int AS n FROM identity.accounts'))[0]!.n).toBe(0);
    expect((await sq<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_audit_events'))[0]!.n).toBe(0);
  });

  it('refuses to change or delete a seeded registry row except through the documented switches: the seeded rows are still intact afterwards', async () => {
    await expect(seedPool.query(`DELETE FROM ${SECTIONS} WHERE section_code = 'PROFILE'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'identity_rule:SECTION_NOT_DELETABLE',
    });
    await expect(seedPool.query(`DELETE FROM ${MATRIX}`)).rejects.toMatchObject({ code: '23000', detail: 'identity_rule:SECTION_ROLE_NOT_DELETABLE' });
    await expect(seedPool.query(`UPDATE ${SECTIONS} SET status = 'INACTIVE' WHERE section_code = 'PROFILE'`)).rejects.toMatchObject({
      code: '23000',
      detail: 'identity_rule:SECTION_IN_USE',
    });
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${MATRIX} WHERE enabled`))[0]!.n).toBe(12);
    expect((await sq<{ n: number }>(`SELECT count(*)::int AS n FROM ${SECTIONS} WHERE status = 'ACTIVE'`))[0]!.n).toBe(6);
  });
});

// ====================================================================== C. every CHECK, foreign key, unique key and NOT NULL, by constraint name
type Attempt = () => Promise<unknown>;
interface ConstraintCase {
  constraint: string;
  label: string;
  attempt: Attempt;
}
const bad = (constraint: string, label: string, attempt: Attempt): ConstraintCase => ({ constraint, label, attempt });
const insertSectionRaw = (code: string, route: string, label: string, description: string | null, status: string) =>
  run('INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES ($1, $2, $3, $4, $5)', [
    code,
    route,
    label,
    description,
    status,
  ]);
const okSection = (): { code: string; route: string } => {
  const n = ++seq;
  return { code: `OK_${n}`, route: `/account/ok-${n}` };
};

const BAD_CODES: [label: string, value: string][] = [
  ['an empty code', ''],
  ['a single character', 'A'],
  ['a lower-case code', 'profile'],
  ['a mixed-case code', 'Profile'],
  ['a code that starts with a digit', '1PROFILE'],
  ['a code that starts with an underscore', '_PROFILE'],
  ['a code with a dash', 'PRO-FILE'],
  ['a code with a space', 'PRO FILE'],
  ['a code with a trailing space', 'PROFILE '],
  ['a code with a trailing line feed', `PROFILE${ch(0x0a)}`],
  ['a code with a leading line feed', `${ch(0x0a)}PROFILE`],
  ['a code with a dot', 'PRO.FILE'],
  ['a 41-character code', `A${'B'.repeat(40)}`],
  ['a code with a full-width letter', `PRO${ch(0xff21)}`],
  ['a code with an accented letter', `PRO${ch(0xc9)}`],
  ['a code with a zero-width space', `PRO${ch(0x200b)}FILE`],
];
const BAD_ROUTES: [label: string, value: string][] = [
  ['the area home without a slash', '/account'],
  ['the area home with a trailing slash', '/account/'],
  ['an upper-case prefix', '/Account/x'],
  ['an upper-case segment', '/account/Profile'],
  ['a one-character slug (the slug needs two or more)', '/account/x'],
  ['a slug with a space', '/account/a b'],
  ['a nested path', '/account/x/y'],
  ['a trailing slash', '/account/profile/'],
  ['a missing leading slash', 'account/profile'],
  ['a slug that starts with a digit', '/account/1ab'],
  ['a slug that starts with a dash', '/account/-ab'],
  ['a slug with an underscore', '/account/ab_c'],
  ['a slug with a trailing line feed', `/account/ab${ch(0x0a)}`],
  ['a 41-character slug', `/account/${'a'.repeat(41)}`],
  ['a slug with an accented letter', `/account/a${ch(0xe9)}`],
  ['a slug with a zero-width space', `/account/a${ch(0x200b)}b`],
  ['another prefix', '/accounts/profile'],
  ['a query string', '/account/profile?x=1'],
  ['a fragment', '/account/profile#x'],
  ['an absolute URL', 'https://example.test/account/profile'],
  ['an empty path', ''],
];
const BAD_KEYS: [label: string, value: string][] = [
  ['an empty key', ''],
  ['a key without a dot', 'nodot'],
  ['an upper-case key', 'Account.area.title'],
  ['a key that starts with a dot', '.account.area'],
  ['a key with a double dot', 'account..area'],
  ['a key with a dash', 'account.area-title'],
  ['a key with a trailing dot', 'account.area.'],
  ['a key with a space', 'account.area title'],
  ['a key that starts with a digit', '1account.area'],
  ['a key with a trailing line feed', `account.area${ch(0x0a)}`],
];

const SECTION_CASES: ConstraintCase[] = [
  ...BAD_CODES.map(([label, value]) =>
    bad('ck_account_sections__section_code_format', `section_code: ${label}`, () => insertSectionRaw(value, okSection().route, KEY, null, 'PLANNED')),
  ),
  ...BAD_ROUTES.map(([label, value]) =>
    bad('ck_account_sections__route_path_format', `route_path: ${label}`, () => insertSectionRaw(okSection().code, value, KEY, null, 'PLANNED')),
  ),
  ...BAD_KEYS.map(([label, value]) =>
    bad('ck_account_sections__label_content_key_format', `label_content_key: ${label}`, () =>
      insertSectionRaw(okSection().code, okSection().route, value, null, 'PLANNED'),
    ),
  ),
  ...BAD_KEYS.map(([label, value]) =>
    bad('ck_account_sections__description_content_key_format', `description_content_key: ${label}`, () =>
      insertSectionRaw(okSection().code, okSection().route, KEY, value, 'PLANNED'),
    ),
  ),
  ...['active', 'DELETED', 'RETIRED', '', 'ACTIVE ', 'Planned'].map((v) =>
    bad('ck_account_sections__status', `status "${v}"`, () => insertSectionRaw(okSection().code, okSection().route, KEY, null, v)),
  ),
  bad('ck_account_sections__status', 'an update to an unknown status', async () => {
    const code = await makeSection();
    await run("UPDATE identity.account_sections SET status = 'GONE' WHERE section_code = $1", [code]);
  }),
  bad('ck_account_sections__route_path_format', 'an update of the route to a nested path', async () => {
    const code = await makeSection();
    await run("UPDATE identity.account_sections SET route_path = '/account/x/y' WHERE section_code = $1", [code]);
  }),
  bad('pk_account_sections', 'a duplicate section code', async () => {
    const code = await makeSection();
    await insertSectionRaw(code, okSection().route, KEY, null, 'PLANNED');
  }),
  bad('uq_account_sections__route_path', 'a second section on the same route (one page per section)', async () => {
    await insertSectionRaw(okSection().code, '/account/profile', KEY, null, 'PLANNED');
  }),
  bad('uq_account_sections__route_path', 'an update of the route onto the route of another section', async () => {
    const code = await makeSection();
    await run("UPDATE identity.account_sections SET route_path = '/account/security' WHERE section_code = $1", [code]);
  }),
  bad('fk_account_sections__label_content_key', 'a label key that is not a content entry', () =>
    insertSectionRaw(okSection().code, okSection().route, 'account.area.section.nonexistent.label', null, 'PLANNED'),
  ),
  bad('fk_account_sections__description_content_key', 'a description key that is not a content entry', () =>
    insertSectionRaw(okSection().code, okSection().route, KEY, 'account.area.section.nonexistent.description', 'PLANNED'),
  ),
  bad('fk_account_sections__label_content_key', 'an update of the label to a key that is not a content entry', async () => {
    const code = await makeSection();
    await run("UPDATE identity.account_sections SET label_content_key = 'account.area.nope.label' WHERE section_code = $1", [code]);
  }),
];
describe('C1. account_sections: every constraint rejects bad data, by constraint name', () => {
  it.each(SECTION_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    const e = await fail(attempt());
    expect(e.constraint).toBe(constraint);
    expect(e.code).toBe(constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505');
  });

  it('accepts the boundary values the checks allow: 2- and 40-character codes with digits and underscores, 2- and 40-character slugs with digits and dashes, a NULL description', async () => {
    const shortCode = `Z${++seq % 10}`;
    for (const [code, route] of [
      [shortCode, '/account/ab'],
      ['A'.repeat(40), `/account/${'a'.repeat(40)}`],
      ['A1_2_3_4', '/account/a-1-2-3'],
      ['ZZ_NULL_DESCRIPTION', '/account/a9'],
    ] as const) {
      await insertSectionRaw(code, route, KEY, code === 'ZZ_NULL_DESCRIPTION' ? null : DESC_KEY, 'PLANNED');
    }
    expect(await count(SECTIONS, "section_code IN ($1, $2, 'A1_2_3_4', 'ZZ_NULL_DESCRIPTION')", [shortCode, 'A'.repeat(40)])).toBe(4);
    expect(
      (await q<{ description_content_key: string | null }>(`SELECT description_content_key FROM ${SECTIONS} WHERE section_code = 'ZZ_NULL_DESCRIPTION'`))[0]!
        .description_content_key,
    ).toBeNull();
  });

  it('refuses NULL in every NOT NULL column by column name (code, route, label, status, both timestamps) but accepts a NULL description', async () => {
    const n = okSection();
    const vals = (over: Record<string, unknown>) => ({
      section_code: n.code,
      route_path: n.route,
      label_content_key: KEY,
      status: 'PLANNED',
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    });
    const insert = (v: Record<string, unknown>) =>
      run(
        `INSERT INTO ${SECTIONS} (${Object.keys(v).join(', ')}) VALUES (${Object.keys(v)
          .map((_, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(v),
      );
    for (const col of ['section_code', 'route_path', 'label_content_key', 'status', 'created_at', 'updated_at'])
      await expectNotNull(insert(vals({ [col]: null })), col);
    await insert(vals({ description_content_key: null }));
  });

  it('defaults the status to PLANNED and both timestamps to the transaction instant (created_at equals updated_at)', async () => {
    const n = okSection();
    await run('INSERT INTO identity.account_sections (section_code, route_path, label_content_key) VALUES ($1, $2, $3)', [n.code, n.route, KEY]);
    const row = await sectionRow(n.code);
    expect(row.status).toBe('PLANNED');
    expect(row.created_at.getTime()).toBe(row.updated_at.getTime());
    expect(Math.abs(row.created_at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

const MATRIX_CASES: ConstraintCase[] = [
  ...[0, -1, 10000, 2147483647].map((v) =>
    bad('ck_account_section_roles__display_order', `display_order ${v}`, async () => {
      const code = await makeSection({ status: 'ACTIVE' });
      await makeRow(code, 'CUSTOMER', { enabled: false, order: v });
    }),
  ),
  bad('ck_account_section_roles__display_order', 'an enabled row with display_order 0 (the guard accepts it, the CHECK refuses it)', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await makeRow(code, 'CUSTOMER', { enabled: true, order: 0 });
  }),
  bad('ck_account_section_roles__display_order', 'an update to display_order 0', async () => {
    const code = await activeSection();
    await run('UPDATE identity.account_section_roles SET display_order = 0 WHERE section_code = $1', [code]);
  }),
  bad('ck_account_section_roles__display_order', 'an update to display_order 10000', async () => {
    const code = await activeSection();
    await run('UPDATE identity.account_section_roles SET display_order = 10000 WHERE section_code = $1', [code]);
  }),
  bad('pk_account_section_roles', 'a second row for the same section and role', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await makeRow(code, 'CUSTOMER');
    await makeRow(code, 'CUSTOMER');
  }),
  bad('uq_account_section_roles__role_order', 'two sections at the same position of one role (enabled or not)', async () => {
    const [a, b] = [await makeSection({ status: 'ACTIVE' }), await makeSection({ status: 'ACTIVE' })];
    const order = await makeRow(a, 'PROVIDER', { enabled: false });
    await makeRow(b, 'PROVIDER', { enabled: false, order });
  }),
  bad('uq_account_section_roles__role_order', 'a disabled row blocks the position of an enabled one', async () => {
    const [a, b] = [await makeSection({ status: 'ACTIVE' }), await makeSection({ status: 'ACTIVE' })];
    const order = await makeRow(a, 'CUSTOMER', { enabled: false });
    await makeRow(b, 'CUSTOMER', { enabled: true, order });
  }),
  bad('uq_account_section_roles__role_order', 'an update onto the position of another section of the role', async () => {
    const [a, b] = [await makeSection({ status: 'ACTIVE' }), await makeSection({ status: 'ACTIVE' })];
    const order = await makeRow(a, 'CUSTOMER');
    await makeRow(b, 'CUSTOMER');
    await run('UPDATE identity.account_section_roles SET display_order = $2 WHERE section_code = $1', [b, order]);
  }),
  bad('uq_account_section_roles__role_order', 'the seeded position 10 of PROVIDER', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await makeRow(code, 'PROVIDER', { order: 10 });
  }),
  bad('fk_account_section_roles__role_id', 'a role that does not exist (disabled row: the guard lets it through to the foreign key)', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await run('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, gen_random_uuid(), false, $2)', [
      code,
      nextOrder(),
    ]);
  }),
  bad('fk_account_section_roles__section_code', 'a section that does not exist (disabled row)', async () => {
    await run('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, false, $3)', [
      'NO_SUCH_SECTION',
      await roleId('CUSTOMER'),
      nextOrder(),
    ]);
  }),
];
describe('C2. account_section_roles: every constraint rejects bad data, by constraint name', () => {
  it.each(MATRIX_CASES)('$constraint: $label', async ({ constraint, attempt }) => {
    const e = await fail(attempt());
    expect(e.constraint).toBe(constraint);
    expect(e.code).toBe(constraint.startsWith('ck_') ? '23514' : constraint.startsWith('fk_') ? '23503' : '23505');
  });

  it('accepts the boundary positions 1 and 9999, the same position for two DIFFERENT roles, and the same section for two roles', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await makeRow(code, 'CUSTOMER', { order: 9999 });
    await makeRow(code, 'PROVIDER', { order: 9999 });
    const other = await makeSection({ status: 'ACTIVE' });
    await makeRow(other, 'CUSTOMER', { order: 1, enabled: true });
    expect((await matrixRow(code, 'CUSTOMER')).display_order).toBe(9999);
    expect((await matrixRow(code, 'PROVIDER')).display_order).toBe(9999);
    expect((await matrixRow(other, 'CUSTOMER')).display_order).toBe(1);
    // free the positions again: the later tests of this file use the low and the high end
    await run('UPDATE identity.account_section_roles SET display_order = $2 WHERE section_code = $1', [code, nextOrder()]);
    await run('UPDATE identity.account_section_roles SET display_order = $2 WHERE section_code = $1 AND role_id = $3', [
      other,
      nextOrder(),
      await roleId('CUSTOMER'),
    ]);
  });

  it('refuses NULL in every NOT NULL column by column name', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    const role = await roleId('CUSTOMER');
    const vals = (over: Record<string, unknown>) => ({
      section_code: code,
      role_id: role,
      enabled: false,
      display_order: nextOrder(),
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    });
    const insert = (v: Record<string, unknown>) =>
      run(
        `INSERT INTO ${MATRIX} (${Object.keys(v).join(', ')}) VALUES (${Object.keys(v)
          .map((_, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(v),
      );
    // updated_at is not listed: the guard overwrites it with now() before the NOT NULL check, so a NULL never reaches the column
    for (const col of ['section_code', 'role_id', 'display_order', 'created_at']) await expectNotNull(insert(vals({ [col]: null })), col);
    await expectNotNull(insert(vals({ enabled: null })), 'enabled'); // the guard sees NULL as "not enabled" and lets it through to the NOT NULL check
    expect(await count(MATRIX, 'section_code = $1', [code])).toBe(0);
  });

  it('defaults enabled to false and both timestamps to the transaction instant; a row with no flag is never shown', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await run('INSERT INTO identity.account_section_roles (section_code, role_id, display_order) VALUES ($1, $2, $3)', [
      code,
      await roleId('CUSTOMER'),
      nextOrder(),
    ]);
    const row = await matrixRow(code, 'CUSTOMER');
    expect(row.enabled).toBe(false);
    expect(row.created_at.getTime()).toBe(row.updated_at.getTime());
  });
});

// ====================================================================== D. the guard rules: the exact failing statement of every rule key
describe('D1. guard_account_sections: SECTION_NOT_DELETABLE, SECTION_CODE_IMMUTABLE, SECTION_IN_USE', () => {
  it('SECTION_NOT_DELETABLE: refuses to delete a section with no matrix row, one with rows, a seeded one, and every section at once', async () => {
    const lone = await makeSection();
    await expectRule(run('DELETE FROM identity.account_sections WHERE section_code = $1', [lone]), 'SECTION_NOT_DELETABLE');
    await expectRule(run("DELETE FROM identity.account_sections WHERE section_code = 'SECURITY'"), 'SECTION_NOT_DELETABLE');
    await expectRule(run('DELETE FROM identity.account_sections'), 'SECTION_NOT_DELETABLE');
    expect(await count(SECTIONS, 'section_code = $1', [lone])).toBe(1);
    expect(await count(SECTIONS)).toBeGreaterThanOrEqual(8);
  });

  it('SECTION_CODE_IMMUTABLE: refuses to change the code, to the same code in another case, and reports it before every other rule', async () => {
    const code = await makeSection({ status: 'ACTIVE' });
    await expectRule(run("UPDATE identity.account_sections SET section_code = 'RENAMED_SECTION' WHERE section_code = $1", [code]), 'SECTION_CODE_IMMUTABLE');
    await expectRule(run("UPDATE identity.account_sections SET section_code = lower(section_code) WHERE section_code = 'PROFILE'"), 'SECTION_CODE_IMMUTABLE');
    // a rename together with a retirement of a section that is in use: the code rule comes first
    await expectRule(
      run("UPDATE identity.account_sections SET section_code = 'XX_PROFILE', status = 'INACTIVE' WHERE section_code = 'PROFILE'"),
      'SECTION_CODE_IMMUTABLE',
    );
    expect(await count(SECTIONS, "section_code IN ('RENAMED_SECTION', 'XX_PROFILE')")).toBe(0);
    expect((await sectionRow(code)).status).toBe('ACTIVE');
  });

  it('SECTION_CODE_IMMUTABLE: an update that sets the code to the same value is accepted (nothing changes)', async () => {
    const code = await makeSection();
    await run('UPDATE identity.account_sections SET section_code = section_code, status = $2 WHERE section_code = $1', [code, 'PLANNED']);
    expect((await sectionRow(code)).status).toBe('PLANNED');
  });

  it('SECTION_IN_USE: a section that a role shows cannot leave ACTIVE, neither for PLANNED nor for INACTIVE, and keeps its status and its rows', async () => {
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    for (const to of ['PLANNED', 'INACTIVE']) {
      await expectRule(setStatus(code, to), 'SECTION_IN_USE');
      expect((await sectionRow(code)).status).toBe('ACTIVE');
    }
    expect((await matrixRow(code, 'CUSTOMER')).enabled).toBe(true);
    // one role still shows it after the other stopped: still in use
    await setEnabled(code, 'PROVIDER', true);
    await setEnabled(code, 'CUSTOMER', false);
    await expectRule(setStatus(code, 'INACTIVE'), 'SECTION_IN_USE');
  });

  it('SECTION_IN_USE: a seeded ACTIVE section cannot be retired and a PLANNED one needs no switch-off (it has none enabled)', async () => {
    await expectRule(setStatus('PROFILE', 'INACTIVE'), 'SECTION_IN_USE');
    await expectRule(setStatus('ROLES', 'PLANNED'), 'SECTION_IN_USE');
    await setStatus('NOTIFICATIONS', 'INACTIVE'); // PLANNED -> INACTIVE: not leaving ACTIVE
    await setStatus('NOTIFICATIONS', 'PLANNED');
    expect((await sectionRow('NOTIFICATIONS')).status).toBe('PLANNED');
  });

  it('retires a section after it is switched off for EVERY role, and it can then be brought back to ACTIVE and shown again', async () => {
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    await setEnabled(code, 'PROVIDER', true);
    await setEnabled(code, 'CUSTOMER', false);
    await expectRule(setStatus(code, 'INACTIVE'), 'SECTION_IN_USE');
    await setEnabled(code, 'PROVIDER', false);
    await setStatus(code, 'INACTIVE');
    expect((await sectionRow(code)).status).toBe('INACTIVE');
    await expectRule(setEnabled(code, 'CUSTOMER', true), 'SECTION_NOT_ACTIVE');
    await setStatus(code, 'ACTIVE');
    await setEnabled(code, 'CUSTOMER', true);
    expect((await matrixRow(code, 'CUSTOMER')).enabled).toBe(true);
  });

  it('allows the changes the rules do not cover: a section that is ACTIVE stays ACTIVE, and its route, label and description can be corrected while a role shows it', async () => {
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    await setStatus(code, 'ACTIVE');
    await run(
      "UPDATE identity.account_sections SET route_path = $2, label_content_key = 'account.area.title', description_content_key = NULL WHERE section_code = $1",
      [code, `/account/moved-${++seq}`],
    );
    const row = (
      await q<{ label_content_key: string; description_content_key: string | null }>(
        `SELECT label_content_key, description_content_key FROM ${SECTIONS} WHERE section_code = $1`,
        [code],
      )
    )[0]!;
    expect(row).toEqual({ label_content_key: 'account.area.title', description_content_key: null });
  });
});

describe('D2. guard_account_section_roles: SECTION_ROLE_NOT_DELETABLE, SECTION_ROLE_KEY_IMMUTABLE, SECTION_NOT_ACTIVE, ROLE_NOT_ACTIVE', () => {
  it('SECTION_ROLE_NOT_DELETABLE: refuses to delete a disabled row, an enabled row, a seeded row and every row at once', async () => {
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    await expectRule(
      run('DELETE FROM identity.account_section_roles WHERE section_code = $1 AND role_id = $2', [code, await roleId('PROVIDER')]),
      'SECTION_ROLE_NOT_DELETABLE',
    );
    await expectRule(
      run('DELETE FROM identity.account_section_roles WHERE section_code = $1 AND role_id = $2', [code, await roleId('CUSTOMER')]),
      'SECTION_ROLE_NOT_DELETABLE',
    );
    await expectRule(run("DELETE FROM identity.account_section_roles WHERE section_code = 'PROFILE'"), 'SECTION_ROLE_NOT_DELETABLE');
    await expectRule(run('DELETE FROM identity.account_section_roles'), 'SECTION_ROLE_NOT_DELETABLE');
    expect(await count(MATRIX, 'section_code = $1', [code])).toBe(2);
  });

  it('SECTION_ROLE_KEY_IMMUTABLE: refuses to move a row to another section or another role, disabled or enabled, and reports it before the activity rules', async () => {
    const [a, b] = [await activeSection(), await activeSection()];
    await expectRule(
      run('UPDATE identity.account_section_roles SET section_code = $2 WHERE section_code = $1 AND role_id = $3', [a, b, await roleId('CUSTOMER')]),
      'SECTION_ROLE_KEY_IMMUTABLE',
    );
    await expectRule(
      run('UPDATE identity.account_section_roles SET role_id = $2 WHERE section_code = $1 AND role_id = $3', [
        a,
        await roleId('CUSTOMER'),
        await roleId('PROVIDER'),
      ]),
      'SECTION_ROLE_KEY_IMMUTABLE',
    );
    await setEnabled(a, 'CUSTOMER', true);
    await expectRule(
      run('UPDATE identity.account_section_roles SET section_code = $2 WHERE section_code = $1 AND role_id = $3', [a, 'PROFILE', await roleId('CUSTOMER')]),
      'SECTION_ROLE_KEY_IMMUTABLE',
    );
    // a move to an unknown section together with enabled = true: the key rule comes before SECTION_NOT_ACTIVE
    await expectRule(
      run('UPDATE identity.account_section_roles SET section_code = $2, enabled = true WHERE section_code = $1 AND role_id = $3', [
        a,
        'NO_SUCH_SECTION',
        await roleId('PROVIDER'),
      ]),
      'SECTION_ROLE_KEY_IMMUTABLE',
    );
    expect((await matrixRow(a, 'CUSTOMER')).enabled).toBe(true);
    expect(await count(MATRIX, 'section_code = $1', [a])).toBe(2);
  });

  it('SECTION_NOT_ACTIVE: refuses to enable a row of a PLANNED or INACTIVE section, by INSERT and by UPDATE, and of a section that does not exist', async () => {
    for (const status of ['PLANNED', 'INACTIVE']) {
      const code = await makeSection({ status });
      await expectRule(makeRow(code, 'CUSTOMER', { enabled: true }), 'SECTION_NOT_ACTIVE');
      expect(await count(MATRIX, 'section_code = $1', [code])).toBe(0);
      await makeRow(code, 'CUSTOMER', { enabled: false });
      await expectRule(setEnabled(code, 'CUSTOMER', true), 'SECTION_NOT_ACTIVE');
      expect((await matrixRow(code, 'CUSTOMER')).enabled).toBe(false);
    }
    await expectRule(
      run('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
        'NO_SUCH_SECTION',
        await roleId('CUSTOMER'),
        nextOrder(),
      ]),
      'SECTION_NOT_ACTIVE',
    );
  });

  it('SECTION_NOT_ACTIVE: enabling a row of a seeded PLANNED section fails, and works once the section is switched ACTIVE (and the section then cannot be retired again)', async () => {
    await expectRule(setEnabled('NOTIFICATIONS', 'CUSTOMER', true), 'SECTION_NOT_ACTIVE');
    await expectRule(setEnabled('CLOSE_ACCOUNT', 'PROVIDER', true), 'SECTION_NOT_ACTIVE');
    await setStatus('NOTIFICATIONS', 'ACTIVE');
    await setEnabled('NOTIFICATIONS', 'CUSTOMER', true);
    expect((await matrixRow('NOTIFICATIONS', 'CUSTOMER')).enabled).toBe(true);
    await expectRule(setStatus('NOTIFICATIONS', 'PLANNED'), 'SECTION_IN_USE');
    // restore the seeded state: switch it off, back to PLANNED
    await setEnabled('NOTIFICATIONS', 'CUSTOMER', false);
    await setStatus('NOTIFICATIONS', 'PLANNED');
    expect(await violations()).toEqual([]);
  });

  it('SECTION_NOT_ACTIVE: switching a row OFF is always allowed, whatever the status of the section', async () => {
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    await setEnabled(code, 'CUSTOMER', false);
    await setEnabled(code, 'CUSTOMER', false);
    // a disabled row of a non-ACTIVE section can be written too (display order, no change)
    await setStatus(code, 'INACTIVE');
    await run('UPDATE identity.account_section_roles SET display_order = $2 WHERE section_code = $1 AND role_id = $3', [
      code,
      nextOrder(),
      await roleId('CUSTOMER'),
    ]);
    expect((await matrixRow(code, 'CUSTOMER')).enabled).toBe(false);
  });

  it('ROLE_NOT_ACTIVE: refuses to enable a row for an INACTIVE role (insert and update) and for a role that does not exist, and accepts the row once the role is ACTIVE again', async () => {
    const role = await newRole('INACTIVE');
    const code = await activeSection();
    const extra = await makeSection({ status: 'ACTIVE' });
    await makeRow(code, role, { enabled: false });
    await expectRule(setEnabled(code, role, true), 'ROLE_NOT_ACTIVE');
    await expectRule(makeRow(extra, role, { enabled: true }), 'ROLE_NOT_ACTIVE');
    await makeRow(extra, role, { enabled: false }); // a disabled row for an inactive role is fine
    expect((await matrixRow(code, role)).enabled).toBe(false);
    await setEnabled(code, 'CUSTOMER', true); // the other roles are unaffected
    await setRoleStatus(role, 'ACTIVE');
    await setEnabled(code, role, true);
    expect((await matrixRow(code, role)).enabled).toBe(true);
    const missing = await makeSection({ status: 'ACTIVE' });
    await expectRule(
      run('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, gen_random_uuid(), true, $2)', [
        missing,
        nextOrder(),
      ]),
      'ROLE_NOT_ACTIVE',
    );
  });

  it('applies the rules in a fixed order: KEY_IMMUTABLE, then SECTION_NOT_ACTIVE, then ROLE_NOT_ACTIVE (a row that breaks both of the last two reports the section)', async () => {
    const role = await newRole('INACTIVE');
    const planned = await makeSection({ status: 'PLANNED' });
    await makeRow(planned, role);
    await expectRule(setEnabled(planned, role, true), 'SECTION_NOT_ACTIVE');
    const active = await makeSection({ status: 'ACTIVE' });
    await makeRow(active, role);
    await expectRule(setEnabled(active, role, true), 'ROLE_NOT_ACTIVE');
  });

  it('a row of an INACTIVE role (crafted with the role trigger bypassed) cannot be re-ordered while enabled, but can be switched off', async () => {
    const role = await newRole();
    const code = await activeSection();
    await makeRow(code, role, { enabled: true });
    // the state ROLE_HAS_SECTIONS forbids: reach it by bypassing the role trigger in one rolled-back-free transaction (commit), as the table owner
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE identity.roles DISABLE TRIGGER USER');
      await setRoleStatus(role, 'INACTIVE', c);
      await c.query('ALTER TABLE identity.roles ENABLE TRIGGER USER');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await expectRule(
      run('UPDATE identity.account_section_roles SET display_order = $3 WHERE section_code = $1 AND role_id = $2', [code, await roleId(role), nextOrder()]),
      'ROLE_NOT_ACTIVE',
    );
    await setEnabled(code, role, false);
    expect((await matrixRow(code, role)).enabled).toBe(false);
  });

  it('a statement that touches many rows applies the rules row by row: one bad row fails the whole statement and leaves every row as it was', async () => {
    const [a, b] = [await activeSection(), await makeSection({ status: 'PLANNED' })];
    await makeRow(b, 'CUSTOMER');
    await expectRule(
      run('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = ANY($1::text[]) AND role_id = $2', [[a, b], await roleId('CUSTOMER')]),
      'SECTION_NOT_ACTIVE',
    );
    expect((await matrixRow(a, 'CUSTOMER')).enabled).toBe(false);
    expect((await matrixRow(b, 'CUSTOMER')).enabled).toBe(false);
  });

  it('keeps the seeded matrix intact through all of the above (the seeded rows are the ones the seed wrote, apart from rows the tests added)', async () => {
    const menu = await q<{ section_code: string; enabled: boolean; display_order: number }>(
      `SELECT section_code, enabled, display_order FROM ${MATRIX} WHERE section_code = ANY($1::text[]) AND role_id = $2 ORDER BY display_order`,
      [SEEDED_SECTIONS.map(([c]) => c), await roleId('CUSTOMER')],
    );
    expect(menu.map((r) => [r.section_code, r.enabled, r.display_order])).toEqual(SEEDED_MENU);
  });
});

describe('D4. guard_roles_account_sections: ROLE_HAS_SECTIONS', () => {
  it('refuses to retire a role while a row is enabled for it, whatever the target status, and changes nothing (the other half of the invariant)', async () => {
    const role = await newRole();
    const code = await activeSection();
    await makeRow(code, role, { enabled: true });
    for (const to of ['INACTIVE'] as const) {
      await expectRule(setRoleStatus(role, to), 'ROLE_HAS_SECTIONS');
      expect((await q<{ status: string }>('SELECT status FROM identity.roles WHERE code = $1', [role]))[0]!.status).toBe('ACTIVE');
    }
    expect((await matrixRow(code, role)).enabled).toBe(true);
    expect(await violations()).toEqual([]);
  });

  it('refuses it for the seeded roles too (six enabled rows each), by an UPDATE of the status alone and together with other columns', async () => {
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      await expectRule(setRoleStatus(role, 'INACTIVE'), 'ROLE_HAS_SECTIONS');
      await expectRule(
        run("UPDATE identity.roles SET status = 'INACTIVE', updated_at = now(), name_content_key = name_content_key WHERE code = $1", [role]),
        'ROLE_HAS_SECTIONS',
      );
    }
    await expectRule(run("UPDATE identity.roles SET status = 'INACTIVE'"), 'ROLE_HAS_SECTIONS'); // every role at once
    expect((await q<{ status: string }>("SELECT status FROM identity.roles WHERE code IN ('CUSTOMER', 'PROVIDER')")).map((r) => r.status)).toEqual([
      'ACTIVE',
      'ACTIVE',
    ]);
    expect(await count('identity.roles', "status <> 'ACTIVE' AND code IN ('CUSTOMER', 'PROVIDER')")).toBe(0);
  });

  it('allows the retirement once every row of the role is switched off (off first, then retire), keeps the disabled rows and then refuses to enable them again (ROLE_NOT_ACTIVE)', async () => {
    const role = await newRole();
    const [a, b] = [await activeSection(), await activeSection()];
    await makeRow(a, role, { enabled: true });
    await makeRow(b, role, { enabled: true });
    await setEnabled(a, role, false);
    await expectRule(setRoleStatus(role, 'INACTIVE'), 'ROLE_HAS_SECTIONS'); // one row is still on
    await setEnabled(b, role, false);
    await setRoleStatus(role, 'INACTIVE');
    expect((await q<{ status: string }>('SELECT status FROM identity.roles WHERE code = $1', [role]))[0]!.status).toBe('INACTIVE');
    expect(await count(MATRIX, 'role_id = $1', [await roleId(role)])).toBe(2);
    await expectRule(setEnabled(a, role, true), 'ROLE_NOT_ACTIVE');
    // and back: ACTIVE again, the rows can be switched on
    await setRoleStatus(role, 'ACTIVE');
    await setEnabled(a, role, true);
    expect((await matrixRow(a, role)).enabled).toBe(true);
  });

  it("only watches the way OUT of ACTIVE: ACTIVE to ACTIVE, other columns, and a rows-free INACTIVE to ACTIVE all pass, and another role's rows do not matter", async () => {
    const role = await newRole();
    const other = await newRole();
    const code = await activeSection();
    await makeRow(code, other, { enabled: true }); // a different role has an enabled row
    await setRoleStatus(role, 'ACTIVE');
    await run("UPDATE identity.roles SET name_content_key = 'identity.role.provider.name', updated_at = now() WHERE code = $1", [role]);
    await setRoleStatus(role, 'INACTIVE'); // no row of THIS role is enabled
    await setRoleStatus(role, 'ACTIVE');
    await run("UPDATE identity.roles SET name_content_key = 'identity.role.provider.name', updated_at = now() WHERE code = $1", [other]); // enabled rows, but not a status change
    expect((await matrixRow(code, other)).enabled).toBe(true);
  });

  it('is a second, independent guard: the older role rules of 0009 still apply (a role held by an account cannot be retired, the code is immutable, a role is never deleted)', async () => {
    const role = await newRole();
    await expectRule(run('UPDATE identity.roles SET code = $2 WHERE code = $1', [role, `${role}X`]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('DELETE FROM identity.roles WHERE code = $1', [role]), 'NOT_DELETABLE');
  });

  it('serializes with an enable under real concurrency, both orders: holding the enable back-pressures the retirement, which is then refused; a retirement in flight makes the enable wait and be refused', async () => {
    // order 1: the enabling transaction is open (role row held FOR SHARE by the matrix guard), the retirement waits, then sees the enabled row
    const r1 = await newRole();
    const s1 = await makeSection({ status: 'ACTIVE' });
    await makeRow(s1, r1);
    const enabling = await openTx();
    await setEnabled(s1, r1, true, enabling);
    const retire = rejection(racePool.query("UPDATE identity.roles SET status = 'INACTIVE' WHERE code = $1", [r1]));
    await lockWaiters(1);
    await finish(enabling);
    await expectRule(Promise.reject(await retire), 'ROLE_HAS_SECTIONS');
    expect((await matrixRow(s1, r1)).enabled).toBe(true);
    // order 2: the retirement is open and uncommitted (no row enabled), the enable waits for the role row, then sees INACTIVE
    const r2 = await newRole();
    const s2 = await makeSection({ status: 'ACTIVE' });
    await makeRow(s2, r2);
    const retiring = await openTx();
    await setRoleStatus(r2, 'INACTIVE', retiring);
    const enable = rejection(
      racePool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1 AND role_id = $2', [s2, await roleId(r2)]),
    );
    await lockWaiters(1);
    await finish(retiring);
    await expectRule(Promise.reject(await enable), 'ROLE_NOT_ACTIVE');
    expect((await matrixRow(s2, r2)).enabled).toBe(false);
    await noLockWaiters();
  });

  it('MUTATION CHECK: with the FOR SHARE lock on the role removed from the matrix guard, or with the role trigger removed, in a scratch database the same interleaving ends with an enabled row on an INACTIVE role', async () => {
    for (const mutate of ['no share lock', 'no role trigger'] as const) {
      const scratch = await createIsolatedDatabase();
      const sp = createTestPool(scratch.url, 6);
      const srace = createTestPool(scratch.url, 6);
      try {
        if (mutate === 'no share lock') {
          const def = ((await sp.query("SELECT pg_get_functiondef('identity.guard_account_section_roles'::regproc) AS d")).rows[0] as { d: string }).d;
          const needle = 'SELECT status INTO r_status FROM identity.roles WHERE role_id = NEW.role_id FOR SHARE;';
          expect(def).toContain(needle);
          await sp.query(def.replace(needle, 'SELECT status INTO r_status FROM identity.roles WHERE role_id = NEW.role_id;'));
        } else {
          await sp.query('DROP TRIGGER trg_roles__account_sections ON identity.roles');
        }
        await sp.query("INSERT INTO identity.roles (code, name_content_key) VALUES ('MUT_ROLE', 'identity.role.customer.name')");
        await sp.query(
          "INSERT INTO identity.account_sections (section_code, route_path, label_content_key, status) VALUES ('MUT_SEC', '/account/mut-sec', $1, 'ACTIVE')",
          [KEY],
        );
        const rid = ((await sp.query("SELECT role_id FROM identity.roles WHERE code = 'MUT_ROLE'")).rows[0] as { role_id: string }).role_id;
        await sp.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, false, 7)', [
          'MUT_SEC',
          rid,
        ]);
        const holder = await sp.connect();
        let committed = false;
        let retire: Promise<void> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1', ['MUT_SEC']);
          let settled = false;
          retire = srace.query("UPDATE identity.roles SET status = 'INACTIVE' WHERE code = 'MUT_ROLE'").then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          for (let i = 0; i < 60 && !settled; i++) await sleep(20);
          // Without the share lock retirement does not wait for the open enable; without the trigger it waits on the lock, then retires.
          const shareLockPresent = mutate === 'no role trigger';
          expect(settled, mutate).toBe(!shareLockPresent);
          await holder.query('COMMIT');
          committed = true;
        } finally {
          try {
            if (!committed) await holder.query('ROLLBACK');
          } finally {
            holder.release();
            if (retire) await retire;
          }
        }
        expect(
          (
            await sp.query(
              "SELECT 1 FROM identity.account_section_roles sr JOIN identity.roles r ON r.role_id = sr.role_id WHERE sr.enabled AND r.status <> 'ACTIVE'",
            )
          ).rows.length,
          mutate,
        ).toBe(1);
      } finally {
        await sp.end();
        await srace.end();
        await scratch.drop();
      }
    }
  });

  it('keeps the invariant over 30 fresh rounds where an enable and a role retirement start at the same instant: exactly one wins, never an enabled row on a non-ACTIVE role', async () => {
    const outcomes = { enabled: 0, retired: 0 };
    for (let round = 0; round < 30; round++) {
      const role = await newRole();
      const code = await makeSection({ status: 'ACTIVE' });
      await makeRow(code, role);
      const [enable, retire] = await Promise.all([
        rejection(
          racePool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1 AND role_id = $2', [code, await roleId(role)]),
        ),
        rejection(racePool.query("UPDATE identity.roles SET status = 'INACTIVE' WHERE code = $1", [role])),
      ]);
      const status = (await q<{ status: string }>('SELECT status FROM identity.roles WHERE code = $1', [role]))[0]!.status;
      const enabled = (await matrixRow(code, role)).enabled;
      expect(enabled && status !== 'ACTIVE', `round ${round}: an enabled row for a ${status} role`).toBe(false);
      expect([enable === undefined, retire === undefined].filter(Boolean)).toHaveLength(1);
      if (enable === undefined) {
        outcomes.enabled++;
        expect((retire as PgFailure).detail).toBe('identity_rule:ROLE_HAS_SECTIONS');
      } else {
        outcomes.retired++;
        expect((enable as PgFailure).detail).toBe('identity_rule:ROLE_NOT_ACTIVE');
      }
    }
    expect(outcomes.enabled + outcomes.retired).toBe(30);
    expect(
      await q('SELECT 1 FROM identity.account_section_roles sr JOIN identity.roles r ON r.role_id = sr.role_id WHERE sr.enabled AND r.status <> $1', [
        'ACTIVE',
      ]),
    ).toEqual([]);
  });
});

describe('D3. updated_at is maintained by the guards, not by the client', () => {
  it('sets updated_at on every UPDATE of a section, whatever the client sends (an old date, a future date, nothing), and leaves created_at alone', async () => {
    const code = await makeSection();
    const first = await sectionRow(code);
    await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
    await setStatus(code, 'ACTIVE');
    const second = await sectionRow(code);
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
    expect(second.created_at.getTime()).toBe(first.created_at.getTime());
    await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
    await run("UPDATE identity.account_sections SET status = 'PLANNED', updated_at = '2000-01-01T00:00:00Z' WHERE section_code = $1", [code]);
    const third = await sectionRow(code);
    expect(third.updated_at.getTime()).toBeGreaterThan(second.updated_at.getTime());
    await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
    await run("UPDATE identity.account_sections SET status = 'INACTIVE', updated_at = '2999-01-01T00:00:00Z' WHERE section_code = $1", [code]);
    const fourth = await sectionRow(code);
    expect(fourth.updated_at.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(fourth.updated_at.getTime()).toBeGreaterThan(third.updated_at.getTime());
  });

  it('sets updated_at on every write of a matrix row (an update with the client value ignored), and keeps it equal to the transaction instant', async () => {
    const code = await activeSection();
    const first = await matrixRow(code, 'CUSTOMER');
    await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
    await setEnabled(code, 'CUSTOMER', true);
    const second = await matrixRow(code, 'CUSTOMER');
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
    await sleep(3); // timestamps are compared at millisecond resolution: let the clock move between two writes
    await run(
      "UPDATE identity.account_section_roles SET display_order = display_order, updated_at = '2000-01-01T00:00:00Z' WHERE section_code = $1 AND role_id = $2",
      [code, await roleId('CUSTOMER')],
    );
    const third = await matrixRow(code, 'CUSTOMER');
    expect(third.updated_at.getTime()).toBeGreaterThan(second.updated_at.getTime());
    expect(third.created_at.getTime()).toBe(first.created_at.getTime());
    // an INSERT that sends an old updated_at gets the instant too
    const other = await makeSection({ status: 'ACTIVE' });
    await run(
      "INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order, updated_at) VALUES ($1, $2, false, $3, '2000-01-01T00:00:00Z')",
      [other, await roleId('CUSTOMER'), nextOrder()],
    );
    const inserted = await matrixRow(other, 'CUSTOMER');
    expect(inserted.updated_at.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('uses one instant per transaction (now()) for every row a statement writes', async () => {
    const [a, b] = [await activeSection(), await activeSection()];
    await run('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = ANY($1::text[]) AND role_id = $2', [
      [a, b],
      await roleId('CUSTOMER'),
    ]);
    const rows = await q<{ n: number }>(`SELECT count(DISTINCT updated_at)::int AS n FROM ${MATRIX} WHERE section_code = ANY($1::text[]) AND role_id = $2`, [
      [a, b],
      await roleId('CUSTOMER'),
    ]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('D3b. created_at is kept by the guards', () => {
  it('ignores an UPDATE of created_at on a section (an old value, a future value, NULL) while updated_at still moves', async () => {
    const code = await makeSection();
    const first = await sectionRow(code);
    for (const value of ["'2000-01-01T00:00:00Z'", "'2999-01-01T00:00:00Z'", 'NULL', "now() - interval '3 days'"]) {
      await sleep(3); // the clock must move between two writes (millisecond comparison)
      await run(`UPDATE identity.account_sections SET created_at = ${value} WHERE section_code = $1`, [code]);
      const row = await sectionRow(code);
      expect(row.created_at.getTime(), value).toBe(first.created_at.getTime());
      expect(row.updated_at.getTime(), value).toBeGreaterThan(first.updated_at.getTime());
      first.updated_at = row.updated_at;
    }
    await run("UPDATE identity.account_sections SET created_at = '2000-01-01T00:00:00Z', status = 'ACTIVE' WHERE section_code = $1", [code]);
    expect((await sectionRow(code)).created_at.getTime()).toBe(first.created_at.getTime());
  });

  it('ignores an UPDATE of created_at on a matrix row (also together with enabled and the position) while updated_at still moves', async () => {
    const code = await activeSection();
    const first = await matrixRow(code, 'CUSTOMER');
    for (const value of ["'2000-01-01T00:00:00Z'", "'2999-01-01T00:00:00Z'", 'NULL']) {
      await sleep(3); // the clock must move between two writes (millisecond comparison)
      await run(`UPDATE identity.account_section_roles SET created_at = ${value} WHERE section_code = $1 AND role_id = $2`, [code, await roleId('CUSTOMER')]);
      const row = await matrixRow(code, 'CUSTOMER');
      expect(row.created_at.getTime(), value).toBe(first.created_at.getTime());
      expect(row.updated_at.getTime(), value).toBeGreaterThan(first.updated_at.getTime());
      first.updated_at = row.updated_at;
    }
    await run(
      "UPDATE identity.account_section_roles SET created_at = '2000-01-01T00:00:00Z', enabled = true, display_order = $3 WHERE section_code = $1 AND role_id = $2",
      [code, await roleId('CUSTOMER'), nextOrder()],
    );
    const row = await matrixRow(code, 'CUSTOMER');
    expect(row.created_at.getTime()).toBe(first.created_at.getTime());
    expect(row.enabled).toBe(true);
  });

  it('still takes the creation time the client sends on INSERT (the guard fixes only updates): the insert default and an explicit value both stand', async () => {
    const code = await makeSection();
    await run("UPDATE identity.account_sections SET status = 'PLANNED' WHERE section_code = $1", [code]);
    const n = okSection();
    await run("INSERT INTO identity.account_sections (section_code, route_path, label_content_key, created_at) VALUES ($1, $2, $3, '2001-02-03T04:05:06Z')", [
      n.code,
      n.route,
      KEY,
    ]);
    expect((await sectionRow(n.code)).created_at.toISOString()).toBe('2001-02-03T04:05:06.000Z');
  });
});

describe('E. RESTRICT: nothing the registry names can be removed or re-keyed underneath it', () => {
  it('keeps a content entry that a section names: deleting it or changing its key is refused by the foreign key (when the content guard is bypassed in the transaction)', async () => {
    // fresh entries without versions, so that the section is the only thing that references them
    const entry = async (): Promise<string> => {
      const key = `account.area.test_${++seq}.entry`;
      await run(
        `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
         VALUES ($1, 'UI_LABEL', 'CONTENT', 'test entry', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'PLATFORM', 'test')`,
        [key],
      );
      return key;
    };
    const [label, description] = [await entry(), await entry()];
    await makeSection({ label, description });
    const refused = async (text: string, params: unknown[], constraint: string) => {
      const e = await fail(isolated(noTriggers('content.entries'), text, params));
      expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint });
    };
    await refused('DELETE FROM content.entries WHERE key = $1', [label], 'fk_account_sections__label_content_key');
    await refused('DELETE FROM content.entries WHERE key = $1', [description], 'fk_account_sections__description_content_key');
    await refused('UPDATE content.entries SET key = $2 WHERE key = $1', [label, `${label}.renamed`], 'fk_account_sections__label_content_key');
    await refused(
      'UPDATE content.entries SET key = $2 WHERE key = $1',
      [description, `${description}.renamed`],
      'fk_account_sections__description_content_key',
    );
    expect(await count('content.entries', 'key = ANY($1::text[])', [[label, description]])).toBe(2);
  });

  it('keeps a role that the matrix names: deleting it is refused by the foreign key (when the role guard is bypassed)', async () => {
    await isolated(noTriggers('identity.roles'), "DELETE FROM identity.roles WHERE code = 'PROVIDER'").then(
      () => expect.unreachable('the delete was expected to fail'),
      (e: PgFailure) => expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: 'fk_account_section_roles__role_id' }),
    );
    expect(await count('identity.roles', "code IN ('CUSTOMER', 'PROVIDER')")).toBe(2);
  });

  it('keeps a section that the matrix names: deleting it is refused by the foreign key (when the section guard is bypassed)', async () => {
    await isolated(noTriggers(SECTIONS), "DELETE FROM identity.account_sections WHERE section_code = 'PROFILE'").then(
      () => expect.unreachable('the delete was expected to fail'),
      (e: PgFailure) => expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23503', constraint: 'fk_account_section_roles__section_code' }),
    );
    expect(await count(SECTIONS, "section_code = 'PROFILE'")).toBe(1);
  });

  it('refuses TRUNCATE of either registry table, alone, together and by CASCADE from the sections or from the roles (ROW_IMMUTABLE), and every row survives', async () => {
    const before = { sections: await count(SECTIONS), matrix: await count(MATRIX), roles: await count('identity.roles') };
    // the matrix is not referenced by a foreign key: only the truncate trigger stands in the way
    await expectRule(run('TRUNCATE identity.account_section_roles'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE identity.account_section_roles, identity.account_sections'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE identity.account_sections CASCADE'), 'ROW_IMMUTABLE');
    await expectRule(run('TRUNCATE identity.account_section_roles CASCADE'), 'ROW_IMMUTABLE');
    // a plain TRUNCATE of the referenced table is stopped by PostgreSQL itself (the matrix references it)
    await expect(pool.query('TRUNCATE identity.account_sections')).rejects.toMatchObject({ code: '0A000' });
    // a cascade that reaches the registry from another table is refused too
    const e = await fail(run('TRUNCATE identity.roles CASCADE'));
    expect(e.code).toBe('23000');
    expect(e.detail).toMatch(/^identity_rule:/);
    expect({ sections: await count(SECTIONS), matrix: await count(MATRIX), roles: await count('identity.roles') }).toEqual(before);
  });
});

// ====================================================================== F. real concurrency: enabling a row serializes with the retirement of its section
interface Retirement {
  /** True when the retirement had to wait for the transaction that enables the row. */
  blocked: boolean;
  retireError: PgFailure | undefined;
  code: string;
}
/**
 * The enabling transaction (the guard reads the section row under FOR SHARE) is open and has NOT committed; a second transaction retires the section. With the share
 * lock the retirement waits, then sees the enabled row and is refused (SECTION_IN_USE). Without it the retirement does not wait, sees no enabled row (the other
 * transaction has not committed) and succeeds: an enabled row on an INACTIVE section.
 */
async function enableThenRetire(main: pg.Pool, race: pg.Pool): Promise<Retirement> {
  const n = ++seq;
  const code = `RACE_${n}`;
  await main.query('INSERT INTO identity.account_sections (section_code, route_path, label_content_key, status) VALUES ($1, $2, $3, $4)', [
    code,
    `/account/race-${n}`,
    KEY,
    'ACTIVE',
  ]);
  const role = ((await main.query("SELECT role_id FROM identity.roles WHERE code = 'PROVIDER'")).rows[0] as { role_id: string }).role_id;
  await main.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, false, $3)', [
    code,
    role,
    nextOrder(),
  ]);
  const holder = await main.connect();
  await holder.query('BEGIN');
  let blocked = false;
  let settled = false;
  let retire: Promise<unknown> = Promise.resolve();
  let retireResult: Promise<PgFailure | undefined> = Promise.resolve(undefined);
  try {
    await holder.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1 AND role_id = $2', [code, role]);
    retire = race.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = $1", [code]);
    retireResult = rejection(retire).then((e) => {
      settled = true;
      return e as PgFailure | undefined;
    });
    for (let i = 0; i < 60 && !settled; i++) {
      if ((await waitersOn(main)) >= 1) {
        blocked = true;
        break;
      }
      await sleep(20);
    }
    expect(settled && blocked).toBe(false);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  return { blocked, retireError: await retireResult, code };
}

describe('F. real concurrency: the guard reads the section and the role under FOR SHARE, so an enable and a retirement can never both win', () => {
  it('holds the retirement back while the enabling transaction is open, then refuses it as SECTION_IN_USE; the row stays enabled on an ACTIVE section', async () => {
    const r = await enableThenRetire(pool, racePool);
    expect(r.blocked).toBe(true);
    expect({ code: r.retireError?.code, detail: r.retireError?.detail }).toEqual({ code: '23000', detail: 'identity_rule:SECTION_IN_USE' });
    expect((await sectionRow(r.code)).status).toBe('ACTIVE');
    expect((await matrixRow(r.code, 'PROVIDER')).enabled).toBe(true);
    expect(await violations()).toEqual([]);
  });

  it('MUTATION CHECK: with the FOR SHARE lock removed from the guard in a scratch database the retirement does NOT wait and the registry ends with an enabled row on an INACTIVE section (the test above would fail)', async () => {
    const scratch = await createIsolatedDatabase();
    const sp = createTestPool(scratch.url, 6);
    const srace = createTestPool(scratch.url, 6);
    try {
      const def = ((await sp.query("SELECT pg_get_functiondef('identity.guard_account_section_roles'::regproc) AS d")).rows[0] as { d: string }).d;
      const needle = 'SELECT status INTO s_status FROM identity.account_sections WHERE section_code = NEW.section_code FOR SHARE;';
      expect(def).toContain(needle);
      await sp.query(def.replace(needle, 'SELECT status INTO s_status FROM identity.account_sections WHERE section_code = NEW.section_code;'));
      const r = await enableThenRetire(sp, srace);
      expect(r.blocked).toBe(false);
      expect(r.retireError).toBeUndefined();
      expect((await violations(sp)).length).toBe(1); // the corrupted state the lock prevents
    } finally {
      await sp.end();
      await srace.end();
      await scratch.drop();
    }
  });

  it('lets the retirement win when it commits first: the enabling statement waits for it and is then refused as SECTION_NOT_ACTIVE, for an UPDATE and for an INSERT', async () => {
    const code = await activeSection();
    const retiring = await openTx();
    await setStatus(code, 'INACTIVE', retiring);
    const enable = rejection(
      racePool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1 AND role_id = $2', [code, await roleId('CUSTOMER')]),
    );
    await lockWaiters(1);
    await finish(retiring);
    await expectRule(Promise.reject(await enable), 'SECTION_NOT_ACTIVE');
    expect((await matrixRow(code, 'CUSTOMER')).enabled).toBe(false);

    const other = await makeSection({ status: 'ACTIVE' });
    const retiring2 = await openTx();
    await setStatus(other, 'PLANNED', retiring2);
    const insert = rejection(
      racePool.query('INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, $2, true, $3)', [
        other,
        await roleId('PROVIDER'),
        nextOrder(),
      ]),
    );
    await lockWaiters(1);
    await finish(retiring2);
    await expectRule(Promise.reject(await insert), 'SECTION_NOT_ACTIVE');
    expect(await count(MATRIX, 'section_code = $1', [other])).toBe(0);
    expect(await violations()).toEqual([]);
  });

  it('does not block two enabling transactions on each other (share locks are compatible); a section edit that is not a retirement waits for neither rule', async () => {
    const code = await activeSection();
    const t1 = await openTx();
    const t2 = await openTx(racePool);
    await setEnabled(code, 'CUSTOMER', true, t1);
    await setEnabled(code, 'PROVIDER', true, t2);
    expect(await waitersOn(pool)).toBe(0);
    await finish(t1);
    await finish(t2);
    expect((await matrixRow(code, 'CUSTOMER')).enabled && (await matrixRow(code, 'PROVIDER')).enabled).toBe(true);
  });

  it('keeps the invariant over 30 fresh rounds where an enable and a retirement start at the same instant: exactly one of them wins, never both', async () => {
    const outcomes = { enabled: 0, retired: 0 };
    for (let round = 0; round < 30; round++) {
      const code = await makeSection({ status: 'ACTIVE' });
      await makeRow(code, 'CUSTOMER');
      const go = Promise.resolve();
      const [enable, retire] = await Promise.all([
        go.then(() => rejection(racePool.query('UPDATE identity.account_section_roles SET enabled = true WHERE section_code = $1', [code]))),
        go.then(() => rejection(racePool.query("UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = $1", [code]))),
      ]);
      const row = await sectionRow(code);
      const enabled = (await matrixRow(code, 'CUSTOMER')).enabled;
      expect(enabled && row.status !== 'ACTIVE', `round ${round}: an enabled row on a ${row.status} section`).toBe(false);
      // exactly one winner: either the enable stuck and the retirement was refused, or the retirement stuck and the enable was refused
      expect([enable === undefined, retire === undefined].filter(Boolean)).toHaveLength(1);
      if (enable === undefined) {
        outcomes.enabled++;
        expect((retire as PgFailure).detail).toBe('identity_rule:SECTION_IN_USE');
      } else {
        outcomes.retired++;
        expect((enable as PgFailure).detail).toBe('identity_rule:SECTION_NOT_ACTIVE');
      }
    }
    expect(outcomes.enabled + outcomes.retired).toBe(30);
    expect(await violations()).toEqual([]);
  });

  it('leaves no lock waiter behind after the races above', async () => {
    await noLockWaiters();
  });
});

// ====================================================================== G. the access path of the navigation query
const NAV_SQL = `SELECT s.section_code, s.route_path, s.label_content_key, s.description_content_key
    FROM identity.roles r
    JOIN identity.account_section_roles sr ON sr.role_id = r.role_id AND sr.enabled
    JOIN identity.account_sections s ON s.section_code = sr.section_code AND s.status = 'ACTIVE'
   WHERE r.code = $1 AND r.status = 'ACTIVE'
   ORDER BY sr.display_order`;
async function planOf(text: string, params: unknown[], settings: string[]): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of settings) await c.query(s);
    return (await c.query(`EXPLAIN (COSTS OFF) ${text}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
describe('G. the access path: the unique key (role_id, display_order) is the index the navigation reads, and the result does not depend on the plan', () => {
  it('reads the role menu through uq_account_section_roles__role_order, the role by uq_roles__code and the section by its primary key, with sequential scans disabled', async () => {
    await run('ANALYZE identity.account_section_roles');
    await run('ANALYZE identity.account_sections');
    const plan = await planOf(NAV_SQL, ['PROVIDER'], ['SET LOCAL enable_seqscan = off']);
    expect(plan).toContain('uq_account_section_roles__role_order');
    expect(plan).toContain('pk_account_sections');
    expect(plan).toContain('uq_roles__code');
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('reads the menu of one role in order straight from the unique key, with no sort step and no sequential scan (the key IS the access path)', async () => {
    const plan = await planOf(
      'SELECT sr.section_code FROM identity.account_section_roles sr WHERE sr.role_id = $1 AND sr.enabled ORDER BY sr.display_order',
      [await roleId('CUSTOMER')],
      ['SET LOCAL enable_seqscan = off', 'SET LOCAL enable_bitmapscan = off'],
    );
    expect(plan).toMatch(/Index Scan using uq_account_section_roles__role_order on account_section_roles sr/);
    expect(plan).not.toMatch(/Sort|Seq Scan/);
  });

  it('actually executes through that index (EXPLAIN ANALYZE reports the index scan with one loop and the six rows of the menu)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      await c.query('SET LOCAL enable_bitmapscan = off');
      const plan = (
        await c.query(
          'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT sr.section_code FROM identity.account_section_roles sr WHERE sr.role_id = $1 AND sr.enabled ORDER BY sr.display_order',
          [await roleId('CUSTOMER')],
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toMatch(/Index Scan using uq_account_section_roles__role_order .*actual rows=\d+ loops=1/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('returns the same menu with the default planner and with sequential scans disabled, for both roles, an unknown role and a role in another case', async () => {
    const menu = async (role: string, settings: string[]) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const s of settings) await c.query(s);
        return (await c.query(NAV_SQL, [role])).rows.map((r) => r.section_code as string);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    for (const role of ['CUSTOMER', 'PROVIDER', 'ADMIN', 'customer', '', "CUSTOMER' OR '1'='1"]) {
      const normal = await menu(role, []);
      expect(await menu(role, ['SET LOCAL enable_seqscan = off']), role).toEqual(normal);
      expect(await menu(role, ['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off']), role).toEqual(normal);
    }
    const six = ['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES'];
    const extras = (await menu('CUSTOMER', [])).filter((c) => !six.includes(c));
    expect((await menu('CUSTOMER', [])).filter((c) => six.includes(c))).toEqual(six); // the seeded six, in menu order, among the rows the tests above added
    expect(extras.every((c) => c.startsWith('TST_') || c.startsWith('RACE_') || c === 'NOTIFICATIONS')).toBe(true);
    expect(await menu('ADMIN', [])).toEqual([]);
    expect(await menu('customer', [])).toEqual([]);
    expect(await menu("CUSTOMER' OR '1'='1", [])).toEqual([]);
  });
});

// ====================================================================== H. privacy shape
describe('H. privacy shape: the registry cannot hold, and does not hold, anything about a person', () => {
  it('has no column that could hold a name, address, token, subject or id of a person, and only scalar types (text, boolean, integer, timestamptz and the role uuid)', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'identity' AND table_name IN ('account_sections', 'account_section_roles') ORDER BY 1, ordinal_position",
    );
    const forbidden =
      /(first|last|full|display_name|person|user|member|owner|customer|email|phone|address|street|city|postal|zip|token|secret|password|credential|subject|session|cookie|device|ip_|account_id|birth|ssn|hash|key_id|note|comment|payload|json)/i;
    // nothing matches: the content KEYS (label_content_key, description_content_key) name managed copy, not people
    const offenders = rows.filter((r) => forbidden.test(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`);
    expect(offenders).toEqual([]);
    expect([...new Set(rows.map((r) => r.data_type))].sort()).toEqual(['boolean', 'integer', 'text', 'timestamp with time zone', 'uuid']);
    expect(rows.filter((r) => r.data_type === 'uuid').map((r) => `${r.table_name}.${r.column_name}`)).toEqual(['account_section_roles.role_id']);
  });

  it('references only reference data: the content registry, the roles and the sections themselves; no foreign key to an account, a profile, a contact or a session, and none from them', async () => {
    const out = await q<{ target: string }>(
      `SELECT DISTINCT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('identity.account_sections'::regclass, 'identity.account_section_roles'::regclass) ORDER BY 1`,
    );
    expect(out.map((r) => r.target)).toEqual(['content.entries', 'identity.account_sections', 'identity.roles']);
    expect(
      await q(
        `SELECT conrelid::regclass::text AS from_table FROM pg_constraint WHERE contype = 'f' AND confrelid IN ('identity.account_sections'::regclass, 'identity.account_section_roles'::regclass)`,
      ),
    ).toEqual([{ from_table: 'identity.account_section_roles' }]);
  });

  it('writes no audit row and no outbox event on its own: changing the registry leaves the audit trail and the outbox exactly as they were', async () => {
    const snap = async () => ({
      audit: await count('identity.account_audit_events'),
      outbox: await count('integration.outbox_events'),
      content: await count('content.audit_events'),
    });
    const before = await snap();
    const code = await activeSection();
    await setEnabled(code, 'CUSTOMER', true);
    await setEnabled(code, 'CUSTOMER', false);
    await setStatus(code, 'INACTIVE');
    expect(await snap()).toEqual(before);
  });

  it('holds no value that looks like a person in the seeded rows: no address, number, UUID or URL in a route or a key, and none in the seeded copy', async () => {
    const rows = await sq<{ v: string }>(
      `SELECT v FROM (SELECT section_code AS v FROM ${SECTIONS} UNION ALL SELECT route_path FROM ${SECTIONS} UNION ALL SELECT label_content_key FROM ${SECTIONS}
                      UNION ALL SELECT description_content_key FROM ${SECTIONS}) t WHERE v IS NOT NULL`,
    );
    for (const { v } of rows) expect(v, v).not.toMatch(/[@\s]|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}/i);
    const bodies = await sq<{ key: string; body: string }>(
      `SELECT e.key, v.body FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key LIKE 'account.area.%'`,
    );
    for (const b of bodies) expect(b.body, b.key).not.toMatch(/@|https?:|[0-9a-f]{8}-[0-9a-f]{4}-|\d{3,}/i);
  });
});
