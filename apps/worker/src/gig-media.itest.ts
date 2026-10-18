import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROVIDER_GIG_MEDIA_POLICY_KEYS } from '@bananagig/contracts';
import { MemoryObjectStore } from '@bananagig/platform';
import { DEFAULT_GIG_MEDIA_POLICY } from '@bananagig/provider';
import { createIsolatedDatabase, createTestPool, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { GIG_MEDIA_CLEANUP_QUEUE, createGigMediaCleaner, registerGigMediaJobs } from './jobs/gig-media';
import { withJobMeta } from './runtime/job';

// Real PostgreSQL (pnpm dev:deps): the real GigMediaService (reference-aware clean-up), the in-memory private object store, the media policy read through a configuration-registry
// stand-in under the real policy keys, and a real pg-boss in this file's own isolated database. No NATS needed.
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => void logSink.lines.push(JSON.stringify({ level, message, ...attrs })),
  };
});

let iso: IsolatedDatabase;
let pool: ReturnType<typeof createTestPool>;
let boss: PgBoss;
const store = new MemoryObjectStore();
const values = new Map<string, unknown>();
const configuration = {
  resolveMany: async (keys: string[]) => ({ values: new Map(keys.filter((k) => values.has(k)).map((k) => [k, { value: values.get(k) }] as const)) }),
};

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  pool = createTestPool(iso.url, 4);
  for (const [k, v] of Object.entries(DEFAULT_GIG_MEDIA_POLICY))
    values.set(PROVIDER_GIG_MEDIA_POLICY_KEYS[k as keyof typeof PROVIDER_GIG_MEDIA_POLICY_KEYS], v);
  boss = new PgBoss({ connectionString: iso.url, max: 3 });
  boss.on('error', () => undefined);
  await boss.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerGigMediaJobs(boss, createGigMediaCleaner({ database: iso.database, store, configuration: configuration as any }));
});
afterAll(async () => {
  await boss.stop({ graceful: true, timeout: 5000 });
  await pool.end();
  await iso.drop();
});

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Record<string, unknown>[];
async function mkAccount(): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'ACTIVE', 'test', 'test')",
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
/** An asset of the account: UPLOAD_PENDING (expiring in `expiresInMs`) or READY with its ready time moved `readyAgoSeconds` into the past. Both objects are put in the store. */
async function mkAsset(accountId: string, o: { ready?: { agoSeconds: number }; expiresInMs?: number }): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = `provider/gig-media/${id}`;
  await q(
    `INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/png', 100, now() + ($4 || ' milliseconds')::interval)`,
    [id, accountId, key, String(o.expiresInMs ?? 900_000)],
  );
  store.put(key, Buffer.from('final'), 'image/png');
  store.put(`${key}.upload`, Buffer.from('upload'), 'image/png');
  if (o.ready) {
    await q(
      `UPDATE provider.media_assets SET status = 'READY', sha256 = $2, width = 800, height = 600, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1`,
      [id, 'a'.repeat(64)],
    );
    await q('ALTER TABLE provider.media_assets DISABLE TRIGGER USER');
    try {
      await q(`UPDATE provider.media_assets SET ready_at = now() - ($2 || ' seconds')::interval WHERE media_asset_id = $1`, [id, String(o.ready.agoSeconds)]);
    } finally {
      await q('ALTER TABLE provider.media_assets ENABLE TRIGGER USER');
    }
  }
  return { id, key };
}
const statusOf = async (id: string): Promise<string> =>
  (await q('SELECT status FROM provider.media_assets WHERE media_asset_id = $1', [id]))[0]!.status as string;
async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error('condition not met in time');
}

describe('gig media clean-up (integration)', () => {
  it('the scheduled job, run by a real pg-boss, abandons an expired upload and deletes a long-unreferenced READY photo, and leaves the others alone', async () => {
    const account = await mkAccount();
    const expired = await mkAsset(account, { expiresInMs: 300 });
    const live = await mkAsset(account, {});
    const orphan = await mkAsset(account, { ready: { agoSeconds: DEFAULT_GIG_MEDIA_POLICY.orphanGraceSeconds + 3600 } });
    const fresh = await mkAsset(account, { ready: { agoSeconds: 5 } });
    await sleep(500);
    logSink.lines.length = 0;
    await boss.send(GIG_MEDIA_CLEANUP_QUEUE, withJobMeta({}));
    await until(async () => (await statusOf(expired.id)) === 'ABANDONED' && (await statusOf(orphan.id)) === 'DELETED');
    expect(await statusOf(live.id)).toBe('UPLOAD_PENDING');
    expect(await statusOf(fresh.id)).toBe('READY');
    for (const k of [expired.key, `${expired.key}.upload`, orphan.key, `${orphan.key}.upload`]) expect(store.objects.has(k), k).toBe(false);
    for (const k of [live.key, `${live.key}.upload`, fresh.key, `${fresh.key}.upload`]) expect(store.objects.has(k), k).toBe(true);
    // counts only in the logs: no key, no id
    const logs = logSink.lines.join('\n');
    expect(logs).toContain('gig photos cleaned up');
    for (const needle of [expired.key, orphan.key, expired.id, orphan.id, 'provider/gig-media']) expect(logs).not.toContain(needle);
  });

  it('is idempotent and honours the batch limit: a second run with nothing left does nothing', async () => {
    const account = await mkAccount();
    const grace = DEFAULT_GIG_MEDIA_POLICY.orphanGraceSeconds + 60;
    const ids = [
      await mkAsset(account, { ready: { agoSeconds: grace } }),
      await mkAsset(account, { ready: { agoSeconds: grace } }),
      await mkAsset(account, { ready: { agoSeconds: grace } }),
    ];
    const cleaner = createGigMediaCleaner({ database: iso.database, store, configuration: configuration as never });
    expect(await cleaner.cleanup({ limit: 2 })).toMatchObject({ abandoned: 0, deleted: 2 });
    expect(await cleaner.cleanup({ limit: 2 })).toMatchObject({ abandoned: 0, deleted: 1 });
    expect(await cleaner.cleanup({ limit: 2 })).toMatchObject({ abandoned: 0, deleted: 0 });
    expect(await Promise.all(ids.map((i) => statusOf(i.id)))).toEqual(['DELETED', 'DELETED', 'DELETED']);
  });

  it('reconciles the objects of terminal assets: a deletion that never happened is done, recorded, and not repeated', async () => {
    const account = await mkAccount();
    const abandoned = await mkAsset(account, { expiresInMs: 200 });
    await q(`UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1`, [abandoned.id]); // closed, objects left behind
    const ready = await mkAsset(account, { expiresInMs: 200 });
    await q(
      `UPDATE provider.media_assets SET status = 'READY', sha256 = $2, width = 800, height = 600, scan_status = 'CLEAN', ready_at = now() WHERE media_asset_id = $1`,
      [ready.id, 'b'.repeat(64)],
    );
    await sleep(400);
    const cleaner = createGigMediaCleaner({ database: iso.database, store, configuration: configuration as never });
    const r = await cleaner.cleanup({ limit: 100 });
    expect(r.reconciled).toBeGreaterThanOrEqual(2);
    expect(store.objects.has(abandoned.key)).toBe(false);
    expect(store.objects.has(`${abandoned.key}.upload`)).toBe(false);
    expect(store.objects.has(ready.key)).toBe(true); // the final object of a READY photo stays
    expect(store.objects.has(`${ready.key}.upload`)).toBe(false); // its upload object goes once the authorization has ended
    const rows = await q('SELECT media_asset_id, objects_removed_at, upload_key_removed_at FROM provider.media_assets WHERE media_asset_id = ANY($1::uuid[])', [
      [abandoned.id, ready.id],
    ]);
    const by = (id: string) => rows.find((x) => x.media_asset_id === id)!;
    expect(by(abandoned.id).objects_removed_at).toBeInstanceOf(Date);
    expect(by(ready.id).upload_key_removed_at).toBeInstanceOf(Date);
    expect(by(ready.id).objects_removed_at).toBeNull();
    expect((await cleaner.cleanup({ limit: 100 })).reconciled).toBe(0);
  });

  it('fails the run (so pg-boss records it) when the media policy cannot be read, deleting nothing', async () => {
    const account = await mkAccount();
    const orphan = await mkAsset(account, { ready: { agoSeconds: DEFAULT_GIG_MEDIA_POLICY.orphanGraceSeconds + 10 } });
    const cleaner = createGigMediaCleaner({ database: iso.database, store, configuration: { resolveMany: async () => ({ values: new Map() }) } as never });
    await expect(cleaner.cleanup({ limit: 100 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await statusOf(orphan.id)).toBe('READY');
    expect(store.objects.has(orphan.key)).toBe(true);
  });
});
