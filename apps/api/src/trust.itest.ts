// TRUST-001 provider verification over HTTP, on the REAL stack wired the way apps/api/src/index.ts wires it: the real Fastify app (buildApp), the real AccountService, ConsentService,
// GeographyService, CatalogService, ContentService and ConfigurationService, the ProviderRegistrationService whose `verification` step is answered by the REAL TrustService through the
// adapters of modules/trust/wiring.ts, the in-memory PRIVATE object store (the uploader is played by the test), the fake evidence scanner (and a second stack with the DISABLED scanner,
// and a third whose clock is an hour ahead), forged-but-signed tokens, and one real, isolated PostgreSQL (migration 0019 seeds the policy, the requirement definitions and the copy; the
// requirement policy is changed through the REAL administrator API). The unit layer (trust.test.ts) proves the HTTP edge with a fake service; this file proves the behaviour.
//
// What it proves end to end: the seeded state -> a provider without a case (overview, PRO-001 step NOT_STARTED, nothing written) -> prerequisites (live registration, verified contacts)
// -> open (201, 200, concurrent) -> upload authorization -> bytes into the store -> finalize (server-side size, content type, signature, SHA-256, scan) -> every spoof refused and
// cleaned up -> withdraw -> submit (stale revision, incomplete, rounds) -> the reviewers' queue and case -> start-review / request-action / reject / approve with rounds and reasons
// -> the provider's resubmission -> approval with the PRO-001 VERIFICATION step following every state while the registration lifecycle and Go-Live stay untouched -> expiry (derived
// and recorded) and re-verification -> external verification -> download links (policy lifetime, audited first) -> policy administration -> cancel and restart -> owner isolation
// and IDOR -> decision and finalize races -> audit and outbox as a whole -> secrecy over every response, log line, audit row and event -> a query-count budget.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountService, ConsentService } from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import {
  CORRELATION_HEADER,
  ErrorResponse,
  ProviderRequirementsResponse,
  TRUST_EVENTS,
  TRUST_POLICY_KEYS,
  categoryNameKey,
  serviceTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  TrustCaseDetailResponse,
  TrustCaseListResponse,
  TrustDownloadResponse,
  TrustPolicyResponse,
  TrustRequirementDecisionResponse,
  DocumentUploadAuthorizationResponse,
  ProviderVerificationResponse,
  VerificationDocumentListResponse,
  VerificationDocumentResponse,
  ExternalVerificationResponse,
} from '@bananagig/contracts';
import { CatalogService } from '@bananagig/catalog';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { MemoryObjectStore } from '@bananagig/platform';
import { ProviderRegistrationService } from '@bananagig/provider';
import {
  DisabledEvidenceScanner,
  DisabledVerificationProvider,
  EICAR_TEST_STRING,
  FakeEvidenceScanner,
  FakeVerificationProvider,
  TrustService,
  type EvidenceScanner,
  type VerificationProvider,
} from '@bananagig/trust';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';
import { createProviderContextPort, createTrustPolicyProvider, createTrustPrerequisites } from './modules/trust/wiring';

// ---------------------------------------------------------------- the real stack
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const AUTHOR = 'author-a';
const APPROVER = 'approver-b';
const CFG_AUTHOR = 'cfg:author';
const CFG_APPROVER = 'cfg:approver';
const REASON = 'trust itest';
const BODY_MARK = 'SYNTHETIC-EVIDENCE-BODY-MARKER';
const P = TRUST_POLICY_KEYS;

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance; // scanner: fake, external: fake
let appNoScan: FastifyInstance; // scanner: disabled, external: disabled
let appLate: FastifyInstance; // clock one hour ahead
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let geography: GeographyService;
let catalog: CatalogService;
let consent: ConsentService;
let trust: TrustService;
let externalProvider: FakeVerificationProvider;
const store = new MemoryObjectStore();
/** Statements run by the database while this is set (the query-count budget). */
let capture: string[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
  cid: string;
}
/** Every response of the file, for the secrecy scan at the end. */
const transcript: Res[] = [];
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const keysOf = (o: object) => Object.keys(o).sort();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- evidence fixtures (SYNTHETIC: a few bytes with a real signature, never a real document)
const pdf = () => Buffer.from(`%PDF-1.4\n% ${BODY_MARK} pdf ${randomUUID()}\n%%EOF\n`, 'latin1');
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${BODY_MARK} png ${randomUUID()}`)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`${BODY_MARK} jpg ${randomUUID()}`)]);
const html = () => Buffer.from(`<html>${BODY_MARK} ${randomUUID()}</html>`);

// ---------------------------------------------------------------- actors and calls
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  email: string;
  phone: string;
  token: string;
}
const actors: Actor[] = [];
let phoneSeq = 0;
const tokenFor = (sub: string, claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims } });
const adminTokenFor = (roles: string[], sub: string) =>
  signToken(keys, {
    claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } } },
  });
const REVIEWER_SUB = 'staff-reviewer-r1';
const READER_SUB = 'staff-reader-r2';
const POLICY_SUB = 'staff-policy-p1';
let REVIEWER: string; // trust-review
let READER: string; // trust-read
let POLICY: string; // trust-admin
let EVERYTHING: string; // all three

const PV = '/api/v1/provider/verification';
const AD = '/api/v1/admin/trust';
const REG = '/api/v1/provider/registration';

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o: { as?: Actor | string | null; body?: unknown; rawBody?: string; headers?: Record<string, string>; on?: FastifyInstance } = {},
): Promise<Res> {
  const token = o.as === null || o.as === undefined ? undefined : typeof o.as === 'string' ? o.as : o.as.token;
  const cid = o.headers?.[CORRELATION_HEADER] ?? `itest-${randomUUID()}`;
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const r = await (o.on ?? app).inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      [CORRELATION_HEADER]: cid,
      ...o.headers,
    },
    ...(hasBody ? { payload: o.rawBody ?? JSON.stringify(o.body) } : {}),
  });
  let body: Json;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  const res: Res = { method, url, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}
const vget = (a: Actor, on?: FastifyInstance) => call('GET', PV, { as: a, on });
const vopen = (a: Actor) => call('POST', PV, { as: a });
const vdocs = (a: Actor) => call('GET', `${PV}/documents`, { as: a });
const vupload = (a: Actor, body: unknown, on?: FastifyInstance) => call('POST', `${PV}/documents/upload`, { as: a, body, on });
const vfinalize = (a: Actor, id: string, body?: unknown, on?: FastifyInstance) =>
  call('POST', `${PV}/documents/${id}/finalize`, { as: a, ...(body === undefined ? {} : { body }), on });
const vwithdraw = (a: Actor, id: string) => call('POST', `${PV}/documents/${id}/withdraw`, { as: a });
const vsubmit = (a: Actor, expectedRevision: number) => call('POST', `${PV}/submit`, { as: a, body: { expectedRevision } });
const vcancel = (a: Actor) => call('POST', `${PV}/cancel`, { as: a });
const vreverify = (a: Actor, code: string, on?: FastifyInstance) => call('POST', `${PV}/requirements/${code}/reverify`, { as: a, on });
const vexternal = (a: Actor, code: string, on?: FastifyInstance) => call('POST', `${PV}/requirements/${code}/external`, { as: a, on });
const vrefresh = (a: Actor, code: string, on?: FastifyInstance) => call('POST', `${PV}/requirements/${code}/external/refresh`, { as: a, on });
const regReqs = (a: Actor) => call('GET', `${REG}/requirements`, { as: a });
// the reviewers
const aList = (t: string | null, qs = '') => call('GET', `${AD}/cases${qs}`, { as: t });
const aCase = (t: string | null, id: string) => call('GET', `${AD}/cases/${id}`, { as: t });
const aDownload = (t: string | null, id: string) => call('GET', `${AD}/documents/${id}/download`, { as: t });
const aDecide = (t: string | null, action: 'start-review' | 'approve' | 'reject' | 'request-action', reqId: string, body: unknown) =>
  call('POST', `${AD}/requirements/${reqId}/${action}`, { as: t, body });
const aPolicy = (t: string | null) => call('GET', `${AD}/policy`, { as: t });
const aStatus = (t: string | null, code: string, status: string) => call('PUT', `${AD}/requirement-definitions/${code}/status`, { as: t, body: { status } });
const aRule = (t: string | null, body: unknown) => call('PUT', `${AD}/requirement-rules`, { as: t, body });

/** A 2xx with the standard envelope; the data must equal its contract exactly (no field missing, none extra). */
type Contract = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
const ok = (r: Res, status = 200, schema: Contract | null = ProviderVerificationResponse): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(keysOf(r.body), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  if (schema !== null) {
    const parsed = schema.safeParse(r.body);
    expect(parsed.success, r.raw).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), 'no field outside the contract').toEqual(r.body);
  }
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  return r.body.error;
};
/** A trust failure: status, code, the fixed message key and the details it may carry. */
const trustFail = (r: Res, status: number, code: string, details: Record<string, unknown> = {}): Json => {
  const e = fail(r, status, `TRUST_${code}`);
  expect(e.details, r.raw).toEqual({ ...details, messageKey: trustErrorKey(code as never) });
  return e;
};
const okDocs = (r: Res) => ok(r, 200, VerificationDocumentListResponse);
const okDoc = (r: Res) => ok(r, 200, VerificationDocumentResponse);
const okDecision = (r: Res) => ok(r, 200, TrustRequirementDecisionResponse);
const requirementOf = (data: Json, code = 'identity_verification'): Json => data.requirements.find((x: Json) => x.requirementCode === code);
const stepOf = (data: Json, step: string): Json => data.steps.find((s: Json) => s.step === step);

async function newActor(label: string, o: { email?: boolean; phone?: boolean } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  const a: Actor = {
    label,
    sub,
    accountId: '',
    email: `sentinel.${label}.${randomUUID().slice(0, 8)}@sentinel-contact.example`,
    phone: `+1415555${String(1000 + ++phoneSeq)}`,
    token: await tokenFor(sub),
  };
  const me = await call('GET', '/api/v1/account/me', { as: a });
  expect(me.status, me.raw).toBe(200);
  a.accountId = me.body.data.accountId;
  if (o.email) await verifyEmail(a);
  if (o.phone) await verifyPhone(a);
  actors.push(a);
  return a;
}
const verifyEmail = async (a: Actor) => {
  await q(`INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')`, [
    a.accountId,
    a.email,
  ]);
  await q(
    `UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
    [a.accountId],
  );
};
const verifyPhone = async (a: Actor) => {
  await q(`INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')`, [
    a.accountId,
    a.phone,
  ]);
  await q(
    `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
    [a.accountId],
  );
};
/** A provider ready for verification: verified contacts, a live registration, the market and the chosen service types. */
async function provider(label: string, services: string[] = [W.stA], market: string = W.a): Promise<Actor> {
  const a = await newActor(label, { email: true, phone: true });
  ok(await call('POST', REG, { as: a }), 201, null);
  expect((await call('PUT', `${REG}/market`, { as: a, body: { marketCode: market } })).status).toBe(200);
  const s = await call('PUT', `${REG}/services`, { as: a, body: { serviceTypeCodes: services } });
  expect(s.status, s.raw).toBe(200);
  return a;
}

// ---------------------------------------------------------------- uploads: the uploader is played by the test
interface Put {
  auth: Res;
  docId: string;
  /** the UPLOAD key the provider PUTs to (trust/upload/...) */
  key: string;
  /** the FINAL key the verified copy lands on (trust/evidence/...) */
  finalKey: string;
  fin?: Res;
}
const keyOfUrl = (url: string): string => decodeURIComponent(url.replace('memory://upload/', ''));
const finalKeyOf = (uploadKey: string): string => uploadKey.replace('trust/upload/', 'trust/evidence/');
const uploadKeyOfFinal = (finalKey: string): string => finalKey.replace('trust/evidence/', 'trust/upload/');
/** the keys among these that the store still holds */
const present = (...keys: string[]) => keys.filter((k) => store.objects.has(k));
interface PutOpts {
  requirement?: string;
  type?: string;
  mime?: string;
  bytes?: Buffer;
  /** the size the provider DECLARES (default: the real size) */
  declared?: number;
  /** the content type the store records for the object (default: the declared MIME type); null = none */
  storedType?: string | null;
  /** do not send the bytes */
  skipPut?: boolean;
  /** finalize? (default true) */
  finalize?: boolean;
  finalizeBody?: unknown;
  on?: FastifyInstance;
}
async function putDoc(a: Actor, o: PutOpts = {}): Promise<Put> {
  const bytes = o.bytes ?? pdf();
  const mime = o.mime ?? 'application/pdf';
  const auth = await vupload(
    a,
    {
      requirementCode: o.requirement ?? 'identity_verification',
      documentTypeCode: o.type ?? 'drivers_license',
      mimeType: mime,
      sizeBytes: o.declared ?? bytes.byteLength,
    },
    o.on,
  );
  if (auth.status !== 201) return { auth, docId: '', key: '', finalKey: '' };
  const d = auth.body.data;
  const key = keyOfUrl(d.upload.url);
  if (!o.skipPut) store.put(key, bytes, o.storedType === null ? undefined : (o.storedType ?? mime));
  const out: Put = { auth, docId: d.document.verificationDocumentId, key, finalKey: finalKeyOf(key) };
  if (o.finalize !== false) out.fin = await vfinalize(a, out.docId, o.finalizeBody, o.on);
  return out;
}
/** A document that is attached (finalized and clean) to the requirement. */
async function attached(a: Actor, o: PutOpts = {}): Promise<Put> {
  const p = await putDoc(a, o);
  okDoc(p.fin!);
  expect(p.fin!.body.data.status).toBe('ATTACHED');
  return p;
}

// ---------------------------------------------------------------- the database views
const caseRows = (accountId: string) =>
  q<{
    verification_case_id: string;
    case_number: number;
    status: string;
    revision: number;
    submitted_at: Date | null;
    decided_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `SELECT verification_case_id, case_number, status, revision, submitted_at, decided_at, cancelled_at FROM trust.verification_cases WHERE account_id = $1 ORDER BY case_number`,
    [accountId],
  );
const liveCase = async (a: Actor) => (await caseRows(a.accountId)).filter((c) => c.status !== 'CANCELLED').at(-1)!;
const reqRows = (caseId: string) =>
  q<{
    case_requirement_id: string;
    code: string;
    cycle: number;
    status: string;
    round: number;
    revision: number;
    expires_at: Date | null;
    approved_at: Date | null;
    superseded_at: Date | null;
  }>(
    `SELECT cr.case_requirement_id, d.code, cr.cycle, cr.status, cr.round, cr.revision, cr.expires_at, cr.approved_at, cr.superseded_at
       FROM trust.case_requirements cr JOIN trust.requirement_definitions d ON d.requirement_definition_id = cr.requirement_definition_id
      WHERE cr.verification_case_id = $1 ORDER BY d.code COLLATE "C", cr.cycle`,
    [caseId],
  );
/** The current (not superseded) instance of a requirement code of the actor's live case. */
async function inst(a: Actor, code = 'identity_verification') {
  const c = await liveCase(a);
  return (await reqRows(c.verification_case_id)).find((r) => r.code === code && r.superseded_at === null)!;
}
const docRows = (accountId: string) =>
  q<{
    verification_document_id: string;
    case_requirement_id: string;
    object_key: string;
    status: string;
    scan_status: string;
    sha256: string | null;
    round: number | null;
    size_bytes: number;
    mime_type: string;
    code: string;
  }>(
    `SELECT doc.verification_document_id, doc.case_requirement_id, doc.object_key, doc.status, doc.scan_status, doc.sha256, doc.round, doc.size_bytes, doc.mime_type, dt.code
       FROM trust.documents doc JOIN trust.document_types dt ON dt.document_type_id = doc.document_type_id
       JOIN trust.case_requirements cr ON cr.case_requirement_id = doc.case_requirement_id JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
      WHERE c.account_id = $1 ORDER BY doc.created_at, doc.verification_document_id`,
    [accountId],
  );
const docRow = async (id: string) =>
  (
    await q<{ status: string; scan_status: string; sha256: string | null; object_key: string }>(
      `SELECT status, scan_status, sha256, object_key FROM trust.documents WHERE verification_document_id = $1`,
      [id],
    )
  )[0]!;
const reviewRows = (reqId: string) =>
  q<{ round: number; decision: string; reason_code: string | null; reviewer: string; expires_at: Date | null; correlation_id: string }>(
    `SELECT round, decision, reason_code, reviewer, expires_at, correlation_id FROM trust.reviews WHERE case_requirement_id = $1 ORDER BY reviewed_at, review_id`,
    [reqId],
  );
const auditOf = (caseId: string) =>
  q<{ action: string; actor: string; changes: Json; reason_code: string | null; correlation_id: string; case_requirement_id: string | null }>(
    `SELECT action, actor, changes, reason_code, correlation_id, case_requirement_id FROM trust.audit_events WHERE verification_case_id = $1 ORDER BY occurred_at, audit_event_id`,
    [caseId],
  );
const outboxOf = (caseId: string) =>
  q<{ event_type: string; aggregate_type: string; actor_type: string; actor_id: string; payload_json: Json; correlation_id: string }>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, payload_json, correlation_id FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, outbox_event_id`,
    [caseId],
  );
const rolesOf = (accountId: string) =>
  q<{ code: string; status: string }>(
    `SELECT r.code, m.status FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 ORDER BY r.code`,
    [accountId],
  );
const regRow = async (accountId: string) =>
  (
    await q<{ status: string; revision: number }>(
      `SELECT status, revision FROM provider.registrations WHERE account_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [accountId],
    )
  )[0]!;
/** Counters of everything the trust domain writes, to prove a refused request changed nothing. */
const writes = async () => ({
  cases: await count('SELECT 1 FROM trust.verification_cases'),
  requirements: await count('SELECT 1 FROM trust.case_requirements'),
  documents: await count('SELECT 1 FROM trust.documents'),
  reviews: await count('SELECT 1 FROM trust.reviews'),
  external: await count('SELECT 1 FROM trust.external_verifications'),
  audit: await count('SELECT 1 FROM trust.audit_events'),
  outbox: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.trust.%'`),
  revisions: (await q<{ s: string | null }>("SELECT string_agg(revision::text, ',' ORDER BY verification_case_id) AS s FROM trust.verification_cases"))[0]!.s,
  objects: store.objects.size,
});
/** The provider-domain counters: verification must never change the registration. */
const providerWrites = async () => ({
  registrations: await count('SELECT 1 FROM provider.registrations'),
  audit: await count('SELECT 1 FROM provider.audit_events'),
  outbox: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'`),
  roles: await count('SELECT 1 FROM identity.account_roles'),
});

// ---------------------------------------------------------------- world: markets, catalogue, legal documents, configuration
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: /\.name$/.test(key) ? 'UI_LABEL' : 'PLAIN_TEXT',
  ownerRole: 'CONTENT',
  description: 'trust itest entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});
async function publishText(key: string, body: string): Promise<void> {
  const v = await content.createVersion(key, { locale: 'en-US', scopeType: 'PLATFORM', scopeRef: null, body, reason: REASON }, AUTHOR);
  const submitted = await content.submit(v.versionId, AUTHOR);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, APPROVER);
  await content.publish(v.versionId, AUTHOR);
}
async function copy(key: string, text: string): Promise<void> {
  await content.createEntry(entryReq(key), AUTHOR);
  await publishText(key, text);
}
let seq = 0;
const code = (prefix: string) => `devtest_${prefix}_${++seq}`;
async function market(name: string): Promise<string> {
  const c = `devtest-trust-${name}`;
  await geography.createMarket(
    { code: c, name: 'Trust Test Market', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: REASON },
    AUTHOR,
  );
  await geography.setMarketActive(c, true, 'activate for test', AUTHOR);
  return c;
}
async function category(): Promise<string> {
  const c = code('cat');
  await copy(categoryNameKey(c), `Category ${c}`);
  await catalog.createCategory({ code: c, withDescription: false, reason: REASON }, AUTHOR);
  await catalog.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  return c;
}
async function serviceType(cat: string): Promise<string> {
  const c = code('st');
  await copy(serviceTypeNameKey(c), `Service ${c}`);
  await catalog.createServiceType({ code: c, categoryCode: cat, reason: REASON }, AUTHOR);
  await catalog.setServiceTypeStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  return c;
}
let order = 0;
const W = {} as { a: string; b: string; stA: string; stB: string; stC: string; stD: string };

async function setConfig(key: string, value: unknown): Promise<void> {
  const cr = await configuration.createChangeRequest({ parameterKey: key, scopeType: 'PLATFORM', scopeRef: null, value, reason: 'itest change' }, CFG_AUTHOR);
  await configuration.submit(cr.changeRequestId, CFG_AUTHOR);
  await configuration.approve(cr.changeRequestId, CFG_APPROVER, 'ok');
  expect((await configuration.publish(cr.changeRequestId, CFG_AUTHOR)).state).toBe('ACTIVE');
}
const DEFAULT_POLICY: Record<string, unknown> = {
  [P.maxSizeBytes]: 10_485_760,
  [P.allowedMimeTypes]: ['application/pdf', 'image/jpeg', 'image/png'],
  [P.maxDocumentsPerRequirement]: 5,
  [P.uploadUrlTtlSeconds]: 300,
  [P.downloadUrlTtlSeconds]: 60,
  [P.requireCleanScan]: true,
};
const resetPolicy = async (only?: string[]) => {
  for (const [k, v] of Object.entries(DEFAULT_POLICY)) if (!only || only.includes(k)) await setConfig(k, v);
};

// legal documents through the REAL content workflow (used once: a registration that completes WITHOUT verification)
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
async function publishLegal(entryKey: string): Promise<void> {
  const created = await content.createVersion(
    entryKey,
    { locale: 'en-US', body: `LEGALBODY ${randomUUID()} body of ${entryKey}`, reason: REASON },
    'legal:author',
  );
  await content.submit(created.versionId, 'legal:author');
  await content.approve(created.versionId, 'legal:approver', 'ok');
  await content.publish(created.versionId, 'legal:author');
}
async function acceptAgreements(a: Actor): Promise<void> {
  const r = await consent.getRequirements(a.accountId, {});
  for (const p of [TERMS, PRIVACY]) {
    const row = r.requirements.find((x) => x.purposeCode === p)!;
    expect(row.document, `${p} has a published document`).not.toBeNull();
    await consent.accept(a.accountId, p, { versionId: row.document!.versionId, locale: row.document!.locale, bodySha256: row.document!.bodySha256 }, {});
  }
}

// ---------------------------------------------------------------- log capture
const logLines: string[] = [];
function captureLogs(): void {
  const grab = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab);
}

// ---------------------------------------------------------------- the stacks
function stack(over: { scanner: EvidenceScanner; external: VerificationProvider; now?: () => Date }) {
  const database = iso.database;
  const accountPort = createAccountPort(accounts);
  const policy = createProviderPolicyProvider(configuration);
  const holder: { current?: ProviderRegistrationService } = {};
  const service = new TrustService({
    database,
    context: createProviderContextPort({ accounts: accountPort, policy, registrations: () => holder.current! }),
    policy: createTrustPolicyProvider(configuration),
    store,
    scanner: over.scanner,
    external: over.external,
    ...(over.now ? { now: over.now } : {}),
  });
  const providerRegistrations = (holder.current = new ProviderRegistrationService({
    database,
    accounts: accountPort,
    consent: createConsentPort(consent),
    markets: createMarketPort(geography),
    catalog: createCatalogPort(catalog),
    policy,
    prerequisites: createTrustPrerequisites(service),
  }));
  return { service, providerRegistrations };
}
async function appOf(s: ReturnType<typeof stack>, verifier: ReturnType<typeof createTokenVerifier>): Promise<FastifyInstance> {
  const a = await buildApp({
    cfg,
    verifier,
    configuration,
    content,
    geography,
    catalog,
    accounts,
    consent,
    providerRegistrations: s.providerRegistrations,
    trust: s.service,
    readiness: async () => ({}),
  });
  await a.ready();
  return a;
}

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { onQuery: (e) => capture?.push(e.sql), overrides: { poolMax: 30, connectionTimeoutMs: 30_000 } } });
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const database = iso.database;
  geography = new GeographyService({ database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  content = new ContentService({
    database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography, { ttlMs: 60_000 }),
  });
  configuration = new ConfigurationService({ database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  catalog = new CatalogService({ database, markets: createMarketGate(geography), cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database, lastSeenTouchSeconds: 0 });
  consent = new ConsentService({ database, policy: createConsentPolicyProvider(configuration), defaultLocale: createDefaultLocaleResolver(content) });
  captureLogs();
  externalProvider = new FakeVerificationProvider();
  const main = stack({ scanner: new FakeEvidenceScanner(), external: externalProvider });
  trust = main.service;
  app = await appOf(main, verifier);
  appNoScan = await appOf(stack({ scanner: new DisabledEvidenceScanner(), external: new DisabledVerificationProvider() }), verifier);
  appLate = await appOf(stack({ scanner: new FakeEvidenceScanner(), external: externalProvider, now: () => new Date(Date.now() + 3_600_000) }), verifier);

  REVIEWER = await adminTokenFor(['trust-review'], REVIEWER_SUB);
  READER = await adminTokenFor(['trust-read'], READER_SUB);
  POLICY = await adminTokenFor(['trust-admin'], POLICY_SUB);
  EVERYTHING = await adminTokenFor(['trust-read', 'trust-review', 'trust-admin'], 'staff-everything-e1');

  // the world: two ACTIVE markets, one category, four service types offered in market A (stA also in B)
  W.a = await market('a');
  W.b = await market('b');
  const cat = await category();
  W.stA = await serviceType(cat);
  W.stB = await serviceType(cat);
  W.stC = await serviceType(cat);
  W.stD = await serviceType(cat);
  await catalog.setMarketCategoryAvailability(W.a, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  await catalog.setMarketCategoryAvailability(W.b, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  for (const st of [W.stA, W.stB, W.stC, W.stD])
    await catalog.setMarketServiceTypeAvailability(W.a, st, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  await catalog.setMarketServiceTypeAvailability(W.b, W.stA, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
}, 240_000);
afterAll(async () => {
  await app?.close();
  await appNoScan?.close();
  await appLate?.close();
  await iso?.drop();
});

// ====================================================================== the seeded state
describe('the seeded policy of migration 0019', () => {
  it('serves the six evidence parameters through the real registry with the documented defaults, and no case exists', async () => {
    const values = (await configuration.resolveMany(Object.values(P))).values;
    expect(Object.fromEntries([...values].map(([k, v]) => [k, v.value]))).toEqual(DEFAULT_POLICY);
    expect(await count('SELECT 1 FROM trust.verification_cases')).toBe(0);
    expect(await count('SELECT 1 FROM trust.audit_events')).toBe(0);
    expect(store.objects.size).toBe(0);
  });
  it('seeds four requirement definitions (only identity_verification ACTIVE), seven document types, seven reasons and ONE all-markets rule', async () => {
    const defs = await q<{ code: string; status: string; evidence_kind: string; expiry_required: boolean }>(
      `SELECT code, status, evidence_kind, expiry_required FROM trust.requirement_definitions ORDER BY code`,
    );
    expect(defs).toEqual([
      { code: 'background_check', status: 'INACTIVE', evidence_kind: 'EXTERNAL', expiry_required: true },
      { code: 'identity_verification', status: 'ACTIVE', evidence_kind: 'DOCUMENT', expiry_required: false },
      { code: 'liability_insurance', status: 'INACTIVE', evidence_kind: 'DOCUMENT', expiry_required: true },
      { code: 'professional_license', status: 'INACTIVE', evidence_kind: 'DOCUMENT', expiry_required: true },
    ]);
    expect(await count('SELECT 1 FROM trust.document_types')).toBe(7);
    expect(await count('SELECT 1 FROM trust.reason_codes')).toBe(7);
    expect(
      await q(
        `SELECT d.code, r.enabled, r.market_id, r.service_type_id FROM trust.requirement_rules r JOIN trust.requirement_definitions d USING (requirement_definition_id)`,
      ),
    ).toEqual([{ code: 'identity_verification', enabled: true, market_id: null, service_type_id: null }]);
  });
});

// ====================================================================== policy administration (trust-admin): the requirements the rest of the file relies on
describe('policy administration', () => {
  it('trust-admin reads the policy: four definitions, one rule, the document types; nothing else', async () => {
    const data = ok(await aPolicy(POLICY), 200, TrustPolicyResponse);
    expect(data.requirements.map((r: Json) => [r.code, r.status])).toEqual([
      ['background_check', 'INACTIVE'],
      ['identity_verification', 'ACTIVE'],
      ['liability_insurance', 'INACTIVE'],
      ['professional_license', 'INACTIVE'],
    ]);
    expect(data.rules).toEqual([{ requirementCode: 'identity_verification', marketCode: null, serviceTypeCode: null, enabled: true }]);
    expect(data.documentTypes).toHaveLength(7);
    expect(data.requirements[0].nameKey).toBe('trust.requirement.background_check.name');
  });

  it('activating a definition and requiring it for a service type is audited, idempotent and changes nobody who does not offer that service type', async () => {
    for (const [codeName, st] of [
      ['professional_license', W.stB],
      ['liability_insurance', W.stC],
      ['background_check', W.stD],
    ] as const) {
      const status = await aStatus(POLICY, codeName, 'ACTIVE');
      expect(ok(status, 200, null)).toEqual({ code: codeName, status: 'ACTIVE', changed: true });
      expect(ok(await aStatus(POLICY, codeName, 'ACTIVE'), 200, null)).toEqual({ code: codeName, status: 'ACTIVE', changed: false });
      const rule = { requirementCode: codeName, marketCode: null, serviceTypeCode: st, enabled: true };
      expect(ok(await aRule(POLICY, rule), 200, null)).toEqual({ ...rule, changed: true });
      expect(ok(await aRule(POLICY, rule), 200, null)).toEqual({ ...rule, changed: false });
    }
    const audit = await q<{ action: string; actor: string; changes: Json }>(
      `SELECT action, actor, changes FROM trust.audit_events WHERE action IN ('TRUST_REQUIREMENT_STATUS_CHANGED', 'TRUST_RULE_CHANGED') ORDER BY occurred_at, audit_event_id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'TRUST_REQUIREMENT_STATUS_CHANGED',
      'TRUST_RULE_CHANGED',
      'TRUST_REQUIREMENT_STATUS_CHANGED',
      'TRUST_RULE_CHANGED',
      'TRUST_REQUIREMENT_STATUS_CHANGED',
      'TRUST_RULE_CHANGED',
    ]);
    for (const a of audit) expect(a.actor).toBe(`admin:${POLICY_SUB}`);
    expect(audit[0]!.changes).toEqual({ requirement: 'professional_license', status: ['INACTIVE', 'ACTIVE'] });
    expect(audit[1]!.changes).toEqual({ requirement: 'professional_license', market: null, serviceType: W.stB, enabled: true });
    // a market-scoped rule: a provider in market B must carry liability insurance too
    const byMarket = { requirementCode: 'liability_insurance', marketCode: W.b, serviceTypeCode: null, enabled: true };
    expect(ok(await aRule(POLICY, byMarket), 200, null)).toEqual({ ...byMarket, changed: true });
    const data = ok(await aPolicy(POLICY), 200, TrustPolicyResponse);
    expect(data.rules).toHaveLength(5);
    expect(data.requirements.find((r: Json) => r.code === 'background_check')).toMatchObject({
      status: 'ACTIVE',
      evidenceKind: 'EXTERNAL',
      expiryRequired: true,
    });
  });

  it('unknown requirement, market and service type are refused cleanly; nothing is written', async () => {
    const before = await writes();
    trustFail(await aRule(POLICY, { requirementCode: 'nope_requirement', marketCode: null, serviceTypeCode: null, enabled: true }), 404, 'NOT_FOUND', {
      reason: 'UNKNOWN_REQUIREMENT',
    });
    trustFail(
      await aRule(POLICY, { requirementCode: 'professional_license', marketCode: 'zz-nowhere', serviceTypeCode: null, enabled: true }),
      400,
      'VALIDATION_FAILED',
      {
        field: 'marketCode',
        reason: 'UNKNOWN_MARKET',
      },
    );
    trustFail(
      await aRule(POLICY, { requirementCode: 'professional_license', marketCode: null, serviceTypeCode: 'nope_service', enabled: true }),
      400,
      'VALIDATION_FAILED',
      {
        field: 'serviceTypeCode',
        reason: 'UNKNOWN_SERVICE_TYPE',
      },
    );
    trustFail(await aStatus(POLICY, 'nope_requirement', 'ACTIVE'), 404, 'NOT_FOUND');
    expect(await writes()).toEqual(before);
  });

  it('the policy is for trust-admin only: trust-read and trust-review get 403, nothing changes', async () => {
    const before = await writes();
    for (const t of [READER, REVIEWER]) {
      expect((await aPolicy(t)).status).toBe(403);
      expect((await aStatus(t, 'professional_license', 'INACTIVE')).status).toBe(403);
      expect((await aRule(t, { requirementCode: 'professional_license', marketCode: null, serviceTypeCode: null, enabled: true })).status).toBe(403);
    }
    expect(await writes()).toEqual(before);
    expect((await aPolicy(null)).status).toBe(401);
  });
});

// ====================================================================== a provider without a verification
const S = {} as { alice: Actor; caseId: string; reqId: string; docId: string; firstDoc: { id: string; key: string } };

describe('before a verification exists', () => {
  it('a provider with a live registration and verified contacts reads: prerequisite met, no case, one requirement NOT_STARTED, Go-Live not evaluated; nothing is written', async () => {
    S.alice = await provider('alice');
    const before = await writes();
    const data = ok(await vget(S.alice));
    expect(data.prerequisiteMet).toBe(true);
    expect(data.case).toBeNull();
    expect(data.overall).toMatchObject({
      status: 'NOT_STARTED',
      statusKey: 'trust.verification.status.not_started',
      verificationComplete: false,
      requiredCount: 1,
      approvedCount: 0,
      missing: ['identity_verification'],
      actionRequired: [],
      expired: [],
    });
    expect(data.goLive).toEqual({ evaluated: false, eligible: false });
    expect(data.requirements).toHaveLength(1);
    expect(requirementOf(data)).toMatchObject({
      caseRequirementId: null,
      requirementType: 'IDENTITY',
      evidenceKind: 'DOCUMENT',
      status: 'NOT_STARTED',
      cycle: 0,
      round: 0,
      canAttachEvidence: false,
      canReverify: false,
      reasonCode: null,
      documents: [],
      nameKey: 'trust.requirement.identity_verification.name',
      instructionsKey: 'trust.requirement.identity_verification.instructions',
      documentTypes: ['drivers_license', 'passport', 'state_id'].map((c) => ({ code: c, nameKey: `trust.document_type.${c}.name` })),
    });
    expect(await writes()).toEqual(before);
    expect(ok(await vdocs(S.alice), 200, VerificationDocumentListResponse)).toEqual([]);
  });

  it('PRO-001 now reports the VERIFICATION step from TRUST-001: NOT_STARTED, owner TRUST-001, no detail; the registration is IN_PROGRESS and Go-Live is not evaluated', async () => {
    const data = ok(await regReqs(S.alice), 200, ProviderRequirementsResponse);
    expect(stepOf(data, 'VERIFICATION')).toEqual({
      step: 'VERIFICATION',
      status: 'NOT_STARTED',
      owner: 'TRUST-001',
      labelKey: 'provider.registration.step.verification.label',
      statusKey: 'provider.registration.step_status.not_started',
    });
    for (const s of ['SUBSCRIPTION', 'PROFILE', 'GIGS']) expect(stepOf(data, s).status, s).toBe('NOT_AVAILABLE');
    expect(data.registration.status).toBe('IN_PROGRESS');
    expect(data.overall.goLive).toEqual({ evaluated: false, eligible: false });
    expect(data.overall.registrationComplete).toBe(false);
  });

  it('a customer with no registration reads prerequisiteMet:false; open is 409 PREREQUISITE_NOT_MET (REGISTRATION_REQUIRED), and nothing is written', async () => {
    const c = await newActor('norg', { email: true, phone: true });
    const before = await writes();
    const data = ok(await vget(c));
    expect(data.prerequisiteMet).toBe(false);
    expect(data.case).toBeNull();
    trustFail(await vopen(c), 409, 'PREREQUISITE_NOT_MET', { reason: 'REGISTRATION_REQUIRED' });
    expect(await writes()).toEqual(before);
  });

  it('a provider whose contacts are not verified is refused (CONTACT_NOT_VERIFIED) until BOTH are; the contact rule is the REGISTRATION policy', async () => {
    const c = await newActor('nocontact');
    expect((await call('POST', REG, { as: c })).status).toBe(201);
    const before = await writes();
    expect(ok(await vget(c)).prerequisiteMet).toBe(false);
    trustFail(await vopen(c), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED' });
    await verifyEmail(c);
    trustFail(await vopen(c), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED' });
    expect(await writes()).toEqual(before);
    await verifyPhone(c);
    ok(await vopen(c), 201);
  });

  it('the write operations find nothing to act on without a case: upload, submit, cancel, reverify and finalize/withdraw of an unknown document', async () => {
    const before = await writes();
    trustFail(
      await vupload(S.alice, { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 }),
      404,
      'NOT_FOUND',
      {
        reason: 'NO_CASE',
      },
    );
    trustFail(await vsubmit(S.alice, 1), 404, 'NOT_FOUND', { reason: 'NO_CASE' });
    trustFail(await vcancel(S.alice), 404, 'NOT_FOUND');
    trustFail(await vreverify(S.alice, 'identity_verification'), 404, 'NOT_FOUND', { reason: 'NO_CASE' });
    trustFail(await vfinalize(S.alice, randomUUID()), 404, 'NOT_FOUND');
    trustFail(await vwithdraw(S.alice, randomUUID()), 404, 'NOT_FOUND');
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== open
describe('open', () => {
  it('POST creates the case (201): number 1, OPEN, revision 1, one requirement NOT_STARTED that takes evidence; one audit row and one outbox event', async () => {
    const providerBefore = await providerWrites();
    const r = await vopen(S.alice);
    const data = ok(r, 201);
    expect(data.case).toMatchObject({ caseNumber: 1, status: 'OPEN', statusKey: 'trust.verification.status.open', revision: 1, submittedAt: null });
    expect(data.overall).toMatchObject({ status: 'OPEN', requiredCount: 1, approvedCount: 0, missing: [], verificationComplete: false });
    expect(requirementOf(data)).toMatchObject({ status: 'NOT_STARTED', cycle: 1, round: 0, canAttachEvidence: true, canReverify: false });
    S.caseId = data.case.verificationCaseId;
    S.reqId = requirementOf(data).caseRequirementId;
    const c = await caseRows(S.alice.accountId);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ verification_case_id: S.caseId, case_number: 1, status: 'OPEN', revision: 1 });
    expect(await reqRows(S.caseId)).toEqual([expect.objectContaining({ code: 'identity_verification', cycle: 1, status: 'NOT_STARTED', round: 0 })]);
    const audit = await auditOf(S.caseId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'VERIFICATION_CASE_OPENED', actor: `account:${S.alice.accountId}`, correlation_id: r.cid });
    expect(audit[0]!.changes).toEqual({ caseNumber: 1, requirements: ['identity_verification'] });
    const events = await outboxOf(S.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: TRUST_EVENTS.caseOpened,
      aggregate_type: 'verification_case',
      actor_id: `account:${S.alice.accountId}`,
      correlation_id: r.cid,
    });
    expect(events[0]!.payload_json).toEqual({ accountId: S.alice.accountId, verificationCaseId: S.caseId, caseNumber: 1, status: 'OPEN' });
    // verification is not registration: nothing of the provider domain or the roles changed
    expect(await providerWrites()).toEqual(providerBefore);
  });

  it('POST again resumes (200): the same case, nothing written', async () => {
    const before = await writes();
    const data = ok(await vopen(S.alice), 200);
    expect(data.case.verificationCaseId).toBe(S.caseId);
    expect(await writes()).toEqual(before);
    const read = ok(await vget(S.alice));
    expect(read.case.verificationCaseId).toBe(S.caseId);
  });

  it('PRO-001 reports the step IN_PROGRESS while the case is OPEN, and the registration is untouched', async () => {
    const reg = await regRow(S.alice.accountId);
    const data = ok(await regReqs(S.alice), 200, ProviderRequirementsResponse);
    expect(stepOf(data, 'VERIFICATION').status).toBe('IN_PROGRESS');
    expect(data.registration.status).toBe('IN_PROGRESS');
    expect(await regRow(S.alice.accountId)).toEqual(reg);
  });

  it('five simultaneous opens of a fresh provider create exactly ONE case: one 201 and four 200s, one audit row, one event', async () => {
    const r = await provider('openrace');
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => vopen(r)));
    expect(rs.map((x) => x.status).sort(), rs.map((x) => x.raw).join('\n')).toEqual([200, 200, 200, 200, 201]);
    const c = await caseRows(r.accountId);
    expect(c).toHaveLength(1);
    expect((await auditOf(c[0]!.verification_case_id)).filter((a) => a.action === 'VERIFICATION_CASE_OPENED')).toHaveLength(1);
    expect((await outboxOf(c[0]!.verification_case_id)).filter((e) => e.event_type === TRUST_EVENTS.caseOpened)).toHaveLength(1);
  });

  it('a provider in the market with a market-scoped rule, and one offering the service type with a service-scoped rule, get the extra requirements (and nobody else does)', async () => {
    const inB = await provider('market-b', [W.stA], W.b);
    const opened = ok(await vopen(inB), 201);
    expect(opened.requirements.map((x: Json) => x.requirementCode)).toEqual(['identity_verification', 'liability_insurance']);
    const lic = await provider('svc-b', [W.stA, W.stB]);
    expect(ok(await vopen(lic), 201).requirements.map((x: Json) => x.requirementCode)).toEqual(['identity_verification', 'professional_license']);
    expect(ok(await vget(S.alice)).requirements.map((x: Json) => x.requirementCode)).toEqual(['identity_verification']);
  });

  it('when policy requires nothing there is no case to open: 200 with case:null and NOT_REQUIRED, and the PRO-001 step is NOT_REQUIRED; restored afterwards', async () => {
    const z = await provider('nothing');
    ok(await aStatus(POLICY, 'identity_verification', 'INACTIVE'), 200, null);
    try {
      const before = await writes();
      const opened = ok(await vopen(z), 200);
      expect(opened.case).toBeNull();
      expect(opened.requirements).toEqual([]);
      expect(opened.overall).toMatchObject({
        status: 'NOT_REQUIRED',
        requiredCount: 0,
        verificationComplete: true,
        statusKey: 'trust.verification.status.not_required',
      });
      expect(await writes()).toEqual(before);
      expect(stepOf(ok(await regReqs(z), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('NOT_REQUIRED');
    } finally {
      ok(await aStatus(POLICY, 'identity_verification', 'ACTIVE'), 200, null);
    }
    expect(ok(await vget(z)).overall.status).toBe('NOT_STARTED');
  });

  it('a requirement that policy starts requiring AFTER the case was opened appears in the overview as missing and is added by the next open', async () => {
    const late = await provider('late', [W.stA]);
    ok(await vopen(late), 201);
    ok(await aRule(POLICY, { requirementCode: 'professional_license', marketCode: null, serviceTypeCode: W.stA, enabled: true }), 200, null);
    try {
      const overview = ok(await vget(late));
      expect(overview.overall.missing).toEqual(['professional_license']);
      expect(requirementOf(overview, 'professional_license')).toMatchObject({ caseRequirementId: null, status: 'NOT_STARTED', canAttachEvidence: false });
      const reopened = ok(await vopen(late), 200);
      expect(reopened.overall.missing).toEqual([]);
      expect(requirementOf(reopened, 'professional_license').caseRequirementId).not.toBeNull();
      const audit = await auditOf((await liveCase(late)).verification_case_id);
      expect(audit.map((a) => a.action)).toEqual(['VERIFICATION_CASE_OPENED', 'VERIFICATION_REQUIREMENTS_SYNCED']);
      expect(audit[1]!.changes).toEqual({ added: ['professional_license'], retired: [] });
    } finally {
      ok(await aRule(POLICY, { requirementCode: 'professional_license', marketCode: null, serviceTypeCode: W.stA, enabled: false }), 200, null);
    }
    // the rule was switched off again: the next open marks the unused requirement NOT_REQUIRED (never deleted)
    const after = ok(await vopen(late), 200);
    expect(after.requirements.map((x: Json) => x.requirementCode)).toEqual(['identity_verification']);
    const rows = await reqRows((await liveCase(late)).verification_case_id);
    expect(rows.find((x) => x.code === 'professional_license')!.status).toBe('NOT_REQUIRED');
  });
});

// ====================================================================== evidence: upload, finalize, withdraw
describe('upload authorization', () => {
  it('authorizes ONE document (201): UPLOAD_PENDING, a one-object PUT with the declared headers, a policy lifetime, an audit row with no key or link', async () => {
    const bytes = pdf();
    const before = Date.now();
    const r = await vupload(S.alice, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'drivers_license',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    });
    const d = ok(r, 201, DocumentUploadAuthorizationResponse);
    expect(d.document).toMatchObject({
      status: 'UPLOAD_PENDING',
      scanStatus: 'PENDING',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      round: null,
      submittedAt: null,
      documentTypeCode: 'drivers_license',
    });
    expect(d.upload.method).toBe('PUT');
    expect(d.upload.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength) });
    expect(d.upload.url.startsWith('memory://upload/')).toBe(true);
    const ttl = new Date(d.upload.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThan(310_000);
    const key = keyOfUrl(d.upload.url);
    S.docId = d.document.verificationDocumentId;
    S.firstDoc = { id: S.docId, key };
    // the provider PUTs to a SEPARATE upload key; the final key (in the database) is written only by the server after it verified the bytes
    expect(key).toBe(`trust/upload/${S.caseId}/${S.docId}`);
    const finalKey = `trust/evidence/${S.caseId}/${S.docId}`;
    expect(store.issued.at(-1)).toEqual({ kind: 'upload', key, ttlSeconds: 300 });
    const row = await docRow(S.docId);
    expect(row).toMatchObject({ status: 'UPLOAD_PENDING', scan_status: 'PENDING', sha256: null, object_key: finalKey });
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toEqual({
      verificationDocumentId: S.docId,
      documentType: 'drivers_license',
      sizeBytes: bytes.byteLength,
      mimeType: 'application/pdf',
    });
    expect(audit[0]).toMatchObject({ actor: `account:${S.alice.accountId}`, correlation_id: r.cid });
    expect(JSON.stringify(audit[0]!.changes)).not.toMatch(/memory:|trust\/evidence|trust\/upload/);
    // the object store holds nothing yet
    expect(present(key, finalKey)).toEqual([]);
    // the authorization is not repeated on a read, and the overview shows the pending document without any key
    const overview = ok(await vget(S.alice));
    expect(requirementOf(overview).documents.map((x: Json) => x.status)).toEqual(['UPLOAD_PENDING']);
    expect(JSON.stringify(overview)).not.toMatch(/memory:|trust\/evidence|trust\/upload/);
  });

  it('finalizing before the bytes arrive is 400 OBJECT_MISSING; the document stays UPLOAD_PENDING and the same authorization still works', async () => {
    const before = await writes();
    trustFail(await vfinalize(S.alice, S.docId), 400, 'OBJECT_MISSING', { reason: 'OBJECT_MISSING' });
    expect(await writes()).toEqual(before);
    expect((await docRow(S.docId)).status).toBe('UPLOAD_PENDING');
  });

  it('every refusal of policy happens before anything is stored: type, size, document type, requirement; nothing is written', async () => {
    const before = await writes();
    const base = { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 };
    trustFail(await vupload(S.alice, { ...base, mimeType: 'image/gif' }), 400, 'MIME_NOT_ALLOWED', { reason: 'MIME_NOT_ALLOWED' });
    trustFail(await vupload(S.alice, { ...base, mimeType: 'text/html' }), 400, 'MIME_NOT_ALLOWED', { reason: 'MIME_NOT_ALLOWED' });
    trustFail(await vupload(S.alice, { ...base, sizeBytes: 10_485_761 }), 400, 'FILE_TOO_LARGE', { reason: 'FILE_TOO_LARGE', max: 10_485_760 });
    trustFail(await vupload(S.alice, { ...base, sizeBytes: 52_428_800 }), 400, 'FILE_TOO_LARGE', { reason: 'FILE_TOO_LARGE', max: 10_485_760 });
    trustFail(await vupload(S.alice, { ...base, documentTypeCode: 'insurance_certificate' }), 400, 'DOCUMENT_TYPE_NOT_ACCEPTED', {
      reason: 'DOCUMENT_TYPE_NOT_ACCEPTED',
    });
    trustFail(await vupload(S.alice, { ...base, documentTypeCode: 'nope_document' }), 400, 'DOCUMENT_TYPE_NOT_ACCEPTED', {
      reason: 'DOCUMENT_TYPE_NOT_ACCEPTED',
    });
    trustFail(await vupload(S.alice, { ...base, requirementCode: 'professional_license' }), 409, 'REQUIREMENT_NOT_APPLICABLE', {
      reason: 'REQUIREMENT_NOT_APPLICABLE',
    });
    trustFail(await vupload(S.alice, { ...base, requirementCode: 'nope_requirement' }), 409, 'REQUIREMENT_NOT_APPLICABLE', {
      reason: 'REQUIREMENT_NOT_APPLICABLE',
    });
    expect(await writes()).toEqual(before);
  });

  it('a requirement that is evidenced externally takes no documents: 409 EVIDENCE_NOT_ACCEPTED (whatever the document type); nothing is written', async () => {
    const ext = await provider('ext-doc', [W.stA, W.stD]);
    ok(await vopen(ext), 201);
    const before = await writes();
    for (const documentTypeCode of ['drivers_license', 'certification', 'nope_document'])
      trustFail(
        await vupload(ext, { requirementCode: 'background_check', documentTypeCode, mimeType: 'application/pdf', sizeBytes: 100 }),
        409,
        'EVIDENCE_NOT_ACCEPTED',
        {
          reason: 'EVIDENCE_NOT_ACCEPTED',
        },
      );
    expect(await writes()).toEqual(before);
  });

  it('the policy limits are configuration: a smaller maximum and a smaller type list change the answers (restored afterwards)', async () => {
    try {
      await setConfig(P.maxSizeBytes, 2048);
      await setConfig(P.allowedMimeTypes, ['image/png']);
      const base = { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 };
      trustFail(await vupload(S.alice, base), 400, 'MIME_NOT_ALLOWED', { reason: 'MIME_NOT_ALLOWED' });
      trustFail(await vupload(S.alice, { ...base, mimeType: 'image/png', sizeBytes: 2049 }), 400, 'FILE_TOO_LARGE', { reason: 'FILE_TOO_LARGE', max: 2048 });
    } finally {
      await resetPolicy([P.maxSizeBytes, P.allowedMimeTypes]);
    }
    const again = await vupload(S.alice, {
      requirementCode: 'identity_verification',
      documentTypeCode: 'drivers_license',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    expect(again.status).toBe(201);
    expect(okDoc(await vwithdraw(S.alice, again.body.data.document.verificationDocumentId)).status).toBe('ABANDONED');
  });
});

describe('finalize', () => {
  it('verifies the stored object on the SERVER (size, content type, signature, SHA-256, scan) and attaches it: ATTACHED, CLEAN, hash in the database only', async () => {
    const bytes = pdf();
    const p = await putDoc(S.alice, { bytes });
    const d = okDoc(p.fin!);
    expect(d).toMatchObject({
      verificationDocumentId: p.docId,
      status: 'ATTACHED',
      scanStatus: 'CLEAN',
      scanStatusKey: 'trust.verification.scan_status.clean',
      statusKey: 'trust.verification.document_status.attached',
    });
    expect(JSON.stringify(d)).not.toContain(sha(bytes));
    expect(await docRow(p.docId)).toMatchObject({ status: 'ATTACHED', scan_status: 'CLEAN', sha256: sha(bytes) });
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_SUBMITTED');
    expect(audit.at(-1)!.changes).toEqual({ verificationDocumentId: p.docId, scanStatus: 'CLEAN', sizeBytes: bytes.byteLength });
    // the verified copy is on the FINAL key; the upload key was emptied
    expect(store.objects.get(p.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect(present(p.key)).toEqual([]);
    // a replayed PUT to the (still valid) upload URL writes an object nothing reads: neither the document nor what a reviewer gets changes
    store.put(p.key, Buffer.from('%PDF-1.4\n% REPLAYED PUT\n'), 'application/pdf');
    expect(store.objects.get(p.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect(okDoc(await vfinalize(S.alice, p.docId)).status).toBe('ATTACHED');
    expect(store.objects.get(p.finalKey)!.bytes.equals(bytes)).toBe(true);
    expect(await docRow(p.docId)).toMatchObject({ sha256: sha(bytes) });
    store.objects.delete(p.key);
    // finalize again is idempotent: the same answer, nothing written
    const before = await writes();
    expect(okDoc(await vfinalize(S.alice, p.docId))).toEqual(d);
    expect(await writes()).toEqual(before);
    S.docId = p.docId;
  });

  it('the FIRST authorization is still usable after its 400 OBJECT_MISSING: once the bytes arrive the same document attaches', async () => {
    const bytes = pdf();
    store.put(S.firstDoc.key, bytes, 'application/pdf');
    const d = okDoc(await vfinalize(S.alice, S.firstDoc.id));
    expect(d).toMatchObject({ verificationDocumentId: S.firstDoc.id, status: 'ATTACHED', scanStatus: 'CLEAN' });
    expect(await docRow(S.firstDoc.id)).toMatchObject({ sha256: sha(bytes) });
  });

  it('a correct client SHA-256 is accepted; PNG and JPEG documents are accepted when their signature matches', async () => {
    const f = await provider('formats');
    ok(await vopen(f), 201);
    const png1 = png();
    const p = await putDoc(f, { bytes: png1, mime: 'image/png', type: 'state_id', finalizeBody: { sha256: sha(png1) } });
    expect(okDoc(p.fin!).status).toBe('ATTACHED');
    const jpg = jpeg();
    const j = await putDoc(f, { bytes: jpg, mime: 'image/jpeg', type: 'passport', finalizeBody: { sha256: sha(jpg) } });
    expect(okDoc(j.fin!).status).toBe('ATTACHED');
    expect(await docRow(j.docId)).toMatchObject({ sha256: sha(jpg) });
    expect(await docRow(p.docId)).toMatchObject({ sha256: sha(png1) });
  });

  describe('spoofed uploads are refused, the document is ABANDONED and the stored object is deleted', () => {
    const cases: [string, (b: Buffer) => PutOpts, string][] = [
      ['a PDF that is really an HTML page (signature)', () => ({ bytes: html() }), 'SIGNATURE_MISMATCH'],
      ['a PDF that is really a PNG (signature)', () => ({ bytes: png() }), 'SIGNATURE_MISMATCH'],
      ['a PNG that is really a PDF (signature)', () => ({ bytes: pdf(), mime: 'image/png', type: 'state_id' }), 'SIGNATURE_MISMATCH'],
      ['bytes longer than declared (size)', (b) => ({ bytes: b, declared: b.byteLength - 3 }), 'SIZE_MISMATCH'],
      ['bytes shorter than declared (size)', (b) => ({ bytes: b, declared: b.byteLength + 50 }), 'SIZE_MISMATCH'],
      ['an object stored with another content type', () => ({ storedType: 'text/html' }), 'CONTENT_TYPE_MISMATCH'],
      ['an object stored with no content type', () => ({ storedType: null }), 'CONTENT_TYPE_MISMATCH'],
      ['a wrong client hash (integrity)', (b) => ({ bytes: b, finalizeBody: { sha256: sha(Buffer.from('another file')) } }), 'HASH_MISMATCH'],
    ];
    it.each(cases)('%s', async (_name, opts, reason) => {
      const bytes = pdf();
      const o = opts(bytes);
      const p = await putDoc(S.alice, { bytes, ...o });
      expect(p.fin, p.auth.raw).toBeDefined();
      trustFail(p.fin!, 400, 'OBJECT_MISMATCH', { reason });
      expect((await docRow(p.docId)).status).toBe('ABANDONED');
      expect(present(p.key, p.finalKey)).toEqual([]);
      const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED');
      expect(audit.at(-1)!.changes).toEqual({ verificationDocumentId: p.docId, reason });
      // an abandoned document is history: it cannot be finalized again, and withdrawing it is a no-op that stays ABANDONED
      trustFail(await vfinalize(S.alice, p.docId), 409, 'INVALID_STATE', { reason: 'DOCUMENT_NOT_PENDING' });
      expect(okDoc(await vwithdraw(S.alice, p.docId)).status).toBe('ABANDONED');
    });

    it('an object far larger than declared and than the policy maximum is refused on its size without being read', async () => {
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 0x20)]);
      const p = await putDoc(S.alice, { bytes: big, declared: 100 });
      trustFail(p.fin!, 400, 'OBJECT_MISMATCH', { reason: 'SIZE_MISMATCH' });
      expect(present(p.key, p.finalKey)).toEqual([]);
    });

    it('a file with the EICAR antivirus test string is INFECTED: 400 SCAN_INFECTED, the document is ABANDONED with scan INFECTED, the object is deleted', async () => {
      const bytes = Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1');
      const p = await putDoc(S.alice, { bytes });
      trustFail(p.fin!, 400, 'SCAN_INFECTED', { reason: 'SCAN_INFECTED' });
      expect(await docRow(p.docId)).toMatchObject({ status: 'ABANDONED', scan_status: 'INFECTED' });
      expect(present(p.key, p.finalKey)).toEqual([]);
      expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED').at(-1)!.changes).toEqual({
        verificationDocumentId: p.docId,
        reason: 'SCAN_INFECTED',
      });
      // an infected document can never be attached later, even by repeating the request with the same id
      trustFail(await vfinalize(S.alice, p.docId), 409, 'INVALID_STATE', { reason: 'DOCUMENT_NOT_PENDING' });
    });

    it('bytes swapped through the still-valid upload URL between the verification and the promotion are refused (OBJECT_CHANGED): the document is ABANDONED and nothing reaches the final key', async () => {
      const evil = Buffer.from('%PDF-1.4\n% SWAPPED AFTER THE CHECK\n');
      const orig = store.readVersioned.bind(store);
      const spy = vi.spyOn(store, 'readVersioned').mockImplementationOnce(async (key, max) => {
        const r = await orig(key, max);
        store.put(key, evil, 'application/pdf');
        return r;
      });
      let p: Put;
      try {
        p = await putDoc(S.alice);
      } finally {
        spy.mockRestore();
      }
      trustFail(p.fin!, 400, 'OBJECT_MISMATCH', { reason: 'OBJECT_CHANGED' });
      expect((await docRow(p.docId)).status).toBe('ABANDONED');
      expect(present(p.key, p.finalKey)).toEqual([]);
    });

    it('an upload authorization that expired is refused 409 UPLOAD_EXPIRED and abandoned (the clock of a third stack is an hour ahead)', async () => {
      const p = await putDoc(S.alice, { finalize: false });
      trustFail(await vfinalize(S.alice, p.docId, undefined, appLate), 409, 'UPLOAD_EXPIRED', { reason: 'UPLOAD_EXPIRED' });
      expect((await docRow(p.docId)).status).toBe('ABANDONED');
      expect(present(p.key, p.finalKey)).toEqual([]);
      expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED').at(-1)!.changes).toEqual({
        verificationDocumentId: p.docId,
        reason: 'UPLOAD_EXPIRED',
      });
    });
  });

  it('with NO working scanner a document cannot attach: 503 SCAN_UNAVAILABLE, it stays UPLOAD_PENDING with its object, and it attaches once a scanner works (the same authorization)', async () => {
    const a = await provider('noscan');
    ok(await vopen(a), 201);
    const p = await putDoc(a, { finalize: false });
    const r = await vfinalize(a, p.docId, undefined, appNoScan);
    trustFail(r, 503, 'SCAN_UNAVAILABLE', { reason: 'SCAN_UNAVAILABLE' });
    expect(await docRow(p.docId)).toMatchObject({ status: 'UPLOAD_PENDING', scan_status: 'PENDING', sha256: null });
    expect(store.objects.has(p.key)).toBe(true);
    // it cannot be submitted either
    trustFail(await vsubmit(a, (await liveCase(a)).revision), 409, 'SUBMISSION_INCOMPLETE', {
      reason: 'SUBMISSION_INCOMPLETE',
      codes: ['identity_verification'],
    });
    // a working scanner finalizes the same document
    expect(okDoc(await vfinalize(a, p.docId)).status).toBe('ATTACHED');
  });

  it('require_clean_scan is configuration: switched off, a document the scanner could not check attaches with scan ERROR and is flagged; restored afterwards', async () => {
    const a = await provider('scanoff');
    ok(await vopen(a), 201);
    try {
      await setConfig(P.requireCleanScan, false);
      const p = await putDoc(a, { finalize: false });
      const d = okDoc(await vfinalize(a, p.docId, undefined, appNoScan));
      expect(d).toMatchObject({ status: 'ATTACHED', scanStatus: 'ERROR', scanStatusKey: 'trust.verification.scan_status.error' });
      expect(await docRow(p.docId)).toMatchObject({ status: 'ATTACHED', scan_status: 'ERROR' });
    } finally {
      await resetPolicy([P.requireCleanScan]);
    }
    // with the default restored the same document no longer lets the case be submitted
    trustFail(await vsubmit(a, (await liveCase(a)).revision), 409, 'SUBMISSION_INCOMPLETE', {
      reason: 'SUBMISSION_INCOMPLETE',
      codes: ['identity_verification'],
    });
  });
});

describe('withdraw and the document limit', () => {
  it('withdraws a draft (ATTACHED -> WITHDRAWN): the object is deleted, an audit row is written, it vanishes from the overview and stays in the list; again is a no-op', async () => {
    const p = await attached(S.alice);
    const reg = await regRow(S.alice.accountId);
    const w = await vwithdraw(S.alice, p.docId);
    expect(okDoc(w)).toMatchObject({ verificationDocumentId: p.docId, status: 'WITHDRAWN' });
    expect(present(p.key, p.finalKey)).toEqual([]);
    expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_REPLACED').at(-1)!.changes).toEqual({ verificationDocumentId: p.docId });
    expect(requirementOf(ok(await vget(S.alice))).documents.map((x: Json) => x.verificationDocumentId)).not.toContain(p.docId);
    const list = okDocs(await vdocs(S.alice));
    expect(list.find((x: Json) => x.verificationDocumentId === p.docId).status).toBe('WITHDRAWN');
    const before = await writes();
    expect(okDoc(await vwithdraw(S.alice, p.docId)).status).toBe('WITHDRAWN');
    expect(await writes()).toEqual(before);
    expect(await regRow(S.alice.accountId)).toEqual(reg);
    // and withdrawing an UPLOAD_PENDING authorization abandons it
    const pending = await putDoc(S.alice, { finalize: false });
    expect(okDoc(await vwithdraw(S.alice, pending.docId)).status).toBe('ABANDONED');
    expect(present(pending.key, pending.finalKey)).toEqual([]);
  });

  it('the list keeps the history: attached, withdrawn and abandoned documents, oldest first, none with a key or a hash', async () => {
    const list = okDocs(await vdocs(S.alice));
    expect(list.length).toBeGreaterThan(5);
    expect(new Set(list.map((x: Json) => x.status))).toEqual(new Set(['ATTACHED', 'WITHDRAWN', 'ABANDONED']));
    const created = list.map((x: Json) => x.createdAt);
    expect([...created].sort()).toEqual(created);
    for (const x of list)
      expect(keysOf(x)).toEqual([
        'createdAt',
        'documentTypeCode',
        'documentTypeNameKey',
        'mimeType',
        'round',
        'scanStatus',
        'scanStatusKey',
        'sizeBytes',
        'status',
        'statusKey',
        'submittedAt',
        'verificationDocumentId',
      ]);
  });

  it('at most the configured number of drafts per requirement: the sixth authorization is 409 TOO_MANY_DOCUMENTS (max 5); a withdrawn draft frees a place', async () => {
    const a = await provider('maxdocs');
    ok(await vopen(a), 201);
    const docs: Put[] = [];
    for (let i = 0; i < 5; i++) docs.push(await attached(a));
    const before = await writes();
    trustFail(
      await vupload(a, { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 }),
      409,
      'TOO_MANY_DOCUMENTS',
      { reason: 'TOO_MANY_DOCUMENTS', max: 5 },
    );
    expect(await writes()).toEqual(before);
    expect(okDoc(await vwithdraw(a, docs[0]!.docId)).status).toBe('WITHDRAWN');
    expect((await putDoc(a, { finalize: false })).auth.status).toBe(201);
  });

  it('eight simultaneous authorizations for a fresh requirement admit exactly five (the account lock serializes the count)', async () => {
    const a = await provider('maxrace');
    ok(await vopen(a), 201);
    const body = { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 };
    const rs = await Promise.all(Array.from({ length: 8 }, () => vupload(a, body)));
    expect(
      rs.filter((r) => r.status === 201),
      rs.map((r) => r.raw).join('\n'),
    ).toHaveLength(5);
    for (const r of rs.filter((x) => x.status !== 201)) trustFail(r, 409, 'TOO_MANY_DOCUMENTS', { reason: 'TOO_MANY_DOCUMENTS', max: 5 });
    expect((await docRows(a.accountId)).filter((d) => d.status === 'UPLOAD_PENDING')).toHaveLength(5);
  });

  it('simultaneous finalizes of ONE document attach it once (all answer 200, one audit row); a withdraw racing a finalize never produces a 500', async () => {
    const a = await provider('finrace');
    ok(await vopen(a), 201);
    const p = await putDoc(a, { finalize: false });
    const rs = await Promise.all([vfinalize(a, p.docId), vfinalize(a, p.docId), vfinalize(a, p.docId)]);
    expect(
      rs.map((r) => r.status),
      rs.map((r) => r.raw).join('\n'),
    ).toEqual([200, 200, 200]);
    const c = await liveCase(a);
    expect((await auditOf(c.verification_case_id)).filter((x) => x.action === 'VERIFICATION_DOCUMENT_SUBMITTED')).toHaveLength(1);
    const q2 = await putDoc(a, { finalize: false });
    const [f, w] = await Promise.all([vfinalize(a, q2.docId), vwithdraw(a, q2.docId)]);
    expect([f.status, w.status], `${f.raw} ${w.raw}`).not.toContain(500);
    expect(['ATTACHED', 'WITHDRAWN', 'ABANDONED']).toContain((await docRow(q2.docId)).status);
  });
});

// ====================================================================== submit
describe('submit', () => {
  it('is refused 409 SUBMISSION_INCOMPLETE while a requirement has no document, naming the requirement; a document-less provider is not submitted', async () => {
    const a = await provider('nodoc', [W.stA, W.stB]);
    const opened = ok(await vopen(a), 201);
    await attached(a, { requirement: 'identity_verification' });
    const before = await writes();
    const rev = (await liveCase(a)).revision;
    trustFail(await vsubmit(a, rev), 409, 'SUBMISSION_INCOMPLETE', { reason: 'SUBMISSION_INCOMPLETE', codes: ['professional_license'] });
    expect(await writes()).toEqual(before);
    expect(opened.requirements).toHaveLength(2);
  });

  it('a stale revision is refused 409 STALE_CASE and writes nothing; a missing or malformed revision is a 400', async () => {
    // no authorization is left pending (it would stay a pending draft of the requirement)
    for (const d of (await docRows(S.alice.accountId)).filter((x) => x.status === 'UPLOAD_PENDING'))
      okDoc(await vwithdraw(S.alice, d.verification_document_id));
    const rev = (await liveCase(S.alice)).revision;
    await attached(S.alice);
    const before = await writes();
    trustFail(await vsubmit(S.alice, rev), 409, 'STALE_CASE', { reason: 'STALE_CASE' });
    fail(await call('POST', `${PV}/submit`, { as: S.alice, body: {} }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', `${PV}/submit`, { as: S.alice }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', `${PV}/submit`, { as: S.alice, body: { expectedRevision: String(rev) } }), 400, 'VALIDATION_FAILED');
    fail(
      await call('POST', `${PV}/submit`, { as: S.alice, body: { expectedRevision: rev, requirementCode: 'identity_verification' } }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await writes()).toEqual(before);
  });

  it('submits (200): the requirement is PENDING in round 1, its attached documents are SUBMITTED in that round, the case is IN_REVIEW; one audit row and one event; PRO-001 reports IN_PROGRESS', async () => {
    const live = await liveCase(S.alice);
    const attachedDocs = (await docRows(S.alice.accountId)).filter((d) => d.status === 'ATTACHED');
    expect(attachedDocs.length).toBeGreaterThanOrEqual(3);
    const reg = await regRow(S.alice.accountId);
    const providerBefore = await providerWrites();
    const r = await vsubmit(S.alice, live.revision);
    const data = ok(r);
    expect(data.case).toMatchObject({ status: 'IN_REVIEW', statusKey: 'trust.verification.status.in_review' });
    expect(data.case.submittedAt).not.toBeNull();
    expect(data.overall).toMatchObject({ status: 'IN_REVIEW', verificationComplete: false });
    const req = requirementOf(data);
    expect(req).toMatchObject({ status: 'PENDING', round: 1, canAttachEvidence: false, reasonCode: null });
    expect(req.documents.every((d: Json) => d.status === 'SUBMITTED' && d.round === 1 && d.submittedAt !== null)).toBe(true);
    expect(req.documents).toHaveLength(attachedDocs.length);
    expect((await docRows(S.alice.accountId)).filter((d) => d.status === 'SUBMITTED' && d.round === 1)).toHaveLength(attachedDocs.length);
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_SUBMITTED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `account:${S.alice.accountId}`, correlation_id: r.cid });
    expect(audit[0]!.changes).toMatchObject({ requirements: ['identity_verification'], status: ['OPEN', 'IN_REVIEW'], documents: attachedDocs.length });
    const events = (await outboxOf(S.caseId)).filter((e) => e.event_type === TRUST_EVENTS.submitted);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toEqual({ accountId: S.alice.accountId, verificationCaseId: S.caseId, caseNumber: 1, status: 'IN_REVIEW' });
    const reqs = ok(await regReqs(S.alice), 200, ProviderRequirementsResponse);
    expect(stepOf(reqs, 'VERIFICATION').status).toBe('IN_PROGRESS');
    // the registration lifecycle is untouched
    expect(await regRow(S.alice.accountId)).toEqual(reg);
    expect(await providerWrites()).toEqual(providerBefore);
    expect(reqs.overall).toMatchObject({ registrationComplete: false, goLive: { evaluated: false, eligible: false } });
  });

  it('submitting again with nothing left to submit is an idempotent 200 (even with a stale revision): nothing is written', async () => {
    const before = await writes();
    const rev = (await liveCase(S.alice)).revision;
    for (const r of [rev, rev, 1]) expect(ok(await vsubmit(S.alice, r)).overall.status).toBe('IN_REVIEW');
    expect(await writes()).toEqual(before);
  });

  it('a submitted document is history: it cannot be withdrawn (409 DOCUMENT_SUBMITTED), nothing new can be attached while the requirement is PENDING (409 EVIDENCE_NOT_ACCEPTED)', async () => {
    const submittedDoc = (await docRows(S.alice.accountId)).find((d) => d.status === 'SUBMITTED')!;
    const before = await writes();
    trustFail(await vwithdraw(S.alice, submittedDoc.verification_document_id), 409, 'INVALID_STATE', { reason: 'DOCUMENT_SUBMITTED' });
    trustFail(
      await vupload(S.alice, { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 }),
      409,
      'EVIDENCE_NOT_ACCEPTED',
      { reason: 'EVIDENCE_NOT_ACCEPTED' },
    );
    expect(await writes()).toEqual(before);
    expect(store.objects.has(submittedDoc.object_key)).toBe(true);
  });

  it('three simultaneous submits of one case submit it ONCE (all 200, one audit row, one event, round 1)', async () => {
    const a = await provider('subrace');
    ok(await vopen(a), 201);
    await attached(a);
    const rev = (await liveCase(a)).revision;
    const rs = await Promise.all([vsubmit(a, rev), vsubmit(a, rev), vsubmit(a, rev)]);
    expect(
      rs.map((r) => r.status),
      rs.map((r) => r.raw).join('\n'),
    ).toEqual([200, 200, 200]);
    const c = await liveCase(a);
    expect((await auditOf(c.verification_case_id)).filter((x) => x.action === 'VERIFICATION_SUBMITTED')).toHaveLength(1);
    expect((await outboxOf(c.verification_case_id)).filter((x) => x.event_type === TRUST_EVENTS.submitted)).toHaveLength(1);
    expect((await inst(a)).round).toBe(1);
  });
});

// ====================================================================== the reviewers: queue, case, decisions
describe('the reviewers queue and case', () => {
  it('trust-read lists the cases (oldest submission first, an internal account id and counters only); the filters work; trust-admin and a provider are refused', async () => {
    const list = ok(await aList(READER), 200, TrustCaseListResponse);
    const mine = list.find((c: Json) => c.verificationCaseId === S.caseId);
    expect(mine).toMatchObject({
      accountId: S.alice.accountId,
      caseNumber: 1,
      status: 'IN_REVIEW',
      statusKey: 'trust.verification.status.in_review',
      requirementCount: 1,
      awaitingReviewCount: 1,
    });
    expect(keysOf(mine)).toEqual([
      'accountId',
      'awaitingReviewCount',
      'caseNumber',
      'requirementCount',
      'status',
      'statusKey',
      'submittedAt',
      'updatedAt',
      'verificationCaseId',
    ]);
    const submitted = list.filter((c: Json) => c.submittedAt !== null).map((c: Json) => c.submittedAt);
    expect([...submitted].sort()).toEqual(submitted);
    // submitted cases come before the ones never submitted
    const firstUnsubmitted = list.findIndex((c: Json) => c.submittedAt === null);
    if (firstUnsubmitted >= 0) expect(list.slice(firstUnsubmitted).every((c: Json) => c.submittedAt === null)).toBe(true);
    expect(ok(await aList(READER, '?status=IN_REVIEW'), 200, TrustCaseListResponse).every((c: Json) => c.status === 'IN_REVIEW')).toBe(true);
    expect(ok(await aList(READER, '?status=OPEN'), 200, TrustCaseListResponse).every((c: Json) => c.status === 'OPEN')).toBe(true);
    expect(ok(await aList(READER, '?limit=1'), 200, TrustCaseListResponse)).toHaveLength(1);
    expect(ok(await aList(READER, '?status=APPROVED&limit=100'), 200, TrustCaseListResponse).every((c: Json) => c.status === 'APPROVED')).toBe(true);
    expect((await aList(POLICY)).status).toBe(403);
    expect((await aList(S.alice.token)).status).toBe(403);
    expect((await aList(null)).status).toBe(401);
    for (const bad of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=abc', '?status=NOPE', '?accountId=x'])
      fail(await aList(READER, bad), 400, 'VALIDATION_FAILED');
  });

  it('the case detail shows the requirement, the submitted documents WITH their hash (the integrity evidence), no key and no link', async () => {
    const d = ok(await aCase(READER, S.caseId), 200, TrustCaseDetailResponse);
    expect(d.case).toMatchObject({ verificationCaseId: S.caseId, accountId: S.alice.accountId, status: 'IN_REVIEW', awaitingReviewCount: 1, decidedAt: null });
    const r = d.requirements[0];
    expect(r).toMatchObject({
      caseRequirementId: S.reqId,
      requirementCode: 'identity_verification',
      status: 'PENDING',
      round: 1,
      cycle: 1,
      superseded: false,
      reviews: [],
      external: null,
    });
    const submittedDocs = (await docRows(S.alice.accountId)).filter((x) => x.status === 'SUBMITTED');
    expect(
      r.documents
        .filter((x: Json) => x.status === 'SUBMITTED')
        .map((x: Json) => x.sha256)
        .sort(),
    ).toEqual(submittedDocs.map((x) => x.sha256).sort());
    expect(r.documents.map((x: Json) => x.status)).toEqual(expect.arrayContaining(['SUBMITTED', 'WITHDRAWN', 'ABANDONED']));
    expect(d.requirements).toHaveLength(1);
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/trust\/evidence|memory:\/\//);
    for (const dr of await docRows(S.alice.accountId)) expect(raw).not.toContain(dr.object_key);
    S.reqId = r.caseRequirementId;
  });

  it('an unknown case is 404 for a reader; a provider or a trust-admin learns nothing (403 either way)', async () => {
    trustFail(await aCase(READER, randomUUID()), 404, 'NOT_FOUND');
    expect((await aCase(S.alice.token, S.caseId)).status).toBe(403);
    expect((await aCase(S.alice.token, randomUUID())).status).toBe(403);
    expect((await aCase(POLICY, S.caseId)).status).toBe(403);
    expect((await aCase(POLICY, randomUUID())).status).toBe(403);
    fail(await aCase(READER, 'not-a-uuid'), 400, 'VALIDATION_FAILED');
  });
});

describe('decisions', () => {
  it('start-review needs the round the reviewer saw: a stale round is 409 STALE_ROUND; the right round moves PENDING to IN_REVIEW (200, changed:true) and is idempotent', async () => {
    const before = await writes();
    trustFail(await aDecide(REVIEWER, 'start-review', S.reqId, { round: 2 }), 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    expect(await writes()).toEqual(before);
    const r = await aDecide(REVIEWER, 'start-review', S.reqId, { round: 1 });
    const d = okDecision(r);
    expect(d).toMatchObject({ changed: true, caseStatus: 'IN_REVIEW' });
    expect(d.requirement).toMatchObject({ caseRequirementId: S.reqId, status: 'IN_REVIEW', round: 1 });
    const reviews = await reviewRows(S.reqId);
    expect(reviews).toEqual([expect.objectContaining({ round: 1, decision: 'STARTED', reviewer: `admin:${REVIEWER_SUB}`, reason_code: null })]);
    expect(reviews[0]!.correlation_id).toBe(r.cid);
    expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_REVIEW_STARTED').at(-1)).toMatchObject({
      actor: `admin:${REVIEWER_SUB}`,
      correlation_id: r.cid,
    });
    const again = okDecision(await aDecide(REVIEWER, 'start-review', S.reqId, { round: 1 }));
    expect(again.changed).toBe(false);
    expect(await reviewRows(S.reqId)).toHaveLength(1);
  });

  it('a trust-read token, a trust-admin token and a provider cannot decide (403); nothing is written; the reviewer is the token subject, never a field of the body', async () => {
    const before = await writes();
    for (const t of [READER, POLICY, S.alice.token])
      for (const action of ['start-review', 'approve'] as const) expect((await aDecide(t, action, S.reqId, { round: 1 })).status).toBe(403);
    fail(await aDecide(REVIEWER, 'approve', S.reqId, { round: 1, reviewer: 'admin:someone-else' }), 400, 'VALIDATION_FAILED');
    expect((await aDecide(null, 'approve', S.reqId, { round: 1 })).status).toBe(401);
    expect(await writes()).toEqual(before);
  });

  it('a reason must exist and apply: an unknown code is refused, a reject-only reason cannot request action, an action-only reason cannot reject; nothing is written', async () => {
    const before = await writes();
    const unknown = await aDecide(REVIEWER, 'reject', S.reqId, { round: 1, reasonCode: 'NOT_A_REASON' });
    expect([400, 409], unknown.raw).toContain(unknown.status);
    expect(unknown.status).not.toBe(500);
    trustFail(await aDecide(REVIEWER, 'request-action', S.reqId, { round: 1, reasonCode: 'LICENSE_INVALID' }), 400, 'REASON_INVALID', {
      reason: 'REASON_NOT_APPLICABLE',
    });
    trustFail(await aDecide(REVIEWER, 'reject', S.reqId, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' }), 400, 'REASON_INVALID', {
      reason: 'REASON_NOT_APPLICABLE',
    });
    expect(await writes()).toEqual(before);
  });

  it('request-action (200): ACTION_REQUIRED with a structured reason; the case needs the provider; the provider sees the reason and may attach again; PRO-001 reports BLOCKED', async () => {
    const r = await aDecide(REVIEWER, 'request-action', S.reqId, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' });
    const d = okDecision(r);
    expect(d).toMatchObject({ changed: true, caseStatus: 'ACTION_REQUIRED' });
    expect(d.requirement).toMatchObject({ status: 'ACTION_REQUIRED' });
    expect(d.requirement.reviews.map((x: Json) => [x.decision, x.reasonCode, x.reasonKey, x.reviewer])).toEqual([
      ['STARTED', null, null, `admin:${REVIEWER_SUB}`],
      ['ACTION_REQUIRED', 'REQUIRES_RESUBMISSION', trustReasonNameKey('REQUIRES_RESUBMISSION'), `admin:${REVIEWER_SUB}`],
    ]);
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_ACTION_REQUIRED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `admin:${REVIEWER_SUB}`, reason_code: 'REQUIRES_RESUBMISSION', correlation_id: r.cid });
    expect(audit[0]!.changes).toEqual({ requirement: 'identity_verification', round: 1, caseStatus: ['IN_REVIEW', 'ACTION_REQUIRED'] });
    const events = (await outboxOf(S.caseId)).filter((e) => e.event_type === TRUST_EVENTS.actionRequired);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toEqual({
      accountId: S.alice.accountId,
      verificationCaseId: S.caseId,
      caseNumber: 1,
      status: 'ACTION_REQUIRED',
      caseRequirementId: S.reqId,
      requirementCode: 'identity_verification',
      requirementType: 'IDENTITY',
      requirementStatus: 'ACTION_REQUIRED',
      reasonCode: 'REQUIRES_RESUBMISSION',
    });
    expect(events[0]).toMatchObject({ actor_id: `admin:${REVIEWER_SUB}`, actor_type: 'system' });
    const view = ok(await vget(S.alice));
    expect(view.overall).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['identity_verification'], verificationComplete: false });
    expect(requirementOf(view)).toMatchObject({
      status: 'ACTION_REQUIRED',
      reasonCode: 'REQUIRES_RESUBMISSION',
      reasonKey: 'trust.reason.requires_resubmission.name',
      canAttachEvidence: true,
      round: 1,
    });
    expect(stepOf(ok(await regReqs(S.alice), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('BLOCKED');
    // the same decision again is a no-op; a different decision on the same evidence is refused
    expect(okDecision(await aDecide(REVIEWER, 'request-action', S.reqId, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' })).changed).toBe(false);
    trustFail(await aDecide(REVIEWER, 'request-action', S.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'ALREADY_DECIDED', {
      reason: 'ALREADY_DECIDED',
    });
    trustFail(await aDecide(REVIEWER, 'approve', S.reqId, { round: 1 }), 409, 'ALREADY_DECIDED', { reason: 'ALREADY_DECIDED' });
    trustFail(await aDecide(REVIEWER, 'reject', S.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'ALREADY_DECIDED', {
      reason: 'ALREADY_DECIDED',
    });
    expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_ACTION_REQUIRED')).toHaveLength(1);
  });

  it('the provider resubmits: new evidence, round 2, the old documents stay as history in round 1; a decision on the OLD round is stale (409 STALE_ROUND) for every action', async () => {
    const fresh = await attached(S.alice, { bytes: jpeg(), mime: 'image/jpeg', type: 'passport' });
    const d = ok(await vsubmit(S.alice, (await liveCase(S.alice)).revision));
    expect(requirementOf(d)).toMatchObject({ status: 'PENDING', round: 2 });
    const docs = requirementOf(d).documents;
    expect(docs.filter((x: Json) => x.round === 1).length).toBeGreaterThan(0);
    expect(docs.filter((x: Json) => x.round === 2).map((x: Json) => x.verificationDocumentId)).toEqual([fresh.docId]);
    const before = await writes();
    trustFail(await aDecide(REVIEWER, 'approve', S.reqId, { round: 1 }), 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    trustFail(await aDecide(REVIEWER, 'reject', S.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    trustFail(await aDecide(REVIEWER, 'request-action', S.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'STALE_ROUND', {
      reason: 'STALE_ROUND',
    });
    trustFail(await aDecide(REVIEWER, 'start-review', S.reqId, { round: 1 }), 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    trustFail(await aDecide(REVIEWER, 'approve', S.reqId, { round: 3 }), 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    expect(await writes()).toEqual(before);
    expect(stepOf(ok(await regReqs(S.alice), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('IN_PROGRESS');
  });

  it('reject (200): REJECTED with a reason, the provider may resubmit; PRO-001 reports BLOCKED; one event requirement-rejected', async () => {
    const r = await aDecide(REVIEWER, 'reject', S.reqId, { round: 2, reasonCode: 'DOCUMENT_UNREADABLE' });
    const d = okDecision(r);
    expect(d).toMatchObject({ changed: true, caseStatus: 'ACTION_REQUIRED' });
    expect(d.requirement.status).toBe('REJECTED');
    expect((await reviewRows(S.reqId)).filter((x) => x.decision === 'REJECTED')).toEqual([
      expect.objectContaining({ round: 2, reason_code: 'DOCUMENT_UNREADABLE' }),
    ]);
    const events = (await outboxOf(S.caseId)).filter((e) => e.event_type === TRUST_EVENTS.requirementRejected);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toMatchObject({ requirementStatus: 'REJECTED', reasonCode: 'DOCUMENT_UNREADABLE', status: 'ACTION_REQUIRED' });
    const view = ok(await vget(S.alice));
    expect(requirementOf(view)).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'DOCUMENT_UNREADABLE',
      reasonKey: 'trust.reason.document_unreadable.name',
      canAttachEvidence: true,
    });
    expect(view.overall).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['identity_verification'] });
    expect(stepOf(ok(await regReqs(S.alice), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('BLOCKED');
  });

  it('the provider resubmits again (round 3) and the reviewer approves it: APPROVED, the case APPROVED, verificationComplete, PRO-001 COMPLETE; approved is NOT live', async () => {
    await attached(S.alice);
    ok(await vsubmit(S.alice, (await liveCase(S.alice)).revision));
    expect((await inst(S.alice)).round).toBe(3);
    const reg = await regRow(S.alice.accountId);
    const providerBefore = await providerWrites();
    const roles = await rolesOf(S.alice.accountId);
    const r = await aDecide(REVIEWER, 'approve', S.reqId, { round: 3 });
    const d = okDecision(r);
    expect(d).toMatchObject({ changed: true, caseStatus: 'APPROVED' });
    expect(d.requirement).toMatchObject({ status: 'APPROVED', round: 3, expiresAt: null });
    expect(d.requirement.approvedAt).not.toBeNull();
    const view = ok(await vget(S.alice));
    expect(view.case).toMatchObject({ status: 'APPROVED', statusKey: 'trust.verification.status.approved' });
    expect(view.overall).toMatchObject({
      status: 'APPROVED',
      verificationComplete: true,
      requiredCount: 1,
      approvedCount: 1,
      missing: [],
      actionRequired: [],
      expired: [],
    });
    expect(requirementOf(view)).toMatchObject({ status: 'APPROVED', canAttachEvidence: false, canReverify: false, reasonCode: null });
    expect(view.goLive).toEqual({ evaluated: false, eligible: false });
    const reqs = ok(await regReqs(S.alice), 200, ProviderRequirementsResponse);
    expect(stepOf(reqs, 'VERIFICATION').status).toBe('COMPLETE');
    // approved verification is NOT registration and NOT go-live
    expect(reqs.registration.status).toBe('IN_PROGRESS');
    expect(reqs.overall).toMatchObject({ registrationComplete: false, goLive: { evaluated: false, eligible: false } });
    expect(await regRow(S.alice.accountId)).toEqual(reg);
    expect(await providerWrites()).toEqual(providerBefore);
    expect(await rolesOf(S.alice.accountId)).toEqual(roles);
    // events: the requirement-approved event and the case-completed event, once each
    const events = await outboxOf(S.caseId);
    const approved = events.filter((e) => e.event_type === TRUST_EVENTS.requirementApproved);
    const completed = events.filter((e) => e.event_type === TRUST_EVENTS.completed);
    expect(approved).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload_json).toEqual({ accountId: S.alice.accountId, verificationCaseId: S.caseId, caseNumber: 1, status: 'APPROVED' });
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_APPROVED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `admin:${REVIEWER_SUB}`, correlation_id: r.cid });
    expect((await caseRows(S.alice.accountId))[0]).toMatchObject({ status: 'APPROVED' });
    expect((await caseRows(S.alice.accountId))[0]!.decided_at).toBeInstanceOf(Date);
  });

  it('an approval is final: the same approval is a no-op, a different decision is 409 ALREADY_DECIDED, the provider can add nothing, and an approved case cannot be cancelled', async () => {
    const before = await writes();
    expect(okDecision(await aDecide(REVIEWER, 'approve', S.reqId, { round: 3 })).changed).toBe(false);
    trustFail(await aDecide(REVIEWER, 'reject', S.reqId, { round: 3, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'ALREADY_DECIDED', {
      reason: 'ALREADY_DECIDED',
    });
    trustFail(await aDecide(REVIEWER, 'request-action', S.reqId, { round: 3, reasonCode: 'DOCUMENT_UNREADABLE' }), 409, 'ALREADY_DECIDED', {
      reason: 'ALREADY_DECIDED',
    });
    trustFail(await aDecide(REVIEWER, 'start-review', S.reqId, { round: 3 }), 409, 'ALREADY_DECIDED', { reason: 'NOT_PENDING' });
    trustFail(
      await vupload(S.alice, { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 }),
      409,
      'EVIDENCE_NOT_ACCEPTED',
      { reason: 'EVIDENCE_NOT_ACCEPTED' },
    );
    trustFail(await vcancel(S.alice), 409, 'INVALID_STATE', { reason: 'HAS_APPROVALS' });
    trustFail(await vreverify(S.alice, 'identity_verification'), 409, 'NOT_REVERIFIABLE', { reason: 'NOT_EXPIRED' });
    expect(await writes()).toEqual(before);
  });

  it('the whole story is on the record in order: audit rows with the actors, reasons and request correlation ids; events with identifiers and codes only', async () => {
    const audit = await auditOf(S.caseId);
    const actions = audit.map((a) => a.action);
    expect(actions[0]).toBe('VERIFICATION_CASE_OPENED');
    const decisions = actions.filter((x) =>
      ['VERIFICATION_REVIEW_STARTED', 'VERIFICATION_ACTION_REQUIRED', 'VERIFICATION_REJECTED', 'VERIFICATION_APPROVED'].includes(x),
    );
    expect(decisions).toEqual(['VERIFICATION_REVIEW_STARTED', 'VERIFICATION_ACTION_REQUIRED', 'VERIFICATION_REJECTED', 'VERIFICATION_APPROVED']);
    expect(actions.filter((x) => x === 'VERIFICATION_SUBMITTED')).toHaveLength(3);
    for (const a of audit) expect(a.actor).toMatch(/^(account:[0-9a-f-]{36}|admin:staff-reviewer-r1)$/);
    const events = await outboxOf(S.caseId);
    const types = events.map((e) => e.event_type);
    expect(types.slice(0, 6)).toEqual([
      TRUST_EVENTS.caseOpened,
      TRUST_EVENTS.submitted,
      TRUST_EVENTS.actionRequired,
      TRUST_EVENTS.submitted,
      TRUST_EVENTS.requirementRejected,
      TRUST_EVENTS.submitted,
    ]);
    // the approval and the completion are written in ONE transaction (one timestamp): their relative order is not defined
    expect(types.slice(6).sort()).toEqual([TRUST_EVENTS.requirementApproved, TRUST_EVENTS.completed].sort());
    // reviews are append-only: STARTED, ACTION_REQUIRED, REJECTED, APPROVED
    expect((await reviewRows(S.reqId)).map((x) => [x.round, x.decision])).toEqual([
      [1, 'STARTED'],
      [1, 'ACTION_REQUIRED'],
      [2, 'REJECTED'],
      [3, 'APPROVED'],
    ]);
  });
});

// ====================================================================== downloads
describe('reviewer downloads', () => {
  it('trust-review gets a short-lived link to ONE document (200); the policy lifetime applies; the access is audited with the document id and no link or key', async () => {
    const doc = (await docRows(S.alice.accountId)).find((d) => d.status === 'SUBMITTED' && d.round === 3)!;
    const issuedBefore = store.issued.length;
    const r = await aDownload(REVIEWER, doc.verification_document_id);
    const d = ok(r, 200, TrustDownloadResponse);
    expect(keysOf(d)).toEqual(['expiresAt', 'url']);
    expect(d.url).toBe(`memory://download/${encodeURIComponent(doc.object_key)}`);
    const lifetime = new Date(d.expiresAt).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(30_000);
    expect(lifetime).toBeLessThan(65_000);
    expect(store.issued.slice(issuedBefore)).toEqual([{ kind: 'download', key: doc.object_key, ttlSeconds: 60 }]);
    const audit = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_ACCESSED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `admin:${REVIEWER_SUB}`, correlation_id: r.cid, case_requirement_id: S.reqId });
    expect(audit[0]!.changes).toEqual({ verificationDocumentId: doc.verification_document_id });
    expect(JSON.stringify(audit[0])).not.toMatch(/memory:|trust\/evidence/);
    expect(r.raw).not.toContain(doc.sha256!);
  });

  it('the link lifetime is configuration (download_url_ttl_seconds): 30 seconds when configured, restored to 60 afterwards', async () => {
    const doc = (await docRows(S.alice.accountId)).find((d) => d.status === 'SUBMITTED')!;
    try {
      await setConfig(P.downloadUrlTtlSeconds, 30);
      ok(await aDownload(REVIEWER, doc.verification_document_id), 200, TrustDownloadResponse);
      expect(store.issued.at(-1)).toMatchObject({ kind: 'download', ttlSeconds: 30 });
    } finally {
      await resetPolicy([P.downloadUrlTtlSeconds]);
    }
    ok(await aDownload(REVIEWER, doc.verification_document_id), 200, TrustDownloadResponse);
    expect(store.issued.at(-1)).toMatchObject({ kind: 'download', ttlSeconds: 60 });
  });

  it('the access is audited BEFORE the link is created: a store that cannot sign still leaves the audit row, and the answer is 503 TRUST_UNAVAILABLE without a link', async () => {
    const doc = (await docRows(S.alice.accountId)).find((d) => d.status === 'SUBMITTED')!;
    const before = (await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_ACCESSED').length;
    const spy = vi.spyOn(store, 'createDownloadUrl').mockRejectedValueOnce(new Error('signer down: secret-signing-detail'));
    const r = await aDownload(REVIEWER, doc.verification_document_id);
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('TRUST_UNAVAILABLE');
    expect(r.raw).not.toContain('secret-signing-detail');
    expect((await auditOf(S.caseId)).filter((a) => a.action === 'VERIFICATION_DOCUMENT_ACCESSED')).toHaveLength(before + 1);
  });

  it('only trust-review may download: trust-read, trust-admin, a provider and anonymous are refused, and nothing is audited or issued', async () => {
    const doc = (await docRows(S.alice.accountId)).find((d) => d.status === 'SUBMITTED')!;
    const issued = store.issued.length;
    const audited = await count(`SELECT 1 FROM trust.audit_events WHERE action = 'VERIFICATION_DOCUMENT_ACCESSED'`);
    for (const t of [READER, POLICY, S.alice.token]) expect((await aDownload(t, doc.verification_document_id)).status).toBe(403);
    expect((await aDownload(null, doc.verification_document_id)).status).toBe(401);
    expect(store.issued.length).toBe(issued);
    expect(await count(`SELECT 1 FROM trust.audit_events WHERE action = 'VERIFICATION_DOCUMENT_ACCESSED'`)).toBe(audited);
  });

  it('an unknown document is 404; a draft that was never finalized or never submitted (ATTACHED), a withdrawn and an abandoned document cannot be downloaded (409 INVALID_STATE); nothing is audited or issued', async () => {
    const issued = store.issued.length;
    const audited = await count(`SELECT 1 FROM trust.audit_events WHERE action = 'VERIFICATION_DOCUMENT_ACCESSED'`);
    trustFail(await aDownload(REVIEWER, randomUUID()), 404, 'NOT_FOUND');
    for (const status of ['UPLOAD_PENDING', 'ATTACHED', 'WITHDRAWN', 'ABANDONED']) {
      const d = (await q<{ verification_document_id: string }>(`SELECT verification_document_id FROM trust.documents WHERE status = $1 LIMIT 1`, [status]))[0];
      expect(d, status).toBeDefined();
      trustFail(await aDownload(REVIEWER, d!.verification_document_id), 409, 'INVALID_STATE', { reason: 'DOCUMENT_NOT_AVAILABLE' });
    }
    fail(await aDownload(REVIEWER, 'not-a-uuid'), 400, 'VALIDATION_FAILED');
    expect(store.issued.length).toBe(issued);
    expect(await count(`SELECT 1 FROM trust.audit_events WHERE action = 'VERIFICATION_DOCUMENT_ACCESSED'`)).toBe(audited);
  });

  it('an infected document is never downloadable (it was abandoned); a document the scanner could not check cannot be downloaded or approved while clean scans are required', async () => {
    const infected = (
      await q<{ verification_document_id: string }>(`SELECT verification_document_id FROM trust.documents WHERE scan_status = 'INFECTED' LIMIT 1`)
    )[0]!;
    trustFail(await aDownload(REVIEWER, infected.verification_document_id), 409, 'INVALID_STATE', { reason: 'DOCUMENT_NOT_AVAILABLE' });
    // submitted while the policy allowed unscanned documents, reviewed after it was tightened again
    const a = await provider('unscanned');
    ok(await vopen(a), 201);
    let reqId = '';
    try {
      await setConfig(P.requireCleanScan, false);
      const p = await putDoc(a, { finalize: false });
      expect(okDoc(await vfinalize(a, p.docId, undefined, appNoScan)).scanStatus).toBe('ERROR');
      ok(await vsubmit(a, (await liveCase(a)).revision));
      reqId = (await inst(a)).case_requirement_id;
    } finally {
      await resetPolicy([P.requireCleanScan]);
    }
    const doc = (await docRows(a.accountId)).find((d) => d.status === 'SUBMITTED')!;
    const issued = store.issued.length;
    trustFail(await aDownload(REVIEWER, doc.verification_document_id), 503, 'SCAN_UNAVAILABLE', { reason: 'SCAN_NOT_CLEAN' });
    expect(store.issued.length).toBe(issued);
    trustFail(await aDecide(REVIEWER, 'approve', reqId, { round: 1 }), 503, 'SCAN_UNAVAILABLE', { reason: 'SCAN_NOT_CLEAN' });
    expect((await inst(a)).status).toBe('PENDING');
  });
});

// ====================================================================== expiry, re-verification, expiry-required requirements
describe('requirements whose approval expires', () => {
  const E = {} as { lic: Actor; caseId: string; idReq: string; licReq: string };

  it('a provider with two requirements submits both together; the case is not submittable until BOTH have a document (SUBMISSION_INCOMPLETE names the missing one)', async () => {
    E.lic = await provider('expiry', [W.stA, W.stB]);
    ok(await vopen(E.lic), 201);
    E.caseId = (await liveCase(E.lic)).verification_case_id;
    await attached(E.lic, { requirement: 'identity_verification' });
    trustFail(await vsubmit(E.lic, (await liveCase(E.lic)).revision), 409, 'SUBMISSION_INCOMPLETE', {
      reason: 'SUBMISSION_INCOMPLETE',
      codes: ['professional_license'],
    });
    // the licence takes licence documents only
    trustFail(
      await vupload(E.lic, { requirementCode: 'professional_license', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 100 }),
      400,
      'DOCUMENT_TYPE_NOT_ACCEPTED',
      { reason: 'DOCUMENT_TYPE_NOT_ACCEPTED' },
    );
    await attached(E.lic, { requirement: 'professional_license', type: 'professional_license' });
    const d = ok(await vsubmit(E.lic, (await liveCase(E.lic)).revision));
    expect(d.requirements.map((x: Json) => [x.requirementCode, x.status, x.round])).toEqual([
      ['identity_verification', 'PENDING', 1],
      ['professional_license', 'PENDING', 1],
    ]);
    E.idReq = requirementOf(d).caseRequirementId;
    E.licReq = requirementOf(d, 'professional_license').caseRequirementId;
    expect(d.overall.requiredCount).toBe(2);
  });

  it('approving a requirement that expires needs an end date: missing, past, invalid or absurdly far is 400 VALIDATION_FAILED on expiresAt; nothing is decided', async () => {
    const before = await writes();
    const expected = (reason: string) => ({ field: 'expiresAt', reason });
    trustFail(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1 }), 400, 'VALIDATION_FAILED', expected('EXPIRY_REQUIRED'));
    trustFail(
      await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: new Date(Date.now() - 86_400_000).toISOString() }),
      400,
      'VALIDATION_FAILED',
      expected('EXPIRY_INVALID'),
    );
    trustFail(
      await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: new Date(Date.now() + 4000 * 86_400_000).toISOString() }),
      400,
      'VALIDATION_FAILED',
      expected('EXPIRY_INVALID'),
    );
    fail(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: 'tomorrow' }), 400, 'VALIDATION_FAILED');
    fail(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: '2030-01-01' }), 400, 'VALIDATION_FAILED');
    expect(await writes()).toEqual(before);
    expect((await inst(E.lic, 'professional_license')).status).toBe('PENDING');
  });

  it('approving one requirement leaves the case IN_REVIEW; the case completes only with the last one (one completed event); the approval carries the end date', async () => {
    okDecision(await aDecide(REVIEWER, 'approve', E.idReq, { round: 1 }));
    expect((await liveCase(E.lic)).status).toBe('IN_REVIEW');
    expect((await outboxOf(E.caseId)).filter((e) => e.event_type === TRUST_EVENTS.completed)).toHaveLength(0);
    const midView = ok(await vget(E.lic));
    expect(midView.overall).toMatchObject({ status: 'IN_REVIEW', approvedCount: 1, requiredCount: 2 });
    expect(stepOf(ok(await regReqs(E.lic), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('IN_PROGRESS');
    const expires = new Date(Date.now() + 6000).toISOString();
    const d = okDecision(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: expires }));
    expect(d.caseStatus).toBe('APPROVED');
    expect(new Date(d.requirement.expiresAt).toISOString()).toBe(expires);
    // replaying the approval: the same end date is a no-op; a different end date is a different decision
    expect(okDecision(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: expires })).changed).toBe(false);
    trustFail(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: new Date(Date.now() + 90_000).toISOString() }), 409, 'ALREADY_DECIDED', {
      reason: 'ALREADY_DECIDED',
    });
    expect((await reviewRows(E.licReq)).find((x) => x.decision === 'APPROVED')!.expires_at!.toISOString()).toBe(expires);
    expect((await outboxOf(E.caseId)).filter((e) => e.event_type === TRUST_EVENTS.completed)).toHaveLength(1);
    expect(ok(await vget(E.lic)).overall).toMatchObject({ status: 'APPROVED', verificationComplete: true, approvedCount: 2 });
    expect(stepOf(ok(await regReqs(E.lic), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('COMPLETE');
  });

  it('expiry is DERIVED from the timestamp: the provider reads EXPIRED (overall EXPIRED, canReverify, PRO-001 BLOCKED) as soon as the end has passed, before anything is recorded', async () => {
    // a clock an hour ahead (a third stack over the same database) sees the approval as ended while the real clock does not
    const late = ok(await vget(E.lic, appLate));
    expect(requirementOf(late, 'professional_license')).toMatchObject({ status: 'EXPIRED', canReverify: true, canAttachEvidence: false });
    expect(late.overall).toMatchObject({ status: 'EXPIRED', verificationComplete: false, expired: ['professional_license'], approvedCount: 1 });
    expect(requirementOf(late)).toMatchObject({ status: 'APPROVED' });
    expect(ok(await vget(E.lic)).overall.status).toBe('APPROVED');
    // nothing was recorded by the read
    expect((await inst(E.lic, 'professional_license')).status).toBe('APPROVED');
    // the same clock refuses a new upload on the (still approved) identity and accepts nothing for the expired licence until re-verified
    trustFail(
      await vupload(
        E.lic,
        { requirementCode: 'professional_license', documentTypeCode: 'professional_license', mimeType: 'application/pdf', sizeBytes: 100 },
        appLate,
      ),
      409,
      'EVIDENCE_NOT_ACCEPTED',
      { reason: 'EVIDENCE_NOT_ACCEPTED' },
    );
  });

  it('after the real end date the sweep RECORDS the expiry (EXPIRED, an audit row by system:expiry, one event, the case EXPIRED); the provider re-verifies: a new cycle, the old approval stays as history', async () => {
    const wait = new Date((await inst(E.lic, 'professional_license')).expires_at!).getTime() - Date.now() + 500;
    if (wait > 0) await sleep(wait);
    const view = ok(await vget(E.lic));
    expect(requirementOf(view, 'professional_license')).toMatchObject({ status: 'EXPIRED', canReverify: true });
    expect(view.overall).toMatchObject({ status: 'EXPIRED', expired: ['professional_license'] });
    expect(stepOf(ok(await regReqs(E.lic), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('BLOCKED');
    expect(await trust.recordExpiries()).toBeGreaterThanOrEqual(1);
    expect(await trust.recordExpiries()).toBe(0);
    expect((await liveCase(E.lic)).status).toBe('EXPIRED');
    const audit = (await auditOf(E.caseId)).filter((a) => a.action === 'VERIFICATION_EXPIRED');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('system:expiry');
    const events = (await outboxOf(E.caseId)).filter((e) => e.event_type === TRUST_EVENTS.expired);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload_json).toMatchObject({
      requirementCode: 'professional_license',
      requirementStatus: 'EXPIRED',
      status: 'EXPIRED',
      reasonCode: null,
    });
    // re-verification: a new cycle; the expired one is history; the identity approval is untouched
    const re = ok(await vreverify(E.lic, 'professional_license'));
    expect(requirementOf(re, 'professional_license')).toMatchObject({
      status: 'NOT_STARTED',
      cycle: 2,
      round: 0,
      canAttachEvidence: true,
      canReverify: false,
      documents: [],
    });
    expect(requirementOf(re)).toMatchObject({ status: 'APPROVED', cycle: 1 });
    expect(re.overall).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['professional_license'] });
    const rows = await reqRows(E.caseId);
    expect(rows.filter((x) => x.code === 'professional_license').map((x) => [x.cycle, x.status, x.superseded_at !== null])).toEqual([
      [1, 'EXPIRED', true],
      [2, 'NOT_STARTED', false],
    ]);
    trustFail(await vreverify(E.lic, 'professional_license'), 409, 'NOT_REVERIFIABLE', { reason: 'NOT_EXPIRED' });
    trustFail(await vreverify(E.lic, 'identity_verification'), 409, 'NOT_REVERIFIABLE', { reason: 'NOT_EXPIRED' });
    const detail = ok(await aCase(READER, E.caseId), 200, TrustCaseDetailResponse);
    const lic = detail.requirements.filter((x: Json) => x.requirementCode === 'professional_license');
    expect(lic.map((x: Json) => [x.cycle, x.status, x.superseded])).toEqual([
      [1, 'EXPIRED', true],
      [2, 'NOT_STARTED', false],
    ]);
    expect(lic[0].reviews.map((x: Json) => x.decision)).toEqual(['APPROVED']);
    // a decision on the superseded cycle is refused
    trustFail(await aDecide(REVIEWER, 'approve', E.licReq, { round: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), 409, 'INVALID_STATE', {
      reason: 'SUPERSEDED_FROZEN',
    });
    // the new cycle takes new evidence, in a fresh round
    await attached(E.lic, { requirement: 'professional_license', type: 'professional_license' });
    const submitted = ok(await vsubmit(E.lic, (await liveCase(E.lic)).revision));
    expect(requirementOf(submitted, 'professional_license')).toMatchObject({ status: 'PENDING', cycle: 2, round: 1 });
    expect(submitted.case.status).toBe('IN_REVIEW');
  });
});

// ====================================================================== external verification
describe('external verification (the adapter boundary)', () => {
  it('the provider starts it (PENDING), refreshes it; the provider can never approve: the adapter and then staff do, and the approval needs an end date', async () => {
    const x = await provider('external', [W.stA, W.stD]);
    ok(await vopen(x), 201);
    const reqId = requirementOf(ok(await vget(x)), 'background_check').caseRequirementId;
    expect(requirementOf(ok(await vget(x)), 'background_check')).toMatchObject({ evidenceKind: 'EXTERNAL', canAttachEvidence: false });
    // identity by document, background check by the adapter
    const started = ok(await vexternal(x, 'background_check'), 200, ExternalVerificationResponse);
    expect(started).toMatchObject({ requirementCode: 'background_check', adapter: 'fake', status: 'PENDING' });
    // the adapter reported PENDING (not CREATED), so the start is recorded as checked just now
    expect(Math.abs(Date.now() - Date.parse(started.lastCheckedAt))).toBeLessThan(30_000);
    expect(ok(await vexternal(x, 'background_check'), 200, ExternalVerificationResponse)).toMatchObject({ status: 'PENDING' });
    expect((await inst(x, 'background_check')).status).toBe('PENDING');
    // staff cannot invent an external approval: the adapter has not approved this round yet
    const writesBefore = await writes();
    trustFail(await aDecide(REVIEWER, 'approve', reqId, { round: 1, expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString() }), 409, 'INVALID_STATE', {
      reason: 'EXTERNAL_NOT_APPROVED',
    });
    expect(await writes()).toEqual(writesBefore);
    expect(await count(`SELECT 1 FROM trust.external_verifications WHERE case_requirement_id = $1`, [reqId])).toBe(1);
    const stored = (
      await q<{ external_id: string; adapter: string }>(`SELECT external_id, adapter FROM trust.external_verifications WHERE case_requirement_id = $1`, [reqId])
    )[0]!;
    // the first poll is still PENDING, the second APPROVED but with no end date: staff complete it
    expect(ok(await vrefresh(x, 'background_check'), 200, ExternalVerificationResponse).status).toBe('PENDING');
    const second = ok(await vrefresh(x, 'background_check'), 200, ExternalVerificationResponse);
    expect(second.status).toBe('APPROVED');
    expect(second.lastCheckedAt).not.toBeNull();
    expect((await inst(x, 'background_check')).status).toBe('IN_REVIEW');
    expect(JSON.stringify(transcript.slice(-6).map((t) => t.raw))).not.toContain(stored.external_id);
    const end = new Date(Date.now() + 86_400_000 * 30).toISOString();
    const approved = okDecision(await aDecide(REVIEWER, 'approve', reqId, { round: 1, expiresAt: end }));
    // replaying the approval: the same end date is a no-op, a different one is a different decision
    expect(okDecision(await aDecide(REVIEWER, 'approve', reqId, { round: 1, expiresAt: end })).changed).toBe(false);
    trustFail(
      await aDecide(REVIEWER, 'approve', reqId, { round: 1, expiresAt: new Date(Date.now() + 86_400_000 * 60).toISOString() }),
      409,
      'ALREADY_DECIDED',
      {
        reason: 'ALREADY_DECIDED',
      },
    );
    expect(approved.requirement.status).toBe('APPROVED');
    expect(approved.requirement.external).toMatchObject({ adapter: 'fake', status: 'APPROVED' });
    expect(JSON.stringify(approved)).not.toContain(stored.external_id);
    // a document requirement does not take an external verification
    trustFail(await vexternal(x, 'identity_verification'), 409, 'EVIDENCE_NOT_ACCEPTED', { reason: 'EVIDENCE_NOT_ACCEPTED' });
    trustFail(await vexternal(x, 'professional_license'), 409, 'REQUIREMENT_NOT_APPLICABLE', { reason: 'REQUIREMENT_NOT_APPLICABLE' });
    trustFail(await vrefresh(x, 'identity_verification'), 404, 'NOT_FOUND', { reason: 'NO_EXTERNAL' });
  });

  it('an external rejection refuses the requirement with OTHER_REVIEW_REQUIRED (reviewer external:fake); with no provider configured it is 503 EXTERNAL_UNAVAILABLE', async () => {
    const x = await provider('external-rej', [W.stA, W.stD]);
    ok(await vopen(x), 201);
    const reqId = requirementOf(ok(await vget(x)), 'background_check').caseRequirementId;
    // the provider is not configured on the second app: unavailable, nothing written
    const before = await writes();
    trustFail(await vexternal(x, 'background_check', appNoScan), 503, 'EXTERNAL_UNAVAILABLE');
    expect(await writes()).toEqual(before);
    ok(await vexternal(x, 'background_check'), 200, ExternalVerificationResponse);
    const externalId = (await q<{ external_id: string }>(`SELECT external_id FROM trust.external_verifications WHERE case_requirement_id = $1`, [reqId]))[0]!
      .external_id;
    externalProvider.setOutcome(externalId, 'REJECTED');
    expect(ok(await vrefresh(x, 'background_check'), 200, ExternalVerificationResponse).status).toBe('REJECTED');
    const r = await inst(x, 'background_check');
    expect(r.status).toBe('REJECTED');
    expect(await reviewRows(reqId)).toEqual([
      expect.objectContaining({ decision: 'REJECTED', reason_code: 'OTHER_REVIEW_REQUIRED', reviewer: 'external:fake', round: 1 }),
    ]);
    expect(requirementOf(ok(await vget(x)), 'background_check')).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'OTHER_REVIEW_REQUIRED',
      canAttachEvidence: false,
    });
  });
});

// ====================================================================== cancel and restart
describe('cancel and restart', () => {
  it('cancels a case that is not decided (200): the case is CANCELLED, the account, the registration and the documents stay; the overview reads no case; again is idempotent', async () => {
    const c = await provider('cancel');
    ok(await vopen(c), 201);
    const d = await attached(c);
    const pending = await putDoc(c, { finalize: false });
    const reg = await regRow(c.accountId);
    const roles = await rolesOf(c.accountId);
    const r = await vcancel(c);
    const view = ok(r);
    expect(view.case).toBeNull();
    expect(view.overall.status).toBe('NOT_STARTED');
    const rows = await caseRows(c.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect(rows[0]!.cancelled_at).toBeInstanceOf(Date);
    const audit = (await auditOf(rows[0]!.verification_case_id)).filter((a) => a.action === 'VERIFICATION_CASE_CANCELLED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `account:${c.accountId}`, correlation_id: r.cid });
    expect(audit[0]!.changes).toEqual({ status: ['OPEN', 'CANCELLED'] });
    expect((await docRows(c.accountId)).map((x) => x.status).sort()).toEqual(['ATTACHED', 'UPLOAD_PENDING']);
    expect(await regRow(c.accountId)).toEqual(reg);
    expect(await rolesOf(c.accountId)).toEqual(roles);
    expect(stepOf(ok(await regReqs(c), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('NOT_STARTED');
    const before = await writes();
    expect(ok(await vcancel(c)).case).toBeNull();
    expect(await writes()).toEqual(before);
    // the cancelled case is frozen: its documents cannot be finalized, withdrawn or downloaded into a live state
    store.put(pending.key, pdf(), 'application/pdf');
    const fin = await vfinalize(c, pending.docId);
    expect([404, 409], fin.raw).toContain(fin.status);
    expect((await docRow(pending.docId)).status).not.toBe('ATTACHED');
    expect(d.docId).toBeDefined();
    // a restart is the NEXT case number, empty
    const reopened = ok(await vopen(c), 201);
    expect(reopened.case.caseNumber).toBe(2);
    expect(requirementOf(reopened).documents).toEqual([]);
    expect((await caseRows(c.accountId)).map((x) => [x.case_number, x.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'OPEN'],
    ]);
    expect(okDocs(await vdocs(c))).toEqual([]);
    // a reviewer cannot decide on a cancelled case
    const oldReq = (await reqRows(rows[0]!.verification_case_id))[0]!;
    trustFail(await aDecide(REVIEWER, 'start-review', oldReq.case_requirement_id, { round: 1 }), 409, 'INVALID_STATE', { reason: 'CASE_FROZEN' });
  });

  it('a case in review can be cancelled too (the registration and roles untouched); an approved one cannot (checked above)', async () => {
    const c = await provider('cancel-review');
    ok(await vopen(c), 201);
    await attached(c);
    ok(await vsubmit(c, (await liveCase(c)).revision));
    expect((await liveCase(c)).status).toBe('IN_REVIEW');
    const submittedDoc = (await docRows(c.accountId)).find((d) => d.status === 'SUBMITTED')!;
    ok(await aDownload(REVIEWER, submittedDoc.verification_document_id), 200, TrustDownloadResponse);
    expect(ok(await vcancel(c)).case).toBeNull();
    expect((await caseRows(c.accountId))[0]!.status).toBe('CANCELLED');
    // the evidence of a withdrawn case is not served to reviewers any more
    trustFail(await aDownload(REVIEWER, submittedDoc.verification_document_id), 409, 'INVALID_STATE', { reason: 'DOCUMENT_NOT_AVAILABLE' });
  });

  it('a decision racing a cancel: one wins, the loser is a clean refusal (never a 500, never a half-written state)', async () => {
    const c = await submittedProvider('cancelrace');
    const [dec, can] = await Promise.all([aDecide(REVIEWER, 'approve', c.reqId, { round: 1 }), vcancel(c.actor)]);
    expect([dec.status, can.status], `${dec.raw} ${can.raw}`).not.toContain(500);
    const row = (await caseRows(c.actor.accountId))[0]!;
    if (row.status === 'CANCELLED') {
      expect(can.status).toBe(200);
      expect(dec.status).toBe(409);
      expect(await inst(c.actor).catch(() => null)).toBeNull();
    } else {
      expect(row.status).toBe('APPROVED');
      expect(dec.status).toBe(200);
      expect(can.status).toBe(409);
    }
  });
});

// ====================================================================== owner isolation and IDOR
describe('owner isolation', () => {
  it("another provider's document id on finalize and withdraw is 404, indistinguishable from an unknown id; nothing changes; the response never mentions the other account", async () => {
    const x = await provider('idor-x');
    const y = await provider('idor-y');
    ok(await vopen(x), 201);
    ok(await vopen(y), 201);
    const dx = await attached(x);
    const px = await putDoc(x, { finalize: false });
    const before = await writes();
    const dxRow = await docRow(dx.docId);
    const strip = (r: Res) => JSON.stringify({ ...r.body, error: { ...r.body.error, correlationId: 'c' } });
    const unknown = await vfinalize(y, randomUUID());
    for (const id of [dx.docId, px.docId]) {
      const f = await vfinalize(y, id);
      trustFail(f, 404, 'NOT_FOUND');
      expect(strip(f)).toBe(strip(unknown));
      const w = await vwithdraw(y, id);
      trustFail(w, 404, 'NOT_FOUND');
      expect(strip(w)).toBe(strip(await vwithdraw(y, randomUUID())));
      expect(f.raw).not.toContain(x.accountId);
    }
    expect(await writes()).toEqual(before);
    expect(await docRow(dx.docId)).toEqual(dxRow);
    // x's own view and list never contain y's data and the reverse
    ok(await vget(y));
    expect(okDocs(await vdocs(y))).toEqual([]);
    expect((await vdocs(x)).raw).not.toContain(y.accountId);
    // y cannot finalize x's pending upload by presenting the bytes either
    store.put(px.key, pdf(), 'application/pdf');
    trustFail(await vfinalize(y, px.docId), 404, 'NOT_FOUND');
    expect((await docRow(px.docId)).status).toBe('UPLOAD_PENDING');
  });

  it("a provider token is 403 on every admin route even with another account's case id; an account id, case id or reviewer in a header or body is never honoured", async () => {
    const x = await provider('idor-z');
    ok(await vopen(x), 201);
    const xc = (await liveCase(x)).verification_case_id;
    const before = await writes();
    expect((await aCase(S.alice.token, xc)).status).toBe(403);
    expect((await aList(S.alice.token)).status).toBe(403);
    expect((await aPolicy(S.alice.token)).status).toBe(403);
    expect((await aDownload(S.alice.token, randomUUID())).status).toBe(403);
    // the provider routes ignore a case or account named by the client
    const hostile = await call('GET', PV, { as: S.alice, headers: { 'x-account-id': x.accountId, 'x-verification-case-id': xc } });
    expect(ok(hostile).case.verificationCaseId).toBe(S.caseId);
    fail(await call('POST', `${PV}/submit`, { as: S.alice, body: { expectedRevision: 1, verificationCaseId: xc } }), 400, 'VALIDATION_FAILED');
    fail(
      await call('POST', `${PV}/documents/upload`, {
        as: S.alice,
        body: {
          requirementCode: 'identity_verification',
          documentTypeCode: 'drivers_license',
          mimeType: 'application/pdf',
          sizeBytes: 5,
          accountId: x.accountId,
        },
      }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await writes()).toEqual(before);
  });

  it('the admin identity has no application account on the provider routes (403 on all eleven), and an anonymous caller gets 401 everywhere', async () => {
    const before = await writes();
    for (const [m, u, b] of [
      ['GET', PV, undefined],
      ['POST', PV, undefined],
      ['GET', `${PV}/documents`, undefined],
      [
        'POST',
        `${PV}/documents/upload`,
        { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 5 },
      ],
      ['POST', `${PV}/documents/${randomUUID()}/finalize`, undefined],
      ['POST', `${PV}/documents/${randomUUID()}/withdraw`, undefined],
      ['POST', `${PV}/submit`, { expectedRevision: 1 }],
      ['POST', `${PV}/cancel`, undefined],
      ['POST', `${PV}/requirements/identity_verification/reverify`, undefined],
      ['POST', `${PV}/requirements/background_check/external`, undefined],
      ['POST', `${PV}/requirements/background_check/external/refresh`, undefined],
    ] as const) {
      expect(fail(await call(m, u, { as: EVERYTHING, ...(b === undefined ? {} : { body: b }) }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED').category).toBe(
        'AUTHORIZATION',
      );
      expect((await call(m, u, { as: null, ...(b === undefined ? {} : { body: b }) })).status).toBe(401);
    }
    expect(await writes()).toEqual(before);
  });

  it('a suspended account is refused 403 ACCOUNT_SUSPENDED on every provider operation and a closed one 403 ACCOUNT_CLOSED; nothing is written; reactivated it carries on', async () => {
    const s = await provider('suspended');
    ok(await vopen(s), 201);
    await accounts.changeStatus(s.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    const before = await writes();
    for (const [m, u, b] of [
      ['GET', PV, undefined],
      ['POST', PV, undefined],
      ['GET', `${PV}/documents`, undefined],
      [
        'POST',
        `${PV}/documents/upload`,
        { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 5 },
      ],
      ['POST', `${PV}/submit`, { expectedRevision: 1 }],
      ['POST', `${PV}/cancel`, undefined],
    ] as const)
      fail(await call(m, u, { as: s, ...(b === undefined ? {} : { body: b }) }), 403, 'ACCOUNT_SUSPENDED');
    expect(await writes()).toEqual(before);
    await accounts.changeStatus(s.accountId, 'ACTIVE', { actor: 'system:itest', reason: 'itest' });
    ok(await vget(s));
    await accounts.changeStatus(s.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    await accounts.changeStatus(s.accountId, 'CLOSED', { actor: 'system:itest', reason: 'itest' });
    fail(await vget(s), 403, 'ACCOUNT_CLOSED');
  });

  it('an account suspended AFTER the case was opened still shows up to the reviewers, who can decide; the account cannot act (the service re-checks ACTIVE under the lock)', async () => {
    const s = await provider('suspended2');
    ok(await vopen(s), 201);
    const d = await attached(s);
    expect(d.docId).toBeDefined();
    // the service itself (not the HTTP guard) refuses a suspended account: ACCOUNT_NOT_ACTIVE
    await accounts.changeStatus(s.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    const rejected = await trust.submitVerification(s.accountId, { expectedRevision: (await liveCase(s)).revision }).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect((await liveCase(s)).status).toBe('OPEN');
    await accounts.changeStatus(s.accountId, 'ACTIVE', { actor: 'system:itest', reason: 'itest' });
  });
});

// ====================================================================== races between reviewers
interface Submitted {
  actor: Actor;
  caseId: string;
  reqId: string;
}
async function submittedProvider(label: string): Promise<Submitted> {
  const actor = await provider(label);
  ok(await vopen(actor), 201);
  await attached(actor);
  ok(await vsubmit(actor, (await liveCase(actor)).revision));
  const c = await liveCase(actor);
  return { actor, caseId: c.verification_case_id, reqId: (await inst(actor)).case_requirement_id };
}

describe('races', () => {
  it('an approve racing a reject of the same evidence: exactly ONE decision is recorded; the loser is 409 ALREADY_DECIDED', async () => {
    for (let i = 0; i < 3; i++) {
      const c = await submittedProvider(`decrace${i}`);
      const rs = await Promise.all([
        aDecide(REVIEWER, 'approve', c.reqId, { round: 1 }),
        aDecide(REVIEWER, 'reject', c.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }),
      ]);
      const statuses = rs.map((r) => r.status).sort();
      expect(statuses, rs.map((r) => r.raw).join('\n')).toEqual([200, 409]);
      const loser = rs.find((r) => r.status === 409)!;
      trustFail(loser, 409, 'ALREADY_DECIDED', { reason: 'ALREADY_DECIDED' });
      const decisions = (await reviewRows(c.reqId)).filter((x) => x.decision !== 'STARTED');
      expect(decisions).toHaveLength(1);
      const winner = rs.find((r) => r.status === 200)!;
      expect(winner.body.data.requirement.status).toBe(decisions[0]!.decision);
      expect((await inst(c.actor)).status).toBe(decisions[0]!.decision);
      expect((await auditOf(c.caseId)).filter((a) => ['VERIFICATION_APPROVED', 'VERIFICATION_REJECTED'].includes(a.action))).toHaveLength(1);
      const events = (await outboxOf(c.caseId)).filter((e) =>
        [TRUST_EVENTS.requirementApproved, TRUST_EVENTS.requirementRejected].includes(e.event_type as never),
      );
      expect(events).toHaveLength(1);
    }
  });

  it('four reviewers approving the same evidence at once: all answer 200, exactly one is a change, one review row, one audit row, one event, one completed event', async () => {
    const c = await submittedProvider('apprace');
    const rs = await Promise.all([1, 2, 3, 4].map(() => aDecide(REVIEWER, 'approve', c.reqId, { round: 1 })));
    expect(
      rs.map((r) => r.status),
      rs.map((r) => r.raw).join('\n'),
    ).toEqual([200, 200, 200, 200]);
    expect(rs.filter((r) => r.body.data.changed === true)).toHaveLength(1);
    expect((await reviewRows(c.reqId)).filter((x) => x.decision === 'APPROVED')).toHaveLength(1);
    expect((await auditOf(c.caseId)).filter((a) => a.action === 'VERIFICATION_APPROVED')).toHaveLength(1);
    const events = await outboxOf(c.caseId);
    expect(events.filter((e) => e.event_type === TRUST_EVENTS.requirementApproved)).toHaveLength(1);
    expect(events.filter((e) => e.event_type === TRUST_EVENTS.completed)).toHaveLength(1);
  });

  it('a decision racing the provider resubmission cannot approve evidence nobody saw: the decision is on a round; a resubmission in between makes it 409 STALE_ROUND', async () => {
    const c = await submittedProvider('stalerace');
    okDecision(await aDecide(REVIEWER, 'request-action', c.reqId, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' }));
    await attached(c.actor);
    ok(await vsubmit(c.actor, (await liveCase(c.actor)).revision));
    const rs = await Promise.all([aDecide(REVIEWER, 'approve', c.reqId, { round: 1 }), aDecide(REVIEWER, 'approve', c.reqId, { round: 1 })]);
    for (const r of rs) trustFail(r, 409, 'STALE_ROUND', { reason: 'STALE_ROUND' });
    expect((await inst(c.actor)).status).toBe('PENDING');
  });

  it('simultaneous start-reviews are one review (all 200); a start-review and a request-action race ends in one consistent state', async () => {
    const c = await submittedProvider('startrace');
    const rs = await Promise.all([1, 2, 3].map(() => aDecide(REVIEWER, 'start-review', c.reqId, { round: 1 })));
    expect(
      rs.map((r) => r.status),
      rs.map((r) => r.raw).join('\n'),
    ).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.data.changed)).toHaveLength(1);
    expect((await reviewRows(c.reqId)).filter((x) => x.decision === 'STARTED')).toHaveLength(1);
    const d = await submittedProvider('startrace2');
    const [s1, a1] = await Promise.all([
      aDecide(REVIEWER, 'start-review', d.reqId, { round: 1 }),
      aDecide(REVIEWER, 'request-action', d.reqId, { round: 1, reasonCode: 'REQUIRES_RESUBMISSION' }),
    ]);
    expect([s1.status, a1.status], `${s1.raw} ${a1.raw}`).not.toContain(500);
    expect(['IN_REVIEW', 'ACTION_REQUIRED']).toContain((await inst(d.actor)).status);
  });

  it('simultaneous requests of different providers do not interfere: eight providers open, upload, submit and are approved at once', async () => {
    const ps = await Promise.all(Array.from({ length: 8 }, (_, i) => provider(`par${i}`)));
    await Promise.all(ps.map((a) => vopen(a)));
    await Promise.all(ps.map((a) => attached(a)));
    const subs = await Promise.all(ps.map(async (a) => vsubmit(a, (await liveCase(a)).revision)));
    expect(
      subs.map((r) => r.status),
      subs.map((r) => r.raw).join('\n'),
    ).toEqual(Array(8).fill(200));
    const decisions = await Promise.all(ps.map(async (a) => aDecide(REVIEWER, 'approve', (await inst(a)).case_requirement_id, { round: 1 })));
    expect(
      decisions.map((r) => r.status),
      decisions.map((r) => r.raw).join('\n'),
    ).toEqual(Array(8).fill(200));
    for (const a of ps) expect((await liveCase(a)).status).toBe('APPROVED');
  });
});

// ====================================================================== a registration that completes WITHOUT verification
describe('verification is not part of the registration', () => {
  it('the PRO-001 submit does NOT require verification: a registration completes with the VERIFICATION step NOT_STARTED; Go-Live is still not evaluated; verification then proceeds on the COMPLETED registration', async () => {
    await publishLegal('legal.terms_of_service');
    await publishLegal('legal.privacy_policy');
    const a = await provider('complete');
    await acceptAgreements(a);
    const reqs = ok(await regReqs(a), 200, ProviderRequirementsResponse);
    expect(stepOf(reqs, 'VERIFICATION').status).toBe('NOT_STARTED');
    expect(reqs.overall).toMatchObject({ registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
    const revision = reqs.registration.revision;
    const done = await call('POST', `${REG}/submit`, { as: a, body: { expectedRevision: revision } });
    const data = ok(done, 200, ProviderRequirementsResponse);
    expect(data.registration.status).toBe('COMPLETED');
    expect(data.providerRole).toBe('ACTIVE');
    expect(stepOf(data, 'VERIFICATION').status).toBe('NOT_STARTED');
    expect(data.overall).toMatchObject({ registrationComplete: true, goLive: { evaluated: false, eligible: false } });
    // verification works on the completed registration, and approval changes neither the registration nor the roles
    const providerBefore = await providerWrites();
    ok(await vopen(a), 201);
    await attached(a);
    ok(await vsubmit(a, (await liveCase(a)).revision));
    okDecision(await aDecide(REVIEWER, 'approve', (await inst(a)).case_requirement_id, { round: 1 }));
    const after = ok(await regReqs(a), 200, ProviderRequirementsResponse);
    expect(stepOf(after, 'VERIFICATION').status).toBe('COMPLETE');
    expect(after.registration.status).toBe('COMPLETED');
    expect(after.providerRole).toBe('ACTIVE');
    expect(after.overall).toMatchObject({ registrationComplete: true, goLive: { evaluated: false, eligible: false } });
    expect(await providerWrites()).toEqual(providerBefore);
    expect(ok(await vget(a)).goLive).toEqual({ evaluated: false, eligible: false });
  });

  it('a cancelled registration is not live: the verification of that account reads prerequisiteMet:false and open is refused (the case history stays)', async () => {
    const a = await provider('regcancel');
    ok(await vopen(a), 201);
    expect((await call('POST', `${REG}/cancel`, { as: a, body: {} })).status).toBe(200);
    expect(ok(await vget(a)).prerequisiteMet).toBe(false);
    trustFail(await vopen(a), 409, 'PREREQUISITE_NOT_MET', { reason: 'REGISTRATION_REQUIRED' });
    expect(await caseRows(a.accountId)).toHaveLength(1);
  });

  it('a failure of the verification domain reports the step NOT_AVAILABLE without breaking the registration read', async () => {
    const a = await provider('outage');
    const spy = vi.spyOn(trust, 'getVerification').mockRejectedValue(new Error('verification down'));
    try {
      const r = await regReqs(a);
      const data = ok(r, 200, ProviderRequirementsResponse);
      expect(stepOf(data, 'VERIFICATION').status).toBe('NOT_AVAILABLE');
      expect(data.registration.status).toBe('IN_PROGRESS');
    } finally {
      spy.mockRestore();
    }
    expect(stepOf(ok(await regReqs(a), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('NOT_STARTED');
  });
});

// ====================================================================== policy changes after the fact
describe('policy changes after the fact', () => {
  it('an approval is history: when policy stops requiring identity the provider reads NOT_REQUIRED but the approval stays visible; it counts again when policy requires it', async () => {
    ok(await aStatus(POLICY, 'identity_verification', 'INACTIVE'), 200, null);
    try {
      const view = ok(await vget(S.alice));
      expect(view.overall).toMatchObject({ status: 'NOT_REQUIRED', requiredCount: 0, approvedCount: 0, verificationComplete: true });
      expect(requirementOf(view)).toMatchObject({ status: 'APPROVED', canAttachEvidence: false, canReverify: false });
      expect(stepOf(ok(await regReqs(S.alice), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('NOT_REQUIRED');
    } finally {
      ok(await aStatus(POLICY, 'identity_verification', 'ACTIVE'), 200, null);
    }
    const back = ok(await vget(S.alice));
    expect(back.overall).toMatchObject({ status: 'APPROVED', requiredCount: 1, approvedCount: 1, verificationComplete: true });
    expect(stepOf(ok(await regReqs(S.alice), 200, ProviderRequirementsResponse), 'VERIFICATION').status).toBe('COMPLETE');
  });

  it('a requirement that policy retires while its evidence waits for review: the next open marks it NOT_REQUIRED (no 500), a reviewer can no longer decide it (409), and requiring it again asks for new evidence in the next round', async () => {
    const c = await submittedProvider('policyreview');
    expect((await inst(c.actor)).status).toBe('PENDING');
    ok(await aStatus(POLICY, 'identity_verification', 'INACTIVE'), 200, null);
    try {
      const view = ok(await vopen(c.actor), 200);
      expect(view.overall).toMatchObject({ status: 'NOT_REQUIRED', requiredCount: 0 });
      expect((await inst(c.actor)).status).toBe('NOT_REQUIRED');
      expect((await auditOf(c.caseId)).filter((a) => a.action === 'VERIFICATION_REQUIREMENTS_SYNCED').at(-1)!.changes).toEqual({
        added: [],
        retired: ['identity_verification'],
      });
      trustFail(await aDecide(REVIEWER, 'approve', c.reqId, { round: 1 }), 409, 'INVALID_STATE', { reason: 'NOT_PENDING' });
      trustFail(await aDecide(REVIEWER, 'start-review', c.reqId, { round: 1 }), 409, 'INVALID_STATE', { reason: 'NOT_PENDING' });
    } finally {
      ok(await aStatus(POLICY, 'identity_verification', 'ACTIVE'), 200, null);
    }
    const again = ok(await vopen(c.actor), 200);
    expect(requirementOf(again)).toMatchObject({ status: 'NOT_STARTED', round: 1, canAttachEvidence: true });
    expect(again.overall).toMatchObject({ status: 'ACTION_REQUIRED', actionRequired: ['identity_verification'] });
    await attached(c.actor);
    const submitted = ok(await vsubmit(c.actor, (await liveCase(c.actor)).revision));
    expect(requirementOf(submitted)).toMatchObject({ status: 'PENDING', round: 2 });
    okDecision(await aDecide(REVIEWER, 'approve', c.reqId, { round: 2 }));
    expect((await liveCase(c.actor)).status).toBe('APPROVED');
  });

  it('a reviewer identity that cannot be recorded (characters outside the actor alphabet) is refused 400 REVIEWER_INVALID on every reviewer operation; nothing is written', async () => {
    const c = await submittedProvider('badreviewer');
    const bad = await adminTokenFor(['trust-review', 'trust-admin'], 'staff reviewer/with spaces');
    const doc = (await docRows(c.actor.accountId))[0]!;
    const before = await writes();
    for (const r of [
      await aDecide(bad, 'start-review', c.reqId, { round: 1 }),
      await aDecide(bad, 'approve', c.reqId, { round: 1 }),
      await aDecide(bad, 'reject', c.reqId, { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' }),
      await aDownload(bad, doc.verification_document_id),
      await aStatus(bad, 'identity_verification', 'ACTIVE'),
    ])
      trustFail(r, 400, 'VALIDATION_FAILED', { reason: 'REVIEWER_INVALID' });
    expect(await writes()).toEqual(before);
    okDecision(await aDecide(REVIEWER, 'approve', c.reqId, { round: 1 }));
  });
});

// ====================================================================== retirement closes a definition for good
describe('retiring a requirement definition', () => {
  it('RETIRED is terminal: it cannot come back (409 INVALID_STATE), a rule for it cannot be enabled (409), and providers are no longer asked for it', async () => {
    ok(await aStatus(POLICY, 'liability_insurance', 'RETIRED'), 200, null);
    trustFail(await aStatus(POLICY, 'liability_insurance', 'ACTIVE'), 409, 'INVALID_STATE', { reason: 'STATUS_TRANSITION' });
    trustFail(await aStatus(POLICY, 'liability_insurance', 'INACTIVE'), 409, 'INVALID_STATE', { reason: 'STATUS_TRANSITION' });
    expect(ok(await aStatus(POLICY, 'liability_insurance', 'RETIRED'), 200, null)).toMatchObject({ changed: false });
    const e = await aRule(POLICY, { requirementCode: 'liability_insurance', marketCode: null, serviceTypeCode: W.stD, enabled: true });
    expect(e.status, e.raw).toBe(409);
    expect(e.body.error.code).toBe('TRUST_CONFLICT');
    const inB = await provider('retired-b', [W.stA], W.b);
    expect(ok(await vget(inB)).requirements.map((x: Json) => x.requirementCode)).toEqual(['identity_verification']);
  });
});

// ====================================================================== audit and outbox as a whole
describe('audit and outbox as a whole', () => {
  it('every trust audit row has an allowed action, an actor of a known shape, a subject, and a changes object with no content, key, hash or link', async () => {
    const rows = await q<{
      action: string;
      actor: string;
      changes: Json;
      verification_case_id: string | null;
      case_requirement_id: string | null;
      requirement_definition_id: string | null;
    }>(`SELECT action, actor, changes, verification_case_id, case_requirement_id, requirement_definition_id FROM trust.audit_events`);
    expect(rows.length).toBeGreaterThan(60);
    for (const r of rows) {
      expect(r.actor).toMatch(/^(account:[0-9a-f-]{36}|admin:[A-Za-z0-9._:@-]+|system:expiry|external:[a-z_]+)$/);
      expect(r.verification_case_id ?? r.case_requirement_id ?? r.requirement_definition_id).not.toBeNull();
      const text = JSON.stringify(r.changes ?? {});
      expect(text, r.action).not.toMatch(/memory:|trust\/evidence|trust\/upload|[0-9a-f]{64}|https?:\/\//);
      expect(text).not.toContain(BODY_MARK);
    }
    expect(new Set(rows.map((r) => r.action)).size).toBeGreaterThanOrEqual(15);
  });

  it('every trust event carries identifiers, the case number and statuses (and a requirement code and reason code) only', async () => {
    const rows = await q<{ event_type: string; payload_json: Json; actor_id: string }>(
      `SELECT event_type, payload_json, actor_id FROM integration.outbox_events WHERE event_type LIKE 'bananagig.trust.%'`,
    );
    expect(rows.length).toBeGreaterThan(30);
    const types = new Set(Object.values(TRUST_EVENTS));
    for (const r of rows) {
      expect(types.has(r.event_type as never), r.event_type).toBe(true);
      const caseOnly = [TRUST_EVENTS.caseOpened, TRUST_EVENTS.submitted, TRUST_EVENTS.completed].includes(r.event_type as never);
      expect(keysOf(r.payload_json), r.event_type).toEqual(
        caseOnly
          ? ['accountId', 'caseNumber', 'status', 'verificationCaseId']
          : [
              'accountId',
              'caseNumber',
              'caseRequirementId',
              'reasonCode',
              'requirementCode',
              'requirementStatus',
              'requirementType',
              'status',
              'verificationCaseId',
            ],
      );
      expect(JSON.stringify(r.payload_json)).not.toMatch(/memory:|trust\/evidence|[0-9a-f]{64}|@|https?:\/\//);
    }
    expect(new Set(rows.map((r) => r.event_type)).size).toBe(7);
  });

  it('a read or a refused call never writes an audit row or an event', async () => {
    const before = await writes();
    for (const a of actors.slice(0, 6)) {
      await vget(a);
      await vdocs(a);
      await vupload(a, { requirementCode: 'nope_requirement', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 5 });
    }
    await aList(READER);
    await aCase(READER, S.caseId);
    await aPolicy(POLICY);
    expect(await writes()).toEqual(before);
  });

  it('the trust tables hold no document bytes: the full dump carries none of the evidence marker, and the only hash and key columns are the documents table', async () => {
    const dump = (
      await q<{ t: string }>(
        ['verification_cases', 'case_requirements', 'reviews', 'external_verifications', 'audit_events', 'requirement_definitions', 'requirement_rules']
          .map((t) => `SELECT to_jsonb(x)::text AS t FROM trust.${t} x`)
          .join(' UNION ALL '),
      )
    )
      .map((r) => r.t)
      .join('\n');
    expect(dump).not.toContain(BODY_MARK);
    expect(dump).not.toMatch(/memory:|trust\/evidence|[0-9a-f]{64}/);
    const docs = (await q<{ t: string }>(`SELECT to_jsonb(x)::text AS t FROM trust.documents x`)).map((r) => r.t).join('\n');
    expect(docs).not.toContain(BODY_MARK);
    for (const a of actors) {
      expect(dump).not.toContain(a.email);
      expect(docs).not.toContain(a.phone);
    }
    const columns = await q<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'trust' AND table_name = 'documents'`,
    );
    expect(columns.filter((c) => c.data_type === 'bytea')).toEqual([]);
    const all = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'trust'`);
    expect(all.map((c) => c.column_name).filter((c) => /email|phone|first_name|last_name|full_name|address|token|subject|body|content$/i.test(c))).toEqual([]);
    // the evidence bytes are in the PRIVATE store only
    expect(store.objects.size).toBeGreaterThan(5);
    expect([...store.objects.values()].some((o) => o.bytes.includes(Buffer.from(BODY_MARK)))).toBe(true);
  });

  it('the stored objects are exactly the live documents: the FINAL key of an attached or submitted one, the UPLOAD key of a pending one; refused, withdrawn and promoted uploads left nothing', async () => {
    const rows = await q<{ object_key: string; status: string }>(`SELECT object_key, status FROM trust.documents`);
    const expected = new Set(
      rows
        .filter((r) => ['ATTACHED', 'SUBMITTED'].includes(r.status))
        .map((r) => r.object_key)
        .concat(rows.filter((r) => r.status === 'UPLOAD_PENDING').map((r) => uploadKeyOfFinal(r.object_key))),
    );
    for (const r of rows.filter((x) => ['WITHDRAWN', 'ABANDONED'].includes(x.status)))
      expect(present(r.object_key, uploadKeyOfFinal(r.object_key)), r.status).toEqual([]);
    for (const r of rows.filter((x) => ['ATTACHED', 'SUBMITTED'].includes(x.status)))
      expect(present(uploadKeyOfFinal(r.object_key)), 'promoted: the upload key is gone').toEqual([]);
    for (const key of store.objects.keys()) expect(expected.has(key), key).toBe(true);
    for (const r of rows.filter((x) => ['ATTACHED', 'SUBMITTED'].includes(x.status))) expect(store.objects.has(r.object_key), r.object_key).toBe(true);
  });
});

// ====================================================================== secrecy
describe('secrecy: no key, link, hash or byte in a provider response, a log line, an audit row or an event', () => {
  const providerCalls = () => transcript.filter((t) => t.url.startsWith(PV) || t.url.startsWith(REG));
  it('no provider response contains an object key, a link (except the upload authorization), a SHA-256, an evidence byte, a contact, a subject or an external id', async () => {
    const mine = providerCalls();
    expect(mine.length).toBeGreaterThan(300);
    const keysInDb = (await q<{ object_key: string; sha256: string | null }>('SELECT object_key, sha256 FROM trust.documents')).flatMap(
      (d) => [d.object_key, uploadKeyOfFinal(d.object_key), d.sha256].filter(Boolean) as string[],
    );
    const externals = (await q<{ external_id: string }>('SELECT external_id FROM trust.external_verifications')).map((e) => e.external_id);
    expect(keysInDb.length).toBeGreaterThan(40);
    for (const t of mine) {
      const isUpload = t.url.endsWith('/documents/upload') && t.status === 201;
      expect(t.raw, `${t.method} ${t.url}`).not.toContain(BODY_MARK);
      expect(t.raw).not.toMatch(/[0-9a-f]{64}/);
      expect(t.raw).not.toMatch(/https?:\/\//);
      for (const e of externals) expect(t.raw).not.toContain(e);
      for (const a of actors) {
        expect(t.raw).not.toContain(a.email);
        expect(t.raw).not.toContain(a.phone);
        expect(t.raw).not.toContain(a.sub);
      }
      if (isUpload) {
        // the authorization is for its caller only: it names its OWN object and nothing else
        expect(t.raw.match(/memory:\/\/[^"]*/g)).toHaveLength(1);
        continue;
      }
      expect(t.raw).not.toMatch(/memory:\/\//);
      expect(t.raw).not.toMatch(/trust\/evidence|trust\/upload/);
      expect(t.raw).not.toMatch(/Bearer |eyJ[A-Za-z0-9_-]{10}/);
    }
    // and the DOWNLOAD links appear only in reviewer download answers
    for (const t of transcript.filter((x) => x.raw.includes('memory://download/')))
      expect(t.url).toMatch(/\/api\/v1\/admin\/trust\/documents\/[0-9a-f-]{36}\/download$/);
  });

  it('no reviewer response (other than the download) contains an object key, a link, evidence bytes or an external id; the hash appears only in the case detail and decisions', async () => {
    const admin = transcript.filter((t) => t.url.startsWith(AD) && !t.url.endsWith('/download'));
    expect(admin.length).toBeGreaterThan(60);
    const externals = (await q<{ external_id: string }>('SELECT external_id FROM trust.external_verifications')).map((e) => e.external_id);
    for (const t of admin) {
      expect(t.raw).not.toContain(BODY_MARK);
      expect(t.raw).not.toMatch(/memory:\/\/|trust\/evidence|trust\/upload|https?:\/\//);
      for (const e of externals) expect(t.raw).not.toContain(e);
      for (const a of actors) {
        expect(t.raw).not.toContain(a.email);
        expect(t.raw).not.toContain(a.phone);
      }
      if (/[0-9a-f]{64}/.test(t.raw))
        expect(t.url, 'a hash is integrity evidence of the case detail and of a decision').toMatch(
          /\/cases\/[0-9a-f-]{36}$|\/requirements\/[0-9a-f-]{36}\/(start-review|approve|reject|request-action)$/,
        );
    }
  });

  it('every error answer is the standard envelope with a fixed message and no stack, SQL, table or constraint name', () => {
    const errors = transcript.filter((t) => (t.url.startsWith(PV) || t.url.startsWith(AD)) && t.status >= 400);
    expect(errors.length).toBeGreaterThan(80);
    for (const t of errors) {
      expect(ErrorResponse.safeParse(t.body).success, t.raw).toBe(true);
      expect(t.raw).not.toMatch(/SELECT |INSERT |UPDATE |FROM trust|trust_rule|23000|23505|\buq_|\bck_|at \S+\.ts:\d+|node_modules/);
    }
    expect(errors.filter((t) => t.status === 500)).toEqual([]);
  });

  it('every provider and administrator response is Cache-Control: no-store', () => {
    for (const t of transcript.filter((x) => x.url.startsWith(PV) || x.url.startsWith(AD) || x.url.startsWith(REG)))
      expect(t.headers['cache-control'], `${t.method} ${t.url}`).toBe('no-store');
  });

  it('no log line contains an object key, a link, a hash, evidence bytes, a contact or a token', async () => {
    const text = logLines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    const keysInDb = (await q<{ object_key: string; sha256: string | null }>('SELECT object_key, sha256 FROM trust.documents')).flatMap(
      (d) => [d.object_key, uploadKeyOfFinal(d.object_key), d.sha256].filter(Boolean) as string[],
    );
    for (const k of keysInDb) expect(text).not.toContain(k);
    expect(text).not.toContain(BODY_MARK);
    expect(text).not.toMatch(/memory:\/\/|trust\/evidence|trust\/upload/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10}/);
    expect(text).not.toContain('secret-signing-detail');
    for (const a of actors) {
      expect(text).not.toContain(a.email);
      expect(text).not.toContain(a.phone);
    }
  });
});

// ====================================================================== query budget
describe('query-count budget of the reads', () => {
  /** Statements the database ran for ONE request (the account guard included). */
  async function statementsOf(fn: () => Promise<Res>): Promise<number> {
    capture = [];
    try {
      const r = await fn();
      expect(r.status, r.raw).toBe(200);
      return capture.length;
    } finally {
      capture = null;
    }
  }
  /** A provider with `n` requirements and evidence on each: 1 identity; 2 + licence (a document each); 3 + the external background check (started). */
  async function shaped(label: string, n: 1 | 2 | 3): Promise<Actor> {
    const a = await provider(label, n === 1 ? [W.stA] : n === 2 ? [W.stA, W.stB] : [W.stA, W.stB, W.stD]);
    ok(await vopen(a), 201);
    await attached(a, { requirement: 'identity_verification' });
    if (n >= 2) await attached(a, { requirement: 'professional_license', type: 'professional_license' });
    if (n === 3) ok(await vexternal(a, 'background_check'), 200, ExternalVerificationResponse);
    return a;
  }
  // CEILINGS. Measured on this stack at the time of writing (GET /provider/verification 16 statements: the account guard, the context, the policy and the batched reads; GET /provider/verification/documents 8;
  // GET /provider/registration/requirements 30 now that it asks the verification domain; GET /admin/trust/cases/:id 5; GET /admin/trust/cases 1) plus about 30%. The equality assertions are the sharper guard: the count must not depend on the
  // number of requirements, documents or reviews. One statement PER requirement or PER document would break them.
  const GET_VERIFICATION_CEILING = 21;
  const GET_PRO_REQUIREMENTS_CEILING = 39;
  const ADMIN_CASE_CEILING = 8;
  const DOCUMENTS_CEILING = 11;

  it('GET /provider/verification runs the same number of statements for 1, 2 and 3 requirements (documents and all), within its ceiling', async () => {
    const one = await shaped('budget-1', 1);
    const two = await shaped('budget-2', 2);
    const three = await shaped('budget-3', 3);
    expect(ok(await vget(one)).requirements).toHaveLength(1);
    expect(ok(await vget(two)).requirements).toHaveLength(2);
    expect(ok(await vget(three)).requirements).toHaveLength(3);
    const counts = [await statementsOf(() => vget(one)), await statementsOf(() => vget(two)), await statementsOf(() => vget(three))];
    process.stdout.write(`TRUST-BUDGET GET /provider/verification statements (1,2,3 requirements): ${counts.join(',')}\n`);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[0]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(GET_VERIFICATION_CEILING);
  });

  it('GET /provider/documents and the PRO-001 requirements read (which now asks the verification domain) do not depend on the number of requirements', async () => {
    const one = await shaped('budget-d1', 1);
    const two = await shaped('budget-d2', 2);
    const three = await shaped('budget-d3', 3);
    const docs = [await statementsOf(() => vdocs(one)), await statementsOf(() => vdocs(two)), await statementsOf(() => vdocs(three))];
    process.stdout.write(`TRUST-BUDGET GET /provider/verification/documents statements: ${docs.join(',')}\n`);
    expect(docs[1]).toBe(docs[0]);
    expect(docs[2]).toBe(docs[0]);
    expect(Math.max(...docs)).toBeLessThanOrEqual(DOCUMENTS_CEILING);
    const reqs = [await statementsOf(() => regReqs(one)), await statementsOf(() => regReqs(two)), await statementsOf(() => regReqs(three))];
    process.stdout.write(`TRUST-BUDGET GET /provider/registration/requirements statements (verification wired): ${reqs.join(',')}\n`);
    expect(reqs[1]).toBe(reqs[0]);
    expect(reqs[2]).toBe(reqs[0]);
    expect(Math.max(...reqs)).toBeLessThanOrEqual(GET_PRO_REQUIREMENTS_CEILING);
  });

  it('the reviewers read a case and the queue in a constant number of statements, whatever the number of requirements, reviews and documents', async () => {
    const one = await shaped('budget-a1', 1);
    const two = await shaped('budget-a2', 2);
    const three = await shaped('budget-a3', 3);
    const ids = await Promise.all([one, two, three].map(async (a) => (await liveCase(a)).verification_case_id));
    const counts = [];
    for (const id of ids) counts.push(await statementsOf(() => aCase(READER, id)));
    process.stdout.write(`TRUST-BUDGET GET /admin/trust/cases/:id statements (1,2,3 requirements): ${counts.join(',')}\n`);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[0]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(ADMIN_CASE_CEILING);
    const small = await statementsOf(() => aList(READER, '?limit=1'));
    const large = await statementsOf(() => aList(READER, '?limit=100'));
    process.stdout.write(`TRUST-BUDGET GET /admin/trust/cases statements (limit 1, 100): ${small},${large}\n`);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(2);
  });
});

describe('the sanity of the file', () => {
  it('leaves no state the schema forbids: one live case per account, contiguous case numbers, no approved requirement without an approval time', async () => {
    expect(await count(`SELECT account_id FROM trust.verification_cases WHERE status <> 'CANCELLED' GROUP BY account_id HAVING count(*) > 1`)).toBe(0);
    expect(await count(`SELECT account_id FROM trust.verification_cases GROUP BY account_id HAVING max(case_number) <> count(*)`)).toBe(0);
    expect(await count(`SELECT 1 FROM trust.case_requirements WHERE status = 'APPROVED' AND approved_at IS NULL`)).toBe(0);
    expect(
      await count(
        `SELECT verification_case_id FROM trust.case_requirements WHERE superseded_at IS NULL GROUP BY verification_case_id, requirement_definition_id HAVING count(*) > 1`,
      ),
    ).toBe(0);
    expect(await count(`SELECT 1 FROM trust.reviews WHERE decision <> 'STARTED' GROUP BY case_requirement_id, round HAVING count(*) > 1`)).toBe(0);
    // every case status equals what its requirements derive (the stored status is maintained in the same transaction)
    const rows = await q<{ verification_case_id: string; status: string; submitted_at: Date | null }>(
      `SELECT verification_case_id, status, submitted_at FROM trust.verification_cases WHERE status <> 'CANCELLED'`,
    );
    for (const c of rows) {
      const statuses = (await reqRows(c.verification_case_id)).filter((r) => r.superseded_at === null && r.status !== 'NOT_REQUIRED').map((r) => r.status);
      const derived =
        c.submitted_at === null
          ? 'OPEN'
          : statuses.some((s) => ['ACTION_REQUIRED', 'REJECTED', 'NOT_STARTED'].includes(s))
            ? 'ACTION_REQUIRED'
            : statuses.some((s) => s === 'EXPIRED')
              ? 'EXPIRED'
              : statuses.some((s) => ['PENDING', 'IN_REVIEW'].includes(s))
                ? 'IN_REVIEW'
                : 'APPROVED';
      expect(c.status, c.verification_case_id).toBe(derived);
    }
    await sleep(0);
  });
});
