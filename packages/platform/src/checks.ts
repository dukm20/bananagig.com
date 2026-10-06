import { randomUUID } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';
import nodemailer from 'nodemailer';
import type { Redis } from 'iovalkey';
import type { AppConfig } from '@bananagig/config';
import type { Database } from '@bananagig/database';
import { withSpan } from '@bananagig/observability';
import type { NatsClient } from './clients';

export const TEST_FLAG = 'dev-test-flag';
export const withTimeout = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

export interface Adapters {
  cfg: AppConfig;
  database: Database;
  valkey: Redis;
  nats: NatsClient;
  s3: S3Client;
}

export const checkPostgres = async ({ database }: Adapters) => ({ version: (await database.query<{ version: string }>('SELECT version()'))[0]?.version });

export async function checkPostGIS({ database }: Adapters) {
  const r = (
    await database.query<{ v: string; d: number }>(
      "SELECT PostGIS_Version() AS v, ST_Distance(ST_GeogFromText('POINT(0 0)'), ST_GeogFromText('POINT(0 1)'))::float AS d",
    )
  )[0];
  return { postgis: r?.v, oneDegreeMeters: Math.round(r?.d ?? 0) };
}

export async function checkValkey({ valkey, cfg }: Adapters) {
  if (valkey.status === 'wait') await valkey.connect();
  const key = `bg:${cfg.env}:diag:ping:${cfg.serviceName}`; // namespace: bg:<env>:<domain>:<key>
  await valkey.set(key, '1', 'EX', 30); // every key has a TTL
  if ((await valkey.get(key)) !== '1') throw new Error('valkey roundtrip failed');
  return { ping: await valkey.ping() };
}

export async function checkNats({ nats }: Adapters) {
  return { rttMs: await (await nats.connection()).rtt() };
}

export async function checkJetStream({ nats }: Adapters) {
  const acct = await (await (await nats.connection()).jetstreamManager()).getAccountInfo();
  return { streams: acct.streams, memory: acct.memory, storage: acct.storage };
}

export async function checkS3({ s3, cfg }: Adapters) {
  const Key = `diag/${randomUUID()}.txt`;
  const Bucket = cfg.s3.bucket;
  const body = `bananagig diag ${Date.now()}`;
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: body }));
  const text = await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body?.transformToString();
  await s3.send(new DeleteObjectCommand({ Bucket, Key }));
  if (text !== body) throw new Error('s3 roundtrip mismatch');
  return { bucket: Bucket, roundtrip: 'put/get/delete ok' };
}

export async function checkOpenSearch({ cfg }: Adapters) {
  const res = await fetch(`${cfg.opensearchUrl}/_cluster/health`);
  if (!res.ok) throw new Error(`opensearch ${res.status}`);
  const h = (await res.json()) as { status: string; cluster_name: string };
  if (h.status === 'red') throw new Error('opensearch cluster red');
  return { cluster: h.cluster_name, status: h.status };
}

// flagd v0.17 pairs with the provider's rpc resolver; older flagd servers returned gRPC UNIMPLEMENTED.
let flagInit: Promise<void> | undefined;
async function ensureFlagProvider(cfg: AppConfig): Promise<void> {
  flagInit ??= withTimeout(OpenFeature.setProviderAndWait(new FlagdProvider({ host: cfg.flagd.host, port: cfg.flagd.port, resolverType: 'rpc' })), 8000).catch(
    (err) => {
      flagInit = undefined;
      throw err;
    },
  );
  await flagInit;
}

export async function checkFlag({ cfg }: Adapters) {
  await ensureFlagProvider(cfg);
  const d = await withTimeout(OpenFeature.getClient().getBooleanDetails(TEST_FLAG, false));
  if (d.reason === 'ERROR' || d.errorCode) throw new Error(`flag eval error: ${d.errorMessage ?? d.errorCode}`);
  return { flag: TEST_FLAG, value: d.value, reason: d.reason };
}

/** Application-facing flag read. Never throws: returns `fallback` when flagd is unavailable. */
export async function flagBoolean(cfg: AppConfig, key: string, fallback: boolean): Promise<boolean> {
  try {
    await withTimeout(ensureFlagProvider(cfg), 3000);
    return await withTimeout(OpenFeature.getClient().getBooleanValue(key, fallback), 2000);
  } catch {
    return fallback;
  }
}

export async function checkMail({ cfg }: Adapters) {
  const tx = nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: false, tls: { rejectUnauthorized: false } });
  const subject = `bananagig diag ${cfg.serviceName} ${randomUUID()}`;
  await tx.sendMail({ from: cfg.mailFrom, to: 'dev@bananagig.localhost', subject, text: 'connectivity test' });
  return { subject };
}

export async function checkTrace({ database, cfg }: Adapters) {
  const { traceId } = await withSpan(`diag.${cfg.serviceName}`, async () => {
    await database.query('SELECT 1');
  });
  return { traceId };
}

/** Runs every connectivity check; entries are independent so one failure does not mask others. */
export async function runDiagnostics(a: Adapters, extra: Record<string, () => Promise<unknown>> = {}) {
  const checks: Record<string, () => Promise<unknown>> = {
    postgres: () => checkPostgres(a),
    postgis: () => checkPostGIS(a),
    valkey: () => checkValkey(a),
    nats: () => checkNats(a),
    jetstream: () => checkJetStream(a),
    s3: () => checkS3(a),
    opensearch: () => checkOpenSearch(a),
    flag: () => checkFlag(a),
    mail: () => checkMail(a),
    trace: () => checkTrace(a),
    ...extra,
  };
  const out: Record<string, { ok: boolean; detail?: unknown; error?: string }> = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, fn]) => {
      try {
        out[name] = { ok: true, detail: await withTimeout(fn(), 10000) };
      } catch (err) {
        out[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return out;
}
