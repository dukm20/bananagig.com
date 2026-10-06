import type { PgBoss } from 'pg-boss';
import type { AppConfig } from '@bananagig/config';
import { INFRA_PING_EVENT_TYPE, INFRA_PING_QUEUE } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { log, runWithCorrelation } from '@bananagig/observability';
import type { NatsClient } from '@bananagig/platform';
import { randomUUID } from 'node:crypto';
import { NatsEventPublisher, INFRA_PING_SUBJECT, newEvent, subscribe } from './runtime/events';
import { jobHandler, withJobMeta } from './runtime/job';
import { PollingOutboxRelay } from './runtime/outbox';
import { insertOutboxEvent } from '@bananagig/platform';

export interface WorkerDeps {
  cfg: AppConfig;
  database: Database;
  nats: NatsClient;
  boss: PgBoss;
}

/** Worker host: owns job runtime (pg-boss) and event runtime (NATS) lifecycle. No product handlers yet. */
export class Worker {
  private started = false;
  private stopping = false;
  private readonly seen = new Map<string, () => void>();
  private readonly publisher: NatsEventPublisher;
  private readonly relay: PollingOutboxRelay;

  constructor(private readonly d: WorkerDeps) {
    this.publisher = new NatsEventPublisher(d.nats);
    this.relay = new PollingOutboxRelay(d.database, this.publisher, d.cfg.outbox);
  }

  get identity(): string {
    return this.d.cfg.worker.id;
  }

  async start(): Promise<void> {
    const { boss, cfg, nats } = this.d;
    boss.on('error', (err) => log('error', 'pg-boss error', { error: String(err) }));
    await boss.start();
    await boss.createQueue(INFRA_PING_QUEUE);
    await boss.work(
      INFRA_PING_QUEUE,
      { localConcurrency: cfg.worker.concurrency },
      jobHandler<{ pingId: string }>(INFRA_PING_QUEUE, async (data) => {
        this.seen.get(`job:${data.pingId}`)?.();
      }),
    );
    await nats.ensureEventStream();
    await subscribe(nats, INFRA_PING_SUBJECT, async (e) => {
      this.seen.get(`${e.payload.via === 'outbox' ? 'outbox' : 'event'}:${String(e.payload.pingId)}`)?.();
    });
    if (cfg.outbox.enabled) this.relay.start();
    this.started = true;
    log('info', 'worker started', { workerId: this.identity, concurrency: cfg.worker.concurrency });
  }

  /** Ready = job runtime started, Postgres reachable, NATS connected. */
  async readiness(): Promise<Record<string, 'up' | 'down'>> {
    const pg = await this.d.database.health();
    return {
      postgres: pg.ok ? 'up' : 'down',
      jobs: this.started && !this.stopping ? 'up' : 'down',
      events: this.d.nats.connected ? 'up' : 'down',
    };
  }

  /** Round-trips one harmless job and one harmless event through the real runtimes. */
  async selfTest(timeoutMs = 8000): Promise<{ job: boolean; event: boolean; outbox: boolean; correlationId: string }> {
    const pingId = randomUUID();
    const correlationId = randomUUID();
    const wait = (key: string) =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        this.seen.set(key, () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    return runWithCorrelation(correlationId, async () => {
      const job = wait(`job:${pingId}`);
      const event = wait(`event:${pingId}`);
      await this.d.boss.send(INFRA_PING_QUEUE, withJobMeta({ pingId }));
      await this.publisher.publish(newEvent({ eventType: INFRA_PING_EVENT_TYPE, aggregateType: 'infra', aggregateId: 'ping', payload: { pingId } }));
      // Outbox path: commit an event row in a transaction; the relay publishes it to JetStream.
      const outbox = wait(`outbox:${pingId}`);
      await this.d.database.transaction(async (trx) => {
        await insertOutboxEvent(trx, {
          aggregateType: 'infra',
          aggregateId: 'ping',
          eventType: INFRA_PING_EVENT_TYPE,
          payload: { pingId, via: 'outbox' },
          correlationId,
        });
      });
      const [j, e, o] = await Promise.all([job, event, outbox]);
      for (const k of ['job', 'event', 'outbox']) this.seen.delete(`${k}:${pingId}`);
      return { job: j, event: e, outbox: o, correlationId };
    });
  }

  /** Graceful stop: no new work, let in-flight jobs finish (bounded), then close connections. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.relay.stop();
    await this.d.boss.stop({ graceful: true, timeout: 10000 });
    await this.d.nats.close();
    log('info', 'worker stopped', { workerId: this.identity });
  }
}
