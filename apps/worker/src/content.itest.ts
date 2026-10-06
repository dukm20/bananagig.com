import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '@bananagig/content';
import { createIsolatedDatabase, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { CONTENT_ACTIVATION_QUEUE, registerContentJobs } from './jobs/content';

// Real PostgreSQL (pnpm dev:deps): the real ContentService and a real pg-boss in this file's own isolated database. No NATS needed.
let iso: IsolatedDatabase;
let boss: PgBoss;
let content: ContentService;
let n = 0;
const ACTOR = 'itest-author';
const APPROVER = 'itest-approver';

/** Authors and publishes one version of a policy-NONE devtest entry. Returns the published (or SCHEDULED) version. */
async function publish(key: string, body: string, from?: Date) {
  const v = await content.createVersion(key, { locale: 'en-US', scopeType: 'PLATFORM', body, effectiveFrom: from?.toISOString(), reason: 'itest' }, ACTOR);
  const submitted = await content.submit(v.versionId, ACTOR);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, APPROVER);
  return content.publish(v.versionId, ACTOR);
}
async function newEntry(): Promise<string> {
  const key = `devtest.worker.t${++n}_${Date.now()}`;
  await content.createEntry(
    { key, contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'worker itest entry', approvalPolicy: 'NONE', fallbackPolicy: 'CHAIN' },
    ACTOR,
  );
  return key;
}
const statusOf = async (versionId: string) => (await content.getVersion(versionId)).status as string;

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  boss = new PgBoss({ connectionString: iso.url, max: 3 });
  boss.on('error', () => undefined);
  content = new ContentService({ database: iso.database, env: 'test', allowTestKeys: true });
  await boss.start();
  await registerContentJobs(boss, content);
});
afterAll(async () => {
  await boss.stop({ graceful: true, timeout: 5000 });
  await iso.drop();
});

describe('content activation (integration)', () => {
  it('activateDue through the real service activates a due version once, and a second run does nothing', async () => {
    const key = await newEntry();
    const v1 = await publish(key, 'one');
    const v2 = await publish(key, 'two', new Date(Date.now() + 1200));
    expect(v2.status).toBe('SCHEDULED');
    expect(await content.activateDue()).toBe(0); // not due yet
    await sleep(1500);
    const first = await content.activateDue();
    const second = await content.activateDue();
    // The minute cron registered in beforeAll may win the race for the single due version; either way it is activated exactly once.
    expect(first + second).toBeLessThanOrEqual(1);
    expect(second).toBe(0);
    expect(await statusOf(v2.versionId)).toBe('PUBLISHED');
    expect(await statusOf(v1.versionId)).toBe('SUPERSEDED');
    // exactly one activation (and one supersession) audit row: the repeat run did not write anything
    const audit = await iso.database.query<{ action: string }>(
      `SELECT action FROM content.audit_events WHERE version_id = $1 AND action = 'VERSION_ACTIVATED'`,
      [v2.versionId],
    );
    expect(audit).toHaveLength(1);
  });
  it('the durable job activates a scheduled version, and sending the job again is harmless', async () => {
    const key = await newEntry();
    await publish(key, 'one');
    const v2 = await publish(key, 'two', new Date(Date.now() + 1000));
    expect(v2.status).toBe('SCHEDULED');
    await sleep(1300);
    await boss.send(CONTENT_ACTIVATION_QUEUE, {}); // the cron sweep would do this every minute
    let status = v2.status as string;
    for (let i = 0; i < 40 && status !== 'PUBLISHED'; i++) {
      await sleep(250);
      status = await statusOf(v2.versionId);
    }
    expect(status).toBe('PUBLISHED');
    await boss.send(CONTENT_ACTIVATION_QUEUE, {});
    await sleep(500);
    expect(await statusOf(v2.versionId)).toBe('PUBLISHED');
  });
});
