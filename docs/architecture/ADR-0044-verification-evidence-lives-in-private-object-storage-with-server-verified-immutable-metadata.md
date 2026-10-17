# ADR-0044 — Verification evidence lives in private object storage with server-verified, immutable metadata: nothing the client says is trusted, keys and links never leave the server, and history is never overwritten

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: TRUST-001

## Context

Identity documents, licences and insurance certificates are among the most sensitive data the platform holds (SV-09.02: "sensitive documents are access-controlled and audited"). The platform has an S3 client (SeaweedFS) but only a health check uses it. An upload feature invites the classic failures: files in the database, public or guessable URLs, a client-declared content type and size taken at face value, signed links in logs, one account reading another's file, evidence overwritten after it was reviewed.

## Decision

- **Bytes are never in PostgreSQL.** The database holds metadata (object key, document type, verified size and content type, server-computed SHA-256, scan state, round, timestamps). Files live in the private bucket under a server-generated key (`trust/evidence/<case>/<document>`) that carries no account, name or content.
- **The store sits behind a port** (`PrivateObjectStore` in `@bananagig/platform`: sign an upload, head, read, sign a download, delete) with an S3 adapter and an in-memory one for tests. Domain code imports no SDK. The signing client can use a separate public endpoint (`S3_PUBLIC_ENDPOINT`) for a caller outside the container network.
- **Two-step upload with server verification.** The provider asks to upload a file of a stated type and size; the server validates it against the configured policy (allowed types, maximum size, documents per requirement) and the requirement's state, records an `UPLOAD_PENDING` document and returns a one-object, short-lived PUT authorization with the type and length signed. After the upload the provider asks to finalize; the server then checks, **outside any transaction**, that the object exists, its size and content type are the authorized ones, its first bytes are the **file signature** of that type, and that the **SHA-256 it computes from the stored bytes** equals the client's when one was sent, then scans it. The provider's bytes arrive at a SEPARATE upload key; because a presigned PUT stays valid until it expires, finalize copies exactly the bytes it hashed and scanned to the final key only while the upload object still has the version it read (a conditional copy), re-reads what landed and compares the hash, and stops reading the upload key. A replayed PUT can therefore only write an object nothing reads. A mismatch, a changed object or an infected file abandons the document and deletes the objects; a missing scanner leaves it pending (fail closed).
- **The web uploads server-side.** The browser posts the file to the web handler, which asks the API to authorize, PUTs the bytes to the one-time URL from the server and asks the API to finalize. The browser never touches the store, so no CORS configuration exists and no signed URL reaches a page.
- **Keys and links never leave the server.** No API returns an object key or a hash to the provider; reviewers receive the hash (integrity evidence) and a short-lived, audited download link only through `trust-review`; nothing is stored in or put into logs, audit rows or events. The audit row of a download is written **before** the link is created.
- **Evidence history is immutable.** A document is a draft (`UPLOAD_PENDING`, `ATTACHED`) until the provider submits, then `SUBMITTED` in a round and frozen by the database (only the scan verdict may still change). A resubmission is a new document in a later round. Identical content uploaded twice is two documents: a matching hash never approves anything and is not used to skip review. Rows are never deleted; a withdrawn draft's object is.
- **Ownership is read through the case.** Documents and requirements carry no account id; every provider operation resolves the document through its case to the token's account, and someone else's document is "not found".
- **No retention period is invented.** The schema keeps history; the retention hook is recorded as debt until Legal confirms a schedule. No destructive job exists.

## Alternatives considered

- **Store files in PostgreSQL (bytea / large objects).** Rejected: bloats the authoritative store and its backups with the most sensitive data, and ties scaling to the database.
- **Public bucket with unguessable names.** Rejected: a leaked name is a permanent leak and nothing is audited.
- **Browser uploads straight to the store.** Rejected for now: it needs CORS, exposes signed URLs to pages and scripts, and a no-script form cannot PUT. The port allows it later.
- **Trusting the declared content type and size.** Rejected: a renamed executable or an HTML page would pass as a PDF.
- **Deduplicating by hash.** Rejected: it could skip review of a re-upload and ties a stored object to two cases.

## Consequences

- The web handler holds the uploaded file in memory for one request (bounded by the structural ceiling and the policy maximum); streaming and very large files are future work.
- Orphans (an authorized upload never finalized) leave an `UPLOAD_PENDING` row and possibly an object until a cleanup job exists (DEBT-0088).
- Production cannot attach a document until a real scanner replaces the disabled one (DEBT-0087).

## Migration / compatibility

Covered by `0019_trust_verification.sql` (the `trust.documents` table and its guards); `@aws-sdk/s3-request-presigner` is added to `@bananagig/platform`; `S3_PUBLIC_ENDPOINT`, `TRUST_SCANNER` and `TRUST_EXTERNAL_PROVIDER` are optional settings with safe defaults.

## Related files

- `db/migrations/0019_trust_verification.sql`
- `packages/platform/src/object-store.ts`
- `packages/trust/src/signatures.ts`
- `packages/trust/src/service.ts`
- `apps/web/src/lib/auth/verification-handlers.ts`
- `docs/engineering/TRUST_VERIFICATION.md`
- `docs/architecture/ADR-0043-provider-verification-is-a-case-of-policy-derived-requirements-not-a-verified-flag.md`
