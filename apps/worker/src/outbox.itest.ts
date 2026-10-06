import { randomUUID } from 'node:crypto';
import { StringCodec } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { EventEnvelope } from '@bananagig/contracts';
import { claimOutboxBatch, insertOutboxEvent, NatsClient, purgePublishedOutbox } from '@bananagig/platform';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from '@bananagig/testing';
import { NatsEventPublisher } from './runtime/events';
import { PollingOutboxRelay, type EventPublisher } from './runtime/outbox';

let iso: IsolatedDatabase;
let nats: NatsClient;
const cfg = loadConfig({
  service: 'bananagig-worker',
  env: { NODE_ENV: 'test', NATS_URL: process.env.NATS_URL ?? 'nats://localhost:14222', OUTBOX_BATCH_SIZE: '10', OUTBOX_LEASE_MS: '2000' },
});
const sc = StringCodec();

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  nats = new NatsClient(cfg);
  await nats.ensureEventStream();
});
afterAll(async () => {
  await nats.close();
  await iso.drop();
});

const event = (overrides = {}) => ({
  aggregateType: 'infra',
  aggregateId: randomUUID(),
  eventType: 'bananagig.infra.ping.v1',
  payload: { n: 1 },
  correlationId: 'corr-outbox-1234',
  ...overrides,
});
const rows = (where = 'true') => iso.database.query<Record<string, unknown>>(`SELECT * FROM integration.outbox_events WHERE ${where} ORDER BY created_at`);
const clear = () => iso.database.query('DELETE FROM integration.outbox_events');

describe('outbox table', () => {
  it('inserts inside the business transaction: commit keeps the event, rollback discards it', async () => {
    await clear();
    await rejection(
      iso.database.transaction(async (trx) => {
        await insertOutboxEvent(trx, event());
        throw new Error('state change failed');
      }),
    );
    expect(await rows()).toHaveLength(0);
    const id = await iso.database.transaction((trx) => insertOutboxEvent(trx, event()));
    const [row] = await rows();
    expect(row).toMatchObject({ outbox_event_id: id, event_version: 1, publish_attempts: 0, published_at: null, actor_type: 'system' });
  });
  it('enforces constraints: event type format, version consistency, actor type, payload shape, published needs an attempt', async () => {
    const code = async (q: string) => ((await rejection(iso.database.query(q))) as { code?: string }).code;
    const base = 'INSERT INTO integration.outbox_events (aggregate_type, aggregate_id, event_type, event_version, actor_type, payload_json, correlation_id)';
    expect(await code(`${base} VALUES ('a','1','booking.created',1,'system','{}','c')`)).toBe('23514');
    expect(await code(`${base} VALUES ('a','1','bananagig.x.y.v2',1,'system','{}','c')`)).toBe('23514');
    expect(await code(`${base} VALUES ('a','1','bananagig.x.y.v1',1,'robot','{}','c')`)).toBe('23514');
    expect(await code(`${base} VALUES ('a','1','bananagig.x.y.v1',1,'system','[]','c')`)).toBe('23514');
    const ins = await iso.database.query<{ id: string }>(`${base} VALUES ('a','1','bananagig.x.y.v1',1,'system','{}','c') RETURNING outbox_event_id AS id`);
    expect(await code(`UPDATE integration.outbox_events SET published_at = now() WHERE outbox_event_id = '${ins[0]!.id}'`)).toBe('23514'); // published requires publish_attempts >= 1
  });
  it('claims with a lease: a second claimer gets nothing until the lease expires; SKIP LOCKED gives disjoint batches', async () => {
    await clear();
    for (let i = 0; i < 4; i++) await iso.database.transaction((trx) => insertOutboxEvent(trx, event()));
    const first = await claimOutboxBatch(iso.database, { batchSize: 2, leaseMs: 60_000 });
    const second = await claimOutboxBatch(iso.database, { batchSize: 10, leaseMs: 60_000 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((r) => r.outboxEventId)).size).toBe(4);
    expect(await claimOutboxBatch(iso.database, { batchSize: 10, leaseMs: 60_000 })).toHaveLength(0);
  });
});

describe('outbox relay', () => {
  it('publishes committed events to JetStream with the event id as message id, then marks them published', async () => {
    await clear();
    const sub = (await nats.connection()).subscribe('bananagig.infra.ping.v1');
    const received = (async () => {
      for await (const m of sub) return JSON.parse(sc.decode(m.data));
    })();
    const id = await iso.database.transaction((trx) => insertOutboxEvent(trx, event({ payload: { via: 'relay-test' } })));
    const relay = new PollingOutboxRelay(iso.database, new NatsEventPublisher(nats), cfg.outbox);
    expect(await relay.pollOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    const envelope = EventEnvelope.parse(await received);
    expect(envelope).toMatchObject({ eventId: id, eventType: 'bananagig.infra.ping.v1', correlationId: 'corr-outbox-1234', payload: { via: 'relay-test' } });
    const [row] = await rows();
    expect(row!.published_at).not.toBeNull();
    expect(row!.publish_attempts).toBe(1);
    sub.unsubscribe();
  });
  it('is idempotent: republishing the same event id is reported as a JetStream duplicate', async () => {
    const publisher = new NatsEventPublisher(nats);
    const envelope = EventEnvelope.parse({
      eventId: randomUUID(),
      eventType: 'bananagig.infra.ping.v1',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-dup-12345',
      causationId: null,
      actor: { type: 'system', id: null },
      aggregateType: 'infra',
      aggregateId: 'x',
      payload: {},
    });
    expect(await publisher.publish(envelope)).toEqual({ duplicate: false });
    expect(await publisher.publish(envelope)).toEqual({ duplicate: true });
  });
  it('records failures with attempt count, error and backoff, and retries later', async () => {
    await clear();
    const id = await iso.database.transaction((trx) => insertOutboxEvent(trx, event()));
    let fail = true;
    const flaky: EventPublisher = {
      publish: async () => {
        if (fail) throw new Error('nats unavailable');
        return { duplicate: false };
      },
    };
    const relay = new PollingOutboxRelay(iso.database, flaky, cfg.outbox);
    expect(await relay.pollOnce()).toMatchObject({ claimed: 1, failed: 1, published: 0 });
    const [failed] = await rows();
    expect(failed).toMatchObject({ outbox_event_id: id, publish_attempts: 1, last_error: 'nats unavailable', published_at: null });
    expect((failed!.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now()); // backoff
    expect(await relay.pollOnce()).toMatchObject({ claimed: 0 }); // not due yet
    fail = false;
    await iso.database.query('UPDATE integration.outbox_events SET next_attempt_at = now()'); // simulate backoff elapsing
    expect(await relay.pollOnce()).toMatchObject({ claimed: 1, published: 1 });
    const [done] = await rows();
    expect(done).toMatchObject({ publish_attempts: 2, last_error: null });
    expect(done!.published_at).not.toBeNull();
  });
  it('purges published rows past retention and keeps unpublished ones', async () => {
    await clear();
    await iso.database.transaction((trx) => insertOutboxEvent(trx, event()));
    const old = await iso.database.transaction((trx) => insertOutboxEvent(trx, event()));
    await iso.database.query(
      "UPDATE integration.outbox_events SET published_at = now() - interval '30 days', publish_attempts = 1 WHERE outbox_event_id = $1",
      [old],
    );
    expect(await purgePublishedOutbox(iso.database, 7)).toBe(1);
    expect(await rows()).toHaveLength(1);
  });
  it('rejects event types without a version suffix before touching the database', async () => {
    const err = (await rejection(iso.database.transaction((trx) => insertOutboxEvent(trx, event({ eventType: 'bananagig.infra.ping' }))))) as Error;
    expect(err.message).toContain('invalid event type');
  });
});
