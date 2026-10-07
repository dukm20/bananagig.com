import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from './index';

// Migration 0007 creates the geography schema and seeds launch reference data (US, USD, four US time zones, the US display-name
// content entry and the PLANNED market la-oc). These tests prove the seeded state from zero and, against the REAL triggers and
// constraints, every database-level activation/integrity rule. Service-level behaviour is covered in packages/geography.
let iso: IsolatedDatabase;
let pool: pg.Pool;
let seq = 0;
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
const messageOf = async (p: Promise<unknown>): Promise<string> => String(((await rejection(p)) as Error).message);
/** The machine-readable key a guard puts in the error DETAIL (undefined when the statement did not fail or the error has no detail). */
const detailOf = async (p: Promise<unknown>): Promise<string | undefined> => ((await rejection(p)) as { detail?: string } | undefined)?.detail;
const rule = (key: string): string => `geography_rule:${key}`;

/** A fresh PLANNED country (never ACTIVE implicitly) with its links, for rule tests that must not touch the seeded US. */
async function makeCountry(opts: { alpha2: string; locales?: string[]; defaultLocale?: string; zones?: string[]; currency?: string } = { alpha2: 'ZZ' }) {
  const n = ++seq;
  const alpha2 = opts.alpha2;
  const locales = opts.locales ?? ['en-US'];
  const defaultLocale = opts.defaultLocale ?? locales[0]!;
  const zones = opts.zones ?? ['America/Los_Angeles'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query(
      `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
       VALUES ($1, $2, $3, 'geography.country.us.name', 'PLANNED', '+999', $4, $5, 'KILOMETERS', 'MONDAY', 'DMY', '24_HOUR') RETURNING country_id`,
      [alpha2, `${alpha2}Z`, String(900 + n).padStart(3, '0'), opts.currency ?? 'USD', defaultLocale],
    );
    const id = c.rows[0].country_id as string;
    for (const l of locales) await client.query('INSERT INTO geography.country_locales (country_id, locale) VALUES ($1, $2)', [id, l]);
    for (const z of zones)
      await client.query(
        'INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT $1, time_zone_id FROM geography.time_zones WHERE iana_name = $2',
        [id, z],
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
async function makeMarket(
  countryId: string,
  code: string,
  o: { locale?: string; currency?: string; zone?: string; status?: string; extraLocales?: string[] } = {},
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = await client.query(
      `INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
       SELECT $2, $2, $1, $3, $4, $5, time_zone_id, now() FROM geography.time_zones WHERE iana_name = $6 RETURNING market_id`,
      [countryId, code, o.status ?? 'PLANNED', o.locale ?? 'en-US', o.currency ?? 'USD', o.zone ?? 'America/Los_Angeles'],
    );
    const id = m.rows[0].market_id as string;
    for (const l of new Set([o.locale ?? 'en-US', ...(o.extraLocales ?? [])]))
      await client.query('INSERT INTO geography.market_locales (market_id, country_id, locale) VALUES ($1, $2, $3)', [id, countryId, l]);
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
const activate = (table: 'countries' | 'markets', idCol: string, id: string) =>
  run(`UPDATE geography.${table} SET status = 'ACTIVE', updated_at = now() WHERE ${idCol} = $1`, [id]);
const registerLocale = (tag: string, active: boolean) => run('INSERT INTO content.locales (locale, is_active) VALUES ($1, $2)', [tag, active]);

describe('seeded launch reference data (migration 0007)', () => {
  it('seeds USD with its ISO data and minor-unit digits', async () => {
    expect(await q('SELECT currency_code, numeric_code, minor_unit_digits, display_name, symbol, status FROM geography.currencies')).toEqual([
      { currency_code: 'USD', numeric_code: '840', minor_unit_digits: 2, display_name: 'US Dollar', symbol: '$', status: 'ACTIVE' },
    ]);
  });
  it('seeds the United States as an ACTIVE country with data-driven defaults', async () => {
    const [us] = await q('SELECT * FROM geography.countries');
    expect(us).toMatchObject({
      iso_alpha2: 'US',
      iso_alpha3: 'USA',
      iso_numeric: '840',
      status: 'ACTIVE',
      dialing_code: '+1',
      default_currency_code: 'USD',
      default_locale: 'en-US',
      distance_unit: 'MILES',
      first_day_of_week: 'SUNDAY',
      date_format_code: 'MDY',
      time_format_code: '12_HOUR',
      display_name_content_key: 'geography.country.us.name',
    });
    expect((await q('SELECT count(*)::int AS n FROM geography.countries'))[0]).toEqual({ n: 1 });
  });
  it('seeds only the four US time zones needed, all valid IANA names and linked to the US', async () => {
    const zones = await q<{ iana_name: string; status: string }>('SELECT iana_name, status FROM geography.time_zones ORDER BY iana_name');
    expect(zones).toEqual([
      { iana_name: 'America/Chicago', status: 'ACTIVE' },
      { iana_name: 'America/Denver', status: 'ACTIVE' },
      { iana_name: 'America/Los_Angeles', status: 'ACTIVE' },
      { iana_name: 'America/New_York', status: 'ACTIVE' },
    ]);
    expect((await q('SELECT count(*)::int AS n FROM geography.country_time_zones'))[0]).toEqual({ n: 4 });
  });
  it('seeds exactly one market, la-oc, as PLANNED (never active until activated through the API), inside the US', async () => {
    const rows = await q(
      'SELECT m.code, m.name, m.status, m.default_locale, m.currency_code, t.iana_name, c.iso_alpha2 FROM geography.markets m JOIN geography.time_zones t ON t.time_zone_id = m.default_time_zone_id JOIN geography.countries c ON c.country_id = m.country_id',
    );
    expect(rows).toEqual([
      { code: 'la-oc', name: 'LA & OC', status: 'PLANNED', default_locale: 'en-US', currency_code: 'USD', iana_name: 'America/Los_Angeles', iso_alpha2: 'US' },
    ]);
  });
  it('keeps content.locales the single locale authority: en-US gained a display name and derived language/script/region', async () => {
    expect(await q('SELECT locale, display_name, language, script, region, is_active, is_platform_default FROM content.locales')).toEqual([
      { locale: 'en-US', display_name: 'English (United States)', language: 'en', script: null, region: 'US', is_active: true, is_platform_default: true },
    ]);
    await registerLocale('zh-Hant-TW', false);
    await registerLocale('es-419', false);
    await registerLocale('fil', false);
    const rows = await q('SELECT locale, display_name, language, script, region FROM content.locales WHERE locale IN ($1, $2, $3) ORDER BY locale', [
      'zh-Hant-TW',
      'es-419',
      'fil',
    ]);
    expect(rows).toEqual([
      { locale: 'es-419', display_name: 'es-419', language: 'es', script: null, region: '419' },
      { locale: 'fil', display_name: 'fil', language: 'fil', script: null, region: null },
      { locale: 'zh-Hant-TW', display_name: 'zh-Hant-TW', language: 'zh', script: 'Hant', region: 'TW' },
    ]);
    // the locale tables are still not duplicated anywhere in geography
    expect(await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'geography' AND table_name = 'locales'")).toEqual([]);
  });
  it('seeds the country display name as managed content (one PUBLISHED en-US version through the real lifecycle)', async () => {
    const rows = await q<{ body: string; status: string; n: string }>(
      "SELECT v.body, v.status, (SELECT count(*) FROM content.audit_events a WHERE a.entry_id = e.entry_id) AS n FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id WHERE e.key = 'geography.country.us.name'",
    );
    expect(rows).toEqual([{ body: 'United States', status: 'PUBLISHED', n: '5' }]);
  });
  it('records the seed in the geography audit trail and emits no outbox events', async () => {
    const actions = (
      await q<{ action: string }>("SELECT action FROM geography.audit_events WHERE correlation_id = 'seed-0007' ORDER BY occurred_at, action")
    ).map((r) => r.action);
    expect(actions.sort()).toEqual(['COUNTRY_ACTIVATED', 'COUNTRY_CREATED', 'MARKET_CREATED']);
    expect((await q("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.geography.%'"))[0]).toEqual({ n: 0 });
  });
});

describe('format and identity constraints', () => {
  it('enforces unique and well-formed ISO codes, currency codes, locale tags, IANA names and market codes', async () => {
    const dupe = (extra: string) =>
      `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code) VALUES (${extra}, 'geography.country.us.name', '+1', 'USD', 'en-US', 'MILES', 'SUNDAY', 'MDY', '12_HOUR')`;
    expect(await messageOf(run(dupe("'US', 'ZZZ', '998'")))).toContain('uq_countries__iso_alpha2');
    expect(await messageOf(run(dupe("'ZY', 'USA', '998'")))).toContain('uq_countries__iso_alpha3');
    expect(await messageOf(run(dupe("'ZY', 'ZYY', '840'")))).toContain('uq_countries__iso_numeric');
    expect(await messageOf(run(dupe("'zy', 'ZYY', '998'")))).toContain('ck_countries__iso_alpha2_format');
    expect(
      await messageOf(run("INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name) VALUES ('USD', '999', 2, 'x')")),
    ).toContain('pk_currencies');
    expect(
      await messageOf(run("INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name) VALUES ('ABC', '840', 2, 'x')")),
    ).toContain('uq_currencies__numeric_code');
    expect(
      await messageOf(run("INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name) VALUES ('ABC', '777', 5, 'x')")),
    ).toContain('ck_currencies__minor_unit_digits');
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Los_Angeles')"))).toContain('uq_time_zones__iana_name');
    expect(await messageOf(run("INSERT INTO content.locales (locale) VALUES ('en-US')"))).toContain('pk_locales');
    expect(await messageOf(run("INSERT INTO content.locales (locale) VALUES ('en_US')"))).toContain('ck_locales__bcp47_format');
  });
  it('supports currencies that do not have two decimals', async () => {
    await run(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name) VALUES ('JPY', '392', 0, 'Yen'), ('KWD', '414', 3, 'Kuwaiti Dinar')",
    );
    expect(await q("SELECT currency_code, minor_unit_digits FROM geography.currencies WHERE currency_code IN ('JPY', 'KWD') ORDER BY 1")).toEqual([
      { currency_code: 'JPY', minor_unit_digits: 0 },
      { currency_code: 'KWD', minor_unit_digits: 3 },
    ]);
  });
  it('only accepts real IANA names (the database tz database is the authority) and never offsets as identity', async () => {
    await run("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Phoenix')");
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('Mars/Olympus_Mons')"))).toContain('not an IANA time zone');
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('UTC+5')"))).toContain('not an IANA time zone');
    // a malformed name is rejected too (the BEFORE INSERT trigger fires ahead of the CHECK constraint, so the message is the trigger's)
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('america/los angeles')"))).toContain('not an IANA time zone');
  });
  it('validates the enumerated format settings and the dialing code', async () => {
    const bad = (col: string, v: string) => run(`UPDATE geography.countries SET ${col} = $1 WHERE iso_alpha2 = 'US'`, [v]);
    expect(await messageOf(bad('distance_unit', 'FURLONGS'))).toContain('ck_countries__distance_unit');
    expect(await messageOf(bad('time_format_code', '13_HOUR'))).toContain('ck_countries__time_format_code');
    expect(await messageOf(bad('date_format_code', 'DYM'))).toContain('ck_countries__date_format_code');
    expect(await messageOf(bad('first_day_of_week', 'FUNDAY'))).toContain('ck_countries__first_day_of_week');
    expect(await messageOf(bad('dialing_code', '1'))).toContain('ck_countries__dialing_code_format');
    expect(await messageOf(bad('status', 'OPEN'))).toContain('ck_countries__status');
  });
  it('rejects a country display name that is not an existing content entry', async () => {
    expect(
      await messageOf(run("UPDATE geography.countries SET display_name_content_key = 'geography.country.nowhere.name' WHERE iso_alpha2 = 'US'")),
    ).toContain('fk_countries__display_name_content_key');
  });
});

describe('immutability and retention', () => {
  it('forbids deleting reference rows and changing identities', async () => {
    expect(await messageOf(run("DELETE FROM geography.countries WHERE iso_alpha2 = 'US'"))).toContain('cannot be deleted');
    expect(await messageOf(run("DELETE FROM geography.currencies WHERE currency_code = 'USD'"))).toContain('cannot be deleted');
    expect(await messageOf(run("DELETE FROM geography.markets WHERE code = 'la-oc'"))).toContain('cannot be deleted');
    expect(await messageOf(run("DELETE FROM geography.time_zones WHERE iana_name = 'America/Denver'"))).toContain('cannot be deleted');
    expect(await messageOf(run("UPDATE geography.countries SET iso_alpha2 = 'XX' WHERE iso_alpha2 = 'US'"))).toContain('identity');
    expect(await messageOf(run("UPDATE geography.currencies SET minor_unit_digits = 3 WHERE currency_code = 'USD'"))).toContain('immutable');
    expect(await messageOf(run("UPDATE geography.time_zones SET iana_name = 'America/Detroit' WHERE iana_name = 'America/Denver'"))).toContain(
      'identity is immutable',
    );
    expect(await messageOf(run("UPDATE geography.markets SET code = 'other' WHERE code = 'la-oc'"))).toContain('market identity');
    expect(await messageOf(run("DELETE FROM content.locales WHERE locale = 'en-US'"))).toContain('cannot be deleted');
  });
  it('keeps the audit trail append-only', async () => {
    expect(await messageOf(run("UPDATE geography.audit_events SET actor = 'x'"))).toContain('immutable');
    expect(await messageOf(run('DELETE FROM geography.audit_events'))).toContain('immutable');
  });
  it('freezes the locale and time zone links of an ACTIVE country', async () => {
    expect(await messageOf(run('DELETE FROM geography.country_locales'))).toContain('ACTIVE country');
    expect(await messageOf(run('DELETE FROM geography.country_time_zones'))).toContain('ACTIVE country');
  });
});

describe('relationship integrity (supported locales, time zones, defaults)', () => {
  it('requires a country default locale to be one of its supported locales (checked at commit)', async () => {
    await registerLocale('qaa', true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
         VALUES ('ZA', 'ZAA', '991', 'geography.country.us.name', '+9', 'USD', 'qaa', 'MILES', 'SUNDAY', 'MDY', '12_HOUR')`,
      );
      expect(await messageOf(client.query('COMMIT'))).toContain('fk_countries__default_locale');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
  it('requires a market default locale to be supported by the market and the market locales to be supported by its country', async () => {
    const zb = await makeCountry({ alpha2: 'ZB', locales: ['en-US', 'qaa'] });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO geography.markets (code, name, country_id, default_locale, currency_code, default_time_zone_id, effective_from)
         SELECT 'zb-one', 'one', $1, 'qaa', 'USD', time_zone_id, now() FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'`,
        [zb],
      );
      expect(await messageOf(client.query('COMMIT'))).toContain('fk_markets__default_locale');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const m = await makeMarket(zb, 'zb-two', { locale: 'en-US' });
    expect(await messageOf(run('INSERT INTO geography.market_locales (market_id, country_id, locale) VALUES ($1, $2, $3)', [m, zb, 'es-419']))).toContain(
      'fk_market_locales__country_locale',
    );
  });
  it('requires a market default time zone to be one of its country time zones', async () => {
    const zc = await makeCountry({ alpha2: 'ZC', zones: ['America/Los_Angeles'] });
    expect(await messageOf(makeMarket(zc, 'zc-ny', { zone: 'America/New_York' }))).toContain('fk_markets__country_time_zone');
  });
});

describe('activation rules (GEO001 13 to 16)', () => {
  it('lets the seeded la-oc market be activated (all dependencies ACTIVE) and deactivated again', async () => {
    await run("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = 'la-oc'");
    expect((await q("SELECT status FROM geography.markets WHERE code = 'la-oc'"))[0]).toEqual({ status: 'ACTIVE' });
    await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE code = 'la-oc'");
  });
  it('refuses to activate a market whose country is not ACTIVE', async () => {
    const c = await makeCountry({ alpha2: 'ZD' });
    const m = await makeMarket(c, 'zd-market');
    expect(await messageOf(activate('markets', 'market_id', m))).toContain('its country is not ACTIVE');
  });
  it('refuses to activate a market whose currency is not ACTIVE', async () => {
    const c = await makeCountry({ alpha2: 'ZE' });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'ze-market', { currency: 'JPY' });
    expect(await messageOf(activate('markets', 'market_id', m))).toContain('currency JPY is not ACTIVE');
  });
  it('refuses to activate a market whose default locale is not an ACTIVE locale', async () => {
    await registerLocale('qab', false);
    const c = await makeCountry({ alpha2: 'ZF', locales: ['en-US', 'qab'] });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zf-market', { locale: 'qab' });
    expect(await messageOf(activate('markets', 'market_id', m))).toContain('default locale qab is not an ACTIVE locale');
  });
  it('refuses to activate a market whose default time zone is not ACTIVE', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('America/Boise', 'PLANNED')");
    const c = await makeCountry({ alpha2: 'ZG', zones: ['America/Los_Angeles', 'America/Boise'] });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zg-market', { zone: 'America/Boise' });
    expect(await messageOf(activate('markets', 'market_id', m))).toContain('default time zone is not ACTIVE');
  });
  it('refuses to activate a country with an inactive default currency or locale, or without an ACTIVE time zone', async () => {
    expect(await messageOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZH', currency: 'KWD' })))).toContain(
      'default currency KWD is not ACTIVE',
    );
    expect(await messageOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZI', locales: ['qab'] })))).toContain(
      'default locale qab is not an ACTIVE locale',
    );
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('America/Adak', 'PLANNED')");
    expect(await messageOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZJ', zones: ['America/Adak'] })))).toContain('no ACTIVE time zone');
  });
  it('refuses to create a country directly as ACTIVE (links do not exist yet)', async () => {
    expect(
      await messageOf(
        run(`INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
             VALUES ('ZK', 'ZKK', '990', 'geography.country.us.name', 'ACTIVE', '+9', 'USD', 'en-US', 'MILES', 'SUNDAY', 'MDY', '12_HOUR')`),
      ),
    ).toContain('no ACTIVE time zone');
  });
  it('does not allow deactivating a dependency that an ACTIVE country or market still uses', async () => {
    await run("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = 'la-oc'");
    expect(await messageOf(run("UPDATE geography.countries SET status = 'INACTIVE' WHERE iso_alpha2 = 'US'"))).toContain('has ACTIVE markets');
    expect(await messageOf(run("UPDATE geography.currencies SET status = 'INACTIVE' WHERE currency_code = 'USD'"))).toContain(
      'used by an ACTIVE country or market',
    );
    expect(await messageOf(run("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'America/Los_Angeles'"))).toContain(
      'needed by an ACTIVE market',
    );
    expect(await messageOf(run("UPDATE content.locales SET is_active = false WHERE locale = 'en-US'"))).toBeTruthy();
    // a non-default zone of an ACTIVE country can be deactivated while another stays ACTIVE
    await run("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'America/Denver'");
    await run("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'America/Denver'");
    await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE code = 'la-oc'");
  });
  it('does not allow deactivating a locale that is the default of an ACTIVE country or market', async () => {
    await registerLocale('qac', true);
    const c = await makeCountry({ alpha2: 'ZL', locales: ['en-US', 'qac'], defaultLocale: 'qac' });
    await activate('countries', 'country_id', c);
    expect(await messageOf(run("UPDATE content.locales SET is_active = false WHERE locale = 'qac'"))).toContain('default of an ACTIVE country or market');
    await run("UPDATE geography.countries SET status = 'INACTIVE' WHERE country_id = $1", [c]);
    await run("UPDATE content.locales SET is_active = false WHERE locale = 'qac'");
  });
  it('allows an ACTIVE market to be created through the normal order: PLANNED, links, then activation', async () => {
    const c = await makeCountry({ alpha2: 'ZM' });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zm-market');
    await activate('markets', 'market_id', m);
    expect((await q('SELECT status FROM geography.markets WHERE market_id = $1', [m]))[0]).toEqual({ status: 'ACTIVE' });
  });
});

describe('guard failures carry a machine-readable key in DETAIL (geography_rule:<KEY>)', () => {
  it('every guard RAISE reports exactly geography_rule:<KEY>, independent of its message text (all 15 keys)', async () => {
    await run(
      "INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, status) VALUES ('SEK', '752', 2, 'Krona', 'PLANNED')",
    );
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('Pacific/Honolulu', 'PLANNED')");
    await registerLocale('qad', false);

    // immutability and retention
    expect(await detailOf(run("UPDATE geography.audit_events SET actor = 'x'"))).toBe(rule('ROW_IMMUTABLE'));
    expect(await detailOf(run('UPDATE geography.country_locales SET created_at = now()'))).toBe(rule('ROW_IMMUTABLE'));
    expect(await detailOf(run("DELETE FROM geography.currencies WHERE currency_code = 'USD'"))).toBe(rule('NOT_DELETABLE'));
    expect(await detailOf(run("DELETE FROM geography.markets WHERE code = 'la-oc'"))).toBe(rule('NOT_DELETABLE'));
    expect(await detailOf(run("UPDATE geography.currencies SET minor_unit_digits = 3 WHERE currency_code = 'USD'"))).toBe(rule('IMMUTABLE_IDENTITY'));
    expect(await detailOf(run("UPDATE geography.markets SET code = 'other' WHERE code = 'la-oc'"))).toBe(rule('IMMUTABLE_IDENTITY'));
    expect(await detailOf(run("UPDATE geography.countries SET status = 'PLANNED' WHERE iso_alpha2 = 'US'"))).toBe(rule('PLANNED_IS_INITIAL'));
    expect(await detailOf(run('DELETE FROM geography.country_locales'))).toBe(rule('LINKS_PROTECTED'));
    expect(await detailOf(run('DELETE FROM geography.country_time_zones'))).toBe(rule('LINKS_PROTECTED'));

    // time zone names: unknown names, offsets and the posix/ and right/ alias trees are not identities
    expect(await detailOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('Mars/Olympus_Mons')"))).toBe(rule('NOT_IANA'));
    expect(await detailOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('posix/America/Denver')"))).toBe(rule('NOT_IANA'));
    expect(await detailOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('right/UTC')"))).toBe(rule('NOT_IANA'));

    // activation dependencies of a country
    expect(await detailOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZU', currency: 'SEK' })))).toBe(rule('CURRENCY_NOT_ACTIVE'));
    expect(await detailOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZV', locales: ['qad'] })))).toBe(rule('LOCALE_NOT_ACTIVE'));
    expect(await detailOf(activate('countries', 'country_id', await makeCountry({ alpha2: 'ZW', zones: ['Pacific/Honolulu'] })))).toBe(
      rule('NO_ACTIVE_TIME_ZONE'),
    );

    // activation dependencies of a market
    const planned = await makeCountry({ alpha2: 'ZX', locales: ['en-US', 'qad'], zones: ['America/Los_Angeles', 'Pacific/Honolulu'] });
    expect(await detailOf(activate('markets', 'market_id', await makeMarket(planned, 'zx-country')))).toBe(rule('COUNTRY_NOT_ACTIVE'));
    await activate('countries', 'country_id', planned);
    expect(await detailOf(activate('markets', 'market_id', await makeMarket(planned, 'zx-currency', { currency: 'SEK' })))).toBe(rule('CURRENCY_NOT_ACTIVE'));
    expect(await detailOf(activate('markets', 'market_id', await makeMarket(planned, 'zx-zone', { zone: 'Pacific/Honolulu' })))).toBe(
      rule('TIME_ZONE_NOT_ACTIVE'),
    );
    expect(await detailOf(activate('markets', 'market_id', await makeMarket(planned, 'zx-locale', { locale: 'qad' })))).toBe(rule('LOCALE_NOT_ACTIVE'));

    // deactivation blocked while an ACTIVE country or market depends on it
    await run("UPDATE geography.markets SET status = 'ACTIVE' WHERE code = 'la-oc'");
    try {
      expect(await detailOf(run("UPDATE geography.countries SET status = 'INACTIVE' WHERE iso_alpha2 = 'US'"))).toBe(rule('COUNTRY_HAS_ACTIVE_MARKETS'));
      expect(await detailOf(run("UPDATE geography.currencies SET status = 'INACTIVE' WHERE currency_code = 'USD'"))).toBe(rule('CURRENCY_IN_USE'));
      expect(await detailOf(run("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'America/Los_Angeles'"))).toBe(rule('TIME_ZONE_IN_USE'));
      expect(await detailOf(run("UPDATE content.locales SET is_active = false WHERE locale = 'en-US'"))).toBe(rule('LOCALE_IS_ACTIVE_DEFAULT'));
    } finally {
      await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE code = 'la-oc'");
    }
  });

  it('a user-chosen market code that contains rule words does not change the key (the message contains the code, the key does not)', async () => {
    await registerLocale('qae', false);
    const c = await makeCountry({ alpha2: 'ZY', locales: ['en-US', 'qae'] });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'its-country-currency-time-zone', { locale: 'qae' });
    const e = (await rejection(activate('markets', 'market_id', m))) as { message: string; detail?: string };
    expect(e.message).toContain('its-country-currency-time-zone'); // the message names the user-chosen code ...
    expect(e.message).toContain('default locale qae is not an ACTIVE locale');
    expect(e.detail).toBe(rule('LOCALE_NOT_ACTIVE')); // ... so it can never be the classification source
  });

  it('time zones: posix/ and right/ aliases are refused, a registered name is accepted by ON CONFLICT DO NOTHING without a second tz scan failing', async () => {
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('posix/America/Los_Angeles')"))).toContain('not an IANA time zone');
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('right/America/Los_Angeles')"))).toContain('not an IANA time zone');
    expect(await messageOf(run("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Los_Angeles')"))).toContain('uq_time_zones__iana_name');
    await run("INSERT INTO geography.time_zones (iana_name) VALUES ('America/Los_Angeles') ON CONFLICT (iana_name) DO NOTHING");
    expect((await q("SELECT count(*)::int AS n FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'"))[0]).toEqual({ n: 1 });
  });
});

describe('status machine, link rows and name length', () => {
  it('treats PLANNED as the initial status only (no table can go back to it)', async () => {
    const c = await makeCountry({ alpha2: 'ZR' });
    await activate('countries', 'country_id', c);
    expect(await messageOf(run("UPDATE geography.countries SET status = 'PLANNED' WHERE country_id = $1", [c]))).toContain('PLANNED is the initial status');
    await run("UPDATE geography.currencies SET status = 'ACTIVE' WHERE currency_code = 'JPY'"); // JPY and Phoenix were inserted PLANNED
    await run("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'America/Phoenix'");
    expect(await messageOf(run("UPDATE geography.currencies SET status = 'PLANNED' WHERE currency_code = 'JPY'"))).toContain('PLANNED is the initial status');
    expect(await messageOf(run("UPDATE geography.time_zones SET status = 'PLANNED' WHERE iana_name = 'America/Phoenix'"))).toContain(
      'PLANNED is the initial status',
    );
    const m = await makeMarket(c, 'zr-market');
    await activate('markets', 'market_id', m);
    expect(await messageOf(run("UPDATE geography.markets SET status = 'PLANNED' WHERE market_id = $1", [m]))).toContain('PLANNED is the initial status');
    // INACTIVE can be activated again; a PLANNED row can be retired
    await run("UPDATE geography.markets SET status = 'INACTIVE' WHERE market_id = $1", [m]);
    await activate('markets', 'market_id', m);
  });
  it('never rewrites link rows (they are only added or removed) and bounds the market name', async () => {
    expect(await messageOf(run("UPDATE geography.country_locales SET locale = 'qaa'"))).toContain('immutable');
    expect(await messageOf(run('UPDATE geography.country_time_zones SET created_at = now()'))).toContain('immutable');
    expect(await messageOf(run('UPDATE geography.market_locales SET created_at = now()'))).toContain('immutable');
    const c = await makeCountry({ alpha2: 'ZS' });
    expect(await messageOf(run("UPDATE geography.markets SET name = repeat('x', 121) WHERE code = 'la-oc'"))).toContain('ck_markets__name_not_blank');
    expect(c).toBeTruthy();
  });
});

describe('concurrent activation safety (GEO001 20)', () => {
  const clientOf = async (): Promise<pg.PoolClient> => pool.connect();
  const waitUntilBlocked = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const r = await q<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'",
      );
      if (Number(r[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the second transaction never blocked on a lock');
  };

  it('market activation in flight blocks a concurrent country deactivation, which then fails on the committed market', async () => {
    const c = await makeCountry({ alpha2: 'ZN' });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zn-market');
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.markets SET status = 'ACTIVE' WHERE market_id = $1", [m]);
      const deactivation = t2.query("UPDATE geography.countries SET status = 'INACTIVE' WHERE country_id = $1", [c]).then(
        () => 'deactivated',
        (e: Error) => e.message,
      );
      await waitUntilBlocked();
      await t1.query('COMMIT');
      expect(await deactivation).toContain('has ACTIVE markets');
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'ACTIVE' });
      expect((await q('SELECT status FROM geography.markets WHERE market_id = $1', [m]))[0]).toEqual({ status: 'ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('country deactivation in flight blocks a concurrent market activation, which then fails on the committed country', async () => {
    const c = await makeCountry({ alpha2: 'ZO' });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zo-market');
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.countries SET status = 'INACTIVE' WHERE country_id = $1", [c]);
      const activation = t2.query("UPDATE geography.markets SET status = 'ACTIVE' WHERE market_id = $1", [m]).then(
        () => 'activated',
        (e: Error) => e.message,
      );
      await waitUntilBlocked();
      await t1.query('COMMIT');
      expect(await activation).toContain('its country is not ACTIVE');
      expect((await q('SELECT status FROM geography.markets WHERE market_id = $1', [m]))[0]).toEqual({ status: 'PLANNED' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('country activation in flight blocks deactivation of its only ACTIVE time zone, which then fails on the committed country', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('America/Juneau', 'ACTIVE')");
    const c = await makeCountry({ alpha2: 'ZQ', zones: ['America/Juneau'] });
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.countries SET status = 'ACTIVE' WHERE country_id = $1", [c]);
      const deactivation = t2.query("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'America/Juneau'").then(
        () => 'deactivated',
        (e: Error) => e.message,
      );
      await waitUntilBlocked();
      await t1.query('COMMIT');
      expect(await deactivation).toContain('only ACTIVE zone of an ACTIVE country');
      expect((await q("SELECT status FROM geography.time_zones WHERE iana_name = 'America/Juneau'"))[0]).toEqual({ status: 'ACTIVE' });
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('time zone deactivation in flight blocks a concurrent country activation, which then sees no ACTIVE zone', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('America/Nome', 'ACTIVE')");
    const c = await makeCountry({ alpha2: 'ZT', zones: ['America/Nome'] });
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'America/Nome'");
      const activation = t2.query("UPDATE geography.countries SET status = 'ACTIVE' WHERE country_id = $1", [c]).then(
        () => 'activated',
        (e: Error) => e.message,
      );
      await waitUntilBlocked();
      await t1.query('COMMIT');
      expect(await activation).toContain('no ACTIVE time zone');
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'PLANNED' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('two concurrent deactivations of two DIFFERENT zones of an ACTIVE country: the second waits, then sees the first and is refused (never an ACTIVE country without an ACTIVE zone)', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('Europe/Berlin', 'ACTIVE'), ('Europe/Paris', 'ACTIVE')");
    const c = await makeCountry({ alpha2: 'YA', zones: ['Europe/Berlin', 'Europe/Paris'] });
    await activate('countries', 'country_id', c);
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'Europe/Berlin'");
      const second = t2.query("UPDATE geography.time_zones SET status = 'INACTIVE' WHERE iana_name = 'Europe/Paris'").then(
        () => 'deactivated',
        (e: Error & { detail?: string }) => `${e.message} | ${e.detail}`,
      );
      await waitUntilBlocked(); // without the country lock in the guard both deactivations pass and nothing ever blocks
      await t1.query('COMMIT');
      expect(await second).toContain('only ACTIVE zone of an ACTIVE country');
      expect(await second).toContain(rule('TIME_ZONE_IN_USE'));
      expect(
        await q(
          "SELECT t.iana_name FROM geography.country_time_zones z JOIN geography.time_zones t USING (time_zone_id) WHERE z.country_id = $1 AND t.status = 'ACTIVE'",
          [c],
        ),
      ).toEqual([{ iana_name: 'Europe/Paris' }]);
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('country activation racing the DELETE of its only time zone link (activation first): the delete waits for the country row, then is refused', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('Asia/Tokyo', 'ACTIVE')");
    const c = await makeCountry({ alpha2: 'YB', zones: ['Asia/Tokyo'] });
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE geography.countries SET status = 'ACTIVE' WHERE country_id = $1", [c]);
      const removal = t2.query('DELETE FROM geography.country_time_zones WHERE country_id = $1', [c]).then(
        () => 'removed',
        (e: Error & { detail?: string }) => `${e.message} | ${e.detail}`,
      );
      await waitUntilBlocked(); // without the share lock on the country row the delete would run at once
      await t1.query('COMMIT');
      expect(await removal).toContain('time zones of an ACTIVE country cannot be removed');
      expect(await removal).toContain(rule('LINKS_PROTECTED'));
      expect((await q('SELECT count(*)::int AS n FROM geography.country_time_zones WHERE country_id = $1', [c]))[0]).toEqual({ n: 1 });
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'ACTIVE' });
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('country activation racing the DELETE of its only time zone link (delete first): the activation waits, then finds no zone and is refused', async () => {
    await run("INSERT INTO geography.time_zones (iana_name, status) VALUES ('Asia/Seoul', 'ACTIVE')");
    const c = await makeCountry({ alpha2: 'YC', zones: ['Asia/Seoul'] });
    const t1 = await clientOf();
    const t2 = await clientOf();
    try {
      await t1.query('BEGIN');
      await t1.query('DELETE FROM geography.country_time_zones WHERE country_id = $1', [c]);
      const activation = t2.query("UPDATE geography.countries SET status = 'ACTIVE' WHERE country_id = $1", [c]).then(
        () => 'activated',
        (e: Error & { detail?: string }) => `${e.message} | ${e.detail}`,
      );
      await waitUntilBlocked(); // without the share lock taken by the delete's guard the activation would run at once and still see the link
      await t1.query('COMMIT');
      expect(await activation).toContain('no ACTIVE time zone');
      expect(await activation).toContain(rule('NO_ACTIVE_TIME_ZONE'));
      expect((await q('SELECT status FROM geography.countries WHERE country_id = $1', [c]))[0]).toEqual({ status: 'PLANNED' });
      expect(
        await q(
          "SELECT 1 FROM geography.countries c WHERE c.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM geography.country_time_zones z WHERE z.country_id = c.country_id)",
        ),
      ).toEqual([]);
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });

  it('two concurrent activations of the same market both end ACTIVE without error (the guard is idempotent)', async () => {
    const c = await makeCountry({ alpha2: 'ZP' });
    await activate('countries', 'country_id', c);
    const m = await makeMarket(c, 'zp-market');
    const results = await Promise.allSettled([activate('markets', 'market_id', m), activate('markets', 'market_id', m)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await q('SELECT status FROM geography.markets WHERE market_id = $1', [m]))[0]).toEqual({ status: 'ACTIVE' });
  });
});

describe('derived values are never stored', () => {
  it('has no stored readiness or currently-active flag on markets: only status and the effective window', async () => {
    const cols = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'geography' AND table_name = 'markets' ORDER BY ordinal_position",
      )
    ).map((r) => r.column_name);
    expect(cols).toEqual([
      'market_id',
      'code',
      'name',
      'country_id',
      'status',
      'default_locale',
      'currency_code',
      'default_time_zone_id',
      'effective_from',
      'effective_to',
      'created_at',
      'updated_at',
    ]);
  });
});
