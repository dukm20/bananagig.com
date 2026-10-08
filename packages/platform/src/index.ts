// Infrastructure adapters (Valkey, NATS, S3, flags, mail, OpenSearch) and the connectivity diagnostics.
// Adapters are infrastructure boundaries: domain modules call them through ports, never the other way round.
export * from './clients';
export * from './checks';
export * from './health-server';
export * from './outbox';
export * from './email';
export * from './rate-limit';
