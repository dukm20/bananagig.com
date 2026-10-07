import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from './index';

// Migration 0006 seeds representative product-shell copy through the REAL content lifecycle (guard triggers, audit,
// exclusion constraint all active). These tests prove the seeded state from zero and that it is protected.
const SEEDED: Record<string, { contentType: string; body: string }> = {
  'brand.name': { contentType: 'UI_LABEL', body: 'BananaGig' },
  'brand.tagline': { contentType: 'UI_LABEL', body: 'Local help. Done fast.' },
  'common.action.sign_in': { contentType: 'UI_LABEL', body: 'Sign in' },
  'common.action.sign_out': { contentType: 'UI_LABEL', body: 'Sign out' },
  'system.home.initialized': { contentType: 'PLAIN_TEXT', body: 'Platform initialization successful.' },
  'session.status.signed_in': { contentType: 'UI_LABEL', body: 'Signed in' },
  'session.status.signed_out': { contentType: 'UI_LABEL', body: 'Not signed in' },
  'session.error.login_failed': { contentType: 'PLAIN_TEXT', body: 'Sign-in could not be completed. Please try again.' },
};
const KEYS = Object.keys(SEEDED);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

let iso: IsolatedDatabase;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
});
afterAll(async () => {
  await iso.drop();
});

interface SeedRow {
  entry_id: string;
  key: string;
  version_id: string;
  body: string;
  body_sha256: string;
  status: string;
  effective_from: Date;
  effective_to: Date | null;
}
const seeded = (): Promise<SeedRow[]> =>
  iso.database.query<SeedRow>(
    `SELECT e.entry_id, e.key, v.version_id, v.body, v.body_sha256, v.status, v.effective_from, v.effective_to
       FROM content.entries e JOIN content.versions v ON v.entry_id = e.entry_id
      WHERE v.locale = 'en-US' AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED') AND e.key = ANY($1) ORDER BY e.key`,
    [KEYS],
  );

describe('migration 0006 seeded shell copy', () => {
  it('creates exactly the eight representative entries with the governance the seed promises', async () => {
    const rows = await iso.database.query<Record<string, unknown>>('SELECT * FROM content.entries WHERE key = ANY($1) ORDER BY key', [KEYS]);
    expect(rows.map((r) => r.key)).toEqual([...KEYS].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        content_type: SEEDED[r.key as string]!.contentType,
        owner_role: 'CONTENT',
        sensitivity: 'PUBLIC',
        criticality: 'STANDARD',
        approval_policy: 'NONE',
        fallback_policy: 'CHAIN',
        max_scope_type: 'PLATFORM',
        is_active: true,
        created_by: 'system:migration',
      });
    }
    expect(Number((await iso.database.query<{ n: string }>('SELECT count(*) AS n FROM content.entry_variables'))[0]!.n)).toBe(0);
    expect(
      Number(
        (
          await iso.database.query<{ n: string }>(
            'SELECT count(*) AS n FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key = ANY($1)',
            [KEYS],
          )
        )[0]!.n,
      ),
    ).toBe(KEYS.length);
  });

  it('has exactly one PUBLISHED en-US PLATFORM version per key, effective now or earlier, with the expected body', async () => {
    const rows = await seeded();
    expect(rows.map((r) => r.key)).toEqual([...KEYS].sort());
    const now = (await iso.database.query<{ now: Date }>('SELECT clock_timestamp() AS now'))[0]!.now;
    for (const r of rows) {
      expect(r.status).toBe('PUBLISHED');
      expect(r.effective_to).toBeNull();
      expect(r.effective_from.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(r.body).toBe(SEEDED[r.key]!.body);
    }
    const detail = await iso.database.query<{ locale: string; scope_type: string; scope_ref: string | null; version: number; approval_policy: string }>(
      'SELECT v.locale, v.scope_type, v.scope_ref, v.version, v.approval_policy FROM content.versions v JOIN content.entries e ON e.entry_id = v.entry_id WHERE e.key = ANY($1)',
      [KEYS],
    );
    for (const d of detail) expect(d).toEqual({ locale: 'en-US', scope_type: 'PLATFORM', scope_ref: null, version: 1, approval_policy: 'NONE' });
  });

  it('stores body_sha256 equal to the SHA-256 of the UTF-8 body', async () => {
    for (const r of await seeded()) expect(r.body_sha256).toBe(sha256(r.body));
  });

  it('writes the trail the service writes for an immediate publication: five events per entry, in causal order by occurred_at, by system:migration', async () => {
    const audit = await iso.database.query<{
      key: string;
      action: string;
      actor: string;
      correlation_id: string;
      locale: string | null;
      version_id: string | null;
      previous_version_id: string | null;
      occurred_at: Date;
    }>(
      // ordered by time ALONE: the seed must not rely on the random audit_event_id to break ties
      `SELECT e.key, a.action, a.actor, a.correlation_id, a.locale, a.version_id, a.previous_version_id, a.occurred_at
         FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key = ANY($1) ORDER BY e.key, a.occurred_at`,
      [KEYS],
    );
    expect(audit).toHaveLength(KEYS.length * 5);
    const versionByKey = new Map((await seeded()).map((r) => [r.key, r.version_id]));
    for (const key of KEYS) {
      const mine = audit.filter((a) => a.key === key);
      expect(mine.map((a) => a.action)).toEqual(['ENTRY_CREATED', 'VERSION_DRAFTED', 'VERSION_APPROVED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED']);
      for (let i = 1; i < mine.length; i++)
        expect(mine[i]!.occurred_at.getTime(), `${key} step ${i}`).toBeGreaterThanOrEqual(mine[i - 1]!.occurred_at.getTime());
      for (const a of mine) {
        expect(a.actor).toBe('system:migration');
        expect(a.correlation_id).toBe('seed-0006');
        expect(a.locale).toBeNull(); // locale is stored for locale actions only; version events reach it through the version
        expect(a.previous_version_id).toBeNull(); // the first version replaces nothing
        expect(a.version_id).toBe(a.action.startsWith('VERSION_') ? versionByKey.get(key) : null);
      }
    }
    // the rows of one entry are written at distinct instants (clock_timestamp), so the order is real and not an artifact of a shared now()
    const distinct = await iso.database.query<{ n: string }>(
      'SELECT count(DISTINCT occurred_at) AS n FROM content.audit_events WHERE entry_id = (SELECT entry_id FROM content.entries WHERE key = $1)',
      ['brand.name'],
    );
    expect(Number(distinct[0]!.n)).toBe(5);
    // no audit rows that do not belong to a seeded entry (the seed does not touch locales)
    expect(
      Number(
        (
          await iso.database.query<{ n: string }>(
            'SELECT count(*) AS n FROM content.audit_events a JOIN content.entries e ON e.entry_id = a.entry_id WHERE e.key = ANY($1)',
            [KEYS],
          )
        )[0]!.n,
      ),
    ).toBe(KEYS.length * 5);
  });

  it('seeded versions emit no outbox events (consumers read current state; documented in the migration)', async () => {
    const n = await iso.database.query<{ n: string }>("SELECT count(*) AS n FROM integration.outbox_events WHERE aggregate_type = 'content_version'");
    expect(Number(n[0]!.n)).toBe(0);
  });

  it('keeps the audit trail internally consistent: a version cannot be attached to another entry, and version actions carry no locale', async () => {
    const [a, b] = await seeded();
    const insert = (action: string, entryId: string, versionId: string | null, locale: string | null, previous: string | null = null) =>
      rejection(
        iso.database.query(
          `INSERT INTO content.audit_events (actor, action, entry_id, locale, version_id, previous_version_id, correlation_id)
           VALUES ('tests', $1, $2, $3, $4, $5, 'cid')`,
          [action, entryId, locale, versionId, previous],
        ),
      );
    const mismatched = (await insert('VERSION_SUBMITTED', b!.entry_id, a!.version_id, null)) as { code?: string; constraint?: string };
    expect(mismatched.code).toBe('23503');
    expect(mismatched.constraint).toBe('fk_audit_events__version_entry');
    const prevMismatch = (await insert('VERSION_PUBLISHED', b!.entry_id, b!.version_id, null, a!.version_id)) as { code?: string; constraint?: string };
    expect(prevMismatch.code).toBe('23503');
    expect(prevMismatch.constraint).toBe('fk_audit_events__previous_version_entry');
    const withLocale = (await insert('VERSION_SUBMITTED', a!.entry_id, a!.version_id, 'en-US')) as { code?: string; constraint?: string };
    expect(withLocale.code).toBe('23514');
    expect(withLocale.constraint).toBe('ck_audit_events__subject');
    const entryWithLocale = (await insert('ENTRY_ACTIVATED', a!.entry_id, null, 'en-US')) as { code?: string };
    expect(entryWithLocale.code).toBe('23514');
  });

  it('keeps the exclusion constraint active: a second approved publication of the same period is rejected', async () => {
    const [target] = await seeded();
    const client = new pg.Client({ connectionString: iso.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      const draft = await client.query<{ version_id: string }>(
        `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
         VALUES ($1, 'en-US', 'PLATFORM', NULL, 2, 'Replacement copy', 'DRAFT', 'NONE', $2, 'overlap probe', 'tests') RETURNING version_id`,
        [target!.entry_id, target!.effective_from],
      );
      const id = draft.rows[0]!.version_id;
      await client.query("UPDATE content.versions SET status = 'APPROVED' WHERE version_id = $1", [id]);
      const err = (await rejection(client.query("UPDATE content.versions SET status = 'PUBLISHED' WHERE version_id = $1", [id]))) as {
        code?: string;
        constraint?: string;
      };
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('23P01');
      expect(err.constraint).toBe('ex_versions__no_overlap');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
    expect((await seeded()).length).toBe(KEYS.length); // nothing leaked out of the rolled-back probe
  });

  it('keeps the guard triggers active: seeded bodies and lifecycle cannot be edited, versions and audit rows cannot be deleted', async () => {
    const rows = await seeded();
    const first = rows[0]!;
    const mutate = (text: string, params: unknown[] = []) => rejection(iso.database.query(text, params));
    expect(String(await mutate('UPDATE content.versions SET body = $2 WHERE version_id = $1', [first.version_id, 'Edited']))).toMatch(
      /version content is immutable/,
    );
    expect(String(await mutate('UPDATE content.versions SET body_sha256 = $2 WHERE version_id = $1', [first.version_id, sha256('x')]))).toMatch(
      /version content is immutable/,
    );
    expect(String(await mutate("UPDATE content.versions SET status = 'DRAFT' WHERE version_id = $1", [first.version_id]))).toMatch(
      /illegal version transition/,
    );
    expect(
      String(await mutate("UPDATE content.versions SET effective_from = effective_from + interval '1 hour' WHERE version_id = $1", [first.version_id])),
    ).toMatch(/effective_from is immutable/);
    expect(String(await mutate('DELETE FROM content.versions WHERE version_id = $1', [first.version_id]))).toMatch(/cannot be deleted/);
    expect(String(await mutate("UPDATE content.entries SET content_type = 'PLAIN_TEXT' WHERE entry_id = $1", [first.entry_id]))).toMatch(
      /entry identity and governance policy are immutable/,
    );
    expect(String(await mutate('DELETE FROM content.entries WHERE entry_id = $1', [first.entry_id]))).toMatch(/cannot be deleted/);
    expect(String(await mutate("UPDATE content.audit_events SET actor = 'someone'"))).toMatch(/immutable/);
    expect(String(await mutate('DELETE FROM content.audit_events'))).toMatch(/immutable/);
    // all bodies are still the seeded ones
    for (const r of await seeded()) expect(r.body).toBe(SEEDED[r.key]!.body);
  });

  it('seeds no business values: no price, fee, legal or marketplace copy', async () => {
    const rows = await iso.database.query<{ key: string; content_type: string; owner_role: string }>(
      'SELECT key, content_type, owner_role FROM content.entries WHERE key = ANY($1)',
      [KEYS],
    );
    expect(rows.every((r) => r.content_type !== 'LEGAL' && r.owner_role === 'CONTENT')).toBe(true);
    expect(rows.some((r) => /price|fee|legal|terms|privacy|commission|marketplace/i.test(r.key))).toBe(false);
    expect(Number((await iso.database.query<{ n: string }>('SELECT count(*) AS n FROM configuration.parameters'))[0]!.n)).toBe(0);
  });
});
