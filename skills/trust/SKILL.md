# Provider verification (the trust domain)

## Purpose

Verify providers without a `verified` flag: the `trust` schema (requirement definitions, the rules that say where each applies, verification cases and their requirement instances, document metadata, structured reviews, external verification references, audit), the `@bananagig/trust` service with its pure evaluator, the private object-store port, the provider API under `/api/v1/provider/verification`, the staff API under `/api/v1/admin/trust` and the temporary `/provider/verification` web flow. Since TRUST-001 a provider can be asked for identity, background, licence, insurance, certification or other proofs (each its own requirement), submit documents to private storage, be reviewed with structured reasons, expire and be re-verified. Go-Live (PRO-003) consumes the signals; it is not here.

## When to use

- A feature needs to know whether a provider's checks are approved, missing, pending or expired (the public "ID Verified", "Insured" and "Background checked" marks, search eligibility, Go-Live): read the derived state or consume the events; never add a boolean.
- Adding or changing what is asked of providers (a requirement definition, a rule for a market or service type, a document type, a reason code) or the evidence limits.
- Touching evidence handling (upload, scan, hashing, download), the reviewer decisions or the `trust` schema, API, events or web flow.
- Plugging in a real malware scanner or an external verification provider (ID.me or another): implement the port, never the domain.
- Connecting the Gig builder (CAT-003): template requirement hooks map onto service-type rules.

## Canonical files

- `db/migrations/0019_trust_verification.sql`, `docs/data/DATA_DICTIONARY.md` (`trust.*`), `docs/data/NORMALIZATION_LOG.md` (TRUST-001)
- `packages/contracts/src/trust.ts` (vocabularies, requests, DTOs, events, error codes, content-key helpers, policy schema)
- `packages/trust/src/{service,derive,policy,signatures,adapters,types,errors,index}.ts`
- `packages/platform/src/object-store.ts` (the private object-store port, the S3 and in-memory adapters), `packages/platform/src/clients.ts` (`createS3Presigner`), `packages/config/src/index.ts` (`S3_PUBLIC_ENDPOINT`, `TRUST_SCANNER`, `TRUST_EXTERNAL_PROVIDER`)
- `apps/api/src/modules/trust/{routes,admin-routes,dto,wiring}.ts`, `apps/api/src/plugins/auth.ts` (`TRUST_PERMISSIONS`), `apps/api/src/index.ts` (composition)
- `apps/web/src/app/provider/verification/page.tsx`, `apps/web/src/app/auth/provider/verification/[action]/route.ts`, `apps/web/src/lib/auth/verification-handlers.ts`
- `packages/testing/src/trust-model.itest.ts`, `packages/trust/src/trust.itest.ts`, `apps/api/src/trust.itest.ts`, `apps/smoke/src/index.ts` (scenario `Provider verification`)
- `docs/engineering/TRUST_VERIFICATION.md`, `docs/architecture/ADR-0043-provider-verification-is-a-case-of-policy-derived-requirements-not-a-verified-flag.md`, `docs/architecture/ADR-0044-verification-evidence-lives-in-private-object-storage-with-server-verified-immutable-metadata.md`, `docs/architecture/ADR-0045-scanning-and-external-verification-are-provider-neutral-ports-that-fail-closed.md`

## Architecture rules

- **No `verified` flag, anywhere.** A case holds a requirement instance per policy-required definition (per cycle); `deriveStatus` / `evaluateVerification` derive the overall state. "Complete" = every required requirement approved and none expired. It is NOT Go-Live, NOT the PROVIDER role and NOT the provider registration (PRO-001); `goLive` is always `{evaluated:false, eligible:false}`.
- **Definition / rule / instance.** The definition (stable code, type, evidence kind `DOCUMENT|EXTERNAL`, `expiry_required`) is reference data; a rule (market and/or service type, NULL = all) says where it applies; the instance says what one provider has to prove. The policy snapshot is the definition id plus the cycle on the instance: a policy change never edits an instance (the next evaluation adds or retires instances). Only identity verification is seeded as required (PR-02.06); never seed a legal obligation that is not in the PRD.
- **Cycles and rounds.** Re-verification of an expired approval is `cycle + 1` (the old instance, approval, documents and reviews stay); a round counts the provider's evidence submissions in a cycle. Every review and document names its round: a decision on stale evidence is `STALE_ROUND`, a different decision on the same evidence is `ALREADY_DECIDED`, the same one again is a no-op.
- **Expiry is derived.** An `APPROVED` instance past `expires_at` reads `EXPIRED` immediately; `recordExpiries` records it (status, audit, event). Approvals carry an end date from the evidence when the definition says so; there is no global validity period.
- **Case status is derived and stored** (reviewers' queue, one live case per account); the service re-derives it in the same transaction as every instance change; the database guards only OPEN (initial) and CANCELLED (terminal). Rejection belongs to a requirement; there is no REJECTED case.
- **Evidence is private.** Bytes live in the private bucket under a server-generated key; the database holds metadata. No API returns a key or a hash to a provider; staff get the hash and an audited, short-lived link (`trust-review`); nothing is logged, audited or put in an event. Documents carry no account id: ownership is read through the case, and someone else's document is "not found".
- **Never trust the client.** The upload is authorized against the configured policy and the requirement state; at finalize the server checks existence, size, content type, the file SIGNATURE of that type, its own SHA-256 (a client hash is only compared) and the scan verdict, all OUTSIDE any transaction. A mismatch or an infected file abandons the document and deletes the object; a working scanner is required when `trust.verification.require_clean_scan` is true (fail closed).
- **A presigned PUT outlives finalize.** The provider uploads to `trust/upload/...`; finalize hashes and scans that object, copies it to the final `object_key` with a conditional copy (the version it read), re-hashes the result and never reads the upload key again. Never read, hash or serve the upload key after finalize, and never sign a PUT for the final key.
- **Reviewers see submitted evidence only** (SUBMITTED documents of a case that was not cancelled); an EXTERNAL requirement is approved by staff only after the provider reported it approved; a case that holds an approval cannot be cancelled.
- **History is immutable.** Submitted documents are frozen (only the scan verdict may change); a resubmission is a new document in a later round; identical content is a new document and a hash never skips review. Reviews are append-only with STRUCTURED reason codes and no free-text notes. Nothing is ever deleted.
- **Ports.** `PrivateObjectStore`, `EvidenceScanner`, `VerificationProvider`, `ProviderContextPort`, `TrustPolicyProvider`. Production defaults of the scanner and the external provider are `disabled` (fail closed); `fake` is DEV/TEST and refused in production. Only structured state (adapter, external id, status snapshot) is stored for an external verification.
- **Roles.** `trust-read` (cases, metadata), `trust-review` (decisions, evidence links; implies read), `trust-admin` (policy only; no evidence, no decisions). A provider token is 403 on admin routes. Reviewers are admin identities recorded as text (`admin:<sub>`).
- **Owner-only provider API.** Every route acts on the token's account; no account, case, requirement or decision identifier is ever accepted from a client; strict bodies; every response `no-store`; error details are an allow-list.
- **PRO-001 asks, TRUST-001 answers.** The registration's `VERIFICATION` step comes from `createTrustPrerequisites` (any failure => NOT_AVAILABLE); the registration lifecycle never changes because of verification.
- **Locks.** Provider operations: account row FOR UPDATE -> case -> requirements -> documents. Staff and system operations: case first. Object-store and scanner I/O never happens while a lock is held.
- **Audit and outbox** in the same transaction for every real change; identifiers, codes, statuses and counts only; none for no-ops. A staff read of evidence is audited BEFORE the link is created.

## Implementation pattern

1. To ask for a new proof: add the content entries (`trust.requirement.<code>.name|instructions`) in a forward migration through the content lifecycle, insert the definition (INACTIVE) and, if a document proves it, the document types; a `trust-admin` turns it on with a rule. No code unless the evidence kind is new.
2. To add an evidence format: add its file signature in `signatures.ts` (with a test), then allow it in `trust.document.allowed_mime_types`.
3. To plug in a scanner or vendor: implement `EvidenceScanner` / `VerificationProvider`, select it by configuration in the API composition, keep the production default failing closed, and verify any inbound callback's signature behind the port.
4. To consume verification: read `getVerification` (derived) or the `bananagig.trust.*` events; do not add a column elsewhere.
5. After changing the API or events run `pnpm specs:generate`; after changing the schema run the Data Model Review Gate (never edit 0019).

## Commands

`pnpm --filter @bananagig/trust test` · `node --env-file-if-exists=.env.host node_modules/vitest/vitest.mjs run -c vitest.integration.config.ts packages/trust/src/trust.itest.ts` · `pnpm identity:sync` (DEV ONLY, after the realm gained the `trust-*` roles) · `pnpm smoke` (scenario `Provider verification`; needs the rebuilt api-service/web-app images and `pnpm migrate`) · `pnpm data-model:check TRUST-001`

## Testing requirements

- Model tests on isolated databases: shape, seeds (6 parameters, 97 content entries, reference rows), every guard with its exact `trust_rule` key, the requirement status matrix, rounds, cycles and supersede rules, expiry guards, document lifecycle, one terminal decision per round, immutability, concurrency in both lock orders.
- Pure tests: `deriveStatus` / `evaluateVerification` truth tables, expiry derivation, signatures, adapters, policy parsing, error mapping, the object store.
- Service tests on a real database with an in-memory store: every refusal path of finalize (missing, size, type, spoofed signature, hash, EICAR, scanner error, expiry), submit gates, stale/duplicate decisions, resubmission keeps history, re-verification keeps the old approval, external flows, audit/outbox exactness and atomicity, races, no key/hash/URL/bytes in any output.
- API tests: owner-only (no identifier accepted), the admin permission matrix with forged tokens, strict bodies, `no-store` everywhere, error mapping, exact key sets, the PRO-001 integration, a query budget with no N+1.
- Break the production line a test claims to cover (mutation check, on a private copy) before trusting it.

## Data-model considerations

Any change to the ten tables or their guards needs the Data Model Review Gate and a forward migration (never edit 0019). Policy per region or per document type, review notes, retention fields, appeals and a Go-Live table are new tables or columns with their own migration and ADR update; Go-Live belongs to PRO-003. Never add a contact, name, address, document text or free-text note column, and never copy a provider's profile.

## Common failure modes

- Looking for a `verified` flag: derive from the requirements (or consume the events).
- Treating "verification approved" as "live": that is Go-Live (PRO-003).
- Opening before the registration and the contacts are in place (409 `PREREQUISITE_NOT_MET`).
- Approving without an end date when the definition expires approvals (400 `VALIDATION_FAILED`, `reason EXPIRY_REQUIRED`).
- A decision on a round the provider has since replaced (409 `STALE_ROUND`); two reviewers on the same evidence (409 `ALREADY_DECIDED`).
- Adding evidence while the requirement is under review or approved (409 `EVIDENCE_NOT_ACCEPTED`).
- Expecting production to accept documents before a real scanner exists (503 `SCAN_UNAVAILABLE`, by design).
- Putting an object key, a signed URL or a hash in a log, an audit row, an event or a provider response (the web upload therefore uses `node:http(s)`, not the global `fetch`, which Next.js traces with the full URL).
- Reading the upload key after finalize, or trusting that bytes at the upload key are still the ones that were hashed.
- Doing object-store or scanner I/O inside a transaction.
- Reading a document by id without resolving its owner through the case.

## Known BananaGig-specific lessons

- A document type belongs to ONE requirement type, so no join table is needed; market-specific acceptance would add one (DEBT-0087).
- Expiry guards use `clock_timestamp()`, so tests that expire an approval wait a real second or two; the sweep and the overview use the same timestamp.
- The presigner and the S3 client resolve two copies of the smithy `Client` declaration; one cast in `object-store.ts` bridges the type clash that does not exist at runtime.
- The smoke needs a customer-only identity and the realm roles `trust-*`: it creates and deletes a throwaway Keycloak user and expects `pnpm identity:sync` to have run.
- The commit-time secret scan reads only the FIRST credential-looking match of a file: mark deliberate fake fixtures with `secret-scan:allow`.
- The web upload is performed by the handler, not the browser; a signed URL therefore never reaches a page, and no CORS is configured on the store.
- Order lists with `COLLATE "C"` so codes, audit `changes` and views are the same on every machine.

## Do not

- Do not add a `verified`, `is_verified` or `approved` column to a provider, account, registration or Gig table.
- Do not store file bytes, text extracted from documents, vendor payloads, free-text notes or personal data in the `trust` schema.
- Do not expose an object key, a hash (to providers), a signed URL (except the one-time authorization to its caller) or a document anywhere else.
- Do not trust a client-declared content type, size or hash; do not let a client mark anything approved.
- Do not make a production default of a fake scanner or a fake external provider.
- Do not hardcode policy values, requirement names or any user-visible text.
- Do not delete or overwrite evidence, reviews, approvals or audit rows.
- Do not decide Go-Live, activate a role or change the provider registration from here.
- Do not import another domain package from `@bananagig/trust`; add a port.
- Do not edit an applied migration.

## Related ADRs

ADR-0042, ADR-0043, ADR-0044, ADR-0045

## Last reviewed

2026-10-18 (TRUST-001)
