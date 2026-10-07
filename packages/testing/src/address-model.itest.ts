import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from './index';

// Migration 0008 adds the address model: administrative areas, versioned effective-dated address formats with ordered fields, and the ONE canonical
// immutable address, and seeds the United States (51 areas, format v1, field label copy). These tests drive the REAL tables, constraints and guard
// triggers with raw SQL: every CHECK/UNIQUE/FK of the four new tables, every guard rule (each carries DETAIL geography_rule:<KEY>) and the exclusion
// constraint. Service behaviour is covered in packages/geography (address.itest.ts).
let iso: IsolatedDatabase;
let pool: pg.Pool;
let seq = 0;
let letter = 0;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = new pg.Pool({ connectionString: iso.url, max: 8 });
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params).then(() => undefined);
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
/** Asserts the statement is refused by a guard trigger with exactly this rule key (SQLSTATE 23000, DETAIL geography_rule:<KEY>). */
const expectRule = async (p: Promise<unknown>, key: string): Promise<void> => {
  const e = await fail(p);
  expect({ code: e.code, detail: e.detail }).toEqual({ code: '23000', detail: `geography_rule:${key}` });
};

const LABELS: Record<string, string> = {
  ADDRESS_LINE_1: 'address.field.line1',
  ADDRESS_LINE_2: 'address.field.line2',
  LOCALITY: 'address.field.city',
  ADMINISTRATIVE_AREA: 'address.field.state',
  POSTAL_CODE: 'address.field.postal_code',
};
type FieldSpec = { field_type: string } & Record<string, unknown>;

/** A fresh PLANNED country (formats and areas do not need an ACTIVE country). Codes are unique per run: XA, XB, ... YA, ... */
async function makeCountry(): Promise<string> {
  const n = ++seq;
  const i = letter++;
  const alpha2 = `${String.fromCharCode(88 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // the default locale must be one of the country's locales (deferred constraint), so both rows go in one transaction
    const c = await client.query(
      `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
       VALUES ($1, $2, $3, 'geography.country.us.name', 'PLANNED', '+999', 'USD', 'en-US', 'KILOMETERS', 'MONDAY', 'DMY', '24_HOUR') RETURNING country_id`,
      [alpha2, `${alpha2}Z`, String(900 + n).padStart(3, '0')],
    );
    const id = c.rows[0].country_id as string;
    await client.query("INSERT INTO geography.country_locales (country_id, locale) VALUES ($1, 'en-US')", [id]);
    await client.query(
      "INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT $1, time_zone_id FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'",
      [id],
    );
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function insertField(formatId: string, spec: FieldSpec): Promise<void> {
  const row: Record<string, unknown> = {
    address_format_id: formatId,
    display_order: 1,
    content_label_key: LABELS[spec.field_type] ?? 'address.field.line1',
    required: true,
    max_length: 100,
    input_type: 'TEXT',
    ...spec,
  };
  const names = Object.keys(row);
  await run(`INSERT INTO geography.address_format_fields (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
}
/** A DRAFT format with its fields (default: required ADDRESS_LINE_1 and optional LOCALITY, template naming both). */
async function draft(countryId: string, o: { fields?: FieldSpec[]; template?: string; from?: string; to?: string | null } = {}): Promise<string> {
  const r = await q<{ address_format_id: string }>(
    `INSERT INTO geography.address_formats (country_id, version, status, display_template, effective_from, effective_to)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM geography.address_formats WHERE country_id = $1), 'DRAFT', $2, $3, $4) RETURNING address_format_id`,
    [countryId, o.template ?? '{ADDRESS_LINE_1}\n{LOCALITY}', o.from ?? '2030-01-01T00:00:00Z', o.to ?? null],
  );
  const id = r[0]!.address_format_id;
  const fields = o.fields ?? [{ field_type: 'ADDRESS_LINE_1' }, { field_type: 'LOCALITY', required: false, max_length: 60 }];
  for (const [i, f] of fields.entries()) await insertField(id, { display_order: i + 1, ...f });
  return id;
}
const publish = (formatId: string) =>
  run("UPDATE geography.address_formats SET status = 'PUBLISHED', updated_at = now() WHERE address_format_id = $1", [formatId]);
const publishedFormat = async (countryId: string, from?: string): Promise<string> => {
  const id = await draft(countryId, { from: from ?? '2020-01-01T00:00:00Z' });
  await publish(id);
  return id;
};
const addArea = async (countryId: string, code: string, o: { status?: string; parent?: string | null; name?: string } = {}): Promise<string> =>
  (
    await q<{ administrative_area_id: string }>(
      `INSERT INTO geography.administrative_areas (country_id, code, name, area_type, status, parent_area_id) VALUES ($1, $2, $3, 'PROVINCE', $4, $5) RETURNING administrative_area_id`,
      [countryId, code, o.name ?? `Area ${code}`, o.status ?? 'ACTIVE', o.parent ?? null],
    )
  )[0]!.administrative_area_id;

interface UsIds {
  countryId: string;
  formatId: string;
  caAreaId: string;
}
let us: UsIds;
beforeAll(async () => {
  const r = await q<{ country_id: string; address_format_id: string; administrative_area_id: string }>(
    `SELECT c.country_id, f.address_format_id, a.administrative_area_id FROM geography.countries c
       JOIN geography.address_formats f ON f.country_id = c.country_id AND f.version = 1
       JOIN geography.administrative_areas a ON a.country_id = c.country_id AND a.code = 'CA' WHERE c.iso_alpha2 = 'US'`,
  );
  us = { countryId: r[0]!.country_id, formatId: r[0]!.address_format_id, caAreaId: r[0]!.administrative_area_id };
});

// ====================================================================== seeds
describe('seeded US address data (migration 0008)', () => {
  it('records no outbox event for the seeded format (the seed runs before any consumer exists)', async () => {
    expect((await q("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.geography.%'"))[0]).toEqual({ n: 0 });
  });

  it('seeds the 50 states and the District of Columbia, all ACTIVE and top level', async () => {
    const rows = await q<{ code: string; name: string; area_type: string; status: string; parent_area_id: string | null; display_order: number | null }>(
      `SELECT a.code, a.name, a.area_type, a.status, a.parent_area_id, a.display_order FROM geography.administrative_areas a
         JOIN geography.countries c ON c.country_id = a.country_id WHERE c.iso_alpha2 = 'US' ORDER BY a.code`,
    );
    expect(rows).toHaveLength(51);
    expect(rows.every((r) => r.status === 'ACTIVE' && r.parent_area_id === null && r.display_order === null)).toBe(true);
    expect(rows.filter((r) => r.area_type === 'DISTRICT').map((r) => [r.code, r.name])).toEqual([['DC', 'District of Columbia']]);
    expect(rows.filter((r) => r.area_type === 'STATE')).toHaveLength(50);
    expect(rows.find((r) => r.code === 'CA')).toMatchObject({ name: 'California', area_type: 'STATE' });
    expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining(['AL', 'AK', 'NY', 'TX', 'WY', 'HI', 'DC']));
    expect(new Set(rows.map((r) => r.code)).size).toBe(51);
    // no area exists for any other country
    expect((await q('SELECT count(*)::int AS n FROM geography.administrative_areas'))[0]).toEqual({ n: 51 });
  });

  it('seeds US address format v1 as PUBLISHED with the five fields in display order and the US display template', async () => {
    const formats = await q<{ version: number; status: string; display_template: string; effective_to: Date | null; iso_alpha2: string }>(
      'SELECT f.version, f.status, f.display_template, f.effective_to, c.iso_alpha2 FROM geography.address_formats f JOIN geography.countries c ON c.country_id = f.country_id',
    );
    expect(formats).toEqual([
      {
        version: 1,
        status: 'PUBLISHED',
        display_template: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
        effective_to: null,
        iso_alpha2: 'US',
      },
    ]);
    const fields = await q(
      `SELECT field_type, display_order, content_label_key, required, max_length, input_type, validation_pattern, example_value, autocomplete_hint, normalization_rule
         FROM geography.address_format_fields WHERE address_format_id = $1 ORDER BY display_order`,
      [us.formatId],
    );
    expect(fields).toEqual([
      {
        field_type: 'ADDRESS_LINE_1',
        display_order: 1,
        content_label_key: 'address.field.line1',
        required: true,
        max_length: 100,
        input_type: 'TEXT',
        validation_pattern: null,
        example_value: null,
        autocomplete_hint: 'address-line1',
        normalization_rule: null,
      },
      {
        field_type: 'ADDRESS_LINE_2',
        display_order: 2,
        content_label_key: 'address.field.line2',
        required: false,
        max_length: 100,
        input_type: 'TEXT',
        validation_pattern: null,
        example_value: null,
        autocomplete_hint: 'address-line2',
        normalization_rule: null,
      },
      {
        field_type: 'LOCALITY',
        display_order: 3,
        content_label_key: 'address.field.city',
        required: true,
        max_length: 60,
        input_type: 'TEXT',
        validation_pattern: null,
        example_value: null,
        autocomplete_hint: 'address-level2',
        normalization_rule: null,
      },
      {
        field_type: 'ADMINISTRATIVE_AREA',
        display_order: 4,
        content_label_key: 'address.field.state',
        required: true,
        max_length: 50,
        input_type: 'LOOKUP',
        validation_pattern: null,
        example_value: null,
        autocomplete_hint: 'address-level1',
        normalization_rule: null,
      },
      {
        field_type: 'POSTAL_CODE',
        display_order: 5,
        content_label_key: 'address.field.postal_code',
        required: true,
        max_length: 10,
        input_type: 'TEXT',
        validation_pattern: '^[0-9]{5}(-[0-9]{4})?$',
        example_value: '12345',
        autocomplete_hint: 'postal-code',
        normalization_rule: null,
      },
    ]);
    // the stored pattern is a usable regular expression and accepts the stored example
    expect(new RegExp(fields[4]!.validation_pattern as string, 'u').test('12345-6789')).toBe(true);
    expect(new RegExp(fields[4]!.validation_pattern as string, 'u').test('1234')).toBe(false);
  });

  it('seeds the twelve address content entries: platform copy for all, US-scoped overrides only for state and postal code, every label key exists', async () => {
    const entries = await q<{ key: string; content_type: string }>("SELECT key, content_type FROM content.entries WHERE key LIKE 'address.%' ORDER BY key");
    expect(entries.map((e) => e.key)).toEqual([
      'address.error.invalid_characters',
      'address.error.invalid_format',
      'address.error.lookup_unavailable',
      'address.error.required',
      'address.error.too_long',
      'address.error.unknown_area',
      'address.error.unsupported_field',
      'address.field.city',
      'address.field.line1',
      'address.field.line2',
      'address.field.postal_code',
      'address.field.state',
    ]);
    expect(entries.filter((e) => e.key.startsWith('address.field.')).every((e) => e.content_type === 'UI_LABEL')).toBe(true);
    expect(entries.filter((e) => e.key.startsWith('address.error.')).every((e) => e.content_type === 'PLAIN_TEXT')).toBe(true);
    const versions = await q<{ key: string; scope_type: string; scope_ref: string | null; body: string; status: string }>(
      "SELECT e.key, v.scope_type, v.scope_ref, v.body, v.status FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key LIKE 'address.%' ORDER BY e.key, v.scope_type",
    );
    expect(versions).toHaveLength(14);
    expect(versions.every((v) => v.status === 'PUBLISHED')).toBe(true);
    expect(versions.filter((v) => v.scope_type === 'PLATFORM')).toHaveLength(12);
    expect(versions.filter((v) => v.scope_type === 'COUNTRY').map((v) => [v.key, v.scope_ref, v.body])).toEqual([
      ['address.field.postal_code', 'US', 'ZIP code'],
      ['address.field.state', 'US', 'State'],
    ]);
    expect(versions.find((v) => v.key === 'address.field.state' && v.scope_type === 'PLATFORM')!.body).toBe('State or region');
    expect(versions.find((v) => v.key === 'address.field.postal_code' && v.scope_type === 'PLATFORM')!.body).toBe('Postal code');
    // every label key the seeded fields use is a real entry (also enforced by fk_address_format_fields__label_key)
    const missing = await q(
      'SELECT f.content_label_key FROM geography.address_format_fields f LEFT JOIN content.entries e ON e.key = f.content_label_key WHERE e.key IS NULL',
    );
    expect(missing).toEqual([]);
  });

  it('writes the same audit trail the service writes: ADDRESS_FORMAT_DRAFTED then ADDRESS_FORMAT_PUBLISHED by system:migration, subject address_format_id only', async () => {
    const rows = await q<{
      actor: string;
      action: string;
      country_id: string | null;
      market_id: string | null;
      address_format_id: string;
      correlation_id: string;
      changes: unknown;
    }>(
      "SELECT actor, action, country_id, market_id, address_format_id, correlation_id, changes FROM geography.audit_events WHERE action LIKE 'ADDRESS_FORMAT_%' ORDER BY occurred_at, audit_event_id",
    );
    expect(rows.map((r) => r.action)).toEqual(['ADDRESS_FORMAT_DRAFTED', 'ADDRESS_FORMAT_PUBLISHED']);
    for (const r of rows) {
      expect(r).toMatchObject({ actor: 'system:migration', country_id: null, market_id: null, address_format_id: us.formatId, correlation_id: 'seed-0008' });
    }
    expect(rows[0]!.changes).toEqual({ version: [null, 1] });
    expect(rows[1]!.changes).toEqual({ status: ['DRAFT', 'PUBLISHED'] });
  });
});

// ====================================================================== administrative areas
describe('administrative areas: constraints and guard', () => {
  it('rejects malformed codes, names, types, statuses, display orders and a self parent (each CHECK)', async () => {
    const country = await makeCountry();
    const ins = (code: string, over: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = { country_id: country, code, name: 'Name', area_type: 'PROVINCE', ...over };
      const names = Object.keys(row);
      return run(
        `INSERT INTO geography.administrative_areas (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    for (const bad of ['ca', '', 'A'.repeat(11), '-A', 'A B', 'A_B'])
      expect(await constraintOf(ins(bad)), `code ${JSON.stringify(bad)}`).toBe('ck_administrative_areas__code_format');
    for (const bad of ['', '   ', 'x'.repeat(121)])
      expect(await constraintOf(ins('N1', { name: bad })), `name length ${bad.length}`).toBe('ck_administrative_areas__name_not_blank');
    expect(await constraintOf(ins('T1', { area_type: 'CITY' }))).toBe('ck_administrative_areas__area_type');
    expect(await constraintOf(ins('S1', { status: 'PLANNED' }))).toBe('ck_administrative_areas__status');
    expect(await constraintOf(ins('D1', { display_order: -1 }))).toBe('ck_administrative_areas__display_order');
    const self = crypto.randomUUID();
    expect(await constraintOf(ins('P1', { administrative_area_id: self, parent_area_id: self }))).toBe('ck_administrative_areas__not_own_parent');
    // boundaries are accepted: ten characters, a digit start, a dash, 120 characters, display order 0, INACTIVE
    await ins('A234567890');
    await ins('1-2', { name: 'x'.repeat(120), display_order: 0, status: 'INACTIVE' });
    for (const t of ['STATE', 'PROVINCE', 'TERRITORY', 'DISTRICT', 'REGION', 'COUNTY', 'OTHER']) await ins(`T-${t}`.slice(0, 10), { area_type: t });
  });

  it('enforces a unique code per country (the same code is fine in another country) and a registered country', async () => {
    const a = await makeCountry();
    const b = await makeCountry();
    await addArea(a, 'NB');
    expect(await constraintOf(addArea(a, 'NB'))).toBe('uq_administrative_areas__country_code');
    await addArea(b, 'NB');
    expect(await constraintOf(addArea(crypto.randomUUID(), 'NB'))).toBe('fk_administrative_areas__country_id');
  });

  it('a parent must exist in the SAME country (composite foreign key); a same-country parent is accepted', async () => {
    const a = await makeCountry();
    const b = await makeCountry();
    const parentA = await addArea(a, 'P1');
    const parentB = await addArea(b, 'P1');
    expect(await constraintOf(addArea(a, 'C1', { parent: parentB }))).toBe('fk_administrative_areas__parent');
    expect(await constraintOf(addArea(a, 'C2', { parent: crypto.randomUUID() }))).toBe('fk_administrative_areas__parent');
    const child = await addArea(a, 'C3', { parent: parentA });
    expect((await q('SELECT parent_area_id FROM geography.administrative_areas WHERE administrative_area_id = $1', [child]))[0]).toEqual({
      parent_area_id: parentA,
    });
  });

  it('identity (id, country, code, parent, created_at) is immutable; name, type, status, display order and updated_at are editable', async () => {
    const a = await makeCountry();
    const b = await makeCountry();
    const parent = await addArea(a, 'P1');
    const other = await addArea(a, 'P2');
    const child = await addArea(a, 'C1', { parent });
    const root = await addArea(a, 'R1');
    await expectRule(run("UPDATE geography.administrative_areas SET code = 'C9' WHERE administrative_area_id = $1", [child]), 'IMMUTABLE_IDENTITY');
    await expectRule(run('UPDATE geography.administrative_areas SET country_id = $2 WHERE administrative_area_id = $1', [child, b]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run('UPDATE geography.administrative_areas SET administrative_area_id = gen_random_uuid() WHERE administrative_area_id = $1', [child]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(
      run("UPDATE geography.administrative_areas SET created_at = created_at - interval '1 day' WHERE administrative_area_id = $1", [child]),
      'IMMUTABLE_IDENTITY',
    );
    // the parent is immutable: re-parent, detach and attach are all refused
    await expectRule(
      run('UPDATE geography.administrative_areas SET parent_area_id = $2 WHERE administrative_area_id = $1', [child, other]),
      'IMMUTABLE_IDENTITY',
    );
    await expectRule(run('UPDATE geography.administrative_areas SET parent_area_id = NULL WHERE administrative_area_id = $1', [child]), 'IMMUTABLE_IDENTITY');
    await expectRule(
      run('UPDATE geography.administrative_areas SET parent_area_id = $2 WHERE administrative_area_id = $1', [root, parent]),
      'IMMUTABLE_IDENTITY',
    );
    // no self parent through UPDATE either (this is the guard, the CHECK covers the insert)
    await expectRule(
      run('UPDATE geography.administrative_areas SET parent_area_id = administrative_area_id WHERE administrative_area_id = $1', [root]),
      'IMMUTABLE_IDENTITY',
    );
    // editable columns
    await run(
      "UPDATE geography.administrative_areas SET name = 'Renamed', area_type = 'REGION', status = 'INACTIVE', display_order = 7, updated_at = now() WHERE administrative_area_id = $1",
      [child],
    );
    expect(
      (await q('SELECT name, area_type, status, display_order FROM geography.administrative_areas WHERE administrative_area_id = $1', [child]))[0],
    ).toEqual({
      name: 'Renamed',
      area_type: 'REGION',
      status: 'INACTIVE',
      display_order: 7,
    });
    // a no-op identity update is allowed
    await run('UPDATE geography.administrative_areas SET updated_at = now() WHERE administrative_area_id = $1', [child]);
  });

  it('refuses every DELETE (areas are deactivated, never deleted), including a seeded one', async () => {
    const a = await makeCountry();
    const area = await addArea(a, 'X1');
    await expectRule(run('DELETE FROM geography.administrative_areas WHERE administrative_area_id = $1', [area]), 'NOT_DELETABLE');
    await expectRule(run("DELETE FROM geography.administrative_areas WHERE code = 'CA' AND country_id = $1", [us.countryId]), 'NOT_DELETABLE');
    expect((await q('SELECT count(*)::int AS n FROM geography.administrative_areas WHERE country_id = $1', [us.countryId]))[0]).toEqual({ n: 51 });
  });
});

// ====================================================================== address format fields
describe('address format fields: constraints', () => {
  let formatId: string;
  let order = 0;
  beforeAll(async () => {
    formatId = await draft(await makeCountry(), { fields: [] });
  });
  /** One field insert into the shared DRAFT with a display order of its own (so the unique order never masks the constraint under test). */
  const field = (spec: FieldSpec) => insertField(formatId, { display_order: (order = (order % 20) + 1), ...spec });

  it('rejects each malformed column: field type, display order, label key, max length, input type, example, autocomplete hint, normalization rule', async () => {
    expect(await constraintOf(field({ field_type: 'FOO' }))).toBe('ck_address_format_fields__field_type');
    expect(await constraintOf(field({ field_type: 'address_line_1' }))).toBe('ck_address_format_fields__field_type');
    for (const bad of [0, 21, -1])
      expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', display_order: bad })), `order ${bad}`).toBe('ck_address_format_fields__display_order');
    for (const bad of ['Address.Field', 'nodot', 'a..b', 'address.Field', '1address.field', 'address.field-x', ''])
      expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', content_label_key: bad })), `label ${bad}`).toBe(
        'ck_address_format_fields__label_key_format',
      );
    for (const bad of [0, 201, -5])
      expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', max_length: bad })), `max ${bad}`).toBe('ck_address_format_fields__max_length');
    expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', input_type: 'RADIO' }))).toBe('ck_address_format_fields__input_type');
    for (const bad of ['', '   ', 'x'.repeat(101), 'a\tb', 'a\u0000b'.replace('\u0000', '\u0007')])
      expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', example_value: bad })), `example ${JSON.stringify(bad)}`).toBe(
        'ck_address_format_fields__example',
      );
    for (const bad of ['Address-Line1', '1abc', '-abc', 'a'.repeat(41), 'address line', 'a_b', ''])
      expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', autocomplete_hint: bad })), `hint ${bad}`).toBe(
        'ck_address_format_fields__autocomplete_hint',
      );
    for (const bad of ['LOWERCASE', 'uppercase', 'TRIM', ''])
      expect(await constraintOf(field({ field_type: 'POSTAL_CODE', normalization_rule: bad })), `rule ${bad}`).toBe(
        'ck_address_format_fields__normalization_rule',
      );
  });

  it('a label key must be a real content entry (foreign key), even when well formed', async () => {
    expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', content_label_key: 'address.field.does_not_exist' }))).toBe(
      'fk_address_format_fields__label_key',
    );
  });

  it('LOOKUP is only for ADMINISTRATIVE_AREA and has no pattern or normalization; a pattern must be 1 to 200 characters', async () => {
    expect(await constraintOf(field({ field_type: 'ADDRESS_LINE_1', input_type: 'LOOKUP' }))).toBe('ck_address_format_fields__lookup_only_for_area');
    expect(await constraintOf(field({ field_type: 'POSTAL_CODE', input_type: 'LOOKUP' }))).toBe('ck_address_format_fields__lookup_only_for_area');
    expect(await constraintOf(field({ field_type: 'ADMINISTRATIVE_AREA', input_type: 'LOOKUP', validation_pattern: '^[A-Z]{2}$' }))).toBe(
      'ck_address_format_fields__lookup_has_no_pattern',
    );
    expect(await constraintOf(field({ field_type: 'ADMINISTRATIVE_AREA', input_type: 'LOOKUP', normalization_rule: 'UPPERCASE' }))).toBe(
      'ck_address_format_fields__lookup_has_no_pattern',
    );
    expect(await constraintOf(field({ field_type: 'POSTAL_CODE', validation_pattern: '' }))).toBe('ck_address_format_fields__pattern_length');
    expect(await constraintOf(field({ field_type: 'POSTAL_CODE', validation_pattern: 'a'.repeat(201) }))).toBe('ck_address_format_fields__pattern_length');
  });

  it('accepts the boundary values and each allowed enumerated value', async () => {
    const f2 = await draft(await makeCountry(), { fields: [] });
    const types = ['ORGANIZATION', 'ADDRESS_LINE_1', 'ADDRESS_LINE_2', 'DEPENDENT_LOCALITY', 'LOCALITY', 'ADMINISTRATIVE_AREA', 'POSTAL_CODE', 'SORTING_CODE'];
    for (const [i, t] of types.entries()) await insertField(f2, { field_type: t, display_order: i + 1, max_length: i % 2 === 0 ? 1 : 200 });
    expect(await q('SELECT count(*)::int AS n FROM geography.address_format_fields WHERE address_format_id = $1', [f2])).toEqual([{ n: 8 }]);
    const f3 = await draft(await makeCountry(), { fields: [] });
    await insertField(f3, { field_type: 'ADDRESS_LINE_1', display_order: 1 });
    await insertField(f3, { field_type: 'ADMINISTRATIVE_AREA', display_order: 20, input_type: 'LOOKUP', autocomplete_hint: 'a'.repeat(40) });
    await insertField(f3, {
      field_type: 'POSTAL_CODE',
      display_order: 2,
      validation_pattern: 'a'.repeat(200),
      example_value: 'x'.repeat(100),
      normalization_rule: 'UPPERCASE_REMOVE_SPACES',
    });
    await insertField(f3, { field_type: 'LOCALITY', display_order: 3, normalization_rule: 'REMOVE_SPACES' });
    await insertField(f3, { field_type: 'SORTING_CODE', display_order: 4, normalization_rule: 'UPPERCASE', autocomplete_hint: 'x' });
  });

  it('keeps one field of each type and one position per format (primary key, unique display order)', async () => {
    const f = await draft(await makeCountry(), { fields: [] });
    await insertField(f, { field_type: 'ADDRESS_LINE_1', display_order: 1 });
    expect(await constraintOf(insertField(f, { field_type: 'ADDRESS_LINE_1', display_order: 2 }))).toBe('pk_address_format_fields');
    expect(await constraintOf(insertField(f, { field_type: 'LOCALITY', display_order: 1 }))).toBe('uq_address_format_fields__format_order');
    await insertField(f, { field_type: 'LOCALITY', display_order: 2 });
  });

  it('a field of a format that does not exist is refused by the guard (the format is not a DRAFT)', async () => {
    await expectRule(insertField(crypto.randomUUID(), { field_type: 'ADDRESS_LINE_1' }), 'FORMAT_NOT_DRAFT');
  });
});

// ====================================================================== address formats: constraints and guard
describe('address formats: constraints', () => {
  it('rejects a malformed version, template and period; unique (country, version); registered country', async () => {
    const country = await makeCountry();
    const ins = (over: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        country_id: country,
        version: 1,
        status: 'DRAFT',
        display_template: '{ADDRESS_LINE_1}',
        effective_from: '2030-01-01T00:00:00Z',
        ...over,
      };
      const names = Object.keys(row);
      return run(`INSERT INTO geography.address_formats (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    };
    expect(await constraintOf(ins({ version: 0 }))).toBe('ck_address_formats__version');
    expect(await constraintOf(ins({ version: -3 }))).toBe('ck_address_formats__version');
    for (const bad of ['', 'x'.repeat(501), 'a\tb', 'a\u0001b', 'a\u007Fb'])
      expect(await constraintOf(ins({ display_template: bad })), `template ${JSON.stringify(bad.slice(0, 8))}`).toBe('ck_address_formats__template');
    // a DRAFT is always open ended (and the end, when present, must follow the start)
    expect(await constraintOf(ins({ effective_to: '2031-01-01T00:00:00Z' }))).toBe('ck_address_formats__draft_is_open');
    expect(await constraintOf(ins({ effective_to: '2029-01-01T00:00:00Z' }))).toMatch(/ck_address_formats__(draft_is_open|effective_range)/);
    expect(await constraintOf(ins({ effective_to: '2030-01-01T00:00:00Z' }))).toMatch(/ck_address_formats__(draft_is_open|effective_range)/);
    await ins({ display_template: 'line\n{ADDRESS_LINE_1}' }); // newline is allowed
    expect(await constraintOf(ins())).toBe('uq_address_formats__country_version');
    await ins({ version: 2, display_template: 'x'.repeat(500) });
    expect(await constraintOf(ins({ country_id: crypto.randomUUID() }))).toBe('fk_address_formats__country_id');
  });

  it('the status CHECK refuses an unknown status (reached through UPDATE: an INSERT of a non-DRAFT status is stopped by the guard first)', async () => {
    const f = await draft(await makeCountry());
    expect(await constraintOf(run("UPDATE geography.address_formats SET status = 'ARCHIVED' WHERE address_format_id = $1", [f]))).toBe(
      'ck_address_formats__status',
    );
  });

  it('the effective range CHECK refuses closing a published format at or before its start', async () => {
    const f = await publishedFormat(await makeCountry(), '2030-01-01T00:00:00Z');
    expect(await constraintOf(run("UPDATE geography.address_formats SET effective_to = '2030-01-01T00:00:00Z' WHERE address_format_id = $1", [f]))).toBe(
      'ck_address_formats__effective_range',
    );
    expect(await constraintOf(run("UPDATE geography.address_formats SET effective_to = '2029-01-01T00:00:00Z' WHERE address_format_id = $1", [f]))).toBe(
      'ck_address_formats__effective_range',
    );
  });
});

describe('address format guard: lifecycle', () => {
  it('a format is created as DRAFT only', async () => {
    const country = await makeCountry();
    await expectRule(
      run(
        "INSERT INTO geography.address_formats (country_id, version, status, display_template, effective_from) VALUES ($1, 1, 'PUBLISHED', '{ADDRESS_LINE_1}', now())",
        [country],
      ),
      'FORMAT_MUST_START_AS_DRAFT',
    );
    await expectRule(
      run(
        "INSERT INTO geography.address_formats (country_id, version, status, display_template, effective_from) VALUES ($1, 1, 'ARCHIVED', '{ADDRESS_LINE_1}', now())",
        [country],
      ),
      'FORMAT_MUST_START_AS_DRAFT',
    );
    expect((await q('SELECT count(*)::int AS n FROM geography.address_formats WHERE country_id = $1', [country]))[0]).toEqual({ n: 0 });
  });

  it('a DRAFT is immutable: period, template, version, country and creation time cannot change (a new version is created instead)', async () => {
    const country = await makeCountry();
    const other = await makeCountry();
    const f = await draft(country);
    await expectRule(run("UPDATE geography.address_formats SET effective_from = '2031-01-01T00:00:00Z' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run("UPDATE geography.address_formats SET effective_to = '2032-01-01T00:00:00Z' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run("UPDATE geography.address_formats SET display_template = '{ADDRESS_LINE_1}' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run('UPDATE geography.address_formats SET version = 9 WHERE address_format_id = $1', [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run('UPDATE geography.address_formats SET country_id = $2 WHERE address_format_id = $1', [f, other]), 'FORMAT_IMMUTABLE');
    await expectRule(
      run("UPDATE geography.address_formats SET created_at = created_at - interval '1 day' WHERE address_format_id = $1", [f]),
      'FORMAT_IMMUTABLE',
    );
    // a touch that changes nothing is fine
    await run('UPDATE geography.address_formats SET updated_at = now() WHERE address_format_id = $1', [f]);
    expect((await q('SELECT status FROM geography.address_formats WHERE address_format_id = $1', [f]))[0]).toEqual({ status: 'DRAFT' });
  });

  it('publishing may raise the start but never lower it, and the end stays open', async () => {
    const country = await makeCountry();
    const lower = await draft(country, { from: '2030-01-01T00:00:00Z' });
    await expectRule(
      run("UPDATE geography.address_formats SET status = 'PUBLISHED', effective_from = '2029-12-31T00:00:00Z' WHERE address_format_id = $1", [lower]),
      'FORMAT_IMMUTABLE',
    );
    await expectRule(
      run("UPDATE geography.address_formats SET status = 'PUBLISHED', effective_to = '2031-01-01T00:00:00Z' WHERE address_format_id = $1", [lower]),
      'FORMAT_IMMUTABLE',
    );
    await run("UPDATE geography.address_formats SET status = 'PUBLISHED', effective_from = '2030-02-01T00:00:00Z' WHERE address_format_id = $1", [lower]);
    expect(
      (
        await q<{ effective_from: Date; effective_to: Date | null }>(
          'SELECT effective_from, effective_to FROM geography.address_formats WHERE address_format_id = $1',
          [lower],
        )
      )[0],
    ).toEqual({
      effective_from: new Date('2030-02-01T00:00:00Z'),
      effective_to: null,
    });
  });

  it('a PUBLISHED format is immutable except that its open end is closed once; it can never go back to DRAFT', async () => {
    const country = await makeCountry();
    const f = await publishedFormat(country, '2030-01-01T00:00:00Z');
    await expectRule(run("UPDATE geography.address_formats SET effective_from = '2030-01-02T00:00:00Z' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run("UPDATE geography.address_formats SET display_template = '{ADDRESS_LINE_1}' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run('UPDATE geography.address_formats SET version = 2 WHERE address_format_id = $1', [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run("UPDATE geography.address_formats SET status = 'DRAFT' WHERE address_format_id = $1", [f]), 'FORMAT_STATUS_TRANSITION');
    await expectRule(run("UPDATE geography.address_formats SET status = 'ARCHIVED' WHERE address_format_id = $1", [f]), 'FORMAT_STATUS_TRANSITION');
    // closing the open end works once ...
    await run("UPDATE geography.address_formats SET effective_to = '2031-01-01T00:00:00Z', updated_at = now() WHERE address_format_id = $1", [f]);
    // ... and the closed end can neither move nor reopen
    await expectRule(run("UPDATE geography.address_formats SET effective_to = '2030-06-01T00:00:00Z' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run("UPDATE geography.address_formats SET effective_to = '2032-01-01T00:00:00Z' WHERE address_format_id = $1", [f]), 'FORMAT_IMMUTABLE');
    await expectRule(run('UPDATE geography.address_formats SET effective_to = NULL WHERE address_format_id = $1', [f]), 'FORMAT_IMMUTABLE');
    // re-publishing (the same value) is not a change and a no-op touch is fine
    await run("UPDATE geography.address_formats SET status = 'PUBLISHED', updated_at = now() WHERE address_format_id = $1", [f]);
  });

  it('refuses every DELETE of a format, draft or published, and every UPDATE or DELETE of a field row', async () => {
    const country = await makeCountry();
    const d = await draft(country);
    const p = await publishedFormat(country);
    await expectRule(run('DELETE FROM geography.address_formats WHERE address_format_id = $1', [d]), 'NOT_DELETABLE');
    await expectRule(run('DELETE FROM geography.address_formats WHERE address_format_id = $1', [p]), 'NOT_DELETABLE');
    await expectRule(
      run("UPDATE geography.address_format_fields SET max_length = 5 WHERE address_format_id = $1 AND field_type = 'ADDRESS_LINE_1'", [d]),
      'ROW_IMMUTABLE',
    );
    await expectRule(run('UPDATE geography.address_format_fields SET required = false WHERE address_format_id = $1', [p]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM geography.address_format_fields WHERE address_format_id = $1', [d]), 'ROW_IMMUTABLE');
    await expectRule(run('DELETE FROM geography.address_format_fields WHERE address_format_id = $1', [p]), 'ROW_IMMUTABLE');
    expect((await q('SELECT count(*)::int AS n FROM geography.address_format_fields WHERE address_format_id = ANY($1)', [[d, p]]))[0]).toEqual({ n: 4 });
    // the seeded format is protected the same way
    await expectRule(run('DELETE FROM geography.address_formats WHERE address_format_id = $1', [us.formatId]), 'NOT_DELETABLE');
  });

  it('fields can be added only while the format is a DRAFT', async () => {
    const country = await makeCountry();
    const d = await draft(country, { template: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE}' });
    await insertField(d, { field_type: 'POSTAL_CODE', display_order: 3, required: false });
    await publish(d);
    await expectRule(insertField(d, { field_type: 'ADDRESS_LINE_2', display_order: 4, required: false }), 'FORMAT_NOT_DRAFT');
    await expectRule(insertField(us.formatId, { field_type: 'SORTING_CODE', display_order: 6, required: false }), 'FORMAT_NOT_DRAFT');
  });

  it('publication needs fields including a REQUIRED ADDRESS_LINE_1', async () => {
    const country = await makeCountry();
    const none = await draft(country, { fields: [], template: '{ADDRESS_LINE_1}' });
    await expectRule(publish(none), 'FORMAT_INCOMPLETE');
    const optionalLine1 = await draft(country, {
      fields: [{ field_type: 'ADDRESS_LINE_1', required: false }, { field_type: 'LOCALITY' }],
    });
    await expectRule(publish(optionalLine1), 'FORMAT_INCOMPLETE');
    const noLine1 = await draft(country, { fields: [{ field_type: 'LOCALITY' }], template: '{LOCALITY}' });
    await expectRule(publish(noLine1), 'FORMAT_INCOMPLETE');
    const ok = await draft(country);
    await publish(ok);
    for (const id of [none, optionalLine1, noLine1])
      expect((await q('SELECT status FROM geography.address_formats WHERE address_format_id = $1', [id]))[0]).toEqual({ status: 'DRAFT' });
  });

  it('publication needs a template that names every field of the format and only fields of the format', async () => {
    const country = await makeCountry();
    const unknownToken = await draft(country, { template: '{ADDRESS_LINE_1}\n{LOCALITY}\n{FOO}' });
    await expectRule(publish(unknownToken), 'FORMAT_TEMPLATE_MISMATCH');
    const undefinedField = await draft(country, { template: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE}' });
    await expectRule(publish(undefinedField), 'FORMAT_TEMPLATE_MISMATCH');
    const missingField = await draft(country, { template: '{ADDRESS_LINE_1}' });
    await expectRule(publish(missingField), 'FORMAT_TEMPLATE_MISMATCH');
    const noTokens = await draft(country, { template: 'plain text' });
    await expectRule(publish(noTokens), 'FORMAT_TEMPLATE_MISMATCH');
    const reordered = await draft(country, { template: '{LOCALITY} / {ADDRESS_LINE_1}' }); // order of tokens is free
    await publish(reordered);
  });

  it('a LOOKUP field needs at least one ACTIVE administrative area in the country at publication', async () => {
    const country = await makeCountry();
    const spec = (): FieldSpec[] => [{ field_type: 'ADDRESS_LINE_1' }, { field_type: 'ADMINISTRATIVE_AREA', input_type: 'LOOKUP' }];
    const template = '{ADDRESS_LINE_1}\n{ADMINISTRATIVE_AREA}';
    const none = await draft(country, { fields: spec(), template });
    await expectRule(publish(none), 'LOOKUP_WITHOUT_AREAS');
    await addArea(country, 'IN', { status: 'INACTIVE' });
    const onlyInactive = await draft(country, { fields: spec(), template });
    await expectRule(publish(onlyInactive), 'LOOKUP_WITHOUT_AREAS');
    // another country's areas do not count
    expect((await q("SELECT count(*)::int AS n FROM geography.administrative_areas WHERE status = 'ACTIVE' AND country_id = $1", [us.countryId]))[0]).toEqual({
      n: 51,
    });
    await expectRule(publish(none), 'LOOKUP_WITHOUT_AREAS');
    await addArea(country, 'ON');
    await publish(none);
    // a TEXT area field has no such prerequisite
    const free = await makeCountry();
    const text = await draft(free, { fields: [{ field_type: 'ADDRESS_LINE_1' }, { field_type: 'ADMINISTRATIVE_AREA' }], template });
    await publish(text);
  });
});

// ====================================================================== exclusion constraint
describe('address formats: exclusion constraint on PUBLISHED periods', () => {
  const overlap = async (p: Promise<unknown>) => {
    const e = await fail(p);
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23P01', constraint: 'ex_address_formats__no_overlap' });
  };

  it('rejects overlapping PUBLISHED periods of one country but allows adjacent half-open periods and the same period for another country', async () => {
    const a = await makeCountry();
    const b = await makeCountry();
    const v1 = await publishedFormat(a, '2030-01-01T00:00:00Z'); // [Jan, open)
    const v2 = await draft(a, { from: '2030-06-01T00:00:00Z' });
    await overlap(publish(v2)); // v1 is still open ended
    await run("UPDATE geography.address_formats SET effective_to = '2030-06-01T00:00:00Z', updated_at = now() WHERE address_format_id = $1", [v1]); // v1 = [Jan, Jun)
    await publish(v2); // [Jun, open): adjacent to v1, no overlap (half-open)
    // anything that reaches into [Jan, Jun) or [Jun, open) collides
    for (const from of ['2030-03-01T00:00:00Z', '2030-01-01T00:00:00Z', '2029-01-01T00:00:00Z', '2030-05-31T23:59:59Z', '2031-01-01T00:00:00Z']) {
      const v = await draft(a, { from });
      await overlap(publish(v));
    }
    // another country may use the very same period
    await publishedFormat(b, '2030-01-01T00:00:00Z');
    const bClosed = (await q<{ address_format_id: string }>('SELECT address_format_id FROM geography.address_formats WHERE country_id = $1', [b]))[0]!
      .address_format_id;
    await run("UPDATE geography.address_formats SET effective_to = '2030-06-01T00:00:00Z' WHERE address_format_id = $1", [bClosed]);
    const rows = await q<{ version: number; effective_from: Date; effective_to: Date | null }>(
      "SELECT version, effective_from, effective_to FROM geography.address_formats WHERE country_id = $1 AND status = 'PUBLISHED' ORDER BY effective_from",
      [a],
    );
    expect(rows.map((r) => [r.version, r.effective_from.toISOString(), r.effective_to?.toISOString() ?? null])).toEqual([
      [1, '2030-01-01T00:00:00.000Z', '2030-06-01T00:00:00.000Z'],
      [2, '2030-06-01T00:00:00.000Z', null],
    ]);
  });

  it('closing an open end that would reach into the successor is an overlap too; a closed predecessor leaves the future open', async () => {
    const a = await makeCountry();
    const v1 = await publishedFormat(a, '2030-01-01T00:00:00Z');
    await run("UPDATE geography.address_formats SET effective_to = '2030-03-01T00:00:00Z' WHERE address_format_id = $1", [v1]);
    const v2 = await draft(a, { from: '2030-02-01T00:00:00Z' });
    await overlap(publish(v2));
    const v3 = await draft(a, { from: '2030-03-01T00:00:00Z' });
    await publish(v3);
    // v1 cannot be re-closed later (immutable), so the periods can never drift into an overlap
    await expectRule(run("UPDATE geography.address_formats SET effective_to = '2030-04-01T00:00:00Z' WHERE address_format_id = $1", [v1]), 'FORMAT_IMMUTABLE');
  });

  it('only PUBLISHED rows take part: any number of DRAFTs may share the same period', async () => {
    const a = await makeCountry();
    await publishedFormat(a, '2030-01-01T00:00:00Z');
    await draft(a, { from: '2030-01-01T00:00:00Z' });
    await draft(a, { from: '2030-01-01T00:00:00Z' });
    await draft(a, { from: '2029-01-01T00:00:00Z' });
    expect((await q('SELECT count(*)::int AS n FROM geography.address_formats WHERE country_id = $1', [a]))[0]).toEqual({ n: 4 });
  });
});

// ====================================================================== addresses
describe('addresses', () => {
  const GEO = 'ST_SetSRID(ST_MakePoint(-117.8265, 33.6846), 4326)::geography';
  async function insertAddress(over: Record<string, unknown> = {}, location = 'NULL'): Promise<string> {
    const row: Record<string, unknown> = {
      country_id: us.countryId,
      address_format_id: us.formatId,
      administrative_area_id: us.caAreaId,
      administrative_area_code: 'CA',
      administrative_area_name: 'California',
      address_line_1: '123 Main St',
      locality: 'Irvine',
      postal_code: '92618',
      formatted_address: '123 Main St\nIrvine, CA 92618',
      validation_status: 'UNVERIFIED',
      validation_source: 'MANUAL',
      raw_input: JSON.stringify({ addressLine1: '123 Main St' }),
      ...over,
    };
    const names = Object.keys(row);
    const r = await pool.query(
      `INSERT INTO geography.addresses (${names.join(', ')}, location) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, ${location}) RETURNING address_id`,
      Object.values(row),
    );
    return r.rows[0].address_id as string;
  }
  const geocoded = { validation_status: 'GEOCODED', validation_source: 'GEOCODER', provider_code: 'mock' };

  it('stores a US address and reads it back whole (ids, snapshot name, format version, defaults)', async () => {
    const id = await insertAddress();
    const [row] = await q<Record<string, unknown>>('SELECT * FROM geography.addresses WHERE address_id = $1', [id]);
    expect(row).toMatchObject({
      country_id: us.countryId,
      address_format_id: us.formatId,
      administrative_area_id: us.caAreaId,
      administrative_area_code: 'CA',
      administrative_area_name: 'California',
      address_line_1: '123 Main St',
      address_line_2: null,
      locality: 'Irvine',
      postal_code: '92618',
      location: null,
      time_zone_id: null,
      validation_status: 'UNVERIFIED',
      validation_source: 'MANUAL',
      provider_code: null,
      provider_reference: null,
      raw_input: { addressLine1: '123 Main St' },
    });
    expect(row!.created_at).toBeInstanceOf(Date);
    // a free-text area (no id, no code) keeps only the name
    await insertAddress({ administrative_area_id: null, administrative_area_code: null, administrative_area_name: 'Ontario' });
    await insertAddress({ administrative_area_id: null, administrative_area_code: null, administrative_area_name: null, locality: null, postal_code: null });
  });

  it('is immutable: every UPDATE is refused (even a no-op), a DELETE is allowed', async () => {
    const id = await insertAddress();
    await expectRule(run("UPDATE geography.addresses SET address_line_1 = '1 Other St' WHERE address_id = $1", [id]), 'ROW_IMMUTABLE');
    await expectRule(run('UPDATE geography.addresses SET address_line_1 = address_line_1 WHERE address_id = $1', [id]), 'ROW_IMMUTABLE');
    await expectRule(run("UPDATE geography.addresses SET validation_status = 'FORMAT_VALID' WHERE address_id = $1", [id]), 'ROW_IMMUTABLE');
    await expectRule(
      run('UPDATE geography.addresses SET location = ST_SetSRID(ST_MakePoint(1, 2), 4326)::geography WHERE address_id = $1', [id]),
      'ROW_IMMUTABLE',
    );
    expect((await q('SELECT address_line_1 FROM geography.addresses WHERE address_id = $1', [id]))[0]).toEqual({ address_line_1: '123 Main St' });
    // erasure is possible (retention policy is a later checkpoint); referencing tables will RESTRICT
    await run('DELETE FROM geography.addresses WHERE address_id = $1', [id]);
    expect((await q('SELECT count(*)::int AS n FROM geography.addresses WHERE address_id = $1', [id]))[0]).toEqual({ n: 0 });
  });

  it('keeps country, format version and administrative area consistent (composite foreign keys)', async () => {
    const zz = await makeCountry();
    const zzFormat = await publishedFormat(zz);
    const zzArea = await addArea(zz, 'ZP');
    // the area of another country is rejected whatever code is given
    expect(await constraintOf(insertAddress({ country_id: zz, address_format_id: zzFormat }))).toBe('fk_addresses__area_country_code');
    expect(
      await constraintOf(
        insertAddress({
          country_id: zz,
          address_format_id: zzFormat,
          administrative_area_id: us.caAreaId,
          administrative_area_code: 'ZP',
          administrative_area_name: 'x',
        }),
      ),
    ).toBe('fk_addresses__area_country_code');
    // the format of another country is rejected
    expect(await constraintOf(insertAddress({ country_id: zz }))).toBe('fk_addresses__format_country');
    expect(await constraintOf(insertAddress({ address_format_id: zzFormat }))).toBe('fk_addresses__format_country');
    // a registered country
    expect(await constraintOf(insertAddress({ country_id: crypto.randomUUID() }))).toBe('fk_addresses__country_id');
    // the same country, format and area is accepted
    await insertAddress({
      country_id: zz,
      address_format_id: zzFormat,
      administrative_area_id: zzArea,
      administrative_area_code: 'ZP',
      administrative_area_name: 'Area ZP',
    });
  });

  it('keeps area id, code and name consistent: all or nothing, the code equals the area code, the name accompanies a code', async () => {
    expect(await constraintOf(insertAddress({ administrative_area_code: null, administrative_area_name: null }))).toBe('ck_addresses__area_consistent');
    expect(await constraintOf(insertAddress({ administrative_area_id: null }))).toBe('ck_addresses__area_consistent');
    expect(await constraintOf(insertAddress({ administrative_area_name: null }))).toBe('ck_addresses__area_consistent');
    // the code must be the code of THAT area (composite foreign key with the id)
    expect(await constraintOf(insertAddress({ administrative_area_code: 'NY' }))).toBe('fk_addresses__area_country_code');
    // an unknown area id is stopped by the guard (it cannot be ACTIVE) before the foreign key is checked
    await expectRule(insertAddress({ administrative_area_id: crypto.randomUUID() }), 'AREA_NOT_ACTIVE');
    // the name is a snapshot and may differ from today's area name
    await insertAddress({ administrative_area_name: 'Kalifornien' });
  });

  it('the area must be ACTIVE and the time zone must be ACTIVE (guard)', async () => {
    const zz = await makeCountry();
    const zzFormat = await publishedFormat(zz);
    const inactive = await addArea(zz, 'OFF', { status: 'INACTIVE' });
    await expectRule(
      insertAddress({
        country_id: zz,
        address_format_id: zzFormat,
        administrative_area_id: inactive,
        administrative_area_code: 'OFF',
        administrative_area_name: 'Area OFF',
      }),
      'AREA_NOT_ACTIVE',
    );
    await run("INSERT INTO geography.time_zones (iana_name) VALUES ('Europe/London')"); // registered PLANNED, not ACTIVE
    const planned = (await q<{ time_zone_id: string }>("SELECT time_zone_id FROM geography.time_zones WHERE iana_name = 'Europe/London'"))[0]!.time_zone_id;
    await expectRule(insertAddress({ time_zone_id: planned }), 'TIME_ZONE_NOT_ACTIVE');
    await run("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'Europe/London'");
    await expectRule(insertAddress({ time_zone_id: planned }), 'TIME_ZONE_NOT_ACTIVE');
    // an unknown zone id is stopped by the guard before the foreign key is checked
    await expectRule(insertAddress({ time_zone_id: crypto.randomUUID() }), 'TIME_ZONE_NOT_ACTIVE');
    const active = (await q<{ time_zone_id: string }>("SELECT time_zone_id FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'"))[0]!
      .time_zone_id;
    const id = await insertAddress({ time_zone_id: active, ...geocoded }, GEO);
    expect(
      (
        await q('SELECT t.iana_name FROM geography.addresses a JOIN geography.time_zones t ON t.time_zone_id = a.time_zone_id WHERE a.address_id = $1', [id])
      )[0],
    ).toEqual({
      iana_name: 'America/Los_Angeles',
    });
  });

  it('only a PUBLISHED format in the same country can be used (guard): a DRAFT or a missing format is refused', async () => {
    const zz = await makeCountry();
    const d = await draft(zz);
    await expectRule(
      insertAddress({ country_id: zz, address_format_id: d, administrative_area_id: null, administrative_area_code: null, administrative_area_name: null }),
      'FORMAT_NOT_PUBLISHED',
    );
    await expectRule(insertAddress({ address_format_id: crypto.randomUUID() }), 'FORMAT_NOT_PUBLISHED');
    await publish(d);
    await insertAddress({ country_id: zz, address_format_id: d, administrative_area_id: null, administrative_area_code: null, administrative_area_name: null });
  });

  it('a published format that has been superseded (closed) can still be referenced by the address row it validated', async () => {
    const zz = await makeCountry();
    const v1 = await publishedFormat(zz, '2020-01-01T00:00:00Z');
    const naked = { country_id: zz, administrative_area_id: null, administrative_area_code: null, administrative_area_name: null };
    const id = await insertAddress({ ...naked, address_format_id: v1 });
    await run("UPDATE geography.address_formats SET effective_to = '2021-01-01T00:00:00Z' WHERE address_format_id = $1", [v1]);
    const v2 = await draft(zz, { from: '2021-01-01T00:00:00Z' });
    await publish(v2);
    expect((await q('SELECT address_format_id FROM geography.addresses WHERE address_id = $1', [id]))[0]).toEqual({ address_format_id: v1 });
  });

  it('GEOCODED and VERIFIED need a location; MANUAL is never located; AUTOCOMPLETE is never VERIFIED; VERIFIED needs GEOCODER or ADMIN', async () => {
    expect(await constraintOf(insertAddress(geocoded))).toBe('ck_addresses__located_status_has_location');
    expect(await constraintOf(insertAddress({ validation_status: 'VERIFIED', validation_source: 'GEOCODER', provider_code: 'mock' }))).toBe(
      'ck_addresses__located_status_has_location',
    );
    expect(await constraintOf(insertAddress({ validation_status: 'VERIFIED', validation_source: 'ADMIN' }))).toBe('ck_addresses__located_status_has_location');
    // MANUAL never located
    expect(await constraintOf(insertAddress({}, GEO))).toBe('ck_addresses__manual_is_not_located');
    expect(await constraintOf(insertAddress({ validation_status: 'GEOCODED' }, GEO))).toBe('ck_addresses__manual_is_not_located');
    expect(await constraintOf(insertAddress({ validation_status: 'VERIFIED' }, GEO))).toMatch(/ck_addresses__(manual_is_not_located|verified_source)/);
    // AUTOCOMPLETE is never VERIFIED
    expect(await constraintOf(insertAddress({ validation_status: 'VERIFIED', validation_source: 'AUTOCOMPLETE', provider_code: 'mock' }, GEO))).toBe(
      'ck_addresses__autocomplete_is_not_verified',
    );
    expect(await constraintOf(insertAddress({ validation_status: 'GEOCODED', validation_source: 'AUTOCOMPLETE', provider_code: 'mock' }, GEO))).toBe(
      'ck_addresses__autocomplete_is_not_verified',
    );
    // VERIFIED only from GEOCODER or ADMIN
    expect(await constraintOf(insertAddress({ validation_status: 'VERIFIED', validation_source: 'IMPORTED' }, GEO))).toBe('ck_addresses__verified_source');
    await insertAddress({ validation_status: 'VERIFIED', validation_source: 'GEOCODER', provider_code: 'mock' }, GEO);
    await insertAddress({ validation_status: 'VERIFIED', validation_source: 'ADMIN' }, GEO);
    // allowed combinations
    await insertAddress({ validation_status: 'FORMAT_VALID', validation_source: 'AUTOCOMPLETE', provider_code: 'mock', provider_reference: 'place-1' });
    await insertAddress({ validation_status: 'FORMAT_VALID', validation_source: 'AUTOCOMPLETE', provider_code: 'mock' }, GEO); // an autocomplete selection may carry coordinates
    await insertAddress({ validation_status: 'INVALID', validation_source: 'MANUAL' });
    await insertAddress({ validation_status: 'FORMAT_VALID', validation_source: 'MANUAL' });
    await insertAddress({ validation_status: 'GEOCODED', validation_source: 'IMPORTED' }, GEO);
    await insertAddress({ validation_status: 'GEOCODED', validation_source: 'ADMIN' }, GEO);
  });

  it('provider code and reference rules: required for AUTOCOMPLETE and GEOCODER, absent for MANUAL and ADMIN, optional for IMPORTED, well-formed, reference needs a code', async () => {
    expect(await constraintOf(insertAddress({ validation_status: 'FORMAT_VALID', validation_source: 'AUTOCOMPLETE' }))).toBe('ck_addresses__provider');
    expect(await constraintOf(insertAddress({ validation_status: 'GEOCODED', validation_source: 'GEOCODER' }, GEO))).toBe('ck_addresses__provider');
    expect(await constraintOf(insertAddress({ provider_code: 'mock' }))).toBe('ck_addresses__provider');
    expect(await constraintOf(insertAddress({ validation_status: 'GEOCODED', validation_source: 'ADMIN', provider_code: 'mock' }, GEO))).toBe(
      'ck_addresses__provider',
    );
    await insertAddress({ validation_status: 'UNVERIFIED', validation_source: 'IMPORTED' });
    await insertAddress({ validation_status: 'UNVERIFIED', validation_source: 'IMPORTED', provider_code: 'legacy-import', provider_reference: 'row-7' });
    for (const bad of ['Mock', 'm', '1mock', 'mo ck', 'a'.repeat(41), 'mock!'])
      expect(await constraintOf(insertAddress({ ...geocoded, provider_code: bad }, GEO)), `provider ${bad}`).toBe('ck_addresses__provider_code_format');
    await insertAddress({ ...geocoded, provider_code: 'a'.repeat(40) }, GEO);
    await insertAddress({ ...geocoded, provider_code: 'a1_b-2' }, GEO);
    // a reference without a code, blank, too long, with a control character
    expect(await constraintOf(insertAddress({ provider_reference: 'ref' }))).toBe('ck_addresses__provider_reference');
    for (const bad of ['', '   ', 'x'.repeat(201), 'a\tb'])
      expect(await constraintOf(insertAddress({ ...geocoded, provider_reference: bad }, GEO)), `reference ${JSON.stringify(bad.slice(0, 6))}`).toBe(
        'ck_addresses__provider_reference',
      );
    await insertAddress({ ...geocoded, provider_reference: 'x'.repeat(200) }, GEO);
  });

  it('raw_input must be a JSON object of at most 4000 characters (boundary 4000 accepted, 4001 refused)', async () => {
    for (const bad of ['[]', '"text"', '42', 'null', 'true', '[{"a": 1}]'])
      expect(await constraintOf(insertAddress({ raw_input: bad })), `raw ${bad}`).toBe('ck_addresses__raw_input');
    // jsonb renders {"k": "<n chars>"} as n + 9 characters
    const exactly = JSON.stringify({ k: 'x'.repeat(3991) });
    const id = await insertAddress({ raw_input: exactly });
    expect((await q<{ n: number }>('SELECT length(raw_input::text)::int AS n FROM geography.addresses WHERE address_id = $1', [id]))[0]).toEqual({ n: 4000 });
    expect(await constraintOf(insertAddress({ raw_input: JSON.stringify({ k: 'x'.repeat(3992) }) }))).toBe('ck_addresses__raw_input');
    await insertAddress({ raw_input: '{}' });
    const [notNull] = [await fail(insertAddress({ raw_input: null }))];
    expect(notNull.code).toBe('23502');
  });

  it('refuses malformed text, formatted address, status and source values (each CHECK)', async () => {
    for (const bad of ['', '   ', 'x'.repeat(201)])
      expect(await constraintOf(insertAddress({ address_line_1: bad })), `line1 ${bad.length}`).toBe('ck_addresses__text_values');
    for (const col of ['organization', 'address_line_2', 'dependent_locality', 'locality', 'administrative_area_name', 'postal_code', 'sorting_code']) {
      const over = (v: string) => (col === 'administrative_area_name' ? { administrative_area_name: v } : { [col]: v });
      expect(await constraintOf(insertAddress(over(''))), `${col} blank`).toBe('ck_addresses__text_values');
      expect(await constraintOf(insertAddress(over('x'.repeat(201)))), `${col} long`).toBe('ck_addresses__text_values');
    }
    await insertAddress({
      address_line_1: 'x'.repeat(200),
      address_line_2: 'x'.repeat(200),
      organization: 'Org',
      dependent_locality: 'Dep',
      sorting_code: 'S1',
    });
    for (const bad of ['', '  ', 'x'.repeat(1501)])
      expect(await constraintOf(insertAddress({ formatted_address: bad })), `formatted ${bad.length}`).toBe('ck_addresses__formatted_address');
    await insertAddress({ formatted_address: 'x'.repeat(1500) });
    expect(await constraintOf(insertAddress({ validation_status: 'DELIVERABLE', validation_source: 'IMPORTED' }))).toBe('ck_addresses__validation_status');
    expect(await constraintOf(insertAddress({ validation_source: 'USER' }))).toBe('ck_addresses__validation_source');
    expect((await fail(insertAddress({ address_line_1: null }))).code).toBe('23502');
    expect((await fail(insertAddress({ formatted_address: null }))).code).toBe('23502');
  });

  it('has no US-specific columns: the country-specific parts are rows (areas, format fields), the table uses generic names', async () => {
    const columns = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'geography' AND table_name = 'addresses' ORDER BY ordinal_position",
      )
    ).map((c) => c.column_name);
    // exact column set: adding a column to the canonical address is a deliberate data-model change that must update this list
    expect(columns).toEqual([
      'address_id',
      'country_id',
      'address_format_id',
      'administrative_area_id',
      'administrative_area_code',
      'administrative_area_name',
      'organization',
      'address_line_1',
      'address_line_2',
      'dependent_locality',
      'locality',
      'postal_code',
      'sorting_code',
      'location',
      'time_zone_id',
      'formatted_address',
      'validation_status',
      'validation_source',
      'provider_code',
      'provider_reference',
      'raw_input',
      'created_at',
    ]);
    // A bare /us|zip|state/i would also match "validation_status" ("status" contains "us"), so match whole underscore-separated words: no word of any
    // column names a country, a US-only concept (zip, state, county) or a country-specific administrative division.
    const forbiddenWords = ['us', 'usa', 'zip', 'zipcode', 'state', 'county', 'province', 'prefecture', 'canton', 'department', 'ssn', 'apn'];
    const offenders = columns.filter((c) => c.split('_').some((w) => forbiddenWords.includes(w)));
    expect(offenders).toEqual([]);
    // the same holds for the format and area tables (no per-country column such as zip_pattern)
    const others = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'geography' AND table_name IN ('address_formats', 'address_format_fields', 'administrative_areas')",
      )
    ).map((c) => c.column_name);
    expect(others.filter((c) => c.split('_').some((w) => forbiddenWords.includes(w)))).toEqual([]);
    // and there is no separate postal-code rules table: postal rules live on the POSTAL_CODE field of the format version
    expect(await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'geography' AND table_name LIKE '%postal%'")).toEqual([]);
  });

  it('keeps a single geography(Point,4326) location: a non-point or a different SRID is rejected, a point round trips with ST_Y/ST_X', async () => {
    const typmod = await q<{ type: string }>(
      "SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = 'geography.addresses'::regclass AND a.attname = 'location'",
    );
    expect(typmod).toEqual([{ type: 'geography(Point,4326)' }]);
    const located = { ...geocoded };
    expect((await fail(insertAddress(located, "ST_GeogFromText('LINESTRING(0 0, 1 1)')"))).message).toMatch(/does not match column type|Point/i);
    expect((await fail(insertAddress(located, "ST_GeogFromText('POLYGON((0 0, 1 0, 1 1, 0 0))')"))).message).toMatch(/does not match column type|Point/i);
    expect((await fail(insertAddress(located, "ST_GeogFromText('MULTIPOINT((0 0), (1 1))')"))).message).toMatch(/does not match column type|Point/i);
    expect((await fail(insertAddress(located, "ST_GeogFromText('SRID=4269;POINT(1 2)')"))).message).toMatch(/SRID/i);
    expect((await fail(insertAddress(located, 'ST_SetSRID(ST_MakePoint(1, 2), 3857)::geography'))).message).toMatch(/lon\/lat|SRID/i);
    const id = await insertAddress(located, 'ST_SetSRID(ST_MakePoint(-117.8265, 33.6846), 4326)::geography');
    const [p] = await q<{ lat: number; lng: number; srid: number; kind: string }>(
      'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, ST_SRID(location::geometry) AS srid, GeometryType(location::geometry) AS kind FROM geography.addresses WHERE address_id = $1',
      [id],
    );
    expect(p!.lat).toBeCloseTo(33.6846, 9);
    expect(p!.lng).toBeCloseTo(-117.8265, 9);
    expect([p!.srid, p!.kind]).toEqual([4326, 'POINT']);
    // the point is where it should be: roughly 1 km from a point 0.01 degrees of latitude away is false, 1.1 km is true
    const [d] = await q<{ m: number }>(
      'SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(-117.8265, 33.6946), 4326)::geography) AS m FROM geography.addresses WHERE address_id = $1',
      [id],
    );
    expect(d!.m).toBeGreaterThan(1000);
    expect(d!.m).toBeLessThan(1200);
  });
});

// ====================================================================== audit events
describe('audit_events: subject rules after migration 0008', () => {
  let marketId: string;
  const ins = (action: string, subject: { country?: string | null; market?: string | null; format?: string | null }) =>
    run(
      `INSERT INTO geography.audit_events (actor, action, country_id, market_id, address_format_id, reason, correlation_id) VALUES ('tester', $1, $2, $3, $4, 'test', 'corr-model')`,
      [action, subject.country ?? null, subject.market ?? null, subject.format ?? null],
    );
  beforeAll(async () => {
    marketId = (await q<{ market_id: string }>("SELECT market_id FROM geography.markets WHERE code = 'la-oc'"))[0]!.market_id;
  });

  it('ADDRESS_FORMAT_* actions need address_format_id and no other subject', async () => {
    for (const action of ['ADDRESS_FORMAT_DRAFTED', 'ADDRESS_FORMAT_PUBLISHED']) {
      await ins(action, { format: us.formatId });
      expect(await constraintOf(ins(action, {})), `${action} without subject`).toBe('ck_audit_events__subject');
      expect(await constraintOf(ins(action, { format: us.formatId, country: us.countryId })), `${action} + country`).toBe('ck_audit_events__subject');
      expect(await constraintOf(ins(action, { format: us.formatId, market: marketId })), `${action} + market`).toBe('ck_audit_events__subject');
      expect(await constraintOf(ins(action, { country: us.countryId })), `${action} with country instead`).toBe('ck_audit_events__subject');
      expect(await constraintOf(ins(action, { market: marketId })), `${action} with market instead`).toBe('ck_audit_events__subject');
    }
    expect(await constraintOf(ins('ADDRESS_FORMAT_DRAFTED', { format: crypto.randomUUID() }))).toBe('fk_audit_events__address_format_id');
  });

  it('the old actions still need their own subject and never an address format', async () => {
    await ins('COUNTRY_UPDATED', { country: us.countryId });
    await ins('MARKET_UPDATED', { market: marketId });
    await ins('COUNTRY_ADMINISTRATIVE_AREAS_UPDATED', { country: us.countryId });
    expect(await constraintOf(ins('COUNTRY_UPDATED', {}))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('COUNTRY_UPDATED', { country: us.countryId, format: us.formatId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('COUNTRY_UPDATED', { format: us.formatId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('COUNTRY_UPDATED', { country: us.countryId, market: marketId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('MARKET_UPDATED', { country: us.countryId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('MARKET_UPDATED', { market: marketId, format: us.formatId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('COUNTRY_ADMINISTRATIVE_AREAS_UPDATED', { format: us.formatId }))).toBe('ck_audit_events__subject');
    expect(await constraintOf(ins('COUNTRY_ADMINISTRATIVE_AREAS_UPDATED', {}))).toBe('ck_audit_events__subject');
  });

  it('refuses actions outside the vocabulary (the widened CHECK is not open ended)', async () => {
    for (const action of ['ADDRESS_FORMAT_DELETED', 'ADDRESS_FORMAT', 'ADDRESS_CREATED', 'COUNTRY_DELETED', 'COUNTRY_ADMINISTRATIVE_AREAS_DELETED', ''])
      expect(await constraintOf(ins(action, { format: us.formatId })), action).toBe('ck_audit_events__action');
  });

  it('stays append-only: UPDATE and DELETE are refused, including rows that carry the new subject', async () => {
    const [row] = await q<{ audit_event_id: string }>(
      'SELECT audit_event_id FROM geography.audit_events WHERE address_format_id IS NOT NULL ORDER BY occurred_at, audit_event_id LIMIT 1',
    );
    const before = (await q('SELECT count(*)::int AS n FROM geography.audit_events'))[0];
    expect((await fail(run("UPDATE geography.audit_events SET reason = 'tampered' WHERE audit_event_id = $1", [row!.audit_event_id]))).message).toMatch(
      /append|immutable|not allowed|cannot/i,
    );
    expect((await fail(run('UPDATE geography.audit_events SET address_format_id = NULL WHERE audit_event_id = $1', [row!.audit_event_id]))).message).toMatch(
      /append|immutable|not allowed|cannot/i,
    );
    expect((await fail(run('DELETE FROM geography.audit_events WHERE audit_event_id = $1', [row!.audit_event_id]))).message).toMatch(
      /append|immutable|not allowed|cannot/i,
    );
    expect((await q('SELECT count(*)::int AS n FROM geography.audit_events'))[0]).toEqual(before);
    // a format with audit rows can never be deleted either (and the guard fires before the foreign key)
    await expectRule(run('DELETE FROM geography.address_formats WHERE address_format_id = $1', [us.formatId]), 'NOT_DELETABLE');
  });

  it('keeps `changes` a JSON object (unchanged rule) for the new actions', async () => {
    expect(
      await constraintOf(
        run(
          "INSERT INTO geography.audit_events (actor, action, address_format_id, changes, reason, correlation_id) VALUES ('t', 'ADDRESS_FORMAT_PUBLISHED', $1, '[1]'::jsonb, 'r', 'c')",
          [us.formatId],
        ),
      ),
    ).toBe('ck_audit_events__changes_object');
  });
});
