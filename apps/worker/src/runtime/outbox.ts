import type { EventEnvelope } from '@bananagig/contracts';

/**
 * Port for the transactional outbox relay. No outbox table exists yet (DEBT-0002); the relay loop
 * (SELECT ... FOR UPDATE SKIP LOCKED -> publish -> mark sent) is built with the first event-producing feature.
 */
export interface OutboxRelay {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}
