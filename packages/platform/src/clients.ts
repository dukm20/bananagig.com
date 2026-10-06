import { Redis } from 'iovalkey';
import { connect, DiscardPolicy, nanos, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '@bananagig/config';

export function createValkey(cfg: AppConfig): Redis {
  return new Redis(cfg.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

export const EVENT_STREAM = 'BANANAGIG_EVENTS';

/** Lazy, shared NATS connection with unlimited reconnects. */
export class NatsClient {
  private nc: NatsConnection | undefined;
  constructor(private readonly cfg: AppConfig) {}
  async connection(): Promise<NatsConnection> {
    this.nc ??= await connect({ servers: this.cfg.natsUrl, name: this.cfg.serviceName, maxReconnectAttempts: -1 });
    return this.nc;
  }
  /**
   * Ensures the durable JetStream stream that captures every domain event subject (bananagig.>).
   * Idempotent. The duplicate window lets JetStream drop re-published messages that carry the same Nats-Msg-Id.
   */
  async ensureEventStream(): Promise<void> {
    const jsm = await (await this.connection()).jetstreamManager();
    const config = {
      name: EVENT_STREAM,
      subjects: ['bananagig.>'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      num_replicas: 1,
      max_age: nanos(7 * 24 * 3600 * 1000),
      duplicate_window: nanos(120_000),
    };
    try {
      await jsm.streams.info(EVENT_STREAM);
      await jsm.streams.update(EVENT_STREAM, config);
    } catch {
      await jsm.streams.add(config);
    }
  }
  get connected(): boolean {
    return !!this.nc && !this.nc.isClosed();
  }
  async close(): Promise<void> {
    await this.nc?.drain().catch(() => undefined);
    this.nc = undefined;
  }
}

/** Safe close: quit() on a client that never connected (lazyConnect) would hang. */
export async function closeValkey(valkey: Redis): Promise<void> {
  if (valkey.status === 'wait' || valkey.status === 'end') valkey.disconnect();
  else await valkey.quit().catch(() => valkey.disconnect());
}

export function createS3(cfg: AppConfig): S3Client {
  return new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
  });
}
