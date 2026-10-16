// ID-005 consent and legal-version history over HTTP, on the REAL stack of services: the real Fastify app (buildApp), the real AccountService, SecurityService, ConsentService
// (with the configuration-backed policy provider of the composition root), ContentService and ConfigurationService on one real, isolated PostgreSQL (migration 0013 seeds the
// two LEGAL document shells, the two purposes, the four consent parameters and the consent copy), the real auth plugin and forged-but-signed tokens carrying `sid` and
// `auth_time`. Keycloak is the FakeSecurityIdentityProvider; the rate limiter is the in-memory one. The legal documents are published through the REAL content workflow
// (draft, submit, approval by a SECOND approver, publish, activateDue) and the consent policy is changed through the REAL configuration change-request workflow with two
// approvers. The unit layer (`consent.test.ts`) proves the HTTP edge with a fake service; this file proves the behaviour with the database.
//
// What this file proves end to end: the seeded state (every required purpose DOCUMENT_UNAVAILABLE until Legal publishes); publication and acceptance over HTTP with the
// version id, locale and hash taken from the requirements and cross-checked against the PUBLIC content resolver; idempotent repeats; the exact parity of the version in
// force with ContentService.resolve (before and after publication, scheduled, superseded, window boundary, inactive locale and entry, a COUNTRY-scoped version that must not
// count); re-acceptance under the three configured modes; roles (union, pending provider); the second locale (EXACT: no fallback); every refusal with its code and a uniform
// body; the strict path, query and body; withdrawal; policy outages (503); account isolation, the admin context, suspended/closed accounts, revoked sessions; atomicity
// (audit and outbox in the same transaction, proved with a failing trigger); HTTP-level concurrency (identical accepts, accept vs withdraw, accept racing a real
// publication); and a secrecy and caching sweep over every response, header, audit row, outbox payload, table dump and captured log line.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  AccountService,
  ConsentService,
  FakeSecurityIdentityProvider,
  SecurityService,
  type ConsentPolicyProvider,
  type SecurityPolicyProvider,
} from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentError, ContentService } from '@bananagig/content';
import {
  AcceptConsentResponse,
  AccountConsentsResponse,
  CONSENT_EVENTS,
  ConsentRequirementsResponse,
  CORRELATION_HEADER,
  ErrorResponse,
  WithdrawConsentResponse,
} from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { MemoryRateLimiter } from '@bananagig/platform';
import { createDatabase, type Database } from '@bananagig/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createSecurityPolicyProvider } from './modules/security/wiring';

// ---------------------------------------------------------------- the real stack
const HASH_KEY = 'itest-consent-hash-key-'.concat('k'.repeat(28));
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', VERIFICATION_HASH_SECRET: HASH_KEY } });
const REALM = cfg.identity.realm;

const AUTHOR = 'legal:author';
const APPROVER = 'legal:approver';
const CFG_AUTHOR = 'cfg:author';
const CFG_APPROVER = 'cfg:approver';
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const TERMS_KEY = 'legal.terms_of_service';
const PRIVACY_KEY = 'legal.privacy_policy';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BODY_MARK = 'ITESTLEGALBODY';

let iso: IsolatedDatabase;
let bigDb: Database;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let consent: ConsentService;
let securityPolicy: SecurityPolicyProvider;
const provider = new FakeSecurityIdentityProvider();
const limiter = new MemoryRateLimiter();
const extraApps: FastifyInstance[] = [];
/** When set, the policy provider of the main app serves this instead of the configuration registry (an outage when it throws). */
let policyOverride: (() => Promise<never>) | null = null;
let realPolicy: ConsentPolicyProvider;
const policyProvider: ConsentPolicyProvider = { policy: (code) => (policyOverride ? policyOverride() : realPolicy.policy(code)) };

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
  /** What the request carried (parsed JSON, or the raw text when it was not JSON). */
  sent: unknown;
}
/** Every response of the file, so the last tests can prove the secrecy, caching and contract rules over ALL of them. */
const transcript: Res[] = [];
/** Everything that must never show up anywhere it does not belong. */
const secrets = { tokens: [] as string[], sids: [] as string[], subjects: [] as string[], bodies: [] as string[], serverMarkers: [] as string[] };

interface Tok {
  token: string;
  sid: string;
}
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  t0: Tok;
}
interface MintOptions {
  sid?: string | null;
  authTime?: number | null;
  claims?: Record<string, unknown>;
  inProvider?: boolean;
}
interface CallOptions {
  body?: unknown;
  /** Sent verbatim with a JSON content type. */
  rawBody?: string;
  headers?: Record<string, string>;
  app?: FastifyInstance;
  /** The token to present (default: the actor's first session); null sends no Authorization header; a string is sent verbatim. */
  as?: Tok | string | null;
  cid?: string;
}

const appNow = (): number => Math.floor(Date.now() / 1000);

async function mint(a: Pick<Actor, 'sub'>, o: MintOptions = {}): Promise<Tok> {
  const sid = o.sid === null ? undefined : (o.sid ?? randomUUID());
  const authTime = o.authTime === null ? undefined : (o.authTime ?? appNow() - 5);
  const token = await signToken(keys, {
    claims: { sub: a.sub, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...o.claims },
    ...(sid === undefined ? { omit: ['sid'] } : { sid }),
    ...(authTime === undefined ? {} : { authTime }),
  });
  secrets.tokens.push(token);
  if (sid !== undefined) {
    secrets.sids.push(sid);
    if (o.inProvider !== false) provider.addSession(a.sub, sid);
  }
  return { token, sid: sid ?? '' };
}

async function call(actor: Actor | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: CallOptions = {}): Promise<Res> {
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const as = o.as === undefined ? actor?.t0 : o.as;
  const token = as === null || as === undefined ? undefined : typeof as === 'string' ? as : as.token;
  const cid = o.cid ?? o.headers?.[CORRELATION_HEADER] ?? randomUUID();
  const path = url.startsWith('/api/') ? url : `/api/v1${url}`;
  const payload = hasBody ? (o.rawBody ?? JSON.stringify(o.body)) : undefined;
  const r = await (o.app ?? app).inject({
    method,
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      [CORRELATION_HEADER]: cid,
      ...o.headers,
    },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: Json;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  let sent: unknown;
  if (payload !== undefined) {
    try {
      sent = JSON.parse(payload);
    } catch {
      sent = payload;
    }
  }
  const res: Res = { method, url: path, status: r.statusCode, body, headers: r.headers, raw: r.body, cid, sent };
  transcript.push(res);
  return res;
}

// ---------------------------------------------------------------- contract shapes
const SHAPES: Record<string, z.ZodType> = {
  getAccountConsents: AccountConsentsResponse,
  getAccountConsentRequirements: ConsentRequirementsResponse,
  acceptAccountConsent: AcceptConsentResponse,
  withdrawAccountConsent: WithdrawConsentResponse,
};
const shapeChecked = new Set<string>();
const OP = {
  consents: 'getAccountConsents',
  requirements: 'getAccountConsentRequirements',
  accept: 'acceptAccountConsent',
  withdraw: 'withdrawAccountConsent',
} as const;

/** A 200 with the standard envelope; with an operation id the body must also equal its contract exactly (no field missing, none extra). */
const ok = (r: Res, op?: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(200);
  expect(Object.keys(r.body).sort(), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  if (op) {
    const parsed = SHAPES[op]!.safeParse(r.body);
    expect(parsed.success, `${op}: ${r.raw}`).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), `${op} carries no field outside its contract`).toEqual(r.body);
    shapeChecked.add(op);
  }
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId, 'the error carries the correlation id of the request').toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control'], `${r.method} ${r.url} ${code}`).toBe('no-store');
  return r.body.error;
};
const SESSION_REVOKED_CHALLENGE = `Bearer realm="${REALM}", error="invalid_token"`;
/** The fixed consent failure: code, status, the managed message key and nothing else in `details`. */
const consentFail = (r: Res, status: number, code: string, messageKey: string): Json => {
  const e = fail(r, status, code);
  expect(e.details, r.raw).toEqual({ messageKey });
  return e;
};
/** The error body without the per-request correlation id: two uniform answers must be identical. */
const bare = (r: Res): unknown => {
  const { correlationId: _c, ...rest } = r.body.error;
  return rest;
};

// ---------------------------------------------------------------- routes
const CONS = '/account/consents';
const getConsents = (a: Actor, o?: CallOptions) => call(a, 'GET', CONS, o);
const getReqs = (a: Actor, locale?: string, o?: CallOptions) => call(a, 'GET', `${CONS}/requirements${locale === undefined ? '' : `?locale=${locale}`}`, o);
interface Claim {
  versionId: string;
  locale: string;
  bodySha256: string;
}
const acceptRaw = (a: Actor, purpose: string, body: unknown, o?: CallOptions) => call(a, 'POST', `${CONS}/${purpose}/accept`, { ...o, body });
const acceptDoc = (a: Actor, purpose: string, p: Pub, o?: CallOptions) => acceptRaw(a, purpose, claimOf(p), o);
const withdraw = (a: Actor, purpose: string, o?: CallOptions) => call(a, 'POST', `${CONS}/${purpose}/withdraw`, o);
const me = (a: Actor, o?: CallOptions) => call(a, 'GET', '/account/me', o);
const claimOf = (p: Pub): Claim => ({ versionId: p.versionId, locale: p.locale, bodySha256: p.hash });
const rowOf = (data: Json, code: string): Json => {
  const row = data.requirements.find((r: Json) => r.purposeCode === code);
  expect(row, `requirement ${code}`).toBeDefined();
  return row;
};

// ---------------------------------------------------------------- the database
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const dbEpoch = async (): Promise<number> => Number((await q<{ e: number }>('SELECT extract(epoch FROM clock_timestamp())::float8 AS e'))[0]!.e);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitUntilDb = async (epoch: number): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((await dbEpoch()) >= epoch) return;
    await sleep(40);
  }
  throw new Error('the database clock did not reach the expected instant');
};
interface EventRow {
  consent_event_id: string;
  account_id: string;
  purpose_code: string;
  event_seq: number;
  event_type: string;
  version_id: string;
  locale: string;
  body_sha256: string;
  occurred_at: Date;
  source: string;
  application_session_id: string | null;
  correlation_id: string;
}
const eventRows = (accountId: string, purpose?: string) =>
  q<EventRow>(`SELECT * FROM identity.consent_events WHERE account_id = $1 AND ($2::text IS NULL OR purpose_code = $2) ORDER BY purpose_code, event_seq`, [
    accountId,
    purpose ?? null,
  ]);
interface AuditRow {
  action: string;
  actor: string;
  changes: Json;
  consent_event_id: string | null;
  correlation_id: string;
  application_session_id: string | null;
  reason: string | null;
}
const auditRows = (accountId: string) =>
  q<AuditRow>(
    `SELECT action, actor, changes, consent_event_id, correlation_id, application_session_id, reason FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'CONSENT\\_%' ORDER BY occurred_at, audit_event_id`,
    [accountId],
  );
interface OutboxRow {
  event_type: string;
  payload_json: Json;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
}
const outboxRows = (accountId: string) =>
  q<OutboxRow>(
    `SELECT event_type, payload_json, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.consent-%' ORDER BY created_at, outbox_event_id`,
    [accountId],
  );
const counts = async (accountId: string) => ({
  events: (await eventRows(accountId)).length,
  audit: (await auditRows(accountId)).length,
  outbox: (await outboxRows(accountId)).length,
});
/** Counters of everything the consent layer writes (and the account layer around it), to prove a refused request changed nothing. */
const writes = async () => ({
  events: await count('SELECT 1 FROM identity.consent_events'),
  audit: await count(`SELECT 1 FROM identity.account_audit_events WHERE action LIKE 'CONSENT\\_%'`),
  outbox: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.consent-%'`),
  accounts: await count('SELECT 1 FROM identity.accounts'),
  sessions: await count('SELECT 1 FROM identity.application_sessions'),
  purposes: await count('SELECT 1 FROM identity.consent_purposes'),
  versions: await count('SELECT 1 FROM content.versions'),
});

// ---------------------------------------------------------------- actors
async function newActor(label: string, o: { roles?: string[]; first?: MintOptions } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  secrets.subjects.push(sub);
  const a: Actor = { label, sub, accountId: '', t0: undefined as unknown as Tok };
  provider.setUser(sub);
  a.t0 = await mint(a, { ...o.first, claims: { realm_access: { roles: o.roles ?? ['customer'] }, ...o.first?.claims } });
  const created = await me(a); // the account and its first session are created by the first authenticated request
  expect(created.status, created.raw).toBe(200);
  a.accountId = created.body.data.accountId;
  return a;
}
/** A further Keycloak session (login) of the same person. */
async function login(a: Actor): Promise<Tok> {
  const t = await mint(a);
  expect((await me(a, { as: t })).status).toBe(200);
  return t;
}
const sessionRowOf = async (sid: string) =>
  (
    await q<{ application_session_id: string; account_id: string }>(
      'SELECT application_session_id, account_id FROM identity.application_sessions WHERE keycloak_session_id = $1',
      [sid],
    )
  )[0];
const grant = (a: Actor, role: 'CUSTOMER' | 'PROVIDER', pending = false) =>
  accounts.grantRole(a.accountId, role, { actor: 'system:itest', source: 'SYSTEM', reason: 'itest', ...(pending ? { pending: true } : {}) });
const revokeRole = (a: Actor, role: 'CUSTOMER' | 'PROVIDER') => accounts.deactivateRole(a.accountId, role, { actor: 'system:itest', reason: 'itest' });

// ---------------------------------------------------------------- legal documents through the REAL content workflow
interface Pub {
  entryKey: string;
  versionId: string;
  version: number;
  locale: string;
  hash: string;
  body: string;
  status: string;
}
type Stage = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'PUBLISHED';
let bodySeq = 0;
/** create -> submit -> approve (a SECOND approver) -> publish, stopping at `stage`. */
async function makeVersion(
  entryKey: string,
  o: { stage?: Stage; locale?: string; from?: Date; to?: Date; scope?: { type: 'COUNTRY' | 'MARKET'; ref: string } } = {},
): Promise<Pub> {
  const stage = o.stage ?? 'PUBLISHED';
  const body = `${BODY_MARK} ${randomUUID()} legal text number ${++bodySeq} of ${entryKey}`;
  secrets.bodies.push(body);
  const created = await content.createVersion(
    entryKey,
    {
      locale: o.locale ?? 'en-US',
      body,
      reason: 'itest',
      ...(o.from ? { effectiveFrom: o.from.toISOString() } : {}),
      ...(o.to ? { effectiveTo: o.to.toISOString() } : {}),
      ...(o.scope ? { scopeType: o.scope.type, scopeRef: o.scope.ref } : {}),
    },
    AUTHOR,
  );
  let cur = created;
  if (stage !== 'DRAFT') {
    if (stage === 'CANCELLED') cur = await content.cancel(created.versionId, AUTHOR);
    else {
      cur = await content.submit(created.versionId, AUTHOR);
      if (stage === 'REJECTED') cur = await content.reject(created.versionId, APPROVER, 'no');
      else if (stage !== 'IN_REVIEW') {
        cur = await content.approve(created.versionId, APPROVER, 'ok');
        if (stage === 'PUBLISHED') cur = await content.publish(created.versionId, AUTHOR);
      }
    }
  }
  return { entryKey, versionId: cur.versionId, version: cur.version, locale: cur.locale, hash: cur.bodySha256, body, status: cur.status };
}
const publishLegal = (entryKey: string, o: { locale?: string; from?: Date; to?: Date } = {}) => makeVersion(entryKey, o);

// ---------------------------------------------------------------- configuration through the REAL change-request workflow
async function setConfig(key: string, value: unknown): Promise<void> {
  const cr = await configuration.createChangeRequest({ parameterKey: key, scopeType: 'PLATFORM', scopeRef: null, value, reason: 'itest change' }, CFG_AUTHOR);
  await configuration.submit(cr.changeRequestId, CFG_AUTHOR);
  await configuration.approve(cr.changeRequestId, CFG_APPROVER, 'ok');
  const published = await configuration.publish(cr.changeRequestId, CFG_AUTHOR);
  expect(published.state).toBe('ACTIVE');
}
type Mode = 'NO_REACCEPT' | 'REACCEPT_FOR_NEW_USERS_ONLY' | 'REACCEPT_REQUIRED';
const requiredForKey = (code: string) => `consent.${code.toLowerCase()}.required_for`;
const reacceptKey = (code: string) => `consent.${code.toLowerCase()}.reacceptance`;
const DEFAULT_REQUIRED = ['CUSTOMER', 'PROVIDER'];
/** Sets the policy of the two seeded purposes (the default is required for both roles, REACCEPT_REQUIRED). */
const setSeededPolicy = async (o: { requiredFor?: string[]; mode?: Mode }): Promise<void> => {
  const jobs: Promise<void>[] = [];
  for (const code of [TERMS, PRIVACY]) {
    if (o.requiredFor) jobs.push(setConfig(requiredForKey(code), o.requiredFor));
    if (o.mode) jobs.push(setConfig(reacceptKey(code), o.mode));
  }
  await Promise.all(jobs);
};
const resetSeededPolicy = () => setSeededPolicy({ requiredFor: DEFAULT_REQUIRED, mode: 'REACCEPT_REQUIRED' });

// ---------------------------------------------------------------- test documents and purposes (a LEGAL entry shell, a purpose and its two parameters)
interface Doc {
  code: string;
  entryKey: string;
  entryId: string;
}
let docSeq = 0;
const registered: Doc[] = [];
async function registerDoc(
  o: { withdrawable?: boolean; requiredFor?: string[]; mode?: Mode; maxScope?: 'PLATFORM' | 'COUNTRY' | 'MARKET'; active?: boolean } = {},
): Promise<Doc> {
  const n = ++docSeq;
  const tag = randomUUID()
    .slice(0, 6)
    .replace(/[^a-f0-9]/g, 'a');
  const entryKey = `legal.itest_${n}_${tag}`;
  const code = `ITEST_${n}_${tag.toUpperCase()}`;
  const entry = await content.createEntry(
    { key: entryKey, contentType: 'LEGAL', ownerRole: 'LEGAL', description: 'itest legal document', variables: [], maxScopeType: o.maxScope ?? 'PLATFORM' },
    AUTHOR,
  );
  await q(`INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy, status) VALUES ($1, $2, $3, $4)`, [
    code,
    entry.entryId,
    o.withdrawable ? 'WITHDRAWABLE' : 'NOT_WITHDRAWABLE',
    o.active === false ? 'INACTIVE' : 'ACTIVE',
  ]);
  const base = {
    dataType: 'JSON' as const,
    ownerRole: 'legal',
    approvalPolicy: 'SECOND_APPROVER' as const,
    criticality: 'CRITICAL' as const,
    isRequired: true,
  };
  await configuration.createParameter(
    {
      ...base,
      key: requiredForKey(code),
      description: 'itest required_for',
      validationRules: { schema: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,29}$' }, uniqueItems: true, maxItems: 10 } },
      allowedOverrideScopes: ['COUNTRY', 'MARKET'],
    },
    CFG_AUTHOR,
  );
  await configuration.createParameter(
    {
      ...base,
      dataType: 'ENUM',
      key: reacceptKey(code),
      description: 'itest reacceptance',
      validationRules: { enum: ['NO_REACCEPT', 'REACCEPT_FOR_NEW_USERS_ONLY', 'REACCEPT_REQUIRED'] },
      allowedOverrideScopes: ['COUNTRY', 'MARKET'],
    },
    CFG_AUTHOR,
  );
  await Promise.all([setConfig(requiredForKey(code), o.requiredFor ?? DEFAULT_REQUIRED), setConfig(reacceptKey(code), o.mode ?? 'REACCEPT_REQUIRED')]);
  const doc = { code, entryKey, entryId: entry.entryId };
  registered.push(doc);
  return doc;
}
const setPurposeStatus = (code: string, status: 'ACTIVE' | 'INACTIVE') =>
  q(`UPDATE identity.consent_purposes SET status = $2, updated_at = now() WHERE purpose_code = $1`, [code, status]);
/** Takes every test purpose out of the evaluation (INACTIVE purposes are skipped), so the seeded-purpose assertions of later tests see only the seeded purposes. */
const retireAll = async (): Promise<void> => {
  await q(`UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE purpose_code LIKE 'ITEST\\_%'`);
};
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------- parity with the content resolver
interface DocView {
  entryKey: string;
  versionId: string;
  version: number;
  locale: string;
  bodySha256: string;
  effectiveFrom: string;
}
/** What the PUBLIC resolver serves for an entry in a locale at the platform scope (no context): null when it has no content. */
async function resolverView(entryKey: string, locale: string, at?: Date): Promise<DocView | null> {
  try {
    const r = await content.resolve(entryKey, { locale, context: {}, includeInternal: false, ...(at ? { at } : {}) });
    if (r.sourceScope !== 'PLATFORM') throw new Error(`the resolver served a ${r.sourceScope} version under an empty context`);
    return {
      entryKey,
      versionId: r.versionId,
      version: r.version,
      locale: r.resolvedLocale,
      bodySha256: r.bodySha256,
      effectiveFrom: r.effectiveFrom.toISOString(),
    };
  } catch (e) {
    if (e instanceof ContentError && (e.code === 'NO_CONTENT' || e.code === 'ENTRY_NOT_FOUND')) return null;
    throw e;
  }
}
/** The version the consent API says is in force for a purpose in a locale. */
async function consentView(a: Actor, code: string, locale: string): Promise<DocView | null> {
  return rowOf(ok(await getReqs(a, locale), OP.requirements), code).document;
}
/** The version in force must be exactly the version the resolver serves (same id, number, locale, hash, start); returns it. */
async function expectParity(a: Actor, doc: Doc, locale: string, label: string): Promise<DocView | null> {
  const before = await resolverView(doc.entryKey, locale);
  const consentSide = await consentView(a, doc.code, locale);
  const after = await resolverView(doc.entryKey, locale);
  expect(after, `${label}: the resolver answer is stable around the comparison`).toEqual(before);
  expect(consentSide, `${label}: consent document equals the resolver answer`).toEqual(before);
  return consentSide;
}

// ---------------------------------------------------------------- variants of the app over the same database
const verifierFor = () =>
  createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: keys.getKey, webClientId: 'bananagig-web', adminClientId: 'bananagig-admin' });
async function makeApp(v: { policy?: ConsentPolicyProvider; defaultLocale?: () => Promise<string> } = {}): Promise<FastifyInstance> {
  const security = new SecurityService({
    database: bigDb,
    policy: securityPolicy,
    identityProvider: provider,
    rateLimiter: limiter,
    hashSecret: HASH_KEY,
  });
  const consentService = new ConsentService({
    database: bigDb,
    policy: v.policy ?? policyProvider,
    defaultLocale: v.defaultLocale ?? createDefaultLocaleResolver(content),
  });
  const instance = await buildApp({
    cfg,
    verifier: verifierFor(),
    configuration,
    content,
    accounts,
    security,
    consent: consentService,
    readiness: async () => ({}),
  });
  await instance.ready();
  extraApps.push(instance);
  if (!consent) consent = consentService;
  return instance;
}

// ---------------------------------------------------------------- log capture (for the whole file)
const logLines: string[] = [];
function captureLogs(): void {
  const capture = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
}

// state shared by the ordered describes below (each describe builds on the previous one, like a story)
const S = {} as {
  terms1: Pub;
  terms2: Pub;
  privacy1: Pub;
  approvedPrivacy: Pub;
  alice: Actor;
  frank: Actor;
};

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 50, connectionTimeoutMs: 30_000 } });
  keys = await createTestKeys('k1');
  configuration = new ConfigurationService({ database: bigDb, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  content = new ContentService({ database: bigDb, env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database: bigDb, lastSeenTouchSeconds: 0 });
  securityPolicy = createSecurityPolicyProvider(configuration);
  realPolicy = createConsentPolicyProvider(configuration);
  captureLogs();
  app = await makeApp();
}, 120_000);
afterAll(async () => {
  for (const a of extraApps) await a.close();
  await bigDb?.close();
  await iso?.drop();
});

// ====================================================================== the seeded state (nothing is published yet)
describe('the seeded state of migration 0013, before Legal publishes anything', () => {
  it('has the two LEGAL shells without a version, the two NOT_WITHDRAWABLE purposes, no event and the four seeded parameters through the real registry', async () => {
    const shells = await q<{ key: string; content_type: string; owner_role: string; fallback_policy: string; max_scope_type: string; versions: string }>(
      `SELECT e.key, e.content_type, e.owner_role, e.fallback_policy, e.max_scope_type, (SELECT count(*) FROM content.versions v WHERE v.entry_id = e.entry_id)::text AS versions
         FROM content.entries e WHERE e.key IN ('legal.terms_of_service', 'legal.privacy_policy') ORDER BY e.key`,
    );
    expect(shells).toEqual([
      { key: PRIVACY_KEY, content_type: 'LEGAL', owner_role: 'LEGAL', fallback_policy: 'EXACT', max_scope_type: 'PLATFORM', versions: '0' },
      { key: TERMS_KEY, content_type: 'LEGAL', owner_role: 'LEGAL', fallback_policy: 'EXACT', max_scope_type: 'PLATFORM', versions: '0' },
    ]);
    expect(await q('SELECT purpose_code, withdrawal_policy, status FROM identity.consent_purposes ORDER BY purpose_code')).toEqual([
      { purpose_code: PRIVACY, withdrawal_policy: 'NOT_WITHDRAWABLE', status: 'ACTIVE' },
      { purpose_code: TERMS, withdrawal_policy: 'NOT_WITHDRAWABLE', status: 'ACTIVE' },
    ]);
    expect(await count('SELECT 1 FROM identity.consent_events')).toBe(0);
    const values = (await configuration.resolveMany([requiredForKey(TERMS), reacceptKey(TERMS), requiredForKey(PRIVACY), reacceptKey(PRIVACY)])).values;
    expect(values.get(requiredForKey(TERMS))!.value).toEqual(DEFAULT_REQUIRED);
    expect(values.get(requiredForKey(PRIVACY))!.value).toEqual(DEFAULT_REQUIRED);
    expect(values.get(reacceptKey(TERMS))!.value).toBe('REACCEPT_REQUIRED');
    expect(values.get(reacceptKey(PRIVACY))!.value).toBe('REACCEPT_REQUIRED');
  });

  it('GET /account/consents/requirements: both purposes are required and DOCUMENT_UNAVAILABLE, with no document and no acceptance; satisfied is false', async () => {
    const a = await newActor('seed-customer');
    const data = ok(await getReqs(a), OP.requirements);
    expect(data.locale).toBe('en-US');
    expect(data.requirements.map((r: Json) => r.purposeCode)).toEqual([PRIVACY, TERMS]);
    for (const r of data.requirements) {
      expect(r).toMatchObject({
        required: true,
        status: 'DOCUMENT_UNAVAILABLE',
        acceptanceState: 'NONE',
        withdrawable: false,
        reacceptance: 'REACCEPT_REQUIRED',
        document: null,
        accepted: null,
      });
      expect(r.labelContentKey).toBe(`account.consent.purpose.${r.purposeCode.toLowerCase()}`);
    }
    expect(data.satisfied).toBe(false);
    expect(data.outstanding).toEqual([PRIVACY, TERMS]);
    // the explicit locale gives the same answer; a CUSTOMER and a PROVIDER account are both required (seeded policy), an account without a role is required of nothing
    expect(ok(await getReqs(a, 'en-US'), OP.requirements)).toEqual(data);
    const provider1 = await newActor('seed-provider', { roles: ['provider'] });
    expect(ok(await getReqs(provider1), OP.requirements).requirements.map((r: Json) => r.required)).toEqual([true, true]);
    const nobody = await newActor('seed-norole', { roles: [] });
    const none = ok(await getReqs(nobody), OP.requirements);
    expect(none.requirements.map((r: Json) => [r.status, r.required])).toEqual([
      ['NOT_REQUIRED', false],
      ['NOT_REQUIRED', false],
    ]);
    expect(none.satisfied).toBe(true);
    expect(none.outstanding).toEqual([]);
  });

  it('GET /account/consents: both purposes are NONE with no latest event, the history is empty and nothing is withdrawable', async () => {
    const a = await newActor('seed-list');
    const data = ok(await getConsents(a), OP.consents);
    expect(data.history).toEqual([]);
    expect(data.current).toEqual([
      { purposeCode: PRIVACY, labelContentKey: 'account.consent.purpose.privacy_policy', state: 'NONE', withdrawable: false, latest: null },
      { purposeCode: TERMS, labelContentKey: 'account.consent.purpose.terms_of_service', state: 'NONE', withdrawable: false, latest: null },
    ]);
  });

  it('nothing is acceptable: any version id is a uniform 404, the public resolver has no legal content, and nothing is written', async () => {
    const a = await newActor('seed-accept');
    const before = await writes();
    const claim = { versionId: randomUUID(), locale: 'en-US', bodySha256: 'a'.repeat(64) };
    for (const purpose of [TERMS, PRIVACY]) {
      consentFail(await acceptRaw(a, purpose, claim), 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
      consentFail(
        await acceptRaw(a, purpose, { ...claim, versionId: NIL_UUID }),
        404,
        'ACCOUNT_CONSENT_VERSION_NOT_FOUND',
        'account.consent.error.version_not_found',
      );
      consentFail(await withdraw(a, purpose), 409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'account.consent.error.not_withdrawable');
    }
    for (const key of [TERMS_KEY, PRIVACY_KEY]) {
      const r = await call(undefined, 'POST', '/content/resolve', { body: { key, locale: 'en-US' }, as: null });
      expect(r.status, r.raw).toBe(404);
    }
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== publication and acceptance
describe('Legal publishes through the real workflow; the account accepts over HTTP', () => {
  let alice: Actor;

  it('publishes Terms v1 and Privacy v1 in en-US (draft, submit, a SECOND approver, publish); the author cannot approve their own draft', async () => {
    S.terms1 = await publishLegal(TERMS_KEY);
    S.privacy1 = await publishLegal(PRIVACY_KEY);
    for (const p of [S.terms1, S.privacy1]) {
      expect(p).toMatchObject({ version: 1, locale: 'en-US', status: 'PUBLISHED' });
      expect(p.hash).toBe(hashOf(p.body));
      expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // the second-approver rule of the workflow (an APPROVED, never published draft is kept: it must be a uniform 404 later)
    const d = await makeVersion(PRIVACY_KEY, { stage: 'IN_REVIEW' });
    await expect(content.approve(d.versionId, AUTHOR)).rejects.toMatchObject({ code: 'FORBIDDEN_APPROVER' });
    expect((await content.approve(d.versionId, APPROVER, 'ok')).status).toBe('APPROVED');
    S.approvedPrivacy = { ...d, status: 'APPROVED' };
  });

  it('GET requirements shows the version in force; its id, locale and hash equal the PUBLIC content resolve (no token)', async () => {
    alice = S.alice = await newActor('alice');
    const data = ok(await getReqs(alice), OP.requirements);
    expect(data.satisfied).toBe(false);
    expect(data.outstanding).toEqual([PRIVACY, TERMS]);
    for (const [code, key, pub] of [
      [TERMS, TERMS_KEY, S.terms1],
      [PRIVACY, PRIVACY_KEY, S.privacy1],
    ] as const) {
      const row = rowOf(data, code);
      expect(row).toMatchObject({ required: true, status: 'OUTSTANDING', acceptanceState: 'NONE', accepted: null });
      expect(row.document).toEqual({
        entryKey: key,
        versionId: pub.versionId,
        version: 1,
        locale: 'en-US',
        bodySha256: pub.hash,
        effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      const resolved = await call(undefined, 'POST', '/content/resolve', { body: { key: row.document.entryKey, locale: row.document.locale }, as: null });
      const pub200 = ok(resolved);
      expect(pub200.contentType).toBe('LEGAL');
      expect(pub200.versionId).toBe(row.document.versionId);
      expect(pub200.bodySha256).toBe(row.document.bodySha256);
      expect(pub200.resolvedLocale).toBe(row.document.locale);
      expect(pub200.version).toBe(row.document.version);
      expect(pub200.effectiveFrom).toBe(row.document.effectiveFrom);
      expect(pub200.fallback.applied).toBe(false);
      expect(pub200.value).toContain(pub.body.split(' ')[1]); // the person is shown the text the hash covers
    }
  });

  it('accepting Terms with the version id, locale and hash taken from the requirements: 200, one event, one audit row and one outbox event with exactly the expected content', async () => {
    const doc = rowOf(ok(await getReqs(alice), OP.requirements), TERMS).document;
    const session = (await sessionRowOf(alice.t0.sid))!;
    const before = await dbEpoch();
    const r = await acceptRaw(alice, TERMS, { versionId: doc.versionId, locale: doc.locale, bodySha256: doc.bodySha256 });
    const after = await dbEpoch();
    const data = ok(r, OP.accept);
    expect(data.changed).toBe(true);
    expect(data.event).toEqual({
      consentEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      purposeCode: TERMS,
      eventType: 'ACCEPTED',
      eventSeq: 1,
      document: { versionId: doc.versionId, version: 1, locale: 'en-US', bodySha256: doc.bodySha256 },
      occurredAt: expect.stringMatching(/Z$/),
      source: 'ACCOUNT_API',
    });
    const at = Date.parse(data.event.occurredAt) / 1000;
    expect(at, 'the time is the database clock at the moment of the request').toBeGreaterThanOrEqual(before - 0.01);
    expect(at).toBeLessThanOrEqual(after + 0.01);

    const rows = await eventRows(alice.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consent_event_id: data.event.consentEventId,
      account_id: alice.accountId,
      purpose_code: TERMS,
      event_seq: 1,
      event_type: 'ACCEPTED',
      version_id: doc.versionId,
      locale: 'en-US',
      body_sha256: doc.bodySha256,
      source: 'ACCOUNT_API',
      application_session_id: session.application_session_id,
      correlation_id: r.cid,
    });
    expect(rows[0]!.occurred_at.toISOString()).toBe(data.event.occurredAt);

    const audit = await auditRows(alice.accountId);
    expect(audit).toEqual([
      {
        action: 'CONSENT_ACCEPTED',
        actor: `account:${alice.accountId}`,
        changes: { purposeCode: TERMS, eventSeq: 1 },
        consent_event_id: data.event.consentEventId,
        correlation_id: r.cid,
        application_session_id: null,
        reason: null,
      },
    ]);
    const outbox = await outboxRows(alice.accountId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toEqual({
      event_type: CONSENT_EVENTS.accepted,
      aggregate_type: 'identity_account',
      aggregate_id: alice.accountId,
      actor_type: 'user',
      actor_id: `account:${alice.accountId}`,
      correlation_id: r.cid,
      payload_json: { accountId: alice.accountId, purposeCode: TERMS, consentEventId: data.event.consentEventId, eventSeq: 1, contentVersionId: doc.versionId },
    });
    expect(Object.keys(outbox[0]!.payload_json).sort()).toEqual(['accountId', 'consentEventId', 'contentVersionId', 'eventSeq', 'purposeCode']);
  });

  it('repeating the same acceptance is 200 changed:false with the SAME event and writes nothing (also with an upper-case version id)', async () => {
    const first = (await eventRows(alice.accountId, TERMS))[0]!;
    const before = await writes();
    const mine = await counts(alice.accountId);
    for (let i = 0; i < 4; i++) {
      const data = ok(await acceptDoc(alice, TERMS, S.terms1), OP.accept);
      expect(data.changed).toBe(false);
      expect(data.event.consentEventId).toBe(first.consent_event_id);
      expect(data.event.eventSeq).toBe(1);
    }
    const upper = ok(await acceptRaw(alice, TERMS, { ...claimOf(S.terms1), versionId: S.terms1.versionId.toUpperCase() }), OP.accept);
    expect(upper.changed).toBe(false);
    expect(upper.event.document.versionId).toBe(S.terms1.versionId);
    expect(await writes()).toEqual(before);
    expect(await counts(alice.accountId)).toEqual(mine);
  });

  it('accepting Privacy too makes the requirements SATISFIED (satisfied true, nothing outstanding) and the history lists both events newest first', async () => {
    const r = ok(await acceptDoc(alice, PRIVACY, S.privacy1), OP.accept);
    expect(r).toMatchObject({ changed: true, event: { purposeCode: PRIVACY, eventSeq: 1, eventType: 'ACCEPTED' } });
    const data = ok(await getReqs(alice), OP.requirements);
    expect(data.satisfied).toBe(true);
    expect(data.outstanding).toEqual([]);
    for (const row of data.requirements) {
      expect(row).toMatchObject({ status: 'SATISFIED', acceptanceState: 'ACCEPTED', required: true });
      expect(row.accepted.eventType).toBe('ACCEPTED');
      expect(row.accepted.document.versionId).toBe(row.document.versionId);
    }
    const all = ok(await getConsents(alice), OP.consents);
    expect(all.current.map((c: Json) => [c.purposeCode, c.state, c.withdrawable, c.latest.eventSeq])).toEqual([
      [PRIVACY, 'ACCEPTED', false, 1],
      [TERMS, 'ACCEPTED', false, 1],
    ]);
    expect(all.history.map((e: Json) => e.purposeCode)).toEqual([PRIVACY, TERMS]);
    expect(all.history[0]).toEqual(all.current[0].latest);
    expect(all.history[1]).toEqual(all.current[1].latest);
    // a withdrawal of a condition of service is refused whatever the state
    consentFail(await withdraw(alice, TERMS), 409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'account.consent.error.not_withdrawable');
    expect((await counts(alice.accountId)).events).toBe(2);
  });

  it('the application session of the request is stored on the event: two sessions of one person write two different session ids', async () => {
    const ivy = await newActor('ivy');
    const s2 = await login(ivy);
    ok(await acceptDoc(ivy, TERMS, S.terms1), OP.accept);
    ok(await acceptDoc(ivy, PRIVACY, S.privacy1, { as: s2 }), OP.accept);
    const rows = await eventRows(ivy.accountId);
    const sid1 = (await sessionRowOf(ivy.t0.sid))!.application_session_id;
    const sid2 = (await sessionRowOf(s2.sid))!.application_session_id;
    expect(sid1).not.toBe(sid2);
    expect(rows.map((r) => [r.purpose_code, r.application_session_id])).toEqual([
      [PRIVACY, sid2],
      [TERMS, sid1],
    ]);
    // the Keycloak session id itself is nowhere in the consent tables
    expect(JSON.stringify(rows)).not.toContain(ivy.t0.sid);
    expect(JSON.stringify(rows)).not.toContain(s2.sid);
  });

  it('other people accept independently: each account has its own sequence and sees only its own history; the upper-case version id is the same id', async () => {
    S.frank = await newActor('frank');
    const bob = await newActor('bob', { roles: ['customer', 'provider'] });
    const gina = await newActor('gina', { roles: ['provider'] });
    for (const who of [S.frank, bob, gina]) {
      ok(await acceptRaw(who, TERMS, { ...claimOf(S.terms1), versionId: S.terms1.versionId.toUpperCase() }), OP.accept);
      ok(await acceptDoc(who, PRIVACY, S.privacy1), OP.accept);
    }
    for (const who of [S.frank, bob, gina]) {
      const rows = await eventRows(who.accountId);
      expect(rows.map((r) => [r.purpose_code, r.event_seq, r.event_type])).toEqual([
        [PRIVACY, 1, 'ACCEPTED'],
        [TERMS, 1, 'ACCEPTED'],
      ]);
      const list = ok(await getConsents(who), OP.consents);
      expect(list.history).toHaveLength(2);
      const mine = new Set(rows.map((r) => r.consent_event_id));
      for (const e of list.history) expect(mine.has(e.consentEventId)).toBe(true);
    }
    // alice's events never appear for bob and bob's account id is never in a response
    const aliceIds = (await eventRows(alice.accountId)).map((r) => r.consent_event_id);
    const bobBody = (await getConsents(bob)).raw;
    for (const id of aliceIds) expect(bobBody).not.toContain(id);
    for (const r of [await getConsents(bob), await getReqs(bob)]) {
      expect(r.raw).not.toContain(bob.accountId);
      expect(r.raw).not.toContain(alice.accountId);
    }
  });
});

// ====================================================================== refusals: claims, unpublished versions, purposes
describe('accept: every wrong claim is refused with its own code, uniformly, and writes nothing', () => {
  let err: Actor;
  const KEY_HASH = 'account.consent.error.hash_mismatch';

  it('a wrong hash is 400 ACCOUNT_CONSENT_HASH_MISMATCH (the hash of another document included); the claimed value is never echoed', async () => {
    err = await newActor('claims');
    const before = await writes();
    for (const wrong of ['f'.repeat(64), '0'.repeat(64), S.privacy1.hash, hashOf('some other text')]) {
      const r = await acceptRaw(err, TERMS, { ...claimOf(S.terms1), bodySha256: wrong });
      consentFail(r, 400, 'ACCOUNT_CONSENT_HASH_MISMATCH', KEY_HASH);
      expect(r.raw).not.toContain(wrong);
      expect(r.raw).not.toContain(S.terms1.hash);
      expect(r.body.error.category).toBe('VALIDATION');
      expect(r.body.error.message).toBe('The document hash does not match the document version');
    }
    expect(await writes()).toEqual(before);
  });

  it('a wrong locale is 400 ACCOUNT_CONSENT_LOCALE_MISMATCH (exact comparison: case, a bare language and an unregistered tag all differ), and it is checked before the hash', async () => {
    const before = await writes();
    for (const wrong of ['es-MX', 'en-us', 'EN-US', 'en', 'fr-FR', 'zz-ZZ', 'en-US-x']) {
      const r = await acceptRaw(err, TERMS, { ...claimOf(S.terms1), locale: wrong });
      consentFail(r, 400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH', 'account.consent.error.locale_mismatch');
      if (wrong.length >= 5) expect(r.raw).not.toContain(wrong);
      expect(r.body.error.message).toBe('The locale does not match the document version');
      // both wrong: the locale answer comes first and still names neither value
      const both = await acceptRaw(err, TERMS, { ...claimOf(S.terms1), locale: wrong, bodySha256: 'e'.repeat(64) });
      consentFail(both, 400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH', 'account.consent.error.locale_mismatch');
    }
    // a locale that is not even a locale tag is a plain validation failure of the service (never reaches the comparison)
    for (const shape of ['en_US', 'en US', 'en-US;x']) {
      const r = await acceptRaw(err, TERMS, { ...claimOf(S.terms1), locale: shape });
      fail(r, 400, 'ACCOUNT_VALIDATION_FAILED');
      expect(r.raw).not.toContain(shape);
    }
    expect(await writes()).toEqual(before);
  });

  it('DRAFT, IN_REVIEW, APPROVED, REJECTED, CANCELLED, another document, an unknown id and the nil uuid are ONE 404 body (no oracle, even with the right locale and hash)', async () => {
    const draft = await makeVersion(PRIVACY_KEY, { stage: 'DRAFT' });
    const review = await makeVersion(PRIVACY_KEY, { stage: 'IN_REVIEW' });
    const rejected = await makeVersion(PRIVACY_KEY, { stage: 'REJECTED' });
    const cancelled = await makeVersion(PRIVACY_KEY, { stage: 'CANCELLED' });
    expect([draft.status, review.status, S.approvedPrivacy.status, rejected.status, cancelled.status]).toEqual([
      'DRAFT',
      'IN_REVIEW',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ]);
    const before = await writes();
    const attempts: [string, Claim][] = [
      ['draft', claimOf(draft)],
      ['in review', claimOf(review)],
      ['approved', claimOf(S.approvedPrivacy)],
      ['rejected', claimOf(rejected)],
      ['cancelled', claimOf(cancelled)],
      ['a published version of ANOTHER document', claimOf(S.terms1)],
      ['unknown id', { versionId: randomUUID(), locale: 'en-US', bodySha256: S.privacy1.hash }],
      ['nil uuid', { versionId: NIL_UUID, locale: 'en-US', bodySha256: S.privacy1.hash }],
      ['draft, wrong locale', { ...claimOf(draft), locale: 'fr-FR' }],
      ['draft, wrong hash', { ...claimOf(draft), bodySha256: 'c'.repeat(64) }],
      ['upper-case id of a draft', { ...claimOf(draft), versionId: draft.versionId.toUpperCase() }],
    ];
    const bodies = new Set<string>();
    for (const [name, claim] of attempts) {
      const r = await acceptRaw(err, PRIVACY, claim);
      consentFail(r, 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
      bodies.add(JSON.stringify(bare(r)));
      expect(r.raw, name).not.toContain(claim.versionId);
      expect(r.raw, name).not.toContain(claim.bodySha256);
    }
    expect(bodies.size, 'one uniform answer').toBe(1);
    expect(await writes()).toEqual(before);
  });

  it('an unknown but well-formed purpose is 404 ACCOUNT_CONSENT_PURPOSE_NOT_FOUND for accept and withdraw; the code is not echoed', async () => {
    const before = await writes();
    for (const purpose of ['NO_SUCH_PURPOSE', 'MARKETING_EMAIL', 'ZZ', 'A'.repeat(64)]) {
      for (const r of [await acceptDoc(err, purpose, S.terms1), await withdraw(err, purpose)]) {
        consentFail(r, 404, 'ACCOUNT_CONSENT_PURPOSE_NOT_FOUND', 'account.consent.error.purpose_not_found');
        expect(r.raw).not.toContain(purpose);
      }
    }
    // a version of a real document is not enough: the purpose decides which document counts
    const wrongPurpose = await acceptDoc(err, 'NO_SUCH_PURPOSE', S.privacy1);
    expect(wrongPurpose.status).toBe(404);
    expect(await writes()).toEqual(before);
  });

  it('a malformed purpose in the path is 400 and never echoed; dot segments, other methods and extra segments never reach the service (404, no-store)', async () => {
    const before = await writes();
    const bad = [
      'terms_of_service',
      'Terms_Of_Service',
      'T',
      '1TERMS',
      '_TERMS',
      'TERMS-OF-SERVICE',
      'TERMS%20OF',
      'TERMS.OF',
      'TERMS%00',
      'TERMS%0A',
      'TERMS_OF_SERVIC%C3%89',
      '%E2%84%AAEY',
      'A'.repeat(65),
      '%27%20OR%201=1--',
      'TERMS_OF_SERVICE%2Faccept',
      err.accountId,
    ];
    for (const purpose of bad) {
      for (const [action, body] of [
        ['accept', claimOf(S.terms1)],
        ['withdraw', {}],
      ] as const) {
        const r = await call(err, 'POST', `${CONS}/${purpose}/${action}`, { body });
        expect(r.status, `${action} ${purpose}: ${r.raw}`).toBe(400);
        expect(ErrorResponse.safeParse(r.body).success).toBe(true);
        expect(r.body.error.category).toBe('VALIDATION');
        expect(r.headers['cache-control']).toBe('no-store');
        if (r.body.error.code === 'VALIDATION_FAILED')
          expect(r.body.error.details).toEqual({ issues: [{ path: 'params.purpose', message: 'must be a purpose code' }] });
        const decoded = decodeURIComponent(purpose);
        if (decoded.length >= 6) {
          expect(r.raw.toLowerCase()).not.toContain(decoded.toLowerCase());
          expect(r.raw.toLowerCase()).not.toContain(purpose.toLowerCase());
        }
      }
    }
    const tooLong = await call(err, 'POST', `${CONS}/${'A'.repeat(300)}/accept`, { body: claimOf(S.terms1) });
    fail(tooLong, 400, 'PATH_PARAMETER_TOO_LONG');
    for (const [method, url] of [
      ['GET', `${CONS}/${TERMS}/accept`],
      ['PUT', `${CONS}/${TERMS}/accept`],
      ['DELETE', CONS],
      ['POST', CONS],
      ['POST', `${CONS}/${TERMS}`],
      ['POST', `${CONS}/${TERMS}/accept/extra`],
      ['POST', `${CONS}/${TERMS}/withdraw/`],
      ['POST', `${CONS}/../accept`],
      ['POST', `${CONS}/%2e%2e/accept`],
    ] as const) {
      const r = await call(err, method, url, { body: method === 'GET' ? undefined : claimOf(S.terms1) });
      expect([404, 400], `${method} ${url}`).toContain(r.status);
      expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect(await writes()).toEqual(before);
  });
});

describe('strict bodies, query and the withdraw body at the integration level (nothing is coerced, nothing is written)', () => {
  let who: Actor;
  const good = () => claimOf(S.terms1);
  const BAD_BODIES: [string, unknown][] = [
    ['empty object', {}],
    ['missing versionId', { locale: 'en-US', bodySha256: S.terms1?.hash }],
    ['missing locale', { versionId: randomUUID(), bodySha256: 'a'.repeat(64) }],
    ['missing bodySha256', { versionId: randomUUID(), locale: 'en-US' }],
    ['unknown field', { ...claimOf(S.terms1 ?? ({} as Pub)), extra: 1 }],
    ['accountId', { ...claimOf(S.terms1 ?? ({} as Pub)), accountId: randomUUID() }],
    ['account_id', { ...claimOf(S.terms1 ?? ({} as Pub)), account_id: randomUUID() }],
    ['subject', { ...claimOf(S.terms1 ?? ({} as Pub)), subject: 'someone' }],
    ['source', { ...claimOf(S.terms1 ?? ({} as Pub)), source: 'ADMIN' }],
    ['occurredAt', { ...claimOf(S.terms1 ?? ({} as Pub)), occurredAt: '2020-01-01T00:00:00Z' }],
    ['eventSeq', { ...claimOf(S.terms1 ?? ({} as Pub)), eventSeq: 7 }],
    ['purposeCode', { ...claimOf(S.terms1 ?? ({} as Pub)), purposeCode: PRIVACY }],
    ['numeric versionId', { versionId: 12345, locale: 'en-US', bodySha256: 'a'.repeat(64) }],
    ['numeric locale', { versionId: randomUUID(), locale: 12, bodySha256: 'a'.repeat(64) }],
    ['numeric hash', { versionId: randomUUID(), locale: 'en-US', bodySha256: 1234 }],
    ['boolean fields', { versionId: true, locale: true, bodySha256: true }],
    ['null fields', { versionId: null, locale: null, bodySha256: null }],
    ['array fields', { versionId: [randomUUID()], locale: ['en-US'], bodySha256: ['a'.repeat(64)] }],
    ['object fields', { versionId: { a: 1 }, locale: { a: 1 }, bodySha256: { a: 1 } }],
    ['non-uuid versionId', { versionId: 'not-a-uuid', locale: 'en-US', bodySha256: 'a'.repeat(64) }],
    ['uuid without dashes', { versionId: randomUUID().replaceAll('-', ''), locale: 'en-US', bodySha256: 'a'.repeat(64) }],
    ['uuid with braces', { versionId: `{${randomUUID()}}`, locale: 'en-US', bodySha256: 'a'.repeat(64) }],
    ['uuid with spaces', { versionId: ` ${randomUUID()} `, locale: 'en-US', bodySha256: 'a'.repeat(64) }],
    ['upper-case hash', { versionId: randomUUID(), locale: 'en-US', bodySha256: 'A'.repeat(64) }],
    ['63-char hash', { versionId: randomUUID(), locale: 'en-US', bodySha256: 'a'.repeat(63) }],
    ['65-char hash', { versionId: randomUUID(), locale: 'en-US', bodySha256: 'a'.repeat(65) }],
    ['non-hex hash', { versionId: randomUUID(), locale: 'en-US', bodySha256: `${'a'.repeat(63)}g` }],
    ['hash with prefix', { versionId: randomUUID(), locale: 'en-US', bodySha256: `sha256:${'a'.repeat(64)}` }],
    ['one-char locale', { versionId: randomUUID(), locale: 'e', bodySha256: 'a'.repeat(64) }],
    ['36-char locale', { versionId: randomUUID(), locale: 'a'.repeat(36), bodySha256: 'a'.repeat(64) }],
    ['array body', [{ versionId: randomUUID(), locale: 'en-US', bodySha256: 'a'.repeat(64) }]],
    ['null body', null],
    ['string body', 'accept'],
    ['number body', 1],
    ['boolean body', true],
  ];

  it('accept refuses every malformed or extended body with 400 VALIDATION_FAILED, never echoes a value, and writes nothing', async () => {
    who = await newActor('strict');
    const before = await writes();
    for (const [name, body] of BAD_BODIES) {
      const r = await acceptRaw(who, TERMS, name.endsWith('body') && body === null ? undefined : body, name === 'null body' ? { rawBody: 'null' } : undefined);
      const e = fail(r, 400, 'VALIDATION_FAILED');
      expect(e.category, name).toBe('VALIDATION');
      const strings: string[] = [];
      const collect = (v: unknown): void => {
        if (typeof v === 'string') strings.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(body);
      for (const s of strings) if (s.length >= 6) expect(r.raw, `${name} echoes ${s.slice(0, 8)}`).not.toContain(s);
    }
    expect(await writes()).toEqual(before);
    // the same body fixed is accepted: the fixture itself is valid
    expect(ok(await acceptRaw(who, TERMS, good()), OP.accept).changed).toBe(true);
  });

  it('accept refuses malformed JSON, an empty body, a prototype-polluting key, a wrong content type and an oversized body (413) without a write', async () => {
    const fresh = await newActor('strict-raw');
    const before = await writes();
    const id = S.terms1.versionId;
    const h = S.terms1.hash;
    for (const text of [
      '{"versionId": ',
      '{versionId: 1}',
      '',
      `{"__proto__":{"x":1},"versionId":"${id}","locale":"en-US","bodySha256":"${h}"}`,
      `{"constructor":1,"versionId":"${id}","locale":"en-US","bodySha256":"${h}"}`,
    ]) {
      const r = await call(fresh, 'POST', `${CONS}/${TERMS}/accept`, { rawBody: text });
      expect(r.status, text).toBe(400);
      expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const form = await call(fresh, 'POST', `${CONS}/${TERMS}/accept`, {
      rawBody: `versionId=${id}&locale=en-US&bodySha256=${h}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBeGreaterThanOrEqual(400);
    expect(form.status).toBeLessThan(500);
    expect(form.headers['cache-control']).toBe('no-store');
    const huge = JSON.stringify({ ...claimOf(S.terms1), locale: 'x'.repeat(100_000) });
    for (const url of [`${CONS}/${TERMS}/accept`, `${CONS}/${TERMS}/withdraw`]) {
      const r = await call(fresh, 'POST', url, { rawBody: huge });
      expect(r.status, url).toBe(413);
      expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const nested = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect((await call(fresh, 'POST', `${CONS}/${TERMS}/accept`, { rawBody: nested })).status).toBeGreaterThanOrEqual(400);
    expect(await writes()).toEqual(before);
  });

  it('withdraw takes no body: none or {} reach the service (a seeded purpose answers 409), anything else is 400 first', async () => {
    const before = await writes();
    consentFail(await withdraw(who, TERMS), 409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'account.consent.error.not_withdrawable');
    consentFail(await withdraw(who, TERMS, { body: {} }), 409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'account.consent.error.not_withdrawable');
    for (const body of [{ a: 1 }, { accountId: who.accountId }, { versionId: S.terms1.versionId }, [], [{}], 'x', 1, true]) {
      fail(await withdraw(who, TERMS, { body }), 400, 'VALIDATION_FAILED');
    }
    fail(await withdraw(who, TERMS, { rawBody: 'null' }), 400, 'VALIDATION_FAILED');
    expect(await writes()).toEqual(before);
  });

  it('the requirements query is strict: only `locale`, given once, a locale tag registered in the content registry (compared exactly); the list takes no query at all', async () => {
    const before = await writes();
    const badQueries = [
      '?locale=',
      '?locale=en-US&locale=en-US',
      '?locale=en-US&locale=es-MX',
      '?locale[]=en-US',
      '?locale[a]=en-US',
      '?locale=en-US&extra=1',
      `?accountId=${who.accountId}`,
      `?locale=en-US&accountId=${who.accountId}`,
      '?account_id=1',
      '?LOCALE=en-US',
      '?locale=e',
      `?locale=${'a'.repeat(36)}`,
      '?locale=en_US',
      '?locale=en-US%00',
      '?locale=%20en-US',
      '?locale=%C3%A9s',
      '?locale=-en',
      '?locale=en-',
      '?locale=en--US',
      '?purposes=TERMS_OF_SERVICE',
      '?locale=en-US&purposes=TERMS_OF_SERVICE',
    ];
    for (const query of badQueries) {
      const r = await call(who, 'GET', `${CONS}/requirements${query}`);
      expect(r.status, query).toBe(400);
      expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
      expect(r.body.error.category).toBe('VALIDATION');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.raw).not.toContain(who.accountId);
    }
    // a well-formed tag that is not registered, or differs in case from the registered one, is a validation failure (no fallback, no normalisation, no echo)
    for (const locale of ['fr-FR', 'en-us', 'en-GB', '1e3', 'zz', 'EN-US']) {
      const r = await getReqs(who, locale);
      fail(r, 400, 'ACCOUNT_VALIDATION_FAILED');
      expect(r.raw).not.toContain(locale === 'zz' ? '"zz"' : locale);
    }
    expect(ok(await getReqs(who, 'en-US'), OP.requirements).locale).toBe('en-US');
    // the list takes no query at all
    for (const query of ['?locale=en-US', `?accountId=${who.accountId}`, '?limit=1', '?x=', '?page=1']) {
      fail(await call(who, 'GET', `${CONS}${query}`), 400, 'VALIDATION_FAILED');
    }
    expect(ok(await getConsents(who), OP.consents).history).toHaveLength(1);
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== parity with ContentService.resolve
const NOT_CURRENT = 'account.consent.error.version_not_current';
const ensureLocale = async (locale: string, active: boolean): Promise<void> => {
  try {
    await content.registerLocale({ locale, active, reason: 'itest' }, AUTHOR);
  } catch (e) {
    if (!(e instanceof ContentError && e.code === 'CONFLICT')) throw e;
  }
  await content.setLocaleActive(locale, active, 'itest', AUTHOR);
};
/** The in-force function of the database for a version at an instant (the single definition shared by the guard trigger and the service). */
const stateAt = async (versionId: string, entryId: string, at: Date): Promise<string> =>
  (await q<{ s: string }>('SELECT identity.consent_version_state($1::uuid, $2::uuid, $3::timestamptz) AS s', [versionId, entryId, at.toISOString()]))[0]!.s;
/** At the instants around every window edge, the version the database calls IN_FORCE is exactly the version the resolver serves at that instant (half-open windows). */
async function expectBoundaryParity(doc: Doc, locale: string, pubs: Pub[]): Promise<void> {
  const instants = new Set<number>();
  for (const p of pubs) {
    const v = await content.getVersion(p.versionId);
    const from = new Date(v.effectiveFrom).getTime();
    for (const t of [from - 1, from, from + 1]) instants.add(t);
    if (v.effectiveTo) {
      const to = new Date(v.effectiveTo).getTime();
      for (const t of [to - 1, to, to + 1]) instants.add(t);
    }
  }
  for (const t of [...instants].sort()) {
    const at = new Date(t);
    const inForce: string[] = [];
    for (const p of pubs) if ((await stateAt(p.versionId, doc.entryId, at)) === 'IN_FORCE') inForce.push(p.versionId);
    expect(inForce.length, `at most one version is in force at ${at.toISOString()}`).toBeLessThanOrEqual(1);
    const served = await resolverView(doc.entryKey, locale, at);
    expect(served?.versionId ?? null, `instant ${at.toISOString()}`).toBe(inForce[0] ?? null);
  }
}

describe('the version in force is exactly the version ContentService.resolve serves', () => {
  let probe: Actor;
  beforeAll(async () => {
    probe = await newActor('parity');
    await ensureLocale('es-MX', true);
    await ensureLocale('pt-BR', true);
  });
  afterAll(retireAll);

  it('before any publication, and with only DRAFT, IN_REVIEW, APPROVED, REJECTED or CANCELLED versions, nothing is in force; the first publication changes both answers together', async () => {
    const doc = await registerDoc();
    expect(await expectParity(probe, doc, 'en-US', 'empty')).toBeNull();
    const row = rowOf(ok(await getReqs(probe), OP.requirements), doc.code);
    expect(row).toMatchObject({ status: 'DOCUMENT_UNAVAILABLE', document: null });
    for (const stage of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      await makeVersion(doc.entryKey, { stage });
      expect(await expectParity(probe, doc, 'en-US', stage), stage).toBeNull();
    }
    const v1 = await publishLegal(doc.entryKey);
    const view = await expectParity(probe, doc, 'en-US', 'published');
    expect(view).toMatchObject({ versionId: v1.versionId, version: v1.version, locale: 'en-US', bodySha256: v1.hash, entryKey: doc.entryKey });
    expect(rowOf(ok(await getReqs(probe), OP.requirements), doc.code).status).toBe('OUTSTANDING');
  });

  it('supersession: the successor is in force, the predecessor is 409 NOT_CURRENT BEFORE any locale or hash comparison, and every window edge agrees with the resolver', async () => {
    const doc = await registerDoc();
    const v1 = await publishLegal(doc.entryKey);
    expect((await expectParity(probe, doc, 'en-US', 'v1'))!.versionId).toBe(v1.versionId);
    await sleep(15);
    const v2 = await publishLegal(doc.entryKey);
    expect((await content.getVersion(v1.versionId)).status).toBe('SUPERSEDED');
    expect((await expectParity(probe, doc, 'en-US', 'v2'))!.versionId).toBe(v2.versionId);
    await expectBoundaryParity(doc, 'en-US', [v1, v2]);
    const before = await writes();
    for (const claim of [claimOf(v1), { ...claimOf(v1), locale: 'fr-FR' }, { ...claimOf(v1), bodySha256: 'd'.repeat(64) }]) {
      consentFail(await acceptRaw(probe, doc.code, claim), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    }
    expect(await writes()).toEqual(before);
    expect(ok(await acceptDoc(probe, doc.code, v2), OP.accept).changed).toBe(true);
  });

  it('a version scheduled for the future is not in force until its start passes (even before the activation job runs); and a window that has ended is no longer in force', async () => {
    const scheduled = async (): Promise<void> => {
      const doc = await registerDoc();
      const a = await newActor('sched-a');
      const b = await newActor('sched-b');
      const v1 = await publishLegal(doc.entryKey);
      const startAt = (await dbEpoch()) * 1000 + 3500;
      const v2 = await makeVersion(doc.entryKey, { from: new Date(startAt) });
      expect(v2.status).toBe('SCHEDULED');
      expect((await expectParity(a, doc, 'en-US', 'before the start'))!.versionId).toBe(v1.versionId);
      // not yet effective: published but not current, whatever else the claim says
      for (const claim of [claimOf(v2), { ...claimOf(v2), locale: 'fr-FR' }, { ...claimOf(v2), bodySha256: 'd'.repeat(64) }])
        consentFail(await acceptRaw(a, doc.code, claim), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
      expect(ok(await acceptDoc(a, doc.code, v1), OP.accept).changed).toBe(true);
      expect(await dbEpoch(), 'the samples above ran before the start').toBeLessThan(startAt / 1000 - 0.2);

      await waitUntilDb(startAt / 1000 + 0.4);
      // the start has passed, the job has NOT run: the status is still SCHEDULED, yet the resolver and the consent API both serve v2
      expect((await content.getVersion(v2.versionId)).status).toBe('SCHEDULED');
      expect((await expectParity(a, doc, 'en-US', 'after the start, before activation'))!.versionId).toBe(v2.versionId);
      expect(rowOf(ok(await getReqs(a), OP.requirements), doc.code)).toMatchObject({ status: 'REACCEPTANCE_REQUIRED', acceptanceState: 'ACCEPTED' });
      expect(ok(await acceptDoc(b, doc.code, v2), OP.accept).changed).toBe(true);
      expect(ok(await acceptDoc(a, doc.code, v2), OP.accept).event.eventSeq).toBe(2);
      consentFail(await acceptDoc(probe, doc.code, v1), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);

      expect(await content.activateDue()).toBeGreaterThanOrEqual(1);
      expect((await content.getVersion(v2.versionId)).status).toBe('PUBLISHED');
      expect((await content.getVersion(v1.versionId)).status).toBe('SUPERSEDED');
      expect((await expectParity(a, doc, 'en-US', 'after activation'))!.versionId).toBe(v2.versionId);
      expect(rowOf(ok(await getReqs(b), OP.requirements), doc.code).status).toBe('SATISFIED');
      await expectBoundaryParity(doc, 'en-US', [v1, v2]);
    };
    const expiring = async (): Promise<void> => {
      const doc = await registerDoc();
      const x = await newActor('exp-x');
      const y = await newActor('exp-y');
      const endAt = (await dbEpoch()) * 1000 + 6000;
      const v1 = await publishLegal(doc.entryKey, { to: new Date(endAt) });
      expect((await expectParity(x, doc, 'en-US', 'inside the window'))!.versionId).toBe(v1.versionId);
      expect(ok(await acceptDoc(x, doc.code, v1), OP.accept).changed).toBe(true);
      expect(await dbEpoch(), 'the samples above ran inside the window').toBeLessThan(endAt / 1000 - 0.3);

      await waitUntilDb(endAt / 1000 + 0.4);
      expect(await expectParity(x, doc, 'en-US', 'after the window')).toBeNull();
      // required, accepted, and nothing in force: not satisfied (REACCEPT_REQUIRED)
      expect(rowOf(ok(await getReqs(x), OP.requirements), doc.code)).toMatchObject({
        status: 'DOCUMENT_UNAVAILABLE',
        acceptanceState: 'ACCEPTED',
        document: null,
        accepted: { document: { versionId: v1.versionId } },
      });
      for (const claim of [claimOf(v1), { ...claimOf(v1), locale: 'fr-FR' }, { ...claimOf(v1), bodySha256: 'd'.repeat(64) }])
        consentFail(await acceptRaw(y, doc.code, claim), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
      // the account that already accepted it is told so (idempotent), a missing document does not undo history
      const again = ok(await acceptDoc(x, doc.code, v1), OP.accept);
      expect(again.changed).toBe(false);
      await sleep(10);
      const v2 = await publishLegal(doc.entryKey);
      expect((await expectParity(x, doc, 'en-US', 'successor'))!.versionId).toBe(v2.versionId);
      expect(rowOf(ok(await getReqs(x), OP.requirements), doc.code).status).toBe('REACCEPTANCE_REQUIRED');
      await expectBoundaryParity(doc, 'en-US', [v1, v2]);
    };
    await Promise.all([scheduled(), expiring()]);
  }, 90_000);

  it('an inactive locale or an inactive entry serves nothing in both; reactivation restores both; an existing acceptance is only repeated, never extended', async () => {
    const doc = await registerDoc();
    const pt = await publishLegal(doc.entryKey, { locale: 'pt-BR' });
    const en = await publishLegal(doc.entryKey);
    const a = await newActor('inactive');
    expect((await expectParity(a, doc, 'pt-BR', 'locale active'))!.versionId).toBe(pt.versionId);
    ok(await acceptDoc(a, doc.code, pt), OP.accept);

    await content.setLocaleActive('pt-BR', false, 'itest', AUTHOR);
    expect(await expectParity(a, doc, 'pt-BR', 'locale inactive')).toBeNull();
    consentFail(await acceptRaw(probe, doc.code, claimOf(pt)), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    expect(ok(await acceptDoc(a, doc.code, pt), OP.accept).changed).toBe(false);
    await content.setLocaleActive('pt-BR', true, 'itest', AUTHOR);
    expect((await expectParity(a, doc, 'pt-BR', 'locale reactivated'))!.versionId).toBe(pt.versionId);

    await content.setEntryActive(doc.entryKey, false, 'itest', AUTHOR);
    expect(await expectParity(a, doc, 'en-US', 'entry inactive')).toBeNull();
    expect(await expectParity(a, doc, 'pt-BR', 'entry inactive (pt-BR)')).toBeNull();
    consentFail(await acceptDoc(probe, doc.code, en), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    await content.setEntryActive(doc.entryKey, true, 'itest', AUTHOR);
    expect((await expectParity(a, doc, 'en-US', 'entry reactivated'))!.versionId).toBe(en.versionId);
    expect(ok(await acceptDoc(probe, doc.code, en), OP.accept).changed).toBe(true);
  });

  it('a COUNTRY-scoped version never counts: the resolver serves it only under a country context, the consent API never, and it cannot be accepted (uniform 404)', async () => {
    const doc = await registerDoc({ maxScope: 'COUNTRY' });
    const us = await makeVersion(doc.entryKey, { scope: { type: 'COUNTRY', ref: 'US' } });
    expect(us.status).toBe('PUBLISHED');
    expect(await expectParity(probe, doc, 'en-US', 'only a country version')).toBeNull();
    const withContext = await content.resolve(doc.entryKey, { locale: 'en-US', context: { country: 'US' }, includeInternal: false });
    expect(withContext.versionId, 'control: the resolver does serve it under a country context').toBe(us.versionId);
    expect(await stateAt(us.versionId, doc.entryId, new Date())).toBe('NOT_FOUND');
    const before = await writes();
    const notFound = await acceptDoc(probe, doc.code, us);
    consentFail(notFound, 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
    expect(await writes()).toEqual(before);

    const platform = await publishLegal(doc.entryKey);
    expect((await expectParity(probe, doc, 'en-US', 'platform version published'))!.versionId).toBe(platform.versionId);
    const specific = await content.resolve(doc.entryKey, { locale: 'en-US', context: { country: 'US' }, includeInternal: false });
    expect(specific.versionId, 'the country context still prefers the more specific version').toBe(us.versionId);
    expect(rowOf(ok(await getReqs(probe), OP.requirements), doc.code).document.versionId).toBe(platform.versionId);
    consentFail(await acceptDoc(probe, doc.code, us), 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
  });

  it('the locale is EXACT: a document that exists only in es-MX is in force for es-MX and for nobody asking en-US; the evaluated locale is the query, then the profile, then the platform default', async () => {
    const doc = await registerDoc();
    const es = await publishLegal(doc.entryKey, { locale: 'es-MX' });
    const a = await newActor('locale-order');
    expect(await expectParity(a, doc, 'en-US', 'en-US')).toBeNull();
    expect((await expectParity(a, doc, 'es-MX', 'es-MX'))!.versionId).toBe(es.versionId);
    // default: the platform default locale
    expect(ok(await getReqs(a), OP.requirements).locale).toBe('en-US');
    expect(rowOf(ok(await getReqs(a), OP.requirements), doc.code).document).toBeNull();
    // the profile preference decides when no query is given; the query wins over the profile
    await accounts.upsertProfile(a.accountId, { firstName: 'Ana', lastName: 'Prueba', preferredLocale: 'es-MX' }, { actor: 'system:itest' });
    const byProfile = ok(await getReqs(a), OP.requirements);
    expect(byProfile.locale).toBe('es-MX');
    expect(rowOf(byProfile, doc.code).document.versionId).toBe(es.versionId);
    const byQuery = ok(await getReqs(a, 'en-US'), OP.requirements);
    expect(byQuery.locale).toBe('en-US');
    expect(rowOf(byQuery, doc.code).document).toBeNull();
    // the locale claim must be the locale of the version: an en-US claim for the es-MX text is refused, never repaired
    consentFail(
      await acceptRaw(a, doc.code, { ...claimOf(es), locale: 'en-US' }),
      400,
      'ACCOUNT_CONSENT_LOCALE_MISMATCH',
      'account.consent.error.locale_mismatch',
    );
    expect(ok(await acceptDoc(a, doc.code, es), OP.accept).event.document.locale).toBe('es-MX');
  });

  it("another document's version id is a uniform 404 even when that version is in force", async () => {
    const d1 = await registerDoc();
    const d2 = await registerDoc();
    const p1 = await publishLegal(d1.entryKey);
    const p2 = await publishLegal(d2.entryKey);
    const before = await writes();
    consentFail(await acceptDoc(probe, d1.code, p2), 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
    consentFail(await acceptDoc(probe, d2.code, p1), 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== a newer version under the seeded REACCEPT_REQUIRED
describe('a newer version under the seeded REACCEPT_REQUIRED', () => {
  let terms2: Pub;
  let erin: Actor;
  it('publishing Terms v2 makes accounts that accepted v1 REACCEPTANCE_REQUIRED for Terms only; Privacy stays SATISFIED', async () => {
    erin = await newActor('erin');
    await sleep(15);
    terms2 = await publishLegal(TERMS_KEY);
    expect(terms2.version).toBe(2);
    expect((await content.getVersion(S.terms1.versionId)).status).toBe('SUPERSEDED');
    const data = ok(await getReqs(S.alice), OP.requirements);
    const terms = rowOf(data, TERMS);
    expect(terms).toMatchObject({ status: 'REACCEPTANCE_REQUIRED', acceptanceState: 'ACCEPTED', required: true });
    expect(terms.document).toMatchObject({ versionId: terms2.versionId, version: 2, bodySha256: terms2.hash });
    expect(terms.accepted.document).toEqual({ versionId: S.terms1.versionId, version: 1, locale: 'en-US', bodySha256: S.terms1.hash });
    expect(rowOf(data, PRIVACY).status).toBe('SATISFIED');
    expect(data.satisfied).toBe(false);
    expect(data.outstanding).toEqual([TERMS]);
    const list = ok(await getConsents(S.alice), OP.consents);
    expect(list.current.find((c: Json) => c.purposeCode === TERMS)).toMatchObject({ state: 'ACCEPTED', latest: { document: { version: 1 } } });
    expect(list.history).toHaveLength(2);
    // the public resolver serves v2 too
    const pub = ok(await call(undefined, 'POST', '/content/resolve', { body: { key: TERMS_KEY, locale: 'en-US' }, as: null }));
    expect([pub.versionId, pub.bodySha256]).toEqual([terms2.versionId, terms2.hash]);
  });

  it('the old version: 409 CONSENT_VERSION_NOT_CURRENT for a newcomer, with any locale or hash claim; repeating an acceptance of v1 already on record is idempotent; after v2 is accepted v1 is 409', async () => {
    const before = await writes();
    for (const claim of [claimOf(S.terms1), { ...claimOf(S.terms1), locale: 'fr-FR' }, { ...claimOf(S.terms1), bodySha256: 'd'.repeat(64) }]) {
      consentFail(await acceptRaw(erin, TERMS, claim), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    }
    expect(await writes()).toEqual(before);
    // alice's latest event IS the acceptance of v1: the identical repeat is a no-op (a wrong claim there is still a mismatch)
    const same = ok(await acceptDoc(S.alice, TERMS, S.terms1), OP.accept);
    expect(same.changed).toBe(false);
    expect(same.event.eventSeq).toBe(1);
    consentFail(
      await acceptRaw(S.alice, TERMS, { ...claimOf(S.terms1), bodySha256: 'd'.repeat(64) }),
      400,
      'ACCOUNT_CONSENT_HASH_MISMATCH',
      'account.consent.error.hash_mismatch',
    );
    consentFail(
      await acceptRaw(S.alice, TERMS, { ...claimOf(S.terms1), locale: 'es-MX' }),
      400,
      'ACCOUNT_CONSENT_LOCALE_MISMATCH',
      'account.consent.error.locale_mismatch',
    );
    expect(await writes()).toEqual(before);
  });

  it('accepting v2 writes event 2 (the history is kept), makes the account SATISFIED again, and v1 is then refused as not current', async () => {
    const r = ok(await acceptDoc(S.alice, TERMS, terms2), OP.accept);
    expect(r).toMatchObject({ changed: true, event: { eventSeq: 2, eventType: 'ACCEPTED', document: { version: 2, versionId: terms2.versionId } } });
    const data = ok(await getReqs(S.alice), OP.requirements);
    expect(data.satisfied).toBe(true);
    expect(rowOf(data, TERMS)).toMatchObject({ status: 'SATISFIED', accepted: { eventSeq: 2 } });
    consentFail(await acceptDoc(S.alice, TERMS, S.terms1), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    const list = ok(await getConsents(S.alice), OP.consents);
    expect(list.history.map((e: Json) => [e.purposeCode, e.eventSeq, e.document.version])).toEqual([
      [TERMS, 2, 2],
      [PRIVACY, 1, 1],
      [TERMS, 1, 1],
    ]);
    const rows = await eventRows(S.alice.accountId, TERMS);
    expect(rows.map((x) => [x.event_seq, x.event_type, x.version_id])).toEqual([
      [1, 'ACCEPTED', S.terms1.versionId],
      [2, 'ACCEPTED', terms2.versionId],
    ]);
    // the acceptance of v1 is still on record, bound to v1's hash, although v1 is superseded
    expect(rows[0]!.body_sha256).toBe(S.terms1.hash);
    expect(await auditActions(S.alice.accountId)).toEqual(['CONSENT_ACCEPTED', 'CONSENT_ACCEPTED', 'CONSENT_ACCEPTED']);
    expect((await outboxRows(S.alice.accountId)).map((o) => o.event_type)).toEqual([CONSENT_EVENTS.accepted, CONSENT_EVENTS.accepted, CONSENT_EVENTS.accepted]);
    S.terms2 = terms2;
  });
});
const auditActions = async (accountId: string): Promise<string[]> => (await auditRows(accountId)).map((r) => r.action);

// ====================================================================== a second locale, the three re-acceptance modes and the roles (configuration through the real workflow)
/** Accepts every outstanding document of the evaluated locale exactly as shown (version id, locale and hash taken from the requirements). */
async function acceptShown(a: Actor, locale?: string): Promise<void> {
  const data = ok(await getReqs(a, locale), OP.requirements);
  for (const row of data.requirements) {
    if (!row.document) continue;
    const d = row.document;
    ok(await acceptRaw(a, row.purposeCode, { versionId: d.versionId, locale: d.locale, bodySha256: d.bodySha256 }), OP.accept);
  }
}
const statusesOf = (data: Json): Record<string, string> => Object.fromEntries(data.requirements.map((r: Json) => [r.purposeCode, r.status]));

describe('a second locale: legal documents are EXACT, never a fallback', () => {
  let termsEs: Pub;
  let privacyEs: Pub;
  beforeAll(async () => {
    await ensureLocale('es-MX', true);
    await ensureLocale('de-DE', true); // active, but Legal has published nothing in it
    await ensureLocale('fr-CA', false); // registered, not served
    termsEs = await publishLegal(TERMS_KEY, { locale: 'es-MX' });
    privacyEs = await publishLegal(PRIVACY_KEY, { locale: 'es-MX' });
  }, 60_000);

  it('?locale=es-MX shows the es-MX versions (equal to the public resolve in es-MX); the default stays en-US; the other locales have no document', async () => {
    const a = await newActor('es-view');
    const es = ok(await getReqs(a, 'es-MX'), OP.requirements);
    expect(es.locale).toBe('es-MX');
    for (const [code, key, pub] of [
      [TERMS, TERMS_KEY, termsEs],
      [PRIVACY, PRIVACY_KEY, privacyEs],
    ] as const) {
      const d = rowOf(es, code).document;
      expect(d).toMatchObject({ entryKey: key, versionId: pub.versionId, version: 1, locale: 'es-MX', bodySha256: pub.hash });
      const resolved = ok(await call(undefined, 'POST', '/content/resolve', { body: { key, locale: 'es-MX' }, as: null }));
      expect([resolved.versionId, resolved.bodySha256, resolved.resolvedLocale]).toEqual([d.versionId, d.bodySha256, 'es-MX']);
      expect((await expectParity(a, { code, entryKey: key, entryId: '' }, 'es-MX', code))!.versionId).toBe(pub.versionId);
    }
    expect(rowOf(ok(await getReqs(a), OP.requirements), TERMS).document.locale).toBe('en-US');
    for (const locale of ['de-DE', 'fr-CA']) {
      const data = ok(await getReqs(a, locale), OP.requirements);
      expect(data.locale).toBe(locale);
      expect(statusesOf(data)).toEqual({ [PRIVACY]: 'DOCUMENT_UNAVAILABLE', [TERMS]: 'DOCUMENT_UNAVAILABLE' });
      for (const row of data.requirements) expect(row.document).toBeNull();
    }
    // an unregistered tag is a validation failure, not a fallback
    fail(await getReqs(a, 'it-IT'), 400, 'ACCOUNT_VALIDATION_FAILED');
    fail(await getReqs(a, 'es-mx'), 400, 'ACCOUNT_VALIDATION_FAILED');
  });

  it('asking the en-US text under es-MX (or the reverse) is 400 LOCALE_MISMATCH; the hash of the other language under the right locale is 400 HASH_MISMATCH; nothing is written', async () => {
    const a = await newActor('es-claims');
    const before = await writes();
    const enOnEs = { versionId: S.terms2.versionId, locale: 'es-MX', bodySha256: S.terms2.hash };
    const esOnEn = { versionId: termsEs.versionId, locale: 'en-US', bodySha256: termsEs.hash };
    consentFail(await acceptRaw(a, TERMS, enOnEs), 400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH', 'account.consent.error.locale_mismatch');
    consentFail(await acceptRaw(a, TERMS, esOnEn), 400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH', 'account.consent.error.locale_mismatch');
    consentFail(
      await acceptRaw(a, TERMS, { ...claimOf(termsEs), bodySha256: S.terms2.hash }),
      400,
      'ACCOUNT_CONSENT_HASH_MISMATCH',
      'account.consent.error.hash_mismatch',
    );
    // a version of the other document in the same language is not found, whatever the locale says
    consentFail(await acceptRaw(a, TERMS, claimOf(privacyEs)), 404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'account.consent.error.version_not_found');
    expect(await writes()).toEqual(before);
    // each language accepts on its own, with its own hash; the events say which
    expect(ok(await acceptDoc(a, TERMS, termsEs), OP.accept).event.document).toEqual({
      versionId: termsEs.versionId,
      version: 1,
      locale: 'es-MX',
      bodySha256: termsEs.hash,
    });
  });

  it('REACCEPT_REQUIRED: an acceptance in en-US does not satisfy es-MX (and the reverse); each switch is a new event and the history keeps both languages', async () => {
    const lena = await newActor('lena');
    await acceptShown(lena);
    expect(ok(await getReqs(lena), OP.requirements).satisfied).toBe(true);
    const es = ok(await getReqs(lena, 'es-MX'), OP.requirements);
    expect(statusesOf(es)).toEqual({ [PRIVACY]: 'REACCEPTANCE_REQUIRED', [TERMS]: 'REACCEPTANCE_REQUIRED' });
    expect(rowOf(es, TERMS).accepted.document.locale).toBe('en-US');
    expect(rowOf(es, TERMS).document.locale).toBe('es-MX');
    expect(es.satisfied).toBe(false);
    await acceptShown(lena, 'es-MX');
    expect(ok(await getReqs(lena, 'es-MX'), OP.requirements).satisfied).toBe(true);
    // the latest acceptance is the es-MX text, so the en-US evaluation asks again
    expect(statusesOf(ok(await getReqs(lena), OP.requirements))).toEqual({ [PRIVACY]: 'REACCEPTANCE_REQUIRED', [TERMS]: 'REACCEPTANCE_REQUIRED' });
    const list = ok(await getConsents(lena), OP.consents);
    expect(list.history.map((e: Json) => [e.purposeCode, e.eventSeq, e.document.locale]).sort()).toEqual(
      [
        [PRIVACY, 1, 'en-US'],
        [PRIVACY, 2, 'es-MX'],
        [TERMS, 1, 'en-US'],
        [TERMS, 2, 'es-MX'],
      ].sort(),
    );
  });

  it('the three modes through the real change-request workflow (two approvers): the effect is visible over HTTP for accounts that accepted en-US v1 while Terms v2 and es-MX exist', async () => {
    const newbie = await newActor('modes-new');
    const results: Record<string, Record<string, Record<string, string>>> = {};
    try {
      for (const mode of ['REACCEPT_REQUIRED', 'REACCEPT_FOR_NEW_USERS_ONLY', 'NO_REACCEPT'] as const) {
        await setSeededPolicy({ mode });
        const out: Record<string, Record<string, string>> = {};
        for (const locale of ['en-US', 'es-MX', 'de-DE']) {
          const frank = ok(await getReqs(S.frank, locale), OP.requirements);
          for (const row of frank.requirements) expect(row.reacceptance).toBe(mode);
          out[`frank ${locale}`] = statusesOf(frank);
          out[`newbie ${locale}`] = statusesOf(ok(await getReqs(newbie, locale), OP.requirements));
        }
        results[mode] = out;
      }
    } finally {
      await resetSeededPolicy();
    }
    const both = (s: string) => ({ [PRIVACY]: s, [TERMS]: s });
    // frank accepted Terms v1 and Privacy v1 in en-US; Terms v2 is in force; es-MX exists; de-DE has no document
    expect(results.REACCEPT_REQUIRED).toEqual({
      'frank en-US': { [PRIVACY]: 'SATISFIED', [TERMS]: 'REACCEPTANCE_REQUIRED' },
      'newbie en-US': both('OUTSTANDING'),
      'frank es-MX': both('REACCEPTANCE_REQUIRED'),
      'newbie es-MX': both('OUTSTANDING'),
      'frank de-DE': both('DOCUMENT_UNAVAILABLE'),
      'newbie de-DE': both('DOCUMENT_UNAVAILABLE'),
    });
    expect(results.REACCEPT_FOR_NEW_USERS_ONLY).toEqual({
      'frank en-US': both('SATISFIED'), // same locale, any earlier version
      'newbie en-US': both('OUTSTANDING'),
      'frank es-MX': both('OUTSTANDING'), // a different locale never satisfies
      'newbie es-MX': both('OUTSTANDING'),
      'frank de-DE': both('DOCUMENT_UNAVAILABLE'),
      'newbie de-DE': both('DOCUMENT_UNAVAILABLE'),
    });
    expect(results.NO_REACCEPT).toEqual({
      'frank en-US': both('SATISFIED'),
      'newbie en-US': both('OUTSTANDING'),
      'frank es-MX': both('SATISFIED'), // any version in any locale
      'newbie es-MX': both('OUTSTANDING'),
      'frank de-DE': both('SATISFIED'), // an acceptance is not undone by a locale without a document
      'newbie de-DE': both('DOCUMENT_UNAVAILABLE'),
    });
    // the seeded policy is back
    expect(statusesOf(ok(await getReqs(S.frank), OP.requirements))).toEqual({ [PRIVACY]: 'SATISFIED', [TERMS]: 'REACCEPTANCE_REQUIRED' });
  }, 90_000);

  it('when NO document is in force in the evaluated locale (the entry is switched off): NO_REACCEPT and the same-locale mode keep an accepted account SATISFIED, REACCEPT_REQUIRED does not', async () => {
    const seen: Record<string, string> = {};
    try {
      await content.setEntryActive(PRIVACY_KEY, false, 'itest', AUTHOR);
      expect(rowOf(ok(await getReqs(S.frank), OP.requirements), PRIVACY).document).toBeNull();
      for (const mode of ['REACCEPT_REQUIRED', 'REACCEPT_FOR_NEW_USERS_ONLY', 'NO_REACCEPT'] as const) {
        await setSeededPolicy({ mode });
        const data = ok(await getReqs(S.frank), OP.requirements);
        seen[mode] = rowOf(data, PRIVACY).status;
        expect(rowOf(data, PRIVACY).acceptanceState).toBe('ACCEPTED');
        // an account that never accepted is DOCUMENT_UNAVAILABLE in every mode
        const nobody = await newActor('nodoc');
        expect(rowOf(ok(await getReqs(nobody), OP.requirements), PRIVACY).status).toBe('DOCUMENT_UNAVAILABLE');
      }
    } finally {
      await content.setEntryActive(PRIVACY_KEY, true, 'itest', AUTHOR);
      await resetSeededPolicy();
    }
    expect(seen).toEqual({ REACCEPT_REQUIRED: 'DOCUMENT_UNAVAILABLE', REACCEPT_FOR_NEW_USERS_ONLY: 'SATISFIED', NO_REACCEPT: 'SATISFIED' });
    expect(rowOf(ok(await getReqs(S.frank), OP.requirements), PRIVACY).status).toBe('SATISFIED');
  }, 90_000);
});

describe('roles: the union of the pending and active roles decides what is required', () => {
  afterAll(resetSeededPolicy);

  it('required_for ["PROVIDER"]: a CUSTOMER-only account gets NOT_REQUIRED (and may still accept voluntarily); PROVIDER, both roles and a PENDING provider role are required; a deactivated one is not', async () => {
    await setSeededPolicy({ requiredFor: ['PROVIDER'] });
    const custOnly = await newActor('r-cust', { roles: ['customer'] });
    const provOnly = await newActor('r-prov', { roles: ['provider'] });
    const both = await newActor('r-both', { roles: ['customer', 'provider'] });
    const pending = await newActor('r-pending', { roles: ['customer'] });
    await grant(pending, 'PROVIDER', true);
    const gone = await newActor('r-gone', { roles: ['customer', 'provider'] });
    await revokeRole(gone, 'PROVIDER');
    const nobody = await newActor('r-none', { roles: [] });
    const expected: [Actor, boolean][] = [
      [custOnly, false],
      [provOnly, true],
      [both, true],
      [pending, true],
      [gone, false],
      [nobody, false],
    ];
    for (const [who, required] of expected) {
      const data = ok(await getReqs(who), OP.requirements);
      for (const row of data.requirements) {
        expect(row.required, who.label).toBe(required);
        expect(row.status, who.label).toBe(required ? 'OUTSTANDING' : 'NOT_REQUIRED');
      }
      expect(data.satisfied, who.label).toBe(!required);
      expect(data.outstanding, who.label).toEqual(required ? [PRIVACY, TERMS] : []);
    }
    // voluntary acceptance: allowed, recorded, but the purpose stays NOT_REQUIRED for the account
    expect(ok(await acceptDoc(custOnly, TERMS, S.terms2), OP.accept).changed).toBe(true);
    const row = rowOf(ok(await getReqs(custOnly), OP.requirements), TERMS);
    expect(row).toMatchObject({ required: false, status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED' });
    expect(row.accepted.eventSeq).toBe(1);
    // the role set is read fresh: granting the provider role makes it required at once, deactivating it ends that
    await grant(custOnly, 'PROVIDER');
    expect(rowOf(ok(await getReqs(custOnly), OP.requirements), TERMS)).toMatchObject({ required: true, status: 'SATISFIED' });
    expect(rowOf(ok(await getReqs(custOnly), OP.requirements), PRIVACY)).toMatchObject({ required: true, status: 'OUTSTANDING' });
    await revokeRole(custOnly, 'PROVIDER');
    expect(rowOf(ok(await getReqs(custOnly), OP.requirements), PRIVACY)).toMatchObject({ required: false, status: 'NOT_REQUIRED' });
    // the active-role header never narrows the union
    const withHeader = ok(await getReqs(both, undefined, { headers: { 'x-active-role': 'CUSTOMER' } }), OP.requirements);
    expect(withHeader.requirements.every((r: Json) => r.required)).toBe(true);
  }, 90_000);

  it('required_for ["CUSTOMER"] and [] : a provider-only account is not required under the first; nobody is under the second', async () => {
    await setSeededPolicy({ requiredFor: ['CUSTOMER'] });
    const provOnly = await newActor('r2-prov', { roles: ['provider'] });
    const custPending = await newActor('r2-cust', { roles: ['provider'] });
    await grant(custPending, 'CUSTOMER', true);
    expect(ok(await getReqs(provOnly), OP.requirements).requirements.map((r: Json) => r.required)).toEqual([false, false]);
    expect(ok(await getReqs(custPending), OP.requirements).requirements.map((r: Json) => r.required)).toEqual([true, true]);
    await setSeededPolicy({ requiredFor: [] });
    for (const who of [provOnly, custPending, S.alice]) {
      const data = ok(await getReqs(who), OP.requirements);
      expect(data.requirements.map((r: Json) => r.required)).toEqual([false, false]);
      expect(data.satisfied).toBe(true);
    }
    // alice's acceptance state is unchanged by the policy change: it is derived from her events
    expect(rowOf(ok(await getReqs(S.alice), OP.requirements), TERMS)).toMatchObject({ status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED' });
    await resetSeededPolicy();
    expect(ok(await getReqs(provOnly), OP.requirements).requirements.map((r: Json) => r.required)).toEqual([true, true]);
  }, 90_000);

  it('the seeded policy is restored exactly (same values, new versions of the same parameters)', async () => {
    await resetSeededPolicy();
    const values = (await configuration.resolveMany([requiredForKey(TERMS), reacceptKey(TERMS), requiredForKey(PRIVACY), reacceptKey(PRIVACY)])).values;
    expect([...values.values()].map((v) => v.value)).toEqual(expect.arrayContaining([DEFAULT_REQUIRED, 'REACCEPT_REQUIRED']));
    expect(values.get(requiredForKey(TERMS))!.value).toEqual(DEFAULT_REQUIRED);
    expect(values.get(reacceptKey(PRIVACY))!.value).toBe('REACCEPT_REQUIRED');
    expect(
      await count(
        `SELECT 1 FROM configuration.change_requests cr JOIN configuration.parameters p ON p.parameter_id = cr.parameter_id WHERE p.key = $1 AND cr.state = 'ACTIVE'`,
        [requiredForKey(TERMS)],
      ),
    ).toBe(1);
  });
});

// ====================================================================== what the person reads is pinned (a renderer change must fail here, on purpose)
describe('the pinned rendering of a LEGAL markdown fixture', () => {
  const FIXTURE = [
    '# Pinned terms',
    '',
    'Some **bold** and *italic* text with a [link](https://example.com/terms).',
    '',
    '- first item',
    '- second item',
    '',
    '<script>alert(1)</script>',
    '',
    'Tom & Jerry say 1 < 2 and "quotes".',
  ].join('\n');
  it('publishes it through the real workflow, resolves it publicly and pins the sanitized value; the evidence hash is the SOURCE text, not the rendering', async () => {
    const doc = await registerDoc({ requiredFor: [] });
    // an unsafe link destination is refused at authoring time: it can never be published, resolved or accepted
    await expect(content.createVersion(doc.entryKey, { locale: 'en-US', body: '[bad](javascript:alert(1))', reason: 'itest' }, AUTHOR)).rejects.toMatchObject({
      code: 'TEMPLATE_ERROR',
    });
    const created = await content.createVersion(doc.entryKey, { locale: 'en-US', body: FIXTURE, reason: 'itest' }, AUTHOR);
    await content.submit(created.versionId, AUTHOR);
    await content.approve(created.versionId, APPROVER, 'ok');
    const v = await content.publish(created.versionId, AUTHOR);
    const a = await newActor('pinned');
    const d = rowOf(ok(await getReqs(a), OP.requirements), doc.code).document;
    expect(d.versionId).toBe(v.versionId);
    expect(d.bodySha256).toBe(hashOf(FIXTURE));
    const r = ok(await call(undefined, 'POST', '/content/resolve', { body: { key: doc.entryKey, locale: 'en-US' }, as: null }));
    expect(r.versionId).toBe(v.versionId);
    expect(r.bodySha256).toBe(hashOf(FIXTURE));
    expect(r.format).toBe('html');
    expect(hashOf(r.value), 'the rendered output is not what the hash covers').not.toBe(r.bodySha256);
    expect(r.value).toBe(PINNED_HTML);
    // accepting records the SOURCE version
    const accepted = ok(await acceptRaw(a, doc.code, { versionId: d.versionId, locale: d.locale, bodySha256: d.bodySha256 }), OP.accept);
    expect(accepted.event.document.bodySha256).toBe(hashOf(FIXTURE));
  });
});
/** The exact sanitized output of the fixture (script text escaped, links rel-hardened). A renderer change must fail the test above on purpose. */
const PINNED_HTML =
  '<h2>Pinned terms</h2><p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://example.com/terms" rel="noopener noreferrer nofollow">link</a>.</p><ul><li>first item</li><li>second item</li></ul><p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>Tom &amp; Jerry say 1 &lt; 2 and &quot;quotes&quot;.</p>';

// ====================================================================== a WITHDRAWABLE purpose (a test purpose with its own LEGAL document and real configuration parameters)
describe('a WITHDRAWABLE purpose: accept, withdraw, repeat, re-grant, REQUIRED_FOR_ROLE, NOT_ACCEPTED, INACTIVE', () => {
  let W: Doc;
  let w1: Pub;
  const NOT_ACCEPTED = 'account.consent.error.not_accepted';
  const REQUIRED = 'account.consent.error.required_for_role';
  beforeAll(async () => {
    W = await registerDoc({ withdrawable: true, requiredFor: [] });
    w1 = await publishLegal(W.entryKey);
  }, 60_000);
  afterAll(async () => {
    policyOverride = null;
    await retireAll();
  });

  it('nothing accepted: the purpose is listed NONE and withdrawable, and withdrawing is 409 NOT_ACCEPTED with no write', async () => {
    const a = await newActor('w-none');
    const list = ok(await getConsents(a), OP.consents);
    expect(list.current.find((c: Json) => c.purposeCode === W.code)).toMatchObject({ state: 'NONE', withdrawable: true, latest: null });
    const before = await writes();
    consentFail(await withdraw(a, W.code), 409, 'ACCOUNT_CONSENT_NOT_ACCEPTED', NOT_ACCEPTED);
    consentFail(await withdraw(a, W.code, { body: {} }), 409, 'ACCOUNT_CONSENT_NOT_ACCEPTED', NOT_ACCEPTED);
    expect(await writes()).toEqual(before);
  });

  it('accept, withdraw (no body), repeat withdraw ({}) and re-grant: events 1..4, the withdrawal carries the accepted version, locale and hash, and each change is audited and announced', async () => {
    const a = await newActor('w-flow');
    const session = (await sessionRowOf(a.t0.sid))!;
    const acc = ok(await acceptDoc(a, W.code, w1), OP.accept);
    expect(acc).toMatchObject({ changed: true, event: { eventSeq: 1, eventType: 'ACCEPTED' } });
    expect(rowOf(ok(await getReqs(a), OP.requirements), W.code)).toMatchObject({
      required: false,
      status: 'NOT_REQUIRED',
      acceptanceState: 'ACCEPTED',
      withdrawable: true,
      reacceptance: 'REACCEPT_REQUIRED',
    });

    const wd = await withdraw(a, W.code);
    const w = ok(wd, OP.withdraw);
    expect(w.changed).toBe(true);
    expect(w.event).toMatchObject({ eventType: 'WITHDRAWN', eventSeq: 2, purposeCode: W.code, source: 'ACCOUNT_API' });
    expect(w.event.document).toEqual(acc.event.document);
    expect(w.event.consentEventId).not.toBe(acc.event.consentEventId);
    const rows = await eventRows(a.accountId, W.code);
    expect(rows[1]).toMatchObject({
      event_type: 'WITHDRAWN',
      application_session_id: session.application_session_id,
      correlation_id: wd.cid,
      version_id: w1.versionId,
      body_sha256: w1.hash,
    });
    const audit = await auditRows(a.accountId);
    expect(audit[1]).toMatchObject({
      action: 'CONSENT_WITHDRAWN',
      changes: { purposeCode: W.code, eventSeq: 2 },
      consent_event_id: w.event.consentEventId,
      correlation_id: wd.cid,
    });
    const outbox = await outboxRows(a.accountId);
    expect(outbox[1]).toMatchObject({ event_type: CONSENT_EVENTS.withdrawn, aggregate_type: 'identity_account', aggregate_id: a.accountId });
    expect(outbox[1]!.payload_json).toEqual({
      accountId: a.accountId,
      purposeCode: W.code,
      consentEventId: w.event.consentEventId,
      eventSeq: 2,
      contentVersionId: w1.versionId,
    });

    const state = ok(await getConsents(a), OP.consents).current.find((c: Json) => c.purposeCode === W.code);
    expect(state).toMatchObject({ state: 'WITHDRAWN', withdrawable: true });
    expect(state.latest).toEqual(w.event);
    expect(rowOf(ok(await getReqs(a), OP.requirements), W.code)).toMatchObject({ acceptanceState: 'WITHDRAWN', accepted: null, status: 'NOT_REQUIRED' });

    const mine = await counts(a.accountId);
    for (let i = 0; i < 3; i++) {
      const again = ok(await withdraw(a, W.code, { body: {} }), OP.withdraw);
      expect(again.changed).toBe(false);
      expect(again.event).toEqual(w.event);
    }
    expect(await counts(a.accountId)).toEqual(mine);

    const regrant = ok(await acceptDoc(a, W.code, w1), OP.accept);
    expect(regrant).toMatchObject({ changed: true, event: { eventType: 'ACCEPTED', eventSeq: 3 } });
    expect(ok(await acceptDoc(a, W.code, w1), OP.accept).changed).toBe(false);
    expect(ok(await withdraw(a, W.code), OP.withdraw)).toMatchObject({ changed: true, event: { eventSeq: 4 } });
    expect((await eventRows(a.accountId, W.code)).map((r) => [r.event_seq, r.event_type])).toEqual([
      [1, 'ACCEPTED'],
      [2, 'WITHDRAWN'],
      [3, 'ACCEPTED'],
      [4, 'WITHDRAWN'],
    ]);
    expect((await auditRows(a.accountId)).map((r) => r.action)).toEqual(['CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN', 'CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN']);
    expect((await outboxRows(a.accountId)).map((r) => r.event_type)).toEqual([
      CONSENT_EVENTS.accepted,
      CONSENT_EVENTS.withdrawn,
      CONSENT_EVENTS.accepted,
      CONSENT_EVENTS.withdrawn,
    ]);
    const history = ok(await getConsents(a), OP.consents).history;
    expect(history.map((e: Json) => e.eventSeq)).toEqual([4, 3, 2, 1]);
  });

  it('REQUIRED_FOR_ROLE: while a role of the account requires the purpose (configuration changed through the workflow) a withdrawal is 409; a withdrawn account stays withdrawn (idempotent); roles are the union, a PENDING one counts, a deactivated one does not', async () => {
    const u1 = await newActor('w-req-cust');
    const u2 = await newActor('w-req-withdrawn');
    const prov = await newActor('w-req-prov', { roles: ['provider'] });
    const pend = await newActor('w-req-pending');
    await grant(pend, 'PROVIDER', true);
    const gone = await newActor('w-req-gone', { roles: ['customer', 'provider'] });
    await revokeRole(gone, 'PROVIDER');
    for (const who of [u1, u2, prov, pend, gone]) ok(await acceptDoc(who, W.code, w1), OP.accept);
    ok(await withdraw(u2, W.code), OP.withdraw);
    try {
      await setConfig(requiredForKey(W.code), ['CUSTOMER']);
      const before = await writes();
      consentFail(await withdraw(u1, W.code), 409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE', REQUIRED);
      consentFail(await withdraw(pend, W.code), 409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE', REQUIRED);
      consentFail(await withdraw(gone, W.code), 409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE', REQUIRED);
      expect(await writes()).toEqual(before);
      expect(ok(await withdraw(prov, W.code), OP.withdraw).changed).toBe(true); // a provider-only account is not required
      expect(ok(await withdraw(u2, W.code), OP.withdraw).changed).toBe(false); // already withdrawn: nothing to refuse
      expect(rowOf(ok(await getReqs(u2), OP.requirements), W.code)).toMatchObject({ required: true, status: 'OUTSTANDING', acceptanceState: 'WITHDRAWN' });
      expect(rowOf(ok(await getReqs(u1), OP.requirements), W.code)).toMatchObject({ required: true, status: 'SATISFIED' });

      await setConfig(requiredForKey(W.code), ['PROVIDER']);
      consentFail(await withdraw(pend, W.code), 409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE', REQUIRED); // a pending provider role still needs the provider's agreement
      expect(ok(await withdraw(gone, W.code), OP.withdraw).changed).toBe(true); // the deactivated provider role does not
      expect(ok(await withdraw(u1, W.code), OP.withdraw).changed).toBe(true); // customer-only under ["PROVIDER"]
    } finally {
      await setConfig(requiredForKey(W.code), []);
    }
    expect(ok(await withdraw(pend, W.code), OP.withdraw).changed).toBe(true);
  }, 90_000);

  it('an INACTIVE purpose cannot be accepted (409) but an identical earlier acceptance is still reported, may be withdrawn even when the policy is unavailable, and is listed only for accounts with events', async () => {
    const holder = await newActor('w-inactive-holder');
    const newcomer = await newActor('w-inactive-new');
    ok(await acceptDoc(holder, W.code, w1), OP.accept);
    await setPurposeStatus(W.code, 'INACTIVE');
    try {
      consentFail(await acceptDoc(newcomer, W.code, w1), 409, 'ACCOUNT_CONSENT_PURPOSE_INACTIVE', 'account.consent.error.purpose_inactive');
      expect(ok(await acceptDoc(holder, W.code, w1), OP.accept).changed).toBe(false);
      expect(ok(await getReqs(holder), OP.requirements).requirements.map((r: Json) => r.purposeCode)).not.toContain(W.code);
      expect(ok(await getConsents(holder), OP.consents).current.map((c: Json) => c.purposeCode)).toContain(W.code);
      expect(ok(await getConsents(newcomer), OP.consents).current.map((c: Json) => c.purposeCode)).not.toContain(W.code);
      policyOverride = async () => {
        throw new Error('policy down');
      };
      expect(ok(await withdraw(holder, W.code), OP.withdraw).changed).toBe(true);
    } finally {
      policyOverride = null;
      await setPurposeStatus(W.code, 'ACTIVE');
    }
    expect(ok(await getReqs(newcomer), OP.requirements).requirements.map((r: Json) => r.purposeCode)).toContain(W.code);
  });
});

// ====================================================================== policy outages fail closed
describe('an unavailable or invalid policy fails closed with a generic 503', () => {
  const MARKER = `POLICYSECRET${randomUUID().replaceAll('-', '')}`;
  secrets.serverMarkers.push(MARKER);
  afterAll(async () => {
    policyOverride = null;
    await resetSeededPolicy();
  });

  it('configuration provider failing: requirements and an ACTIVE withdrawal are 503, accept and the history read (no policy) and a NOT_WITHDRAWABLE refusal still work; nothing leaks', async () => {
    const a = await newActor('outage');
    const wDoc = await registerDoc({ withdrawable: true, requiredFor: [] });
    const w = await publishLegal(wDoc.entryKey);
    ok(await acceptDoc(a, wDoc.code, w), OP.accept);
    policyOverride = async () => {
      throw new Error(`registry down ${MARKER}`);
    };
    try {
      for (const r of [await getReqs(a), await getReqs(a, 'en-US'), await withdraw(a, wDoc.code)]) {
        const e = fail(r, 503, 'ACCOUNT_UNAVAILABLE');
        expect(e.category).toBe('DEPENDENCY');
        expect(r.raw).not.toContain(MARKER);
        expect(JSON.stringify(e.details ?? {})).not.toMatch(/POLICY|purposeCode|registry/);
      }
      expect(ok(await getConsents(a), OP.consents).current.length).toBeGreaterThan(0);
      consentFail(await withdraw(a, TERMS), 409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'account.consent.error.not_withdrawable');
      const fresh = await newActor('outage-accept');
      expect(ok(await acceptDoc(fresh, TERMS, S.terms2), OP.accept).changed).toBe(true); // accepting reads no policy
      expect((await eventRows(a.accountId, wDoc.code)).map((r) => r.event_type)).toEqual(['ACCEPTED']); // the failed withdrawal wrote nothing
    } finally {
      policyOverride = null;
    }
    expect(ok(await withdraw(a, wDoc.code), OP.withdraw).changed).toBe(true);
    await retireAll();
  });

  it('a failing configuration registry (the real provider over a registry that throws) is 503; so is an unknown role in the configured list and an unavailable default locale (an explicit locale still works)', async () => {
    const a = await newActor('outage-registry');
    const down = await makeApp({
      policy: createConsentPolicyProvider({
        resolveMany: async () => {
          throw new Error(`registry down ${MARKER}`);
        },
      } as never),
    });
    const r = await getReqs(a, undefined, { app: down });
    fail(r, 503, 'ACCOUNT_UNAVAILABLE');
    expect(r.raw).not.toContain(MARKER);
    expect(ok(await getConsents(a, { app: down }), OP.consents).history).toEqual([]);

    // a role code that does not exist is an invalid policy, never "nobody is required"
    await setConfig(requiredForKey(PRIVACY), ['NOPE_ROLE']);
    try {
      const bad = await getReqs(a);
      fail(bad, 503, 'ACCOUNT_UNAVAILABLE');
      expect(bad.raw).not.toContain('NOPE_ROLE');
    } finally {
      await setConfig(requiredForKey(PRIVACY), DEFAULT_REQUIRED);
    }
    expect(ok(await getReqs(a), OP.requirements).requirements).toHaveLength(2);

    const noDefault = await makeApp({
      defaultLocale: async () => {
        throw new Error(`no default ${MARKER}`);
      },
    });
    const fresh = await newActor('outage-locale');
    const failing = await getReqs(fresh, undefined, { app: noDefault });
    fail(failing, 503, 'ACCOUNT_UNAVAILABLE');
    expect(failing.raw).not.toContain(MARKER);
    expect(ok(await getReqs(fresh, 'en-US', { app: noDefault }), OP.requirements).locale).toBe('en-US');
  }, 90_000);
});

// ====================================================================== accounts, contexts, sessions
describe('isolation between accounts, the contexts and account states, and revoked sessions', () => {
  const adminClaims = (sub: string) => ({
    sub,
    azp: 'bananagig-admin',
    resource_access: { 'bananagig-admin': { roles: ['admin-console-access', 'content-read'] } },
    realm_access: { roles: [] },
  });
  const routes = (p: Pub): [string, string, unknown][] => [
    ['GET', CONS, undefined],
    ['GET', `${CONS}/requirements`, undefined],
    ['POST', `${CONS}/${TERMS}/accept`, claimOf(p)],
    ['POST', `${CONS}/${TERMS}/withdraw`, undefined],
    ['POST', `${CONS}/${PRIVACY}/withdraw`, {}],
  ];

  it('one account never sees or affects another: no account id is accepted (body, query, header) or echoed, and each account has its own events', async () => {
    const a = await newActor('iso-a');
    const b = await newActor('iso-b');
    ok(await acceptDoc(a, TERMS, S.terms2), OP.accept);
    const aIds = (await eventRows(a.accountId)).map((r) => r.consent_event_id);
    const before = await writes();
    for (const extra of [
      { accountId: a.accountId },
      { account_id: a.accountId },
      { subject: a.sub },
      { sub: a.sub },
      { sid: a.t0.sid },
      { applicationSessionId: randomUUID() },
      { sessionId: randomUUID() },
    ]) {
      fail(await acceptRaw(b, TERMS, { ...claimOf(S.terms2), ...extra }), 400, 'VALIDATION_FAILED');
      fail(await withdraw(b, TERMS, { body: extra }), 400, 'VALIDATION_FAILED');
      const key = Object.keys(extra)[0]!;
      fail(await call(b, 'GET', `${CONS}?${key}=${encodeURIComponent(String(Object.values(extra)[0]))}`), 400, 'VALIDATION_FAILED');
      fail(await call(b, 'GET', `${CONS}/requirements?${key}=${encodeURIComponent(String(Object.values(extra)[0]))}`), 400, 'VALIDATION_FAILED');
    }
    expect(await writes()).toEqual(before);
    // a header naming the other account changes nothing: the account comes from the verified token only
    const spoof = { 'x-account-id': a.accountId, 'x-forwarded-user': a.sub };
    const bList = await getConsents(b, { headers: spoof });
    expect(ok(bList, OP.consents).history).toEqual([]);
    for (const id of aIds) expect(bList.raw).not.toContain(id);
    expect(rowOf(ok(await getReqs(b, undefined, { headers: spoof }), OP.requirements), TERMS).acceptanceState).toBe('NONE');
    // b accepts on its own: its event is not a repeat of a's
    const bAccept = ok(await acceptDoc(b, TERMS, S.terms2, { headers: spoof }), OP.accept);
    expect(bAccept.changed).toBe(true);
    expect(aIds).not.toContain(bAccept.event.consentEventId);
    expect((await eventRows(b.accountId)).map((r) => r.account_id)).toEqual([b.accountId]);
    expect((await eventRows(a.accountId)).map((r) => r.consent_event_id)).toEqual(aIds);
  });

  it('401 on every route without a usable token, and 401 wins over 400 (a garbage body, query or purpose with no token)', async () => {
    const before = await writes();
    for (const as of [null, 'garbage', 'a.b.c', `${(await mint({ sub: 'x' })).token}x`]) {
      for (const [method, url, body] of routes(S.terms2)) {
        const r = await call(undefined, method as 'GET' | 'POST', url, { as, body });
        expect(r.status, `${method} ${url} ${String(as).slice(0, 8)}`).toBe(401);
        expect(ErrorResponse.safeParse(r.body).success).toBe(true);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['www-authenticate']).toBeDefined();
      }
      expect((await call(undefined, 'GET', `${CONS}/requirements?locale=&x=1`, { as })).status).toBe(401);
      expect((await call(undefined, 'POST', `${CONS}/lower_case/accept`, { as, body: { junk: 1 } })).status).toBe(401);
      // malformed JSON is rejected by the body parser before any hook runs (framework behaviour, 400 for everyone, never a write)
      expect((await call(undefined, 'POST', `${CONS}/${TERMS}/accept`, { as, rawBody: '{garbage' })).status).toBe(400);
      expect((await call(undefined, 'POST', `${CONS}/${TERMS}/withdraw`, { as, body: { x: 1 } })).status).toBe(401);
    }
    expect(await writes()).toEqual(before);
  });

  it('the admin-context token is 403 ACCOUNT_CONTEXT_NOT_SUPPORTED on every consent route and creates no account, session or event', async () => {
    const before = await writes();
    const sub = `itest-admin-${randomUUID()}`;
    secrets.subjects.push(sub);
    const t = await mint({ sub }, { claims: adminClaims(sub) });
    for (const [method, url, body] of routes(S.terms2)) {
      const e = fail(await call(undefined, method as 'GET' | 'POST', url, { as: t, body }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
      expect(e.category).toBe('AUTHORIZATION');
    }
    expect(await writes()).toEqual(before);
  });

  it('a SUSPENDED or CLOSED account is 403 before anything else on every route (known session, brand-new session), writes nothing, and works again when reactivated', async () => {
    const a = await newActor('status');
    ok(await acceptDoc(a, TERMS, S.terms2), OP.accept);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    const fresh = await mint(a);
    const before = await writes();
    for (const t of [a.t0, fresh]) {
      for (const [method, url, body] of routes(S.terms2)) {
        const e = fail(await call(a, method as 'GET' | 'POST', url, { as: t, body }), 403, 'ACCOUNT_SUSPENDED');
        expect(e.details).toEqual({ status: 'SUSPENDED' });
      }
      // 403 even for a body that would otherwise be a 400
      fail(await call(a, 'POST', `${CONS}/${TERMS}/accept`, { as: t, body: { junk: 1 } }), 403, 'ACCOUNT_SUSPENDED');
    }
    expect(await writes()).toEqual(before);
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest' });
    expect(ok(await getConsents(a), OP.consents).history).toHaveLength(1);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(a.accountId, 'CLOSED', { actor: 'system:itest', reason: 'itest' });
    const before2 = await writes();
    for (const [method, url, body] of routes(S.terms2)) fail(await call(a, method as 'GET' | 'POST', url, { body }), 403, 'ACCOUNT_CLOSED');
    expect(await writes()).toEqual(before2);
    // history survives (the closed account keeps its rows; the database refuses new events for it)
    expect(await eventRows(a.accountId)).toHaveLength(1);
  });

  it("a revoked session is 401 SESSION_REVOKED on the very next request on every consent route, writes nothing, and the account's other session keeps working", async () => {
    const a = await newActor('revoked');
    const s2 = await login(a);
    const id = (await sessionRowOf(s2.sid))!.application_session_id;
    ok(await getConsents(a, { as: s2 }), OP.consents);
    const rev = await call(a, 'DELETE', `/account/security/sessions/${id}`);
    expect(rev.status, rev.raw).toBe(200);
    const before = await writes();
    for (const [method, url, body] of routes(S.terms2)) {
      const r = await call(a, method as 'GET' | 'POST', url, { as: s2, body });
      const e = fail(r, 401, 'SESSION_REVOKED');
      expect(e.category).toBe('AUTHENTICATION');
      expect(r.headers['www-authenticate']).toBe(SESSION_REVOKED_CHALLENGE);
      expect(e.details).toEqual({ messageKey: 'account.security.error.session_revoked' });
    }
    expect(await writes()).toEqual(before);
    expect(ok(await acceptDoc(a, TERMS, S.terms2), OP.accept).changed).toBe(true);
  });

  it('a token without a sid is 401 INVALID_TOKEN on every consent route (the security layer is wired) and creates nothing', async () => {
    const a = await newActor('nosid');
    const noSid = await mint(a, { sid: null });
    const before = await writes();
    for (const [method, url, body] of routes(S.terms2)) {
      const r = await call(a, method as 'GET' | 'POST', url, { as: noSid, body });
      fail(r, 401, 'INVALID_TOKEN');
      expect(r.headers['www-authenticate']).toBe(SESSION_REVOKED_CHALLENGE);
    }
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== atomicity
describe('the event, its audit row and its outbox event are one transaction', () => {
  const setup = async (table: string, column: string, like: string): Promise<void> => {
    await q('CREATE TABLE IF NOT EXISTS public.itest_fail_accounts (account_id text PRIMARY KEY)');
    await q(`CREATE OR REPLACE FUNCTION public.itest_fail_${table.split('.')[1]}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.itest_fail_accounts f WHERE f.account_id = NEW.${column}::text) AND ${like} THEN
          RAISE EXCEPTION 'itest forced failure ${table}';
        END IF;
        RETURN NEW;
      END $f$`);
    await q(`CREATE TRIGGER trg_itest_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.itest_fail_${table.split('.')[1]}()`);
  };
  const teardown = async (table: string): Promise<void> => {
    await q(`DROP TRIGGER IF EXISTS trg_itest_fail ON ${table}`);
    await q(`DROP FUNCTION IF EXISTS public.itest_fail_${table.split('.')[1]}()`);
  };
  afterAll(async () => {
    await teardown('integration.outbox_events');
    await teardown('identity.account_audit_events');
    await q('DROP TABLE IF EXISTS public.itest_fail_accounts');
  });

  for (const [table, column, like] of [
    ['integration.outbox_events', 'aggregate_id', `NEW.event_type LIKE 'bananagig.identity.consent-%'`],
    ['identity.account_audit_events', 'account_id', `NEW.action LIKE 'CONSENT\\_%'`],
  ] as const) {
    it(`a failure writing ${table} rolls the whole accept (and withdraw) back: no event, no audit row, no outbox event, no sequence gap; the retry succeeds`, async () => {
      const wDoc = await registerDoc({ withdrawable: true, requiredFor: [] });
      const w = await publishLegal(wDoc.entryKey);
      const a = await newActor('atomic');
      await setup(table, column, like);
      await q('INSERT INTO public.itest_fail_accounts (account_id) VALUES ($1)', [a.accountId]);
      try {
        const before = await writes();
        const mine = await counts(a.accountId);
        const r = await acceptDoc(a, wDoc.code, w);
        expect(r.status, r.raw).toBeGreaterThanOrEqual(500);
        expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.raw).not.toContain('itest forced failure');
        expect(await counts(a.accountId)).toEqual(mine);
        expect(await writes()).toEqual(before);
        // lift the failure, accept, then fail the withdrawal
        await q('DELETE FROM public.itest_fail_accounts WHERE account_id = $1', [a.accountId]);
        const okAccept = ok(await acceptDoc(a, wDoc.code, w), OP.accept);
        expect(okAccept).toMatchObject({ changed: true, event: { eventSeq: 1 } });
        expect(await counts(a.accountId)).toEqual({ events: 1, audit: 1, outbox: 1 });
        await q('INSERT INTO public.itest_fail_accounts (account_id) VALUES ($1)', [a.accountId]);
        const bad = await withdraw(a, wDoc.code);
        expect(bad.status).toBeGreaterThanOrEqual(500);
        expect(bad.raw).not.toContain('itest forced failure');
        expect(await counts(a.accountId)).toEqual({ events: 1, audit: 1, outbox: 1 });
        expect(rowOf(ok(await getReqs(a), OP.requirements), wDoc.code).acceptanceState).toBe('ACCEPTED');
        await q('DELETE FROM public.itest_fail_accounts WHERE account_id = $1', [a.accountId]);
        expect(ok(await withdraw(a, wDoc.code), OP.withdraw)).toMatchObject({ changed: true, event: { eventSeq: 2 } });
        expect(await counts(a.accountId)).toEqual({ events: 2, audit: 2, outbox: 2 });
      } finally {
        await q('DELETE FROM public.itest_fail_accounts');
        await teardown(table);
        await retireAll();
      }
    });
  }
});

// ====================================================================== concurrency over HTTP
/** SQL: every ACCEPTED event whose instant lies OUTSIDE the effective window of its version (there must be none: the guard trigger serializes with a publication). */
const windowViolations = () =>
  q<{ consent_event_id: string }>(
    `SELECT e.consent_event_id FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
      WHERE e.event_type = 'ACCEPTED' AND NOT (e.occurred_at >= v.effective_from AND (v.effective_to IS NULL OR e.occurred_at < v.effective_to))`,
  );
/** The invariants of one account's history of one purpose, whatever the interleaving: contiguous numbers, an ACCEPTED first, one audit row and one outbox event per event. */
async function expectConsistentHistory(accountId: string, purpose: string): Promise<EventRow[]> {
  const rows = await eventRows(accountId, purpose);
  rows.forEach((r, i) => expect(r.event_seq, `event ${i + 1}`).toBe(i + 1));
  expect(rows[0]?.event_type).toBe('ACCEPTED');
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.event_type, `same version: events alternate (${i + 1})`).not.toBe(rows[i - 1]!.event_type);
  // concurrent transactions start in a different order than they commit: order by the event number, which is the order of the history
  const audit = (await auditRows(accountId)).filter((r) => r.changes.purposeCode === purpose).sort((x, y) => x.changes.eventSeq - y.changes.eventSeq);
  const outbox = (await outboxRows(accountId))
    .filter((r) => r.payload_json.purposeCode === purpose)
    .sort((x, y) => x.payload_json.eventSeq - y.payload_json.eventSeq);
  expect(audit.map((r) => r.consent_event_id)).toEqual(rows.map((r) => r.consent_event_id));
  expect(outbox.map((r) => r.payload_json.consentEventId)).toEqual(rows.map((r) => r.consent_event_id));
  return rows;
}

describe('concurrency over HTTP', () => {
  let C: Doc;
  let c1: Pub;
  beforeAll(async () => {
    C = await registerDoc({ withdrawable: true, requiredFor: [] });
    c1 = await publishLegal(C.entryKey);
  }, 60_000);
  afterAll(retireAll);

  it('25 parallel identical accepts: all 200, exactly one changed:true, the same event for every caller, one audit row and one outbox event (3 rounds, fresh accounts)', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newActor(`cc-same-${round}`);
      const results = await Promise.all(Array.from({ length: 25 }, () => acceptDoc(a, TERMS, S.terms2)));
      const data = results.map((r) => ok(r, OP.accept));
      expect(data.filter((d) => d.changed)).toHaveLength(1);
      expect(new Set(data.map((d) => d.event.consentEventId)).size).toBe(1);
      expect(data.every((d) => d.event.eventSeq === 1)).toBe(true);
      expect(await counts(a.accountId)).toEqual({ events: 1, audit: 1, outbox: 1 });
      await expectConsistentHistory(a.accountId, TERMS);
    }
  });

  it('parallel accepts of both purposes and of many accounts at once never cross accounts or purposes', async () => {
    const people = await Promise.all(Array.from({ length: 8 }, (_, i) => newActor(`cc-many-${i}`)));
    const results = await Promise.all(
      people.flatMap((a) => [TERMS, PRIVACY].flatMap((p) => Array.from({ length: 3 }, () => acceptDoc(a, p, p === TERMS ? S.terms2 : S.privacy1)))),
    );
    for (const r of results) ok(r, OP.accept);
    for (const a of people) {
      expect((await counts(a.accountId)).events).toBe(2);
      await expectConsistentHistory(a.accountId, TERMS);
      await expectConsistentHistory(a.accountId, PRIVACY);
    }
  });

  it('25 parallel accepts of a version that is no longer in force are all 409 and write nothing', async () => {
    const a = await newActor('cc-stale');
    const before = await writes();
    const results = await Promise.all(Array.from({ length: 25 }, () => acceptDoc(a, TERMS, S.terms1)));
    for (const r of results) consentFail(r, 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
    expect(await writes()).toEqual(before);
  });

  it('accept racing withdraw on one account: the account lock serializes them; numbers stay contiguous, events alternate, and every change has its audit row and outbox event', async () => {
    for (let round = 0; round < 4; round++) {
      const accepted = await newActor(`cc-aw-${round}`);
      ok(await acceptDoc(accepted, C.code, c1), OP.accept);
      const start = await Promise.all([
        ...Array.from({ length: 8 }, () => acceptDoc(accepted, C.code, c1)),
        ...Array.from({ length: 8 }, () => withdraw(accepted, C.code)),
      ]);
      const data = start.map((r) => ok(r));
      const rows = await expectConsistentHistory(accepted.accountId, C.code);
      expect(data.filter((d) => d.changed).length + 1, 'every change is exactly one event').toBe(rows.length);
      const state = ok(await getConsents(accepted), OP.consents).current.find((c: Json) => c.purposeCode === C.code);
      expect(state.latest.eventSeq).toBe(rows.length);
      expect(state.state).toBe(rows[rows.length - 1]!.event_type === 'ACCEPTED' ? 'ACCEPTED' : 'WITHDRAWN');

      const fresh = await newActor(`cc-aw-fresh-${round}`);
      const mixed = await Promise.all([
        ...Array.from({ length: 6 }, () => acceptDoc(fresh, C.code, c1)),
        ...Array.from({ length: 6 }, () => withdraw(fresh, C.code)),
      ]);
      let changed = 0;
      for (const r of mixed) {
        if (r.status === 200) changed += ok(r).changed ? 1 : 0;
        else consentFail(r, 409, 'ACCOUNT_CONSENT_NOT_ACCEPTED', 'account.consent.error.not_accepted');
      }
      const freshRows = await expectConsistentHistory(fresh.accountId, C.code);
      expect(changed).toBe(freshRows.length);
    }
  }, 90_000);

  it('accept racing a REAL publication of the next version: each accept is a 200 that lies inside the window of its version, or a 409; never an acceptance after the window closed', async () => {
    const tally = { accepted: 0, refused: 0 };
    const rounds = 8;
    const prepared = await Promise.all(
      Array.from({ length: rounds }, async () => {
        const doc = await registerDoc({ requiredFor: [] });
        const v1 = await publishLegal(doc.entryKey);
        const v2 = await makeVersion(doc.entryKey, { stage: 'APPROVED' });
        return { doc, v1, v2, people: await Promise.all(Array.from({ length: 10 }, (_, i) => newActor(`cc-pub-${i}`))) };
      }),
    );
    for (const [round, { doc, v1, v2, people }] of prepared.entries()) {
      // the accepts start at once; the publication starts a little later each round, so the window closes at a different point of the accepts
      const [published, ...results] = await Promise.all([
        sleep(round * 6).then(() => content.publish(v2.versionId, AUTHOR)),
        ...people.map((a) => acceptDoc(a, doc.code, v1)),
      ]);
      expect(published.status).toBe('PUBLISHED');
      let landed = 0;
      for (const r of results) {
        if (r.status === 200) {
          expect(ok(r, OP.accept).changed).toBe(true);
          landed += 1;
        } else consentFail(r, 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
      }
      tally.accepted += landed;
      tally.refused += results.length - landed;
      const stored = await q<{ n: string }>(`SELECT count(*) AS n FROM identity.consent_events WHERE purpose_code = $1`, [doc.code]);
      expect(Number(stored[0]!.n), 'the stored events are exactly the accepted responses').toBe(landed);
      const v = await content.getVersion(v1.versionId);
      expect(v.status).toBe('SUPERSEDED');
      for (const r of await q<{ occurred_at: Date }>('SELECT occurred_at FROM identity.consent_events WHERE purpose_code = $1', [doc.code])) {
        expect(r.occurred_at.getTime()).toBeGreaterThanOrEqual(new Date(v.effectiveFrom).getTime());
        expect(r.occurred_at.getTime(), 'accepted inside the window').toBeLessThan(new Date(v.effectiveTo!).getTime());
      }
      // v1 is refused now for everybody who had not accepted it, and v2 is accepted
      const late = await newActor('cc-pub-late');
      consentFail(await acceptDoc(late, doc.code, v1), 409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', NOT_CURRENT);
      expect(ok(await acceptDoc(late, doc.code, v2), OP.accept).changed).toBe(true);
    }
    expect(tally.accepted + tally.refused).toBe(rounds * 10);
    expect(await windowViolations()).toEqual([]);
  }, 120_000);
});

// ====================================================================== contracts, caching and secrecy over EVERYTHING this file did (keep last)
type Schema = Record<string, Json>;
/** A small structural check of a value against an OpenAPI/JSON schema as Fastify emits it (inline schemas, anyOf for nullables): the list of violations. */
function conforms(schema: Schema, value: unknown, at = '$'): string[] {
  if (schema.anyOf) return (schema.anyOf as Schema[]).some((s) => conforms(s, value, at).length === 0) ? [] : [`${at}: no anyOf branch matches`];
  const errs: string[] = [];
  switch (schema.type) {
    case 'null':
      return value === null ? [] : [`${at}: expected null`];
    case 'string':
      if (typeof value !== 'string') return [`${at}: expected string`];
      if (schema.enum && !(schema.enum as unknown[]).includes(value)) errs.push(`${at}: not in the enum`);
      return errs;
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at}: expected integer`];
    case 'number':
      return typeof value === 'number' ? [] : [`${at}: expected number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: expected boolean`];
    case 'array':
      if (!Array.isArray(value)) return [`${at}: expected array`];
      value.forEach((v, i) => errs.push(...conforms(schema.items as Schema, v, `${at}[${i}]`)));
      return errs;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object`];
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const k of (schema.required ?? []) as string[]) if (!(k in value)) errs.push(`${at}.${k}: missing`);
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) errs.push(...conforms(props[k], v, `${at}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not declared`);
      }
      return errs;
    }
    default:
      return [`${at}: unsupported schema ${JSON.stringify(schema).slice(0, 60)}`];
  }
}

describe('contracts, caching and secrecy over the whole transcript', () => {
  const consentRes = (): Res[] => transcript.filter((r) => r.url.startsWith('/api/v1/account/consents'));
  const FORBIDDEN_KEYS = new Set([
    'accountid',
    'account_id',
    'subject',
    'sub',
    'sid',
    'keycloaksessionid',
    'keycloak_session_id',
    'email',
    'token',
    'accesstoken',
    'applicationsessionid',
    'application_session_id',
    'roles',
    'issuer',
    'ip',
    'useragent',
    'body',
    'text',
  ]);
  const keysOf = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysOf(x, out);
      }
    return out;
  };
  const opOf = (r: Res): string | undefined => {
    const path = r.url.split('?')[0]!;
    if (r.method === 'GET' && path === '/api/v1/account/consents') return OP.consents;
    if (r.method === 'GET' && path === '/api/v1/account/consents/requirements') return OP.requirements;
    if (r.method === 'POST' && /^\/api\/v1\/account\/consents\/[A-Z][A-Z0-9_]{1,63}\/accept$/.test(path)) return OP.accept;
    if (r.method === 'POST' && /^\/api\/v1\/account\/consents\/[A-Z][A-Z0-9_]{1,63}\/withdraw$/.test(path)) return OP.withdraw;
    return undefined;
  };

  it('every response under /account/consents, errors and router-level errors included, is Cache-Control: no-store', () => {
    const rs = consentRes();
    expect(rs.length).toBeGreaterThan(600);
    expect(rs.filter((r) => r.headers['cache-control'] !== 'no-store').map((r) => `${r.method} ${r.url} ${r.status} ${r.body?.error?.code}`)).toEqual([]);
    // the 200s, the 4xx and the 5xx all occurred
    expect(new Set(rs.map((r) => Math.floor(r.status / 100)))).toEqual(new Set([2, 4, 5]));
  });

  it('every operation of the consent tag was exercised; every 200 equals its contract and the generated OpenAPI schema; every error is the standard envelope', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { operationId?: string; tags?: string[]; security?: unknown[]; responses: Json }>>;
    };
    const ops: { id: string; path: string; method: string; schema: Schema; security?: unknown[] }[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        if (op.tags?.includes('consent'))
          ops.push({ id: op.operationId!, path, method, security: op.security, schema: op.responses['200'].content['application/json'].schema });
    expect(ops.map((o) => o.id).sort()).toEqual(Object.values(OP).sort());
    for (const o of ops) {
      expect(shapeChecked.has(o.id), `${o.id} validated against its contract`).toBe(true);
      expect(o.security).toEqual([{ bearerAuth: [] }]);
      expect(o.path.startsWith('/api/v1/account/consents')).toBe(true);
    }
    const byId = new Map(ops.map((o) => [o.id, o.schema]));
    let successes = 0;
    for (const r of consentRes()) {
      if (r.status === 200) {
        const id = opOf(r);
        expect(id, `${r.method} ${r.url}`).toBeDefined();
        expect(conforms(byId.get(id!)!, r.body), `${r.method} ${r.url}`).toEqual([]);
        expect(SHAPES[id!]!.safeParse(r.body).success).toBe(true);
        successes += 1;
      } else expect(ErrorResponse.safeParse(r.body).success, `${r.method} ${r.url} ${r.status}: ${r.raw.slice(0, 200)}`).toBe(true);
    }
    expect(successes).toBeGreaterThan(300);
  });

  it('no consent response names an account, a subject, a session, an address or a role, and the only identifiers are event, version and purpose', () => {
    const offenders: string[] = [];
    for (const r of consentRes()) {
      const bad = keysOf(r.body).filter((k) => FORBIDDEN_KEYS.has(k.toLowerCase()));
      if (bad.length) offenders.push(`${r.method} ${r.url}: ${bad.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('a text hash appears only as `bodySha256`; no response (the public resolver aside) holds legal text; no error holds a hash, a text or ANY value the client sent', async () => {
    const hashes = new Set((await q<{ h: string }>('SELECT body_sha256 AS h FROM content.versions')).map((r) => r.h));
    expect(hashes.size).toBeGreaterThan(40);
    const offenders: string[] = [];
    const walk = (v: unknown, key: string, where: string): void => {
      if (typeof v === 'string') {
        if (hashes.has(v) && key !== 'bodySha256') offenders.push(`${where}: hash under ${key}`);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, where));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, where);
    };
    const claimed = (r: Res): string[] => {
      const out: string[] = [];
      const collect = (v: unknown, depth = 0): void => {
        if (depth > 12) return; // the deeply nested array of the oversized-body test
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach((x) => collect(x, depth + 1));
        else if (v && typeof v === 'object') Object.values(v).forEach((x) => collect(x, depth + 1));
      };
      collect(r.sent);
      const [path, query] = r.url.split('?');
      for (const seg of path!.split('/')) out.push(decodeURIComponent(seg.replace(/%(?![0-9a-f]{2})/gi, '')));
      for (const part of (query ?? '').split('&')) out.push(...part.split('=').map((x) => decodeURIComponent(x)));
      return out.filter((s) => s.length >= 6 && !/^(account|consents?|requirements|accept|withdraw|locale)$/i.test(s) && !s.startsWith('/api'));
    };
    for (const r of transcript) {
      const where = `${r.method} ${r.url} ${r.status}`;
      if (r.url.includes('/content/resolve') || r.url.startsWith('/api/v1/account/security')) continue;
      for (const b of secrets.bodies) if (r.raw.includes(b)) offenders.push(`${where}: legal text`);
      if (r.raw.includes(BODY_MARK)) offenders.push(`${where}: legal text marker`);
      if (r.url.startsWith('/api/v1/account/consents')) {
        walk(r.body, '', where);
        if (r.status >= 400) {
          for (const h of hashes) if (r.raw.includes(h)) offenders.push(`${where}: a hash in an error`);
          // the generic router 404 names the method and the path it could not route (never the query, never a body value): not a consent answer
          const router = r.body?.error?.code === 'ROUTE_NOT_FOUND';
          if (router) expect(r.body.error.message).toMatch(new RegExp(`^Route ${r.method} /api/v1/[A-Za-z0-9_/.%-]* not found$`));
          for (const c of router ? [] : claimed(r)) if (r.raw.includes(c)) offenders.push(`${where}: echoes a client value (${c.slice(0, 10)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  const needles = (): { name: string; value: string }[] => [
    ...secrets.tokens.flatMap((t) => {
      const [, payload, signature] = t.split('.');
      return [
        { name: 'token', value: t },
        { name: 'token payload', value: payload! },
        { name: 'token signature', value: signature! },
      ];
    }),
    ...secrets.sids.map((value) => ({ name: 'sid', value })),
    ...secrets.subjects.map((value) => ({ name: 'subject', value })),
    ...secrets.serverMarkers.map((value) => ({ name: 'server marker', value })),
  ];
  const firstHit = (haystack: string, skip: ReadonlySet<string> = new Set()): string | undefined => {
    for (const n of needles()) if (n.value.length >= 16 && !skip.has(n.name) && haystack.includes(n.value)) return `${n.name} ${n.value.slice(0, 12)}...`;
    return undefined;
  };

  it('no response body or header contains a token, a session id, a subject or a server-side marker', () => {
    expect(needles().filter((n) => n.value.length >= 16).length).toBeGreaterThan(300);
    const offenders: string[] = [];
    for (const r of transcript) {
      const hit = firstHit(`${r.raw}\n${JSON.stringify(r.headers)}`);
      if (hit) offenders.push(`${r.method} ${r.url} ${r.status}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no table of the identity, integration and configuration schemas holds legal text; no hash is stored outside consent_events and the content registry; no secret outside its one legitimate place', async () => {
    const hashes = (await q<{ h: string }>('SELECT body_sha256 AS h FROM content.versions')).map((r) => r.h);
    const tables = await q<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('identity', 'integration', 'configuration')`,
    );
    expect(tables.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const t of tables) {
      const rows = await q<{ j: string; type: string | null }>(
        t.tablename === 'outbox_events'
          ? `SELECT to_jsonb(t)::text AS j, t.event_type AS type FROM ${t.schemaname}.${t.tablename} t`
          : `SELECT to_jsonb(t)::text AS j, NULL::text AS type FROM ${t.schemaname}.${t.tablename} t`,
      );
      const skip = new Set<string>();
      if (t.tablename === 'application_sessions') skip.add('sid');
      if (t.tablename === 'external_identities') skip.add('subject');
      for (const row of rows) {
        const hit = firstHit(row.j, skip);
        if (hit) offenders.push(`${t.schemaname}.${t.tablename}: ${hit}`);
        for (const b of secrets.bodies) if (row.j.includes(b)) offenders.push(`${t.schemaname}.${t.tablename}: legal text`);
        if (row.j.includes(BODY_MARK)) offenders.push(`${t.schemaname}.${t.tablename}: legal text marker`);
        const identityScope = t.schemaname === 'identity' || (t.tablename === 'outbox_events' && row.type?.startsWith('bananagig.identity.'));
        if (identityScope && t.tablename !== 'consent_events')
          for (const h of hashes) if (row.j.includes(h)) offenders.push(`${t.schemaname}.${t.tablename}: a text hash`);
      }
    }
    expect(offenders).toEqual([]);
    expect(await count(`SELECT 1 FROM content.audit_events a WHERE to_jsonb(a)::text LIKE '%${BODY_MARK}%'`)).toBe(0);
    // the consent tables hold identifiers, the locale and the hash: no text, no address, no agent, no client time
    const columns = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'consent_events'`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [
        'account_id',
        'application_session_id',
        'body_sha256',
        'consent_event_id',
        'correlation_id',
        'event_seq',
        'event_type',
        'locale',
        'occurred_at',
        'purpose_code',
        'source',
        'version_id',
      ].sort(),
    );
  });

  it('no captured log line holds a token, a session id, a subject, legal text, a text hash or a configuration cause; the outage lines carry codes only', async () => {
    const hashes = (await q<{ h: string }>('SELECT body_sha256 AS h FROM content.versions')).map((r) => r.h);
    const joined = logLines.join('\n');
    expect(logLines.length, 'the run produced log lines (outages were injected)').toBeGreaterThan(0);
    expect(firstHit(joined)).toBeUndefined();
    expect(joined).not.toContain(BODY_MARK);
    for (const b of secrets.bodies) expect(joined).not.toContain(b);
    for (const h of hashes) expect(joined).not.toContain(h);
    expect(joined).toContain('consent policy unavailable');
    for (const line of logLines) if (line.includes('consent policy unavailable')) expect(line.length).toBeLessThan(400);
  });

  it('the stored history is consistent: contiguous numbers, an ACCEPTED first, one audit row and one outbox event per event, and every acceptance lies inside the window of its version', async () => {
    expect(await windowViolations()).toEqual([]);
    const total = await count('SELECT 1 FROM identity.consent_events');
    expect(total).toBeGreaterThan(80);
    expect(await count(`SELECT 1 FROM identity.account_audit_events WHERE action LIKE 'CONSENT\\_%'`)).toBe(total);
    expect(await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.consent-%'`)).toBe(total);
    expect(
      await count(
        `SELECT 1 FROM identity.account_audit_events a JOIN identity.consent_events e ON e.consent_event_id = a.consent_event_id AND e.account_id = a.account_id`,
      ),
    ).toBe(total);
    const gaps = await q(
      `SELECT account_id, purpose_code FROM identity.consent_events GROUP BY account_id, purpose_code HAVING max(event_seq) <> count(*) OR min(event_seq) <> 1`,
    );
    expect(gaps).toEqual([]);
    expect(await count(`SELECT 1 FROM identity.consent_events e WHERE e.event_seq = 1 AND e.event_type <> 'ACCEPTED'`)).toBe(0);
    // every event is bound to the exact version: the locale and the hash are those of the immutable version
    expect(
      await count(
        `SELECT 1 FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id WHERE v.locale <> e.locale OR v.body_sha256 <> e.body_sha256`,
      ),
    ).toBe(0);
    // the application session of an event belongs to its account
    expect(
      await count(
        `SELECT 1 FROM identity.consent_events e JOIN identity.application_sessions s ON s.application_session_id = e.application_session_id WHERE s.account_id <> e.account_id`,
      ),
    ).toBe(0);
  });
});
