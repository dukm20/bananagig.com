// Transactional outbox store (SQL for integration.outbox_events). The table is the committed-event source;
// NATS is only the transport. Producers call insertOutboxEvent inside the SAME transaction as the state change.
import { sql, type Database, type Trx } from '@bananagig/database';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  /** bananagig.<domain>.<event>.v<n>; the version is derived from the suffix. */
  eventType: string;
  actorType?: 'user' | 'system' | 'service';
  actorId?: string | null;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId?: string | null;
}

export interface OutboxRow {
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  actorType: 'user' | 'system' | 'service';
  actorId: string | null;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  createdAt: Date;
  publishAttempts: number;
}

/** Insert an event. Must run inside database.transaction() together with the state change it describes. */
export async function insertOutboxEvent(trx: Trx, e: OutboxEventInput): Promise<string> {
  const version = Number(e.eventType.split('.v').pop());
  if (!Number.isInteger(version) || version < 1) throw new Error(`invalid event type (missing .v<n> suffix): ${e.eventType}`);
  const r = await sql<{ outbox_event_id: string }>`
    INSERT INTO integration.outbox_events (aggregate_type, aggregate_id, event_type, event_version, actor_type, actor_id, payload_json, correlation_id, causation_id)
    VALUES (${e.aggregateType}, ${e.aggregateId}, ${e.eventType}, ${version}, ${e.actorType ?? 'system'}, ${e.actorId ?? null}, ${JSON.stringify(e.payload)}::jsonb, ${e.correlationId}, ${e.causationId ?? null})
    RETURNING outbox_event_id`.execute(trx);
  return r.rows[0]!.outbox_event_id;
}

/**
 * Claims due rows with a LEASE (not a long-held lock): select FOR UPDATE SKIP LOCKED, push next_attempt_at forward by the
 * lease, commit. Publishing then happens with no database lock held; a crashed relay's rows become due again after the lease.
 */
export async function claimOutboxBatch(database: Database, o: { batchSize: number; leaseMs: number }): Promise<OutboxRow[]> {
  return database.transaction(async (trx) => {
    const r = await sql<Record<string, unknown>>`
      SELECT outbox_event_id, aggregate_type, aggregate_id, event_type, event_version, actor_type, actor_id, payload_json, correlation_id, causation_id, created_at, publish_attempts
        FROM integration.outbox_events
       WHERE published_at IS NULL AND next_attempt_at <= now()
       ORDER BY created_at, outbox_event_id
       LIMIT ${o.batchSize}
       FOR UPDATE SKIP LOCKED`.execute(trx);
    if (r.rows.length) {
      const ids = r.rows.map((x) => x.outbox_event_id as string);
      await sql`UPDATE integration.outbox_events SET next_attempt_at = now() + make_interval(secs => ${o.leaseMs / 1000}) WHERE outbox_event_id = ANY(${ids}::uuid[])`.execute(
        trx,
      );
    }
    return r.rows.map((x) => ({
      outboxEventId: x.outbox_event_id as string,
      aggregateType: x.aggregate_type as string,
      aggregateId: x.aggregate_id as string,
      eventType: x.event_type as string,
      eventVersion: x.event_version as number,
      actorType: x.actor_type as OutboxRow['actorType'],
      actorId: (x.actor_id as string | null) ?? null,
      payload: x.payload_json as Record<string, unknown>,
      correlationId: x.correlation_id as string,
      causationId: (x.causation_id as string | null) ?? null,
      createdAt: x.created_at as Date,
      publishAttempts: x.publish_attempts as number,
    }));
  });
}

export async function markOutboxPublished(database: Database, id: string): Promise<void> {
  await database.db.transaction().execute(async (trx) => {
    await sql`UPDATE integration.outbox_events SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE outbox_event_id = ${id} AND published_at IS NULL`.execute(
      trx,
    );
  });
}

/** Records a failed attempt and schedules a retry with exponential backoff (2^attempts seconds, capped at 5 minutes). */
export async function markOutboxFailed(database: Database, id: string, attempts: number, error: string): Promise<void> {
  const backoffSeconds = Math.min(300, 2 ** Math.min(attempts + 1, 9));
  await database.db.transaction().execute(async (trx) => {
    await sql`UPDATE integration.outbox_events SET publish_attempts = publish_attempts + 1, last_error = ${error.slice(0, 1000)}, next_attempt_at = now() + make_interval(secs => ${backoffSeconds}) WHERE outbox_event_id = ${id} AND published_at IS NULL`.execute(
      trx,
    );
  });
}

/** Retention: remove rows published more than `days` ago. Returns the number of rows removed. */
export async function purgePublishedOutbox(database: Database, days: number): Promise<number> {
  const r = await database.db
    .transaction()
    .execute((trx) => sql`DELETE FROM integration.outbox_events WHERE published_at < now() - make_interval(days => ${days})`.execute(trx));
  return Number(r.numAffectedRows ?? 0);
}
