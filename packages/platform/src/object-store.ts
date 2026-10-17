// The PRIVATE object store port and its adapters (TRUST-001). Domain modules store sensitive files (verification evidence) through this port and never see the S3 SDK.
//
//  - Objects live in a private bucket: nothing here ever creates a public URL. Access is by short-lived presigned URLs created for ONE object, or by the server reading the
//    object itself (to hash, sniff and scan it).
//  - The bytes never touch PostgreSQL, and the port never logs a key, a URL or a byte.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// The presigner and the client resolve two copies of the smithy `Client` declaration (a private-member type clash that does not exist at runtime): one cast, here.
type Signer = Parameters<typeof getSignedUrl>[0];

export interface StoredObjectInfo {
  size: number;
  contentType: string | undefined;
}
export interface UploadUrlRequest {
  key: string;
  contentType: string;
  contentLength: number;
  ttlSeconds: number;
}
export interface UploadAuthorization {
  url: string;
  /** The headers the uploader must send with the PUT (they are part of what is signed). */
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface DownloadUrlRequest {
  key: string;
  ttlSeconds: number;
  contentType?: string;
}
export interface DownloadAuthorization {
  url: string;
  expiresAt: Date;
}

export interface PrivateObjectStore {
  /** A one-object, short-lived URL the caller PUTs the file to. The content type and length are signed, so a different file is refused by the store. */
  createUploadUrl(r: UploadUrlRequest): Promise<UploadAuthorization>;
  /** Size and content type of the stored object, or null when there is none. */
  head(key: string): Promise<StoredObjectInfo | null>;
  /** The stored bytes, or null when there is none. Throws ObjectStoreError('TOO_LARGE') when the object is larger than `maxBytes` (nothing is read). */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Like `read`, with the version (ETag) of the bytes returned; the read fails with ObjectStoreError('CHANGED') if the object changes while it is being read. */
  readVersioned(key: string, maxBytes: number): Promise<{ bytes: Buffer; version: string } | null>;
  /** Copies the object at `fromKey` to `toKey` only while it still has `version`; ObjectStoreError('CHANGED') otherwise. The source is left in place. */
  copyIfVersion(fromKey: string, toKey: string, version: string): Promise<void>;
  /** A one-object, short-lived URL the caller GETs the file from (served as an attachment). */
  createDownloadUrl(r: DownloadUrlRequest): Promise<DownloadAuthorization>;
  /** Removes the object (idempotent). */
  delete(key: string): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    public readonly code: 'TOO_LARGE' | 'CHANGED' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

const isPreconditionFailed = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
};
const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

export interface S3PrivateObjectStoreOptions {
  /** The client used to read, head and delete (the internal endpoint). */
  client: S3Client;
  /** The client used to sign URLs (the endpoint the URL's holder can reach); defaults to `client`. */
  presignClient?: S3Client;
  bucket: string;
  now?: () => Date;
}

export class S3PrivateObjectStore implements PrivateObjectStore {
  private readonly presign: S3Client;
  private readonly now: () => Date;
  constructor(private readonly o: S3PrivateObjectStoreOptions) {
    this.presign = o.presignClient ?? o.client;
    this.now = o.now ?? (() => new Date());
  }

  async createUploadUrl(r: UploadUrlRequest): Promise<UploadAuthorization> {
    const url = await getSignedUrl(
      this.presign as unknown as Signer,
      new PutObjectCommand({ Bucket: this.o.bucket, Key: r.key, ContentType: r.contentType, ContentLength: r.contentLength }),
      { expiresIn: r.ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      url,
      headers: { 'content-type': r.contentType, 'content-length': String(r.contentLength) },
      expiresAt: new Date(this.now().getTime() + r.ttlSeconds * 1000),
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const r = await this.o.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (err) {
      if (isMissing(err)) return null;
      throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const info = await this.head(key);
    if (info === null) return null;
    if (info.size > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
    try {
      const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes) return null;
      if (bytes.byteLength > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof ObjectStoreError) throw err;
      if (isMissing(err)) return null;
      throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    }
  }

  async readVersioned(key: string, maxBytes: number): Promise<{ bytes: Buffer; version: string } | null> {
    const info = await this.head(key);
    if (info === null) return null;
    if (info.size > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
    try {
      const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes || !r.ETag) return null;
      if (bytes.byteLength > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
      return { bytes: Buffer.from(bytes), version: r.ETag };
    } catch (err) {
      if (err instanceof ObjectStoreError) throw err;
      if (isMissing(err)) return null;
      throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    }
  }

  async copyIfVersion(fromKey: string, toKey: string, version: string): Promise<void> {
    try {
      await this.o.client.send(
        new CopyObjectCommand({
          Bucket: this.o.bucket,
          Key: toKey,
          CopySource: `${this.o.bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
          CopySourceIfMatch: version,
        }),
      );
    } catch (err) {
      if (isPreconditionFailed(err) || isMissing(err)) throw new ObjectStoreError('CHANGED', 'the object changed');
      throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    }
  }

  async createDownloadUrl(r: DownloadUrlRequest): Promise<DownloadAuthorization> {
    const url = await getSignedUrl(
      this.presign as unknown as Signer,
      new GetObjectCommand({
        Bucket: this.o.bucket,
        Key: r.key,
        ResponseContentDisposition: 'attachment',
        ...(r.contentType ? { ResponseContentType: r.contentType } : {}),
      }),
      { expiresIn: r.ttlSeconds },
    );
    return { url, expiresAt: new Date(this.now().getTime() + r.ttlSeconds * 1000) };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key }));
    } catch (err) {
      if (isMissing(err)) return;
      throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    }
  }
}

/**
 * An in-memory store for unit tests and offline development. The "URLs" are opaque tokens that only this class understands (`put(token, ...)` plays the uploader); nothing leaves the
 * process.
 */
export class MemoryObjectStore implements PrivateObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string | undefined; version: number }>();
  private versions = 0;
  readonly issued: { kind: 'upload' | 'download'; key: string; ttlSeconds: number }[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Plays the uploader: stores bytes under a key (as a PUT to a presigned URL would). */
  put(key: string, bytes: Buffer, contentType?: string): void {
    this.objects.set(key, { bytes, contentType, version: ++this.versions });
  }
  async createUploadUrl(r: UploadUrlRequest): Promise<UploadAuthorization> {
    this.issued.push({ kind: 'upload', key: r.key, ttlSeconds: r.ttlSeconds });
    return {
      url: `memory://upload/${encodeURIComponent(r.key)}`,
      headers: { 'content-type': r.contentType, 'content-length': String(r.contentLength) },
      expiresAt: new Date(this.now().getTime() + r.ttlSeconds * 1000),
    };
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength, contentType: o.contentType } : null;
  }
  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.bytes.byteLength > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
    return Buffer.from(o.bytes);
  }
  async readVersioned(key: string, maxBytes: number): Promise<{ bytes: Buffer; version: string } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.bytes.byteLength > maxBytes) throw new ObjectStoreError('TOO_LARGE', 'the object is larger than allowed');
    return { bytes: Buffer.from(o.bytes), version: String(o.version) };
  }
  async copyIfVersion(fromKey: string, toKey: string, version: string): Promise<void> {
    const o = this.objects.get(fromKey);
    if (!o || String(o.version) !== version) throw new ObjectStoreError('CHANGED', 'the object changed');
    this.put(toKey, o.bytes, o.contentType);
  }
  async createDownloadUrl(r: DownloadUrlRequest): Promise<DownloadAuthorization> {
    this.issued.push({ kind: 'download', key: r.key, ttlSeconds: r.ttlSeconds });
    return { url: `memory://download/${encodeURIComponent(r.key)}`, expiresAt: new Date(this.now().getTime() + r.ttlSeconds * 1000) };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
