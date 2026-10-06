import { Redis } from 'iovalkey';
import { connect, type NatsConnection } from 'nats';
import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '@bananagig/config';

export function createValkey(cfg: AppConfig): Redis {
  return new Redis(cfg.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

/** Lazy, shared NATS connection with unlimited reconnects. */
export class NatsClient {
  private nc: NatsConnection | undefined;
  constructor(private readonly cfg: AppConfig) {}
  async connection(): Promise<NatsConnection> {
    this.nc ??= await connect({ servers: this.cfg.natsUrl, name: this.cfg.serviceName, maxReconnectAttempts: -1 });
    return this.nc;
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
