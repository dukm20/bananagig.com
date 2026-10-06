import { randomUUID } from 'node:crypto';
import { headers as natsHeaders, StringCodec, type Subscription } from 'nats';
import { CORRELATION_HEADER, EventEnvelope, INFRA_PING_EVENT_TYPE, isSafeCorrelationId } from '@bananagig/contracts';
import { getCorrelationId, log, resolveCorrelationId, runWithCorrelation } from '@bananagig/observability';
import type { NatsClient } from '@bananagig/platform';

const sc = StringCodec();

/** Publishes validated domain events as NATS messages. Subject == eventType (bananagig.<domain>.<event>.v<n>). */
export class NatsEventPublisher {
  constructor(private readonly nats: NatsClient) {}
  async publish(event: EventEnvelope): Promise<void> {
    const valid = EventEnvelope.parse(event);
    const h = natsHeaders();
    h.set(CORRELATION_HEADER, valid.correlationId);
    (await this.nats.connection()).publish(valid.eventType, sc.encode(JSON.stringify(valid)), { headers: h });
  }
}

export function newEvent(partial: Pick<EventEnvelope, 'eventType' | 'aggregateType' | 'aggregateId' | 'payload'> & Partial<EventEnvelope>): EventEnvelope {
  const v = Number(partial.eventType.split('.v').pop());
  return {
    eventId: randomUUID(),
    eventVersion: v,
    occurredAt: new Date().toISOString(),
    correlationId: getCorrelationId() ?? randomUUID(),
    causationId: null,
    actor: { type: 'system', id: null },
    ...partial,
  };
}

/** Subscribes with correlation restored from the message header. Handlers receive validated envelopes. */
export async function subscribe(nats: NatsClient, subject: string, handler: (e: EventEnvelope) => Promise<void>): Promise<Subscription> {
  const sub = (await nats.connection()).subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      const hdr = msg.headers?.get(CORRELATION_HEADER);
      const correlationId = resolveCorrelationId(isSafeCorrelationId(hdr) ? hdr : undefined);
      await runWithCorrelation(correlationId, async () => {
        try {
          await handler(EventEnvelope.parse(JSON.parse(sc.decode(msg.data))));
        } catch (err) {
          log('error', 'event handler failed', { subject, error: String(err) });
        }
      });
    }
  })();
  return sub;
}

export const INFRA_PING_SUBJECT = INFRA_PING_EVENT_TYPE;
