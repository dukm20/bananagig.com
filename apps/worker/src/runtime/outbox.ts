import type { AppConfig } from '@bananagig/config';
import type { EventEnvelope } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { log, runWithCorrelation } from '@bananagig/observability';
import { claimOutboxBatch, markOutboxFailed, markOutboxPublished, purgePublishedOutbox, type OutboxRow } from '@bananagig/platform';

export interface EventPublisher {
  publish(event: EventEnvelope): Promise<{ duplicate: boolean }>;
}
export interface OutboxRelay {
  start(): void;
  stop(): Promise<void>;
}

export const rowToEnvelope = (r: OutboxRow): EventEnvelope => ({
  eventId: r.outboxEventId,
  eventType: r.eventType,
  eventVersion: r.eventVersion,
  occurredAt: r.createdAt.toISOString(),
  correlationId: r.correlationId,
  causationId: r.causationId,
  actor: { type: r.actorType, id: r.actorId },
  aggregateType: r.aggregateType,
  aggregateId: r.aggregateId,
  payload: r.payload,
});

/**
 * Polls integration.outbox_events and publishes committed events to NATS JetStream.
 * Idempotent: the event id is the Nats-Msg-Id, publish is retried with backoff, and a row is only marked published after
 * JetStream acknowledged it. Delivery is therefore at-least-once; consumers dedupe by eventId.
 */
export class PollingOutboxRelay implements OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lastPurge = 0;

  constructor(
    private readonly database: Database,
    private readonly publisher: EventPublisher,
    private readonly cfg: AppConfig['outbox'],
  ) {}

  async pollOnce(): Promise<{ claimed: number; published: number; failed: number }> {
    const rows = await claimOutboxBatch(this.database, { batchSize: this.cfg.batchSize, leaseMs: this.cfg.leaseMs });
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      await runWithCorrelation(row.correlationId, async () => {
        try {
          const { duplicate } = await this.publisher.publish(rowToEnvelope(row));
          await markOutboxPublished(this.database, row.outboxEventId);
          published++;
          log('info', 'outbox event published', { eventType: row.eventType, outboxEventId: row.outboxEventId, duplicate });
        } catch (err) {
          failed++;
          await markOutboxFailed(this.database, row.outboxEventId, row.publishAttempts, err instanceof Error ? err.message : String(err));
          log('warn', 'outbox publish failed; will retry with backoff', {
            eventType: row.eventType,
            outboxEventId: row.outboxEventId,
            attempts: row.publishAttempts + 1,
          });
        }
      });
    }
    if (Date.now() - this.lastPurge > 3_600_000) {
      this.lastPurge = Date.now();
      // singleton maintenance: only one relay replica purges at a time
      await this.database.withAdvisoryLock('outboxPurge', 0, () => purgePublishedOutbox(this.database, this.cfg.retentionDays)).catch(() => undefined);
    }
    return { claimed: rows.length, published, failed };
  }

  start(): void {
    const tick = (): void => {
      if (this.stopped) return;
      this.inFlight = this.pollOnce()
        .catch((err) => log('error', 'outbox poll failed', { error: String(err) }))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.cfg.pollIntervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }
}
