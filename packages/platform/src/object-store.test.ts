// Unit tests of the private object store port (TRUST-001): the in-memory adapter completely, and the S3 adapter with a recording stub client for head/read/delete and a REAL S3Client
// with fake credentials and a fake endpoint for presigning (signing is offline: nothing here opens a socket).
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@bananagig/config';
import { createS3Presigner } from './clients';
import { MemoryObjectStore, ObjectStoreError, S3PrivateObjectStore } from './object-store';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const clock = () => NOW;
const KEY = 'trust/evidence/0f9a0c1e-7a3b-4c11-9d2e-111111111111/7b6d4a52-2c0e-4a70-8f1b-222222222222';
const BUCKET = 'bananagig-test-private';

// ---------------------------------------------------------------- MemoryObjectStore
describe('MemoryObjectStore', () => {
  const upload = { key: KEY, contentType: 'application/pdf', contentLength: 123, ttlSeconds: 600 };

  it('head and read are null for a missing object', async () => {
    const s = new MemoryObjectStore(clock);
    expect(await s.head(KEY)).toBeNull();
    expect(await s.read(KEY, 1000)).toBeNull();
  });
  it('head reports the stored size and content type', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('%PDF-1.4 synthetic'), 'application/pdf');
    expect(await s.head(KEY)).toEqual({ size: 18, contentType: 'application/pdf' });
    s.put('k2', Buffer.alloc(0));
    expect(await s.head('k2')).toEqual({ size: 0, contentType: undefined });
  });
  it('read returns the bytes, and a copy', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('abc'));
    const first = (await s.read(KEY, 10))!;
    expect(first.toString()).toBe('abc');
    first[0] = 0x7a;
    expect((await s.read(KEY, 10))!.toString()).toBe('abc');
  });
  it('read accepts an object of exactly maxBytes and refuses one byte more with TOO_LARGE', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.alloc(100, 1));
    expect((await s.read(KEY, 100))!.byteLength).toBe(100);
    const err = await s.read(KEY, 99).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe('TOO_LARGE');
    expect((err as ObjectStoreError).name).toBe('ObjectStoreError');
  });
  it('put replaces an object under the same key', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('one'), 'a/b');
    s.put(KEY, Buffer.from('three'), 'c/d');
    expect(await s.head(KEY)).toEqual({ size: 5, contentType: 'c/d' });
  });
  it('delete removes the object, is idempotent and leaves other keys alone', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('x'));
    s.put('other', Buffer.from('y'));
    await s.delete(KEY);
    await s.delete(KEY);
    await s.delete('never-existed');
    expect(await s.head(KEY)).toBeNull();
    expect(await s.head('other')).not.toBeNull();
  });
  it('createUploadUrl returns an opaque memory URL with the signed headers and the expiry from the injected clock', async () => {
    const s = new MemoryObjectStore(clock);
    const a = await s.createUploadUrl(upload);
    expect(a.url).toBe(`memory://upload/${encodeURIComponent(KEY)}`);
    expect(a.url).toMatch(/^memory:\/\//);
    expect(a.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': '123' });
    expect(a.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
    expect(a.expiresAt).toBeInstanceOf(Date);
  });
  it('createDownloadUrl returns a memory URL and the expiry from the injected clock', async () => {
    const s = new MemoryObjectStore(clock);
    const a = await s.createDownloadUrl({ key: KEY, ttlSeconds: 90 });
    expect(a.url).toBe(`memory://download/${encodeURIComponent(KEY)}`);
    expect(a.expiresAt.getTime()).toBe(NOW.getTime() + 90_000);
  });
  it('records every issued URL (kind, key, ttl) in order and nothing else', async () => {
    const s = new MemoryObjectStore(clock);
    await s.createUploadUrl(upload);
    await s.createDownloadUrl({ key: 'k2', ttlSeconds: 15 });
    expect(s.issued).toEqual([
      { kind: 'upload', key: KEY, ttlSeconds: 600 },
      { kind: 'download', key: 'k2', ttlSeconds: 15 },
    ]);
  });
  it('uses the real clock by default', async () => {
    const before = Date.now();
    const a = await new MemoryObjectStore().createDownloadUrl({ key: 'k', ttlSeconds: 60 });
    expect(Math.abs(a.expiresAt.getTime() - (before + 60_000))).toBeLessThan(5000);
  });
  it('does not mutate shared state across instances', async () => {
    const a = new MemoryObjectStore(clock);
    const b = new MemoryObjectStore(clock);
    a.put(KEY, Buffer.from('x'));
    await a.createUploadUrl(upload);
    expect(await b.head(KEY)).toBeNull();
    expect(b.issued).toEqual([]);
  });
});

// ---------------------------------------------------------------- S3PrivateObjectStore: head / read / delete with a stub client
type Sent = { name: string; input: Record<string, unknown> };
type Handler = (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown;
const stubClient = (handler: Handler) => {
  const sent: Sent[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return handler(cmd);
    },
  } as unknown as S3Client;
  return { client, sent };
};
const named = (name: string, extra: object = {}) =>
  Object.assign(new Error(`${name}: secret internal detail http://10.0.0.7:9000 key=${KEY}`), { name, ...extra });
const SDK_LEAK = 'secret internal detail';
const expectUnavailable = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ObjectStoreError);
  const e = err as ObjectStoreError;
  expect(e.code).toBe('UNAVAILABLE');
  expect(e.message).toBe('the object store is unavailable');
  expect(JSON.stringify([e.message, e.stack?.split('\n')[0]])).not.toContain(SDK_LEAK);
  expect(e.message).not.toContain(KEY);
  expect((e as { cause?: unknown }).cause).toBeUndefined();
};
const body = (bytes: Uint8Array | undefined) => (bytes ? { transformToByteArray: async () => bytes } : undefined);

describe('S3PrivateObjectStore: head', () => {
  it('sends HeadObject for the bucket and key and reports size and content type', async () => {
    const { client, sent } = stubClient(() => ({ ContentLength: 2048, ContentType: 'image/png' }));
    const s = new S3PrivateObjectStore({ client, bucket: BUCKET });
    expect(await s.head(KEY)).toEqual({ size: 2048, contentType: 'image/png' });
    expect(sent).toEqual([{ name: 'HeadObjectCommand', input: { Bucket: BUCKET, Key: KEY } }]);
  });
  it('reports size 0 and no content type when the store omits them', async () => {
    const { client } = stubClient(() => ({}));
    expect(await new S3PrivateObjectStore({ client, bucket: BUCKET }).head(KEY)).toEqual({ size: 0, contentType: undefined });
  });
  it.each([
    ['NotFound', named('NotFound')],
    ['NoSuchKey', named('NoSuchKey')],
    ['a bare 404 status', named('SomethingElse', { $metadata: { httpStatusCode: 404 } })],
  ])('maps %s to null', async (_n, err) => {
    const { client } = stubClient(() => {
      throw err;
    });
    expect(await new S3PrivateObjectStore({ client, bucket: BUCKET }).head(KEY)).toBeNull();
  });
  it.each([
    ['a 403', named('Forbidden', { $metadata: { httpStatusCode: 403 } })],
    ['a 500', named('InternalError', { $metadata: { httpStatusCode: 500 } })],
    ['AccessDenied', named('AccessDenied')],
    ['a network error', named('Error')],
    ['a timeout', named('TimeoutError')],
    ['a non-Error rejection', 'plain string'],
    ['null', null],
  ])('maps %s to UNAVAILABLE without leaking the SDK message', async (_n, err) => {
    const { client } = stubClient(() => {
      throw err;
    });
    await expectUnavailable(new S3PrivateObjectStore({ client, bucket: BUCKET }).head(KEY));
  });
});

describe('S3PrivateObjectStore: read', () => {
  const store = (handler: Handler) => {
    const { client, sent } = stubClient(handler);
    return { s: new S3PrivateObjectStore({ client, bucket: BUCKET }), sent };
  };
  it('heads first, then gets, and returns the bytes as a Buffer', async () => {
    const { s, sent } = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 5 } : { Body: body(Uint8Array.from([1, 2, 3, 4, 5])) }));
    const out = await s.read(KEY, 100);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out!]).toEqual([1, 2, 3, 4, 5]);
    expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    expect(sent[1]!.input).toEqual({ Bucket: BUCKET, Key: KEY });
  });
  it('returns null and never sends a GET for a missing object', async () => {
    const { s, sent } = store(() => {
      throw named('NotFound');
    });
    expect(await s.read(KEY, 100)).toBeNull();
    expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand']);
  });
  it('throws TOO_LARGE from the HEAD size before reading a single byte', async () => {
    const { s, sent } = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 101 } : { Body: body(Uint8Array.from([1])) }));
    const err = await s.read(KEY, 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe('TOO_LARGE');
    expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand']);
  });
  it('accepts an object of exactly maxBytes', async () => {
    const { s } = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 3 } : { Body: body(Uint8Array.from([1, 2, 3])) }));
    expect((await s.read(KEY, 3))!.byteLength).toBe(3);
  });
  it('re-checks the size of the bytes actually received (a HEAD that understated the size)', async () => {
    const { s } = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 2 } : { Body: body(Uint8Array.from([1, 2, 3, 4])) }));
    const err = await s.read(KEY, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe('TOO_LARGE');
  });
  it('returns null when the GET has no body', async () => {
    const { s } = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 2 } : {}));
    expect(await s.read(KEY, 100)).toBeNull();
  });
  it('returns null when the object disappears between HEAD and GET', async () => {
    const { s } = store((c) => {
      if (c.constructor.name === 'HeadObjectCommand') return { ContentLength: 2 };
      throw named('NoSuchKey');
    });
    expect(await s.read(KEY, 100)).toBeNull();
  });
  it('maps a GET failure to UNAVAILABLE without leaking', async () => {
    const { s } = store((c) => {
      if (c.constructor.name === 'HeadObjectCommand') return { ContentLength: 2 };
      throw named('InternalError', { $metadata: { httpStatusCode: 500 } });
    });
    await expectUnavailable(s.read(KEY, 100));
  });
  it('maps a body stream failure to UNAVAILABLE', async () => {
    const { s } = store((c) =>
      c.constructor.name === 'HeadObjectCommand'
        ? { ContentLength: 2 }
        : {
            Body: {
              transformToByteArray: async () => {
                throw new Error(SDK_LEAK);
              },
            },
          },
    );
    await expectUnavailable(s.read(KEY, 100));
  });
  it('maps a HEAD failure inside read to UNAVAILABLE', async () => {
    const { s } = store(() => {
      throw named('AccessDenied');
    });
    await expectUnavailable(s.read(KEY, 100));
  });
});

describe('S3PrivateObjectStore: delete', () => {
  it('sends DeleteObject for the bucket and key', async () => {
    const { client, sent } = stubClient(() => ({}));
    await new S3PrivateObjectStore({ client, bucket: BUCKET }).delete(KEY);
    expect(sent).toEqual([{ name: 'DeleteObjectCommand', input: { Bucket: BUCKET, Key: KEY } }]);
  });
  it.each([named('NotFound'), named('NoSuchKey'), named('X', { $metadata: { httpStatusCode: 404 } })])(
    'is idempotent: a missing object (%s) is not an error',
    async (err) => {
      const { client } = stubClient(() => {
        throw err;
      });
      await expect(new S3PrivateObjectStore({ client, bucket: BUCKET }).delete(KEY)).resolves.toBeUndefined();
    },
  );
  it('maps any other failure to UNAVAILABLE without leaking', async () => {
    const { client } = stubClient(() => {
      throw named('AccessDenied');
    });
    await expectUnavailable(new S3PrivateObjectStore({ client, bucket: BUCKET }).delete(KEY));
  });
});

// ---------------------------------------------------------------- S3PrivateObjectStore: presigning with a real client (offline)
const realClient = (endpoint: string, forcePathStyle = true) =>
  new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle,
    // fake, offline-only values (secret-scan:allow): nothing ever authenticates with them
    credentials: { accessKeyId: 'AKIATESTDUMMYEXAMPLE', secretAccessKey: 'dummy-test-example-secret-access-key-0000' }, // secret-scan:allow
  });
const INTERNAL = 'http://s3-internal.test:9000';
const PUBLIC = 'https://files.example.test:8443';

describe('S3PrivateObjectStore: createUploadUrl', () => {
  const up = { key: KEY, contentType: 'application/pdf', contentLength: 4096, ttlSeconds: 600 };
  const make = (opts: { presign?: S3Client; now?: () => Date } = {}) => {
    const { client, sent } = stubClient(() => ({}));
    return { s: new S3PrivateObjectStore({ client, presignClient: opts.presign ?? realClient(INTERNAL), bucket: BUCKET, now: opts.now ?? clock }), sent };
  };

  it('returns a SigV4 URL whose path is /<bucket>/<key> and whose query does not contain the key', async () => {
    const { s } = make();
    const a = await s.createUploadUrl(up);
    const u = new URL(a.url);
    expect(u.origin).toBe(INTERNAL);
    expect(u.pathname).toBe(`/${BUCKET}/${KEY}`);
    expect(u.search).not.toContain('trust');
    expect(u.search).not.toContain(KEY);
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
    expect(a.url.startsWith('http')).toBe(true);
  });
  it('signs the host, the content type and the content length (a different file is refused by the store)', async () => {
    const { s } = make();
    const u = new URL((await s.createUploadUrl(up)).url);
    const signed = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').sort();
    expect(signed).toEqual(['content-length', 'content-type', 'host']);
  });
  it('carries the TTL as X-Amz-Expires and returns the same headers the uploader must send', async () => {
    const { s } = make();
    const a = await s.createUploadUrl(up);
    expect(new URL(a.url).searchParams.get('X-Amz-Expires')).toBe('600');
    expect(a.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': '4096' });
  });
  it('computes expiresAt from the injected clock and the TTL', async () => {
    const { s } = make();
    expect((await s.createUploadUrl({ ...up, ttlSeconds: 60 })).expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect((await s.createUploadUrl({ ...up, ttlSeconds: 3600 })).expiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
  });
  it('a later clock gives a later expiry; the default clock is the system clock', async () => {
    const later = new Date('2030-01-01T00:00:00.000Z');
    expect((await make({ now: () => later }).s.createUploadUrl(up)).expiresAt).toEqual(new Date(later.getTime() + 600_000));
    const { client } = stubClient(() => ({}));
    const t0 = Date.now();
    const a = await new S3PrivateObjectStore({ client, presignClient: realClient(INTERNAL), bucket: BUCKET }).createUploadUrl(up);
    expect(Math.abs(a.expiresAt.getTime() - (t0 + 600_000))).toBeLessThan(5000);
  });
  it('different TTLs, content types or lengths give different signatures for the same key', async () => {
    const { s } = make();
    const sig = async (over: object) => new URL((await s.createUploadUrl({ ...up, ...over })).url).searchParams.get('X-Amz-Signature');
    const base = await sig({});
    expect(await sig({ ttlSeconds: 601 })).not.toBe(base);
    expect(await sig({ contentType: 'image/png' })).not.toBe(base);
    expect(await sig({ contentLength: 4097 })).not.toBe(base);
    expect(await sig({ key: `${KEY}x` })).not.toBe(base);
  });
  it('signs with the presign client (the public endpoint), never with the internal client, and sends nothing', async () => {
    const { client, sent } = stubClient(() => ({}));
    const s = new S3PrivateObjectStore({ client, presignClient: realClient(PUBLIC), bucket: BUCKET, now: clock });
    const u = new URL((await s.createUploadUrl(up)).url);
    expect(u.origin).toBe(PUBLIC);
    expect(u.host).not.toContain('internal');
    expect(sent).toEqual([]);
  });
  it('falls back to the main client when no presign client is given', async () => {
    const s = new S3PrivateObjectStore({ client: realClient(INTERNAL), bucket: BUCKET, now: clock });
    expect(new URL((await s.createUploadUrl(up)).url).origin).toBe(INTERNAL);
  });
  it('puts the bucket in the host for virtual-hosted style and the key stays in the path', async () => {
    const s = new S3PrivateObjectStore({ client: realClient('https://s3.example.test', false), bucket: BUCKET, now: clock });
    const u = new URL((await s.createUploadUrl(up)).url);
    expect(u.host).toBe(`${BUCKET}.s3.example.test`);
    expect(u.pathname).toBe(`/${KEY}`);
    expect(u.search).not.toContain(KEY);
  });
  it('percent-encodes odd characters of a key inside the path only', async () => {
    const { s } = make();
    const u = new URL((await s.createUploadUrl({ ...up, key: 'trust/evidence/a b/c?d#e' })).url);
    expect(u.pathname).toBe(`/${BUCKET}/trust/evidence/a%20b/c%3Fd%23e`);
    expect(u.hash).toBe('');
    expect(u.searchParams.has('d')).toBe(false);
  });
  it('the signing time is the real clock (the injected clock affects only expiresAt)', async () => {
    const { s } = make();
    const t0 = Date.now();
    const u = new URL((await s.createUploadUrl(up)).url);
    const d = u.searchParams.get('X-Amz-Date')!;
    const signedAt = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));
    expect(Math.abs(signedAt - t0)).toBeLessThan(10_000);
  });
});

describe('S3PrivateObjectStore: createDownloadUrl', () => {
  const make = (presign = realClient(INTERNAL)) => {
    const { client, sent } = stubClient(() => ({}));
    return { s: new S3PrivateObjectStore({ client, presignClient: presign, bucket: BUCKET, now: clock }), sent };
  };
  it('returns a GET URL with the key only in the path, served as an attachment', async () => {
    const { s, sent } = make();
    const a = await s.createDownloadUrl({ key: KEY, ttlSeconds: 120 });
    const u = new URL(a.url);
    expect(u.pathname).toBe(`/${BUCKET}/${KEY}`);
    expect(u.search).not.toContain(KEY);
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(u.searchParams.has('response-content-type')).toBe(false);
    expect(sent).toEqual([]);
  });
  it('sets the response content type only when one is given', async () => {
    const { s } = make();
    const u = new URL((await s.createDownloadUrl({ key: KEY, ttlSeconds: 120, contentType: 'application/pdf' })).url);
    expect(u.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
  });
  it('serves the object inline only when asked (an image preview), and as an attachment otherwise', async () => {
    const { s } = make();
    const inline = new URL((await s.createDownloadUrl({ key: KEY, ttlSeconds: 60, contentType: 'image/png', disposition: 'inline' })).url);
    expect(inline.searchParams.get('response-content-disposition')).toBe('inline');
    expect(inline.searchParams.get('response-content-type')).toBe('image/png');
    const dflt = new URL((await s.createDownloadUrl({ key: KEY, ttlSeconds: 60, disposition: 'attachment' })).url);
    expect(dflt.searchParams.get('response-content-disposition')).toBe('attachment');
  });
  it('computes expiresAt from the injected clock and the TTL', async () => {
    const { s } = make();
    expect((await s.createDownloadUrl({ key: KEY, ttlSeconds: 15 })).expiresAt).toEqual(new Date(NOW.getTime() + 15_000));
    expect((await s.createDownloadUrl({ key: KEY, ttlSeconds: 900 })).expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
  });
  it('signs with the presign client origin', async () => {
    const { s } = make(realClient(PUBLIC));
    expect(new URL((await s.createDownloadUrl({ key: KEY, ttlSeconds: 60 })).url).origin).toBe(PUBLIC);
  });
  it('is a different signature from the upload URL of the same key', async () => {
    const { s } = make();
    const d = new URL((await s.createDownloadUrl({ key: KEY, ttlSeconds: 600 })).url);
    const u = new URL((await s.createUploadUrl({ key: KEY, contentType: 'application/pdf', contentLength: 1, ttlSeconds: 600 })).url);
    expect(d.searchParams.get('X-Amz-Signature')).not.toBe(u.searchParams.get('X-Amz-Signature'));
    expect(d.searchParams.has('response-content-disposition')).toBe(true);
    expect(u.searchParams.has('response-content-disposition')).toBe(false);
  });
});

// ---------------------------------------------------------------- readVersioned / copyIfVersion (TRUST-001: upload key separation + promote)
const UPLOAD_KEY = 'trust/upload/0f9a0c1e-7a3b-4c11-9d2e-111111111111/7b6d4a52-2c0e-4a70-8f1b-222222222222';

describe('MemoryObjectStore: readVersioned and copyIfVersion', () => {
  it('readVersioned is null for a missing object, returns a copy of the bytes with a version, and enforces maxBytes', async () => {
    const s = new MemoryObjectStore(clock);
    expect(await s.readVersioned(KEY, 10)).toBeNull();
    s.put(KEY, Buffer.from('abc'));
    const r = (await s.readVersioned(KEY, 10))!;
    expect(r.bytes.toString()).toBe('abc');
    expect(typeof r.version).toBe('string');
    r.bytes[0] = 0x7a;
    expect((await s.read(KEY, 10))!.toString()).toBe('abc');
    expect((await s.readVersioned(KEY, 3))!.bytes.byteLength).toBe(3);
    const err = await s.readVersioned(KEY, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe('TOO_LARGE');
  });
  it('the version changes with every put, even with identical bytes (a replayed PUT is a change)', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('same'));
    const v1 = (await s.readVersioned(KEY, 10))!.version;
    expect((await s.readVersioned(KEY, 10))!.version).toBe(v1);
    s.put(KEY, Buffer.from('same'));
    expect((await s.readVersioned(KEY, 10))!.version).not.toBe(v1);
  });
  it('two keys never share a version', async () => {
    const s = new MemoryObjectStore(clock);
    s.put('a', Buffer.from('x'));
    s.put('b', Buffer.from('x'));
    expect((await s.readVersioned('a', 10))!.version).not.toBe((await s.readVersioned('b', 10))!.version);
  });
  it('copyIfVersion copies the bytes and the content type to the target and leaves the source in place', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(UPLOAD_KEY, Buffer.from('%PDF-1.4 synthetic'), 'application/pdf');
    const { version } = (await s.readVersioned(UPLOAD_KEY, 100))!;
    await s.copyIfVersion(UPLOAD_KEY, KEY, version);
    expect((await s.read(KEY, 100))!.toString()).toBe('%PDF-1.4 synthetic');
    expect(await s.head(KEY)).toEqual({ size: 18, contentType: 'application/pdf' });
    expect(await s.head(UPLOAD_KEY)).not.toBeNull();
  });
  it('the copy is independent of the source (a later put at the source does not change the target)', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(UPLOAD_KEY, Buffer.from('first'));
    await s.copyIfVersion(UPLOAD_KEY, KEY, (await s.readVersioned(UPLOAD_KEY, 100))!.version);
    s.put(UPLOAD_KEY, Buffer.from('second, different'));
    expect((await s.read(KEY, 100))!.toString()).toBe('first');
  });
  it('copyIfVersion throws CHANGED when the source was replaced after the read, and writes nothing', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(UPLOAD_KEY, Buffer.from('first'));
    const { version } = (await s.readVersioned(UPLOAD_KEY, 100))!;
    s.put(UPLOAD_KEY, Buffer.from('first'));
    const err = await s.copyIfVersion(UPLOAD_KEY, KEY, version).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe('CHANGED');
    expect(await s.head(KEY)).toBeNull();
  });
  it('copyIfVersion throws CHANGED for a missing source and for a version that never existed', async () => {
    const s = new MemoryObjectStore(clock);
    const missing = await s.copyIfVersion(UPLOAD_KEY, KEY, '1').catch((e: unknown) => e);
    expect((missing as ObjectStoreError).code).toBe('CHANGED');
    s.put(UPLOAD_KEY, Buffer.from('x'));
    const wrong = await s.copyIfVersion(UPLOAD_KEY, KEY, 'not-a-version').catch((e: unknown) => e);
    expect((wrong as ObjectStoreError).code).toBe('CHANGED');
    expect(await s.head(KEY)).toBeNull();
  });
  it('copyIfVersion over an existing target replaces it (the target gets a new version)', async () => {
    const s = new MemoryObjectStore(clock);
    s.put(KEY, Buffer.from('old'));
    const old = (await s.readVersioned(KEY, 10))!.version;
    s.put(UPLOAD_KEY, Buffer.from('new'));
    await s.copyIfVersion(UPLOAD_KEY, KEY, (await s.readVersioned(UPLOAD_KEY, 10))!.version);
    const now = (await s.readVersioned(KEY, 10))!;
    expect(now.bytes.toString()).toBe('new');
    expect(now.version).not.toBe(old);
  });
});

describe('S3PrivateObjectStore: readVersioned', () => {
  const store = (handler: Handler) => {
    const { client, sent } = stubClient(handler);
    return { s: new S3PrivateObjectStore({ client, bucket: BUCKET }), sent };
  };
  it('heads first, then gets, and returns the bytes with the ETag of the GET as the version', async () => {
    const { s, sent } = store((c) =>
      c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 3 } : { Body: body(Uint8Array.from([1, 2, 3])), ETag: '"abc123"' },
    );
    const out = (await s.readVersioned(KEY, 100))!;
    expect(Buffer.isBuffer(out.bytes)).toBe(true);
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.version).toBe('"abc123"');
    expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    expect(sent[1]!.input).toEqual({ Bucket: BUCKET, Key: KEY });
  });
  it('returns null (and sends no GET) for a missing object', async () => {
    const { s, sent } = store(() => {
      throw named('NotFound');
    });
    expect(await s.readVersioned(KEY, 100)).toBeNull();
    expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand']);
  });
  it('throws TOO_LARGE from the HEAD before reading, and re-checks the received size', async () => {
    const big = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 101 } : { Body: body(Uint8Array.from([1])), ETag: '"e"' }));
    const e1 = await big.s.readVersioned(KEY, 100).catch((e: unknown) => e);
    expect((e1 as ObjectStoreError).code).toBe('TOO_LARGE');
    expect(big.sent.map((x) => x.name)).toEqual(['HeadObjectCommand']);
    const liar = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 2 } : { Body: body(Uint8Array.from([1, 2, 3, 4])), ETag: '"e"' }));
    const e2 = await liar.s.readVersioned(KEY, 3).catch((e: unknown) => e);
    expect((e2 as ObjectStoreError).code).toBe('TOO_LARGE');
  });
  it('returns null when the GET has no body or no ETag (no version means no safe copy)', async () => {
    const noBody = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 2 } : { ETag: '"e"' }));
    expect(await noBody.s.readVersioned(KEY, 100)).toBeNull();
    const noEtag = store((c) => (c.constructor.name === 'HeadObjectCommand' ? { ContentLength: 2 } : { Body: body(Uint8Array.from([1, 2])) }));
    expect(await noEtag.s.readVersioned(KEY, 100)).toBeNull();
  });
  it('returns null when the object disappears between HEAD and GET', async () => {
    const { s } = store((c) => {
      if (c.constructor.name === 'HeadObjectCommand') return { ContentLength: 2 };
      throw named('NoSuchKey');
    });
    expect(await s.readVersioned(KEY, 100)).toBeNull();
  });
  it('maps GET, body-stream and HEAD failures to UNAVAILABLE without leaking', async () => {
    await expectUnavailable(
      store((c) => {
        if (c.constructor.name === 'HeadObjectCommand') return { ContentLength: 2 };
        throw named('InternalError', { $metadata: { httpStatusCode: 500 } });
      }).s.readVersioned(KEY, 100),
    );
    await expectUnavailable(
      store((c) =>
        c.constructor.name === 'HeadObjectCommand'
          ? { ContentLength: 2 }
          : {
              ETag: '"e"',
              Body: {
                transformToByteArray: async () => {
                  throw new Error(SDK_LEAK);
                },
              },
            },
      ).s.readVersioned(KEY, 100),
    );
    await expectUnavailable(
      store(() => {
        throw named('AccessDenied');
      }).s.readVersioned(KEY, 100),
    );
  });
});

describe('S3PrivateObjectStore: copyIfVersion', () => {
  /** HEAD answers `head` (the source as the store reports it); every other command goes to `handler`. */
  const run = (handler: Handler, head: object | (() => never) = { ContentLength: 10, ContentType: 'image/png' }) => {
    const { client, sent } = stubClient((cmd) => {
      if (cmd.constructor.name === 'HeadObjectCommand') return typeof head === 'function' ? head() : head;
      return handler(cmd);
    });
    return { s: new S3PrivateObjectStore({ client, bucket: BUCKET }), sent };
  };
  const copies = (sent: Sent[]) => sent.filter((c) => c.name === 'CopyObjectCommand');
  it('reads the source content type, then sends ONE CopyObject into the target key with CopySourceIfMatch = the version, the source as <bucket>/<key> and REPLACE metadata', async () => {
    const { s, sent } = run(() => ({}));
    await s.copyIfVersion(UPLOAD_KEY, KEY, '"abc123"');
    expect(sent).toEqual([
      { name: 'HeadObjectCommand', input: { Bucket: BUCKET, Key: UPLOAD_KEY } },
      {
        name: 'CopyObjectCommand',
        input: {
          Bucket: BUCKET,
          Key: KEY,
          CopySource: `${BUCKET}/${UPLOAD_KEY}`,
          CopySourceIfMatch: '"abc123"',
          MetadataDirective: 'REPLACE',
          ContentType: 'image/png',
        },
      },
    ]);
  });
  it('carries no unsigned metadata of the upload to the final object: REPLACE with only the content type (no cache control, encoding, disposition or user metadata is passed)', async () => {
    const { s, sent } = run(() => ({}), {
      ContentLength: 10,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000',
      ContentEncoding: 'gzip',
      Metadata: { x: 'y' },
    });
    await s.copyIfVersion(UPLOAD_KEY, KEY, '"v"');
    const input = copies(sent)[0]!.input;
    expect(input.MetadataDirective).toBe('REPLACE');
    expect(Object.keys(input).sort()).toEqual(['Bucket', 'ContentType', 'CopySource', 'CopySourceIfMatch', 'Key', 'MetadataDirective']);
    expect(input.ContentType).toBe('image/jpeg');
  });
  it('omits ContentType when the source reports none (REPLACE then leaves the target without one rather than guessing)', async () => {
    const { s, sent } = run(() => ({}), { ContentLength: 10 });
    await s.copyIfVersion(UPLOAD_KEY, KEY, '"v"');
    expect(copies(sent)[0]!.input).not.toHaveProperty('ContentType');
    expect(copies(sent)[0]!.input.MetadataDirective).toBe('REPLACE');
  });
  it('percent-encodes each path segment of the source but keeps the slashes', async () => {
    const { s, sent } = run(() => ({}));
    await s.copyIfVersion('trust/upload/a b/c?d#e+f', KEY, '"v"');
    expect(copies(sent)[0]!.input.CopySource).toBe(`${BUCKET}/trust/upload/a%20b/c%3Fd%23e%2Bf`);
  });
  it('a source that is already gone (HEAD finds nothing) is CHANGED and no copy is sent', async () => {
    const { s, sent } = run(
      () => ({}),
      () => {
        throw named('NotFound');
      },
    );
    const e = await s.copyIfVersion(UPLOAD_KEY, KEY, '"v"').catch((x: unknown) => x);
    expect((e as ObjectStoreError).code).toBe('CHANGED');
    expect(copies(sent)).toEqual([]);
  });
  it('an outage while reading the source is UNAVAILABLE without leaking the SDK message', async () => {
    const { s } = run(
      () => ({}),
      () => {
        throw named('InternalError', { $metadata: { httpStatusCode: 500 } });
      },
    );
    await expectUnavailable(s.copyIfVersion(UPLOAD_KEY, KEY, '"v"'));
  });
  it.each([
    ['PreconditionFailed by name', named('PreconditionFailed')],
    ['a bare 412 status', named('Whatever', { $metadata: { httpStatusCode: 412 } })],
    ['NoSuchKey (the source is gone)', named('NoSuchKey')],
    ['NotFound', named('NotFound')],
    ['a bare 404 status', named('Whatever', { $metadata: { httpStatusCode: 404 } })],
  ])('maps %s on the copy to CHANGED', async (_n, err) => {
    const { s } = run(() => {
      throw err;
    });
    const e = await s.copyIfVersion(UPLOAD_KEY, KEY, '"v"').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ObjectStoreError);
    expect((e as ObjectStoreError).code).toBe('CHANGED');
    expect((e as ObjectStoreError).message).not.toContain(SDK_LEAK);
  });
  it.each([
    ['a 403', named('AccessDenied', { $metadata: { httpStatusCode: 403 } })],
    ['a 500', named('InternalError', { $metadata: { httpStatusCode: 500 } })],
    ['a 503', named('ServiceUnavailable', { $metadata: { httpStatusCode: 503 } })],
    ['a network error', named('Error')],
    ['a timeout', named('TimeoutError')],
    ['a non-Error rejection', 'plain string'],
    ['null', null],
  ])('maps %s on the copy to UNAVAILABLE without leaking the SDK message', async (_n, err) => {
    const { s } = run(() => {
      throw err;
    });
    await expectUnavailable(s.copyIfVersion(UPLOAD_KEY, KEY, '"v"'));
  });
});

// ---------------------------------------------------------------- the presigner client (createS3Presigner)
describe('createS3Presigner: no checksum is hoisted into the signed PUT URL', () => {
  const cfg = {
    s3: {
      endpoint: 'http://s3-internal.test:9000',
      publicEndpoint: PUBLIC,
      accessKey: 'AKIATESTDUMMYEXAMPLE', // secret-scan:allow
      secretKey: 'dummy-test-example-secret-access-key-0000', // secret-scan:allow
      bucket: BUCKET,
      region: 'us-east-1',
    },
  } as unknown as AppConfig;
  const up = { key: UPLOAD_KEY, contentType: 'application/pdf', contentLength: 4096, ttlSeconds: 600 };

  it('the presigned PUT URL holds neither x-amz-checksum-* nor x-amz-sdk-checksum-algorithm (any file the uploader sends is accepted)', async () => {
    const { client } = stubClient(() => ({}));
    const s = new S3PrivateObjectStore({ client, presignClient: createS3Presigner(cfg), bucket: BUCKET, now: clock });
    const u = new URL((await s.createUploadUrl(up)).url);
    const names = [...u.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names.filter((k) => k.includes('checksum'))).toEqual([]);
    expect(u.search.toLowerCase()).not.toContain('x-amz-checksum');
    expect(u.search.toLowerCase()).not.toContain('x-amz-sdk-checksum-algorithm');
    expect(u.origin).toBe(PUBLIC);
    expect(u.pathname).toBe(`/${BUCKET}/${UPLOAD_KEY}`);
    expect((u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').sort()).toEqual(['content-length', 'content-type', 'host']);
  });
  it('is configured with requestChecksumCalculation WHEN_REQUIRED', async () => {
    expect(await createS3Presigner(cfg).config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
  });
  it('control: a default client DOES hoist a checksum (so the assertion above can fail)', async () => {
    const { client } = stubClient(() => ({}));
    const s = new S3PrivateObjectStore({ client, presignClient: realClient(PUBLIC), bucket: BUCKET, now: clock });
    const u = new URL((await s.createUploadUrl(up)).url);
    expect(u.search.toLowerCase()).toContain('x-amz-checksum');
  });
  it('signs for the PUBLIC endpoint of the configuration, with the configured region', async () => {
    const c = createS3Presigner(cfg);
    expect(await c.config.region()).toBe('us-east-1');
    expect(c.config.forcePathStyle).toBe(true);
  });
});
