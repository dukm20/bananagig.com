// Connectivity smoke test. Runs inside the Compose network (pnpm smoke) and verifies real
// round-trips, not just container status. Exits non-zero if any check fails.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { AccountService, hashDimension } from '@bananagig/accounts';
import { Redis } from 'iovalkey';
import { FakeSmsInbox, extractSmsCode } from '@bananagig/testing/sms';
import {
  AcceptConsentResponse,
  ACTIVE_ROLE_HEADER,
  AccountConsentsResponse,
  AccountEmailResponse,
  AccountNavigationResponse,
  AccountProfileViewResponse,
  AccountResponse,
  AccountRolesSectionResponse,
  ConsentRequirementsResponse,
  ContactVerificationSectionResponse,
  CORRELATION_HEADER,
  DeviceRemovedResponse,
  DeviceTrustResponse,
  EmailVerifiedResponse,
  GigDetailResponse,
  GigMediaPreviewResponse,
  GigMediaUploadResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  gigErrorKey,
  ErrorResponse,
  LEGAL_ENTRY_KEYS,
  MfaEnrollmentResponse,
  PasswordResetAcceptedResponse,
  PhoneVerifiedResponse,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  RegisteredSessionResponse,
  SecurityActivityResponse,
  SecurityDevicesResponse,
  SecurityOverviewResponse,
  SecuritySummaryResponse,
  SecuritySessionsResponse,
  SessionRevokedResponse,
  SessionsRevokedAllResponse,
  SetEmailResponse,
  SetPhoneResponse,
  SignedOutResponse,
  SystemInfoResponse,
  WhoAmIResponse,
  canonicalizeEmail,
  consentErrorMessageKey,
  maskEmail,
  maskPhone,
  type ConsentRequirementDto,
} from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  createTokenVerifier,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  kcActionStatusFromCallback,
  oidcEndpoints,
  randomToken,
  refreshTokenSet,
} from '@bananagig/identity';
import {
  ADMIN_REDIRECT_URI,
  authorizationCodeLogin,
  completeLogin,
  DEV_USERS,
  devAccessToken,
  WEB_REDIRECT_URI,
  type KeycloakTarget,
} from '@bananagig/identity/testing';
import { providerPublicProfileScenario } from './provider-public-profile';

type Result = { name: string; ok: boolean; note: string; label?: string };
type Diag = Record<string, { ok: boolean; detail?: any; error?: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any

const env = (k: string, d: string) => process.env[k] ?? d;
const results: Result[] = [];
const record = (name: string, ok: boolean, note = '', label?: string) => results.push({ name, ok, note, label });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(8000), ...init });
}
async function ensureDevtestGeography(admin: string): Promise<void> {
  type Method = 'GET' | 'POST';
  const request = async (module: 'geography' | 'content', method: Method, path: string, body?: unknown, okStatuses = [200, 201]) => {
    const r = await get(`${api}/api/v1/${module}${path}`, {
      method,
      headers: { authorization: `Bearer ${admin}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!okStatuses.includes(r.status)) throw new Error(`${method} /${module}${path} -> ${r.status} ${json?.error?.code ?? ''}`);
    return { status: r.status, json };
  };
  const locales = (await request('content', 'GET', '/locales')).json.data as { locale: string; isActive: boolean }[];
  const qaa = locales.find((l) => l.locale === 'qaa');
  if (!qaa)
    await request('content', 'POST', '/locales', { locale: 'qaa', active: false, displayName: 'DEV/TEST private-use', reason: 'smoke test' }, [201, 409]);
  if (!qaa?.isActive) await request('content', 'POST', '/locales/qaa/activation', { active: true, reason: 'smoke test' });

  const zzLookup = await request('geography', 'GET', '/countries/ZZ', undefined, [200, 404]);
  if (zzLookup.status === 404)
    await request(
      'geography',
      'POST',
      '/countries',
      {
        code: 'ZZ',
        alpha3: 'ZZZ',
        numeric: '999',
        displayNameContentKey: 'geography.country.us.name',
        dialingCode: '+999',
        defaultCurrencyCode: 'USD',
        defaultLocale: 'qaa',
        supportedLocales: ['en-US', 'qaa'],
        timeZones: ['America/Los_Angeles'],
        distanceUnit: 'KILOMETERS',
        firstDayOfWeek: 'MONDAY',
        dateFormat: 'DMY',
        timeFormat: '24_HOUR',
        reason: 'DEV/TEST ONLY smoke country',
      },
      [201, 409],
    );
  const zz = (await request('geography', 'GET', '/countries/ZZ')).json.data;
  if (zz.status !== 'ACTIVE') await request('geography', 'POST', '/countries/ZZ/activation', { active: true, reason: 'smoke test' });

  // A market can only be activated when its country has an address format in force (ADDRESS_FORMAT readiness check), so ZZ gets one through the
  // management API. Idempotent: a published format is reused, a draft left by an interrupted run is published instead of creating another.
  const zzFormat = await request('geography', 'GET', '/countries/ZZ/address-format', undefined, [200, 404]);
  if (zzFormat.status === 404) {
    const versions = (await request('geography', 'GET', '/countries/ZZ/address-formats')).json.data as { version: number; status: string }[];
    let version = versions.find((f) => f.status === 'DRAFT')?.version;
    if (version === undefined) {
      const draft = await request('geography', 'POST', '/countries/ZZ/address-formats', {
        displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
        fields: [
          { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 },
          { fieldType: 'ADDRESS_LINE_2', contentLabelKey: 'address.field.line2', required: false, maxLength: 100 },
          { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60 },
          { fieldType: 'ADMINISTRATIVE_AREA', contentLabelKey: 'address.field.state', required: false, maxLength: 50 },
          { fieldType: 'POSTAL_CODE', contentLabelKey: 'address.field.postal_code', required: false, maxLength: 10 },
        ],
        reason: 'DEV/TEST ONLY smoke country address format',
      });
      version = draft.json.data.version as number;
    }
    await request('geography', 'POST', `/countries/ZZ/address-formats/${version}/publication`, { reason: 'DEV/TEST ONLY smoke country address format' });
  }
}
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    record(name, true, (await fn()) ?? '');
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}
async function retry<T>(fn: () => Promise<T>, tries = 20, delay = 3000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(delay);
    }
  }
  throw last;
}
/**
 * Test hygiene for repeated local runs: the verification endpoints limit requests per hour per SOURCE ADDRESS in Valkey, and every smoke run sends from the same one.
 * A scenario clears ONLY its own Valkey buckets before it starts. This does NOT reset the per-ACCOUNT hourly send cap, which is authoritative in PostgreSQL (5 per
 * hour): the Email and Phone scenarios therefore pass at most about twice per hour for the same customer.dev, by design. Nothing outside the given prefix is touched.
 */
const clearLimiterBuckets = async (prefix: string): Promise<void> => {
  const client = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  client.on('error', () => undefined);
  try {
    const keys = await client.keys(`bananagig:rl:${prefix}:*`);
    if (keys.length) await client.del(...keys);
  } finally {
    client.disconnect();
  }
};

const expectOk = async (url: string, init?: RequestInit) => {
  const r = await get(url, init);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r;
};

const api = env('API_URL', 'http://api-service:3000');
const worker = env('WORKER_URL', 'http://worker-service:3000');
const web = env('WEB_URL', 'http://web-app:3000');
const grafanaAuth = 'Basic ' + Buffer.from(`${env('GRAFANA_ADMIN_USER', 'admin')}:${env('GRAFANA_ADMIN_PASSWORD', 'admin')}`).toString('base64');

const diags: Record<string, Diag> = {};
for (const [name, base] of [
  ['api', api],
  ['worker', worker],
] as const) {
  try {
    // Retry until the service answers; individual check failures are reported below, not retried forever.
    diags[name] = await retry(async () => (await expectOk(`${base}/internal/diagnostics`)).json() as Promise<Diag>, 20, 3000);
  } catch (err) {
    diags[name] = {};
    record(`${name} diagnostics`, false, String(err));
  }
}
const d = (svc: string, key: string): { ok: boolean; note: string } => {
  const c = diags[svc]?.[key];
  return c ? { ok: c.ok, note: c.ok ? '' : (c.error ?? 'failed') } : { ok: false, note: 'no result' };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const both = (name: string, key: string, fmt: (x: any) => string = () => '', label?: string) => {
  const a = d('api', key),
    w = d('worker', key);
  record(name, a.ok && w.ok, a.ok && w.ok ? `api+worker ${fmt(diags['api']?.[key]?.detail)}`.trim() : `api:${a.note || 'ok'} worker:${w.note || 'ok'}`, label);
};

both('Postgres DB', 'postgres', (x) => String(x.version).split(' ').slice(0, 2).join(' '));
both('PostGIS', 'postgis', (x) => `v${x.postgis}`, 'available');
both('Valkey Cache', 'valkey', (x) => x.ping);
both('NATS Events', 'nats');
both('JetStream', 'jetstream', () => '', 'available');
both('SeaweedFS Storage', 's3', (x) => x.roundtrip);
both('OpenSearch Search', 'opensearch', (x) => `cluster ${x.status}`);
both('Feature Flags (SDK)', 'flag', (x) => `dev-test-flag=${x.value}`);
{
  const w = d('worker', 'runtime');
  const det = diags['worker']?.['runtime']?.detail as { job: boolean; event: boolean; outbox: boolean } | undefined;
  record(
    'Worker runtime',
    w.ok && !!det?.job && !!det?.event && !!det?.outbox,
    w.ok ? `pg-boss job + NATS event + outbox->JetStream relay ${det?.job && det?.event && det?.outbox ? 'ok' : 'FAILED'}` : w.note,
  );
}

await check('Mailpit Email', async () => {
  await expectOk(`${env('MAILPIT_URL', 'http://mailpit-email:8025')}/livez`);
  for (const svc of ['api', 'worker']) {
    const subject = diags[svc]?.['mail']?.detail?.subject as string | undefined;
    if (!subject) throw new Error(`${svc} sent no test mail`);
    await retry(
      async () => {
        const r = (await (
          await expectOk(`${env('MAILPIT_URL', 'http://mailpit-email:8025')}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)
        ).json()) as { messages_count: number };
        if (r.messages_count < 1) throw new Error(`mail from ${svc} not received`);
      },
      5,
      1000,
    );
  }
  return 'test mail from api+worker received';
});
await check('Database telemetry', async () => {
  // Query/transaction/pool metrics must be exposed by both api and worker (scraped by Prometheus).
  for (const [name, base] of [
    ['api', api],
    ['worker', worker],
  ] as const) {
    const text = await (await expectOk(`${base}/metrics`)).text();
    for (const m of ['db_query_duration_seconds', 'db_transaction_duration_seconds', 'db_pool_connections'])
      if (!text.includes(m)) throw new Error(`${name} /metrics is missing ${m}`);
  }
  return 'query, transaction and pool metrics exposed by api and worker';
});
await check('OTel Collector', async () => {
  await expectOk(`${env('OTEL_HEALTH_URL', 'http://otel-collector:13133')}/`);
  return 'health ok';
});
await check('Tempo Traces', async () => {
  await expectOk(`${env('TEMPO_URL', 'http://tempo-traces:3200')}/ready`);
  // End-to-end: traces emitted by api and worker must reach Tempo via the Collector.
  for (const svc of ['api', 'worker']) {
    const id = diags[svc]?.['trace']?.detail?.traceId as string | undefined;
    if (!id) throw new Error(`${svc} produced no trace id`);
    await retry(
      async () => {
        await expectOk(`${env('TEMPO_URL', 'http://tempo-traces:3200')}/api/traces/${id}`);
      },
      15,
      2000,
    );
  }
  return 'api+worker traces found';
});
const correlationId = `smoke-${Date.now()}-corr`;
await check('API contract + correlation', async () => {
  const v = (await (await expectOk(`${api}/version`)).json()) as { version: string };
  const r = await expectOk(`${api}/api/v1/system/info`, { headers: { [CORRELATION_HEADER]: correlationId } });
  const body = SystemInfoResponse.parse(await r.json());
  if (r.headers.get(CORRELATION_HEADER) !== correlationId || body.meta.correlationId !== correlationId) throw new Error('correlation id not echoed');
  return `api v${v.version}, correlation echoed`;
});
await check('Web -> API (SSR /system)', async () => {
  const html = await (await expectOk(`${web}/system`)).text();
  if (!html.includes('api reachable')) throw new Error('web /system did not reach the API');
  return 'web rendered api system info';
});
await check('Loki Logs', async () => {
  await expectOk(`${env('LOKI_URL', 'http://loki-logs:3100')}/ready`);
  const end = Date.now() * 1e6,
    start = end - 15 * 60 * 1e9;
  await retry(
    async () => {
      const r = (await (
        await expectOk(
          `${env('LOKI_URL', 'http://loki-logs:3100')}/loki/api/v1/query_range?query=${encodeURIComponent('{service_name=~"bananagig-.+"}')}&start=${start}&end=${end + 60e9}&limit=1`,
        )
      ).json()) as { data: { result: unknown[] } };
      if (r.data.result.length < 1) throw new Error('no app logs in Loki yet');
    },
    10,
    3000,
  );
  // The correlation id sent above must be searchable in the structured logs.
  await retry(
    async () => {
      const q = encodeURIComponent(`{service_name="bananagig-api"} | correlationId = \`${correlationId}\``);
      const r = (await (
        await expectOk(`${env('LOKI_URL', 'http://loki-logs:3100')}/loki/api/v1/query_range?query=${q}&start=${start}&end=${Date.now() * 1e6 + 60e9}&limit=1`)
      ).json()) as { data: { result: unknown[] } };
      if (r.data.result.length < 1) throw new Error('correlation id not found in Loki');
    },
    10,
    3000,
  );
  return 'app logs queryable, correlation id found';
});
await check('Prometheus Metrics', async () => {
  const base = env('PROMETHEUS_URL', 'http://prometheus-metrics:9090');
  await expectOk(`${base}/-/healthy`);
  const t = await retry(
    async () => {
      const r = (await (await expectOk(`${base}/api/v1/targets`)).json()) as { data: { activeTargets: { health: string; labels: { job: string } }[] } };
      const bad = r.data.activeTargets.filter((x) => x.health !== 'up');
      if (bad.length || r.data.activeTargets.length === 0) throw new Error(`targets not up: ${bad.map((b) => b.labels.job).join(',') || 'none'}`);
      return r.data.activeTargets.length;
    },
    12,
    5000,
  );
  return `${t} targets up`;
});
await check('Grafana Dashboard', async () => {
  const base = env('GRAFANA_URL', 'http://grafana-dashboard:3000');
  await expectOk(`${base}/api/health`);
  const ds = (await (await expectOk(`${base}/api/datasources`, { headers: { authorization: grafanaAuth } })).json()) as { type: string }[];
  const types = ds.map((x) => x.type);
  for (const t of ['prometheus', 'loki', 'tempo']) if (!types.includes(t)) throw new Error(`datasource ${t} missing`);
  return 'datasources: prometheus, loki, tempo';
});
// ---------------------------------------------------------------- identity (Keycloak, API auth, web session, Caddy auth routes)
const kcUrl = env('KEYCLOAK_URL', 'http://keycloak-auth:8080');
const kc: KeycloakTarget = { keycloakUrl: kcUrl, publicUrl: env('KEYCLOAK_PUBLIC_URL', 'http://auth.localhost:8080') };
const webPublic = env('WEB_PUBLIC_URL', 'http://app.localhost:8080');
const ep = oidcEndpoints({ publicUrl: kc.publicUrl!, internalUrl: kcUrl, realm: 'bananagig' });

await check('Keycloak Auth', async () => {
  await retry(
    async () => {
      await expectOk(`${env('KEYCLOAK_HEALTH_URL', 'http://keycloak-auth:9000')}/health/ready`);
    },
    30,
    3000,
  );
  const disc = (await (await expectOk(`${kcUrl}/realms/bananagig/.well-known/openid-configuration`)).json()) as {
    issuer: string;
    code_challenge_methods_supported: string[];
  };
  if (disc.issuer !== ep.issuer) throw new Error(`issuer ${disc.issuer} != ${ep.issuer}`);
  if (!disc.code_challenge_methods_supported.includes('S256')) throw new Error('S256 not supported');
  const jwks = (await (await expectOk(ep.jwks)).json()) as { keys: unknown[] };
  if (!jwks.keys.length) throw new Error('JWKS is empty');
  // Client configuration (admin REST with the dev admin credentials)
  const tokenRes = await expectOk(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: env('KEYCLOAK_ADMIN', 'admin'),
      password: env('KEYCLOAK_ADMIN_PASSWORD', 'admin_dev_only'),
    }),
  });
  const adminToken = ((await tokenRes.json()) as { access_token: string }).access_token;
  const clients = (await (await expectOk(`${kcUrl}/admin/realms/bananagig/clients`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as {
    clientId: string;
    publicClient: boolean;
    implicitFlowEnabled: boolean;
    directAccessGrantsEnabled: boolean;
    attributes: Record<string, string>;
  }[];
  const by = (id: string) => clients.find((c) => c.clientId === id);
  for (const id of ['bananagig-web', 'bananagig-api', 'bananagig-admin']) if (!by(id)) throw new Error(`client ${id} missing`);
  for (const id of ['bananagig-web', 'bananagig-admin']) {
    const c = by(id)!;
    if (!c.publicClient || c.implicitFlowEnabled || c.directAccessGrantsEnabled || c.attributes['pkce.code.challenge.method'] !== 'S256')
      throw new Error(`client ${id} violates the PKCE/public-client policy`);
  }
  const grantClients = clients.filter((c) => c.directAccessGrantsEnabled && c.attributes['bananagig.devOnly'] !== 'true');
  if (grantClients.length) throw new Error(`password grant enabled on ${grantClients.map((c) => c.clientId).join(', ')}`);
  return 'realm bananagig: discovery, JWKS and web/api/admin clients configured';
});

const verifier = createTokenVerifier({
  issuer: ep.issuer,
  apiAudience: 'bananagig-api',
  jwks: { url: ep.jwks },
  webClientId: 'bananagig-web',
  adminClientId: 'bananagig-admin',
});

// ---- Keycloak admin REST (master realm, dev admin credentials: the same source as the 'Keycloak Auth' check) for the 'Sessions and security' scenario.
// provider.dev is password-only in the realm file; the scenario enrols a second factor for it and ALWAYS removes it again. A run that died before its cleanup would
// leave that user challenged for a code and break every login below, so the leftovers of such a run are removed first.
const kcMasterToken = async (): Promise<string> => {
  const res = await get(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: env('KEYCLOAK_ADMIN', 'admin'),
      password: env('KEYCLOAK_ADMIN_PASSWORD', 'admin_dev_only'),
    }),
  });
  const token = ((await res.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!res.ok || !token) throw new Error(`Keycloak master admin token -> HTTP ${res.status} (KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD)`);
  return token;
};
const kcRealmAdmin = async (token: string, path: string, method = 'GET'): Promise<{ status: number; json: unknown }> => {
  const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
};
/** Removes the TOTP and recovery-code credentials of a dev user (the realm file defines none). Returns how many were removed. */
const removeSecondFactors = async (username: string): Promise<number> => {
  const token = await kcMasterToken();
  const id = ((await kcRealmAdmin(token, `/users?username=${encodeURIComponent(username)}&exact=true`)).json as { id?: string }[] | undefined)?.[0]?.id;
  if (!id) throw new Error(`Keycloak user ${username} not found`);
  const credentials = ((await kcRealmAdmin(token, `/users/${id}/credentials`)).json ?? []) as { id: string; type: string }[];
  let removed = 0;
  for (const c of credentials.filter((x) => x.type === 'otp' || x.type === 'recovery-authn-codes')) {
    const del = await kcRealmAdmin(token, `/users/${id}/credentials/${c.id}`, 'DELETE');
    if (del.status !== 204) throw new Error(`removing a ${c.type} credential of ${username} -> HTTP ${del.status}`);
    removed++;
  }
  return removed;
};
let healedSecondFactors = 0;
try {
  healedSecondFactors = await removeSecondFactors(DEV_USERS.provider.username);
} catch {
  // Keycloak admin not reachable with these credentials: the checks below report the real problem
}

let customerToken = '';
await check('Keycloak Auth token flow', async () => {
  customerToken = await devAccessToken(kc, 'customer'); // DEV/TEST-only client
  const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.provider });
  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: ep.token,
    clientId: 'bananagig-web',
    redirectUri: WEB_REDIRECT_URI,
    code: login.code,
    codeVerifier: login.verifier,
  });
  const p = await verifier.verifyAccessToken(tokens.accessToken);
  const adminLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
  const adminTokens = await exchangeAuthorizationCode({
    tokenEndpoint: ep.token,
    clientId: 'bananagig-admin',
    redirectUri: ADMIN_REDIRECT_URI,
    code: adminLogin.code,
    codeVerifier: adminLogin.verifier,
  });
  const ap = await verifier.verifyAccessToken(adminTokens.accessToken);
  if (p.authContext !== 'web' || ap.authContext !== 'admin') throw new Error('identity contexts not separated');
  return `PKCE code flow ok (web: ${p.realmRoles.join(',')}; admin context separate)`;
});

await check('API Service auth', async () => {
  const who = WhoAmIResponse.parse(
    await (
      await expectOk(`${api}/api/v1/system/whoami`, { headers: { authorization: `Bearer ${customerToken}`, [CORRELATION_HEADER]: 'smoke-auth-correlation' } })
    ).json(),
  );
  if (who.meta.correlationId !== 'smoke-auth-correlation' || !who.data.realmRoles.includes('customer')) throw new Error('whoami returned unexpected identity');
  for (const [label, headers] of [
    ['no token', {}],
    ['invalid token', { authorization: 'Bearer not.a.token' }],
    ['tampered token', { authorization: `Bearer ${customerToken}x` }],
  ] as const) {
    const r = await get(`${api}/api/v1/system/whoami`, { headers });
    if (r.status !== 401) throw new Error(`${label}: expected 401, got ${r.status}`);
    ErrorResponse.parse(await r.json());
  }
  // Auth telemetry: counted by category, no token material in the metric labels.
  const metricsText = await (await expectOk(`${api}/metrics`)).text();
  for (const m of [
    'auth_token_validations_total{result="success"}',
    'auth_token_validation_failures_total{category="missing"}',
    'auth_token_validation_failures_total{category="malformed"}',
  ])
    if (!metricsText.includes(m)) throw new Error(`api /metrics is missing ${m}`);
  if (/eyJ/.test(metricsText)) throw new Error('token material found in /metrics');
  return 'valid token accepted; missing, invalid and tampered tokens rejected with 401; auth metrics exposed';
});

await check('Web App session', async () => {
  const cookieJar = new Map<string, string>();
  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (!value || /max-age=0/i.test(line)) cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
  };
  const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
  // 1. start login: redirect to Keycloak with PKCE S256, opaque HttpOnly transaction cookie
  const start = await get(`${web}/auth/login?returnTo=/session`, { redirect: 'manual' });
  absorb(start);
  const authorizeUrl = start.headers.get('location') ?? '';
  const txCookie = start.headers.getSetCookie().find((c) => c.startsWith('bg_auth_tx='));
  if (start.status !== 302 || !authorizeUrl.includes('code_challenge_method=S256') || !txCookie || !/HttpOnly/.test(txCookie) || !/SameSite=Lax/.test(txCookie))
    throw new Error('login did not start a PKCE flow with a bound HttpOnly cookie');
  // 2. sign in at Keycloak, 3. return to the web callback with the code
  const callbackUrl = await completeLogin(kc, authorizeUrl, { redirectUri: `${webPublic}/auth/callback`, ...DEV_USERS.customer });
  const cb = new URL(callbackUrl);
  const callback = await get(`${web}/auth/callback${cb.search}`, { redirect: 'manual', headers: { cookie: cookieHeader() } });
  absorb(callback);
  const sessionCookie = callback.headers.getSetCookie().find((c) => c.startsWith('bg_session='));
  if (callback.status !== 302 || callback.headers.get('location') !== `${webPublic}/session` || !sessionCookie)
    throw new Error(`callback failed (${callback.status})`);
  if (!/HttpOnly/.test(sessionCookie) || !/SameSite=Lax/.test(sessionCookie) || /eyJ/.test(sessionCookie))
    throw new Error('session cookie must be HttpOnly, SameSite=Lax and opaque (no JWT)');
  if (/eyJ/.test(callback.headers.get('location') ?? '') || (await callback.text()).includes('eyJ'))
    throw new Error('token leaked to the browser in the callback response');
  // 4. session status + the session page (which calls the API with the session's bearer token)
  const status = await (await expectOk(`${web}/auth/session`, { headers: { cookie: cookieHeader() } })).text();
  if (!status.includes('"authenticated":true') || status.includes('eyJ')) throw new Error('session status wrong or leaks token');
  const page = await (await expectOk(`${web}/session`, { headers: { cookie: cookieHeader() } })).text();
  if (!page.includes('Signed in') || !page.includes('web client (bananagig-web)')) throw new Error('session page did not show the API-confirmed identity');
  // 5. logout: cross-origin POST is refused (CSRF), same-origin POST ends the session
  const evil = await get(`${web}/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader(), origin: 'http://evil.example' } });
  if (evil.status !== 403) throw new Error(`cross-origin logout should be 403, got ${evil.status}`);
  const getLogout = await get(`${web}/auth/logout`, { headers: { cookie: cookieHeader() } });
  if (getLogout.status !== 405) throw new Error(`GET logout should be 405, got ${getLogout.status}`);
  const logout = await get(`${web}/auth/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(), origin: new URL(webPublic).origin },
  });
  if (
    logout.status !== 303 ||
    !(logout.headers.get('location') ?? '').includes('/protocol/openid-connect/logout') ||
    !logout.headers.getSetCookie().some((c) => /^bg_session=;/.test(c) || /Max-Age=0/i.test(c))
  )
    throw new Error('logout did not end the session');
  const after = await (await expectOk(`${web}/auth/session`, { headers: { cookie: cookieHeader() + (cookieJar.has('bg_session') ? '' : '') } })).text();
  const stale = await (await expectOk(`${web}/auth/session`, { headers: { cookie: `bg_session=${sessionCookie.split(';')[0]!.split('=')[1]}` } })).text();
  if (!after.includes('"authenticated":false') || !stale.includes('"authenticated":false')) throw new Error('session still valid after logout');
  return 'PKCE login -> opaque HttpOnly cookie -> API call with session token -> CSRF-safe logout';
});

await check('Configuration Registry', async () => {
  // DEV/TEST-only records (devtest.* keys and markets are refused in production). Two real administrators, real PKCE logins, real HTTP.
  const tokenFor = async (user: keyof typeof DEV_USERS): Promise<string> => {
    const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS[user] });
    return (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-admin',
        redirectUri: ADMIN_REDIRECT_URI,
        code: login.code,
        codeVerifier: login.verifier,
      })
    ).accessToken;
  };
  const [a, b] = [await tokenFor('admin'), await tokenFor('admin2')];
  await ensureDevtestGeography(a);
  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const marketCode = `devtest-${runId}`;
  const geoMarket = await get(`${api}/api/v1/geography/markets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      code: marketCode,
      name: `DEV/TEST configuration smoke market ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY configuration smoke market',
    }),
  });
  if (geoMarket.status !== 201) throw new Error(`POST /geography/markets -> ${geoMarket.status}`);
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown, okStatuses = [200, 201]) => {
    const r = await get(`${api}/api/v1/configuration${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!okStatuses.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${json?.error?.code ?? ''}`);
    return { status: r.status, json };
  };
  const key = 'devtest.smoke.window_hours';
  // 1. create the test parameter (idempotent across runs)
  await call(
    a,
    'POST',
    '/parameters',
    {
      key,
      dataType: 'INTEGER',
      description: 'DEV/TEST ONLY smoke parameter',
      ownerRole: 'platform',
      approvalPolicy: 'SECOND_APPROVER',
      validationRules: { min: 1, max: 1000 },
      allowedOverrideScopes: ['MARKET'],
    },
    [201, 409],
  );
  // publishes a value through the full second-approver workflow
  let selfApprovalChecked = false;
  const publish = async (scopeType: 'PLATFORM' | 'MARKET', scopeRef: string | null, value: number): Promise<void> => {
    const cr = (await call(a, 'POST', '/change-requests', { parameterKey: key, scopeType, scopeRef, value, reason: 'smoke test' })).json.data
      .changeRequestId as string;
    await call(a, 'POST', `/change-requests/${cr}/submit`, {});
    if (!selfApprovalChecked) {
      await call(a, 'POST', `/change-requests/${cr}/approve`, {}, [403]); // the requester cannot approve their own change
      selfApprovalChecked = true;
    }
    await call(b, 'POST', `/change-requests/${cr}/approve`, {});
    await call(a, 'POST', `/change-requests/${cr}/publish`, {});
  };
  const base = 10 + (Date.now() % 500);
  await publish('PLATFORM', null, base); // 2. platform value
  await publish('MARKET', marketCode, base + 1); // 3. market override
  const resolve = async (market?: string) =>
    (await call(a, 'POST', '/resolve', { keys: [key], context: market ? { market } : {} })).json.data.values[0] as {
      value: number;
      sourceScope: string;
      version: number;
    };
  const inMarket = await resolve(marketCode); // 4. resolve with market context
  if (inMarket.value !== base + 1 || inMarket.sourceScope !== 'MARKET') throw new Error('market override did not win'); // 5.
  const elsewhere = await resolve('other-market');
  if (elsewhere.value !== base || elsewhere.sourceScope !== 'PLATFORM') throw new Error('platform value should apply outside the override market');
  const snap = (await call(a, 'POST', '/snapshots', { keys: [key], context: { market: marketCode }, purpose: 'smoke test' })).json.data; // 6.
  await publish('MARKET', marketCode, base + 2); // 7. change active configuration
  const now = await resolve(marketCode);
  if (now.value !== base + 2) throw new Error('new market value is not effective');
  const again = (await call(a, 'GET', `/snapshots/${snap.snapshotId}`)).json.data; // 8. old snapshot unchanged
  if (again.items[0].value !== base + 1 || again.items[0].version !== inMarket.version) throw new Error('snapshot changed after a configuration change');
  // access control: a customer-style token and an unauthenticated call are refused
  const anon = await get(`${api}/api/v1/configuration/parameters`);
  if (anon.status !== 401) throw new Error(`configuration API must require authentication (got ${anon.status})`);
  const customerToken = await devAccessToken(kc, 'customer');
  const forbidden = await get(`${api}/api/v1/configuration/parameters`, { headers: { authorization: `Bearer ${customerToken}` } });
  if (forbidden.status !== 403) throw new Error(`customer token must be forbidden (got ${forbidden.status})`);
  return `second-approver workflow, market override beat platform (${base + 1} vs ${base}), snapshot kept ${base + 1} after change to ${base + 2}`;
});

await check('Content Registry', async () => {
  // DEV/TEST-only entry (devtest.* keys are refused in production), unique per run. Real administrator PKCE login, real HTTP.
  const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
  const admin = (
    await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-admin',
      redirectUri: ADMIN_REDIRECT_URI,
      code: login.code,
      codeVerifier: login.verifier,
    })
  ).accessToken;
  const call = async (token: string | null, method: 'GET' | 'POST', path: string, body?: unknown, okStatuses = [200, 201]) => {
    const r = await get(`${api}/api/v1/content${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!okStatuses.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${json?.error?.code ?? ''}`);
    return { status: r.status, json };
  };
  type Resolved = { value: string; version: number; versionId: string; resolvedLocale: string; fallback: { applied: boolean; chain: string[] } };
  const resolve = async (token: string | null, key: string, locale = 'en-US', at?: string): Promise<Resolved> =>
    (await call(token, 'POST', '/resolve', { key, locale, context: {}, ...(at ? { at } : {}) })).json.data as Resolved;

  // (a) anonymous resolve of the seeded shell copy
  const name = await resolve(null, 'brand.name');
  const tagline = await resolve(null, 'brand.tagline');
  if (name.value !== 'BananaGig' || tagline.value !== 'Local help. Done fast.')
    throw new Error(`seeded copy not resolved (brand.name=${JSON.stringify(name.value)}, brand.tagline=${JSON.stringify(tagline.value)})`);

  // (b) locale fallback: no Spanish copy exists, so es-MX resolves to the platform default and says so
  const es = await resolve(null, 'brand.name', 'es-MX');
  if (es.resolvedLocale !== 'en-US' || es.fallback.applied !== true || es.value !== 'BananaGig')
    throw new Error(`es-MX should fall back to en-US (resolved ${es.resolvedLocale}, applied ${es.fallback.applied})`);

  // (c) a unique plain entry with policy NONE, version 1 published
  const runId = `r${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const key = `devtest.smoke.${runId}`;
  const v1Text = `Smoke v1 ${runId}`;
  const v2Text = `Smoke v2 ${runId}`;
  await call(admin, 'POST', '/entries', {
    key,
    contentType: 'UI_LABEL',
    ownerRole: 'CONTENT',
    description: 'DEV/TEST ONLY smoke entry',
    approvalPolicy: 'NONE',
  });
  const author = async (body: string, effectiveFrom?: string): Promise<{ versionId: string; status: string }> => {
    const v = (
      await call(admin, 'POST', `/entries/${key}/versions`, { locale: 'en-US', body, reason: 'smoke test', ...(effectiveFrom ? { effectiveFrom } : {}) })
    ).json.data;
    await call(admin, 'POST', `/versions/${v.versionId}/submit`, {});
    return (await call(admin, 'POST', `/versions/${v.versionId}/publish`, {})).json.data;
  };
  const v1 = await author(v1Text);
  if (v1.status !== 'PUBLISHED') throw new Error(`version 1 should be PUBLISHED (got ${v1.status})`);
  const first = await resolve(null, key);
  if (first.value !== v1Text || first.version !== 1) throw new Error('published version 1 did not resolve anonymously');

  // (d) snapshot of the entry while version 1 is effective
  const snap = (await call(admin, 'POST', '/snapshots', { keys: [key], locale: 'en-US', context: {}, purpose: 'smoke test' })).json.data;

  // (e) version 2 scheduled a few seconds ahead: invisible before the instant, derived from time (not from the job) after it
  const instant = new Date(Date.now() + 8000);
  const v2 = await author(v2Text, instant.toISOString());
  if (v2.status !== 'SCHEDULED') throw new Error(`version 2 should be SCHEDULED (got ${v2.status}; the start must still be in the future)`);
  if (Date.now() >= instant.getTime()) throw new Error('too slow to observe the scheduled state before its instant');
  const before = await resolve(null, key);
  if (before.value !== v1Text || before.version !== 1) throw new Error('scheduled version resolved before its effective instant');
  const preview = await resolve(admin, key, 'en-US', new Date(instant.getTime() + 1000).toISOString());
  if (preview.value !== v2Text || preview.version !== 2) throw new Error('at= after the instant should preview version 2 for a content-read caller');
  await sleep(Math.max(0, instant.getTime() + 1200 - Date.now()));
  const after = await resolve(null, key);
  if (after.value !== v2Text || after.version !== 2) throw new Error('version 2 did not resolve after its effective instant');

  // (f) the earlier snapshot still reproduces version 1
  const again = (await call(admin, 'GET', `/snapshots/${snap.snapshotId}`)).json.data;
  const item = again.items[0];
  if (again.items.length !== 1 || item.version !== 1 || item.versionId !== v1.versionId || item.body !== v1Text)
    throw new Error('snapshot changed after a newer version became effective');

  // access control: the public resolve needs no token, management routes do
  const anon = await get(`${api}/api/v1/content/entries`);
  if (anon.status !== 401) throw new Error(`content management API must require authentication (got ${anon.status})`);
  return `seeded copy + es-MX fallback to en-US, scheduled v2 invisible before and effective after its instant, snapshot kept v1 (${key})`;
});

await check('Geography', async () => {
  // Reference data: countries, markets, currencies, time zones. DEV/TEST-only records (country ZZ, locale qaa, devtest-* markets) are refused in production.
  // Idempotent across runs: ZZ and qaa are reused, the market and content entry are unique per run (entities cannot be deleted).
  const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
  const admin = (
    await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-admin',
      redirectUri: ADMIN_REDIRECT_URI,
      code: login.code,
      codeVerifier: login.verifier,
    })
  ).accessToken;
  type Method = 'GET' | 'POST' | 'PUT';
  const request =
    (module: 'geography' | 'content' | 'configuration') =>
    async (token: string | null, method: Method, path: string, body?: unknown, okStatuses = [200, 201]) => {
      const r = await get(`${api}/api/v1/${module}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!okStatuses.includes(r.status)) throw new Error(`${method} /${module}${path} -> ${r.status} ${json?.error?.code ?? ''}`);
      return { status: r.status, json };
    };
  const geo = request('geography');
  const content = request('content');
  const configuration = request('configuration');
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  type MarketRow = { code: string; status?: string };
  const listed = async (token: string | null, code: string): Promise<boolean> =>
    ((await geo(token, 'GET', '/markets')).json.data as MarketRow[]).some((m) => m.code === code);

  // (1) anonymous reference data: ACTIVE and public fields only
  const us = (await geo(null, 'GET', '/countries/US')).json.data;
  assert(
    us.distanceUnit === 'MILES' && us.defaultLocale === 'en-US' && us.defaultCurrencyCode === 'USD' && us.dialingCode === '+1',
    `US country data wrong (${JSON.stringify(us)})`,
  );
  assert(!('status' in us) && !('createdAt' in us) && !('updatedAt' in us), 'anonymous country response must not expose status or timestamps');
  const usd = ((await geo(null, 'GET', '/currencies')).json.data as { code: string; minorUnitDigits: number }[]).find((c) => c.code === 'USD');
  assert(usd?.minorUnitDigits === 2, 'USD with 2 minor unit digits is not listed');
  const publicLocales = (await content(null, 'GET', '/locales')).json.data as { locale: string }[];
  assert(
    publicLocales.some((l) => l.locale === 'en-US'),
    'en-US is not in the public content locale list',
  );
  const anonReadiness = await get(`${api}/api/v1/geography/markets/la-oc/readiness`);
  assert(anonReadiness.status === 401, `market readiness must require authentication (got ${anonReadiness.status})`);

  // (2) the seeded market la-oc: its status is owner data (seeded PLANNED; the owner may activate or retire it), so the proof adapts. PLANNED or INACTIVE
  // (or ACTIVE but outside its effective period): invisible to anonymous callers. ACTIVE and in effect: publicly visible and listed. Management always sees defaults.
  // The "inactive market is not returned as active" proof does not depend on la-oc: it is also covered by the devtest market below.
  const laoc = (await geo(admin, 'GET', '/markets/la-oc')).json.data;
  assert(['PLANNED', 'ACTIVE', 'INACTIVE'].includes(laoc.status), `la-oc has an unknown status (${laoc.status})`);
  const nowMs = Date.now();
  const laocPublic =
    laoc.status === 'ACTIVE' &&
    Date.parse(laoc.effectiveFrom) <= nowMs &&
    (laoc.effectiveTo === null || laoc.effectiveTo === undefined || nowMs < Date.parse(laoc.effectiveTo));
  await geo(null, 'GET', '/markets/la-oc', undefined, laocPublic ? [200] : [404]);
  assert(
    (await listed(null, 'la-oc')) === laocPublic,
    laocPublic ? 'la-oc is ACTIVE and in effect but missing from the anonymous list' : `la-oc is ${laoc.status} but appears in the anonymous list`,
  );
  const laDefaults = (await geo(admin, 'GET', '/markets/la-oc/defaults')).json.data;
  assert(
    laDefaults.locale === 'en-US' &&
      laDefaults.currency.code === 'USD' &&
      laDefaults.timeZone === 'America/Los_Angeles' &&
      laDefaults.distanceUnit === 'MILES' &&
      laDefaults.firstDayOfWeek === 'SUNDAY' &&
      laDefaults.dateFormat === 'MDY' &&
      laDefaults.timeFormat === '12_HOUR',
    `la-oc defaults wrong (${JSON.stringify(laDefaults)})`,
  );
  await geo(null, 'GET', '/markets/la-oc/defaults', undefined, laocPublic ? [200] : [404]);

  // (3) DEV/TEST market flow: private-use locale qaa, DEV/TEST country ZZ, a unique devtest market
  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await ensureDevtestGeography(admin);
  // strict integer path parameter (GEO-002A): Ajv coercion used to read 1e3 as 1000; only canonical base-10 text may reach the service
  for (const version of ['1e3', '1.0', '01', '+1', '0x10']) {
    const bad = await geo(admin, 'POST', `/countries/US/address-formats/${version}/publication`, { reason: 'smoke strict version check' }, [400]);
    assert(
      bad.json.error?.code === 'VALIDATION_FAILED' && bad.json.error.details?.issues?.[0]?.path === 'params.version',
      `version ${version} must be rejected with the standard validation envelope (${JSON.stringify(bad.json).slice(0, 160)})`,
    );
  }
  const republished = await geo(admin, 'POST', '/countries/US/address-formats/1/publication', { reason: 'smoke strict version check (idempotent)' });
  assert(
    republished.json.data?.version === 1 && republished.json.data?.status === 'PUBLISHED',
    'publishing the already published US format 1 must be an idempotent no-op',
  );
  const activeLocales = (await content(null, 'GET', '/locales')).json.data as { locale: string }[];
  assert(
    activeLocales.some((l) => l.locale === 'qaa'),
    'locale qaa is not active',
  );

  const zzActive = (await geo(admin, 'GET', '/countries/ZZ')).json.data;
  assert(zzActive.status === 'ACTIVE', `country ZZ should be ACTIVE (got ${zzActive.status})`);

  const marketCode = `devtest-${runId}`;
  await geo(admin, 'POST', '/markets', {
    code: marketCode,
    name: `DEV/TEST smoke market ${runId}`,
    countryCode: 'ZZ',
    defaultLocale: 'qaa',
    currencyCode: 'USD',
    defaultTimeZone: 'America/Los_Angeles',
    reason: 'DEV/TEST ONLY smoke market',
  });
  const created = (await geo(admin, 'GET', `/markets/${marketCode}`)).json.data;
  assert(created.status === 'PLANNED', `new market should be PLANNED (got ${created.status})`);
  await geo(null, 'GET', `/markets/${marketCode}`, undefined, [404]);
  assert(!(await listed(null, marketCode)), 'a PLANNED market must not appear in the anonymous market list');
  const readiness = (await geo(admin, 'GET', `/markets/${marketCode}/readiness`)).json.data;
  assert(readiness.market === marketCode && readiness.ready === true, `market should be ready to activate (${JSON.stringify(readiness)})`);
  await geo(admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' });
  assert(await listed(null, marketCode), 'an ACTIVE market must appear in the anonymous market list');
  const defaults = (await geo(null, 'GET', `/markets/${marketCode}/defaults`)).json.data;
  assert(
    defaults.market.code === marketCode &&
      defaults.locale === 'qaa' &&
      defaults.timeZone === 'America/Los_Angeles' &&
      defaults.currency.code === 'USD' &&
      defaults.distanceUnit === 'KILOMETERS' &&
      defaults.firstDayOfWeek === 'MONDAY' &&
      defaults.dateFormat === 'DMY' &&
      defaults.timeFormat === '24_HOUR',
    `public market defaults wrong (${JSON.stringify(defaults)})`,
  );

  // (4) content integration: requested locale (fr-CA, no copy) -> market default (qaa) -> platform default (en-US)
  const key = `devtest.smoke.geo.${runId}`;
  const enText = `Geo en-US ${runId}`;
  const qaaText = `Geo qaa ${runId}`;
  await content(admin, 'POST', '/entries', {
    key,
    contentType: 'UI_LABEL',
    ownerRole: 'CONTENT',
    description: 'DEV/TEST ONLY geography smoke entry',
    approvalPolicy: 'NONE',
  });
  for (const [locale, body] of [
    ['en-US', enText],
    ['qaa', qaaText],
  ] as const) {
    const v = (await content(admin, 'POST', `/entries/${key}/versions`, { locale, body, reason: 'smoke test' })).json.data;
    await content(admin, 'POST', `/versions/${v.versionId}/submit`, {});
    const published = (await content(admin, 'POST', `/versions/${v.versionId}/publish`, {})).json.data;
    assert(published.status === 'PUBLISHED', `${locale} version should be PUBLISHED (got ${published.status})`);
  }
  type Resolved = { value: string; resolvedLocale: string; fallback: { applied: boolean; chain: string[] } };
  const withMarket = (await content(null, 'POST', '/resolve', { key, locale: 'fr-CA', context: { market: marketCode } })).json.data as Resolved;
  assert(
    withMarket.resolvedLocale === 'qaa' && withMarket.fallback.applied === true && withMarket.value === qaaText,
    `fr-CA in market ${marketCode} should resolve to the market default qaa (got ${withMarket.resolvedLocale}, applied ${withMarket.fallback.applied})`,
  );
  const withoutMarket = (await content(null, 'POST', '/resolve', { key, locale: 'fr-CA', context: {} })).json.data as Resolved;
  assert(
    withoutMarket.resolvedLocale === 'en-US' && withoutMarket.fallback.applied === true && withoutMarket.value === enText,
    `fr-CA without a market should resolve to the platform default en-US (got ${withoutMarket.resolvedLocale})`,
  );

  // (5) configuration scope integration: market references are validated against the registry
  const paramKey = 'devtest.smoke.window_hours';
  await configuration(
    admin,
    'POST',
    '/parameters',
    {
      key: paramKey,
      dataType: 'INTEGER',
      description: 'DEV/TEST ONLY smoke parameter',
      ownerRole: 'platform',
      approvalPolicy: 'SECOND_APPROVER',
      validationRules: { min: 1, max: 1000 },
      allowedOverrideScopes: ['MARKET'],
    },
    [201, 409],
  );
  const value = 10 + (Date.now() % 500);
  // PLANNED and ACTIVE references are accepted, an INACTIVE (retired) one is not: la-oc follows the owner's data, the verdict follows its status.
  const accepted = await configuration(
    admin,
    'POST',
    '/change-requests',
    { parameterKey: paramKey, scopeType: 'MARKET', scopeRef: 'la-oc', value, reason: 'smoke test' },
    laoc.status === 'INACTIVE' ? [400] : [200, 201],
  );
  assert(
    laoc.status === 'INACTIVE' ? accepted.json?.error?.details?.reason === 'SCOPE_REFERENCE_INVALID' : !!accepted.json.data?.changeRequestId,
    `change request for the real market la-oc (${laoc.status}) was not handled as expected (${JSON.stringify(accepted.json)})`,
  );
  const rejected = await configuration(
    admin,
    'POST',
    '/change-requests',
    { parameterKey: paramKey, scopeType: 'MARKET', scopeRef: 'no-such-market', value, reason: 'smoke test' },
    [400],
  );
  assert(
    rejected.json?.error?.details?.reason === 'SCOPE_REFERENCE_INVALID',
    `unknown market should be rejected with SCOPE_REFERENCE_INVALID (got ${JSON.stringify(rejected.json?.error)})`,
  );

  // (6) deactivation removes the market from public view; ZZ and qaa stay in place
  await geo(admin, 'POST', `/markets/${marketCode}/activation`, { active: false, reason: 'smoke test cleanup' });
  assert(!(await listed(null, marketCode)), 'a deactivated market must disappear from the anonymous market list');
  await geo(null, 'GET', `/markets/${marketCode}`, undefined, [404]);
  assert((await geo(admin, 'GET', `/markets/${marketCode}`)).json.data.status === 'INACTIVE', 'the deactivated market should be INACTIVE for geography-read');
  return `US/USD public data, la-oc ${laoc.status} (${laocPublic ? 'public and listed' : 'hidden publicly'}, defaults for admin), ${marketCode} on ZZ/qaa: PLANNED hidden -> ACTIVE listed -> INACTIVE hidden; fr-CA -> qaa with market, en-US without; MARKET scope la-oc ${laoc.status === 'INACTIVE' ? 'rejected (retired)' : 'accepted'}, no-such-market rejected`;
});

await check('Addresses', async () => {
  // Country-driven address model, anonymous caller: the US form definition, the area lookup and the stateless validate/format operations.
  // The address below is a test address, not user data. Nothing here is persisted (there is no route that stores an address).
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await get(`${api}/api/v1/${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: JSON.parse(text) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  // fields that must never reach an anonymous caller: raw input, identifiers, lifecycle internals
  const INTERNAL = ['rawInput', 'raw_input', 'addressId', 'addressFormatId', 'administrativeAreaId', 'status', 'displayTemplate', 'createdBy'];
  const noInternals = (what: string, text: string): void => {
    for (const w of INTERNAL) assert(!text.includes(`"${w}"`), `${what} exposes the internal field ${w}`);
  };

  // (1) the US form definition, in field order, with content label keys
  const format = await call('GET', 'geography/countries/US/address-format');
  assert(format.status === 200, `US address format -> ${format.status}`);
  const fields = format.json.data.fields as { fieldType: string; contentLabelKey: string; required: boolean }[];
  const order = fields.map((f) => f.fieldType).join(',');
  assert(order === 'ADDRESS_LINE_1,ADDRESS_LINE_2,LOCALITY,ADMINISTRATIVE_AREA,POSTAL_CODE', `US address field order wrong (${order})`);
  assert(format.json.data.administrativeAreaMode === 'LOOKUP' && format.json.data.countryCode === 'US', 'US administrative area mode should be LOOKUP');
  assert(
    fields.every((f) => f.contentLabelKey.startsWith('address.field.')),
    'US field labels must be address.field.* content keys',
  );
  noInternals('the anonymous address format', format.text);

  // labels are content: the US wording comes from the content registry with the country as context
  const label = async (key: string, country: string): Promise<string> =>
    (await call('POST', 'content/resolve', { key, locale: 'en-US', context: { country } })).json.data?.value;
  const stateKey = fields.find((f) => f.fieldType === 'ADMINISTRATIVE_AREA')!.contentLabelKey;
  const stateLabel = await label(stateKey, 'US');
  assert(stateLabel === 'State', `the US state label should resolve to "State" (got ${stateLabel})`);

  // (2) administrative areas: 50 states and DC
  const areas = await call('GET', 'geography/countries/US/administrative-areas');
  const list = areas.json.data.areas as { code: string }[];
  assert(areas.status === 200 && areas.json.data.mode === 'LOOKUP', `US administrative areas -> ${areas.status}`);
  assert(list.length === 51, `expected 51 US areas (got ${list.length})`);
  assert(list.some((a) => a.code === 'CA') && list.some((a) => a.code === 'DC'), 'US areas must include CA and DC');
  noInternals('the anonymous administrative areas', areas.text);

  // (3) validate: normalized structure; no-store; nothing internal
  const address = { countryCode: 'US', addressLine1: '123 Main St', locality: 'Irvine', administrativeArea: 'CA', postalCode: '92618' };
  const valid = await call('POST', 'geography/addresses/validate', { address });
  assert(valid.status === 200 && valid.json.data.valid === true, `a valid address was not accepted (${valid.status} ${valid.text.slice(0, 200)})`);
  const n = valid.json.data.address;
  assert(
    n.countryCode === 'US' &&
      n.addressLine1 === '123 Main St' &&
      n.locality === 'Irvine' &&
      n.administrativeAreaCode === 'CA' &&
      n.administrativeAreaName === 'California' &&
      n.postalCode === '92618' &&
      n.addressLine2 === null,
    `normalized address wrong (${JSON.stringify(n)})`,
  );
  assert(valid.headers.get('cache-control') === 'no-store', `validate must answer Cache-Control: no-store (got ${valid.headers.get('cache-control')})`);
  noInternals('the validate response', valid.text);

  // (4) format: the central formatter
  const formatted = await call('POST', 'geography/addresses/format', { address });
  assert(formatted.status === 200, `format -> ${formatted.status} ${formatted.text.slice(0, 200)}`);
  const lines = formatted.json.data.formatted.lines as string[];
  assert(lines.join('|') === '123 Main St|Irvine, CA 92618', `formatted address wrong (${JSON.stringify(lines)})`);
  assert(formatted.headers.get('cache-control') === 'no-store', 'format must answer Cache-Control: no-store');
  noInternals('the format response', formatted.text);

  // (5) an invalid ZIP is a normal result, with a content message key and no echo of the rejected value
  const invalid = await call('POST', 'geography/addresses/validate', { address: { ...address, postalCode: '9261' } });
  const issue = invalid.json.data?.issues?.[0];
  assert(invalid.status === 200 && invalid.json.data.valid === false && invalid.json.data.address === null, 'an invalid ZIP must be valid=false');
  assert(
    issue?.field === 'postalCode' && issue.code === 'INVALID_FORMAT' && issue.messageKey === 'address.error.invalid_format',
    `issue wrong (${JSON.stringify(issue)})`,
  );
  assert(!invalid.text.includes('9261'), 'the rejected value must not be echoed');
  assert(invalid.headers.get('cache-control') === 'no-store', 'an invalid validation must also be no-store');
  const message = await label(issue.messageKey, 'US');
  assert(typeof message === 'string' && message.length > 0, 'the validation message key must resolve in content');
  const refused = await call('POST', 'geography/addresses/format', { address: { ...address, postalCode: '9261' } });
  assert(refused.status === 400 && !refused.text.includes('9261'), `format of an invalid address must be 400 without the value (got ${refused.status})`);

  // (6) nothing persists or reads a stored address
  assert((await call('POST', 'geography/addresses', { address })).status === 404, 'there must be no route that creates an address');
  return `US format ${order.split(',').length} fields in order, ${list.length} areas, validate normalizes, format "${lines.join(' / ')}", bad ZIP -> valid=false, no-store, no internal fields`;
});

await check('Accounts', async () => {
  // Application account (ID-001) with REAL Keycloak tokens (Authorization Code + PKCE). The account is created lazily at the first /account/me of the
  // customer.dev identity and kept: the scenario is idempotent across runs (the dev user keeps its account; granting PROVIDER is idempotent).
  // Granting a role has no endpoint by design, so step 3 does what provider sign-up will do later: AccountService on the database.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const seen: string[] = []; // every response body and header block, searched for secrets at the end
  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, token?: string, o: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json };
  };
  const account = (r: { status: number; text: string; json: unknown }, what: string) => {
    assert(r.status === 200, `${what} -> ${r.status} ${r.text.slice(0, 160)}`);
    return AccountResponse.parse(r.json).data;
  };
  const codes = (a: { roles: { code: string }[] }): string =>
    a.roles
      .map((x) => x.code)
      .sort()
      .join(',');
  const login = async (clientId: 'bananagig-web' | 'bananagig-admin', user: keyof typeof DEV_USERS): Promise<string> => {
    const redirectUri = clientId === 'bananagig-web' ? WEB_REDIRECT_URI : ADMIN_REDIRECT_URI;
    const l = await authorizationCodeLogin(kc, { clientId, redirectUri, ...DEV_USERS[user] });
    return (await exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId, redirectUri, code: l.code, codeVerifier: l.verifier })).accessToken;
  };

  // (1) the first authenticated request of customer.dev creates (or finds) its account
  const customer = await login('bananagig-web', 'customer');
  const subjectOfToken = (await verifier.verifyAccessToken(customer)).subject;
  const first = account(await call('GET', '/account/me', customer), 'GET /account/me');
  assert(/^[0-9a-f-]{36}$/.test(first.accountId), `account id is not a uuid (${first.accountId})`);

  // (2) the second call returns the same account: ACTIVE, CUSTOMER among the roles, CUSTOMER active (the preferred role, since no role is requested)
  const second = account(await call('GET', '/account/me', customer), 'second GET /account/me');
  assert(second.accountId === first.accountId, 'the same identity must map to the same account');
  assert(second.status === 'ACTIVE', `account status ${second.status}`);
  assert(
    second.roles.some((r) => r.code === 'CUSTOMER'),
    `CUSTOMER missing from the roles (${codes(second)})`,
  );
  assert(
    second.roles.every((r) => r.nameContentKey.startsWith('identity.role.')),
    'role names must be content keys',
  );
  assert(second.activeRole === 'CUSTOMER' && second.primaryRole === 'CUSTOMER', `active ${second.activeRole} / primary ${second.primaryRole}`);

  // (3) grant PROVIDER to THAT account the way the server does (no endpoint exists for it); idempotent across runs
  const databaseUrl = process.env.DATABASE_URL;
  assert(!!databaseUrl, 'DATABASE_URL is not set in the smoke environment');
  const database = createDatabase(databaseUrl!, { role: 'tests' });
  try {
    await new AccountService({ database }).grantRole(first.accountId, 'PROVIDER', { actor: 'system:smoke', source: 'SYSTEM' });
  } finally {
    await database.close();
  }

  // (4) both roles now; switching is a validation that persists nothing and keeps the account; the header is validated on every request
  const both = account(await call('GET', '/account/me', customer), 'GET /account/me after the grant');
  assert(both.accountId === first.accountId, 'granting a role must not change the account');
  assert(codes(both) === 'CUSTOMER,PROVIDER', `roles after the grant: ${codes(both)}`);
  const switched = account(await call('POST', '/account/active-role', customer, { body: { role: 'PROVIDER' } }), 'POST /account/active-role');
  assert(
    switched.accountId === first.accountId && switched.activeRole === 'PROVIDER',
    `switch answered ${switched.accountId === first.accountId ? '' : 'another account, '}active ${switched.activeRole}`,
  );
  assert(switched.primaryRole === first.primaryRole, 'switching the active role must not change the stored preferred role');
  const afterSwitch = account(await call('GET', '/account/me', customer), 'GET /account/me after the switch');
  assert(afterSwitch.activeRole === first.primaryRole, 'the switch is not persisted: without a role header the preferred role applies again');
  const asProvider = account(await call('GET', '/account/me', customer, { headers: { [ACTIVE_ROLE_HEADER]: 'PROVIDER' } }), 'GET /account/me as PROVIDER');
  assert(
    asProvider.accountId === first.accountId && asProvider.activeRole === 'PROVIDER',
    `${ACTIVE_ROLE_HEADER}: PROVIDER gave active ${asProvider.activeRole}`,
  );
  const asCustomer = account(await call('GET', '/account/me', customer, { headers: { [ACTIVE_ROLE_HEADER]: 'CUSTOMER' } }), 'GET /account/me as CUSTOMER');
  assert(asCustomer.activeRole === 'CUSTOMER', `${ACTIVE_ROLE_HEADER}: CUSTOMER gave active ${asCustomer.activeRole}`);
  for (const role of ['ADMIN', 'provider', 'NOPE ROLE']) {
    const refused = await call('GET', '/account/me', customer, { headers: { [ACTIVE_ROLE_HEADER]: role } });
    assert(
      refused.status === 403 && refused.json?.error?.code === 'ACCOUNT_ROLE_NOT_HELD',
      `a role the account does not hold (${role}) must be 403 ACCOUNT_ROLE_NOT_HELD (got ${refused.status})`,
    );
  }
  const switchRefused = await call('POST', '/account/active-role', customer, { body: { role: 'ADMIN' } });
  assert(switchRefused.status === 403, `switching to a role the account does not hold must be 403 (got ${switchRefused.status})`);

  // (5) the admin identity context has no application account
  const admin = await login('bananagig-admin', 'admin');
  for (const [method, path, body] of [
    ['GET', '/account/me', undefined],
    ['POST', '/account/active-role', { role: 'CUSTOMER' }],
  ] as const) {
    const refused = await call(method, path, admin, { body });
    assert(
      refused.status === 403 && refused.json?.error?.code === 'ACCOUNT_CONTEXT_NOT_SUPPORTED',
      `${method} ${path} for the admin context must be 403 ACCOUNT_CONTEXT_NOT_SUPPORTED (got ${refused.status} ${refused.json?.error?.code})`,
    );
  }

  // (6) no token, no account
  const anonymous = await call('GET', '/account/me');
  assert(anonymous.status === 401, `anonymous /account/me must be 401 (got ${anonymous.status})`);

  // (7) nothing a response says (bodies and headers) holds a token or the Keycloak subject
  const everything = seen.join('\n');
  assert(!everything.includes(customer) && !everything.includes(admin), 'a response contains an access token');
  assert(subjectOfToken.length > 8 && !everything.includes(subjectOfToken), 'a response contains the Keycloak subject');
  return `customer.dev -> account ${first.accountId.slice(0, 8)}... ACTIVE, roles CUSTOMER+PROVIDER (PROVIDER granted server-side), switch to PROVIDER validated and not persisted, ${ACTIVE_ROLE_HEADER} honored or refused with 403, admin context 403 ACCOUNT_CONTEXT_NOT_SUPPORTED, anonymous 401, no token or subject in any response`;
});

await check('Email verification', async () => {
  await clearLimiterBuckets('email-verification');
  // Email contact + verification (ID-002) end to end with REAL Keycloak tokens, the real SMTP adapter and Mailpit: set an address, send the verification,
  // read the message from Mailpit through the approved test helper (the code and the link are extracted from the delivered message), verify, and prove the
  // retry is safe. It is idempotent across runs: a customer.dev that is already verified exercises the CHANGE_EMAIL path (the old address stays primary
  // until the new one verifies), otherwise INITIAL_EMAIL; every run uses a fresh address and ends VERIFIED.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const seen: string[] = []; // every response body and header block: searched for the full address, the code and the token at the end
  const cid = `smoke-email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const flowStart = Date.now() * 1e6;
  const call = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown) => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, [CORRELATION_HEADER]: cid, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');

  // (1) authenticate customer.dev and read the account state
  const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
  const customer = (
    await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-web',
      redirectUri: WEB_REDIRECT_URI,
      code: l.code,
      codeVerifier: l.verifier,
    })
  ).accessToken;
  const me = await call('GET', '/account/me', customer);
  assert(me.status === 200, `GET /account/me -> ${me.status}`);
  const before = AccountResponse.parse(me.json).data.email;
  assert(['NONE', 'PENDING', 'VERIFIED'].includes(before.emailVerificationStatus), `unexpected email state ${before.emailVerificationStatus}`);
  assert(!/@[a-z0-9.-]+\.[a-z]+/i.test(JSON.stringify(before)) || /\*\*\*@/.test(JSON.stringify(before)), 'the account state must carry masked addresses only');
  const startedVerified = before.emailVerificationStatus === 'VERIFIED';

  // (2) set the address to verify (mixed case on purpose: the canonical form is lower case)
  const address = `smoke-${Math.random().toString(36).slice(2, 10)}@bananagig.localhost`;
  const canonical = canonicalizeEmail(address.toUpperCase());
  assert(canonical.ok && canonical.value === address, 'canonicalization must fold the case');
  const set = await call('POST', '/account/email', customer, { email: address.toUpperCase() });
  assert(set.status === 200, `POST /account/email -> ${set.status} ${set.text.slice(0, 200)}`);
  const afterSet = SetEmailResponse.parse(set.json).data;
  const pendingAfterSet = afterSet.email.pending;
  assert(afterSet.changed && pendingAfterSet?.maskedEmail === maskEmail(address), 'the pending address must be set and masked');
  assert(pendingAfterSet?.purpose === (startedVerified ? 'CHANGE_EMAIL' : 'INITIAL_EMAIL'), `purpose ${pendingAfterSet?.purpose}`);
  if (startedVerified)
    assert(
      afterSet.email.emailVerificationStatus === 'VERIFIED' && afterSet.email.primary?.maskedEmail === before.primary?.maskedEmail,
      'a pending change must leave the verified primary address active',
    );

  // (3) send the verification (one message: code + magic link)
  const send = await call('POST', '/account/email/verification/send', customer, {});
  assert(send.status === 200, `send -> ${send.status} ${send.text.slice(0, 200)}`);
  assert(
    send.json.data.codeLength === 6 && send.json.data.validityMinutes === 10,
    'the code policy must come from the configuration registry (6 digits, 10 minutes)',
  );

  // (4) a resend inside the cooldown is refused (429 + Retry-After) and sends nothing
  const tooSoon = await call('POST', '/account/email/verification/send', customer, {});
  assert(
    tooSoon.status === 429 && tooSoon.json?.error?.code === 'ACCOUNT_EMAIL_RESEND_TOO_SOON',
    `resend inside the cooldown -> ${tooSoon.status} ${tooSoon.json?.error?.code}`,
  );
  assert(Number(tooSoon.headers.get('retry-after')) >= 1, 'the cooldown refusal must carry Retry-After');

  // (5) the message arrives in Mailpit through the production SMTP adapter; extract the code and the link from the DELIVERED message
  const message = await retry(
    async () => {
      const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json()) as {
        messages: { ID: string }[] | null;
      };
      if (!found.messages?.length) throw new Error('the verification email has not arrived');
      return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as {
        Subject: string;
        Text: string;
        HTML: string;
        To: { Address: string }[];
      };
    },
    10,
    1000,
  );
  assert(message.To.length === 1 && message.To[0]!.Address === address, 'the message must be addressed to the canonical address only');
  const code = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
  const webOrigin = webPublic.replace(/\/$/, '');
  const linkPrefix = `${webOrigin}/verify-email#token=`;
  const linkAt = message.Text.indexOf(linkPrefix);
  const candidate = linkAt >= 0 ? message.Text.slice(linkAt + linkPrefix.length, linkAt + linkPrefix.length + 43) : undefined;
  const token = candidate && /^[A-Za-z0-9_-]{43}$/.test(candidate) ? candidate : undefined;
  assert(!!code, 'the verification code is missing from the delivered message');
  assert(!!token, 'the magic link (token in the URL fragment) is missing from the delivered message');
  assert(!message.Subject.includes(code!), 'the subject must not carry the code');
  assert(message.HTML.includes('<a ') && message.HTML.includes(`verify-email#token=`), 'the HTML part must carry the link');

  // (6) a wrong code is counted, the right one verifies
  const wrong = await call('POST', '/account/email/verification/confirm-code', customer, { code: code === '000000' ? '111111' : '000000' });
  assert(
    wrong.status === 400 && wrong.json?.error?.code === 'ACCOUNT_EMAIL_CODE_INVALID' && wrong.json.error.details?.attemptsRemaining === 4,
    `a wrong code must be 400 with 4 attempts left (got ${wrong.status} ${wrong.json?.error?.code} ${wrong.json?.error?.details?.attemptsRemaining})`,
  );
  const verified = await call('POST', '/account/email/verification/confirm-code', customer, { code });
  assert(verified.status === 200, `confirm-code -> ${verified.status} ${verified.text.slice(0, 200)}`);
  assert(EmailVerifiedResponse.parse(verified.json).data.changed === true, 'the first confirmation must change the state');

  // (7) /account/me now reports VERIFIED with the new address (masked) as the primary
  const after = AccountResponse.parse((await call('GET', '/account/me', customer)).json).data.email;
  assert(after.emailVerificationStatus === 'VERIFIED' && after.pending === null, `state after verification: ${after.emailVerificationStatus}`);
  assert(after.primary?.maskedEmail === maskEmail(address) && after.primary.source === 'USER_ENTERED', 'the verified address must be the new primary');
  const detail = AccountEmailResponse.parse((await call('GET', '/account/email', customer)).json).data;
  assert(detail.codeLength === 6 && detail.validityMinutes === 10, 'the email detail must expose the configured code policy');

  // (8) retrying the same verification is safe: idempotent success with no second side effect, by code and by link
  const again = await call('POST', '/account/email/verification/confirm-code', customer, { code });
  assert(
    again.status === 200 && EmailVerifiedResponse.parse(again.json).data.changed === false,
    `repeating the code must be an idempotent success (got ${again.status})`,
  );
  const viaLink = await call('POST', '/account/email/verification/confirm-link', customer, { token });
  assert(
    viaLink.status === 200 && EmailVerifiedResponse.parse(viaLink.json).data.changed === false,
    `the consumed link must be an idempotent success (got ${viaLink.status})`,
  );
  const stranger = await call('POST', '/account/email/verification/confirm-link', customer, { token: 'A'.repeat(43) });
  assert(stranger.status === 400 && stranger.json?.error?.code === 'ACCOUNT_EMAIL_LINK_INVALID', 'an unknown token must be 400 ACCOUNT_EMAIL_LINK_INVALID');

  // (9) no response holds the full address, the code, the token or an access token
  const everything = seen.join('\n');
  assert(!everything.includes(address), 'a response contains the full email address');
  assert(!everything.includes(token!) && !everything.includes(`"code":"${code}"`) && !everything.includes(customer), 'a response contains a secret');

  // (10) no plaintext code or token in the logs: once this flow's own log lines are searchable in Loki, the secrets must not be
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const query = async (q: string) =>
    (await (
      await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
    ).json()) as {
      data: { result: unknown[] };
    };
  await retry(
    async () => {
      if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1) throw new Error('this flow is not in Loki yet');
    },
    12,
    2000,
  );
  await sleep(6000); // the log exporter batches (5 s): give the last lines of the flow time to arrive before asserting an absence
  for (const [what, q] of [
    ['token', `{service_name=~"bananagig-.+"} |= \`${token}\``],
    ['code', `{service_name=~"bananagig-.+"} |~ \`\\b${code}\\b\``],
    ['address', `{service_name=~"bananagig-.+"} |= \`${address}\``],
  ] as const)
    assert((await query(q)).data.result.length === 0, `the ${what} appears in the logs`);

  return `customer.dev ${startedVerified ? 'CHANGE_EMAIL (old primary kept until the new one verified)' : 'INITIAL_EMAIL'}: set (canonical, masked) -> send -> cooldown 429 -> Mailpit message (code + #token link, none in the subject) -> wrong code counted (4 left) -> verified -> /account/me VERIFIED -> repeat by code and link idempotent -> no address, code or token in responses or logs`;
});

await check('Phone verification', async () => {
  await clearLimiterBuckets('phone-verification');
  // Phone contact + SMS verification (ID-003) end to end with REAL Keycloak tokens: add a national-format number, the line-type policy, send, read the SMS from the
  // fake sink (DEV/TEST only), wrong code counted, verify, derived contacts summary, idempotent repeat, no code or number in responses or Loki, and DEBT-0055:
  // an X-Forwarded-For spoofed through Caddy creates NO rate-limit bucket. Idempotent across runs: INITIAL_PHONE, then CHANGE_PHONE (the old number stays primary
  // until the new one verifies); every run uses a fresh number and ends VERIFIED.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const seen: string[] = [];
  const cid = `smoke-phone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const flowStart = Date.now() * 1e6;
  const call = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown) => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, [CORRELATION_HEADER]: cid, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = new FakeSmsInbox(valkey);
  const hashSecret = env('VERIFICATION_HASH_SECRET', 'bananagig-dev-only-verification-hash-key-0001');
  try {
    // (1) authenticate customer.dev and read the account state
    const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const customer = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: l.code,
        codeVerifier: l.verifier,
      })
    ).accessToken;
    const before = AccountResponse.parse((await call('GET', '/account/me', customer)).json).data;
    assert(['NONE', 'PENDING', 'VERIFIED'].includes(before.phone.phoneVerificationStatus), `unexpected phone state ${before.phone.phoneVerificationStatus}`);
    assert(
      before.contacts.emailVerified === (before.email.emailVerificationStatus === 'VERIFIED'),
      'contacts.emailVerified must be derived from the email state',
    );
    const startedVerified = before.phone.phoneVerificationStatus === 'VERIFIED';

    // (2) the line-type / risk policy: a virtual number, a high-risk number and a failing lookup are refused BEFORE anything is stored or sent (fake classifier: last three digits)
    const fresh = (): { national: string; e164: string } => {
      for (;;) {
        const tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
        if (!['901', '902', '903', '904', '905'].includes(tail.slice(-3))) return { national: `(202) 555-${tail}`, e164: `+1202555${tail}` };
      }
    };
    const withTail = (tail: string) => ({ national: `(202) 555-${String(Math.floor(Math.random() * 10)).padStart(1, '0')}${tail}`, e164: '' });
    for (const [tail, code, status] of [
      ['902', 'ACCOUNT_PHONE_NOT_ACCEPTED', 400], // VIRTUAL (VOIP, 901, is not in the default blocklist)
      ['904', 'ACCOUNT_PHONE_NOT_ACCEPTED', 400],
      ['905', 'ACCOUNT_PHONE_RISK_UNAVAILABLE', 503],
    ] as const) {
      const refused = await call('POST', '/account/phone', customer, { phone: withTail(tail).national, country: 'US' });
      assert(
        refused.status === status && refused.json?.error?.code === code,
        `a number ending ${tail} must be ${status} ${code} (got ${refused.status} ${refused.json?.error?.code})`,
      );
    }
    const unsupported = await call('POST', '/account/phone', customer, { phone: '+44 20 7946 0958' });
    assert(
      unsupported.status === 400 && unsupported.json?.error?.details?.reason === 'COUNTRY_NOT_SUPPORTED',
      'a number of a country that is not ACTIVE must be refused (COUNTRY_NOT_SUPPORTED)',
    );
    const garbage = await call('POST', '/account/phone', customer, { phone: 'call me maybe', country: 'US' });
    assert(garbage.status === 400 && garbage.json?.error?.details?.reason === 'INVALID_CHARACTERS', 'letters in a number must be refused (INVALID_CHARACTERS)');
    const coerced = await call('POST', '/account/phone', customer, { phone: 2025550142 });
    assert(coerced.status === 400, 'a numeric phone value must not be coerced (strict body)');

    // (3) DEBT-0055: set the number THROUGH CADDY with a spoofed X-Forwarded-For. Caddy replaces the header, the API trusts exactly one hop, so the spoofed address must
    //     never become a rate-limit bucket (the real one, the connection address as Caddy sees it, does)
    const { national, e164 } = fresh();
    const spoof = '203.0.113.77';
    const viaCaddy = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const payload = JSON.stringify({ phone: national, country: 'US' });
      const req = http.request(
        {
          host: 'caddy-proxy',
          port: 80,
          path: '/api/v1/account/phone',
          method: 'POST',
          headers: {
            host: 'app.localhost',
            authorization: `Bearer ${customer}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-forwarded-for': spoof,
            [CORRELATION_HEADER]: cid,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    seen.push(viaCaddy.text);
    assert(viaCaddy.status === 200, `POST /account/phone through Caddy -> ${viaCaddy.status} ${viaCaddy.text.slice(0, 200)}`);
    const set = SetPhoneResponse.parse(JSON.parse(viaCaddy.text)).data;
    const pending = set.phone.pending;
    if (!pending) throw new Error('no pending number after setting one');
    assert(
      set.changed && pending?.maskedPhone === maskPhone(e164) && pending.countryCode === 'US',
      'the pending number must be canonical (E.164), masked and US',
    );
    assert(pending.purpose === (startedVerified ? 'CHANGE_PHONE' : 'INITIAL_PHONE'), `purpose ${pending.purpose}`);
    if (startedVerified)
      assert(
        set.phone.phoneVerificationStatus === 'VERIFIED' && set.phone.primary?.maskedPhone === before.phone.primary?.maskedPhone,
        'a pending change must leave the verified primary number active',
      );
    const ipKeys = await valkey.keys('bananagig:rl:phone-verification:ip:*');
    const spoofKey = `bananagig:rl:phone-verification:ip:${hashDimension(hashSecret, 'ip', spoof)}`;
    assert(ipKeys.length > 0, 'the request must have been counted under a source-address bucket');
    assert(!ipKeys.includes(spoofKey), 'a spoofed X-Forwarded-For created a rate-limit bucket (DEBT-0055)');

    // (4) send; a resend inside the cooldown is refused (429 + Retry-After) and sends nothing
    await inbox.clear(e164);
    const send = await call('POST', '/account/phone/verification/send', customer, {});
    assert(
      send.status === 200 && send.json.data.codeLength === 6 && send.json.data.validityMinutes === 10,
      `send -> ${send.status} ${send.text.slice(0, 200)}`,
    );
    const tooSoon = await call('POST', '/account/phone/verification/send', customer, {});
    assert(
      tooSoon.status === 429 && tooSoon.json?.error?.code === 'ACCOUNT_PHONE_RESEND_TOO_SOON' && Number(tooSoon.headers.get('retry-after')) >= 1,
      `resend inside the cooldown -> ${tooSoon.status}`,
    );

    // (5) the SMS arrives in the fake sink: concise, no link, no account id
    const messages = await inbox.wait(e164, 1, 10_000);
    assert(messages.length === 1, `exactly one SMS expected (got ${messages.length})`);
    const body = messages[0]!.body;
    const code = extractSmsCode(body);
    assert(!!code && code.length === 6, 'the verification code is missing from the SMS');
    assert(
      body.length <= 160 && !/https?:|www\./i.test(body) && !body.includes(before.accountId),
      'the SMS must be one concise segment without a link or an account id',
    );

    // (6) a wrong code is counted, the right one verifies; the phone state and the derived contacts summary
    const wrong = await call('POST', '/account/phone/verification/confirm-code', customer, { code: code === '000000' ? '111111' : '000000' });
    assert(
      wrong.status === 400 && wrong.json?.error?.code === 'ACCOUNT_PHONE_CODE_INVALID' && wrong.json.error.details?.attemptsRemaining === 4,
      `a wrong code must be 400 with 4 attempts left (got ${wrong.status})`,
    );
    const verified = await call('POST', '/account/phone/verification/confirm-code', customer, { code });
    assert(
      verified.status === 200 && PhoneVerifiedResponse.parse(verified.json).data.changed === true,
      `confirm-code -> ${verified.status} ${verified.text.slice(0, 200)}`,
    );
    const after = AccountResponse.parse((await call('GET', '/account/me', customer)).json).data;
    assert(
      after.phone.phoneVerificationStatus === 'VERIFIED' && after.phone.pending === null,
      `phone state after verification: ${after.phone.phoneVerificationStatus}`,
    );
    assert(
      after.phone.primary?.maskedPhone === maskPhone(e164) && after.phone.primary.countryCode === 'US',
      'the verified number must be the new primary (masked)',
    );
    assert(after.email.emailVerificationStatus === before.email.emailVerificationStatus, 'verifying the phone must not change the email state');
    assert(
      after.contacts.phoneVerified === true && after.contacts.emailVerified === (after.email.emailVerificationStatus === 'VERIFIED'),
      'the contacts summary must be derived from the two states',
    );
    assert(after.contacts.contactsVerified === (after.contacts.emailVerified && after.contacts.phoneVerified), 'contactsVerified is both contacts verified');

    // (7) retrying the same verification is safe
    const again = await call('POST', '/account/phone/verification/confirm-code', customer, { code });
    assert(
      again.status === 200 && PhoneVerifiedResponse.parse(again.json).data.changed === false,
      `repeating the code must be an idempotent success (got ${again.status})`,
    );

    // (8) no response holds the full number, the national digits or the code
    const everything = seen.join('\n');
    assert(!everything.includes(e164) && !everything.includes(e164.slice(1)) && !everything.includes(national), 'a response contains the phone number');
    assert(!everything.includes(`"code":"${code}"`) && !everything.includes(customer), 'a response contains a secret');

    // (9) no code and no number in the logs once this flow's own lines are searchable in Loki
    const loki = env('LOKI_URL', 'http://loki-logs:3100');
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    for (const [what, q] of [
      ['e164 number', `{service_name=~"bananagig-.+"} |= \`${e164}\``],
      ['national number', `{service_name=~"bananagig-.+"} |= \`${national}\``],
      ['code', `{service_name=~"bananagig-.+"} |~ \`\\b${code}\\b\``],
    ] as const)
      assert((await query(q)).data.result.length === 0, `the ${what} appears in the logs`);

    return `customer.dev ${startedVerified ? 'CHANGE_PHONE (old primary kept until the new one verified)' : 'INITIAL_PHONE'}: national input -> E.164 (US, masked), virtual / high-risk refused, failing lookup 503, inactive country and letters refused, strict body; spoofed X-Forwarded-For through Caddy created no bucket (DEBT-0055); send -> cooldown 429 -> one concise SMS in the fake sink -> wrong code counted (4 left) -> verified -> /account/me VERIFIED, contacts derived, email unchanged -> repeat idempotent -> no number or code in responses or logs`;
  } finally {
    valkey.disconnect();
  }
});

// ---------------------------------------------------------------- Sessions and security (ID-004)
// A scripted browser for the Keycloak pages the shared helpers do not cover: the OTP page, the numbered recovery-code page and the application-initiated actions
// (kc_action) that enrol a TOTP credential or generate recovery codes. Forms are parsed and posted; no browser is involved. Nothing it reads is printed or logged.
const totpAt = (secret: string, counter: number): string => {
  // RFC 6238 / HmacSHA1, 6 digits, 30 s. Keycloak uses the ASCII bytes of the stored secret string as the HMAC key.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, '0');
};
// Keycloak accepts the counters c-1..c+1 and refuses a counter at or below the last accepted one: remember the last counter used per secret and wait for the next
// 30 s window when the three codes of one window are spent. `exact` (enrolment) uses the current window.
const lastTotpCounter = new Map<string, number>();
const nextTotp = async (secret: string, o: { exact?: boolean } = {}): Promise<string> => {
  for (;;) {
    const c = Math.floor(Date.now() / 30_000);
    const pick = o.exact ? c : Math.max(c - 1, (lastTotpCounter.get(secret) ?? 0) + 1);
    if (pick <= c + 1) {
      lastTotpCounter.set(secret, pick);
      return totpAt(secret, pick);
    }
    await sleep(1000);
  }
};

class KcJar {
  private c = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.c.delete(name);
      else this.c.set(name, value);
    }
  }
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
const htmlDecode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#61;/g, '=')
    .replace(/&quot;/g, '"');
const htmlField = (html: string, name: string): string => {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  return htmlDecode(tag.match(/value="([^"]*)"/)?.[1] ?? '');
};
type KcPage =
  'login' | 'login-password-only' | 'select-credential' | 'otp' | 'recovery-code' | 'configure-totp' | 'configure-recovery' | 'action-proceed' | 'other';
const kcPage = (html: string): KcPage => {
  const names = new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!));
  if (names.has('password') && names.has('username')) return 'login';
  if (names.has('password') && !names.has('username')) return 'login-password-only';
  if (/id="kc-select-credential-form"/.test(html)) return 'select-credential';
  if (names.has('otp')) return 'otp';
  if (names.has('recoveryCodeInput')) return 'recovery-code';
  if (names.has('totpSecret')) return 'configure-totp';
  if (names.has('generatedRecoveryAuthnCodes')) return 'configure-recovery';
  if (/<a [^>]*href="[^"]*action-token\?key=/.test(html) && !/<form/.test(html)) return 'action-proceed';
  return 'other';
};
interface KcCreds {
  user: string;
  pw: string;
  /** Answer for the OTP page. Without it (and without `recovery`) the driver stops at that page: nothing is consumed. */
  otp?: () => Promise<string>;
  /** Answer the OTP page with a recovery code instead: "Try another way", then the code Keycloak asks for by number. */
  recovery?: (n: number) => string;
  /** Complete the CONFIGURE_TOTP / CONFIGURE_RECOVERY_AUTHN_CODES page when the (kc_action) flow reaches it. */
  enrol?: 'totp' | 'recovery';
  stopAt?: readonly KcPage[];
}
interface KcResult {
  done: boolean;
  /** The callback URL (carrying the code) when the flow completed. */
  location?: string;
  kind?: KcPage;
  /** The server re-rendered the page that was just answered (a refusal). */
  rejected?: boolean;
  /** The Keycloak-generated TOTP secret and recovery codes of an enrolment: held in memory only, scanned for at the end, never printed. */
  totpSecret?: string;
  recoveryCodes?: string[];
  jar: KcJar;
  verifier: string;
}
const kcRewrite = (u: string): string => u.replace(kc.publicUrl!.replace(/\/$/, ''), kcUrl.replace(/\/$/, ''));
async function kcDrive(startUrl: string, c: KcCreds, jar: KcJar): Promise<Omit<KcResult, 'verifier'>> {
  let url = startUrl;
  let lastPosted: KcPage | undefined;
  let curExec: string | undefined;
  let pending: Response | undefined;
  const out: Omit<KcResult, 'verifier'> = { done: false, jar };
  const post = async (action: string, body: Record<string, string>): Promise<Response> => {
    const r = await fetch(kcRewrite(action), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams(body),
    });
    jar.absorb(r);
    return r;
  };
  for (let i = 0; i < 18; i++) {
    const r = pending ?? (await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { cookie: jar.header() } }));
    if (!pending) jar.absorb(r);
    pending = undefined;
    const loc = r.headers.get('location');
    if (loc) {
      if (loc.startsWith(WEB_REDIRECT_URI)) return { ...out, done: true, location: loc };
      url = kcRewrite(new URL(loc, url).toString());
      continue;
    }
    const html = await r.text();
    const kind = kcPage(html);
    const action = htmlDecode(html.match(/<form[^>]*\baction="([^"]+)"/i)?.[1] ?? '');
    if (kind === 'action-proceed') {
      url = kcRewrite(htmlDecode(html.match(/<a [^>]*href="([^"]*action-token\?key=[^"]*)"/)![1]!));
      continue;
    }
    if (c.stopAt?.includes(kind) || !action) return { ...out, kind };
    if (kind === lastPosted) return { ...out, kind, rejected: true }; // never hammer: brute-force protection counts every failure
    let body: Record<string, string>;
    if (kind === 'login') body = { username: c.user, password: c.pw, credentialId: '' };
    else if (kind === 'login-password-only') body = { password: c.pw, credentialId: '' };
    else if (kind === 'otp' && c.recovery) {
      const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const tryAnother = forms.find((f) => /name="tryAnotherWay"/.test(f));
      if (!tryAnother) return { ...out, kind };
      pending = await post(htmlDecode(tryAnother.match(/action="([^"]+)"/)![1]!), { tryAnotherWay: 'on' });
      curExec = htmlDecode(action).match(/execution=([^&]+)/)?.[1];
      continue;
    } else if (kind === 'select-credential') {
      const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const pick = forms.map((f) => f.match(/name="authenticationExecution" value="([^"]+)"/)?.[1]).find((id) => id && id !== curExec);
      if (!pick) return { ...out, kind };
      pending = await post(action, { authenticationExecution: pick });
      continue;
    } else if (kind === 'otp') {
      if (!c.otp) return { ...out, kind };
      body = { otp: await c.otp(), selectedCredentialId: html.match(/name="selectedCredentialId"[^>]*value="([^"]*)"/)?.[1] ?? '' };
    } else if (kind === 'recovery-code') {
      if (!c.recovery) return { ...out, kind };
      body = { recoveryCodeInput: c.recovery(Number(html.match(/Recovery code #(\d+)/)?.[1] ?? 0)) }; // Keycloak asks for a NUMBERED code, in order
    } else if (kind === 'configure-totp' && c.enrol === 'totp') {
      out.totpSecret = htmlField(html, 'totpSecret');
      body = { totp: await nextTotp(out.totpSecret, { exact: true }), totpSecret: out.totpSecret, userLabel: 'smoke authenticator' };
    } else if (kind === 'configure-recovery' && c.enrol === 'recovery') {
      const generated = htmlField(html, 'generatedRecoveryAuthnCodes');
      out.recoveryCodes = generated.split(',');
      body = {
        generatedRecoveryAuthnCodes: generated,
        generatedAt: htmlField(html, 'generatedAt'),
        userLabel: 'Recovery codes',
        kcRecoveryCodesConfirmationCheck: 'on',
      };
    } else return { ...out, kind };
    lastPosted = kind;
    pending = await post(action, body);
  }
  return out;
}
/** Starts an Authorization Code + PKCE request for bananagig-web (the URL builder the web server uses) and drives the login. */
const kcWebLogin = async (c: KcCreds, o: { kcAction?: 'CONFIGURE_TOTP' | 'CONFIGURE_RECOVERY_AUTHN_CODES'; jar?: KcJar } = {}): Promise<KcResult> => {
  const verifier = generateCodeVerifier();
  const url = buildAuthorizeUrl({
    authorizationEndpoint: ep.authorization,
    clientId: 'bananagig-web',
    redirectUri: WEB_REDIRECT_URI,
    state: randomToken(16),
    nonce: randomToken(16),
    codeChallenge: codeChallengeS256(verifier),
    kcAction: o.kcAction,
  });
  return { ...(await kcDrive(kcRewrite(url), c, o.jar ?? new KcJar())), verifier };
};
const kcTokens = async (l: KcResult) => {
  if (!l.done || !l.location)
    throw new Error(`the login did not reach the callback (it stopped at the ${l.kind ?? 'unknown'} page${l.rejected ? ', refused' : ''})`);
  const code = new URL(l.location).searchParams.get('code');
  if (!code) throw new Error('the callback carried no code');
  return exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, code, codeVerifier: l.verifier });
};

await check('Sessions and security', async () => {
  // Application sessions, devices, MFA status, sign out everywhere, the security timeline and the public password-reset request (ID-004) end to end with REAL Keycloak
  // tokens (Authorization Code + PKCE, bananagig-web) and real HTTP. customer.dev only creates and revokes sessions; the second factor is enrolled for provider.dev
  // (kc_action=CONFIGURE_TOTP / CONFIGURE_RECOVERY_AUTHN_CODES) and ALWAYS removed again in a finally block through the Keycloak admin REST API (master realm, dev
  // credentials KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD), so later runs and the other scenarios log in with a password only. Every run uses fresh sessions and
  // browsers (random device secrets) and ends with the same state: customer.dev with every session revoked except one signed-in session, provider.dev password-only.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const seen: string[] = []; // every response body and header block: searched for secrets at the end
  const secretsOf = new Map<string, string[]>(); // what -> values that must appear in no response and no log line
  const logSecretsOf = new Map<string, string[]>();
  const guard = (what: string, ...values: (string | undefined)[]): void => {
    secretsOf.set(what, [...(secretsOf.get(what) ?? []), ...values.filter((v): v is string => typeof v === 'string' && v.length >= 8)]);
  };
  const guardLogs = (what: string, ...values: (string | undefined)[]): void => {
    logSecretsOf.set(what, [...(logSecretsOf.get(what) ?? []), ...values.filter((v): v is string => typeof v === 'string' && v.length >= 8)]);
  };
  const cid = `smoke-security-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const flowStart = Date.now() * 1e6;
  const notes: string[] = [];
  type Reply = { status: number; text: string; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token?: string,
    o: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const ok = <T>(r: Reply, schema: { parse: (x: unknown) => { data: T } }, what: string): T => {
    assert(r.status === 200, `${what} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.text.slice(0, 160)}`);
    return schema.parse(r.json).data;
  };
  const refusal = (r: Reply, status: number, code: string, what: string): void =>
    assert(
      r.status === status && r.json?.error?.code === code,
      `${what}: expected ${status} ${code}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 120)}`,
    );
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  interface Login {
    token: string;
    refreshToken: string;
    sid: string;
    authTime: number | undefined;
    acr: string | undefined;
  }
  const loginOf = async (tokens: { accessToken: string; refreshToken: string }): Promise<Login> => {
    const p = await verifier.verifyAccessToken(tokens.accessToken);
    assert(!!p.sessionId, 'the access token carries no sid claim (the application session is keyed by it)');
    guard('access token (signature)', tokens.accessToken.split('.')[2]?.slice(0, 64));
    guard('refresh token (signature)', tokens.refreshToken.split('.').pop()?.slice(0, 64));
    guard('Keycloak session id', p.sessionId);
    guard('Keycloak subject', p.subject);
    return { token: tokens.accessToken, refreshToken: tokens.refreshToken, sid: p.sessionId!, authTime: p.authTime, acr: p.acr };
  };
  /** A new, independent Keycloak session (its own cookie jar): password only. */
  const signIn = async (user: 'customer' | 'provider'): Promise<Login> => {
    const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS[user] });
    return loginOf(
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: l.code,
        codeVerifier: l.verifier,
      }),
    );
  };
  /** The first authenticated request of a login: the API creates its application session. Returns the application session id. */
  const seenBy = async (s: Login, what: string): Promise<string> => {
    const sessions = ok(await call('GET', '/account/security/sessions', s.token), SecuritySessionsResponse, `${what}: GET /account/security/sessions`);
    const current = sessions.sessions.filter((x) => x.current);
    assert(current.length === 1 && current[0]!.status === 'ACTIVE' && uuid.test(current[0]!.sessionId), `${what}: exactly one ACTIVE current session expected`);
    return current[0]!.sessionId;
  };
  const sessionsOf = async (s: Login, what: string) => ok(await call('GET', '/account/security/sessions', s.token), SecuritySessionsResponse, what);
  const revoked = (r: Reply, what: string): void => {
    refusal(r, 401, 'SESSION_REVOKED', what);
    assert(/^Bearer /.test(r.headers.get('www-authenticate') ?? ''), `${what}: the 401 must carry a Bearer challenge`);
  };

  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const rawUserAgentParts = ['AppleWebKit', 'Macintosh', 'Chrome/126'];

  // ------------------------------------------------------------------------------------------------------ customer.dev: sessions
  // (1) the first authenticated request creates the application session of that login: listed as current, first
  const a = await signIn('customer');
  assert(a.authTime !== undefined && Math.abs(Date.now() / 1000 - a.authTime) < 300, 'the web token must carry a recent auth_time');
  const listA1 = await sessionsOf(a, '(1) first request');
  assert(listA1.sessions[0]!.current === true, '(1) the current session must be listed first');
  assert(
    listA1.sessions.every((s) => s.status === 'ACTIVE'),
    '(1) only active sessions are listed',
  );
  const idA = listA1.sessions[0]!.sessionId;
  const knownBeforeB = new Set(listA1.sessions.map((s) => s.sessionId));
  const meA = AccountResponse.parse((await call('GET', '/account/me', a.token)).json).data;
  assert(/^[0-9a-f-]{36}$/.test(meA.accountId), 'GET /account/me did not return an account');

  // (2) a second independent login: a different Keycloak session (sid) and a second application session
  const b = await signIn('customer');
  assert(b.sid !== a.sid, '(2) the second login must be a different Keycloak session');
  const idB = await seenBy(b, '(2) second login');
  assert(idB !== idA, '(2) two Keycloak sessions must be two application sessions');
  const listA2 = await sessionsOf(a, '(2) list after the second login');
  assert(
    listA2.sessions.length >= 2 && listA2.sessions[0]!.sessionId === idA && listA2.sessions[0]!.current,
    '(2) the list from token A must start with its own session',
  );
  const sessionB = listA2.sessions.find((s) => s.sessionId === idB);
  assert(
    !!sessionB && !sessionB.current && sessionB.status === 'ACTIVE' && !knownBeforeB.has(idB),
    '(2) the second session must be listed as another, active session',
  );

  // (3) revoke B with A: B is refused on its very next request (its access token is still valid for minutes), A keeps working, Keycloak's session ends too
  const revokeStart = Date.now();
  const revokeB = ok(await call('DELETE', `/account/security/sessions/${idB}`, a.token), SessionRevokedResponse, '(3) revoke B');
  assert(revokeB.changed && !revokeB.current && revokeB.sessionId === idB, '(3) the revocation must report a changed, non-current session');
  assert(
    revokeB.keycloak === 'ENDED',
    `(3) the Keycloak session of B must be ended, got ${revokeB.keycloak} (is KEYCLOAK_SECURITY_CLIENT_SECRET set for the API container?)`,
  );
  const bAfter = await call('GET', '/account/me', b.token);
  const refusedAfterMs = Date.now() - revokeStart;
  revoked(bAfter, '(3) B after its revocation');
  assert(refusedAfterMs < 2000, `(3) the revoked session must be refused at once (took ${refusedAfterMs} ms)`);
  assert((await call('GET', '/account/me', a.token)).status === 200, '(3) revoking B must not touch A');
  const refreshOfB = await refreshTokenSet({ tokenEndpoint: ep.token, clientId: 'bananagig-web', refreshToken: b.refreshToken }).then(
    () => 'accepted',
    () => 'refused',
  );
  assert(refreshOfB === 'refused', '(3) the refresh token of B must stop working once its Keycloak session is ended');
  const again = ok(await call('DELETE', `/account/security/sessions/${idB}`, a.token), SessionRevokedResponse, '(3) revoke B again');
  assert(!again.changed, '(3) revoking a revoked session is an idempotent no-op');
  refusal(await call('DELETE', `/account/security/sessions/${randomUUID()}`, a.token), 404, 'ACCOUNT_SESSION_NOT_FOUND', '(3) unknown session id');
  assert((await call('DELETE', '/account/security/sessions/not-a-uuid', a.token)).status === 400, '(3) a malformed session id must be a 400');

  // (4) register the browser of A: a random 43-character secret and a user agent; only the coarse families come back
  const deviceSecret = randomBytes(32).toString('base64url');
  assert(deviceSecret.length === 43, 'device secret shape');
  guard('device secret', deviceSecret);
  const registered = ok(
    await call('POST', '/account/security/sessions/current', a.token, { body: { device: deviceSecret, userAgent } }),
    RegisteredSessionResponse,
    '(4) register the browser',
  );
  assert(
    registered.sessionId === idA && !!registered.deviceId && uuid.test(registered.deviceId) && !registered.deviceTrusted,
    '(4) the browser must be registered, untrusted',
  );
  const deviceId = registered.deviceId!;
  const reregistered = ok(
    await call('POST', '/account/security/sessions/current', a.token, { body: { device: deviceSecret, userAgent } }),
    RegisteredSessionResponse,
    '(4) register again',
  );
  assert(reregistered.deviceId === deviceId, '(4) the same browser secret must be the same device');
  for (const [what, body] of [
    ['an extra field', { device: deviceSecret, extra: true }],
    ['a short secret', { device: 'short' }],
    ['a numeric secret', { device: 1234567890 }],
  ] as const)
    assert((await call('POST', '/account/security/sessions/current', a.token, { body })).status === 400, `(4) ${what} must be a 400`);
  const devices = ok(await call('GET', '/account/security/devices', a.token), SecurityDevicesResponse, '(4) list the browsers');
  const mine = devices.devices.find((d) => d.deviceId === deviceId);
  assert(
    !!mine && mine.current && mine.device.browser === 'CHROME' && mine.device.os === 'MACOS' && mine.device.deviceClass === 'DESKTOP' && !mine.trusted,
    `(4) the browser must be shown as CHROME / MACOS / DESKTOP, current, untrusted (got ${JSON.stringify(mine)})`,
  );
  const currentRow = (await sessionsOf(a, '(4) list with the browser')).sessions[0]!;
  assert(
    currentRow.deviceId === deviceId && currentRow.device?.browser === 'CHROME',
    '(4) the session list must show the coarse browser of the current session',
  );

  // (5) trust the current browser: a login within the policy window passes the step-up guard; the window is session.trusted_browser_days
  const overviewA = ok(await call('GET', '/account/security', a.token), SecurityOverviewResponse, '(5) overview');
  assert(
    overviewA.mfa.available,
    '(5) mfa.available is false: the API cannot read Keycloak (KEYCLOAK_SECURITY_CLIENT_SECRET missing or wrong in the API container)',
  );
  assert(
    !overviewA.mfa.totpConfigured && !overviewA.mfa.recoveryCodesConfigured && !overviewA.stepUp.mfaSatisfied,
    '(5) customer.dev must have no second factor',
  );
  assert(
    overviewA.stepUp.authenticatedAt !== null &&
      overviewA.stepUp.recentUntil !== null &&
      Math.abs(Date.parse(overviewA.stepUp.recentUntil) - Date.parse(overviewA.stepUp.authenticatedAt) - overviewA.policy.stepUpValidMinutes * 60_000) < 1500,
    '(5) recentUntil must be auth_time + security.step_up_valid_minutes',
  );
  assert(
    overviewA.currentSession.deviceId === deviceId && !overviewA.currentSession.deviceTrusted,
    '(5) the overview must show the registered, untrusted browser',
  );
  assert(
    (await call('POST', '/account/security/devices/current/trust', a.token, { body: { unexpected: true } })).status === 400,
    '(5) trust takes no body: a field must be a 400',
  );
  const trusted = ok(await call('POST', '/account/security/devices/current/trust', a.token), DeviceTrustResponse, '(5) trust the browser');
  assert(trusted.trusted && trusted.deviceId === deviceId && trusted.trustedUntil !== null, '(5) the browser must be trusted');
  const trustedDays = (Date.parse(trusted.trustedUntil!) - Date.now()) / 86_400_000;
  assert(
    Math.abs(trustedDays - overviewA.policy.trustedBrowserDays) < 0.01,
    `(5) trusted until ${trustedDays.toFixed(3)} days ahead, session.trusted_browser_days is ${overviewA.policy.trustedBrowserDays}`,
  );
  const overviewTrusted = ok(await call('GET', '/account/security', a.token), SecurityOverviewResponse, '(5) overview after trusting');
  assert(
    overviewTrusted.currentSession.deviceTrusted && Date.parse(overviewTrusted.currentSession.trustedUntil ?? '') === Date.parse(trusted.trustedUntil ?? ''),
    '(5) the overview must show the trust window',
  );
  const untrusted = ok(await call('DELETE', '/account/security/devices/current/trust', a.token), DeviceTrustResponse, '(5) untrust');
  assert(!untrusted.trusted && untrusted.trustedUntil === null, '(5) untrust clears the window');
  assert(
    !ok(await call('DELETE', '/account/security/devices/current/trust', a.token), DeviceTrustResponse, '(5) untrust again').trusted,
    '(5) untrust is idempotent',
  );
  assert(ok(await call('POST', '/account/security/devices/current/trust', a.token), DeviceTrustResponse, '(5) trust again').trusted, '(5) trust again');

  // (5b) the step-up refusal. A real token cannot be aged inside a smoke run (the window is minutes), so it is exercised only on request: SMOKE_STEP_UP_AGING=1
  // lowers security.step_up_valid_minutes to 1 through the real second-approver workflow, waits until the login of A is older than that, expects
  // 401 STEP_UP_REQUIRED with the RFC 9470 challenge, shows that a fresh login of the same browser passes, and ALWAYS restores the configured value.
  let caller = a; // the session that signs out the others below (A, or the fresh login of the same browser after the aging check)
  let stepUpNote = 'step-up refusal NOT exercised (SMOKE_STEP_UP_AGING=1 enables it); the guard accepted a fresh login';
  if (env('SMOKE_STEP_UP_AGING', '') === '1') {
    const original = overviewA.policy.stepUpValidMinutes;
    const adminAccess = async (user: 'admin' | 'admin2'): Promise<string> => {
      const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS[user] });
      return (
        await exchangeAuthorizationCode({
          tokenEndpoint: ep.token,
          clientId: 'bananagig-admin',
          redirectUri: ADMIN_REDIRECT_URI,
          code: l.code,
          codeVerifier: l.verifier,
        })
      ).accessToken;
    };
    const setWindow = async (minutes: number): Promise<void> => {
      const [x, y] = [await adminAccess('admin'), await adminAccess('admin2')];
      const cfg = async (token: string, path: string, body: unknown) => {
        const r = await get(`${api}/api/v1/configuration${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert(r.status === 200 || r.status === 201, `POST /configuration${path} -> ${r.status} ${json?.error?.code ?? ''}`);
        return json;
      };
      const change = (
        await cfg(x, '/change-requests', {
          parameterKey: 'security.step_up_valid_minutes',
          scopeType: 'PLATFORM',
          scopeRef: null,
          value: minutes,
          reason: 'smoke: step-up aging check (restored by the same run)',
        })
      ).data.changeRequestId as string;
      await cfg(x, `/change-requests/${change}/submit`, {});
      await cfg(y, `/change-requests/${change}/approve`, {});
      await cfg(x, `/change-requests/${change}/publish`, {});
    };
    try {
      await setWindow(1);
      const ageMs = a.authTime! * 1000 + 62_000 - Date.now();
      if (ageMs > 0) await sleep(ageMs);
      let refused: Reply | undefined;
      for (let i = 0; i < 30 && refused === undefined; i++) {
        const r = await call('POST', '/account/security/devices/current/trust', a.token); // the configuration read may be cached for a few seconds
        if (r.status === 401) refused = r;
        else await sleep(4000);
      }
      assert(refused !== undefined, '(5b) the aged login was never refused (is the configuration cache TTL longer than two minutes?)');
      refusal(refused!, 401, 'STEP_UP_REQUIRED', '(5b) trust with an aged login');
      assert(
        refused!.json.error.details?.requirement === 'RECENT_AUTHENTICATION' && refused!.json.error.details?.maxAgeSeconds === 60,
        `(5b) the details must name RECENT_AUTHENTICATION and max age 60 (got ${JSON.stringify(refused!.json.error.details)})`,
      );
      const challenge = refused!.headers.get('www-authenticate') ?? '';
      assert(
        /error="insufficient_user_authentication"/.test(challenge) && /max_age="60"/.test(challenge),
        `(5b) RFC 9470 challenge expected, got ${challenge}`,
      );
      refusal(
        await call('POST', '/account/security/mfa/enrollment', a.token, { body: { method: 'TOTP' } }),
        401,
        'STEP_UP_REQUIRED',
        '(5b) MFA enrolment with an aged login',
      );
      assert((await call('GET', '/account/security', a.token)).status === 200, '(5b) reads are not step-up guarded');
      const fresh = await signIn('customer'); // the same browser signs in again: same secret, new login
      await seenBy(fresh, '(5b) fresh login');
      ok(
        await call('POST', '/account/security/sessions/current', fresh.token, { body: { device: deviceSecret, userAgent } }),
        RegisteredSessionResponse,
        '(5b) register',
      );
      assert(
        ok(await call('POST', '/account/security/devices/current/trust', fresh.token), DeviceTrustResponse, '(5b) trust after a fresh login').trusted,
        '(5b) a fresh login passes',
      );
      caller = fresh; // A is old by now (its access token lives 5 minutes): the same browser continues with the fresh login
      stepUpNote = 'step-up refusal exercised: aged login -> 401 STEP_UP_REQUIRED (RECENT_AUTHENTICATION, max_age 60, RFC 9470 challenge), fresh login passes';
    } finally {
      await setWindow(original);
      const probe = await signIn('customer');
      await seenBy(probe, '(5b) probe');
      let restored = false;
      for (let i = 0; i < 30 && !restored; i++) {
        restored = (await call('GET', '/account/security', probe.token)).json?.data?.policy?.stepUpValidMinutes === original;
        if (!restored) await sleep(4000);
      }
      assert(
        restored,
        `security.step_up_valid_minutes was lowered for the check and could NOT be confirmed restored to ${original}: restore it in the configuration console`,
      );
    }
  }

  // (7a) sign out everywhere else: C is another session (it also has no registered browser), F is a login the API has never seen
  const c = await signIn('customer');
  const idC = await seenBy(c, '(7a) C');
  refusal(
    await call('POST', '/account/security/devices/current/trust', c.token),
    409,
    'ACCOUNT_DEVICE_REQUIRED',
    '(7a) trusting a session without a registered browser',
  );
  const f = await signIn('customer');
  await sleep(2600); // the revocation watermark tolerates 2 s of auth_time (one-second resolution): F must be clearly older than the revocation
  const revokeOthers = ok(
    await call('POST', '/account/security/sessions/revoke-all', caller.token, { body: { includeCurrent: false } }),
    SessionsRevokedAllResponse,
    '(7a) sign out everywhere else',
  );
  const revokeOthersAt = Date.now();
  assert(
    revokeOthers.revokedCount >= 1 && revokeOthers.keycloak !== 'UNAVAILABLE',
    `(7a) revoked ${revokeOthers.revokedCount}, keycloak ${revokeOthers.keycloak}`,
  );
  revoked(await call('GET', '/account/me', c.token), '(7a) C after sign out everywhere else');
  assert(Date.now() - revokeOthersAt < 2000, '(7a) C must be refused at once');
  assert((await call('GET', '/account/me', caller.token)).status === 200, '(7a) the current session must be kept');
  revoked(await call('GET', '/account/me', f.token), '(7a) F, a Keycloak session the API had not seen yet, authenticated before the revocation');
  // a login within 2 s of the watermark is ambiguous (auth_time has one-second resolution) and is accepted only when the identity provider confirms it started later:
  // a real login takes longer than that, an automated one must wait
  await sleep(2600);
  const e = await signIn('customer'); // the watermark must not block a NEW login
  const idE = await seenBy(e, '(7a) a new login after the revocation');
  assert(idE !== idA, '(7a) a new login is a new session');
  assert(
    (await sessionsOf(e, '(7a) list from E')).sessions.every((s) => s.sessionId !== idC),
    '(7a) a revoked session is not listed as active',
  );

  // remove the browser of A from another session: its sessions go with it
  const removed = ok(await call('DELETE', `/account/security/devices/${deviceId}`, e.token), DeviceRemovedResponse, '(7a) remove the browser');
  assert(removed.changed && removed.sessionsRevoked >= 1, `(7a) removing the browser must revoke its session (revoked ${removed.sessionsRevoked})`);
  revoked(await call('GET', '/account/me', caller.token), '(7a) the session of the removed browser');
  assert(
    !ok(await call('GET', '/account/security/devices', e.token), SecurityDevicesResponse, '(7a) list').devices.some((d) => d.deviceId === deviceId),
    '(7a) a removed browser is not listed',
  );
  assert(
    !ok(await call('DELETE', `/account/security/devices/${deviceId}`, e.token), DeviceRemovedResponse, '(7a) remove again').changed,
    '(7a) removing twice is idempotent',
  );
  refusal(await call('DELETE', `/account/security/devices/${randomUUID()}`, e.token), 404, 'ACCOUNT_DEVICE_NOT_FOUND', '(7a) unknown browser id');

  // (7b) sign out everywhere including this session: every token is refused, a NEW login works afterwards
  const g = await signIn('customer');
  const h = await signIn('customer');
  await seenBy(g, '(7b) G');
  await seenBy(h, '(7b) H');
  const revokeAll = ok(
    await call('POST', '/account/security/sessions/revoke-all', g.token, { body: { includeCurrent: true } }),
    SessionsRevokedAllResponse,
    '(7b) sign out everywhere',
  );
  assert(revokeAll.revokedCount >= 3, `(7b) G, H and E must be revoked (revoked ${revokeAll.revokedCount})`);
  for (const [what, s] of [
    ['G (the caller)', g],
    ['H', h],
    ['E', e],
  ] as const)
    revoked(await call('GET', '/account/me', s.token), `(7b) ${what} after sign out everywhere`);
  await sleep(2600); // same reason as for E: the new login must be clearly later than the watermark
  const k = await signIn('customer');
  assert(
    (await call('GET', '/account/me', k.token)).status === 200,
    '(7b) a new login after sign out everywhere must work (the watermark only affects logins that pre-date it)',
  );
  for (const bad of [{ includeCurrent: 'yes' }, { includeCurrent: 1 }, { everyone: true }])
    assert((await call('POST', '/account/security/sessions/revoke-all', k.token, { body: bad })).status === 400, `(7b) ${JSON.stringify(bad)} must be a 400`);

  // (8) sign out the current session: the same token is refused afterwards
  const i = await signIn('customer');
  const idI = await seenBy(i, '(8) I');
  const out = ok(await call('POST', '/account/security/sessions/current/sign-out', i.token), SignedOutResponse, '(8) sign out');
  assert(out.changed && out.keycloak === 'ENDED', `(8) sign-out result changed=${out.changed} keycloak=${out.keycloak}`);
  revoked(await call('GET', '/account/me', i.token), '(8) I after signing out');
  revoked(await call('POST', '/account/security/sessions/current/sign-out', i.token), '(8) signing out twice is a revoked-session 401');
  assert(
    (await refreshTokenSet({ tokenEndpoint: ep.token, clientId: 'bananagig-web', refreshToken: i.refreshToken }).then(
      () => 'accepted',
      () => 'refused',
    )) === 'refused',
    '(8) the refresh token of a signed-out session must stop working',
  );

  // ------------------------------------------------------------------------------------------------------ (10) password reset (public)
  const reset = await (async (): Promise<{ recorded: boolean; note: string }> => {
    const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
    valkey.on('error', () => undefined);
    const databaseUrl = env('DATABASE_URL', '');
    assert(databaseUrl !== '', 'DATABASE_URL is not set in the smoke environment');
    const database = createDatabase(databaseUrl, { role: 'tests' });
    const clearLimits = async (): Promise<void> => {
      // test hygiene: this scenario sends a few requests per run from one source and the limit is per hour; its own buckets are cleared before and after
      const keys = await valkey.keys('bananagig:rl:password-reset:*');
      if (keys.length) await valkey.del(...keys);
    };
    const mailpitUrl = env('MAILPIT_URL', 'http://mailpit-email:8025');
    const mailCount = async (to: string): Promise<number> =>
      ((await (await expectOk(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages_count: number }).messages_count;
    try {
      await clearLimits();
      const token = await kcMasterToken();
      const keycloakEmail = (
        (await kcRealmAdmin(token, `/users?username=${DEV_USERS.customer.username}&exact=true`)).json as { email?: string }[] | undefined
      )?.[0]?.email?.toLowerCase();
      assert(!!keycloakEmail, '(10) customer.dev has no email in Keycloak');
      const primary = (
        await database.query<{ email_normalized: string }>(
          `SELECT email_normalized FROM identity.email_contacts WHERE account_id = $1 AND is_primary AND status = 'VERIFIED'`,
          [meA.accountId],
        )
      )[0]?.email_normalized;
      const resetRequests = async (): Promise<number> =>
        Number(
          (
            await database.query<{ n: string }>(
              `SELECT count(*) AS n FROM identity.account_audit_events WHERE account_id = $1 AND action = 'PASSWORD_RESET_REQUESTED'`,
              [meA.accountId],
            )
          )[0]!.n,
        );
      const ask = async (email: string): Promise<Reply> => call('POST', '/auth/password-reset', undefined, { body: { email } });
      const unknown = `smoke-nobody-${Math.random().toString(36).slice(2, 10)}@bananagig.localhost`;
      const unknownReply = await ask(unknown);
      const invalidReply = await ask('not an email address');
      assert(unknownReply.status === 202, `(10) an unknown address must get 202, got ${unknownReply.status}`);
      PasswordResetAcceptedResponse.parse(unknownReply.json);
      assert(invalidReply.status === 202 && invalidReply.text === unknownReply.text, '(10) an invalid address must get the same 202 body');
      guard('email address', unknown);
      guardLogs('email address', primary, keycloakEmail);
      if (!primary) {
        return {
          recorded: false,
          note: 'customer.dev has NO verified primary email in this environment, so only an unknown and an invalid address were requested (identical 202); nothing was created to force the known case',
        };
      }
      const before = await resetRequests();
      const sentBefore = await mailCount(keycloakEmail!);
      const sentToPrimaryBefore = await mailCount(primary);
      const knownReply = await ask(primary);
      assert(knownReply.status === unknownReply.status, `(10) known ${knownReply.status} vs unknown ${unknownReply.status}`);
      assert(
        knownReply.text === unknownReply.text,
        `(10) the 202 body must be byte-identical for a known and an unknown address (${knownReply.text} vs ${unknownReply.text})`,
      );
      for (const h of ['content-type', 'cache-control'])
        assert(knownReply.headers.get(h) === unknownReply.headers.get(h), `(10) header ${h} differs between a known and an unknown address`);
      await retry(
        async () => {
          if ((await resetRequests()) <= before) throw new Error('the request has not been recorded yet');
        },
        10,
        1000,
      );
      if (primary === keycloakEmail) {
        // the verified address is the one Keycloak holds: Keycloak sends the single-use link
        const link = await retry(
          async () => {
            const found = (await (await expectOk(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${keycloakEmail}"`)}`)).json()) as {
              messages: { ID: string }[] | null;
            };
            if (!found.messages?.length || (await mailCount(keycloakEmail!)) <= sentBefore) throw new Error('the reset email has not arrived');
            const m = (await (await expectOk(`${mailpitUrl}/api/v1/message/${found.messages[0]!.ID}`)).json()) as {
              Text: string;
              HTML: string;
              To: { Address: string }[];
            };
            assert(m.To.length === 1 && m.To[0]!.Address.toLowerCase() === keycloakEmail, '(10) the reset email must go to the verified address only');
            const key = /action-token\?key=([A-Za-z0-9._-]+)/.exec(htmlDecode(`${m.Text}\n${m.HTML}`))?.[1];
            if (!key) throw new Error('the reset email carries no link');
            return key;
          },
          10,
          1000,
        );
        guard('password reset link', link);
        await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${keycloakEmail}"`)}`, { method: 'DELETE' }).catch(() => undefined);
        return {
          recorded: true,
          note: 'the same 202 for the verified address of customer.dev, an unknown and an invalid address; the verified address equals the Keycloak address, so Keycloak sent the single-use link to Mailpit (not logged)',
        };
      }
      // the verified address differs from the one Keycloak holds: the request is recorded but NOTHING may be sent (to either address)
      await sleep(4000);
      assert(
        (await mailCount(keycloakEmail!)) === sentBefore,
        '(10) a reset email was sent to the Keycloak address although it differs from the verified address of the account',
      );
      assert((await mailCount(primary)) === sentToPrimaryBefore, '(10) a reset email was sent to the verified address, which Keycloak does not know');
      return {
        recorded: true,
        note: 'the same 202 for the verified address of customer.dev, an unknown and an invalid address; the verified address differs from the Keycloak email in this environment, so the request was recorded (PASSWORD_RESET_REQUESTED) and no mail was sent to either address',
      };
    } finally {
      await clearLimits().catch(() => undefined);
      valkey.disconnect();
      await database.close();
    }
  })();

  // ------------------------------------------------------------------------------------------------------ (9) the security timeline of customer.dev
  const t = await signIn('customer');
  const idT = await seenBy(t, '(9) timeline login');
  const timeline = ok(await call('GET', '/account/security/activity?limit=100', t.token), SecurityActivityResponse, '(9) activity');
  const entriesOf = (type: string) => timeline.entries.filter((x) => x.type === type);
  const at = (x: { occurredAt: string }): number => Date.parse(x.occurredAt);
  const createdA = entriesOf('SESSION_CREATED').find((x) => x.sessionId === idA);
  assert(!!createdA, '(9) SESSION_CREATED of session A is missing from the timeline');
  assert(
    entriesOf('SESSION_CREATED').some((x) => x.sessionId === idT),
    '(9) SESSION_CREATED of the timeline login is missing',
  );
  assert(
    entriesOf('SESSION_REVOKED').some((x) => x.sessionId === idB),
    '(9) SESSION_REVOKED of session B is missing',
  );
  assert(
    entriesOf('SESSION_REVOKED').some((x) => x.sessionId === idA),
    '(9) SESSION_REVOKED of session A (its browser was removed) is missing',
  );
  assert(
    entriesOf('SESSION_REVOKED').some((x) => x.sessionId === idI),
    '(9) SESSION_REVOKED of the signed-out session I is missing',
  );
  assert(entriesOf('SESSIONS_REVOKED_ALL').filter((x) => at(x) > at(createdA!)).length >= 2, '(9) two SESSIONS_REVOKED_ALL entries of this run are expected');
  for (const type of ['DEVICE_TRUSTED', 'DEVICE_UNTRUSTED', 'DEVICE_REMOVED'])
    assert(
      entriesOf(type).some((x) => at(x) > at(createdA!)),
      `(9) ${type} of this run is missing from the timeline`,
    );
  assert(
    entriesOf('SESSION_CREATED').find((x) => x.sessionId === idA)?.device?.browser === 'CHROME',
    '(9) the entry of session A must carry its coarse browser',
  );
  if (reset.recorded) assert(entriesOf('PASSWORD_RESET_REQUESTED').length > 0, '(9) PASSWORD_RESET_REQUESTED is missing');
  assert(
    timeline.entries.every((x, n, all) => n === 0 || at(all[n - 1]!) >= at(x)) &&
      timeline.entries.every((x) => x.outcome === 'SUCCESS' && x.labelContentKey.startsWith('account.security.activity.')),
    '(9) the timeline must be newest first with content-key labels',
  );
  assert(
    timeline.entries.every((x) =>
      Object.keys(x).every((key) => ['id', 'type', 'occurredAt', 'outcome', 'labelContentKey', 'sessionId', 'device'].includes(key)),
    ),
    '(9) unexpected fields in a timeline entry',
  );
  const page1 = ok(await call('GET', '/account/security/activity?limit=5', t.token), SecurityActivityResponse, '(9) first page');
  assert(page1.entries.length === 5 && page1.nextBefore !== null, '(9) a page of 5 must have a cursor');
  const page2 = ok(
    await call('GET', `/account/security/activity?limit=5&before=${encodeURIComponent(page1.nextBefore!)}`, t.token),
    SecurityActivityResponse,
    '(9) second page',
  );
  const firstPageIds = new Set(page1.entries.map((x) => x.id));
  assert(
    page2.entries.length > 0 && page2.entries.every((x) => !firstPageIds.has(x.id) && at(x) <= at(page1.entries[page1.entries.length - 1]!)),
    '(9) the second page must hold older entries only',
  );
  for (const bad of ['limit=0', 'limit=1e3', 'limit=101', 'limit=1.0', 'before=yesterday', 'unknown=1'])
    assert((await call('GET', `/account/security/activity?${bad}`, t.token)).status === 400, `(9) ?${bad} must be a 400`);

  for (const s of [t, k]) await call('POST', '/account/security/sessions/current/sign-out', s.token); // tidy: end the sessions this scenario still holds for customer.dev

  // ------------------------------------------------------------------------------------------------------ (6) MFA: provider.dev
  const mfaNote = await (async (): Promise<string> => {
    const provider = DEV_USERS.provider;
    const lines: string[] = [];
    let cleaned = false;
    try {
      // the web server records the intent first (a step-up guarded call: a login within the window is enough), then sends the browser to Keycloak with kc_action
      const p0 = await signIn('provider');
      assert(
        !p0.acr || p0.acr === 'bananagig:password',
        `(6) provider.dev must start password-only (acr ${p0.acr}): leftovers of an earlier run? (${healedSecondFactors} removed at the start)`,
      );
      const request = ok(
        await call('POST', '/account/security/mfa/enrollment', p0.token, { body: { method: 'TOTP' } }),
        MfaEnrollmentResponse,
        '(6) start TOTP enrolment',
      );
      assert(request.method === 'TOTP' && request.keycloakAction === 'CONFIGURE_TOTP', `(6) enrolment action ${request.keycloakAction}`);
      const before = ok(await call('GET', '/account/security', p0.token), SecurityOverviewResponse, '(6) overview before');
      assert(before.mfa.available && !before.mfa.totpConfigured, '(6) provider.dev must have no authenticator yet');

      const enrol = await kcWebLogin({ user: provider.username, pw: provider.password, enrol: 'totp' }, { kcAction: 'CONFIGURE_TOTP' });
      assert(enrol.done && !!enrol.totpSecret, `(6) the CONFIGURE_TOTP action did not complete (stopped at ${enrol.kind ?? 'unknown'})`);
      guard('TOTP secret', enrol.totpSecret);
      assert(kcActionStatusFromCallback(enrol.location!) === 'success', '(6) the callback must report kc_action_status=success');
      const enrolled = await loginOf(await kcTokens(enrol));
      const afterEnrol = ok(await call('GET', '/account/security', enrolled.token), SecurityOverviewResponse, '(6) overview after enrolment');
      assert(
        afterEnrol.mfa.available && afterEnrol.mfa.totpConfigured && !afterEnrol.mfa.recoveryCodesConfigured,
        `(6) GET /account/security must show totpConfigured:true (${JSON.stringify(afterEnrol.mfa)})`,
      );
      lines.push('TOTP enrolled through kc_action, totpConfigured:true');

      // a new login is CHALLENGED for the code even though the authorization request carries no acr_values
      await sleep(1200);
      const probe = await kcWebLogin({ user: provider.username, pw: provider.password, stopAt: ['otp'] });
      assert(!probe.done && probe.kind === 'otp', `(6) the login must be challenged for a code, got ${probe.done ? 'a token' : probe.kind}`);
      const mfa = await kcWebLogin({ user: provider.username, pw: provider.password, otp: () => nextTotp(enrol.totpSecret!) });
      const mfaLogin = await loginOf(await kcTokens(mfa));
      assert(mfaLogin.acr === 'bananagig:mfa', `(6) the token after the code must carry acr bananagig:mfa, got ${mfaLogin.acr}`);
      const overviewMfa = ok(await call('GET', '/account/security', mfaLogin.token), SecurityOverviewResponse, '(6) overview with an MFA login');
      assert(overviewMfa.stepUp.mfaSatisfied && overviewMfa.mfa.totpConfigured, '(6) the overview must show the second factor as satisfied');
      const recoveryRequest = ok(
        await call('POST', '/account/security/mfa/enrollment', mfaLogin.token, { body: { method: 'RECOVERY_CODES' } }),
        MfaEnrollmentResponse,
        '(6) start recovery-code enrolment with an MFA login',
      );
      assert(recoveryRequest.keycloakAction === 'CONFIGURE_RECOVERY_AUTHN_CODES', '(6) recovery-code enrolment action');
      lines.push('login challenged for the code without acr_values, acr bananagig:mfa, the sensitive enrolment endpoint accepts it');

      // recovery codes: generated by Keycloak in the SSO session of that login, then one code opens a new login instead of the authenticator
      const recovery = await kcWebLogin(
        { user: provider.username, pw: provider.password, otp: () => nextTotp(enrol.totpSecret!), enrol: 'recovery' },
        { kcAction: 'CONFIGURE_RECOVERY_AUTHN_CODES', jar: mfa.jar },
      );
      assert(
        recovery.done && (recovery.recoveryCodes?.length ?? 0) >= 8,
        `(6) the recovery-code action did not complete (stopped at ${recovery.kind ?? 'unknown'})`,
      );
      guard('recovery codes', ...recovery.recoveryCodes!);
      const afterRecovery = ok(await call('GET', '/account/security', mfaLogin.token), SecurityOverviewResponse, '(6) overview after recovery codes');
      assert(afterRecovery.mfa.recoveryCodesConfigured, '(6) GET /account/security must show recoveryCodesConfigured:true');
      await sleep(1200);
      const asked: number[] = [];
      const viaCode = await kcWebLogin({ user: provider.username, pw: provider.password, recovery: (n) => (asked.push(n), recovery.recoveryCodes![n - 1]!) });
      const codeLogin = await loginOf(await kcTokens(viaCode));
      assert(
        asked.length === 1 && codeLogin.acr === 'bananagig:mfa',
        `(6) one recovery code (asked for #${asked.join(',')}) must open a login with acr bananagig:mfa, got ${codeLogin.acr}`,
      );
      lines.push('recovery codes generated, one code used instead of the authenticator (acr mfa)');
      const providerActivity = ok(await call('GET', '/account/security/activity?limit=100', mfaLogin.token), SecurityActivityResponse, '(6) provider timeline');
      for (const type of ['MFA_ENROLLMENT_REQUESTED', 'MFA_ENABLED', 'RECOVERY_CODES_REQUESTED', 'RECOVERY_CODES_ENABLED'])
        assert(
          providerActivity.entries.some((x) => x.type === type),
          `(6) ${type} is missing from the provider timeline`,
        );
    } finally {
      // ALWAYS: provider.dev returns to password-only, whatever happened above
      const removedFactors = await removeSecondFactors(provider.username).catch((err: unknown) => {
        const why = `COULD NOT REMOVE the second factors of ${provider.username}: ${err instanceof Error ? err.message : String(err)}`;
        notes.push(why);
        console.error(why);
        return -1;
      });
      cleaned = removedFactors >= 0;
    }
    assert(cleaned, 'provider.dev kept its second factor: remove its otp / recovery-authn-codes credentials in the Keycloak admin console');
    await sleep(1200);
    const back = await signIn('provider'); // a password-only login works again; the API observes the removal (MFA_DISABLED / RECOVERY_CODES_DISABLED)
    const after = ok(await call('GET', '/account/security', back.token), SecurityOverviewResponse, '(6) overview after cleanup');
    assert(
      !after.mfa.totpConfigured && !after.mfa.recoveryCodesConfigured && back.acr === 'bananagig:password',
      '(6) provider.dev must be password-only again after the cleanup',
    );
    return `${lines.join('; ')}; second factors removed again and provider.dev logs in with a password only`;
  })();

  // ------------------------------------------------------------------------------------------------------ the web app through Caddy (what a browser reaches)
  const viaCaddy = (
    host: string,
    path: string,
    method: 'GET' | 'POST',
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string; location?: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: 'caddy-proxy', port: 80, path, method, headers: { host, ...(method === 'POST' ? { 'content-length': '0' } : {}), ...headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  const page = await viaCaddy('app.localhost', '/security', 'GET');
  assert(
    (page.status >= 300 && page.status < 400 && /\/auth\/login|\/session/.test(page.location ?? '')) ||
      (page.status === 200 && page.body.includes('/auth/login?returnTo=/security')),
    `GET /security without a session must send the visitor to sign in (got ${page.status})`,
  );
  assert(!page.body.includes('eyJ'), 'GET /security leaked token material');
  assert((await viaCaddy('app.localhost', '/forgot-password', 'GET')).status === 200, 'GET /forgot-password is a public page');
  const webOrigin = new URL(webPublic).origin;
  for (const path of ['/auth/security/revoke-all', '/auth/security/trust-device', '/auth/password-reset']) {
    assert((await viaCaddy('app.localhost', path, 'POST')).status === 403, `POST ${path} without an Origin header must be 403`);
    assert((await viaCaddy('app.localhost', path, 'POST', { origin: 'http://evil.example' })).status === 403, `POST ${path} with a foreign Origin must be 403`);
  }
  assert((await viaCaddy('app.localhost', '/auth/security/revoke-all', 'GET')).status === 405, 'GET /auth/security/revoke-all must be 405');
  const noSession = await viaCaddy('app.localhost', '/auth/security/revoke-all', 'POST', { origin: webOrigin });
  assert(
    noSession.status === 303 && /\/session$/.test(noSession.location ?? ''),
    `a same-origin POST without a session must redirect to /session (got ${noSession.status} ${noSession.location})`,
  );

  // ------------------------------------------------------------------------------------------------------ (11) no secret in any response or log line
  const everything = seen.join('\n');
  for (const [what, values] of secretsOf) for (const value of values) assert(!everything.includes(value), `a response contains the ${what}`);
  for (const part of rawUserAgentParts) assert(!everything.includes(part), `a response contains the raw user agent (${part})`);
  assert(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(everything), 'a response contains a JWT');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const query = async (q: string) =>
    (await (
      await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
    ).json()) as { data: { result: unknown[] } };
  await retry(
    async () => {
      if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1) throw new Error('this flow is not in Loki yet');
    },
    12,
    2000,
  );
  await sleep(6000); // the log exporter batches (5 s): give the last lines of the flow time to arrive before asserting an absence
  const apps = '{service_name=~"bananagig-(api|web|worker)"}';
  for (const [what, values] of [...secretsOf, ...logSecretsOf, ['raw user agent', rawUserAgentParts]] as [string, string[]][]) {
    const unique = [...new Set(values)];
    if (unique.length === 0) continue;
    // one query per group: the alternation of RE2-safe tokens (everything guarded is base64url, hex, a uuid, an address or a short code)
    const pattern = unique.map((v) => v.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&')).join('|');
    assert((await query(`${apps} |~ \`${pattern}\``)).data.result.length === 0, `the ${what} appears in the api, web or worker logs`);
  }

  return [
    `customer.dev: (1) first request created session ${idA.slice(0, 8)}... current:true, (2) second login = second session (different sid), (3) revoke of B -> B 401 SESSION_REVOKED ${refusedAfterMs} ms later, A kept, Keycloak session ended, refresh refused`,
    `(4) browser registered (random 43-char secret) shown as CHROME/MACOS/DESKTOP only`,
    `(5) trusted for ${overviewA.policy.trustedBrowserDays} days (window ${overviewA.policy.stepUpValidMinutes} min); ${stepUpNote}`,
    `(7) sign out everywhere else kept the caller and refused C and an unseen older login, a new login works; removing the browser revoked its session; including the caller refused all, new login works`,
    `(8) sign-out then 401 and refresh refused`,
    `(9) timeline: SESSION_CREATED / SESSION_REVOKED / SESSIONS_REVOKED_ALL / DEVICE_TRUSTED / DEVICE_UNTRUSTED / DEVICE_REMOVED, paged, coarse browser only`,
    `(6) provider.dev: ${mfaNote}`,
    `(10) ${reset.note}`,
    `web through Caddy: /security signs in, POSTs without a same-origin Origin are 403`,
    `(11) no token, sid, subject, device secret, TOTP secret, recovery code or reset link, and no raw user agent, in any response or in api/web/worker logs`,
    ...notes,
  ].join('; ');
});

// ---------------------------------------------------------------- Consent and legal-version history (ID-005)
await check('Consent', async () => {
  // Account consent (ID-005) end to end with REAL Keycloak tokens (customer.dev on bananagig-web, admin.dev and admin2.dev on bananagig-admin), real HTTP, the database
  // (read-only SQL) and Loki. Fresh environments hold NO legal text, so the scenario PUBLISHES legal versions of legal.terms_of_service and legal.privacy_policy (en-US)
  // through the REAL two-approver content workflow (admin.dev authors, submits and publishes; admin2.dev approves; both hold content-legal) on EVERY run: the text is
  // obviously dev-only ("SMOKE TEST ... <random>: not a legal document"), and because every run supersedes the previous run's versions, every run also exercises
  // REACCEPTANCE_REQUIRED. Consent state is append-only and is never restored; the scenario is repeatable because it always ends with both purposes SATISFIED.
  // Assumptions: DATABASE_URL (read-only SELECTs on identity.consent_events, content.versions, integration.outbox_events, identity.account_audit_events); LOKI_URL;
  // KEYCLOAK_*; WEB_PUBLIC_URL (default http://app.localhost:8080, the Origin the web handlers require); Caddy at caddy-proxy:80 routing Host app.localhost to the web
  // app; the dev policy of migration 0013 (consent.*.required_for = CUSTOMER, PROVIDER; consent.*.reacceptance = REACCEPT_REQUIRED); content locale en-US registered.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const PURPOSES = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'] as const;
  type Purpose = (typeof PURPOSES)[number];
  const cid = `smoke-consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const flowStart = Date.now() * 1e6;
  const seen: string[] = []; // every account-API response body and header block: searched for secrets and legal text at the end (NOT the public resolver or admin replies)
  const secrets = new Map<string, string[]>(); // what -> values that must appear in no account-API response and no log line
  const guard = (what: string, ...values: (string | undefined)[]): void => {
    secrets.set(what, [...(secrets.get(what) ?? []), ...values.filter((v): v is string => typeof v === 'string' && v.length >= 8)]);
  };
  const bodyTokens: string[] = []; // the random part of every legal text published here: must appear in no account-API response, log line, outbox payload or audit row
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  const decodeEntities = (s: string): string =>
    s
      .replace(/&#x27;|&#39;|&apos;/g, "'")
      .replace(/&quot;|&#x22;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  let customer = ''; // the access token of customer.dev (bananagig-web), set in step (1)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  type Reply = { status: number; text: string; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The account API as customer.dev (or anonymously): everything it answers is kept for the secret scan. */
  const call = async (method: 'GET' | 'POST', path: string, token?: string, o: { body?: unknown; raw?: string } = {}): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(o.body !== undefined || o.raw !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(o.raw !== undefined ? { body: o.raw } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const refusal = (r: Reply, status: number, code: string, what: string): void => {
    assert(
      r.status === status && r.json?.error?.code === code,
      `${what}: expected ${status} ${code}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 120)}`,
    );
  };
  const consentRefusal = (r: Reply, status: number, code: string, what: string): void => {
    refusal(r, status, `ACCOUNT_${code}`, what);
    assert(r.headers.get('cache-control') === 'no-store', `${what}: an error about consent must be Cache-Control: no-store`);
    assert(
      r.json.error.details?.messageKey === consentErrorMessageKey(code as Parameters<typeof consentErrorMessageKey>[0]),
      `${what}: the details must carry the message key ${consentErrorMessageKey(code as Parameters<typeof consentErrorMessageKey>[0])}`,
    );
  };

  // ---- administrators and the real content workflow (not part of the secret scan: the management API legitimately returns legal text)
  const adminCache = new Map<string, { token: string; at: number }>();
  const adminToken = async (user: 'admin' | 'admin2'): Promise<string> => {
    const cached = adminCache.get(user);
    if (cached && Date.now() - cached.at < 120_000) return cached.token;
    const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS[user] });
    const token = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-admin',
        redirectUri: ADMIN_REDIRECT_URI,
        code: l.code,
        codeVerifier: l.verifier,
      })
    ).accessToken;
    adminCache.set(user, { token, at: Date.now() });
    return token;
  };
  const content = async (token: string | null, method: 'GET' | 'POST', path: string, body?: unknown, okStatuses = [200, 201]) => {
    const r = await get(`${api}/api/v1/content${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!okStatuses.includes(r.status)) throw new Error(`${method} /content${path} -> ${r.status} ${json?.error?.code ?? ''}`);
    return { status: r.status, json };
  };
  interface Published {
    key: string;
    versionId: string;
    version: number;
    bodySha256: string;
    token: string;
  }
  /** Authors, submits, approves (by the SECOND administrator) and publishes a new en-US version of a legal document, immediately effective. */
  const publishLegal = async (key: string, label: string): Promise<Published> => {
    const token = randomBytes(12).toString('hex');
    const body = `SMOKE TEST ${label} ${token}: not a legal document`;
    bodyTokens.push(token);
    const author = await adminToken('admin');
    const draft = (await content(author, 'POST', `/entries/${key}/versions`, { locale: 'en-US', body, reason: 'DEV/TEST ONLY consent smoke document' })).json
      .data;
    assert(draft.status === 'DRAFT', `${key}: a new version should be a DRAFT (got ${draft.status})`);
    await content(author, 'POST', `/versions/${draft.versionId}/submit`, {});
    await content(await adminToken('admin2'), 'POST', `/versions/${draft.versionId}/approve`, {});
    const published = (await content(author, 'POST', `/versions/${draft.versionId}/publish`, {})).json.data;
    assert(published.status === 'PUBLISHED', `${key}: the version should be PUBLISHED (got ${published.status})`);
    assert(published.bodySha256 === sha256(body), `${key}: the stored hash must be the SHA-256 of the UTF-8 text`);
    return { key, versionId: published.versionId, version: published.version, bodySha256: published.bodySha256, token };
  };
  /** The PUBLIC resolver (no token): what any visitor is served for a document. */
  const resolvePublic = async (key: string, locale: string) => {
    const r = await get(`${api}/api/v1/content/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, locale, context: {} }),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const copyOf = async (key: string): Promise<string> => {
    const r = await resolvePublic(key, 'en-US');
    assert(r.status === 200 && typeof r.json.data?.value === 'string' && r.json.data.value.length > 0, `the registry copy ${key} is not served`);
    return r.json.data.value as string;
  };

  // ---- the account API views
  const requirements = async (what: string, locale?: string) => {
    const r = await call('GET', `/account/consents/requirements${locale === undefined ? '' : `?locale=${encodeURIComponent(locale)}`}`, customer);
    assert(r.status === 200, `${what}: GET /account/consents/requirements -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 120)}`);
    assert(r.headers.get('cache-control') === 'no-store', `${what}: requirements must be no-store`);
    return ConsentRequirementsResponse.parse(r.json).data;
  };
  const consents = async (what: string) => {
    const r = await call('GET', '/account/consents', customer);
    assert(r.status === 200, `${what}: GET /account/consents -> ${r.status}`);
    return AccountConsentsResponse.parse(r.json).data;
  };
  const row = (d: { requirements: ConsentRequirementDto[] }, code: string): ConsentRequirementDto => {
    const x = d.requirements.find((r) => r.purposeCode === code);
    assert(!!x, `the requirements do not list ${code}`);
    return x!;
  };
  type Claim = { versionId: string; locale: string; bodySha256: string };
  const claimOf = (d: { versionId: string; locale: string; bodySha256: string }): Claim => ({
    versionId: d.versionId,
    locale: d.locale,
    bodySha256: d.bodySha256,
  });
  const accept = (code: string, body: unknown): Promise<Reply> => call('POST', `/account/consents/${code}/accept`, customer, { body });
  /** A changed (or unchanged) acceptance that must succeed, checked against the exact version it claims. */
  const acceptOk = async (code: Purpose, c: Claim & { version: number }, what: string, o: { changed: boolean; seq?: number }) => {
    const r = await accept(code, claimOf(c));
    assert(r.status === 200, `${what}: accept ${code} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 120)}`);
    assert(r.headers.get('cache-control') === 'no-store', `${what}: accept must be no-store`);
    const d = AcceptConsentResponse.parse(r.json).data;
    assert(d.changed === o.changed, `${what}: accept ${code} changed=${d.changed}, expected ${o.changed}`);
    assert(
      d.event.purposeCode === code &&
        d.event.eventType === 'ACCEPTED' &&
        d.event.source === 'ACCOUNT_API' &&
        d.event.document.versionId === c.versionId &&
        d.event.document.locale === c.locale &&
        d.event.document.bodySha256 === c.bodySha256 &&
        d.event.document.version === c.version,
      `${what}: the event of ${code} must reference the exact version id, number, locale and hash`,
    );
    if (o.seq !== undefined) assert(d.event.eventSeq === o.seq, `${what}: ${code} event_seq ${d.event.eventSeq}, expected ${o.seq}`);
    assert(uuidRe.test(d.event.consentEventId), `${what}: the event id is not a uuid`);
    return d;
  };

  const databaseUrl = env('DATABASE_URL', '');
  assert(databaseUrl !== '', 'DATABASE_URL is not set in the smoke environment');
  const database = createDatabase(databaseUrl, { role: 'tests' });
  try {
    const startDb = (await database.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`))[0]!.t; // the database clock: both sides of every time comparison come from it

    // ------------------------------------------------------------------------------------------------------ (1) authenticate customer.dev
    const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    customer = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: l.code,
        codeVerifier: l.verifier,
      })
    ).accessToken;
    const principal = await verifier.verifyAccessToken(customer);
    guard('access token (signature)', customer.split('.')[2]?.slice(0, 64));
    guard('Keycloak session id', principal.sessionId);
    guard('Keycloak subject', principal.subject);
    const me = AccountResponse.parse((await call('GET', '/account/me', customer)).json).data;
    const accountId = me.accountId;
    assert(
      me.roles.some((r) => r.code === 'CUSTOMER'),
      '(1) customer.dev must hold the CUSTOMER role',
    );
    const sessions = SecuritySessionsResponse.parse((await call('GET', '/account/security/sessions', customer)).json).data.sessions;
    const currentSessionId = sessions.find((s) => s.current)?.sessionId;
    assert(!!currentSessionId && uuidRe.test(currentSessionId), '(1) the login must have one current application session');
    refusal(await call('GET', '/account/consents/requirements'), 401, 'AUTHENTICATION_REQUIRED', '(1) anonymous requirements');
    refusal(await call('GET', '/account/consents'), 401, 'AUTHENTICATION_REQUIRED', '(1) anonymous consents');

    // ------------------------------------------------------------------------------------------------------ (2) requirements before the documents are published
    const req2 = await requirements('(2)');
    assert(
      req2.locale === 'en-US',
      `(2) the evaluated locale should be the platform default en-US (got ${req2.locale}; does customer.dev have a preferred locale?)`,
    );
    const state0 = new Map<Purpose, { status: string; accepted: boolean }>();
    for (const code of PURPOSES) {
      const r = row(req2, code);
      assert(r.required, `(2) ${code} must be required for customer.dev (consent.${code.toLowerCase()}.required_for)`);
      assert(
        r.withdrawable === false && r.reacceptance === 'REACCEPT_REQUIRED',
        `(2) ${code} must be NOT_WITHDRAWABLE with reacceptance REACCEPT_REQUIRED (got withdrawable ${r.withdrawable}, ${r.reacceptance})`,
      );
      assert(
        (r.status === 'DOCUMENT_UNAVAILABLE') === (r.document === null),
        `(2) ${code}: DOCUMENT_UNAVAILABLE exactly when no document is in force (${r.status})`,
      );
      if (r.document) {
        assert(
          r.document.entryKey === LEGAL_ENTRY_KEYS[code] && r.document.locale === 'en-US',
          `(2) ${code}: the document is ${r.document.entryKey} ${r.document.locale}`,
        );
        if (r.status === 'SATISFIED')
          assert(
            r.acceptanceState === 'ACCEPTED' && r.accepted?.document.versionId === r.document.versionId,
            `(2) ${code}: SATISFIED needs the acceptance of the version in force`,
          );
        if (r.status === 'REACCEPTANCE_REQUIRED')
          assert(
            r.acceptanceState === 'ACCEPTED' && r.accepted?.document.versionId !== r.document.versionId,
            `(2) ${code}: REACCEPTANCE_REQUIRED needs an older acceptance`,
          );
        if (r.status === 'OUTSTANDING') assert(r.acceptanceState !== 'ACCEPTED', `(2) ${code}: OUTSTANDING means not accepted`);
      }
      assert(
        ['DOCUMENT_UNAVAILABLE', 'OUTSTANDING', 'REACCEPTANCE_REQUIRED', 'SATISFIED'].includes(r.status),
        `(2) ${code}: unexpected status ${r.status} (NOT_REQUIRED would mean the policy no longer requires it for CUSTOMER)`,
      );
      state0.set(code, { status: r.status, accepted: r.acceptanceState === 'ACCEPTED' });
    }
    assert(
      req2.satisfied === PURPOSES.every((c) => row(req2, c).status === 'SATISFIED') &&
        req2.outstanding.length === PURPOSES.filter((c) => row(req2, c).status !== 'SATISFIED').length,
      '(2) satisfied / outstanding must follow the statuses',
    );
    const fresh = PURPOSES.every((c) => state0.get(c)!.status === 'DOCUMENT_UNAVAILABLE');
    // event_seq counts the events of an account and purpose (nothing here withdraws), so the latest sequence numbers are exact even when the history read is capped
    const latestSeq = async (what: string): Promise<Record<Purpose, number>> => {
      const c = (await consents(what)).current;
      return {
        TERMS_OF_SERVICE: c.find((x) => x.purposeCode === 'TERMS_OF_SERVICE')?.latest?.eventSeq ?? 0,
        PRIVACY_POLICY: c.find((x) => x.purposeCode === 'PRIVACY_POLICY')?.latest?.eventSeq ?? 0,
      };
    };
    const eventCount = async (what: string): Promise<number> => Object.values(await latestSeq(what)).reduce((n, x) => n + x, 0);
    const seq0 = await latestSeq('(2)');

    // ------------------------------------------------------------------------------------------------------ (3) publish the documents through the real workflow; the public resolver equals the requirement
    const published = {} as Record<Purpose, Published>;
    for (const code of PURPOSES) published[code] = await publishLegal(LEGAL_ENTRY_KEYS[code], code === 'TERMS_OF_SERVICE' ? 'TERMS' : 'PRIVACY');
    const req3 = await requirements('(3)');
    assert(
      !req3.satisfied && PURPOSES.every((c) => req3.outstanding.includes(c)),
      `(3) both purposes must be outstanding after the new versions (${req3.outstanding.join(',')})`,
    );
    for (const code of PURPOSES) {
      const r = row(req3, code);
      const pub = published[code];
      const d = r.document;
      assert(!!d, `(3) ${code}: the version in force is missing after the publication`);
      assert(
        d!.entryKey === pub.key && d!.versionId === pub.versionId && d!.version === pub.version && d!.bodySha256 === pub.bodySha256 && d!.locale === 'en-US',
        `(3) ${code}: the requirement must name the version just published (entry, id, number, hash, locale)`,
      );
      // every run supersedes: an account that accepted before must be asked again; one that never did is outstanding
      const expected = state0.get(code)!.accepted ? 'REACCEPTANCE_REQUIRED' : 'OUTSTANDING';
      assert(r.status === expected, `(3) ${code}: expected ${expected} after the supersession, got ${r.status}`);
      const resolved = await retry(
        async () => {
          const x = await resolvePublic(pub.key, 'en-US');
          if (x.status !== 200 || x.json.data?.versionId !== pub.versionId)
            throw new Error(`the public resolver served ${x.status} ${x.json.data?.versionId ?? ''}`);
          return x.json.data;
        },
        10,
        500,
      );
      assert(
        resolved.key === d!.entryKey &&
          resolved.contentType === 'LEGAL' &&
          resolved.versionId === d!.versionId &&
          resolved.version === d!.version &&
          resolved.bodySha256 === d!.bodySha256 &&
          resolved.resolvedLocale === d!.locale &&
          resolved.requestedLocale === 'en-US' &&
          resolved.fallback.applied === false,
        `(3) ${code}: the PUBLIC resolver must serve exactly the version of the requirement (id, hash, EXACT en-US, no fallback)`,
      );
      assert(String(resolved.value).includes(pub.token), `(3) ${code}: the resolver must serve the text that was published`);
      assert(
        resolved.bodySha256 === sha256(`SMOKE TEST ${code === 'TERMS_OF_SERVICE' ? 'TERMS' : 'PRIVACY'} ${pub.token}: not a legal document`),
        `(3) ${code}: the served hash is not the SHA-256 of the text`,
      );
      const other = await resolvePublic(pub.key, 'es-MX');
      assert(other.status !== 200, `(3) ${code}: es-MX must not silently resolve to another locale (EXACT fallback), got ${other.status}`);
    }

    // ------------------------------------------------------------------------------------------------------ (4) (5) accept both, exactly what was shown
    const events = new Map<string, { purpose: Purpose; versionId: string; locale: string; bodySha256: string; seq: number; viaWeb: boolean }>();
    const noteEvent = (e: { consentEventId: string; purposeCode: string; eventSeq: number; document: Claim }, viaWeb: boolean): void => {
      events.set(e.consentEventId, { purpose: e.purposeCode as Purpose, ...claimOf(e.document), seq: e.eventSeq, viaWeb });
    };
    const first = {} as Record<Purpose, Awaited<ReturnType<typeof acceptOk>>>;
    for (const code of PURPOSES) {
      const d = row(req3, code).document!;
      first[code] = await acceptOk(code, d, `(${code === 'TERMS_OF_SERVICE' ? 4 : 5})`, { changed: true, seq: seq0[code] + 1 });
      noteEvent(first[code].event, false);
    }

    // ------------------------------------------------------------------------------------------------------ (6) satisfied
    const req6 = await requirements('(6)');
    assert(
      req6.satisfied === true && req6.outstanding.length === 0,
      `(6) satisfied must be true with nothing outstanding (outstanding ${req6.outstanding.join(',')})`,
    );
    for (const code of PURPOSES) {
      const r = row(req6, code);
      assert(
        r.status === 'SATISFIED' &&
          r.acceptanceState === 'ACCEPTED' &&
          r.accepted?.consentEventId === first[code].event.consentEventId &&
          r.document?.versionId === published[code].versionId,
        `(6) ${code}: SATISFIED by the event just recorded`,
      );
    }

    // ------------------------------------------------------------------------------------------------------ (7) repeating is idempotent
    const lengthAfterAccepts = await eventCount('(7)');
    for (const code of PURPOSES) {
      const again = await acceptOk(code, { ...claimOf(row(req6, code).document!), version: published[code].version }, '(7)', { changed: false });
      assert(again.event.consentEventId === first[code].event.consentEventId, `(7) ${code}: a repeat must return the original event, not a new one`);
    }
    assert((await eventCount('(7)')) === lengthAfterAccepts, '(7) repeating the acceptances must not add history');

    // ------------------------------------------------------------------------------------------------------ (8) the history, refusals, locale handling and the database
    const all = await consents('(8)');
    for (const code of PURPOSES) {
      const ev = first[code].event;
      const inHistory = all.history.find((e) => e.consentEventId === ev.consentEventId);
      assert(
        !!inHistory &&
          inHistory.document.versionId === published[code].versionId &&
          inHistory.document.locale === 'en-US' &&
          inHistory.document.bodySha256 === published[code].bodySha256 &&
          inHistory.eventType === 'ACCEPTED',
        `(8) ${code}: the history event must reference the exact version id, locale and hash`,
      );
      const current = all.current.find((c) => c.purposeCode === code);
      assert(
        current?.state === 'ACCEPTED' && current.withdrawable === false && current.latest?.consentEventId === ev.consentEventId,
        `(8) ${code}: the derived current state`,
      );
    }
    assert(
      all.history.every((e) => e.source === 'ACCOUNT_API' && uuidRe.test(e.consentEventId)),
      '(8) history shape',
    );
    const terms = row(req6, 'TERMS_OF_SERVICE').document!;
    const termsClaim = claimOf(terms);
    const lengthBeforeRefusals = await eventCount('(8)');
    const flip = (hash: string): string => (hash[0] === '0' ? '1' : '0') + hash.slice(1);
    const wrongHash = flip(terms.bodySha256);
    // the claimed hash or locale is compared with the immutable version and never repaired; the rejected value is never echoed
    const badHash = await accept('TERMS_OF_SERVICE', { ...termsClaim, bodySha256: wrongHash });
    consentRefusal(badHash, 400, 'CONSENT_HASH_MISMATCH', '(8) wrong hash');
    assert(!badHash.text.includes(wrongHash), '(8) a wrong hash must not be echoed');
    consentRefusal(await accept('TERMS_OF_SERVICE', { ...termsClaim, locale: 'fr-FR' }), 400, 'CONSENT_LOCALE_MISMATCH', '(8) wrong locale');
    consentRefusal(
      await accept('TERMS_OF_SERVICE', { ...termsClaim, locale: 'en-us' }),
      400,
      'CONSENT_LOCALE_MISMATCH',
      '(8) locale in another case is not silently normalized',
    );
    consentRefusal(await accept('TERMS_OF_SERVICE', { ...termsClaim, versionId: randomUUID() }), 404, 'CONSENT_VERSION_NOT_FOUND', '(8) unknown version id');
    consentRefusal(
      await accept('TERMS_OF_SERVICE', { ...termsClaim, versionId: '00000000-0000-0000-0000-000000000000' }),
      404,
      'CONSENT_VERSION_NOT_FOUND',
      '(8) the nil uuid',
    );
    consentRefusal(
      await accept('TERMS_OF_SERVICE', claimOf(row(req6, 'PRIVACY_POLICY').document!)),
      404,
      'CONSENT_VERSION_NOT_FOUND',
      '(8) the version of ANOTHER document for this purpose',
    );
    consentRefusal(await accept('NO_SUCH_PURPOSE', termsClaim), 404, 'CONSENT_PURPOSE_NOT_FOUND', '(8) unknown well-formed purpose');
    consentRefusal(
      await call('POST', '/account/consents/TERMS_OF_SERVICE/withdraw', customer, { body: {} }),
      409,
      'CONSENT_NOT_WITHDRAWABLE',
      '(8) withdrawing TERMS_OF_SERVICE',
    );
    consentRefusal(
      await call('POST', '/account/consents/PRIVACY_POLICY/withdraw', customer),
      409,
      'CONSENT_NOT_WITHDRAWABLE',
      '(8) withdrawing PRIVACY_POLICY (no body)',
    );
    // strict inputs: nothing is coerced, normalized or taken from the client
    for (const [what, path, body] of [
      ['an extra field', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, extra: true }],
      ['an account id', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, accountId }],
      ['a client time', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, occurredAt: '2001-01-01T00:00:00Z' }],
      ['an upper-case hash', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, bodySha256: terms.bodySha256.toUpperCase() }],
      ['a malformed version id', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, versionId: 'not-a-uuid' }],
      ['a numeric locale', '/account/consents/TERMS_OF_SERVICE/accept', { ...termsClaim, locale: 12345 }],
      ['a missing field', '/account/consents/TERMS_OF_SERVICE/accept', { versionId: terms.versionId, locale: terms.locale }],
      ['an empty body', '/account/consents/TERMS_OF_SERVICE/accept', {}],
      ['a lower-case purpose', '/account/consents/terms_of_service/accept', termsClaim],
      ['a withdraw body with a field', '/account/consents/TERMS_OF_SERVICE/withdraw', { reason: 'x' }],
    ] as const)
      assert((await call('POST', path, customer, { body })).status === 400, `(8) ${what} must be a 400`);
    assert(
      (await call('POST', '/account/consents/TERMS_OF_SERVICE/accept', customer, { raw: '{"versionId":' })).status === 400,
      '(8) malformed JSON must be a 400',
    );
    assert(
      (await call('POST', '/account/consents/TERMS_OF_SERVICE/accept', undefined, { body: termsClaim })).status === 401,
      '(8) accepting without a token must be a 401',
    );
    assert((await call('GET', '/account/consents/requirements?locale=en-US&locale=en-US', customer)).status === 400, '(8) a repeated locale must be a 400');
    assert((await call('GET', '/account/consents/requirements?other=1', customer)).status === 400, '(8) an unknown query parameter must be a 400');
    // a stale (superseded) version: an older version of the document that is not the account's latest acceptance is refused as NOT_CURRENT
    let staleNote = 'a superseded version is refused in step (9)';
    {
      const detail = (await content(await adminToken('admin'), 'GET', `/entries/${LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE}`)).json.data.versions as {
        versionId: string;
        locale: string;
        scopeType: string;
        status: string;
        version: number;
        bodySha256: string;
      }[];
      const older = detail
        .filter((v) => v.status === 'SUPERSEDED' && v.locale === 'en-US' && v.scopeType === 'PLATFORM')
        .sort((x, y) => y.version - x.version)[0];
      if (older) {
        consentRefusal(
          await accept('TERMS_OF_SERVICE', { versionId: older.versionId, locale: older.locale, bodySha256: older.bodySha256 }),
          409,
          'CONSENT_VERSION_NOT_CURRENT',
          '(8) a superseded version',
        );
        staleNote = `superseded version ${older.version} refused 409 NOT_CURRENT`;
      }
    }
    // ?locale: an explicit locale is evaluated EXACTLY (no silent en-US fallback), or refused when it is not a registered locale
    const registered = ((await content(await adminToken('admin'), 'GET', '/locales')).json.data as { locale: string }[]).some((x) => x.locale === 'es-MX');
    let localeNote: string;
    if (registered) {
      const es = await requirements('(8) es-MX', 'es-MX');
      assert(es.locale === 'es-MX', `(8) the requirements were evaluated in ${es.locale}, not es-MX (silent fallback)`);
      for (const code of PURPOSES) {
        const r = row(es, code);
        assert(
          r.document === null ? r.status === 'DOCUMENT_UNAVAILABLE' : r.document.locale === 'es-MX',
          `(8) ${code} in es-MX: no en-US document may be offered (status ${r.status})`,
        );
      }
      localeNote = 'es-MX is a registered locale: evaluated exactly, DOCUMENT_UNAVAILABLE (no legal text in es-MX), never the en-US document';
    } else {
      const es = await call('GET', '/account/consents/requirements?locale=es-MX', customer);
      assert(
        es.status === 400 && es.json?.error?.code === 'ACCOUNT_VALIDATION_FAILED' && es.json.error.details?.reason === 'INVALID_LOCALE',
        `(8) es-MX is not a registered locale: expected 400 ACCOUNT_VALIDATION_FAILED INVALID_LOCALE, got ${es.status} ${es.json?.error?.code}`,
      );
      localeNote = 'es-MX is NOT a registered locale: refused 400 INVALID_LOCALE, no fallback to en-US';
    }
    const wrongCase = await call('GET', '/account/consents/requirements?locale=en-us', customer);
    assert(
      wrongCase.status === 400 && wrongCase.json?.error?.details?.reason === 'INVALID_LOCALE',
      `(8) en-us is not the registered tag en-US: expected 400 INVALID_LOCALE, got ${wrongCase.status}`,
    );
    assert((await eventCount('(8)')) === lengthBeforeRefusals, '(8) a refused request must write nothing');

    /** The read-only database proof of every event of the account (composite binding, sequence, session, server time) and, optionally, of the events of this run. */
    const verifyDb = async (what: string): Promise<string> => {
      const rows = await database.query<{
        consent_event_id: string;
        purpose_code: string;
        event_seq: number;
        event_type: string;
        version_id: string;
        locale: string;
        body_sha256: string;
        application_session_id: string | null;
        source: string;
        entry_key: string;
        age_s: string;
        since_start: boolean;
      }>(
        `SELECT e.consent_event_id, e.purpose_code, e.event_seq, e.event_type, e.version_id, e.locale, e.body_sha256, e.application_session_id, e.source, en.key AS entry_key,
                extract(epoch FROM (clock_timestamp() - e.occurred_at)) AS age_s, (e.occurred_at >= $2::timestamptz) AS since_start
           FROM identity.consent_events e
           JOIN content.versions v ON v.version_id = e.version_id AND v.locale = e.locale AND v.body_sha256 = e.body_sha256
           JOIN content.entries en ON en.entry_id = v.entry_id
          WHERE e.account_id = $1
          ORDER BY e.purpose_code, e.event_seq`,
        [accountId, startDb],
      );
      const total = Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM identity.consent_events WHERE account_id = $1`, [accountId]))[0]!.n);
      assert(rows.length === total, `${what}: ${total - rows.length} event(s) are not bound to a content version by (version_id, locale, body_sha256)`);
      for (const code of PURPOSES) {
        const seqs = rows.filter((x) => x.purpose_code === code).map((x) => x.event_seq);
        assert(
          seqs.every((s, n) => s === n + 1),
          `${what}: ${code} event_seq must be 1..n without gaps (got ${seqs.join(',')})`,
        );
        assert(
          rows.filter((x) => x.purpose_code === code).every((x) => x.entry_key === LEGAL_ENTRY_KEYS[code]),
          `${what}: ${code} events must be bound to ${LEGAL_ENTRY_KEYS[code]}`,
        );
      }
      assert(
        rows.every((x) => x.source === 'ACCOUNT_API' && x.application_session_id !== null && uuidRe.test(x.application_session_id)),
        `${what}: every event must record the application session it happened in`,
      );
      const mine = rows.filter((x) => x.since_start);
      assert(mine.length === events.size, `${what}: ${mine.length} event(s) since the start of this run in the database, ${events.size} recorded by the API`);
      for (const x of mine) {
        const known = events.get(x.consent_event_id);
        assert(!!known, `${what}: the database holds an event of this run that the API never reported`);
        assert(
          known!.purpose === x.purpose_code &&
            known!.versionId === x.version_id &&
            known!.locale === x.locale &&
            known!.bodySha256 === x.body_sha256 &&
            known!.seq === x.event_seq &&
            x.event_type === 'ACCEPTED',
          `${what}: the stored event differs from what the API reported`,
        );
        if (!known!.viaWeb)
          assert(x.application_session_id === currentSessionId, `${what}: the event must be tied to the application session of the token that accepted`);
        const age = Number(x.age_s);
        assert(age >= 0 && age < 900, `${what}: occurred_at must be the database time of this run (${age.toFixed(1)} s ago)`);
      }
      return `${rows.length} events in the database, ${mine.length} of this run`;
    };
    const dbNote8 = await verifyDb('(8)');

    // ------------------------------------------------------------------------------------------------------ (9) a newer Terms version supersedes: re-acceptance
    const termsV1 = { ...termsClaim, version: published.TERMS_OF_SERVICE.version };
    const termsV2 = await publishLegal(LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE, 'TERMS');
    const req9 = await requirements('(9)');
    const t9 = row(req9, 'TERMS_OF_SERVICE');
    assert(
      t9.status === 'REACCEPTANCE_REQUIRED' &&
        t9.acceptanceState === 'ACCEPTED' &&
        t9.accepted?.document.versionId === termsV1.versionId &&
        t9.document?.versionId === termsV2.versionId,
      `(9) Terms must be REACCEPTANCE_REQUIRED (got ${t9.status}); the old acceptance is kept in the record`,
    );
    assert(row(req9, 'PRIVACY_POLICY').status === 'SATISFIED', '(9) Privacy is untouched by a new Terms version');
    assert(!req9.satisfied && req9.outstanding.length === 1 && req9.outstanding[0] === 'TERMS_OF_SERVICE', '(9) only Terms is outstanding');
    // repeating the account's latest acceptance (now superseded) is an idempotent no-op that does not satisfy the new version
    const repeatOld = await acceptOk('TERMS_OF_SERVICE', termsV1, '(9) the superseded version again', { changed: false });
    assert(repeatOld.event.consentEventId === first.TERMS_OF_SERVICE.event.consentEventId, '(9) the repeat returns the original event');
    assert(
      row(await requirements('(9) after the repeat'), 'TERMS_OF_SERVICE').status === 'REACCEPTANCE_REQUIRED',
      '(9) a repeated old acceptance must not satisfy the new version',
    );
    const v2Event = await acceptOk('TERMS_OF_SERVICE', { ...claimOf(t9.document!), version: termsV2.version }, '(9) the new version', {
      changed: true,
      seq: first.TERMS_OF_SERVICE.event.eventSeq + 1,
    });
    noteEvent(v2Event.event, false);
    const req9b = await requirements('(9) after accepting');
    assert(
      req9b.satisfied && req9b.outstanding.length === 0 && row(req9b, 'TERMS_OF_SERVICE').accepted?.document.versionId === termsV2.versionId,
      '(9) satisfied again with the new version',
    );
    consentRefusal(
      await accept('TERMS_OF_SERVICE', claimOf(termsV1)),
      409,
      'CONSENT_VERSION_NOT_CURRENT',
      '(9) the superseded version after the new acceptance',
    );
    const lengthAfterV2 = await eventCount('(9)');
    assert(lengthAfterV2 === lengthAfterAccepts + 1, `(9) the history must hold exactly one more event (${lengthAfterAccepts} -> ${lengthAfterV2})`);

    // ------------------------------------------------------------------------------------------------------ (10) the web app through Caddy (what a browser reaches)
    const webOrigin = new URL(webPublic).origin;
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[]; headers: http.IncomingHttpHeaders };
    const caddy = (method: 'GET' | 'POST', path: string, o: { cookie?: string; origin?: string; form?: URLSearchParams } = {}): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const payload = o.form?.toString();
        const req = http.request(
          {
            host: 'caddy-proxy',
            port: 80,
            path,
            method,
            headers: {
              host: 'app.localhost',
              ...(o.cookie ? { cookie: o.cookie } : {}),
              ...(o.origin ? { origin: o.origin } : {}),
              ...(method === 'POST' ? { 'content-length': String(Buffer.byteLength(payload ?? '')) } : {}),
              ...(payload !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, location: res.headers.location, body, cookies: res.headers['set-cookie'] ?? [], headers: res.headers }),
            );
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end(payload);
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const formsOf = (html: string) =>
      [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({
        action: decodeEntities(/\baction="([^"]*)"/.exec(m[1]!)?.[1] ?? ''),
        inputs: [...m[2]!.matchAll(/<input\b([^>]*)>/g)].map((i) => ({
          type: decodeEntities(/\btype="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          name: decodeEntities(/\bname="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          value: decodeEntities(/\bvalue="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
        })),
        html: m[2]!,
      }));
    /** The web app forbids framing every page (clickjacking): both headers on every response. */
    const noFraming = (h: Hop, what: string): void => {
      const csp = String(h.headers['content-security-policy'] ?? '');
      assert(
        /frame-ancestors\s+'none'/.test(csp) && String(h.headers['x-frame-options'] ?? '').toUpperCase() === 'DENY',
        `${what}: the response must carry Content-Security-Policy frame-ancestors 'none' and X-Frame-Options DENY`,
      );
    };
    const pageHas = (html: string, text: string): boolean => html.includes(text) || decodeEntities(html).includes(text);
    /** How often a registry text is visible in the page (script payloads of the framework excluded). */
    const countOf = (html: string, text: string): number => decodeEntities(html.replace(/<script[\s\S]*?<\/script>/g, '')).split(text).length - 1;
    const consentPage = async (query = '') => {
      const p = await caddy('GET', `/consents${query}`, { cookie: cookie() });
      assert(p.status === 200, `(10) GET /consents${query} with a session -> ${p.status}`);
      noFraming(p, `(10) GET /consents${query}`);
      assert(!/eyJ[A-Za-z0-9_-]{10,}\./.test(p.body) && !p.body.includes(customer), '(10) the consents page leaked token material');
      for (const v of jar.values()) assert(v.length < 8 || !p.body.includes(v), '(10) the consents page contains the session cookie value');
      return p;
    };
    const redirectsTo = (h: Hop, suffix: string, what: string): void =>
      assert(h.status === 303 && (h.location ?? '').endsWith(suffix), `${what}: expected 303 ...${suffix}, got ${h.status} ${h.location}`);

    // signed out: sign-in is offered, no control that changes state exists, and every action refuses
    const anonPage = await caddy('GET', '/consents');
    assert(
      anonPage.status === 200 && anonPage.body.includes('/auth/login?returnTo=/consents'),
      `(10) GET /consents without a session must offer sign-in (got ${anonPage.status})`,
    );
    noFraming(anonPage, '(10) signed-out GET /consents');
    noFraming(await caddy('GET', '/security'), '(10) signed-out GET /security');
    assert(
      !anonPage.body.includes('/auth/consents/accept') && !anonPage.body.includes(published.TERMS_OF_SERVICE.token),
      '(10) the signed-out page must hold no accept form and no legal text',
    );
    const claimForm = (c: Claim, purpose = 'TERMS_OF_SERVICE') =>
      new URLSearchParams({ purpose, versionId: c.versionId, locale: c.locale, bodySha256: c.bodySha256 });
    assert(
      (await caddy('POST', '/auth/consents/accept', { form: claimForm(termsV1) })).status === 403,
      '(10) POST /auth/consents/accept without an Origin must be 403',
    );
    assert(
      (await caddy('POST', '/auth/consents/accept', { form: claimForm(termsV1), origin: 'http://evil.example' })).status === 403,
      '(10) POST /auth/consents/accept with a foreign Origin must be 403',
    );
    assert(
      (await caddy('POST', '/auth/consents/withdraw', { form: new URLSearchParams({ purpose: 'TERMS_OF_SERVICE' }) })).status === 403,
      '(10) POST /auth/consents/withdraw without an Origin must be 403',
    );
    assert((await caddy('GET', '/auth/consents/accept')).status === 405, '(10) GET /auth/consents/accept must be 405 (no GET changes state)');
    redirectsTo(
      await caddy('POST', '/auth/consents/accept', { form: claimForm(termsV1), origin: webOrigin }),
      '/session',
      '(10) a same-origin POST without a session',
    );

    // sign in on the web app (Authorization Code + PKCE through Caddy, like a browser), after publishing a THIRD Terms version so that something is outstanding
    const termsV3 = await publishLegal(LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE, 'TERMS');
    const start = await caddy('GET', '/auth/login?returnTo=/consents');
    absorb(start);
    assert(start.status === 302 && (start.location ?? '').includes('code_challenge_method=S256'), `(10) web login did not start a PKCE flow (${start.status})`);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, ...DEV_USERS.customer });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, { cookie: cookie() });
    absorb(callback);
    assert(
      callback.status === 302 && (callback.location ?? '').endsWith('/consents') && jar.has('bg_session'),
      `(10) web callback failed (${callback.status} ${callback.location})`,
    );
    guard('web session cookie', jar.get('bg_session'));

    const req10 = await requirements('(10)');
    const t10 = row(req10, 'TERMS_OF_SERVICE');
    assert(
      t10.status === 'REACCEPTANCE_REQUIRED' && t10.document?.versionId === termsV3.versionId,
      `(10) Terms must await re-acceptance of the third version (got ${t10.status})`,
    );
    const lengthBeforeWeb = await eventCount('(10)');
    const statusCopy = {
      reacceptance: await copyOf('account.consent.status.reacceptance_required'),
      satisfied: await copyOf('account.consent.status.satisfied'),
    };
    const pageBefore = await consentPage();
    assert(pageHas(pageBefore.body, termsV3.token), '(10) the page must show the legal text of the version in force (served by the public resolver)');
    const reacceptBefore = countOf(pageBefore.body, statusCopy.reacceptance);
    const satisfiedBefore = countOf(pageBefore.body, statusCopy.satisfied);
    assert(reacceptBefore >= 1, '(10) the page must show the REACCEPTANCE_REQUIRED status copy');
    assert(
      !/<input[^>]*type="checkbox"/i.test(pageBefore.body) && !/<input[^>]*\schecked\b/i.test(pageBefore.body),
      '(10) nothing may be pre-ticked (PRD R-13)',
    );
    const acceptForms = formsOf(pageBefore.body).filter((f) => f.action === '/auth/consents/accept');
    assert(acceptForms.length === 1, `(10) exactly one accept form expected (Terms), got ${acceptForms.length}`);
    const form = acceptForms[0]!;
    const fields = Object.fromEntries(form.inputs.map((i) => [i.name, i.value]));
    assert(
      form.inputs.length === 4 && form.inputs.every((i) => i.type === 'hidden') && Object.keys(fields).sort().join() === 'bodySha256,locale,purpose,versionId',
      '(10) the accept form must hold exactly the four hidden fields',
    );
    assert(
      fields.purpose === 'TERMS_OF_SERVICE' && fields.versionId === termsV3.versionId && fields.locale === 'en-US' && fields.bodySha256 === termsV3.bodySha256,
      '(10) the hidden fields must be the version in force (proven equal to what the public resolver served)',
    );
    assert(!formsOf(pageBefore.body).some((f) => f.action === '/auth/consents/withdraw'), '(10) no withdraw control for a purpose that cannot be withdrawn');

    // a tampered or malformed form changes nothing
    const post = (form: URLSearchParams) => caddy('POST', '/auth/consents/accept', { cookie: cookie(), origin: webOrigin, form });
    const good = claimForm(claimOf(t10.document!));
    const tampered = (change: Record<string, string>): URLSearchParams => new URLSearchParams({ ...Object.fromEntries(good), ...change });
    redirectsTo(await post(tampered({ bodySha256: flip(termsV3.bodySha256) })), '/consents?error=ACCOUNT_CONSENT_HASH_MISMATCH', '(10) a tampered hash');
    redirectsTo(await post(tampered({ locale: 'fr-FR' })), '/consents?error=ACCOUNT_CONSENT_LOCALE_MISMATCH', '(10) a tampered locale');
    redirectsTo(
      await post(tampered({ versionId: published.PRIVACY_POLICY.versionId })),
      '/consents?error=ACCOUNT_CONSENT_VERSION_NOT_FOUND',
      '(10) the version of another document',
    );
    redirectsTo(
      await post(tampered({ versionId: termsV1.versionId, bodySha256: termsV1.bodySha256 })),
      '/consents?error=ACCOUNT_CONSENT_VERSION_NOT_CURRENT',
      '(10) a superseded version',
    );
    redirectsTo(await post(tampered({ purpose: 'NO_SUCH_PURPOSE' })), '/consents?error=ACCOUNT_CONSENT_PURPOSE_NOT_FOUND', '(10) an unknown purpose');
    for (const [what, form] of [
      ['a malformed hash', tampered({ bodySha256: 'nothex' })],
      ['an upper-case hash', tampered({ bodySha256: termsV3.bodySha256.toUpperCase() })],
      ['a malformed version id', tampered({ versionId: 'x' })],
      ['a lower-case purpose', tampered({ purpose: 'terms_of_service' })],
      ['an extra field', new URLSearchParams([...good, ['accountId', accountId] as [string, string]])],
      ['a repeated field', new URLSearchParams([...good, ['locale', 'en-US'] as [string, string]])],
      ['a missing field', new URLSearchParams({ purpose: 'TERMS_OF_SERVICE', versionId: termsV3.versionId, locale: 'en-US' })],
    ] as const)
      assert((await post(form)).status === 400, `(10) ${what} must be a 400`);
    assert((await eventCount('(10)')) === lengthBeforeWeb, '(10) a tampered or malformed form must record nothing');
    assert(row(await requirements('(10) after tampering'), 'TERMS_OF_SERVICE').status === 'REACCEPTANCE_REQUIRED', '(10) Terms must still await re-acceptance');
    const errorPage = await consentPage('?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    assert(
      !decodeEntities(errorPage.body.replace(/<script[\s\S]*?<\/script>/g, '')).includes('alert(1)'),
      '(10) an unknown ?error= value must never be echoed in the page',
    );

    // the correct form is accepted, then the page shows the accepted state
    const accepted = await post(good);
    redirectsTo(accepted, '/consents?notice=accepted', '(10) the correct form');
    const reqAfterWeb = await requirements('(10) after the web acceptance');
    const afterWeb = row(reqAfterWeb, 'TERMS_OF_SERVICE');
    assert(
      reqAfterWeb.satisfied &&
        afterWeb.status === 'SATISFIED' &&
        afterWeb.accepted?.document.versionId === termsV3.versionId &&
        afterWeb.accepted.eventSeq === v2Event.event.eventSeq + 1,
      '(10) the web acceptance must be recorded for the exact version (event_seq + 1)',
    );
    noteEvent(afterWeb.accepted!, true);
    assert((await eventCount('(10)')) === lengthBeforeWeb + 1, '(10) exactly one event is recorded by the web acceptance');
    const pageAfter = await consentPage();
    assert(
      countOf(pageAfter.body, statusCopy.satisfied) > satisfiedBefore && countOf(pageAfter.body, statusCopy.reacceptance) === reacceptBefore - 1,
      `(10) the page must show more of the SATISFIED copy (which is also the accepted-state and history-event copy, so the count grows by one or more) and one less REACCEPTANCE_REQUIRED status after the acceptance (satisfied ${satisfiedBefore} -> ${countOf(pageAfter.body, statusCopy.satisfied)}, reacceptance ${reacceptBefore} -> ${countOf(pageAfter.body, statusCopy.reacceptance)})`,
    );
    assert(!formsOf(pageAfter.body).some((f) => f.action === '/auth/consents/accept'), '(10) nothing is left to accept: no accept form');
    const noticePage = await consentPage('?notice=accepted');
    assert(
      pageHas(noticePage.body, await copyOf('account.consent.notice.accepted')),
      '(10) ?notice=accepted shows the registry copy (the data proves the acceptance)',
    );
    redirectsTo(await post(good), '/consents?notice=already_accepted', '(10) the same form again');
    assert((await eventCount('(10)')) === lengthBeforeWeb + 1, '(10) the repeated form must record nothing');
    const logout = await caddy('POST', '/auth/logout', { cookie: cookie(), origin: webOrigin });
    assert(logout.status === 303, `(10) web logout -> ${logout.status}`);

    // ------------------------------------------------------------------------------------------------------ (11) database proof, outbox, audit, and no legal text anywhere it must not be
    const dbNote = await verifyDb('(11)');
    const accepts = [...events.entries()];
    const outbox = await database.query<{ event_type: string; payload_json: Record<string, unknown> }>(
      `SELECT event_type, payload_json FROM integration.outbox_events
        WHERE event_type LIKE 'bananagig.identity.consent-%' AND payload_json->>'accountId' = $1 AND created_at >= $2::timestamptz`,
      [accountId, startDb],
    );
    assert(
      outbox.length === accepts.length && outbox.every((o) => o.event_type === 'bananagig.identity.consent-accepted.v1'),
      `(11) ${accepts.length} consent-accepted events expected in the outbox for this run (and no withdrawal), found ${outbox.length}: ${outbox.map((o) => o.event_type).join(',')}`,
    );
    for (const o of outbox) {
      assert(
        Object.keys(o.payload_json).sort().join() === 'accountId,consentEventId,contentVersionId,eventSeq,purposeCode',
        `(11) a consent-accepted payload must carry exactly the 5 keys (got ${Object.keys(o.payload_json).sort().join(',')})`,
      );
      const known = events.get(String(o.payload_json.consentEventId));
      assert(
        !!known && known.versionId === o.payload_json.contentVersionId && known.purpose === o.payload_json.purposeCode && known.seq === o.payload_json.eventSeq,
        '(11) an outbox payload must match the event it announces',
      );
    }
    const audit = await database.query<{ action: string; changes: Record<string, unknown>; consent_event_id: string }>(
      `SELECT action, changes, consent_event_id FROM identity.account_audit_events
        WHERE account_id = $1 AND action IN ('CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN') AND occurred_at >= $2::timestamptz`,
      [accountId, startDb],
    );
    assert(
      audit.length === accepts.length &&
        audit.every(
          (a) => a.action === 'CONSENT_ACCEPTED' && events.has(a.consent_event_id) && Object.keys(a.changes).sort().join() === 'eventSeq,purposeCode',
        ),
      `(11) one CONSENT_ACCEPTED audit row per acceptance, changes = {purposeCode, eventSeq} only (found ${audit.length})`,
    );
    const patterns = bodyTokens.map((t) => `%${t}%`);
    const leaks = (
      await database.query<{ outbox: string; audit: string; events: string; versions: string }>(
        `SELECT (SELECT count(*) FROM integration.outbox_events WHERE created_at >= $1::timestamptz AND payload_json::text LIKE ANY($2::text[])) AS outbox,
                (SELECT count(*) FROM identity.account_audit_events WHERE occurred_at >= $1::timestamptz AND (coalesce(changes::text, '') LIKE ANY($2::text[]) OR coalesce(reason, '') LIKE ANY($2::text[]))) AS audit,
                (SELECT count(*) FROM identity.consent_events e WHERE e::text LIKE ANY($2::text[])) AS events,
                (SELECT count(*) FROM content.versions WHERE body LIKE ANY($2::text[])) AS versions`,
        [startDb, patterns],
      )
    )[0]!;
    assert(Number(leaks.outbox) === 0, '(11) legal text found in integration.outbox_events payloads');
    assert(Number(leaks.audit) === 0, '(11) legal text found in identity.account_audit_events');
    assert(Number(leaks.events) === 0, '(11) legal text found in identity.consent_events');
    assert(
      Number(leaks.versions) === bodyTokens.length,
      `(11) the content registry should hold the ${bodyTokens.length} published texts (and only there), found ${leaks.versions}`,
    );

    const everything = seen.join('\n');
    for (const token of bodyTokens) assert(!everything.includes(token), '(11) legal body text found in an account API response');
    for (const [what, values] of secrets) for (const value of values) assert(!everything.includes(value), `(11) an account API response contains the ${what}`);
    assert(!everything.includes(customer), '(11) an account API response contains the access token');
    assert(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(everything), '(11) an account API response contains a JWT');

    const loki = env('LOKI_URL', 'http://loki-logs:3100');
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000); // the log exporter batches (5 s): give the last lines of the flow time to arrive before asserting an absence
    const apps = '{service_name=~"bananagig-(api|web|worker)"}';
    for (const [what, values] of [['legal body text', bodyTokens], ...secrets] as [string, string[]][]) {
      const unique = [...new Set(values)];
      if (unique.length === 0) continue;
      const pattern = unique.map((v) => v.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&')).join('|');
      assert((await query(`${apps} |~ \`${pattern}\``)).data.result.length === 0, `(11) the ${what} appears in the api, web or worker logs`);
    }

    return [
      `customer.dev (${accountId.slice(0, 8)}...): (2) requirements for both purposes ${fresh ? 'DOCUMENT_UNAVAILABLE (fresh environment: no legal text existed)' : [...state0.values()].map((x) => x.status).join('/')}, (3) legal versions published through the real two-approver workflow (admin.dev authors and publishes, admin2.dev approves) and equal to the PUBLIC resolver (version id, hash, EXACT en-US, no fallback)`,
      `(4)(5) Terms and Privacy accepted with exactly the version id, locale and hash shown, (6) satisfied, (7) repeats idempotent (changed:false, history unchanged)`,
      `(8) history events carry the exact version id, locale and hash; wrong hash 400, wrong locale 400, unknown or foreign version 404, unknown purpose 404, NOT_WITHDRAWABLE 409, strict bodies 400, ${staleNote}; ${localeNote}; ${dbNote8}`,
      `(9) a newer Terms version -> REACCEPTANCE_REQUIRED (the repeat of the superseded acceptance is an idempotent no-op that does not satisfy; after the new acceptance the superseded version is refused 409), satisfied again`,
      `(10) web through Caddy: signed-out /consents offers sign-in, POSTs without a same-origin Origin 403, tampered or malformed forms redirected with an error word and nothing recorded, the correct form 303 notice=accepted, the page then shows the accepted state, a repeat is already_accepted`,
      `(11) ${dbNote}; ${outbox.length} consent-accepted outbox events with exactly the 5 payload keys and ${audit.length} audit rows; ${bodyTokens.length} legal texts found only in the content registry (none in responses, logs, outbox, audit or consent events); no token, sid, subject or session cookie in any response or in api/web/worker logs`,
    ].join('; ');
  } finally {
    await database.close();
  }
});

// Caddy routes are exercised exactly as a browser would reach them (Host header), from inside the network.
const proxy = (host: string, path: string, method = 'GET'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: 'caddy-proxy', port: 80, path, method, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
await check('Account area', async () => {
  // The shared account area (ACC-001) end to end with a REAL Keycloak token of customer.dev (bananagig-web), real HTTP through the API, the database and the content
  // resolver. customer.dev holds CUSTOMER and PROVIDER (PROVIDER is granted idempotently here, as the Accounts scenario does, because no endpoint grants a role).
  // The seeded matrix gives both roles the same six sections, so the ROLE-DRIVEN difference is proven against the registry itself: the section set is compared with a
  // direct SQL read of the matrix for the role in use, and one matrix row (PRIVACY_DATA for PROVIDER) is switched off for the duration of one step and ALWAYS restored.
  // Assumptions: DATABASE_URL (read of the registry; the one temporary UPDATE is restored in `finally`); the seed of migration 0014; content locale en-US.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const cid = `smoke-area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seen: string[] = []; // every account-API response body and header block, searched for secrets at the end
  type Reply = { status: number; text: string; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (method: 'GET' | 'PATCH', path: string, token?: string, o: { body?: unknown; role?: string } = {}): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(o.role ? { [ACTIVE_ROLE_HEADER]: o.role } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    seen.push(text, JSON.stringify([...r.headers]));
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const ok200 = (r: Reply, what: string): Reply => {
    assert(r.status === 200, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 120)}`);
    assert(r.headers.get('cache-control') === 'no-store', `${what}: an account area response must be Cache-Control: no-store`);
    return r;
  };
  const copyOf = async (key: string): Promise<string> => {
    const r = await get(`${api}/api/v1/content/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, locale: 'en-US', context: {} }),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert(r.status === 200 && typeof json.data?.value === 'string' && json.data.value.length > 0, `the registry copy ${key} is not served`);
    return json.data.value as string;
  };

  const databaseUrl = env('DATABASE_URL', '');
  assert(databaseUrl !== '', 'DATABASE_URL is not set in the smoke environment');
  const database = createDatabase(databaseUrl, { role: 'tests' });
  let privacyOffForProvider = false;
  try {
    // precondition (self-healing): step (9) switches ONE seeded matrix row off and restores it; a run that was killed in between would leave it off. The seeded state is
    // "enabled", so put it back before anything is compared with it.
    const healed = await database.query<{ section_code: string }>(
      `UPDATE identity.account_section_roles SET enabled = true
        WHERE section_code = 'PRIVACY_DATA' AND NOT enabled AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')
        RETURNING section_code`,
    );
    if (healed.length > 0) console.warn('Account area: restored PRIVACY_DATA for PROVIDER, which an interrupted earlier run had switched off');

    // (1) authenticate and make sure the account holds both roles (idempotent)
    const l = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const customer = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: l.code,
        codeVerifier: l.verifier,
      })
    ).accessToken;
    const principal = await verifier.verifyAccessToken(customer);
    const me = AccountResponse.parse(ok200(await call('GET', '/account/me', customer), 'GET /account/me').json).data;
    await new AccountService({ database }).grantRole(me.accountId, 'PROVIDER', { actor: 'system:smoke', source: 'SYSTEM' });
    assert((await call('GET', '/account/navigation')).status === 401, '(1) the navigation must require a token');

    // the registry as the database holds it, for a role: the oracle the API answer is compared with
    const registry = async (role: string) =>
      database.query<{ code: string; route: string; label: string; description: string | null }>(
        `SELECT s.section_code AS code, s.route_path AS route, s.label_content_key AS label, s.description_content_key AS description
           FROM identity.roles r
           JOIN identity.account_section_roles sr ON sr.role_id = r.role_id AND sr.enabled
           JOIN identity.account_sections s ON s.section_code = sr.section_code AND s.status = 'ACTIVE'
          WHERE r.code = $1 AND r.status = 'ACTIVE'
          ORDER BY sr.display_order`,
        [role],
      );
    const navigation = async (what: string, role?: string) =>
      AccountNavigationResponse.parse(ok200(await call('GET', '/account/navigation', customer, { role }), what).json).data;
    const asRegistry = (sections: { code: string; route: string; labelContentKey: string; descriptionContentKey: string | null }[]) =>
      sections.map((s) => ({ code: s.code, route: s.route, label: s.labelContentKey, description: s.descriptionContentKey }));

    // (2) the CUSTOMER section set is the registry's, in its order, with its own URL per section and managed labels
    const asCustomer = await navigation('(2) navigation as CUSTOMER', 'CUSTOMER');
    assert(asCustomer.activeRole === 'CUSTOMER', `(2) active role ${asCustomer.activeRole}`);
    assert(
      asCustomer.roles
        .map((r) => r.code)
        .sort()
        .join() === 'CUSTOMER,PROVIDER',
      '(2) the switcher must list both held roles',
    );
    const expectedSeed = ['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES'];
    assert(
      JSON.stringify(asRegistry(asCustomer.sections)) === JSON.stringify(await registry('CUSTOMER')),
      '(2) the CUSTOMER navigation must equal the registry read from the database for that role',
    );
    assert(
      asCustomer.sections.map((s) => s.code).join() === expectedSeed.join(),
      `(2) seeded CUSTOMER sections: ${asCustomer.sections.map((s) => s.code).join()}`,
    );
    assert(
      new Set(asCustomer.sections.map((s) => s.route)).size === asCustomer.sections.length &&
        asCustomer.sections.every((s) => /^\/account\/[a-z-]+$/.test(s.route)),
      '(2) every section has its own /account/<slug> URL',
    );
    assert(!asCustomer.sections.some((s) => s.code === 'NOTIFICATIONS' || s.code === 'CLOSE_ACCOUNT'), '(2) PLANNED sections must not be offered');
    for (const s of asCustomer.sections) {
      await copyOf(s.labelContentKey);
      if (s.descriptionContentKey) await copyOf(s.descriptionContentKey);
    }
    assert(
      asCustomer.contacts.contactsVerified === (asCustomer.contacts.emailVerified && asCustomer.contacts.phoneVerified),
      '(2) the contacts summary must be derived',
    );

    // (3) profile: composed from identity.account_profiles; the names are PATCHed by field, an unchanged repeat writes nothing
    const profileOf = async (what: string) =>
      AccountProfileViewResponse.parse(ok200(await call('GET', '/account/profile', customer, { role: 'CUSTOMER' }), what).json).data.profile;
    let profile = await profileOf('(3) GET /account/profile');
    if (profile === null) {
      const created = ProfilePatchedResponse.parse(
        ok200(
          await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { firstName: 'Dev', lastName: 'Customer' } }),
          '(3) create the profile',
        ).json,
      ).data;
      assert(created.changed, '(3) creating the profile must report changed');
      profile = await profileOf('(3) GET /account/profile after creating');
    }
    assert(
      profile !== null && profile.displayName === `${profile.firstName} ${[...profile.lastName][0]!.toUpperCase()}.`,
      '(3) displayName must be first name and last initial',
    );
    const sameName = ProfilePatchedResponse.parse(
      ok200(await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { lastName: profile!.lastName } }), '(3) unchanged PATCH').json,
    ).data;
    assert(!sameName.changed, '(3) an unchanged PATCH must write nothing');
    const refusedEmpty = await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: {} });
    assert(refusedEmpty.status === 400 && refusedEmpty.json?.error?.code === 'VALIDATION_FAILED', '(3) an empty PATCH must be a 400');
    assert(
      (await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { accountId: me.accountId, firstName: 'X' } })).status === 400,
      '(3) an account id in the body must be refused',
    );
    // language and region: an ACTIVE zone is accepted and cleared again, the names stay; an unknown zone is refused without changing anything
    const zones = (await (await get(`${api}/api/v1/geography/time-zones`)).json()) as { data: { ianaName: string }[] };
    const zone = zones.data.find((z) => z.ianaName === 'America/New_York')?.ianaName ?? zones.data[0]?.ianaName;
    assert(typeof zone === 'string', '(3) no ACTIVE time zone is registered');
    const before = profile!;
    const setZone = ProfilePatchedResponse.parse(
      ok200(await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { timeZone: zone } }), '(3) set the time zone').json,
    ).data;
    assert(
      setZone.profile.timeZone === zone && setZone.profile.firstName === before.firstName && setZone.profile.lastName === before.lastName,
      '(3) only the time zone changes',
    );
    const badZone = await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { timeZone: 'Mars/Olympus_Mons' } });
    assert(badZone.status === 400, `(3) an unknown time zone must be refused (${badZone.status})`);
    assert(!badZone.text.includes('Olympus'), '(3) a refused value must never be echoed');
    const cleared = ProfilePatchedResponse.parse(
      ok200(await call('PATCH', '/account/profile', customer, { role: 'CUSTOMER', body: { timeZone: before.timeZone } }), '(3) restore the time zone').json,
    ).data;
    assert(cleared.profile.timeZone === before.timeZone, '(3) the time zone must be restored');

    // (4) contact details: the SAME masked values as /account/me, composed
    const contact = ContactVerificationSectionResponse.parse(
      ok200(await call('GET', '/account/contact-verification', customer, { role: 'CUSTOMER' }), '(4) contacts').json,
    ).data;
    const meAgain = AccountResponse.parse(ok200(await call('GET', '/account/me', customer, { role: 'CUSTOMER' }), '(4) /account/me').json).data;
    assert(
      JSON.stringify(contact) === JSON.stringify({ email: meAgain.email, phone: meAgain.phone, contacts: meAgain.contacts }),
      '(4) the contact section must equal the account read model (composition, not a second copy)',
    );

    // (5) security: a light summary of ID-004
    const security = SecuritySummaryResponse.parse(
      ok200(await call('GET', '/account/security-summary', customer, { role: 'CUSTOMER' }), '(5) security').json,
    ).data;
    assert(security.activeSessionCount >= 1, '(5) this login is a live session');
    assert(typeof security.mfa.available === 'boolean' && typeof security.currentBrowserTrusted === 'boolean', '(5) the summary shape');

    // (6) privacy: counts equal what the consent layer says; the data download is announced as not available
    const privacy = PrivacySummaryResponse.parse(ok200(await call('GET', '/account/privacy', customer, { role: 'CUSTOMER' }), '(6) privacy').json).data;
    const req = ConsentRequirementsResponse.parse(
      ok200(await call('GET', '/account/consents/requirements', customer, { role: 'CUSTOMER' }), '(6) requirements').json,
    ).data;
    assert(
      privacy.consents.satisfied === req.satisfied && privacy.consents.outstandingCount === req.outstanding.length && privacy.consents.locale === req.locale,
      '(6) the privacy summary must agree with the consent requirements',
    );
    assert(privacy.dataDownload.available === false, '(6) the data download is not available yet');

    // (7) roles: held roles and the switch targets
    const roles = AccountRolesSectionResponse.parse(ok200(await call('GET', '/account/roles', customer, { role: 'CUSTOMER' }), '(7) roles').json).data;
    assert(roles.activeRole === 'CUSTOMER' && roles.switchableTo.join() === 'PROVIDER', `(7) switchableTo ${roles.switchableTo.join()}`);

    // (8) PROVIDER with the SAME token (no new login): the set follows the active role
    const asProvider = await navigation('(8) navigation as PROVIDER', 'PROVIDER');
    assert(asProvider.activeRole === 'PROVIDER', `(8) active role ${asProvider.activeRole}`);
    assert(
      JSON.stringify(asRegistry(asProvider.sections)) === JSON.stringify(await registry('PROVIDER')),
      '(8) the PROVIDER navigation must equal the registry read from the database for that role',
    );
    assert(
      asProvider.roles.map((r) => r.code).join() === asCustomer.roles.map((r) => r.code).join(),
      '(8) switching role keeps the same account and its roles',
    );
    const rolesAsProvider = AccountRolesSectionResponse.parse(
      ok200(await call('GET', '/account/roles', customer, { role: 'PROVIDER' }), '(8) roles').json,
    ).data;
    assert(rolesAsProvider.activeRole === 'PROVIDER' && rolesAsProvider.switchableTo.join() === 'CUSTOMER', '(8) switch targets follow the active role');
    const stillMe = AccountResponse.parse(ok200(await call('GET', '/account/me', customer, { role: 'PROVIDER' }), '(8) /account/me').json).data;
    assert(stillMe.accountId === me.accountId, '(8) the same account after the switch');
    assert((await verifier.verifyAccessToken(customer)).sessionId === principal.sessionId, '(8) the same Keycloak session (no new login)');
    const notHeld = await call('GET', '/account/navigation', customer, { role: 'ADMIN' });
    assert(
      notHeld.status === 403 && notHeld.json?.error?.code === 'ACCOUNT_ROLE_NOT_HELD',
      `(8) a role the account does not hold must be a 403 (${notHeld.status})`,
    );

    // (8b) the WEB app through Caddy with a real PKCE session (what a browser reaches): the shell follows whatever the API returns for the active role
    const webOrigin = new URL(webPublic).origin;
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[]; headers: http.IncomingHttpHeaders };
    const caddy = (method: 'GET' | 'POST', path: string, o: { cookie?: string; origin?: string; form?: URLSearchParams } = {}): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const payload = o.form?.toString();
        const req = http.request(
          {
            host: 'caddy-proxy',
            port: 80,
            path,
            method,
            headers: {
              host: 'app.localhost',
              ...(o.cookie ? { cookie: o.cookie } : {}),
              ...(o.origin ? { origin: o.origin } : {}),
              ...(method === 'POST' ? { 'content-length': String(Buffer.byteLength(payload ?? '')) } : {}),
              ...(payload !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, location: res.headers.location, body, cookies: res.headers['set-cookie'] ?? [], headers: res.headers }),
            );
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end(payload);
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const decode = (x: string): string =>
      x
        .replace(/&#x27;|&#39;|&apos;/g, "'")
        .replace(/&quot;|&#x22;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    const page = async (path: string): Promise<Hop> => caddy('GET', path, { cookie: cookie() });
    /** The links of the account menu (the `nav` of the account shell, not the site header), in document order. */
    const menuOf = (html: string): string[] => {
      const nav = /<nav\b[^>]*\bclass="account-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
      return [...nav.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => decode(m[1]!));
    };
    /** Next.js answers 404 for a not-found page, or 200 with the not-found content once the response is streaming: either is "not served". */
    const notServed = (h: Hop): boolean => h.status === 404 || (h.status === 200 && /Page not found/.test(h.body));
    const noFraming = (h: Hop, what: string): void =>
      assert(
        /frame-ancestors\s+'none'/.test(String(h.headers['content-security-policy'] ?? '')) &&
          String(h.headers['x-frame-options'] ?? '').toUpperCase() === 'DENY',
        `${what}: the response must forbid framing`,
      );
    const signedOut = await caddy('GET', '/account');
    assert(
      (signedOut.status >= 300 && signedOut.status < 400 && (signedOut.location ?? '').includes('/auth/login')) ||
        signedOut.body.includes('/auth/login?returnTo=/account'),
      `(8b) /account without a session must lead to sign-in (${signedOut.status} ${signedOut.location ?? ''})`,
    );
    const start = await caddy('GET', '/auth/login?returnTo=/account');
    absorb(start);
    assert(start.status === 302 && (start.location ?? '').includes('code_challenge_method=S256'), `(8b) web login did not start a PKCE flow (${start.status})`);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, ...DEV_USERS.customer });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, { cookie: cookie() });
    absorb(callback);
    assert(callback.status === 302 && jar.has('bg_session'), `(8b) web callback failed (${callback.status})`);
    const switchTo = (role: string, next?: string) =>
      caddy('POST', '/auth/active-role', {
        cookie: cookie(),
        origin: webOrigin,
        form: new URLSearchParams(next === undefined ? { role } : { role, next }),
      });
    const labels = new Map<string, string>(); // section code -> managed label
    for (const sec of asCustomer.sections) labels.set(sec.code, await copyOf(sec.labelContentKey));
    const expectedMenu = (sections: { route: string }[]): string => sections.map((x) => x.route).join(',');
    const customerHome = await page('/account');
    assert(customerHome.status === 200, `(8b) GET /account as CUSTOMER -> ${customerHome.status}`);
    noFraming(customerHome, '(8b) GET /account');
    assert(
      menuOf(customerHome.body).join(',') === expectedMenu(asCustomer.sections),
      `(8b) the menu must be the API sections in order (${menuOf(customerHome.body).join(',')})`,
    );
    for (const label of labels.values()) assert(decode(customerHome.body).includes(label), `(8b) the registry label "${label}" must be on the page`);
    assert((customerHome.body.match(/<h1\b/g) ?? []).length === 1, '(8b) one h1 per page');
    assert(/<nav\b[^>]*\bclass="account-nav"[^>]*aria-label="[^"]+"/.test(customerHome.body), '(8b) the menu is a labelled nav landmark');
    for (const sec of asCustomer.sections) {
      const h = await page(sec.route);
      assert(h.status === 200, `(8b) GET ${sec.route} -> ${h.status}`);
      assert(
        new RegExp(`href="${sec.route}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${sec.route}"`).test(h.body),
        `(8b) ${sec.route} must mark itself aria-current`,
      );
      assert(decode(h.body).includes(labels.get(sec.code)!), `(8b) ${sec.route} must carry its managed heading`);
    }
    for (const gone of ['/account/notifications', '/account/close', '/account/no-such-section'])
      assert(notServed(await page(gone)), `(8b) ${gone} (a PLANNED or unknown section) must not be served`);
    for (const v of jar.values()) assert(v.length < 8 || !customerHome.body.includes(v), '(8b) the account page contains the session cookie value');
    assert(!customerHome.body.includes(customer) && !customerHome.body.includes(me.accountId), '(8b) a token or the account id leaked into the page');

    // the role switch through the BFF: no new login, the next page follows the new role; only the two allowed return paths are honoured
    const evil = await switchTo('PROVIDER', '//evil.example/x');
    assert(
      evil.status === 303 && (evil.location ?? '').endsWith('/session'),
      `(8b) an unlisted next must fall back to /session (${evil.status} ${evil.location})`,
    );
    const sw = await switchTo('PROVIDER', '/account/roles');
    assert(
      sw.status === 303 && (sw.location ?? '').endsWith('/account/roles'),
      `(8b) the role switch must return to the Roles section (${sw.status} ${sw.location})`,
    );
    const providerHome = await page('/account');
    assert(
      menuOf(providerHome.body).join(',') === expectedMenu(asProvider.sections),
      `(8b) the menu after the switch must be the PROVIDER sections (${menuOf(providerHome.body).join(',')})`,
    );
    assert(
      (await caddy('POST', '/auth/active-role', { cookie: cookie(), form: new URLSearchParams({ role: 'CUSTOMER' }) })).status === 403,
      '(8b) the role switch without an Origin must be 403',
    );

    // (9) hidden means absent ON THE SERVER: switch PRIVACY_DATA off for PROVIDER (restored in finally) and the set, the guarded route and the other role follow
    await database.query(
      `UPDATE identity.account_section_roles SET enabled = false
        WHERE section_code = 'PRIVACY_DATA' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
    );
    privacyOffForProvider = true;
    const providerNow = await navigation('(9) navigation as PROVIDER, PRIVACY_DATA off', 'PROVIDER');
    assert(
      !providerNow.sections.some((s) => s.code === 'PRIVACY_DATA') && providerNow.sections.length === asProvider.sections.length - 1,
      '(9) the section must be gone from the PROVIDER navigation (and no other)',
    );
    const customerNow = await navigation('(9) navigation as CUSTOMER', 'CUSTOMER');
    assert(
      customerNow.sections.some((s) => s.code === 'PRIVACY_DATA'),
      '(9) CUSTOMER keeps the section',
    );
    const hidden = await call('GET', '/account/privacy', customer, { role: 'PROVIDER' });
    assert(
      hidden.status === 404 && hidden.json?.error?.code === 'ACCOUNT_SECTION_NOT_FOUND',
      `(9) the hidden section must be a 404 (${hidden.status} ${hidden.json?.error?.code})`,
    );
    assert(hidden.headers.get('cache-control') === 'no-store', '(9) the 404 must be no-store');
    assert(!/PRIVACY|PROVIDER|CUSTOMER/.test(hidden.text), '(9) the 404 must not name the section or the role');
    assert((await call('GET', '/account/privacy', customer, { role: 'CUSTOMER' })).status === 200, '(9) CUSTOMER can still read the privacy summary');
    assert(
      (await call('GET', '/account/consents/requirements', customer, { role: 'PROVIDER' })).status === 200,
      '(9) the consent domain endpoint is not gated by the menu',
    );
    // the web app follows the server: the menu loses the entry, and the URL is not served (the API answered 404 and the page ends in not-found)
    const providerWeb = await page('/account');
    assert(
      !menuOf(providerWeb.body).includes('/account/privacy') && menuOf(providerWeb.body).length === asProvider.sections.length - 1,
      '(9) the web menu must lose the hidden section',
    );
    assert(notServed(await page('/account/privacy')), '(9) /account/privacy must not be served to PROVIDER when the section is off');
    await database.query(
      `UPDATE identity.account_section_roles SET enabled = true
        WHERE section_code = 'PRIVACY_DATA' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
    );
    privacyOffForProvider = false;
    assert(
      (await navigation('(9) navigation as PROVIDER, restored', 'PROVIDER')).sections.length === asProvider.sections.length,
      '(9) the registry must be restored',
    );

    // (10) back to CUSTOMER: the same account and session, the original set
    assert((await switchTo('CUSTOMER', '/account')).status === 303, '(10) switching back through the web must succeed');
    assert(menuOf((await page('/account')).body).join(',') === expectedMenu(asCustomer.sections), '(10) the web menu must be the CUSTOMER set again');
    assert((await page('/account/privacy')).status === 200, '(10) /account/privacy is served again');
    const back = await navigation('(10) navigation as CUSTOMER again', 'CUSTOMER');
    assert(JSON.stringify(back.sections) === JSON.stringify(asCustomer.sections), '(10) switching back restores the CUSTOMER set');

    // (11) nothing private leaks: no token, session id, subject or full contact value in any account-area response
    const blob = seen.join('\n');
    for (const [what, value] of [
      ['access token', customer.split('.')[2]?.slice(0, 40)],
      ['Keycloak session id', principal.sessionId],
      ['Keycloak subject', principal.subject],
    ] as const)
      assert(!value || value.length < 8 || !blob.includes(value), `(11) ${what} appeared in an account area response`);
    return (
      `customer.dev: (2) CUSTOMER set = registry (${asCustomer.sections.map((s) => s.code).join(', ')}) with one URL each, labels resolved; (3) profile composed, PATCH by field ` +
      `(unchanged repeat writes nothing, unknown zone refused, no echo); (4) contacts equal /account/me; (5) security summary; (6) privacy summary agrees with the consents; ` +
      `(7) roles; (8) PROVIDER with the same token and session = registry for PROVIDER, ADMIN refused 403; (9) PRIVACY_DATA switched off for PROVIDER: gone from its set, ` +
      `404 ACCOUNT_SECTION_NOT_FOUND on its route, CUSTOMER and the consent endpoints unaffected, restored; (10) back to CUSTOMER; (11) no token, session id or subject in any response`
    );
  } finally {
    if (privacyOffForProvider)
      await database
        .query(
          `UPDATE identity.account_section_roles SET enabled = true
            WHERE section_code = 'PRIVACY_DATA' AND role_id = (SELECT role_id FROM identity.roles WHERE code = 'PROVIDER')`,
        )
        // never silent: the next run heals it, but whoever reads this run must know the registry was left switched off
        .catch((err: unknown) =>
          console.error(
            `Account area: COULD NOT RESTORE PRIVACY_DATA for PROVIDER (${err instanceof Error ? err.message : String(err)}); the next run restores it`,
          ),
        );
    await database.close();
  }
});

await check('Catalog', async () => {
  // The platform-owned catalogue taxonomy (CAT-001) end to end with a REAL Keycloak admin token (admin.dev holds catalog-write), real HTTP, the content registry and the
  // database (read-only SELECTs on the audit trail and the outbox). The SEEDED taxonomy (home_cleaning, auto_services and their service types, all DRAFT) is only read: the
  // activation flow runs on DEV/TEST codes (devtest_*) in a DEV/TEST market (ZZ), and everything it creates is left RETIRED or INACTIVE (entities are never deleted).
  // The seeded market la-oc is NEVER activated here: its status is owner data and the proof adapts (PLANNED: nothing public).
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  type Reply = { status: number; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (
    module: 'catalog' | 'geography' | 'content' | 'configuration',
    token: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const r = await get(`${api}/api/v1/${module}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { status: r.status, json, headers: r.headers };
  };
  const expectStatus = (r: Reply, statuses: number[], what: string): Reply => {
    assert(statuses.includes(r.status), `${what} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };
  const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
  const admin = (
    await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-admin',
      redirectUri: ADMIN_REDIRECT_URI,
      code: login.code,
      codeVerifier: login.verifier,
    })
  ).accessToken;
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const marketCode = `devtest-cat-${runId}`;
  const categoryCode = `devtest_cat_${runId}`;
  const stA = `devtest_st_${runId}_a`;
  const stB = `devtest_st_${runId}_b`;

  // (1) the SEEDED taxonomy is management data: DRAFT, resolved text, and the public view cannot see it
  const seeded = expectStatus(await call('catalog', admin, 'GET', '/categories'), [200], '(1) management category list').json.data as {
    code: string;
    status: string;
    name: string;
    description: string | null;
    nameContentKey: string;
  }[];
  for (const [code, name] of [
    ['home_cleaning', 'Home Cleaning'],
    ['auto_services', 'Auto Services'],
  ] as const) {
    const c = seeded.find((x) => x.code === code);
    assert(
      c !== undefined && c.name === name && c.nameContentKey === `catalog.category.${code}.name` && c.description !== null,
      `(1) seeded category ${code} missing or wrong (${JSON.stringify(c)})`,
    );
  }
  const seededTypes = expectStatus(await call('catalog', admin, 'GET', '/service-types'), [200], '(1) management service type list').json.data as {
    code: string;
    categoryCode: string;
    name: string;
  }[];
  for (const [code, category, name] of [
    ['regular_cleaning', 'home_cleaning', 'Regular Cleaning'],
    ['deep_cleaning', 'home_cleaning', 'Deep Cleaning'],
    ['car_detailing', 'auto_services', 'Car Detailing'],
    ['mobile_car_wash', 'auto_services', 'Mobile Car Wash'],
  ] as const) {
    const t = seededTypes.find((x) => x.code === code);
    assert(t !== undefined && t.categoryCode === category && t.name === name, `(1) seeded service type ${code} missing or wrong (${JSON.stringify(t)})`);
  }
  const one = expectStatus(await call('catalog', admin, 'GET', '/service-types/deep_cleaning'), [200], '(1) one seeded service type').json.data;
  assert(one.name === 'Deep Cleaning' && one.categoryCode === 'home_cleaning', '(1) the seeded service type resolves its name and category');
  const noMarket = expectStatus(await call('catalog', null, 'GET', '/categories'), [400], '(1) the public view needs a market');
  assert(noMarket.json.error?.details?.reason === 'MARKET_REQUIRED', '(1) the missing market must be named MARKET_REQUIRED');
  const anonMgmt = await call('catalog', null, 'POST', '/categories', { code: 'x_y', reason: 'nope' });
  assert(anonMgmt.status === 401, `(1) a mutation without a token must be 401 (${anonMgmt.status})`);
  const anonProhibited = await call('catalog', null, 'GET', '/prohibited-services');
  assert(anonProhibited.status === 401, `(1) the prohibited-service list is never public (${anonProhibited.status})`);

  // (2) the seeded market la-oc: nothing of the catalogue is public through a market that is not public (la-oc is PLANNED unless its owner launched it)
  const laoc = (await call('geography', admin, 'GET', '/markets/la-oc')).json.data as { status: string };
  const laocPublic = (await call('geography', null, 'GET', '/markets/la-oc')).status === 200;
  const laocList = await call('catalog', null, 'GET', '/categories?market=la-oc');
  if (laocPublic) {
    assert(
      laocList.status === 200 && !(laocList.json.data as { code: string }[]).some((c) => ['home_cleaning', 'auto_services'].includes(c.code)),
      '(2) a public la-oc must not list DRAFT seeded categories',
    );
  } else {
    assert(
      laocList.status === 404 && laocList.json.error?.code === 'CATALOG_MARKET_NOT_FOUND',
      `(2) la-oc (${laoc.status}) is not public: the catalogue must answer 404 CATALOG_MARKET_NOT_FOUND (${laocList.status})`,
    );
    assert((await call('catalog', null, 'GET', '/service-types?market=la-oc')).status === 404, '(2) service types of a non-public market are 404 too');
  }
  assert((await call('catalog', null, 'GET', '/categories?market=no-such-market')).status === 404, '(2) an unknown market is 404');

  // (3) a DEV/TEST market: preparing availability while PLANNED exposes nothing
  await ensureDevtestGeography(admin);
  expectStatus(
    await call('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST catalog smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    }),
    [201],
    '(3) create the test market',
  );

  // the managed copy of the test category and service types (the name entries must exist first: the key is derived from the code)
  const publish = async (key: string, texts: Record<string, string>): Promise<void> => {
    expectStatus(
      await call('content', admin, 'POST', '/entries', {
        key,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY catalogue smoke entry',
        approvalPolicy: 'NONE',
      }),
      [201],
      `(3) entry ${key}`,
    );
    for (const [locale, body] of Object.entries(texts)) {
      const v = expectStatus(
        await call('content', admin, 'POST', `/entries/${key}/versions`, { locale, body, reason: 'smoke test' }),
        [201],
        `(3) version ${key} ${locale}`,
      ).json.data;
      expectStatus(await call('content', admin, 'POST', `/versions/${v.versionId}/submit`, {}), [200, 201], `(3) submit ${key}`);
      assert(
        expectStatus(await call('content', admin, 'POST', `/versions/${v.versionId}/publish`, {}), [200, 201], `(3) publish ${key}`).json.data.status ===
          'PUBLISHED',
        `(3) ${key} ${locale} must be PUBLISHED`,
      );
    }
  };
  const names = { cat: `Smoke Category ${runId}`, catQaa: `qaa Smoke Category ${runId}`, a: `Smoke Service A ${runId}`, b: `Smoke Service B ${runId}` };
  await publish(`catalog.category.${categoryCode}.name`, { 'en-US': names.cat, qaa: names.catQaa });
  await publish(`catalog.category.${categoryCode}.description`, { 'en-US': `Description of ${categoryCode}` });
  await publish(`catalog.service_type.${stA}.name`, { 'en-US': names.a });
  await publish(`catalog.service_type.${stB}.name`, { 'en-US': names.b });

  // a name without content is refused with a precise reason (nothing is created)
  const noCopy = expectStatus(
    await call('catalog', admin, 'POST', '/categories', { code: `devtest_nocopy_${runId}`, reason: 'smoke' }),
    [400],
    '(3) a category without its name content',
  );
  assert(noCopy.json.error?.details?.reason === 'NAME_CONTENT_MISSING', '(3) the missing name entry must be named NAME_CONTENT_MISSING');
  const created = expectStatus(
    await call('catalog', admin, 'POST', '/categories', {
      code: categoryCode,
      iconKey: 'wrench',
      withDescription: true,
      reason: 'DEV/TEST ONLY smoke category',
    }),
    [201],
    '(3) create the category',
  ).json.data;
  assert(
    created.status === 'DRAFT' && created.code === categoryCode && created.name === names.cat && /^[0-9a-f-]{36}$/.test(created.categoryId),
    `(3) the new category is DRAFT with its resolved name (${JSON.stringify(created)})`,
  );
  const categoryId = created.categoryId as string;
  expectStatus(await call('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'duplicate' }), [409], '(3) a duplicate code');
  const typeA = expectStatus(
    await call('catalog', admin, 'POST', '/service-types', { code: stA, categoryCode, reason: 'DEV/TEST ONLY smoke service type' }),
    [201],
    '(3) create service type A',
  ).json.data;
  const typeB = expectStatus(
    await call('catalog', admin, 'POST', '/service-types', { code: stB, categoryCode, reason: 'DEV/TEST ONLY smoke service type' }),
    [201],
    '(3) create service type B',
  ).json.data;
  assert(typeA.status === 'DRAFT' && typeB.status === 'DRAFT' && typeA.categoryCode === categoryCode, '(3) a service type is created DRAFT under its category');
  // hierarchy rules through the API: nothing is ACTIVE under a DRAFT category
  const early = expectStatus(
    await call('catalog', admin, 'PUT', `/service-types/${stA}/status`, { status: 'ACTIVE', reason: 'too early' }),
    [409],
    '(3) a service type under a DRAFT category',
  );
  assert(early.json.error?.details?.reason === 'CATEGORY_NOT_ACTIVE', '(3) CATEGORY_NOT_ACTIVE expected');
  // prepare the availability in the PLANNED market (allowed), then check the public view says nothing
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, {
      enabled: true,
      displayOrder: 10,
      reason: 'prepare before launch',
    }),
    [200],
    '(3) prepare the category in the PLANNED market',
  );
  assert(
    (await call('catalog', null, 'GET', `/categories?market=${marketCode}`)).status === 404,
    '(3) a PLANNED market exposes no catalogue, even with prepared rows',
  );

  // (4) launch: market ACTIVE, category ACTIVE, service types: A visible, B hidden (still DRAFT although enabled)
  expectStatus(
    await call('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' }),
    [200],
    '(4) activate the test market',
  );
  assert(
    (await call('catalog', null, 'GET', `/categories?market=${marketCode}`)).json.data.length === 0,
    '(4) an ACTIVE market with a DRAFT category lists nothing',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' }),
    [200],
    '(4) activate the category',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/service-types/${stA}/status`, { status: 'ACTIVE', reason: 'launch' }),
    [200],
    '(4) activate service type A',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${stB}`, { enabled: true, displayOrder: 20, reason: 'prepare' }),
    [200],
    '(4) enable B (still DRAFT)',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${stA}`, { enabled: true, displayOrder: 10, reason: 'launch' }),
    [200],
    '(4) enable A',
  );
  const dupOrder = expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${stA}`, { enabled: true, displayOrder: 20, reason: 'clash' }),
    [409],
    '(4) a display order already used in the market',
  );
  assert(dupOrder.json.error?.details?.reason === 'DISPLAY_ORDER_TAKEN', '(4) DISPLAY_ORDER_TAKEN expected');
  const publicCategories = expectStatus(await call('catalog', null, 'GET', `/categories?market=${marketCode}&locale=en-US`), [200], '(4) public categories')
    .json.data as Record<string, unknown>[];
  assert(
    publicCategories.length === 1 &&
      publicCategories[0]!.code === categoryCode &&
      publicCategories[0]!.name === names.cat &&
      publicCategories[0]!.displayOrder === 10,
    `(4) the public view lists exactly the launched category (${JSON.stringify(publicCategories)})`,
  );
  assert(
    Object.keys(publicCategories[0]!).sort().join() === 'categoryId,code,description,displayOrder,iconKey,name',
    `(4) the public category has public fields only (${Object.keys(publicCategories[0]!).join()})`,
  );
  const publicTypes = expectStatus(await call('catalog', null, 'GET', `/service-types?market=${marketCode}&locale=en-US`), [200], '(4) public service types')
    .json.data as Record<string, unknown>[];
  assert(
    publicTypes.length === 1 && publicTypes[0]!.code === stA && publicTypes[0]!.name === names.a && publicTypes[0]!.categoryCode === categoryCode,
    `(4) only the ACTIVE service type A is public (${JSON.stringify(publicTypes)})`,
  );
  assert(
    (await call('catalog', null, 'GET', `/service-types/${stB}?market=${marketCode}`)).status === 404,
    '(4) the DRAFT service type B is not public even though it is enabled',
  );
  assert(
    (await call('catalog', null, 'GET', `/categories?market=${marketCode}&locale=qaa`)).json.data[0].name === names.catQaa,
    '(4) the requested locale is honoured',
  );
  assert(
    (await call('catalog', null, 'GET', `/categories?market=${marketCode}`)).json.data[0].name === names.catQaa,
    '(4) without a locale the default locale of the market (qaa) is used',
  );
  const filtered = (await call('catalog', null, 'GET', `/service-types?market=${marketCode}&category=home_cleaning`)).json.data as unknown[];
  assert(filtered.length === 0, '(4) the category filter applies');
  const mgmtMarket = expectStatus(
    await call('catalog', admin, 'GET', `/service-types?market=${marketCode}`),
    [200],
    '(4) management service types in the market',
  ).json.data as { code: string; status: string; enabled: boolean }[];
  assert(
    mgmtMarket.some((t) => t.code === stB && t.status === 'DRAFT' && t.enabled === true),
    '(4) the management view shows B as a DRAFT enabled row',
  );

  // (5) inactive items are hidden and come back; the hierarchy refuses unsafe moves
  expectStatus(await call('catalog', admin, 'PUT', `/service-types/${stA}/status`, { status: 'INACTIVE', reason: 'pause' }), [200], '(5) pause A');
  assert((await call('catalog', null, 'GET', `/service-types?market=${marketCode}`)).json.data.length === 0, '(5) an INACTIVE service type disappears');
  expectStatus(await call('catalog', admin, 'PUT', `/service-types/${stA}/status`, { status: 'ACTIVE', reason: 'resume' }), [200], '(5) resume A');
  const refused = expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'INACTIVE', reason: 'unsafe' }),
    [409],
    '(5) pause a category with an ACTIVE service type',
  );
  assert(refused.json.error?.details?.reason === 'CATEGORY_HAS_ACTIVE_SERVICE_TYPES', '(5) CATEGORY_HAS_ACTIVE_SERVICE_TYPES expected');
  const sameStatus = expectStatus(
    await call('catalog', admin, 'PUT', `/service-types/${stA}/status`, { status: 'ACTIVE', reason: 'again' }),
    [200],
    '(5) idempotent status',
  );
  assert(sameStatus.json.data.status === 'ACTIVE', '(5) a repeated status is accepted');

  // (6) rename = a content change: the identity, the order and the availability do not move
  const nameKey = `catalog.category.${categoryCode}.name`;
  const renamed = `Renamed ${names.cat}`;
  const v2 = expectStatus(
    await call('content', admin, 'POST', `/entries/${nameKey}/versions`, { locale: 'en-US', body: renamed, reason: 'smoke rename' }),
    [201],
    '(6) draft the new name',
  ).json.data;
  expectStatus(await call('content', admin, 'POST', `/versions/${v2.versionId}/submit`, {}), [200, 201], '(6) submit the new name');
  expectStatus(await call('content', admin, 'POST', `/versions/${v2.versionId}/publish`, {}), [200, 201], '(6) publish the new name');
  let after: Record<string, unknown> | undefined;
  for (let n = 0; n < 40 && after?.name !== renamed; n++) {
    after = (await call('catalog', null, 'GET', `/categories/${categoryCode}?market=${marketCode}&locale=en-US`)).json.data;
    if (after?.name !== renamed) await sleep(250);
  }
  assert(after?.name === renamed, `(6) the public category must show the new name (got ${String(after?.name)})`);
  assert(
    after?.categoryId === categoryId && after?.code === categoryCode && after?.displayOrder === 10,
    '(6) a rename must not change the id, the code or the order',
  );
  const typeAfter = (await call('catalog', null, 'GET', `/service-types/${stA}?market=${marketCode}`)).json.data;
  assert(typeAfter.serviceTypeId === typeA.serviceTypeId && typeAfter.code === stA, '(6) the service type identity is unchanged');

  // (7) switching a category off in the market also switches off its service types; the CATEGORY configuration scope is validated by the catalogue
  const off = expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: false, reason: 'withdraw' }),
    [200],
    '(7) withdraw the category',
  ).json.data;
  assert(
    JSON.stringify(off.alsoDisabled.sort()) === JSON.stringify([stA, stB].sort()),
    `(7) the service types of the category are switched off with it (${JSON.stringify(off.alsoDisabled)})`,
  );
  assert((await call('catalog', null, 'GET', `/categories?market=${marketCode}`)).json.data.length === 0, '(7) nothing is public after the withdrawal');
  const paramKey = 'devtest.smoke.catalog_window_hours';
  await call('configuration', admin, 'POST', '/parameters', {
    key: paramKey,
    dataType: 'INTEGER',
    description: 'DEV/TEST ONLY catalogue smoke parameter',
    ownerRole: 'platform',
    approvalPolicy: 'SECOND_APPROVER',
    validationRules: { min: 1, max: 1000 },
    allowedOverrideScopes: ['CATEGORY'],
  });
  const goodScope = await call('configuration', admin, 'POST', '/change-requests', {
    parameterKey: paramKey,
    scopeType: 'CATEGORY',
    scopeRef: 'home_cleaning',
    value: 10 + (Date.now() % 500),
    reason: 'smoke test',
  });
  assert(
    [200, 201].includes(goodScope.status),
    `(7) a real category is a valid CATEGORY scope reference (${goodScope.status} ${JSON.stringify(goodScope.json?.error)})`,
  );
  const badScope = await call('configuration', admin, 'POST', '/change-requests', {
    parameterKey: paramKey,
    scopeType: 'CATEGORY',
    scopeRef: 'no_such_category',
    value: 12,
    reason: 'smoke test',
  });
  assert(
    badScope.status === 400 && badScope.json?.error?.details?.reason === 'SCOPE_REFERENCE_INVALID',
    `(7) an unknown category must be refused as a scope reference (${badScope.status} ${JSON.stringify(badScope.json?.error)})`,
  );

  // (8) retirement keeps the record and the code; the audit trail and the outbox hold every change
  for (const code of [stA, stB])
    expectStatus(
      await call('catalog', admin, 'PUT', `/service-types/${code}/status`, { status: 'RETIRED', reason: 'smoke cleanup' }),
      [200],
      `(8) retire ${code}`,
    );
  const retired = expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'RETIRED', reason: 'smoke cleanup' }),
    [200],
    '(8) retire the category',
  ).json.data;
  assert(retired.status === 'RETIRED' && retired.categoryId === categoryId, '(8) a retired category keeps its row and id');
  expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'back' }),
    [409],
    '(8) RETIRED is terminal',
  );
  expectStatus(await call('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'reuse' }), [409], '(8) a retired code is never reused');
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: true, reason: 'late' }),
    [409],
    '(8) a retired category is never enabled again',
  );
  const databaseUrl = env('DATABASE_URL', '');
  assert(databaseUrl !== '', 'DATABASE_URL is not set in the smoke environment');
  const database = createDatabase(databaseUrl, { role: 'tests' });
  try {
    const audit = await database.query<{ action: string; n: number }>(
      `SELECT a.action, count(*)::int AS n FROM catalog.audit_events a
        LEFT JOIN catalog.categories c ON c.category_id = a.category_id LEFT JOIN catalog.service_types st ON st.service_type_id = a.service_type_id
       WHERE c.code = $1 OR st.code = ANY($2::text[]) GROUP BY a.action ORDER BY a.action`,
      [categoryCode, [stA, stB]],
    );
    const byAction = Object.fromEntries(audit.map((r) => [r.action, r.n]));
    assert(
      byAction.CATEGORY_CREATED === 1 &&
        byAction.CATEGORY_STATUS_CHANGED === 2 &&
        byAction.SERVICE_TYPE_CREATED === 2 &&
        (byAction.SERVICE_TYPE_STATUS_CHANGED ?? 0) >= 5 &&
        (byAction.MARKET_CATALOG_AVAILABILITY_CHANGED ?? 0) >= 5,
      `(8) the audit trail must hold every mutation (${JSON.stringify(byAction)})`,
    );
    const events = await database.query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.%' AND payload_json::text LIKE '%' || $1 || '%' GROUP BY event_type`,
      [runId],
    );
    const ev = Object.fromEntries(events.map((r) => [r.event_type, r.n]));
    assert(
      (ev['bananagig.catalog.category-activated.v1'] ?? 0) === 1 &&
        (ev['bananagig.catalog.service-type-activated.v1'] ?? 0) >= 2 &&
        (ev['bananagig.catalog.availability-changed.v1'] ?? 0) >= 5,
      `(8) the outbox must hold the activation and availability events (${JSON.stringify(ev)})`,
    );
    const seededUntouched = await database.query<{ code: string; status: string }>(
      `SELECT code, status FROM catalog.categories WHERE code IN ('home_cleaning', 'auto_services') ORDER BY code`,
    );
    assert(
      seededUntouched.every((c) => c.status === 'DRAFT'),
      '(8) the smoke must leave the seeded taxonomy as it found it (DRAFT)',
    );
  } finally {
    await database.close();
  }

  // (9) cleanup of the DEV/TEST market (the retired test taxonomy stays, entities are never deleted)
  expectStatus(
    await call('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: false, reason: 'smoke cleanup' }),
    [200],
    '(9) deactivate the test market',
  );
  assert((await call('catalog', null, 'GET', `/categories?market=${marketCode}`)).status === 404, '(9) a deactivated market exposes no catalogue');
  return (
    `seeded taxonomy DRAFT with resolved names (2 categories, 4 service types); la-oc ${laoc.status} ${laocPublic ? '(public: nothing seeded listed)' : '=> 404 CATALOG_MARKET_NOT_FOUND'}; ${marketCode}: PLANNED with prepared rows => 404, ACTIVE => only the ACTIVE category and service type ` +
    `(DRAFT B hidden although enabled), locale and market default honoured, public fields only; INACTIVE hidden and restored; rename kept id/code/order; withdrawal cascaded to ${off.alsoDisabled.length} service types; ` +
    `CATEGORY scope validated; retirement terminal with the code reserved; audit and outbox complete; seeded rows untouched`
  );
});

await check('Gig templates', async () => {
  // The platform-owned Gig Templates (CAT-002) end to end with a REAL Keycloak admin token (admin.dev holds catalog-write), real HTTP, the content registry and the database
  // (read-only SELECTs on the audit trail and the outbox). Everything runs on DEV/TEST codes (devtest_*) in a DEV/TEST market (ZZ) with its own category and service type, and is
  // left RETIRED or INACTIVE (entities are never deleted). The SEEDED templates (full_detail, standard_clean: DRAFT, no versions) are only read. The seeded market la-oc is NEVER
  // activated here: its status is owner data and the proof adapts (PLANNED: nothing public).
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  type Reply = { status: number; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (
    module: 'catalog' | 'geography' | 'content',
    token: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const r = await get(`${api}/api/v1/${module}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { status: r.status, json, headers: r.headers };
  };
  const expectStatus = (r: Reply, statuses: number[], what: string): Reply => {
    assert(statuses.includes(r.status), `${what} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };
  const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
  const admin = (
    await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-admin',
      redirectUri: ADMIN_REDIRECT_URI,
      code: login.code,
      codeVerifier: login.verifier,
    })
  ).accessToken;
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const marketCode = `devtest-gt-${runId}`;
  const categoryCode = `devtest_gtc_${runId}`;
  const serviceType = `devtest_gts_${runId}`;
  const tpl = `devtest_gt_${runId}`;
  const key = (suffix: string): string => `catalog.gig_template.${tpl}.${suffix}`;
  const publishCopy = async (k: string, text: string, opts: { publish?: boolean } = {}): Promise<string> => {
    expectStatus(
      await call('content', admin, 'POST', '/entries', {
        key: k,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY gig template smoke entry',
        approvalPolicy: 'NONE',
      }),
      [201],
      `entry ${k}`,
    );
    const v = expectStatus(
      await call('content', admin, 'POST', `/entries/${k}/versions`, { locale: 'en-US', body: text, reason: 'smoke test' }),
      [201],
      `version ${k}`,
    ).json.data;
    if (opts.publish === false) return v.versionId as string; // the entry exists, its text is only a draft: not published
    expectStatus(await call('content', admin, 'POST', `/versions/${v.versionId}/submit`, {}), [200, 201], `submit ${k}`);
    assert(
      expectStatus(await call('content', admin, 'POST', `/versions/${v.versionId}/publish`, {}), [200, 201], `publish ${k}`).json.data.status === 'PUBLISHED',
      `${k} must be PUBLISHED`,
    );
    return v.versionId as string;
  };

  // (1) the SEEDED templates are management data: DRAFT without versions, resolved text, never public
  const seeded = expectStatus(await call('catalog', admin, 'GET', '/gig-templates'), [200], '(1) management template list').json.data as {
    code: string;
    status: string;
    serviceTypeCode: string;
    name: string;
    activeVersion: unknown;
    nameContentKey: string;
  }[];
  for (const [code, serviceTypeCode, name] of [
    ['full_detail', 'car_detailing', 'Full Detail'],
    ['standard_clean', 'regular_cleaning', 'Standard Clean'],
  ] as const) {
    const t = seeded.find((x) => x.code === code);
    assert(
      t !== undefined &&
        t.status === 'DRAFT' &&
        t.serviceTypeCode === serviceTypeCode &&
        t.name === name &&
        t.activeVersion === null &&
        t.nameContentKey === key('name').replace(tpl, code),
      `(1) seeded template ${code} missing or wrong (${JSON.stringify(t)})`,
    );
  }
  const noMarket = expectStatus(await call('catalog', null, 'GET', '/gig-templates'), [400], '(1) the public view needs a market');
  assert(noMarket.json.error?.details?.reason === 'MARKET_REQUIRED', '(1) the missing market must be named MARKET_REQUIRED');
  assert(
    (await call('catalog', null, 'POST', '/gig-templates', { code: 'x_y', serviceTypeCode: 'car_detailing', reason: 'nope' })).status === 401,
    '(1) a mutation without a token is 401',
  );
  assert((await call('catalog', null, 'GET', '/gig-templates/full_detail/versions/1')).status === 401, '(1) a version read without a token is 401');
  const laoc = (await call('geography', admin, 'GET', '/markets/la-oc')).json.data as { status: string };
  const laocPublic = (await call('geography', null, 'GET', '/markets/la-oc')).status === 200;
  const laocList = await call('catalog', null, 'GET', '/gig-templates?market=la-oc');
  if (laocPublic)
    assert(
      laocList.status === 200 && !(laocList.json.data as { code: string }[]).some((t) => ['full_detail', 'standard_clean'].includes(t.code)),
      '(1) a public la-oc must not list DRAFT seeded templates',
    );
  else
    assert(
      laocList.status === 404 && laocList.json.error?.code === 'CATALOG_MARKET_NOT_FOUND',
      `(1) la-oc (${laoc.status}) is not public: 404 CATALOG_MARKET_NOT_FOUND (${laocList.status})`,
    );

  // (2) a DEV/TEST market, category and service type, launched; the template copy
  await ensureDevtestGeography(admin);
  expectStatus(
    await call('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST gig template smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    }),
    [201],
    '(2) create the test market',
  );
  await publishCopy(`catalog.category.${categoryCode}.name`, `Smoke GT Category ${runId}`);
  await publishCopy(`catalog.service_type.${serviceType}.name`, `Smoke GT Service ${runId}`);
  expectStatus(await call('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'DEV/TEST ONLY' }), [201], '(2) create the category');
  expectStatus(
    await call('catalog', admin, 'POST', '/service-types', { code: serviceType, categoryCode, reason: 'DEV/TEST ONLY' }),
    [201],
    '(2) create the service type',
  );
  // a template needs an ACTIVE service type: nothing can be activated under a DRAFT one
  await publishCopy(key('name'), `Smoke Template ${runId}`);
  const created = expectStatus(
    await call('catalog', admin, 'POST', '/gig-templates', {
      code: tpl,
      serviceTypeCode: serviceType,
      withDescription: false,
      withInstructions: false,
      reason: 'DEV/TEST ONLY smoke template',
    }),
    [201],
    '(2) create the template',
  ).json.data;
  assert(
    created.status === 'DRAFT' && created.code === tpl && created.name === `Smoke Template ${runId}` && created.activeVersion === null,
    `(2) the new template is DRAFT with its resolved name (${JSON.stringify(created)})`,
  );
  const early = expectStatus(
    await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'too early' }),
    [409],
    '(2) a template under a DRAFT service type',
  );
  assert(early.json.error?.details?.reason === 'SERVICE_TYPE_NOT_ACTIVE', '(2) SERVICE_TYPE_NOT_ACTIVE expected');
  expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' }),
    [200],
    '(2) activate the category',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/service-types/${serviceType}/status`, { status: 'ACTIVE', reason: 'launch' }),
    [200],
    '(2) activate the service type',
  );
  expectStatus(await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'launch' }), [200], '(2) activate the template');

  // (3) the first draft: the copy of every field must exist before the draft can name it; fields: a fixed text, an enum, required media, a duration
  await publishCopy(key('field.inclusions.label'), 'What is included');
  await publishCopy(key('field.inclusions.default'), 'Exterior wash, interior vacuum, windows.');
  await publishCopy(key('field.finish.label'), 'Finish');
  await publishCopy(key('field.finish.option.wax.label'), 'Wax');
  await publishCopy(key('field.finish.option.sealant.label'), 'Sealant');
  await publishCopy(key('field.photos.label'), 'Work photos');
  await publishCopy(key('field.photos.help'), 'Show the finished work.');
  const pendingText = await publishCopy(key('field.extra_time.label'), 'Extra time', { publish: false }); // the entry exists but its text is only a draft
  const draft = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'DEV/TEST ONLY first draft' }),
    [201],
    '(3) create the draft',
  ).json.data;
  assert(
    draft.versionNumber === 1 && draft.status === 'DRAFT' && draft.revision === 1 && draft.fields.length === 0,
    `(3) the first draft is empty at revision 1 (${JSON.stringify(draft)})`,
  );
  const dup = expectStatus(await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'second draft' }), [409], '(3) a second draft');
  assert(dup.json.error?.details?.reason === 'DRAFT_EXISTS', '(3) DRAFT_EXISTS expected');
  const definition = {
    expectedRevision: 1,
    duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
    pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
    areaModes: ['RADIUS', 'POLYGON'],
    fields: [
      { fieldKey: 'inclusions', fieldType: 'LONG_TEXT', section: 'INCLUSIONS', behavior: 'PLATFORM_FIXED', withDefaultText: true },
      { fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }] },
      { fieldKey: 'photos', fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 2, maxItems: 10, withHelp: true },
      { fieldKey: 'extra_time', fieldType: 'DURATION', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 15, maxNumber: 120 },
    ],
    requirements: [{ requirementType: 'EQUIPMENT', referenceCode: 'polisher' }, { requirementType: 'INSURANCE' }],
    reason: 'DEV/TEST ONLY fields',
  };
  const filled = expectStatus(await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, definition), [200], '(3) replace the draft').json.data;
  assert(
    filled.revision === 2 && filled.fields.length === 4 && filled.requirements.length === 2,
    `(3) the draft holds the definition at revision 2 (${JSON.stringify({ r: filled.revision, f: filled.fields.length })})`,
  );
  assert(
    filled.fields.map((f: { fieldKey: string }) => f.fieldKey).join() === 'inclusions,finish,photos,extra_time' && filled.fields[2].mediaRule === 'REQUIRED',
    '(3) the fields keep their order and the media rule is derived',
  );
  const stale = expectStatus(await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, definition), [409], '(3) a stale revision');
  assert(stale.json.error?.details?.reason === 'STALE_DRAFT', '(3) STALE_DRAFT expected');
  const missingCopy = expectStatus(
    await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, {
      ...definition,
      expectedRevision: 2,
      fields: [...definition.fields, { fieldKey: 'never_written', fieldType: 'TEXT', behavior: 'PROVIDER_CONFIGURABLE' }],
    }),
    [400],
    '(3) a field whose copy does not exist',
  );
  assert(
    missingCopy.json.error?.details?.reason === 'CONTENT_ENTRY_MISSING' &&
      missingCopy.json.error?.details?.contentKeys?.[0] === key('field.never_written.label'),
    `(3) the missing entry is named (${JSON.stringify(missingCopy.json.error?.details)})`,
  );

  // (4) publication: refused while the copy of a field is only a draft (and the missing key is named), then published and frozen
  const blocked = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'too early' }),
    [409],
    '(4) publish with unpublished copy',
  );
  assert(
    blocked.json.error?.details?.reason === 'CONTENT_NOT_PUBLISHED' && blocked.json.error?.details?.contentKeys?.join() === key('field.extra_time.label'),
    `(4) the unpublished key is named (${JSON.stringify(blocked.json.error?.details)})`,
  );
  expectStatus(await call('content', admin, 'POST', `/versions/${pendingText}/submit`, {}), [200, 201], '(4) submit the text');
  expectStatus(await call('content', admin, 'POST', `/versions/${pendingText}/publish`, {}), [200, 201], '(4) publish the text');
  const v1 = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish' }),
    [200],
    '(4) publish v1',
  ).json.data;
  assert(
    v1.status === 'ACTIVE' && v1.publishedAt !== null && v1.closedAt === null && v1.revision === 2,
    `(4) v1 is ACTIVE and frozen (${JSON.stringify({ s: v1.status, r: v1.revision })})`,
  );
  const again = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'repeat' }),
    [200],
    '(4) a repeated publication',
  );
  assert(again.json.data.publishedAt === v1.publishedAt, '(4) a repeated publication changes nothing');
  const frozen = expectStatus(
    await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, { ...definition, expectedRevision: 2 }),
    [409],
    '(4) editing a published version',
  );
  assert(frozen.json.error?.details?.reason === 'VERSION_NOT_DRAFT', '(4) VERSION_NOT_DRAFT expected');
  const v1Frozen = JSON.stringify((await call('catalog', admin, 'GET', `/gig-templates/${tpl}/versions/1`)).json.data);

  // (5) not public until the market is launched and the template is offered there
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: true, displayOrder: 10, reason: 'prepare' }),
    [200],
    '(5) prepare the category',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${serviceType}`, { enabled: true, displayOrder: 10, reason: 'prepare' }),
    [200],
    '(5) prepare the service type',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: true, displayOrder: 10, reason: 'prepare' }),
    [200],
    '(5) prepare the template',
  );
  assert(
    (await call('catalog', null, 'GET', `/gig-templates?market=${marketCode}`)).status === 404,
    '(5) a PLANNED market exposes no template, even with prepared rows',
  );
  expectStatus(
    await call('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' }),
    [200],
    '(5) activate the test market',
  );

  // (6) the public view: exactly the safe structure of v1, resolved text, nothing of the management view
  const list = expectStatus(await call('catalog', null, 'GET', `/gig-templates?market=${marketCode}&locale=en-US`), [200], '(6) public list').json
    .data as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert(
    list.length === 1 && list[0]!.code === tpl && list[0]!.name === `Smoke Template ${runId}` && list[0]!.activeVersion.versionNumber === 1,
    `(6) the public list holds the launched template (${JSON.stringify(list)})`,
  );
  assert(
    Object.keys(list[0]!).sort().join() === 'activeVersion,categoryCode,code,description,displayOrder,gigTemplateId,name,serviceTypeCode',
    `(6) the public list item has public fields only (${Object.keys(list[0]!).join()})`,
  );
  const detail = expectStatus(await call('catalog', null, 'GET', `/gig-templates/${tpl}?market=${marketCode}&locale=en-US`), [200], '(6) public detail').json
    .data;
  const fields = detail.activeVersion.fields as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert(
    fields.map((f) => f.label).join('|') === 'What is included|Finish|Work photos|Extra time' &&
      fields[0]!.defaultText === 'Exterior wash, interior vacuum, windows.' &&
      fields[1]!.options.map((o: { label: string }) => o.label).join() === 'Wax,Sealant' &&
      fields[1]!.options[0].isDefault === true &&
      fields[2]!.help === 'Show the finished work.' &&
      fields[2]!.mediaRule === 'REQUIRED' &&
      fields[3]!.minNumber === 15 &&
      fields[3]!.maxNumber === 120,
    `(6) the fields resolve their copy and keep their metadata (${JSON.stringify(fields.map((f) => f.label))})`,
  );
  assert(
    detail.activeVersion.pricingModels.join() === 'FIXED,DROP_ELIGIBLE' &&
      detail.activeVersion.areaModes.join() === 'RADIUS,POLYGON' &&
      detail.activeVersion.duration.suggestedMinutes === 120 &&
      detail.activeVersion.requirements.length === 2,
    '(6) pricing models, area modes, duration guidance and requirement hooks are served',
  );
  assert(
    !('status' in detail) &&
      !('enabled' in detail) &&
      !('versions' in detail) &&
      !('nameContentKey' in detail) &&
      !('revision' in detail.activeVersion) &&
      !('labelContentKey' in fields[0]!),
    '(6) the public detail carries no management field',
  );
  const byType = expectStatus(
    await call('catalog', null, 'GET', `/service-types/${serviceType}/gig-templates?market=${marketCode}&locale=en-US`),
    [200],
    '(6) templates of the service type',
  ).json.data as unknown[];
  assert(byType.length === 1, '(6) the service type lists its template');
  assert(
    (await call('catalog', null, 'GET', `/service-types/car_detailing/gig-templates?market=${marketCode}`)).status === 404,
    '(6) a service type that is not public in the market is 404',
  );

  // (7) the next version: a copy of v1 with one more field and a changed duration; v1 is superseded, not changed
  await publishCopy(key('field.bring_water.label'), 'Bring your own water');
  const d2 = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { copyFromVersion: 1, reason: 'DEV/TEST ONLY second draft' }),
    [201],
    '(7) create draft 2',
  ).json.data;
  assert(
    d2.versionNumber === 2 && d2.status === 'DRAFT' && d2.fields.length === 4,
    `(7) draft 2 starts from the structure of v1 (${JSON.stringify({ n: d2.versionNumber, f: d2.fields.length })})`,
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/2`, {
      ...definition,
      expectedRevision: 1,
      duration: { minMinutes: 90, maxMinutes: 300, suggestedMinutes: 150 },
      fields: [...definition.fields, { fieldKey: 'bring_water', fieldType: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE', defaultBoolean: false }],
      reason: 'DEV/TEST ONLY second definition',
    }),
    [200],
    '(7) edit draft 2',
  );
  const v2 = expectStatus(
    await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/2/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish 2' }),
    [200],
    '(7) publish v2',
  ).json.data;
  assert(v2.status === 'ACTIVE' && v2.fields.length === 5, '(7) v2 is ACTIVE with its five fields');

  // (8) v1 is preserved byte for byte; the public view serves v2
  const v1After = (await call('catalog', admin, 'GET', `/gig-templates/${tpl}/versions/1`)).json.data;
  assert(v1After.status === 'SUPERSEDED' && v1After.closedAt !== null, `(8) v1 is SUPERSEDED with its closing time (${v1After.status})`);
  const strip = (v: Record<string, unknown>): string => JSON.stringify({ ...v, status: 'x', closedAt: 'x' });
  assert(strip(JSON.parse(v1Frozen)) === strip(v1After), '(8) v1 keeps its exact structure');
  const mgmt = expectStatus(await call('catalog', admin, 'GET', `/gig-templates/${tpl}?market=${marketCode}`), [200], '(8) management detail').json.data;
  assert(
    mgmt.versions.map((v: { versionNumber: number; status: string }) => `${v.versionNumber}:${v.status}`).join() === '2:ACTIVE,1:SUPERSEDED' &&
      mgmt.enabled === true,
    `(8) the management detail lists every version (${JSON.stringify(mgmt.versions?.map((v: { versionNumber: number; status: string }) => `${v.versionNumber}:${v.status}`))})`,
  );
  const publicV2 = (await call('catalog', null, 'GET', `/gig-templates/${tpl}?market=${marketCode}&locale=en-US`)).json.data;
  assert(
    publicV2.activeVersion.versionNumber === 2 &&
      publicV2.activeVersion.fields.length === 5 &&
      publicV2.activeVersion.duration.minMinutes === 90 &&
      publicV2.activeVersion.fields[4].label === 'Bring your own water',
    `(8) the public view serves v2 (${publicV2.activeVersion.versionNumber})`,
  );

  // (9) retirement hides the template and keeps every version; a retired template accepts nothing new
  const retired = expectStatus(
    await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'RETIRED', reason: 'DEV/TEST ONLY cleanup' }),
    [200],
    '(9) retire the template',
  ).json.data;
  assert(
    retired.status === 'RETIRED' && retired.versions.map((v: { status: string }) => v.status).join() === 'RETIRED,SUPERSEDED',
    `(9) the versions are kept (${JSON.stringify(retired.versions?.map((v: { status: string }) => v.status))})`,
  );
  assert((await call('catalog', null, 'GET', `/gig-templates/${tpl}?market=${marketCode}`)).status === 404, '(9) a retired template is not public');
  assert((await call('catalog', null, 'GET', `/gig-templates?market=${marketCode}`)).json.data.length === 0, '(9) the public list is empty');
  expectStatus(await call('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'late' }), [409], '(9) no new version for a retired template');
  expectStatus(await call('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'back' }), [409], '(9) RETIRED is terminal');
  expectStatus(
    await call('catalog', admin, 'POST', '/gig-templates', { code: tpl, serviceTypeCode: serviceType, reason: 'reuse' }),
    [409],
    '(9) a retired code is never reused',
  );
  // retirement leaves the availability row as it was (hidden by the public read): switching it off works, switching it on again is refused
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: false, reason: 'withdraw' }),
    [200],
    '(9) withdraw the retired template',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: true, reason: 'late' }),
    [409],
    '(9) a retired template is never enabled again',
  );
  assert((await call('catalog', admin, 'GET', `/gig-templates/${tpl}/versions/1`)).json.data.fields.length === 4, '(9) the history stays readable');

  // (10) the audit trail and the outbox hold every change; the seeded templates were not touched
  const databaseUrl = env('DATABASE_URL', '');
  assert(databaseUrl !== '', 'DATABASE_URL is not set in the smoke environment');
  const database = createDatabase(databaseUrl, { role: 'tests' });
  try {
    const audit = await database.query<{ action: string; n: number }>(
      `SELECT a.action, count(*)::int AS n FROM catalog.audit_events a JOIN catalog.gig_templates t ON t.gig_template_id = a.gig_template_id WHERE t.code = $1 GROUP BY a.action ORDER BY a.action`,
      [tpl],
    );
    const byAction = Object.fromEntries(audit.map((r) => [r.action, r.n]));
    assert(
      byAction.GIG_TEMPLATE_CREATED === 1 &&
        byAction.GIG_TEMPLATE_STATUS_CHANGED === 2 &&
        byAction.GIG_TEMPLATE_VERSION_CREATED === 2 &&
        byAction.GIG_TEMPLATE_VERSION_CHANGED === 2 &&
        byAction.GIG_TEMPLATE_VERSION_PUBLISHED === 2 &&
        byAction.GIG_TEMPLATE_VERSION_RETIRED === 1 &&
        byAction.MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED === 2,
      `(10) the audit trail must hold every mutation (${JSON.stringify(byAction)})`,
    );
    const events = await database.query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.gig-template-%' AND payload_json::text LIKE '%' || $1 || '%' GROUP BY event_type`,
      [tpl],
    );
    const ev = Object.fromEntries(events.map((r) => [r.event_type, r.n]));
    assert(
      ev['bananagig.catalog.gig-template-activated.v1'] === 1 &&
        ev['bananagig.catalog.gig-template-published.v1'] === 2 &&
        ev['bananagig.catalog.gig-template-retired.v1'] === 1 &&
        ev['bananagig.catalog.gig-template-availability-changed.v1'] === 2,
      `(10) the outbox must hold the activation, publication, retirement and availability events (${JSON.stringify(ev)})`,
    );
    const copyLeak = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM catalog.audit_events WHERE changes::text LIKE '%Exterior wash%' OR changes::text LIKE '%Show the finished work%'`,
    );
    assert(copyLeak[0]!.n === 0, '(10) no copy in the audit trail');
    const seededUntouched = await database.query<{ code: string; status: string; versions: number }>(
      `SELECT t.code, t.status, (SELECT count(*)::int FROM catalog.gig_template_versions v WHERE v.gig_template_id = t.gig_template_id) AS versions
         FROM catalog.gig_templates t WHERE t.code IN ('full_detail', 'standard_clean') ORDER BY t.code`,
    );
    assert(
      seededUntouched.length === 2 && seededUntouched.every((t) => t.status === 'DRAFT' && t.versions === 0),
      '(10) the smoke must leave the seeded templates as it found them (DRAFT, no versions)',
    );
  } finally {
    await database.close();
  }

  // (11) cleanup of the DEV/TEST taxonomy and market (everything stays, retired or inactive)
  expectStatus(
    await call('catalog', admin, 'PUT', `/service-types/${serviceType}/status`, { status: 'RETIRED', reason: 'smoke cleanup' }),
    [200],
    '(11) retire the service type',
  );
  expectStatus(
    await call('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'RETIRED', reason: 'smoke cleanup' }),
    [200],
    '(11) retire the category',
  );
  expectStatus(
    await call('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: false, reason: 'smoke cleanup' }),
    [200],
    '(11) deactivate the test market',
  );
  assert((await call('catalog', null, 'GET', `/gig-templates?market=${marketCode}`)).status === 404, '(11) a deactivated market exposes no template');
  return (
    `seeded templates DRAFT without versions (full_detail, standard_clean); la-oc ${laoc.status} ${laocPublic ? '(public: nothing seeded listed)' : '=> 404 CATALOG_MARKET_NOT_FOUND'}; ${tpl}: SERVICE_TYPE_NOT_ACTIVE refused, draft v1 ` +
    `(4 typed fields, 2 hooks, revision 2, stale and duplicate drafts refused, unpublished copy named), v1 published and frozen, public view = safe structure with resolved copy, ` +
    `v2 from a copy published (v1 SUPERSEDED, byte-identical), public serves v2, retirement hides it and keeps both versions, code never reused, audit and outbox complete, no copy in the audit trail`
  );
});

// ---------------------------------------------------------------- Provider registration (PRO-001)
await check('Provider registration', async () => {
  // Provider registration (PRO-001) end to end with REAL Keycloak tokens and a THROWAWAY customer-only identity (created through the Keycloak admin API and deleted at the end:
  // customer.dev already holds PROVIDER, so it cannot show a registration that starts from a customer). One account becomes a provider: no second login, no copied contact.
  // The catalogue it registers into is an isolated DEV/TEST market (ZZ) with its own category and service types, activated and RETIRED/deactivated by this scenario; the seeded
  // market la-oc is never activated and its status is checked before and after. Contacts are verified through the REAL email and phone flows (Mailpit, fake SMS sink), consent
  // through the REAL consent API (the legal versions published by the 'Consent' scenario are in force). Attempt 1 runs through the API (gates, cancel); attempt 2 (restart) runs
  // through the web forms behind Caddy. Assumptions: DATABASE_URL (read-only SELECTs), LOKI_URL, MAILPIT_URL, VALKEY_URL, KEYCLOAK_ADMIN*, a consent policy of migration 0013
  // (both legal purposes required for CUSTOMER and PROVIDER) and the provider policy of migration 0018 (verified email and phone, ACTIVE markets, 1 to 10 service types).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any; // parsed response bodies are checked field by field below
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cid = `smoke-provider-${runId}`;
  const flowStart = Date.now() * 1e6;
  const marketCode = `devtest-pro-${runId}`;
  const categoryCode = `devtest_pro_${runId}`;
  const stA = `devtest_pro_${runId}_a`;
  const stB = `devtest_pro_${runId}_b`;
  const stC = `devtest_pro_${runId}_c`; // ACTIVE but never enabled in the market: not offered
  const username = `pro001.${runId}`;
  const password = `Pw-${randomBytes(9).toString('hex')}`; // secret-scan:allow throwaway DEV/TEST identity, deleted at the end
  const email = `pro001-${runId}@bananagig.localhost`;
  const webOrigin = new URL(webPublic).origin;
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const seen: string[] = []; // every PROVIDER API response (body and headers): searched for identifiers, contacts and tokens at the end
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  await clearLimiterBuckets('email-verification');
  await clearLimiterBuckets('phone-verification');

  type Reply = { status: number; text: string; json: Json; headers: Headers };
  const request = async (
    module: string,
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Reply> => {
    const r = await get(`${api}/api/v1/${module}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const mgmt = async (
    module: 'catalog' | 'geography' | 'content',
    admin: string,
    method: string,
    path: string,
    body?: unknown,
    ok = [200, 201],
  ): Promise<Reply> => {
    const r = await request(module, method, path, admin, body);
    assert(ok.includes(r.status), `${method} /${module}${path} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };
  /** The provider API as the throwaway customer (or anonymously). */
  const provider = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string | null,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Reply> => {
    const r = await request('provider', method, `/registration${path}`, token, body, extra);
    seen.push(r.text, JSON.stringify([...r.headers]));
    assert(
      r.headers.get('cache-control') === 'no-store',
      `${method} /provider/registration${path}: every provider response must be Cache-Control: no-store (${r.status})`,
    );
    return r;
  };
  const account = (token: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Reply> =>
    request('account', method, path.replace(/^\/account/, ''), token, body);
  const refusal = (r: Reply, status: number, code: string, what: string): Reply => {
    assert(
      r.status === status && r.json?.error?.code === code,
      `${what}: expected ${status} ${code}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)}`,
    );
    assert(
      r.json.error.details?.messageKey === `provider.registration.error.${code.replace(/^PROVIDER_/, '').toLowerCase()}`,
      `${what}: the error must carry its content message key (got ${r.json.error.details?.messageKey})`,
    );
    return r;
  };
  const ok = (r: Reply, status: number, what: string): Json => {
    assert(r.status === status, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)}`);
    return r.json.data;
  };
  const stepOf = (req: Json, step: string): Json => req.steps.find((s: Json) => s.step === step);

  // ---- Keycloak: the throwaway identity (customer realm role only, so the account starts as a customer: ADR-0025 bootstrap)
  const kcToken = await kcMasterToken();
  const kcAdmin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; location: string | null }> => {
    const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, {
      method,
      headers: { authorization: `Bearer ${kcToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  let kcUserId = '';
  const database = createDatabase(env('DATABASE_URL', ''), { role: 'tests' });
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = new FakeSmsInbox(valkey);
  let marketCreated = false;
  let admin = '';
  try {
    const created = await kcAdmin('POST', '/users', {
      username,
      enabled: true,
      email: `kc-${email}`,
      emailVerified: true,
      firstName: 'Pro',
      lastName: 'Smoke',
      attributes: { 'bananagig.devOnly': ['true'] },
    });
    assert(created.status === 201 && !!created.location, `(1) creating the throwaway Keycloak user -> ${created.status} ${JSON.stringify(created.json)}`);
    kcUserId = created.location!.split('/').pop()!;
    const role = await kcAdmin('GET', '/roles/customer');
    assert(role.status === 200, `(1) the customer realm role -> ${role.status}`);
    assert((await kcAdmin('POST', `/users/${kcUserId}/role-mappings/realm`, [role.json])).status === 204, '(1) mapping the customer realm role');
    assert(
      (await kcAdmin('PUT', `/users/${kcUserId}/reset-password`, { type: 'password', value: password, temporary: false })).status === 204,
      '(1) setting the throwaway password',
    );
    const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, username, password });
    const token = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: login.code,
        codeVerifier: login.verifier,
      })
    ).accessToken;
    const me = AccountResponse.parse((await account(token, '/account/me')).json).data;
    const accountId = me.accountId;
    assert(uuidRe.test(accountId) && me.status === 'ACTIVE', '(1) the account is created on the first request and ACTIVE');
    assert(me.roles.map((r) => r.code).join() === 'CUSTOMER', `(1) the throwaway account starts as a customer only (${me.roles.map((r) => r.code).join()})`);
    const roleStatus = async (code: string): Promise<string | undefined> =>
      (
        await database.query<{ status: string }>(
          `SELECT ar.status FROM identity.account_roles ar JOIN identity.roles r ON r.role_id = ar.role_id WHERE ar.account_id = $1 AND r.code = $2`,
          [accountId, code],
        )
      )[0]?.status;
    const counts = async (): Promise<{ audit: Record<string, number>; events: Record<string, number>; attempts: number; accounts: number }> => {
      const audit = await database.query<{ action: string; n: number }>(
        `SELECT a.action, count(*)::int AS n FROM provider.audit_events a JOIN provider.registrations r USING (provider_registration_id) WHERE r.account_id = $1 GROUP BY a.action`,
        [accountId],
      );
      const events = await database.query<{ event_type: string; n: number }>(
        `SELECT event_type, count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%' AND payload_json->>'accountId' = $1::text GROUP BY event_type`,
        [accountId],
      );
      const attempts = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider.registrations WHERE account_id = $1`, [accountId]);
      const accounts = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM identity.accounts WHERE account_id = $1`, [accountId]);
      return {
        audit: Object.fromEntries(audit.map((r) => [r.action, r.n])),
        events: Object.fromEntries(events.map((r) => [r.event_type, r.n])),
        attempts: attempts[0]!.n,
        accounts: accounts[0]!.n,
      };
    };
    assert((await roleStatus('PROVIDER')) === undefined, '(1) no PROVIDER membership exists before the person asks for one');

    // (2) before anything is started: nothing exists, every route needs the caller's own token, and no client can name an account, a role or a status
    const empty = ok(await provider('GET', '', token), 200, '(2) GET /registration');
    assert(empty.providerRole === 'NONE' && empty.registration === null, `(2) before starting: role NONE and no registration (${JSON.stringify(empty)})`);
    const req0 = ok(await provider('GET', '/requirements', token), 200, '(2) GET /requirements');
    assert(
      ['ACCOUNT', 'MARKET', 'SERVICES'].every((s) => stepOf(req0, s).status === 'NOT_STARTED') &&
        stepOf(req0, 'CONTACT').status === 'NOT_STARTED' &&
        // VERIFICATION is answered by the verification domain (TRUST-001): identity verification applies to everyone and has not started; the later steps are not built yet
        stepOf(req0, 'VERIFICATION').status === 'NOT_STARTED' &&
        // SUBSCRIPTION is not built yet; PROFILE is answered by the public profile domain (PRO-002): no profile row exists, so it has not started
        stepOf(req0, 'SUBSCRIPTION').status === 'NOT_AVAILABLE' &&
        stepOf(req0, 'PROFILE').status === 'NOT_STARTED' &&
        // GIGS is answered by the Gig domain (CAT-003): no Gig exists, so it has not started
        stepOf(req0, 'GIGS').status === 'NOT_STARTED' &&
        req0.overall.registrationReady === false &&
        req0.overall.goLive.evaluated === false &&
        req0.overall.goLive.eligible === false,
      `(2) the evaluator before starting (${JSON.stringify(req0.steps.map((s: Json) => `${s.step}:${s.status}`))})`,
    );
    assert(
      req0.steps.every(
        (s: Json) => /^provider\.registration\.step\.[a-z]+\.label$/.test(s.labelKey) && /^provider\.registration\.step_status\./.test(s.statusKey),
      ),
      '(2) steps carry content keys, not words',
    );
    assert((await provider('GET', '', null)).status === 401, '(2) GET without a token must be 401');
    assert((await provider('POST', '', null, {})).status === 401, '(2) POST without a token must be 401');
    for (const [what, body] of [
      ['an account id', { accountId }],
      ['a role', { role: 'PROVIDER' }],
      ['a status', { status: 'COMPLETED' }],
    ] as const)
      assert((await provider('POST', '', token, body)).status === 400, `(2) a start request naming ${what} must be 400`);
    assert((await provider('POST', '', token, '[]')).status === 400, '(2) a start request that is not an object must be 400');
    assert((await provider('PUT', '/market', token, { marketCode: 'x-y', accountId })).status === 400, '(2) a market request naming an account must be 400');
    assert((await provider('POST', '/submit', token, {})).status === 400, '(2) submit without expectedRevision must be 400');
    refusal(
      await provider('PUT', '/market', token, { marketCode: marketCode }),
      409,
      'PROVIDER_PREREQUISITE_NOT_MET',
      '(2) choosing a market before starting (contacts first)',
    );
    assert((await roleStatus('PROVIDER')) === undefined, '(2) refused calls must not create a membership');

    // (3) the isolated DEV/TEST market and catalogue (activated here, retired at the end); la-oc is only observed
    const adminLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
    admin = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-admin',
        redirectUri: ADMIN_REDIRECT_URI,
        code: adminLogin.code,
        codeVerifier: adminLogin.verifier,
      })
    ).accessToken;
    const laocBefore = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    await ensureDevtestGeography(admin);
    await mgmt('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST provider smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    });
    marketCreated = true;
    const publish = async (key: string, text: string): Promise<void> => {
      await mgmt('content', admin, 'POST', '/entries', {
        key,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY provider smoke entry',
        approvalPolicy: 'NONE',
      });
      const v = (await mgmt('content', admin, 'POST', `/entries/${key}/versions`, { locale: 'en-US', body: text, reason: 'smoke test' })).json.data;
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/submit`, {});
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/publish`, {});
    };
    const names = { a: `Smoke Provider Service A ${runId}`, b: `Smoke Provider Service B ${runId}`, c: `Smoke Provider Service C ${runId}` };
    await publish(`catalog.category.${categoryCode}.name`, `Smoke Provider Category ${runId}`);
    await publish(`catalog.service_type.${stA}.name`, names.a);
    await publish(`catalog.service_type.${stB}.name`, names.b);
    await publish(`catalog.service_type.${stC}.name`, names.c);
    await mgmt('catalog', admin, 'POST', '/categories', { code: categoryCode, iconKey: 'wrench', reason: 'DEV/TEST ONLY smoke category' });
    for (const st of [stA, stB, stC])
      await mgmt('catalog', admin, 'POST', '/service-types', { code: st, categoryCode, reason: 'DEV/TEST ONLY smoke service type' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, {
      enabled: true,
      displayOrder: 10,
      reason: 'prepare before launch',
    });
    await mgmt('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' });
    await mgmt('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' });
    for (const [st, order] of [
      [stA, 10],
      [stB, 20],
    ] as const) {
      await mgmt('catalog', admin, 'PUT', `/service-types/${st}/status`, { status: 'ACTIVE', reason: 'launch' });
      await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${st}`, { enabled: true, displayOrder: order, reason: 'launch' });
    }
    await mgmt('catalog', admin, 'PUT', `/service-types/${stC}/status`, { status: 'ACTIVE', reason: 'launch (not enabled in the market)' });

    // (4) become a provider: the SAME account asks for the role (PENDING, never ACTIVE at the start); starting twice is one attempt
    const before4 = await counts();
    const started = await provider('POST', '', token, {});
    const s1 = ok(started, 201, '(4) POST /registration (first)');
    assert(
      s1.providerRole === 'PENDING' &&
        s1.registration.status === 'IN_PROGRESS' &&
        s1.registration.attempt === 1 &&
        s1.registration.marketCode === null &&
        s1.registration.serviceTypeCodes.length === 0,
      `(4) a started registration is IN_PROGRESS attempt 1 with the PROVIDER role PENDING (${JSON.stringify(s1)})`,
    );
    assert(
      Object.keys(s1.registration).sort().join() ===
        'attempt,cancelledAt,completedAt,createdAt,marketCode,providerRegistrationId,revision,serviceTypeCodes,status',
      '(4) the registration read model has no other fields',
    );
    assert(
      (await roleStatus('PROVIDER')) === 'PENDING' && (await roleStatus('CUSTOMER')) === 'ACTIVE',
      '(4) PROVIDER is PENDING and CUSTOMER stays ACTIVE on the one account',
    );
    const again = ok(await provider('POST', '', token, {}), 200, '(4) POST /registration (resume)');
    assert(
      again.registration.providerRegistrationId === s1.registration.providerRegistrationId && again.registration.revision === s1.registration.revision,
      '(4) starting twice resumes the same attempt',
    );
    const after4 = await counts();
    assert(
      after4.attempts === 1 &&
        after4.accounts === 1 &&
        after4.audit.PROVIDER_REGISTRATION_STARTED === 1 &&
        after4.events['bananagig.provider.registration-started.v1'] === 1,
      `(4) one attempt, one account, one STARTED audit row and one started event (${JSON.stringify(after4)}; before ${JSON.stringify(before4)})`,
    );
    assert(
      (await account(token, '/account/me').then((r) => AccountResponse.parse(r.json).data)).roles.map((r) => r.code).join() === 'CUSTOMER',
      '(4) the PENDING provider role is not an ACTIVE role yet',
    );

    // (5) contacts first (PR-01.03/05): market and services wait for a verified email and phone; consent is read from its owner and shows outstanding
    refusal(
      await provider('PUT', '/market', token, { marketCode }),
      409,
      'PROVIDER_PREREQUISITE_NOT_MET',
      '(5) choosing a market before the contacts are verified',
    );
    const req5 = ok(await provider('GET', '/requirements', token), 200, '(5) requirements');
    assert(stepOf(req5, 'CONTACT').status === 'NOT_STARTED' && stepOf(req5, 'ACCOUNT').status === 'COMPLETE', '(5) ACCOUNT complete, CONTACT not started');
    assert(
      stepOf(req5, 'CONTACT').detail?.email === 'NOT_VERIFIED' && stepOf(req5, 'CONTACT').detail?.phone === 'NOT_VERIFIED',
      '(5) CONTACT says which contact is missing (statuses only)',
    );

    // (6) the contacts are verified by their owners through the real flows; nothing is copied into the provider domain
    const setEmail = await account(token, '/account/email', 'POST', { email });
    assert(setEmail.status === 200, `(6) POST /account/email -> ${setEmail.status}`);
    assert((await account(token, '/account/email/verification/send', 'POST', {})).status === 200, '(6) sending the email verification');
    const message = await retry(
      async () => {
        const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
          messages: { ID: string }[] | null;
        };
        if (!found.messages?.length) throw new Error('the verification email has not arrived');
        return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
      },
      10,
      1000,
    );
    const emailCode = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
    assert(!!emailCode, '(6) the verification code is missing from the delivered message');
    assert((await account(token, '/account/email/verification/confirm-code', 'POST', { code: emailCode })).status === 200, '(6) confirming the email code');
    let tail = '';
    do tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    while (['901', '902', '903', '904', '905'].includes(tail.slice(-3))); // the fake line-type classifier reads the last three digits
    const national = `(202) 555-${tail}`;
    const e164 = `+1202555${tail}`;
    await inbox.clear(e164);
    assert((await account(token, '/account/phone', 'POST', { phone: national, country: 'US' })).status === 200, '(6) setting the phone number');
    assert((await account(token, '/account/phone/verification/send', 'POST', {})).status === 200, '(6) sending the SMS');
    const sms = await inbox.wait(e164, 1, 10_000);
    const smsCode = extractSmsCode(sms[0]!.body);
    assert(!!smsCode, '(6) the SMS code is missing');
    assert((await account(token, '/account/phone/verification/confirm-code', 'POST', { code: smsCode })).status === 200, '(6) confirming the SMS code');
    const req6 = ok(await provider('GET', '/requirements', token), 200, '(6) requirements');
    assert(
      stepOf(req6, 'CONTACT').status === 'COMPLETE' &&
        stepOf(req6, 'CONTACT').detail?.email === 'VERIFIED' &&
        stepOf(req6, 'CONTACT').detail?.phone === 'VERIFIED',
      '(6) CONTACT is complete from the owners',
    );

    // (7) choosing where: services need a market; an unknown market and a market that is not ACTIVE are refused by the configured policy; la-oc is never made public by this
    refusal(await provider('PUT', '/services', token, { serviceTypeCodes: [stA] }), 409, 'PROVIDER_MARKET_REQUIRED', '(7) services before a market');
    refusal(await provider('PUT', '/market', token, { marketCode: 'no-such-market' }), 400, 'PROVIDER_MARKET_NOT_ELIGIBLE', '(7) an unknown market');
    const laocNow = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    if (laocNow !== 'ACTIVE')
      refusal(
        await provider('PUT', '/market', token, { marketCode: 'la-oc' }),
        400,
        'PROVIDER_MARKET_NOT_ELIGIBLE',
        `(7) la-oc (${laocNow}) is not open for provider registration`,
      );
    const m1 = ok(await provider('PUT', '/market', token, { marketCode, expectedRevision: s1.registration.revision }), 200, '(7) choose the test market');
    assert(
      m1.registration.marketCode === marketCode && m1.registration.revision === s1.registration.revision + 1,
      '(7) the market is chosen and the revision grows by one',
    );
    const m1b = ok(await provider('PUT', '/market', token, { marketCode }), 200, '(7) choose the same market again');
    assert(m1b.registration.revision === m1.registration.revision, '(7) choosing the same market again changes nothing');
    refusal(
      await provider('PUT', '/market', token, { marketCode, expectedRevision: s1.registration.revision }),
      409,
      'PROVIDER_STALE_REGISTRATION',
      '(7) a stale revision',
    );

    // (8) choosing what: only ACTIVE service types offered in the chosen market, within the configured range, replaced as a whole
    refusal(await provider('PUT', '/services', token, { serviceTypeCodes: [] }), 400, 'PROVIDER_SERVICE_COUNT_OUT_OF_RANGE', '(8) no service type');
    refusal(
      await provider('PUT', '/services', token, { serviceTypeCodes: [stC] }),
      400,
      'PROVIDER_SERVICE_TYPE_NOT_ELIGIBLE',
      '(8) a service type that is not offered in the market',
    );
    refusal(
      await provider('PUT', '/services', token, { serviceTypeCodes: ['regular_cleaning'] }),
      400,
      'PROVIDER_SERVICE_TYPE_NOT_ELIGIBLE',
      '(8) a seeded DRAFT service type',
    );
    assert((await provider('PUT', '/services', token, { serviceTypeCodes: [stA, stA] })).status === 400, '(8) a duplicated code must be 400');
    assert((await provider('PUT', '/services', token, { serviceTypeCodes: ['Not A Code'] })).status === 400, '(8) a malformed code must be 400');
    const sv1 = ok(
      await provider('PUT', '/services', token, { serviceTypeCodes: [stB, stA], expectedRevision: m1.registration.revision }),
      200,
      '(8) choose two service types',
    );
    assert(
      sv1.registration.serviceTypeCodes.join() === [stA, stB].sort().join() && sv1.registration.revision === m1.registration.revision + 1,
      '(8) the set is stored sorted and the revision grows',
    );
    const sv1b = ok(await provider('PUT', '/services', token, { serviceTypeCodes: [stA, stB] }), 200, '(8) the same set again');
    assert(sv1b.registration.revision === sv1.registration.revision, '(8) an equal set changes nothing');
    const sv2 = ok(await provider('PUT', '/services', token, { serviceTypeCodes: [stA] }), 200, '(8) replace by one service type');
    assert(sv2.registration.serviceTypeCodes.join() === stA && sv2.registration.revision === sv1.registration.revision + 1, '(8) the whole set is replaced');
    const mid = await counts();
    assert(
      mid.audit.PROVIDER_MARKET_SELECTED === 1 && mid.audit.PROVIDER_SERVICES_UPDATED === 2,
      `(8) one audit row per real change and none for no-ops (${JSON.stringify(mid.audit)})`,
    );

    // (9) the requirements now: everything this checkpoint owns is complete except the legal step, which belongs to the consent owner; submit refuses and names it
    const req9 = ok(await provider('GET', '/requirements', token), 200, '(9) requirements');
    assert(
      stepOf(req9, 'MARKET').status === 'COMPLETE' &&
        stepOf(req9, 'SERVICES').status === 'COMPLETE' &&
        stepOf(req9, 'LEGAL').status !== 'COMPLETE' &&
        req9.overall.blockedBy.join() === 'LEGAL',
      `(9) only LEGAL stands in the way (${JSON.stringify(req9.steps.map((s: Json) => `${s.step}:${s.status}`))} ${JSON.stringify(req9.overall.blockedBy)})`,
    );
    const incomplete = refusal(
      await provider('POST', '/submit', token, { expectedRevision: sv2.registration.revision }),
      409,
      'PROVIDER_REGISTRATION_INCOMPLETE',
      '(9) submit with consent outstanding',
    );
    assert(incomplete.json.error.details.steps?.join() === 'LEGAL', '(9) the refusal names the open step');

    // (10) cancel keeps the account, the customer role, the contacts and the history; a restart is a NEW attempt
    const mid10 = await counts();
    const cancelled = ok(await provider('POST', '/cancel', token, {}), 200, '(10) cancel');
    assert(
      cancelled.registration.status === 'CANCELLED' && cancelled.registration.attempt === 1 && cancelled.registration.cancelledAt !== null,
      '(10) attempt 1 is CANCELLED and kept',
    );
    assert(
      cancelled.providerRole === 'PENDING' && (await roleStatus('PROVIDER')) === 'PENDING' && (await roleStatus('CUSTOMER')) === 'ACTIVE',
      '(10) cancelling leaves the account, the CUSTOMER role and the pending PROVIDER role as they were',
    );
    const cancelAgain = ok(await provider('POST', '/cancel', token, {}), 200, '(10) cancel again');
    assert(
      cancelAgain.registration.status === 'CANCELLED' && cancelAgain.registration.cancelledAt === cancelled.registration.cancelledAt,
      '(10) cancelling twice is idempotent',
    );
    refusal(await provider('PUT', '/market', token, { marketCode }), 404, 'PROVIDER_REGISTRATION_NOT_FOUND', '(10) a cancelled attempt cannot be changed');
    const req10 = ok(await provider('GET', '/requirements', token), 200, '(10) requirements after cancelling');
    assert(
      stepOf(req10, 'CONTACT').status === 'COMPLETE' && stepOf(req10, 'MARKET').status === 'NOT_STARTED',
      '(10) the contacts stay verified and the selections are not carried',
    );
    const after10 = await counts();
    assert(
      after10.audit.PROVIDER_REGISTRATION_CANCELLED === 1 &&
        after10.events['bananagig.provider.registration-cancelled.v1'] === 1 &&
        mid10.audit.PROVIDER_REGISTRATION_CANCELLED === undefined,
      `(10) exactly one CANCELLED audit row and one cancelled event (${JSON.stringify(after10)})`,
    );

    // (11) consent is accepted by the person through the consent API (explicit, never implied), for exactly the version in force
    const consentReq = ConsentRequirementsResponse.parse((await account(token, '/account/consents/requirements')).json).data;
    const outstanding = consentReq.requirements.filter((r) => r.status === 'OUTSTANDING' || r.status === 'REACCEPTANCE_REQUIRED');
    assert(
      outstanding.length >= 1 && outstanding.every((r) => r.document),
      `(11) legal text must be in force (the Consent scenario publishes it): ${JSON.stringify(consentReq.requirements.map((r) => `${r.purposeCode}:${r.status}`))}`,
    );
    for (const r of outstanding) {
      const accepted = await account(token, `/account/consents/${r.purposeCode}/accept`, 'POST', {
        versionId: r.document!.versionId,
        locale: r.document!.locale,
        bodySha256: r.document!.bodySha256,
      });
      assert(accepted.status === 200, `(11) accepting ${r.purposeCode} -> ${accepted.status} ${accepted.json?.error?.code ?? ''}`);
    }

    // (12) attempt 2 through the WEB app behind Caddy: sign in, start, choose the market and services with the forms, submit
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[]; headers: http.IncomingHttpHeaders };
    const caddy = (method: 'GET' | 'POST', path: string, o: { cookie?: string; origin?: string; form?: URLSearchParams } = {}): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const payload = o.form?.toString();
        const req = http.request(
          {
            host: 'caddy-proxy',
            port: 80,
            path,
            method,
            headers: {
              host: 'app.localhost',
              ...(o.cookie ? { cookie: o.cookie } : {}),
              ...(o.origin ? { origin: o.origin } : {}),
              ...(method === 'POST' ? { 'content-length': String(Buffer.byteLength(payload ?? '')) } : {}),
              ...(payload !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, location: res.headers.location, body, cookies: res.headers['set-cookie'] ?? [], headers: res.headers }),
            );
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end(payload);
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const decode = (s: string): string =>
      s
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    const formsOf = (html: string) =>
      [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({
        action: decode(/\baction="([^"]*)"/.exec(m[1]!)?.[1] ?? ''),
        inputs: [...m[2]!.matchAll(/<input\b([^>]*)>/g)].map((i) => ({
          type: decode(/\btype="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          name: decode(/\bname="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          value: decode(/\bvalue="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          id: decode(/\bid="([^"]*)"/.exec(i[1]!)?.[1] ?? ''),
          checked: /\schecked\b/.test(i[1]!),
        })),
        html: m[2]!,
      }));
    const page = async (query = ''): Promise<Hop> => {
      const p = await caddy('GET', `/provider/registration${query}`, { cookie: cookie() });
      assert(p.status === 200, `(12) GET /provider/registration${query} -> ${p.status}`);
      assert(
        !/eyJ[A-Za-z0-9_-]{10,}\./.test(p.body) && !p.body.includes(token) && !p.body.includes(accountId),
        '(12) the page leaked a token or the account id',
      );
      for (const v of jar.values()) assert(v.length < 8 || !p.body.includes(v), '(12) the page contains the session cookie value');
      return p;
    };
    const post = (action: string, form: URLSearchParams, o: { origin?: string | null; cookie?: boolean } = {}) =>
      caddy('POST', `/auth/provider/${action}`, {
        ...(o.cookie === false ? {} : { cookie: cookie() }),
        ...(o.origin === null ? {} : { origin: o.origin ?? webOrigin }),
        form,
      });
    const lands = (h: Hop, suffix: string, what: string): void =>
      assert(h.status === 303 && (h.location ?? '').endsWith(suffix), `${what}: expected 303 ...${suffix}, got ${h.status} ${h.location}`);

    const anon = await caddy('GET', '/provider/registration');
    assert(
      anon.status === 200 && anon.body.includes('/auth/login?returnTo=/provider/registration') && formsOf(anon.body).length === 0,
      '(12) signed out: sign-in is offered and no form exists',
    );
    assert((await caddy('GET', '/auth/provider/start')).status === 405, '(12) GET /auth/provider/start must be 405 (no GET changes state)');
    assert((await post('start', new URLSearchParams(), { origin: null, cookie: false })).status === 403, '(12) POST without an Origin must be 403');
    assert(
      (await post('start', new URLSearchParams(), { origin: 'http://evil.example', cookie: false })).status === 403,
      '(12) POST with a foreign Origin must be 403',
    );
    lands(await post('start', new URLSearchParams(), { cookie: false }), '/session', '(12) a same-origin POST without a session');
    assert((await post('nope', new URLSearchParams(), { cookie: false })).status === 404, '(12) an unknown action must be 404');

    const start = await caddy('GET', '/auth/login?returnTo=/provider/registration');
    absorb(start);
    assert(start.status === 302 && (start.location ?? '').includes('code_challenge_method=S256'), `(12) web login did not start a PKCE flow (${start.status})`);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, username, password });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, { cookie: cookie() });
    absorb(callback);
    assert(
      callback.status === 302 && (callback.location ?? '').endsWith('/provider/registration') && jar.has('bg_session'),
      `(12) web callback failed (${callback.status} ${callback.location})`,
    );

    const p0 = await page();
    const startForms = formsOf(p0.body).filter((f) => f.action === '/auth/provider/start');
    assert(
      startForms.length === 1 && formsOf(p0.body).length === 1,
      `(12) after cancelling only the restart form is offered (${formsOf(p0.body)
        .map((f) => f.action)
        .join()})`,
    );
    assert((await post('start', new URLSearchParams({ accountId })).then((h) => h.status)) === 400, '(12) a start form naming an account must be 400');
    const restart = await post('start', new URLSearchParams());
    lands(restart, '/provider/registration?notice=started', '(12) restart');
    const p1 = await page();
    const marketForm = formsOf(p1.body).find((f) => f.action === '/auth/provider/market');
    assert(!!marketForm, '(12) the market form is offered for the attempt in progress');
    const radio = marketForm!.inputs.find((i) => i.type === 'radio' && i.value === marketCode);
    assert(
      !!radio && !radio.checked && marketForm!.html.includes(`for="${radio.id}"`) && decode(marketForm!.html).includes(`DEV/TEST provider smoke ${runId}`),
      '(12) the market is a labelled radio, not pre-selected',
    );
    assert(!formsOf(p1.body).some((f) => f.action === '/auth/provider/services'), '(12) services are not offered before a market is chosen');
    assert(!formsOf(p1.body).some((f) => f.action === '/auth/provider/submit'), '(12) submit is not offered before the registration is ready');
    const revision1 = marketForm!.inputs.find((i) => i.name === 'expectedRevision')!.value;
    lands(
      await post('market', new URLSearchParams({ marketCode: 'devtest-pro-nope', expectedRevision: revision1 })),
      '?error=PROVIDER_MARKET_NOT_ELIGIBLE',
      '(12) an ineligible market through the form',
    );
    lands(
      await post('market', new URLSearchParams({ marketCode, expectedRevision: revision1 })),
      '/provider/registration?notice=market_saved',
      '(12) choose the market',
    );
    const p2 = await page();
    const servicesForm = formsOf(p2.body).find((f) => f.action === '/auth/provider/services');
    assert(!!servicesForm, '(12) the services form is offered once a market is chosen');
    const boxes = servicesForm!.inputs.filter((i) => i.type === 'checkbox');
    assert(
      boxes
        .map((b) => b.value)
        .sort()
        .join() === [stA, stB].sort().join() && boxes.every((b) => !b.checked && servicesForm!.html.includes(`for="${b.id}"`)),
      `(12) the offered service types are labelled checkboxes (${boxes.map((b) => b.value).join()}); the one not enabled in the market is absent`,
    );
    assert(
      decode(servicesForm!.html).includes(names.a) && decode(servicesForm!.html).includes(names.b) && !decode(servicesForm!.html).includes(names.c),
      '(12) resolved names are shown',
    );
    const revision2 = servicesForm!.inputs.find((i) => i.name === 'expectedRevision')!.value;
    lands(
      await post('services', new URLSearchParams({ expectedRevision: revision2 })),
      '?error=PROVIDER_SERVICE_COUNT_OUT_OF_RANGE',
      '(12) no checked service type',
    );
    const servicesBody = new URLSearchParams({ expectedRevision: revision2 });
    servicesBody.append('serviceTypeCode', stA);
    servicesBody.append('serviceTypeCode', stB);
    lands(await post('services', servicesBody), '/provider/registration?notice=services_saved', '(12) choose the services');
    const p3 = await page();
    const submitForm = formsOf(p3.body).find((f) => f.action === '/auth/provider/submit');
    assert(!!submitForm, '(12) everything this checkpoint owns is complete: submit is offered');
    assert(
      !formsOf(p3.body).some((f) => f.inputs.some((i) => i.type === 'checkbox' && /consent|legal|terms/i.test(i.name + i.id))),
      '(12) the page has no consent checkbox (consent is accepted on /consents)',
    );
    lands(
      await post('submit', new URLSearchParams({ expectedRevision: String(Number(submitForm!.inputs.find((i) => i.name === 'expectedRevision')!.value) - 1) })),
      '?error=PROVIDER_STALE_REGISTRATION',
      '(12) submit with a stale revision',
    );
    const doneBefore = await counts();
    lands(
      await post('submit', new URLSearchParams({ expectedRevision: submitForm!.inputs.find((i) => i.name === 'expectedRevision')!.value })),
      '/provider/registration?notice=submitted',
      '(12) submit',
    );
    const p4 = await page('?notice=submitted');
    assert(
      formsOf(p4.body).length === 0,
      `(12) a completed registration offers no form (${formsOf(p4.body)
        .map((f) => f.action)
        .join()})`,
    );

    // (13) the result: ONE account, attempt 2 COMPLETED, PROVIDER now ACTIVE (a role), Go-Live untouched (not this checkpoint's), later steps NOT_AVAILABLE, no further change
    const done = ok(await provider('GET', '', token), 200, '(13) GET /registration');
    assert(
      done.providerRole === 'ACTIVE' && done.registration.status === 'COMPLETED' && done.registration.attempt === 2 && done.registration.completedAt !== null,
      `(13) attempt 2 is COMPLETED and the role ACTIVE (${JSON.stringify(done)})`,
    );
    assert(
      done.registration.marketCode === marketCode && done.registration.serviceTypeCodes.join() === [stA, stB].sort().join(),
      '(13) the registration holds the market and service types chosen',
    );
    assert(
      (await roleStatus('PROVIDER')) === 'ACTIVE' && (await roleStatus('CUSTOMER')) === 'ACTIVE',
      '(13) the one account holds CUSTOMER and PROVIDER, both ACTIVE',
    );
    const reqDone = ok(await provider('GET', '/requirements', token), 200, '(13) requirements');
    assert(
      reqDone.overall.registrationComplete === true &&
        reqDone.overall.goLive.evaluated === false &&
        reqDone.overall.goLive.eligible === false &&
        stepOf(reqDone, 'VERIFICATION').status === 'NOT_STARTED' &&
        stepOf(reqDone, 'SUBSCRIPTION').status === 'NOT_AVAILABLE' &&
        stepOf(reqDone, 'PROFILE').status === 'NOT_STARTED' &&
        stepOf(reqDone, 'GIGS').status === 'NOT_STARTED',
      '(13) completing the registration is not Go-Live and does not need verification: VERIFICATION (TRUST-001) is not started, GIGS (CAT-003) has no Gig, SUBSCRIPTION is NOT_AVAILABLE, PROFILE (PRO-002) has no profile yet and Go-Live is not evaluated',
    );
    const submitAgain = ok(await provider('POST', '/submit', token, { expectedRevision: done.registration.revision }), 200, '(13) submit again');
    assert(submitAgain.registration.status === 'COMPLETED', '(13) submitting a completed registration is idempotent');
    refusal(await provider('PUT', '/market', token, { marketCode }), 409, 'PROVIDER_REGISTRATION_NOT_IN_PROGRESS', '(13) changing a completed registration');
    refusal(await provider('POST', '/cancel', token, {}), 409, 'PROVIDER_REGISTRATION_NOT_IN_PROGRESS', '(13) cancelling a completed registration');
    const final = await counts();
    assert(
      final.attempts === 2 &&
        final.accounts === 1 &&
        final.audit.PROVIDER_REGISTRATION_STARTED === 2 &&
        final.audit.PROVIDER_REGISTRATION_COMPLETED === 1 &&
        final.audit.PROVIDER_REGISTRATION_CANCELLED === 1 &&
        final.audit.PROVIDER_MARKET_SELECTED === 2 &&
        final.audit.PROVIDER_SERVICES_UPDATED === 3 &&
        final.events['bananagig.provider.registration-started.v1'] === 2 &&
        final.events['bananagig.provider.registration-completed.v1'] === 1 &&
        final.events['bananagig.provider.registration-cancelled.v1'] === 1,
      `(13) the audit trail and the outbox hold every change exactly once (${JSON.stringify(final)}; before submit ${JSON.stringify(doneBefore)})`,
    );
    const rows = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'provider' AND (column_name ILIKE '%email%' OR column_name ILIKE '%phone%' OR column_name ILIKE '%password%')`,
    );
    assert(rows[0]!.n === 0, '(13) the provider schema holds no email, phone or password column');
    const laocAfter = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    assert(laocAfter === laocBefore, `(13) la-oc must stay as it was (${laocBefore} -> ${laocAfter})`);

    // (14) what was shown or logged: no response holds the contacts, the account id, a token or a code; Loki holds none either
    const everything = seen.join('\n');
    for (const [what, value] of [
      ['email', email],
      ['phone', e164],
      ['national phone', national],
      ['account id', accountId],
      ['access token', token],
      ['email code', `"${emailCode}"`],
      ['password', password],
    ] as const)
      assert(!everything.includes(value), `(14) a provider API response contains the ${what}`);
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    for (const [what, q] of [
      ['email', `{service_name=~"bananagig-.+"} |= \`${email}\``],
      ['phone', `{service_name=~"bananagig-.+"} |= \`${e164}\``],
      ['email code', `{service_name=~"bananagig-.+"} |~ \`\\b${emailCode}\\b\``],
      ['password', `{service_name=~"bananagig-.+"} |= \`${password}\``],
      ['access token', `{service_name=~"bananagig-.+"} |= \`${token}\``],
    ] as const)
      assert((await query(q)).data.result.length === 0, `(14) the ${what} appears in the logs`);

    return (
      `throwaway customer-only account -> PROVIDER requested PENDING on the SAME account (idempotent start); contacts first (409 until the real email and phone flows verify them); ` +
      `market policy (unknown and non-ACTIVE refused, la-oc ${laocBefore} untouched), service types offered-only within [1,10], stale revisions 409; submit refused naming LEGAL until consent; ` +
      `cancel kept the account, CUSTOMER and the PENDING role (idempotent), restart = attempt 2 through the web forms, submit -> COMPLETED + PROVIDER ACTIVE, Go-Live not evaluated; ` +
      `audit and outbox exactly once; no contact, id, token or code in responses or logs`
    );
  } finally {
    // cleanup: the test catalogue is retired and the test market deactivated (entities are never deleted); the throwaway Keycloak user is removed
    try {
      if (admin && marketCreated) {
        for (const st of [stA, stB, stC]) await request('catalog', 'PUT', `/service-types/${st}/status`, admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request('catalog', 'PUT', `/categories/${categoryCode}/status`, admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request('geography', 'POST', `/markets/${marketCode}/activation`, admin, { active: false, reason: 'smoke cleanup' });
      }
    } catch {
      // best effort: the failure that got us here is the one to report
    }
    try {
      if (kcUserId) await kcAdmin('DELETE', `/users/${kcUserId}`);
    } catch {
      // best effort
    }
    valkey.disconnect();
    await database.close();
  }
});

// ---------------------------------------------------------------- Provider verification (TRUST-001)
await check('Provider verification', async () => {
  // Provider verification and documents (TRUST-001) end to end with REAL Keycloak tokens, a THROWAWAY customer-only identity (created through the Keycloak admin API and deleted at the
  // end), the real private object store (SeaweedFS: one-object presigned PUT and GET), the fake scanner (DEV/TEST), the database (read-only SELECTs on audit and outbox) and Loki.
  // The identity is verified through the REAL email and phone flows (verification starts only after both), starts a provider registration, and the policy is exercised with the
  // seeded requirement definitions: identity verification is ACTIVE for everyone (PRD PR-02.06) and liability insurance is turned on, for a DEV/TEST market only, by a
  // trust-admin (admin.dev) and turned off again at the end. Evidence is SYNTHETIC (a few bytes with a PDF signature): never a real document. Reviewers are admin.dev.
  // Assumptions: DATABASE_URL, LOKI_URL, MAILPIT_URL, VALKEY_URL, KEYCLOAK_ADMIN*, the realm roles trust-read/-review/-admin on admin.dev (run `pnpm identity:sync` after pulling
  // this checkpoint), TRUST_SCANNER=fake and the object store reachable at S3_ENDPOINT (the presigned host) from this container.
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any; // parsed response bodies are checked field by field below
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cid = `smoke-trust-${runId}`;
  const flowStart = Date.now() * 1e6;
  const marketCode = `devtest-trust-${runId}`;
  const username = `trust001.${runId}`;
  const password = `Pw-${randomBytes(9).toString('hex')}`; // secret-scan:allow throwaway DEV/TEST identity, deleted at the end
  const email = `trust001-${runId}@bananagig.localhost`;
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const webOrigin = new URL(webPublic).origin;
  const seen: string[] = []; // every PROVIDER verification response (body and headers): searched for keys, urls, hashes, contacts and tokens at the end
  await clearLimiterBuckets('email-verification');
  await clearLimiterBuckets('phone-verification');

  type Reply = { status: number; text: string; json: Json; headers: Headers };
  const request = async (path: string, method: string, token: string | null, body?: unknown): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const ok = (r: Reply, status: number, what: string): Json => {
    assert(r.status === status, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`);
    return r.json.data;
  };
  /** The provider verification API as the throwaway customer (everything it answers is kept for the secret scan, except the one-time upload authorization). */
  const provider = async (method: 'GET' | 'POST', path: string, token: string | null, body?: unknown, keep = true): Promise<Reply> => {
    const r = await request(`/provider/verification${path}`, method, token, body);
    if (keep) seen.push(r.text, JSON.stringify([...r.headers]));
    assert(
      r.headers.get('cache-control') === 'no-store',
      `${method} /provider/verification${path}: every response must be Cache-Control: no-store (${r.status})`,
    );
    return r;
  };
  const admin = async (method: 'GET' | 'POST' | 'PUT', path: string, token: string | null, body?: unknown): Promise<Reply> => {
    const r = await request(`/admin/trust${path}`, method, token, body);
    assert(r.headers.get('cache-control') === 'no-store', `${method} /admin/trust${path}: every response must be Cache-Control: no-store (${r.status})`);
    return r;
  };
  const refusal = (r: Reply, status: number, code: string, what: string): Reply => {
    assert(
      r.status === status && r.json?.error?.code === code,
      `${what}: expected ${status} ${code}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)}`,
    );
    assert(
      r.json.error.details?.messageKey === `trust.verification.error.${code.replace(/^TRUST_/, '').toLowerCase()}`,
      `${what}: the error must carry its content message key`,
    );
    return r;
  };
  /** The standard EICAR antivirus TEST string: harmless by design; the fake scanner reports a file that contains it INFECTED. */
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% BananaGig DEV/TEST synthetic evidence ${label} ${runId}\n%%EOF\n`, 'latin1');
  const requirementOf = (v: Json, code: string): Json => v.requirements.find((r: Json) => r.requirementCode === code);

  // ---- Keycloak: the throwaway identity (customer realm role only)
  const kcToken = await kcMasterToken();
  const kcAdmin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; location: string | null }> => {
    const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, {
      method,
      headers: { authorization: `Bearer ${kcToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  let kcUserId = '';
  const database = createDatabase(env('DATABASE_URL', ''), { role: 'tests' });
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = new FakeSmsInbox(valkey);
  let adminToken = '';
  let marketCreated = false;
  let ruleOn = false;
  let definitionOn = false;
  try {
    const created = await kcAdmin('POST', '/users', {
      username,
      enabled: true,
      email: `kc-${email}`,
      emailVerified: true,
      firstName: 'Trust',
      lastName: 'Smoke',
      attributes: { 'bananagig.devOnly': ['true'] },
    });
    assert(created.status === 201 && !!created.location, `(1) creating the throwaway Keycloak user -> ${created.status} ${JSON.stringify(created.json)}`);
    kcUserId = created.location!.split('/').pop()!;
    const role = await kcAdmin('GET', '/roles/customer');
    assert((await kcAdmin('POST', `/users/${kcUserId}/role-mappings/realm`, [role.json])).status === 204, '(1) mapping the customer realm role');
    assert(
      (await kcAdmin('PUT', `/users/${kcUserId}/reset-password`, { type: 'password', value: password, temporary: false })).status === 204,
      '(1) setting the throwaway password',
    );
    const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, username, password });
    const token = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: login.code,
        codeVerifier: login.verifier,
      })
    ).accessToken;
    const accountId = AccountResponse.parse((await request('/account/me', 'GET', token)).json).data.accountId;
    const adminLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
    adminToken = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-admin',
        redirectUri: ADMIN_REDIRECT_URI,
        code: adminLogin.code,
        codeVerifier: adminLogin.verifier,
      })
    ).accessToken;
    const laocBefore = (await request('/geography/markets/la-oc', 'GET', adminToken)).json.data.status as string;

    // (2) not a provider yet and not verified: the prerequisites are real and the requirements policy applies to a provider, not to a customer
    const v0 = ok(await provider('GET', '', token), 200, '(2) GET /provider/verification');
    assert(
      v0.prerequisiteMet === false && v0.case === null && v0.overall.status === 'NOT_STARTED' && v0.goLive.evaluated === false && v0.goLive.eligible === false,
      `(2) before registering: nothing met, no case, Go-Live not evaluated (${JSON.stringify(v0.overall)})`,
    );
    refusal(await provider('POST', '', token, {}), 409, 'TRUST_PREREQUISITE_NOT_MET', '(2) opening before the registration and the contacts');
    assert((await provider('GET', '', null)).status === 401, '(2) GET without a token must be 401');
    assert((await provider('POST', '', null, {})).status === 401, '(2) POST without a token must be 401');
    for (const [what, body] of [
      ['an account id', { accountId }],
      ['a status', { status: 'APPROVED' }],
      ['a case id', { verificationCaseId: accountId }],
    ] as const)
      assert((await provider('POST', '', token, body)).status === 400, `(2) an open request naming ${what} must be 400`);
    for (const path of ['/cases', '/policy'])
      assert((await admin('GET', path, token)).status === 403, `(2) a provider token must be 403 on /admin/trust${path}`);
    assert((await admin('GET', '/cases', null)).status === 401, '(2) admin routes without a token must be 401');

    // (3) the contacts are verified through the real flows (verification starts only after both), then a provider registration is started: the SAME account
    assert((await request('/account/email', 'POST', token, { email })).status === 200, '(3) setting the email');
    assert((await request('/account/email/verification/send', 'POST', token, {})).status === 200, '(3) sending the email verification');
    const message = await retry(
      async () => {
        const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
          messages: { ID: string }[] | null;
        };
        if (!found.messages?.length) throw new Error('the verification email has not arrived');
        return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
      },
      10,
      1000,
    );
    const emailCode = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
    assert(!!emailCode, '(3) the email code is missing from the delivered message');
    assert((await request('/account/email/verification/confirm-code', 'POST', token, { code: emailCode })).status === 200, '(3) confirming the email code');
    let tail = '';
    do tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    while (['901', '902', '903', '904', '905'].includes(tail.slice(-3)));
    const e164 = `+1202555${tail}`;
    await inbox.clear(e164);
    assert((await request('/account/phone', 'POST', token, { phone: `(202) 555-${tail}`, country: 'US' })).status === 200, '(3) setting the phone number');
    assert((await request('/account/phone/verification/send', 'POST', token, {})).status === 200, '(3) sending the SMS');
    const smsCode = extractSmsCode((await inbox.wait(e164, 1, 10_000))[0]!.body);
    assert(!!smsCode, '(3) the SMS code is missing');
    assert((await request('/account/phone/verification/confirm-code', 'POST', token, { code: smsCode })).status === 200, '(3) confirming the SMS code');
    assert((await request('/provider/registration', 'POST', token, {})).status === 201, '(3) starting the provider registration');

    // (4) the DEV/TEST market and the policy: identity verification applies to everyone; liability insurance is turned on for THIS market only, by a trust-admin
    await ensureDevtestGeography(adminToken);
    const geo = async (path: string, method: string, body?: unknown): Promise<Json> => {
      const r = await get(`${api}/api/v1/geography${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      assert([200, 201].includes(r.status), `${method} /geography${path} -> ${r.status}`);
      return r.json();
    };
    await geo('/markets', 'POST', {
      code: marketCode,
      name: `DEV/TEST trust smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    });
    marketCreated = true;
    await geo(`/markets/${marketCode}/activation`, 'POST', { active: true, reason: 'smoke test' });
    const policy0 = ok(await admin('GET', '/policy', adminToken), 200, '(4) GET /admin/trust/policy');
    const defOf = (p: Json, code: string): Json => p.requirements.find((r: Json) => r.code === code);
    assert(
      defOf(policy0, 'identity_verification')?.status === 'ACTIVE' && defOf(policy0, 'liability_insurance')?.status === 'INACTIVE',
      '(4) seeded: identity ACTIVE, insurance INACTIVE',
    );
    assert(
      policy0.rules
        .filter((r: Json) => r.enabled)
        .every((r: Json) => r.requirementCode === 'identity_verification' && r.marketCode === null && r.serviceTypeCode === null),
      '(4) the only seeded rule requires identity verification everywhere (no invented obligation)',
    );
    ok(await admin('PUT', '/requirement-definitions/liability_insurance/status', adminToken, { status: 'ACTIVE' }), 200, '(4) activate insurance');
    definitionOn = true;
    ok(
      await admin('PUT', '/requirement-rules', adminToken, { requirementCode: 'liability_insurance', marketCode, serviceTypeCode: null, enabled: true }),
      200,
      '(4) require insurance in the test market',
    );
    ruleOn = true;
    assert((await request('/provider/registration/market', 'PUT', token, { marketCode })).status === 200, '(4) choosing the test market in the registration');

    // (5) open the case: requirements derive from the registration's market; open is idempotent
    const before = ok(await provider('GET', '', token), 200, '(5) overview before opening');
    assert(
      before.prerequisiteMet === true &&
        before.case === null &&
        before.requirements.map((r: Json) => r.requirementCode).join() === 'identity_verification,liability_insurance',
      `(5) policy derives identity + insurance for the test market (${before.requirements.map((r: Json) => r.requirementCode)})`,
    );
    const opened = ok(await provider('POST', '', token, {}), 201, '(5) open');
    assert(
      opened.case.status === 'OPEN' && opened.requirements.every((r: Json) => r.status === 'NOT_STARTED' && r.caseRequirementId),
      '(5) a new case is OPEN with both requirements NOT_STARTED',
    );
    ok(await provider('POST', '', token, {}), 200, '(5) open again (resume)');
    assert(
      (await request('/provider/registration', 'GET', token)).json.data.registration.status === 'IN_PROGRESS',
      '(5) the registration lifecycle is not changed by verification',
    );
    const regReq0 = (await request('/provider/registration/requirements', 'GET', token)).json.data;
    assert(
      regReq0.steps.find((s: Json) => s.step === 'VERIFICATION').status === 'IN_PROGRESS',
      `(5) PRO-001 reports the VERIFICATION step from TRUST-001 (${regReq0.steps.find((s: Json) => s.step === 'VERIFICATION').status})`,
    );

    // (6) evidence: authorization rules, the private store, the server-side checks
    const up = (requirementCode: string, documentTypeCode: string, mimeType: string, sizeBytes: number) =>
      provider('POST', '/documents/upload', token, { requirementCode, documentTypeCode, mimeType, sizeBytes }, false);
    refusal(await up('identity_verification', 'drivers_license', 'text/html', 100), 400, 'TRUST_MIME_NOT_ALLOWED', '(6) a file type that is not allowed');
    assert(
      (await up('identity_verification', 'drivers_license', 'application/pdf', 999_999_999)).status === 400,
      '(6) a size above the structural ceiling must be 400',
    );
    refusal(
      await up('identity_verification', 'drivers_license', 'application/pdf', 20_000_000),
      400,
      'TRUST_FILE_TOO_LARGE',
      '(6) a size above the configured maximum',
    );
    refusal(
      await up('identity_verification', 'insurance_certificate', 'application/pdf', 100),
      400,
      'TRUST_DOCUMENT_TYPE_NOT_ACCEPTED',
      '(6) a document type of another requirement type',
    );
    refusal(
      await up('background_check', 'drivers_license', 'application/pdf', 100),
      409,
      'TRUST_REQUIREMENT_NOT_APPLICABLE',
      '(6) a requirement that does not apply',
    );
    const idBytes = pdf('identity');
    const putTo = async (a: Json, bytes: Buffer, type: string): Promise<number> => {
      const r = await fetch(a.upload.url, { method: 'PUT', headers: { 'content-type': type }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(8000) });
      return r.status;
    };
    const authorizeIdentity = async (bytes: Buffer, mime = 'application/pdf'): Promise<Json> =>
      ok(await up('identity_verification', 'drivers_license', mime, bytes.byteLength), 201, '(6) authorize an upload');
    // a spoofed file (HTML bytes declared as a PDF) is refused by the server after it is stored, the document is abandoned and the object is deleted
    const html = Buffer.from('<html><body>not a pdf</body></html>');
    const spoof = await authorizeIdentity(html);
    assert((await putTo(spoof, html, 'application/pdf')) < 300, '(6) the store accepts the PUT of the authorized object');
    refusal(
      await provider('POST', `/documents/${spoof.document.verificationDocumentId}/finalize`, token, {}),
      400,
      'TRUST_OBJECT_MISMATCH',
      '(6) a spoofed content type (signature)',
    );
    // the same for an infected file (the harmless EICAR antivirus test string)
    const eicar = Buffer.from(`%PDF-1.4\n${EICAR}\n%%EOF\n`, 'latin1');
    const infected = await authorizeIdentity(eicar);
    assert((await putTo(infected, eicar, 'application/pdf')) < 300, '(6) PUT of the EICAR test file');
    refusal(
      await provider('POST', `/documents/${infected.document.verificationDocumentId}/finalize`, token, {}),
      400,
      'TRUST_SCAN_INFECTED',
      '(6) an infected file',
    );
    // a wrong client hash is refused too
    const wrongHash = await authorizeIdentity(idBytes);
    assert((await putTo(wrongHash, idBytes, 'application/pdf')) < 300, '(6) PUT for the wrong-hash case');
    refusal(
      await provider('POST', `/documents/${wrongHash.document.verificationDocumentId}/finalize`, token, { sha256: '0'.repeat(64) }),
      400,
      'TRUST_OBJECT_MISMATCH',
      '(6) a client hash that differs from the stored bytes',
    );
    // finalize without any upload: the object is missing and the call can be repeated
    const missing = await authorizeIdentity(idBytes);
    refusal(
      await provider('POST', `/documents/${missing.document.verificationDocumentId}/finalize`, token, {}),
      400,
      'TRUST_OBJECT_MISSING',
      '(6) finalize before the upload',
    );
    // the good path
    const good = await authorizeIdentity(idBytes);
    assert(!JSON.stringify(good).includes(accountId) && good.upload.method === 'PUT', '(6) the authorization names no account');
    assert((await putTo(good, idBytes, 'application/pdf')) < 300, '(6) PUT of the evidence to the one-time URL');
    const attached = ok(
      await provider('POST', `/documents/${good.document.verificationDocumentId}/finalize`, token, { sha256: sha256(idBytes) }),
      200,
      '(6) finalize',
    );
    assert(
      attached.status === 'ATTACHED' && attached.scanStatus === 'CLEAN' && !('sha256' in attached) && !('objectKey' in attached),
      `(6) finalized: ATTACHED and CLEAN, no hash and no key for the provider (${JSON.stringify(attached)})`,
    );
    ok(await provider('POST', `/documents/${good.document.verificationDocumentId}/finalize`, token, {}), 200, '(6) finalize again (idempotent)');
    // the presigned PUT is still valid after finalize: a REPLAY with other bytes of the same size and type must change nothing the reviewers will see (the bytes were promoted to a
    // different key; the upload key is never read again). Whether the store accepts the replay is its business; what is stored as evidence is checked at the download below.
    const swapped = Buffer.from(idBytes);
    swapped.write('X', 20, 'latin1');
    await putTo(good, swapped, 'application/pdf').catch(() => 0);
    // the store should refuse a body whose length differs from the signed one; if it does not, finalize must (the size is checked after the bytes are stored)
    const longBytes = Buffer.concat([idBytes, Buffer.from('padding-padding')]);
    const sized = await authorizeIdentity(idBytes);
    const sizedStatus = await putTo(sized, longBytes, 'application/pdf').catch(() => 0);
    if (sizedStatus >= 200 && sizedStatus < 300)
      refusal(
        await provider('POST', `/documents/${sized.document.verificationDocumentId}/finalize`, token, {}),
        400,
        'TRUST_OBJECT_MISMATCH',
        '(6) a body longer than the authorized size',
      );
    else ok(await provider('POST', `/documents/${sized.document.verificationDocumentId}/withdraw`, token, {}), 200, '(6) withdraw the refused upload');
    const ids = await provider('GET', '/documents', token);
    assert(
      ids.json.data.some((d: Json) => d.status === 'ABANDONED') && ids.json.data.filter((d: Json) => d.status === 'ATTACHED').length === 1,
      '(6) the history keeps the abandoned uploads; one draft is attached',
    );
    // withdraw + replace
    ok(await provider('POST', `/documents/${missing.document.verificationDocumentId}/withdraw`, token, {}), 200, '(6) withdraw the pending document');
    // another account cannot touch it (customer.dev): not found, indistinguishable
    const otherLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const other = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: otherLogin.code,
        codeVerifier: otherLogin.verifier,
      })
    ).accessToken;
    refusal(
      await provider('POST', `/documents/${good.document.verificationDocumentId}/finalize`, other, {}),
      404,
      'TRUST_NOT_FOUND',
      '(6) another account finalizing this document',
    );
    refusal(
      await provider('POST', `/documents/${good.document.verificationDocumentId}/withdraw`, other, {}),
      404,
      'TRUST_NOT_FOUND',
      '(6) another account withdrawing this document',
    );
    const insBytes = pdf('insurance');
    const insAuth = ok(
      await up('liability_insurance', 'insurance_certificate', 'application/pdf', insBytes.byteLength),
      201,
      '(6) authorize the insurance document',
    );
    assert((await putTo(insAuth, insBytes, 'application/pdf')) < 300, '(6) PUT of the insurance evidence');
    ok(await provider('POST', `/documents/${insAuth.document.verificationDocumentId}/finalize`, token, {}), 200, '(6) finalize the insurance document');

    // (7) submit: a stale revision is refused; the submission moves both requirements to PENDING; a repeat changes nothing
    const toSubmit = ok(await provider('GET', '', token), 200, '(7) overview');
    refusal(await provider('POST', '/submit', token, { expectedRevision: toSubmit.case.revision + 5 }), 409, 'TRUST_STALE_CASE', '(7) a stale revision');
    const submitted = ok(await provider('POST', '/submit', token, { expectedRevision: toSubmit.case.revision }), 200, '(7) submit');
    assert(
      submitted.case.status === 'IN_REVIEW' && submitted.requirements.every((r: Json) => r.status === 'PENDING' && r.round === 1),
      `(7) both requirements are PENDING in round 1 (${submitted.requirements.map((r: Json) => `${r.requirementCode}:${r.status}`)})`,
    );
    const again = ok(await provider('POST', '/submit', token, { expectedRevision: submitted.case.revision }), 200, '(7) submit again (idempotent)');
    assert(again.case.revision === submitted.case.revision, '(7) a repeat submit changes nothing');
    refusal(
      await up('identity_verification', 'drivers_license', 'application/pdf', 100),
      409,
      'TRUST_EVIDENCE_NOT_ACCEPTED',
      '(7) no new evidence while the requirement is under review',
    );

    // (8) the reviewer (admin.dev, trust-read + trust-review): the queue, the case, the integrity hash, an audited short-lived link
    const queue = ok(await admin('GET', '/cases?status=IN_REVIEW&limit=50', adminToken), 200, '(8) the reviewers queue');
    const mine = queue.find((c: Json) => c.accountId === accountId);
    assert(
      !!mine && mine.awaitingReviewCount === 2 && !('email' in mine) && !('name' in mine),
      '(8) the case is in the queue with the internal account id only',
    );
    const detail = ok(await admin('GET', `/cases/${mine.verificationCaseId}`, adminToken), 200, '(8) the case');
    const idReq = detail.requirements.find((r: Json) => r.requirementCode === 'identity_verification');
    const insReq = detail.requirements.find((r: Json) => r.requirementCode === 'liability_insurance');
    const idDoc = idReq.documents.find((d: Json) => d.status === 'SUBMITTED');
    assert(idDoc.sha256 === sha256(idBytes) && idDoc.round === 1, '(8) the SERVER-computed SHA-256 of the stored bytes is recorded for the reviewers');
    assert(!/trust\/evidence|X-Amz|objectKey/.test(JSON.stringify(detail)), '(8) the case view carries no object key and no link');
    const link = ok(await admin('GET', `/documents/${idDoc.verificationDocumentId}/download`, adminToken), 200, '(8) download link');
    const fetched = Buffer.from(await (await fetch(link.url, { signal: AbortSignal.timeout(8000) })).arrayBuffer());
    assert(fetched.equals(idBytes), '(8) the link serves exactly the bytes that were hashed and scanned (a replayed PUT changed nothing)');
    assert(
      (await fetch(link.url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)), { signal: AbortSignal.timeout(8000) })).status >= 400,
      '(8) a tampered link is refused by the store',
    );

    // (9) decisions: structured reasons, the round, stale and repeated decisions
    const round = idReq.round as number;
    assert(round === 1, '(9) the evidence is in round 1');
    ok(await admin('POST', `/requirements/${idReq.caseRequirementId}/start-review`, adminToken, { round }), 200, '(9) start review');
    const approve = ok(await admin('POST', `/requirements/${idReq.caseRequirementId}/approve`, adminToken, { round }), 200, '(9) approve identity');
    assert(
      approve.changed === true && approve.requirement.status === 'APPROVED' && approve.caseStatus === 'IN_REVIEW',
      '(9) identity is APPROVED; the case still waits for the insurance',
    );
    const approveAgain = ok(await admin('POST', `/requirements/${idReq.caseRequirementId}/approve`, adminToken, { round }), 200, '(9) approve again');
    assert(approveAgain.changed === false, '(9) the same decision again is a no-op');
    refusal(
      await admin('POST', `/requirements/${idReq.caseRequirementId}/reject`, adminToken, { round, reasonCode: 'DOCUMENT_UNREADABLE' }),
      409,
      'TRUST_ALREADY_DECIDED',
      '(9) a different decision on the same evidence',
    );
    refusal(
      await admin('POST', `/requirements/${insReq.caseRequirementId}/request-action`, adminToken, { round: 99, reasonCode: 'DOCUMENT_UNREADABLE' }),
      409,
      'TRUST_STALE_ROUND',
      '(9) a decision on a round that does not exist',
    );
    refusal(
      await admin('POST', `/requirements/${insReq.caseRequirementId}/request-action`, adminToken, { round, reasonCode: 'NOT_A_REASON' }),
      400,
      'TRUST_REASON_INVALID',
      '(9) a reason code that does not exist',
    );
    const asked = ok(
      await admin('POST', `/requirements/${insReq.caseRequirementId}/request-action`, adminToken, { round, reasonCode: 'DOCUMENT_UNREADABLE' }),
      200,
      '(9) request action on the insurance',
    );
    assert(asked.requirement.status === 'ACTION_REQUIRED' && asked.caseStatus === 'ACTION_REQUIRED', '(9) the insurance needs action and so does the case');

    // (10) the provider sees the reason, PRO-001 reports the step as blocked, and the registration is unchanged
    const needs = ok(await provider('GET', '', token), 200, '(10) overview');
    const insNeeds = requirementOf(needs, 'liability_insurance');
    assert(
      insNeeds.status === 'ACTION_REQUIRED' && insNeeds.reasonKey === 'trust.reason.document_unreadable.name' && insNeeds.canAttachEvidence === true,
      '(10) the insurance shows its structured reason and takes new evidence',
    );
    assert(
      requirementOf(needs, 'identity_verification').status === 'APPROVED' && needs.overall.verificationComplete === false,
      '(10) identity approved, verification not complete',
    );
    assert(
      (await request('/provider/registration/requirements', 'GET', token)).json.data.steps.find((s: Json) => s.step === 'VERIFICATION').status === 'BLOCKED',
      '(10) PRO-001 reports the VERIFICATION step BLOCKED while action is required',
    );

    // (11) resubmission through the WEB app behind Caddy (the browser posts the file to the handler; the handler talks to the store): history is kept
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[]; headers: http.IncomingHttpHeaders };
    const caddy = (method: 'GET' | 'POST', path: string, o: { cookie?: string; origin?: string; body?: Buffer; contentType?: string } = {}): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: 'caddy-proxy',
            port: 80,
            path,
            method,
            headers: {
              host: 'app.localhost',
              ...(o.cookie ? { cookie: o.cookie } : {}),
              ...(o.origin ? { origin: o.origin } : {}),
              ...(o.body ? { 'content-length': String(o.body.byteLength), 'content-type': o.contentType ?? 'application/x-www-form-urlencoded' } : {}),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, location: res.headers.location, body, cookies: res.headers['set-cookie'] ?? [], headers: res.headers }),
            );
          },
        );
        req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end(o.body);
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const multipart = (fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }): { body: Buffer; contentType: string } => {
      const boundary = `----bg${randomBytes(12).toString('hex')}`;
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(
        Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`),
        file.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      );
      return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
    };
    const anon = await caddy('GET', '/provider/verification');
    assert(
      anon.status === 200 && anon.body.includes('/auth/login?returnTo=/provider/verification') && !/<form\b/.test(anon.body),
      '(11) signed out: sign-in is offered and no form exists',
    );
    assert((await caddy('GET', '/auth/provider/verification/upload')).status === 405, '(11) GET on the upload handler must be 405 (no GET changes state)');
    assert((await caddy('POST', '/auth/provider/verification/open', { body: Buffer.from('') })).status === 403, '(11) POST without an Origin must be 403');
    const start = await caddy('GET', '/auth/login?returnTo=/provider/verification');
    absorb(start);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, username, password });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, { cookie: cookie() });
    absorb(callback);
    assert(
      callback.status === 302 && (callback.location ?? '').endsWith('/provider/verification') && jar.has('bg_session'),
      `(11) web callback failed (${callback.status} ${callback.location})`,
    );
    const page = await caddy('GET', '/provider/verification', { cookie: cookie() });
    assert(
      page.status === 200 && !page.body.includes(token) && !page.body.includes(accountId) && !/trust\/evidence|X-Amz/.test(page.body),
      '(11) the verification page leaks no token, account id, key or link',
    );
    assert(
      /enctype="multipart\/form-data"/i.test(page.body) &&
        /<label[^>]*for="file-liability_insurance"/.test(page.body) &&
        /name="file"[^>]*type="file"|type="file"[^>]*name="file"/.test(page.body),
      `(11) the insurance requirement offers a labelled multipart file form (forms: ${(page.body.match(/<form\b[^>]*>/g) ?? []).join(' | ').slice(0, 600)}; alert: ${(/role="alert"[^>]*>([^<]*)/.exec(page.body) ?? [])[1] ?? 'none'}; inputs: ${(page.body.match(/<(input|select|label)\b[^>]*>/g) ?? []).join(' ').slice(0, 600)})`,
    );
    assert(!/href="[^"]*download/i.test(page.body) && !/action="[^"]*approve/i.test(page.body), '(11) the page has no download link and no approve control');
    const insBytes2 = pdf('insurance-2');
    const m = multipart(
      { requirementCode: 'liability_insurance', documentTypeCode: 'insurance_certificate' },
      { name: 'insurance.pdf', type: 'application/pdf', bytes: insBytes2 },
    );
    const wrongOrigin = await caddy('POST', '/auth/provider/verification/upload', {
      cookie: cookie(),
      origin: 'http://evil.example',
      body: m.body,
      contentType: m.contentType,
    });
    assert(wrongOrigin.status === 403, '(11) a foreign Origin is refused');
    const uploaded = await caddy('POST', '/auth/provider/verification/upload', {
      cookie: cookie(),
      origin: webOrigin,
      body: m.body,
      contentType: m.contentType,
    });
    assert(
      uploaded.status === 303 && (uploaded.location ?? '').endsWith('/provider/verification?notice=uploaded'),
      `(11) the web upload must end in a notice (${uploaded.status} ${uploaded.location})`,
    );
    assert(!(uploaded.location ?? '').includes('insurance.pdf'), '(11) the file name is not in the redirect');
    const draftPage = await caddy('GET', '/provider/verification?notice=uploaded', { cookie: cookie() });
    assert(
      /action="\/auth\/provider\/verification\/submit"/.test(draftPage.body),
      '(11) with every waiting requirement holding a draft, the page offers Submit',
    );
    const revisionOnPage = (/name="expectedRevision"[^>]*value="(\d+)"/.exec(draftPage.body) ?? [])[1];
    assert(!!revisionOnPage, '(11) the submit form carries the revision');
    const submitWeb = await caddy('POST', '/auth/provider/verification/submit', {
      cookie: cookie(),
      origin: webOrigin,
      body: Buffer.from(new URLSearchParams({ expectedRevision: revisionOnPage! }).toString()),
    });
    assert(
      submitWeb.status === 303 && (submitWeb.location ?? '').endsWith('/provider/verification?notice=submitted'),
      `(11) the web submit must end in a notice (${submitWeb.status} ${submitWeb.location})`,
    );
    const history = (await provider('GET', '/documents', token)).json.data as Json[];
    assert(
      history.filter((d) => d.status === 'SUBMITTED' && d.round === 1).length === 2 && history.some((d) => d.status === 'SUBMITTED' && d.round === 2),
      '(11) resubmission preserved the round-1 evidence and added the round-2 document',
    );

    // (12) the second round: approve with an end date (insurance expires), the case is approved, PRO-001 reports COMPLETE, Go-Live untouched
    const afterResubmit = ok(await admin('GET', `/cases/${mine.verificationCaseId}`, adminToken), 200, '(12) the case');
    const ins2 = afterResubmit.requirements.find((r: Json) => r.requirementCode === 'liability_insurance' && !r.superseded);
    assert(
      ins2.round === 2 && ins2.status === 'PENDING' && ins2.reviews.some((r: Json) => r.round === 1 && r.decision === 'ACTION_REQUIRED'),
      '(12) round 2 is pending and the round-1 decision is kept',
    );
    refusal(
      await admin('POST', `/requirements/${ins2.caseRequirementId}/approve`, adminToken, { round: 2 }),
      400,
      'TRUST_VALIDATION_FAILED',
      '(12) an approval of an expiring requirement needs an end date',
    );
    refusal(
      await admin('POST', `/requirements/${ins2.caseRequirementId}/approve`, adminToken, { round: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      409,
      'TRUST_STALE_ROUND',
      '(12) the earlier round is stale now',
    );
    const expiresAt = new Date(Date.now() + 4000).toISOString();
    const approvedIns = ok(
      await admin('POST', `/requirements/${ins2.caseRequirementId}/approve`, adminToken, { round: 2, expiresAt }),
      200,
      '(12) approve insurance with an end date',
    );
    assert(approvedIns.requirement.status === 'APPROVED' && approvedIns.caseStatus === 'APPROVED', '(12) the case is APPROVED');
    const complete = ok(await provider('GET', '', token), 200, '(12) overview');
    assert(
      complete.overall.status === 'APPROVED' &&
        complete.overall.verificationComplete === true &&
        complete.goLive.evaluated === false &&
        complete.goLive.eligible === false,
      '(12) verification complete, and Go-Live is not evaluated',
    );
    const regReq = (await request('/provider/registration/requirements', 'GET', token)).json.data;
    assert(
      regReq.steps.find((s: Json) => s.step === 'VERIFICATION').status === 'COMPLETE' && regReq.overall.goLive.evaluated === false,
      '(12) PRO-001 reports VERIFICATION COMPLETE and still does not evaluate Go-Live',
    );
    assert(
      (await request('/provider/registration', 'GET', token)).json.data.registration.status === 'IN_PROGRESS',
      '(12) the registration lifecycle is independent of verification',
    );

    // (13) expiry is derived from the timestamp; the original approval stays as history; a new cycle re-verifies
    await sleep(4500);
    const expired = ok(await provider('GET', '', token), 200, '(13) overview after the end date');
    const insExpired = requirementOf(expired, 'liability_insurance');
    assert(
      insExpired.status === 'EXPIRED' &&
        expired.overall.status === 'EXPIRED' &&
        insExpired.canReverify === true &&
        expired.overall.verificationComplete === false,
      '(13) an approval past its end reads EXPIRED (derived), complete is false again',
    );
    refusal(
      await provider('POST', '/requirements/identity_verification/reverify', token, {}),
      409,
      'TRUST_NOT_REVERIFIABLE',
      '(13) a requirement that has not expired cannot be re-verified',
    );
    const reverified = ok(await provider('POST', '/requirements/liability_insurance/reverify', token, {}), 200, '(13) reverify');
    const insCycle2 = requirementOf(reverified, 'liability_insurance');
    assert(
      insCycle2.cycle === 2 && insCycle2.status === 'NOT_STARTED' && reverified.case.status === 'ACTION_REQUIRED',
      '(13) cycle 2 starts NOT_STARTED and the case needs action',
    );
    const cycles = await database.query<{ cycle: number; status: string; superseded: boolean; has_approval: boolean }>(
      `SELECT cr.cycle, cr.status, cr.superseded_at IS NOT NULL AS superseded, cr.approved_at IS NOT NULL AS has_approval
         FROM trust.case_requirements cr JOIN trust.requirement_definitions d USING (requirement_definition_id)
        WHERE cr.verification_case_id = $1 AND d.code = 'liability_insurance' ORDER BY cr.cycle`,
      [mine.verificationCaseId],
    );
    assert(
      cycles.length === 2 && cycles[0]!.superseded && cycles[0]!.status === 'EXPIRED' && cycles[0]!.has_approval && !cycles[1]!.superseded,
      `(13) cycle 1 (with its approval) is kept as history (${JSON.stringify(cycles)})`,
    );

    // (14) audit and events: complete, exactly once, and free of evidence, keys, links and hashes
    const audit = await database.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM trust.audit_events WHERE verification_case_id = $1 GROUP BY action`,
      [mine.verificationCaseId],
    );
    const a = Object.fromEntries(audit.map((r) => [r.action, r.n]));
    assert(
      a.VERIFICATION_CASE_OPENED === 1 &&
        a.VERIFICATION_SUBMITTED === 2 &&
        a.VERIFICATION_APPROVED === 2 &&
        a.VERIFICATION_ACTION_REQUIRED === 1 &&
        a.VERIFICATION_REVIEW_STARTED === 1 &&
        a.VERIFICATION_EXPIRED === 1 &&
        a.VERIFICATION_REVERIFICATION_REQUESTED === 1 &&
        a.VERIFICATION_DOCUMENT_ACCESSED === 1 &&
        (a.VERIFICATION_DOCUMENT_SUBMITTED ?? 0) >= 3 &&
        (a.VERIFICATION_DOCUMENT_UPLOAD_REFUSED ?? 0) >= 3,
      `(14) the audit trail holds every action exactly as often as it happened (${JSON.stringify(a)})`,
    );
    const events = await database.query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.trust.%' AND payload_json->>'verificationCaseId' = $1::text GROUP BY event_type`,
      [mine.verificationCaseId],
    );
    const e = Object.fromEntries(events.map((r) => [r.event_type, r.n]));
    assert(
      e['bananagig.trust.verification-case-opened.v1'] === 1 &&
        e['bananagig.trust.verification-submitted.v1'] === 2 &&
        e['bananagig.trust.verification-requirement-approved.v1'] === 2 &&
        e['bananagig.trust.verification-action-required.v1'] === 1 &&
        e['bananagig.trust.verification-completed.v1'] === 1 &&
        e['bananagig.trust.verification-expired.v1'] === 1,
      `(14) the outbox holds each event exactly once (${JSON.stringify(e)})`,
    );
    const stored = await database.query<{ s: string }>(
      `SELECT (SELECT string_agg(changes::text, ' ') FROM trust.audit_events WHERE verification_case_id = $1) || ' ' ||
              (SELECT string_agg(payload_json::text, ' ') FROM integration.outbox_events WHERE event_type LIKE 'bananagig.trust.%' AND payload_json->>'verificationCaseId' = $1::text) AS s`,
      [mine.verificationCaseId],
    );
    assert(
      !/trust\/evidence|X-Amz|[0-9a-f]{64}/.test(stored[0]!.s) && !stored[0]!.s.includes(email) && !stored[0]!.s.includes(e164),
      '(14) no object key, link, hash or contact in the audit trail or the outbox',
    );
    const columns = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'trust' AND (column_name ~* 'email|phone|password|name|address|body|note|text|content$' AND column_name !~* 'content_key|object_key|mime_type|code|reviewer|requirement_type')`,
    );
    assert(columns[0]!.n === 0, `(14) the trust schema holds no personal-data or free-text column (${columns[0]!.n})`);
    const everything = seen.join('\n');
    for (const [what, value] of [
      ['email', email],
      ['phone', e164],
      ['account id', accountId],
      ['access token', token],
      ['password', password],
      ['object key', 'trust/evidence'],
      ['signature', 'X-Amz-Signature'],
      ['document hash', sha256(idBytes)],
    ] as const)
      assert(!everything.includes(value), `(14) a provider verification response contains the ${what}`);
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    for (const [what, q] of [
      ['signature', '{service_name=~"bananagig-.+"} |= `X-Amz-Signature`'],
      ['object key', '{service_name=~"bananagig-.+"} |= `trust/evidence`'],
      ['document hash', `{service_name=~"bananagig-.+"} |= \`${sha256(idBytes)}\``],
      ['email', `{service_name=~"bananagig-.+"} |= \`${email}\``],
      ['access token', `{service_name=~"bananagig-.+"} |= \`${token}\``],
    ] as const)
      assert((await query(q)).data.result.length === 0, `(14) the ${what} appears in the logs`);
    // no span carries a signed URL: a trace backend is also a log
    const tempo = env('TEMPO_URL', 'http://tempo-traces:3200');
    for (const q of ['{ name =~ ".*X-Amz-Signature.*" }', '{ span.http.url =~ ".*X-Amz-Signature.*" }', '{ span.url.full =~ ".*X-Amz-Signature.*" }']) {
      const r = await get(
        `${tempo}/api/search?q=${encodeURIComponent(q)}&limit=5&start=${Math.floor(flowStart / 1e9) - 60}&end=${Math.floor(Date.now() / 1000) + 60}`,
      );
      const found = r.ok ? (((await r.json()) as { traces?: unknown[] }).traces ?? []) : [];
      assert(found.length === 0, `(14) a trace span carries a signed URL (${q})`);
    }
    const laocAfter = (await request('/geography/markets/la-oc', 'GET', adminToken)).json.data.status as string;
    assert(laocAfter === laocBefore, `(14) la-oc must stay as it was (${laocBefore} -> ${laocAfter})`);

    return (
      `throwaway provider (contacts verified through the real flows, registration started on the SAME account); policy: identity verification everywhere, insurance turned on for a DEV/TEST market by a trust-admin; ` +
      `case opened from the registration (idempotent), PRO-001 reports the VERIFICATION step from TRUST-001; private store: one-object presigned PUT, server-side size/type/signature/SHA-256 checks, spoofed, infected, wrong-hash and missing uploads refused, ` +
      `another account gets 404; submit (stale revision 409, idempotent), reviewer queue, audited short-lived link serving the exact bytes, structured decisions on a named round (stale/duplicate refused), resubmission through the web app keeps round 1; ` +
      `approval with an end date, expiry derived from the timestamp, new cycle keeps the old approval; Go-Live never evaluated; audit and outbox exact; no key, link, hash or contact in responses, audit, outbox or logs; la-oc ${laocBefore} untouched`
    );
  } finally {
    // cleanup: the policy is put back (rule off, definition INACTIVE), the DEV/TEST market deactivated, the throwaway Keycloak user removed. Cases and evidence stay (history is never deleted).
    try {
      if (adminToken && ruleOn)
        await request('/admin/trust/requirement-rules', 'PUT', adminToken, {
          requirementCode: 'liability_insurance',
          marketCode,
          serviceTypeCode: null,
          enabled: false,
        });
      if (adminToken && definitionOn)
        await request('/admin/trust/requirement-definitions/liability_insurance/status', 'PUT', adminToken, { status: 'INACTIVE' });
      if (adminToken && marketCreated)
        await request('/geography/markets/' + marketCode + '/activation', 'POST', adminToken, { active: false, reason: 'smoke cleanup' });
    } catch {
      // best effort: the failure that got us here is the one to report
    }
    try {
      if (kcUserId) await kcAdmin('DELETE', `/users/${kcUserId}`);
    } catch {
      // best effort
    }
    valkey.disconnect();
    await database.close();
  }
});

// ---------------------------------------------------------------- Provider GigMenu and Gig versioning (CAT-003)
await check('Provider GigMenu', async () => {
  // The provider GigMenu (CAT-003) end to end with REAL Keycloak tokens and a THROWAWAY customer-only identity (created through the Keycloak admin API and deleted at the end). The
  // identity becomes a provider through the REAL flows (Mailpit email, fake SMS sink, the consent API, the registration API), in an isolated DEV/TEST market (ZZ) with its own
  // category, service type and Gig Template (published by admin.dev; retired or deactivated at the end). Then it builds Gigs from the template through the owner-only API: exact
  // template-version binding, eager draft validation, completeness at publish, optimistic revisions, publish/supersede/retire, the GigMenu and its readiness facts, a second account
  // (customer.dev) that gets 404, and the web pages behind Caddy. A Gig is NOT live: Go-Live is never evaluated, and no service-area, availability or search field exists in any response (variants, add-ons and media are CAT-004 and have their own scenario).
  // Assumptions: DATABASE_URL (read-only SELECTs on the Gig tables, audit and outbox), LOKI_URL, MAILPIT_URL, VALKEY_URL, KEYCLOAK_ADMIN*, the legal versions published by the
  // 'Consent' scenario, and the Gig API of apps/api (routes under /api/v1/provider, error codes either GIG-prefixed or as named in the contract).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any; // parsed response bodies are checked field by field below
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cid = `smoke-gigs-${runId}`;
  const flowStart = Date.now() * 1e6;
  const marketCode = `devtest-gig-${runId}`;
  const categoryCode = `devtest_gigc_${runId}`;
  const serviceType = `devtest_gigs_${runId}`;
  const tpl = `devtest_gig_${runId}`;
  const key = (suffix: string): string => `catalog.gig_template.${tpl}.${suffix}`;
  const username = `cat003.${runId}`;
  const password = `Pw-${randomBytes(9).toString('hex')}`; // secret-scan:allow throwaway DEV/TEST identity, deleted at the end
  const email = `cat003-${runId}@bananagig.localhost`;
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // the provider text of this run (plain text; unique per run so it can be searched for in the audit trail, the outbox and the logs)
  const title1 = `Smoke Gig Title ${runId}`;
  const pitch1 = `Smoke gig pitch ${runId}`;
  const description1 = `Smoke gig description ${runId}.\nSecond line.`;
  const notes1 = `Bring the keys ${runId}`;
  const title2 = `Smoke Gig Title ${runId} second`;
  const providerText = [title1, pitch1, `Smoke gig description ${runId}`, notes1, title2];
  const seen: string[] = []; // every PROVIDER Gig response (body and headers): searched for forbidden fields, identifiers, contacts and tokens
  await clearLimiterBuckets('email-verification');
  await clearLimiterBuckets('phone-verification');

  type Reply = { status: number; text: string; json: Json; headers: Headers };
  const request = async (path: string, method: string, token: string | null, body?: unknown): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const mgmt = async (
    module: 'catalog' | 'geography' | 'content',
    admin: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses = [200, 201],
  ): Promise<Reply> => {
    const r = await request(`/${module}${path}`, method, admin, body);
    assert(okStatuses.includes(r.status), `${method} /${module}${path} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };
  /** The provider Gig API (every response is kept for the scans at the end and must be Cache-Control: no-store). */
  const gig = async (method: 'GET' | 'POST' | 'PUT', path: string, token: string | null, body?: unknown): Promise<Reply> => {
    const r = await request(`/provider${path}`, method, token, body);
    seen.push(r.text, JSON.stringify([...r.headers]));
    assert(r.headers.get('cache-control') === 'no-store', `${method} /provider${path}: every Gig response must be Cache-Control: no-store (${r.status})`);
    return r;
  };
  const registration = (method: 'GET' | 'POST' | 'PUT', path: string, token: string | null, body?: unknown): Promise<Reply> =>
    request(`/provider/registration${path}`, method, token, body);
  const account = (token: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Reply> =>
    request(`/account${path}`, method, token, body);
  /** The wire code of a Gig error is the contract code, optionally behind a GIG_ prefix. */
  const isCode = (wire: unknown, code: string): boolean => wire === code || wire === `GIG_${code}`;
  const refusal = (r: Reply, statuses: number[], codes: string[], what: string): Reply => {
    assert(
      statuses.includes(r.status) && codes.some((c) => isCode(r.json?.error?.code, c)),
      `${what}: expected ${statuses.join('|')} ${codes.join('|')}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)}`,
    );
    const mk = r.json.error.details?.messageKey;
    if (mk !== undefined)
      assert(
        codes.some((c) => mk === gigErrorKey(c as never)),
        `${what}: the error message key ${mk} does not belong to ${codes.join('|')}`,
      );
    return r;
  };
  const hasIssue = (r: Reply, reason: string, fieldKey?: string): boolean =>
    Array.isArray(r.json?.error?.details?.issues) &&
    r.json.error.details.issues.some(
      (i: Json) => i.reason === reason && (fieldKey === undefined || i.fieldKey === fieldKey) && i.messageKey === `provider.gig.issue.${reason.toLowerCase()}`,
    );
  type Parser = { safeParse(v: unknown): Json };
  /** An expected success whose body must match the published contract. Returns the `data` member. */
  const read = (schema: Parser, r: Reply, status: number, what: string): Json => {
    assert(r.status === status, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`);
    const p = schema.safeParse(r.json);
    if (!p.success) throw new Error(`${what}: the response does not match its contract: ${String(p.error?.message).slice(0, 400)}`);
    return p.data.data;
  };
  const byNumber = (d: Json, n: number): Json => d.versions.find((v: Json) => v.versionNumber === n);
  const fieldValueMap = (v: Json): string => JSON.stringify(Object.fromEntries(v.fieldValues.map((f: Json) => [f.fieldKey, f.value]).sort()));
  const fieldOf = (v: Json, k: string): Json => v.fields.find((f: Json) => f.fieldKey === k);

  // ---- Keycloak: the throwaway identity (customer realm role only; the account starts as a customer)
  const kcToken = await kcMasterToken();
  const kcAdmin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; location: string | null }> => {
    const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, {
      method,
      headers: { authorization: `Bearer ${kcToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  let kcUserId = '';
  const database = createDatabase(env('DATABASE_URL', ''), { role: 'tests' });
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = new FakeSmsInbox(valkey);
  let admin = '';
  let marketCreated = false;
  let templateRetired = false;
  try {
    // (1) the throwaway identity, an admin token for the catalogue, the owner's market status
    const created = await kcAdmin('POST', '/users', {
      username,
      enabled: true,
      email: `kc-${email}`,
      emailVerified: true,
      firstName: 'Gig',
      lastName: 'Smoke',
      attributes: { 'bananagig.devOnly': ['true'] },
    });
    assert(created.status === 201 && !!created.location, `(1) creating the throwaway Keycloak user -> ${created.status} ${JSON.stringify(created.json)}`);
    kcUserId = created.location!.split('/').pop()!;
    const role = await kcAdmin('GET', '/roles/customer');
    assert(role.status === 200, `(1) the customer realm role -> ${role.status}`);
    assert((await kcAdmin('POST', `/users/${kcUserId}/role-mappings/realm`, [role.json])).status === 204, '(1) mapping the customer realm role');
    assert(
      (await kcAdmin('PUT', `/users/${kcUserId}/reset-password`, { type: 'password', value: password, temporary: false })).status === 204,
      '(1) setting the throwaway password',
    );
    const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, username, password });
    const token = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: login.code,
        codeVerifier: login.verifier,
      })
    ).accessToken;
    const me = AccountResponse.parse((await account(token, '/me')).json).data;
    const accountId = me.accountId;
    assert(uuidRe.test(accountId) && me.status === 'ACTIVE', '(1) the account is created on the first request and ACTIVE');
    const adminLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
    admin = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-admin',
        redirectUri: ADMIN_REDIRECT_URI,
        code: adminLogin.code,
        codeVerifier: adminLogin.verifier,
      })
    ).accessToken;
    const laocBefore = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;

    // (2) the platform side: a DEV/TEST market, category, service type and an ACTIVE Gig Template (v1 published) offered in the market. The template allows a fixed price and has
    // a fixed text, a required ENUM, an optional DURATION, an optional BOOLEAN and an optional bounded TEXT: no media, so the Gig can be complete in CAT-003.
    await ensureDevtestGeography(admin);
    await mgmt('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST gig smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    });
    marketCreated = true;
    const publishCopy = async (k: string, text: string): Promise<void> => {
      await mgmt('content', admin, 'POST', '/entries', {
        key: k,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY Gig smoke entry',
        approvalPolicy: 'NONE',
      });
      const v = (await mgmt('content', admin, 'POST', `/entries/${k}/versions`, { locale: 'en-US', body: text, reason: 'smoke test' })).json.data;
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/submit`, {});
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/publish`, {});
    };
    await publishCopy(`catalog.category.${categoryCode}.name`, `Smoke Gig Category ${runId}`);
    await publishCopy(`catalog.service_type.${serviceType}.name`, `Smoke Gig Service ${runId}`);
    await publishCopy(key('name'), `Smoke Gig Template ${runId}`);
    await mgmt('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/service-types', { code: serviceType, categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/gig-templates', {
      code: tpl,
      serviceTypeCode: serviceType,
      withDescription: false,
      withInstructions: false,
      reason: 'DEV/TEST ONLY smoke template',
    });
    await mgmt('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/service-types/${serviceType}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'launch' });
    await publishCopy(key('field.inclusions.label'), 'What is included');
    await publishCopy(key('field.inclusions.default'), 'Exterior wash, interior vacuum, windows.');
    await publishCopy(key('field.finish.label'), 'Finish');
    await publishCopy(key('field.finish.option.wax.label'), 'Wax');
    await publishCopy(key('field.finish.option.sealant.label'), 'Sealant');
    await publishCopy(key('field.extra_time.label'), 'Extra time');
    await publishCopy(key('field.bring_water.label'), 'Bring your own water');
    await publishCopy(key('field.vehicle_notes.label'), 'Vehicle notes');
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'DEV/TEST ONLY first draft' });
    const definition = {
      expectedRevision: 1,
      duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
      pricingModels: ['FIXED'],
      areaModes: ['RADIUS'],
      fields: [
        { fieldKey: 'inclusions', fieldType: 'LONG_TEXT', section: 'INCLUSIONS', behavior: 'PLATFORM_FIXED', withDefaultText: true },
        { fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }] },
        { fieldKey: 'extra_time', fieldType: 'DURATION', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 15, maxNumber: 120 },
        { fieldKey: 'bring_water', fieldType: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE', defaultBoolean: false },
        { fieldKey: 'vehicle_notes', fieldType: 'TEXT', behavior: 'PROVIDER_CONFIGURABLE', maxLength: 80 },
      ],
      requirements: [{ requirementType: 'INSURANCE' }],
      reason: 'DEV/TEST ONLY fields',
    };
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, definition);
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${serviceType}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' });
    const tplVersionRow = async (versionNumber: number): Promise<string> => {
      const rows = await database.query<{ id: string }>(
        `SELECT v.gig_template_version_id AS id FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE t.code = $1 AND v.version_number = $2`,
        [tpl, versionNumber],
      );
      assert(rows.length === 1, `(2) template ${tpl} version ${versionNumber} must exist exactly once`);
      return rows[0]!.id;
    };
    const tplV1 = await tplVersionRow(1);

    // (3) before anything: every Gig route needs the caller's own token, strict bodies refuse any owner/status/currency, and a customer is not eligible
    for (const [method, path, body] of [
      ['GET', '/gig-templates', undefined],
      ['GET', '/gigs', undefined],
      ['POST', '/gigs', { gigTemplateCode: tpl }],
      ['GET', `/gigs/${randomUUID()}`, undefined],
      ['POST', `/gigs/${randomUUID()}/versions`, {}],
      ['GET', `/gigs/${randomUUID()}/versions/1`, undefined],
      ['PUT', `/gigs/${randomUUID()}/draft`, { expectedRevision: 1 }],
      ['POST', `/gigs/${randomUUID()}/publish`, { expectedRevision: 1 }],
      ['POST', `/gigs/${randomUUID()}/retire`, {}],
    ] as const)
      assert(
        (await gig(method, path, null, body)).status === 401,
        `(3) ${method} /provider${path.replace(/[0-9a-f-]{36}/, ':gigId')} without a token must be 401`,
      );
    for (const [what, body] of [
      ['an account id', { gigTemplateCode: tpl, accountId }],
      ['a status', { gigTemplateCode: tpl, status: 'ACTIVE' }],
      ['a template version', { gigTemplateCode: tpl, gigTemplateVersionId: tplV1 }],
      ['a currency', { gigTemplateCode: tpl, currency: 'EUR' }],
      ['a malformed idempotency token', { gigTemplateCode: tpl, clientRequestId: 'not-a-uuid' }],
      ['no template', {}],
    ] as const)
      assert((await gig('POST', '/gigs', token, body)).status === 400, `(3) a create request naming ${what} must be 400`);
    assert((await gig('POST', '/gigs', token, '[]')).status === 400, '(3) a create request that is not an object must be 400');
    assert((await gig('GET', '/gigs/not-a-uuid', token)).status === 400, '(3) a malformed Gig id must be 400');
    const notProvider = await gig('GET', '/gig-templates', token);
    if (notProvider.status === 200)
      assert(notProvider.json.data.templates.length === 0, `(3) a customer who is not a provider is offered no template (${notProvider.text.slice(0, 160)})`);
    refusal(
      await gig('POST', '/gigs', token, { gigTemplateCode: tpl }),
      [403],
      ['PROVIDER_NOT_ELIGIBLE'],
      '(3) a customer who is not a provider creating a Gig',
    );

    // (4) become a provider through the real flows: verified contacts, the market and service type, consent, submit
    assert((await account(token, '/email', 'POST', { email })).status === 200, '(4) setting the email');
    assert((await account(token, '/email/verification/send', 'POST', {})).status === 200, '(4) sending the email verification');
    const message = await retry(
      async () => {
        const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
          messages: { ID: string }[] | null;
        };
        if (!found.messages?.length) throw new Error('the verification email has not arrived');
        return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
      },
      10,
      1000,
    );
    const emailCode = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
    assert(!!emailCode, '(4) the email code is missing from the delivered message');
    assert((await account(token, '/email/verification/confirm-code', 'POST', { code: emailCode })).status === 200, '(4) confirming the email code');
    let tail = '';
    do tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    while (['901', '902', '903', '904', '905'].includes(tail.slice(-3)));
    const e164 = `+1202555${tail}`;
    await inbox.clear(e164);
    assert((await account(token, '/phone', 'POST', { phone: `(202) 555-${tail}`, country: 'US' })).status === 200, '(4) setting the phone number');
    assert((await account(token, '/phone/verification/send', 'POST', {})).status === 200, '(4) sending the SMS');
    const smsCode = extractSmsCode((await inbox.wait(e164, 1, 10_000))[0]!.body);
    assert(!!smsCode, '(4) the SMS code is missing');
    assert((await account(token, '/phone/verification/confirm-code', 'POST', { code: smsCode })).status === 200, '(4) confirming the SMS code');
    const started = await registration('POST', '', token, {});
    assert(started.status === 201, `(4) starting the provider registration -> ${started.status} ${started.json?.error?.code ?? ''}`);
    const market = await registration('PUT', '/market', token, { marketCode });
    assert(market.status === 200, `(4) choosing the test market -> ${market.status} ${market.json?.error?.code ?? ''}`);
    const services = await registration('PUT', '/services', token, { serviceTypeCodes: [serviceType] });
    assert(services.status === 200, `(4) choosing the service type -> ${services.status} ${services.json?.error?.code ?? ''}`);
    const consentReq = ConsentRequirementsResponse.parse((await account(token, '/consents/requirements')).json).data;
    const outstanding = consentReq.requirements.filter((r) => r.status === 'OUTSTANDING' || r.status === 'REACCEPTANCE_REQUIRED');
    assert(
      outstanding.every((r) => r.document),
      `(4) legal text must be in force (the Consent scenario publishes it): ${JSON.stringify(consentReq.requirements.map((r) => `${r.purposeCode}:${r.status}`))}`,
    );
    for (const r of outstanding) {
      const accepted = await account(token, `/consents/${r.purposeCode}/accept`, 'POST', {
        versionId: r.document!.versionId,
        locale: r.document!.locale,
        bodySha256: r.document!.bodySha256,
      });
      assert(accepted.status === 200, `(4) accepting ${r.purposeCode} -> ${accepted.status} ${accepted.json?.error?.code ?? ''}`);
    }
    const reg0 = (await registration('GET', '', token)).json.data.registration;
    const submitted = await registration('POST', '/submit', token, { expectedRevision: reg0.revision });
    assert(
      submitted.status === 200 && submitted.json.data.registration.status === 'COMPLETED' && submitted.json.data.providerRole === 'ACTIVE',
      `(4) submit -> ${submitted.status} ${submitted.json?.error?.code ?? ''} ${JSON.stringify(submitted.json?.error?.details ?? {})}`,
    );
    const stepOf = (req: Json, step: string): Json => req.steps.find((s: Json) => s.step === step);
    const req4 = (await registration('GET', '/requirements', token)).json.data;
    assert(
      stepOf(req4, 'GIGS').status === 'NOT_STARTED' && req4.overall.registrationComplete === true,
      `(4) the registration is complete and the GIGS step has not started (${stepOf(req4, 'GIGS').status})`,
    );

    // (5) the templates the provider can start from: the ACTIVE template of the selected service type, enabled in the provider's market
    const choices = read(GigTemplateChoicesResponse, await gig('GET', '/gig-templates', token), 200, '(5) GET /gig-templates');
    assert(
      choices.marketCode === marketCode &&
        choices.templates.length === 1 &&
        choices.templates[0].gigTemplateCode === tpl &&
        choices.templates[0].serviceTypeCode === serviceType &&
        choices.templates[0].categoryCode === categoryCode &&
        choices.templates[0].gigTemplateVersionNumber === 1,
      `(5) exactly the launched template is offered, at its ACTIVE version 1 (${JSON.stringify(choices)})`,
    );
    const empty = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(5) GET /gigs (empty)');
    assert(
      empty.gigs.length === 0 &&
        empty.canCreate === true &&
        empty.readiness.hasPublishedGig === false &&
        empty.readiness.publishedGigCount === 0 &&
        empty.readiness.draftVersionCount === 0 &&
        empty.limits.activeCount === 0 &&
        empty.limits.draftCount === 0,
      `(5) the GigMenu of a new provider is empty and can create (${JSON.stringify(empty)})`,
    );

    // (6) create the Gig: a DRAFT identity with draft version 1 bound to the EXACT template version; the request token makes it idempotent; no market or service type is stored on it
    const requestId = randomUUID();
    refusal(await gig('POST', '/gigs', token, { gigTemplateCode: 'devtest_no_such_template' }), [404], ['GIG_TEMPLATE_NOT_FOUND'], '(6) an unknown template');
    const createdGig = read(GigDetailResponse, await gig('POST', '/gigs', token, { gigTemplateCode: tpl, clientRequestId: requestId }), 201, '(6) POST /gigs');
    const gigId: string = createdGig.gig.gigId;
    assert(
      uuidRe.test(gigId) &&
        createdGig.gig.status === 'DRAFT' &&
        createdGig.gig.statusKey === 'provider.gig.status.draft' &&
        createdGig.gig.gigTemplateCode === tpl &&
        createdGig.gig.serviceTypeCode === serviceType &&
        createdGig.gig.retiredAt === null &&
        createdGig.currentVersion === null &&
        createdGig.versions.length === 1,
      `(6) a new Gig is a DRAFT identity without a published version (${JSON.stringify(createdGig.gig)})`,
    );
    const draft1 = createdGig.draftVersion;
    assert(
      draft1 !== null &&
        draft1.versionNumber === 1 &&
        draft1.status === 'DRAFT' &&
        draft1.revision === 1 &&
        draft1.title === null &&
        draft1.template.gigTemplateVersionId === tplV1 &&
        draft1.template.gigTemplateVersionNumber === 1 &&
        draft1.template.versionStatus === 'ACTIVE' &&
        draft1.template.templateStatus === 'ACTIVE' &&
        draft1.template.gigTemplateCode === tpl &&
        draft1.template.serviceTypeCode === serviceType,
      `(6) draft 1 is bound to the exact ACTIVE template version (${JSON.stringify(draft1?.template)} expected ${tplV1})`,
    );
    const replay = read(
      GigDetailResponse,
      await gig('POST', '/gigs', token, { gigTemplateCode: tpl, clientRequestId: requestId }),
      200,
      '(6) the same request token again',
    );
    assert(replay.gig.gigId === gigId, '(6) repeating the request token returns the same Gig (200, not a second Gig)');
    const gigRow = await database.query<{ n: number; cols: number }>(
      `SELECT (SELECT count(*)::int FROM provider.gigs WHERE account_id = $1) AS n,
              (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'provider' AND table_name = 'gigs' AND column_name IN ('market_id', 'market_code', 'service_type_id', 'service_type_code')) AS cols`,
      [accountId],
    );
    assert(
      gigRow[0]!.n === 1 && gigRow[0]!.cols === 0,
      `(6) one Gig row, and the Gig stores neither a market nor a service type (${JSON.stringify(gigRow[0])})`,
    );

    // (7) the editor view: structure comes from the bound template version (nothing copied), the permissions and limits are explicit, the empty draft says why it cannot publish
    const fx = fieldOf(draft1, 'inclusions');
    assert(
      draft1.fields.map((f: Json) => f.fieldKey).join() === 'inclusions,finish,extra_time,bring_water,vehicle_notes' &&
        fx.fixed === true &&
        fx.supported === true &&
        fx.required === false &&
        fx.defaultContentKey !== null &&
        fieldOf(draft1, 'finish').required === true &&
        fieldOf(draft1, 'finish')
          .options.map((o: Json) => o.optionCode)
          .join() === 'wax,sealant' &&
        fieldOf(draft1, 'extra_time').fixed === false &&
        fieldOf(draft1, 'extra_time').minNumber === 15 &&
        fieldOf(draft1, 'vehicle_notes').maxLength === 80 &&
        draft1.fieldValues.length === 0,
      `(7) the fields come from the template version, the platform-fixed one is resolved not copied (${JSON.stringify(draft1.fields.map((f: Json) => f.fieldKey))})`,
    );
    assert(
      draft1.constraints.price.permitted === true &&
        draft1.constraints.price.required === true &&
        draft1.constraints.price.currency === 'USD' &&
        draft1.constraints.duration.permitted === true &&
        draft1.constraints.duration.required === true &&
        draft1.constraints.duration.minMinutes === 60 &&
        draft1.constraints.duration.maxMinutes === 240 &&
        draft1.constraints.duration.suggestedMinutes === 120 &&
        draft1.constraints.title.maxLength > 0 &&
        draft1.constraints.shortPitch.maxLength > 0 &&
        draft1.constraints.description.maxLength > 0,
      `(7) the constraints name the market currency (derived, never sent) and the template's price and duration permissions (${JSON.stringify(draft1.constraints)})`,
    );
    assert(
      draft1.publishable === false &&
        ['TITLE_REQUIRED', 'SHORT_PITCH_REQUIRED', 'DESCRIPTION_REQUIRED', 'PRICE_REQUIRED', 'DURATION_REQUIRED', 'FIELD_REQUIRED'].every((reason) =>
          draft1.issues.some((i: Json) => i.reason === reason && i.messageKey === `provider.gig.issue.${reason.toLowerCase()}`),
        ),
      `(7) an empty draft is not publishable and names what is missing (${JSON.stringify(draft1.issues.map((i: Json) => i.reason))})`,
    );

    // (8) a draft may be incomplete, but any value present must be valid; a refused save changes nothing (the revision stays 1)
    const valid1 = {
      expectedRevision: 1,
      title: title1,
      shortPitch: pitch1,
      description: description1,
      priceAmountMinor: 15000,
      durationMinutes: 120,
      fieldValues: [
        { fieldKey: 'finish', value: 'wax' },
        { fieldKey: 'extra_time', value: 30 },
        { fieldKey: 'bring_water', value: true },
        { fieldKey: 'vehicle_notes', value: notes1 },
      ],
    };
    const save = (token_: string | null, body: unknown) => gig('PUT', `/gigs/${gigId}/draft`, token_, body);
    const invalid = async (what: string, patch: Record<string, unknown>, reason: string, fieldKey?: string): Promise<void> => {
      const r = refusal(await save(token, { ...valid1, ...patch }), [400], ['VALIDATION_FAILED'], `(8) ${what}`);
      assert(
        hasIssue(r, reason, fieldKey),
        `(8) ${what}: expected the issue ${reason}${fieldKey ? ` on ${fieldKey}` : ''} (${JSON.stringify(r.json.error.details?.issues)})`,
      );
    };
    await invalid(
      'a platform-fixed field value',
      { fieldValues: [{ fieldKey: 'inclusions', value: 'my own text' }] },
      'FIELD_NOT_PROVIDER_EDITABLE',
      'inclusions',
    );
    await invalid('an unknown field', { fieldValues: [{ fieldKey: 'no_such_field', value: 'x' }] }, 'FIELD_UNKNOWN', 'no_such_field');
    await invalid('an option the template does not have', { fieldValues: [{ fieldKey: 'finish', value: 'diamond' }] }, 'FIELD_OPTION_UNKNOWN', 'finish');
    await invalid('a duration field below its bound', { fieldValues: [{ fieldKey: 'extra_time', value: 5 }] }, 'FIELD_VALUE_OUT_OF_RANGE', 'extra_time');
    await invalid(
      'a text longer than the template allows',
      { fieldValues: [{ fieldKey: 'vehicle_notes', value: 'x'.repeat(81) }] },
      'FIELD_TOO_LONG',
      'vehicle_notes',
    );
    await invalid('a boolean field with a string', { fieldValues: [{ fieldKey: 'bring_water', value: 'yes' }] }, 'FIELD_VALUE_INVALID', 'bring_water');
    await invalid('a Gig duration below the template minimum', { durationMinutes: 45 }, 'DURATION_OUT_OF_RANGE');
    await invalid('markup in the title', { title: '<b>Hello</b>' }, 'HTML_NOT_ALLOWED');
    await invalid('a title far beyond the configured length', { title: 'T'.repeat(250) }, 'TITLE_TOO_LONG');
    for (const [what, patch] of [
      ['a currency in the body', { priceCurrency: 'EUR' }],
      ['an account id', { accountId }],
      ['a status', { status: 'PUBLISHED' }],
      ['a negative price', { priceAmountMinor: -1 }],
      ['a fractional price', { priceAmountMinor: 10.5 }],
      ['a revision of zero', { expectedRevision: 0 }],
      [
        'a repeated field key',
        {
          fieldValues: [
            { fieldKey: 'finish', value: 'wax' },
            { fieldKey: 'finish', value: 'sealant' },
          ],
        },
      ],
    ] as const)
      assert((await save(token, { ...valid1, ...patch })).status === 400, `(8) a save with ${what} must be 400`);
    const stillEmpty = read(GigDetailResponse, await gig('GET', `/gigs/${gigId}`, token), 200, '(8) GET after the refused saves');
    assert(
      stillEmpty.draftVersion.revision === 1 && stillEmpty.draftVersion.title === null && stillEmpty.draftVersion.fieldValues.length === 0,
      '(8) refused saves wrote nothing',
    );

    // (9) publishing an incomplete draft is refused with identifiers only
    const blocked = refusal(
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 1 }),
      [409, 422],
      ['PUBLISH_BLOCKED'],
      '(9) publishing an empty draft',
    );
    for (const reason of ['TITLE_REQUIRED', 'PRICE_REQUIRED', 'DURATION_REQUIRED']) assert(hasIssue(blocked, reason), `(9) the refusal names ${reason}`);
    assert(hasIssue(blocked, 'FIELD_REQUIRED', 'finish'), '(9) the refusal names the required field by key');
    assert(
      read(GigDetailResponse, await gig('GET', `/gigs/${gigId}`, token), 200, '(9) GET').gig.status === 'DRAFT',
      '(9) a refused publish leaves the Gig a DRAFT',
    );

    // (10) save a valid draft: the revision grows by one, the currency is the market's (server-derived), the fixed field stores no value; a stale revision is 409
    const saved1 = read(GigDetailResponse, await save(token, valid1), 200, '(10) PUT draft');
    const d1 = saved1.draftVersion;
    assert(
      d1.revision === 2 &&
        d1.title === title1 &&
        d1.shortPitch === pitch1 &&
        d1.description === description1 &&
        d1.price?.amountMinor === 15000 &&
        d1.price?.currency === 'USD' &&
        d1.durationMinutes === 120 &&
        d1.template.gigTemplateVersionId === tplV1 &&
        d1.fieldValues.length === 4 &&
        !d1.fieldValues.some((f: Json) => f.fieldKey === 'inclusions') &&
        d1.publishable === true &&
        d1.issues.length === 0,
      `(10) the draft holds the content, USD from the market, no value for the platform-fixed field, and is publishable at revision 2 (${JSON.stringify({ r: d1.revision, p: d1.price, n: d1.fieldValues.length, i: d1.issues })})`,
    );
    refusal(await save(token, valid1), [409], ['STALE_DRAFT'], '(10) saving with the revision already used');

    // (11) publish version 1: the Gig becomes ACTIVE, the version is frozen; publishing again or saving afterwards is refused; at most one PUBLISHED version
    refusal(await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 1 }), [409], ['STALE_DRAFT'], '(11) publishing with a stale revision');
    assert(
      (await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 2, title: 'x' })).status === 400,
      '(11) a publish request with extra keys must be 400',
    );
    const published1 = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 2 }), 200, '(11) publish v1');
    const v1 = published1.currentVersion;
    assert(
      published1.gig.status === 'ACTIVE' &&
        v1.versionNumber === 1 &&
        v1.status === 'PUBLISHED' &&
        v1.statusKey === 'provider.gig.version_status.published' &&
        v1.publishedAt !== null &&
        v1.title === title1 &&
        v1.template.gigTemplateVersionId === tplV1 &&
        published1.draftVersion === null &&
        published1.versions.length === 1,
      `(11) the Gig is ACTIVE with version 1 PUBLISHED (${JSON.stringify({ g: published1.gig.status, v: v1?.status })})`,
    );
    refusal(
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 2 }),
      [409],
      ['STALE_DRAFT', 'NO_DRAFT'],
      '(11) a second publish of the same revision',
    );
    refusal(
      await save(token, { ...valid1, expectedRevision: 2, title: 'Changed after publishing' }),
      [409],
      ['NO_DRAFT', 'STALE_DRAFT'],
      '(11) saving a published version',
    );
    const frozen1 = JSON.stringify(read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/1`, token), 200, '(11) GET version 1'));
    assert(JSON.parse(frozen1).title === title1, '(11) version 1 still holds its title');
    const publishedCount = async (): Promise<number> =>
      (await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider.gig_versions WHERE gig_id = $1 AND status = 'PUBLISHED'`, [gigId]))[0]!.n;
    assert((await publishedCount()) === 1, '(11) exactly one PUBLISHED version');

    // (12) the GigMenu shows it; readiness is a set of facts and the registration's GIGS step is derived from them
    const menu12 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(12) GET /gigs');
    const row12 = menu12.gigs.find((g: Json) => g.gig.gigId === gigId);
    assert(
      menu12.gigs.length === 1 &&
        row12.gig.status === 'ACTIVE' &&
        row12.currentVersion.versionNumber === 1 &&
        row12.currentVersion.title === title1 &&
        row12.currentVersion.price.amountMinor === 15000 &&
        row12.currentVersion.price.currency === 'USD' &&
        row12.currentVersion.durationMinutes === 120 &&
        row12.draftVersion === null &&
        row12.versionCount === 1,
      `(12) the GigMenu row holds the published version (${JSON.stringify(row12)})`,
    );
    assert(
      menu12.readiness.hasPublishedGig === true &&
        menu12.readiness.publishedGigCount === 1 &&
        menu12.readiness.draftVersionCount === 0 &&
        menu12.readiness.goLive.evaluated === false &&
        menu12.readiness.goLive.eligible === false &&
        menu12.limits.activeCount === 1 &&
        menu12.limits.draftCount === 0 &&
        menu12.limits.maxActive >= 1 &&
        menu12.limits.maxDrafts >= 1 &&
        menu12.canCreate === true,
      `(12) readiness: one published Gig, Go-Live not evaluated (${JSON.stringify(menu12.readiness)} ${JSON.stringify(menu12.limits)})`,
    );
    const req12 = (await registration('GET', '/requirements', token)).json.data;
    assert(
      stepOf(req12, 'GIGS').status === 'COMPLETE' && req12.overall.goLive.evaluated === false && req12.overall.goLive.eligible === false,
      `(12) the registration GIGS step is COMPLETE from the Gig facts, Go-Live still not evaluated (${stepOf(req12, 'GIGS').status})`,
    );

    // (13) a NEWER template version does not move the Gig: template v2 is published, the Gig's next draft still binds template v1 (an owner decision, ADR-0046)
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { copyFromVersion: 1, reason: 'DEV/TEST ONLY second draft' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/2`, {
      ...definition,
      expectedRevision: 1,
      duration: { minMinutes: 90, maxMinutes: 300, suggestedMinutes: 150 },
      reason: 'DEV/TEST ONLY second definition',
    });
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/2/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish 2' });
    const tplV2 = await tplVersionRow(2);
    assert(tplV2 !== tplV1, '(13) template version 2 is another row');
    const afterTpl = read(GigDetailResponse, await gig('GET', `/gigs/${gigId}`, token), 200, '(13) GET the Gig after template v2');
    assert(
      afterTpl.currentVersion.template.gigTemplateVersionId === tplV1 &&
        afterTpl.currentVersion.template.gigTemplateVersionNumber === 1 &&
        afterTpl.currentVersion.template.versionStatus === 'SUPERSEDED',
      `(13) the published Gig keeps template version 1, now SUPERSEDED (${JSON.stringify(afterTpl.currentVersion.template)})`,
    );
    assert(
      read(GigTemplateChoicesResponse, await gig('GET', '/gig-templates', token), 200, '(13) choices').templates[0].gigTemplateVersionNumber === 2,
      '(13) new Gigs would start from template version 2',
    );
    const next = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/versions`, token, {}), 201, '(13) POST /versions (next draft)');
    const draft2 = next.draftVersion;
    assert(
      draft2.versionNumber === 2 &&
        draft2.status === 'DRAFT' &&
        draft2.revision === 1 &&
        draft2.template.gigTemplateVersionId === tplV1 &&
        draft2.template.versionStatus === 'SUPERSEDED' &&
        draft2.constraints.duration.minMinutes === 60 &&
        draft2.constraints.duration.maxMinutes === 240 &&
        draft2.title === title1 &&
        next.currentVersion.versionNumber === 1 &&
        next.versions.length === 2,
      `(13) draft 2 starts from the published version and binds the SAME template version 1, with its duration bounds (${JSON.stringify({ t: draft2.template, c: draft2.constraints.duration })})`,
    );
    refusal(await gig('POST', `/gigs/${gigId}/versions`, token, {}), [409], ['DRAFT_EXISTS'], '(13) a second draft');
    assert((await gig('POST', `/gigs/${gigId}/versions`, token, { title: 'x' })).status === 400, '(13) a next-draft request with a body must be 400');
    const menu13 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(13) GET /gigs');
    assert(
      menu13.gigs[0].draftVersion.versionNumber === 2 &&
        menu13.gigs[0].currentVersion.versionNumber === 1 &&
        menu13.gigs[0].versionCount === 2 &&
        menu13.readiness.hasPublishedGig === true &&
        menu13.readiness.draftVersionCount === 1 &&
        menu13.limits.draftCount === 1,
      `(13) the menu shows the published version and the draft (${JSON.stringify({ r: menu13.readiness, l: menu13.limits })})`,
    );

    // (14) edit and publish version 2: version 1 is superseded in the same step; there is still exactly one PUBLISHED version
    const valid2 = {
      expectedRevision: 1,
      title: title2,
      shortPitch: pitch1,
      description: description1,
      priceAmountMinor: 17500,
      durationMinutes: 75, // valid under template version 1 (60 to 240); the ACTIVE template version 2 would refuse it (90 to 300)
      fieldValues: [
        { fieldKey: 'finish', value: 'sealant' },
        { fieldKey: 'extra_time', value: 45 },
        { fieldKey: 'bring_water', value: false },
      ],
    };
    const saved2 = read(GigDetailResponse, await save(token, valid2), 200, '(14) PUT draft 2');
    assert(
      saved2.draftVersion.revision === 2 && saved2.draftVersion.durationMinutes === 75 && saved2.draftVersion.publishable === true,
      '(14) draft 2 saved at revision 2 and publishable',
    );
    refusal(await save(token, valid2), [409], ['STALE_DRAFT'], '(14) saving draft 2 with a stale revision');
    const published2 = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 2 }), 200, '(14) publish v2');
    assert(
      published2.gig.status === 'ACTIVE' &&
        published2.currentVersion.versionNumber === 2 &&
        published2.currentVersion.status === 'PUBLISHED' &&
        published2.currentVersion.title === title2 &&
        published2.currentVersion.price.amountMinor === 17500 &&
        published2.draftVersion === null &&
        byNumber(published2, 1).status === 'SUPERSEDED' &&
        byNumber(published2, 1).supersededAt !== null &&
        byNumber(published2, 2).status === 'PUBLISHED',
      `(14) version 2 is PUBLISHED and version 1 SUPERSEDED (${JSON.stringify(published2.versions.map((v: Json) => `${v.versionNumber}:${v.status}`))})`,
    );
    assert((await publishedCount()) === 1, '(14) still exactly one PUBLISHED version');

    // (15) version 1 is preserved: SUPERSEDED but readable, with the content it was published with and its original template binding
    const v1Again = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/1`, token), 200, '(15) GET version 1');
    const was = JSON.parse(frozen1);
    assert(
      v1Again.status === 'SUPERSEDED' &&
        v1Again.supersededAt !== null &&
        v1Again.title === was.title &&
        v1Again.shortPitch === was.shortPitch &&
        v1Again.description === was.description &&
        JSON.stringify(v1Again.price) === JSON.stringify(was.price) &&
        v1Again.durationMinutes === was.durationMinutes &&
        fieldValueMap(v1Again) === fieldValueMap(was) &&
        v1Again.template.gigTemplateVersionId === tplV1 &&
        v1Again.publishedAt === was.publishedAt &&
        v1Again.revision === was.revision,
      `(15) version 1 keeps its content after being superseded (${v1Again.status})`,
    );
    const v2Read = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/2`, token), 200, '(15) GET version 2');
    assert(
      v2Read.status === 'PUBLISHED' && v2Read.title === title2 && fieldValueMap(v2Read) === fieldValueMap({ fieldValues: valid2.fieldValues }),
      '(15) version 2 is readable',
    );
    refusal(await gig('GET', `/gigs/${gigId}/versions/3`, token), [404], ['GIG_VERSION_NOT_FOUND'], '(15) a version that does not exist');
    for (const bad of ['0', '01', '1e3', '-1', '+1', ' 1', '1.0'])
      assert((await gig('GET', `/gigs/${gigId}/versions/${encodeURIComponent(bad)}`, token)).status === 400, `(15) the version "${bad}" must be 400`);
    refusal(await save(token, { ...valid2, expectedRevision: 2 }), [409], ['NO_DRAFT', 'STALE_DRAFT'], '(15) a stale revision once nothing is a draft');

    // (16) the web pages behind Caddy (server-rendered; signed in with the same throwaway identity)
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[] };
    const caddy = (method: 'GET', path: string, cookieHeader?: string): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: 'caddy-proxy', port: 80, path, method, headers: { host: 'app.localhost', ...(cookieHeader ? { cookie: cookieHeader } : {}) } },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body, cookies: res.headers['set-cookie'] ?? [] }));
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end();
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const anon = await caddy('GET', '/provider/gigs');
    assert(
      anon.status === 200 && anon.body.includes('/auth/login?returnTo=/provider/gigs') && !anon.body.includes(gigId) && !anon.body.includes(title2),
      `(16) signed out: sign-in is offered and no Gig is shown (${anon.status})`,
    );
    const start = await caddy('GET', '/auth/login?returnTo=/provider/gigs');
    absorb(start);
    assert(start.status === 302 && (start.location ?? '').includes('code_challenge_method=S256'), `(16) web login did not start a PKCE flow (${start.status})`);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, username, password });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, cookie());
    absorb(callback);
    assert(
      callback.status === 302 && (callback.location ?? '').endsWith('/provider/gigs') && jar.has('bg_session'),
      `(16) web callback failed (${callback.status} ${callback.location})`,
    );
    const webPage = async (path: string): Promise<string> => {
      const p = await caddy('GET', path, cookie());
      assert(p.status === 200, `(16) GET ${path.replace(gigId, ':gigId')} -> ${p.status}`);
      assert(
        !/eyJ[A-Za-z0-9_-]{10,}\./.test(p.body) && !p.body.includes(token) && !p.body.includes(accountId) && !p.body.includes(email) && !p.body.includes(e164),
        `(16) ${path.replace(gigId, ':gigId')} leaked a token, the account id or a contact`,
      );
      for (const v of jar.values()) assert(v.length < 8 || !p.body.includes(v), '(16) the page contains the session cookie value');
      return p.body;
    };
    const menuPage = await webPage('/provider/gigs');
    assert(menuPage.includes(title2) && menuPage.includes(`/provider/gigs/${gigId}`), '(16) the GigMenu page lists the Gig by its title and links to it');
    const detailPage = await webPage(`/provider/gigs/${gigId}`);
    assert(detailPage.includes(title2), '(16) the Gig page shows the published version');
    const versionPage = await webPage(`/provider/gigs/${gigId}/versions/1`);
    assert(versionPage.includes(title1), '(16) the superseded version 1 is readable on the web');

    // (17) another account (customer.dev) cannot see or touch the Gig: 404, never 403, and indistinguishable from a Gig that does not exist
    const otherLogin = await authorizationCodeLogin(kc, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const other = (
      await exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: otherLogin.code,
        codeVerifier: otherLogin.verifier,
      })
    ).accessToken;
    const nowhere = randomUUID();
    const probes: [string, string, string, unknown][] = [
      ['GET the Gig', 'GET', '', undefined],
      ['GET a version', 'GET', '/versions/1', undefined],
      ['create the next draft', 'POST', '/versions', {}],
      ['save a draft', 'PUT', '/draft', { ...valid2, expectedRevision: 1 }],
      ['publish', 'POST', '/publish', { expectedRevision: 1 }],
      ['retire', 'POST', '/retire', {}],
    ];
    for (const [what, method, suffix, body] of probes) {
      const theirs = refusal(
        await gig(method as 'GET' | 'POST' | 'PUT', `/gigs/${gigId}${suffix}`, other, body),
        [404],
        ['GIG_NOT_FOUND', 'GIG_VERSION_NOT_FOUND'],
        `(17) another account: ${what}`,
      );
      const none = await gig(method as 'GET' | 'POST' | 'PUT', `/gigs/${nowhere}${suffix}`, other, body);
      assert(
        none.status === theirs.status && none.json?.error?.code === theirs.json?.error?.code,
        `(17) ${what}: a Gig of someone else must answer exactly like a Gig that does not exist (${theirs.json?.error?.code} vs ${none.json?.error?.code})`,
      );
      assert(!theirs.text.includes(title2) && !theirs.text.includes(gigId), `(17) ${what}: the refusal must not echo the Gig`);
    }
    const otherMenu = await gig('GET', '/gigs', other);
    if (otherMenu.status === 200)
      assert(!otherMenu.text.includes(gigId) && !otherMenu.text.includes(title2), "(17) the other account's GigMenu must not list this Gig");
    assert(
      read(GigDetailResponse, await gig('GET', `/gigs/${gigId}`, token), 200, '(17) the owner still sees the Gig').gig.status === 'ACTIVE',
      '(17) the refused calls changed nothing',
    );

    // (18) retire: terminal, history kept, the draft and published versions are RETIRED, the superseded one stays; nothing can be created or published on it again
    assert(
      (await gig('POST', `/gigs/${gigId}/retire`, token, { reason: 'because' })).status === 400,
      '(18) a retire request carrying text must be 400 (free text would reach the audit trail)',
    );
    const retired = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/retire`, token, {}), 200, '(18) retire');
    assert(
      retired.gig.status === 'RETIRED' &&
        retired.gig.statusKey === 'provider.gig.status.retired' &&
        retired.gig.retiredAt !== null &&
        retired.draftVersion === null &&
        byNumber(retired, 1).status === 'SUPERSEDED' &&
        byNumber(retired, 2).status === 'RETIRED' &&
        byNumber(retired, 2).retiredAt !== null &&
        retired.versions.length === 2,
      `(18) the Gig is RETIRED; version 2 RETIRED, version 1 stays SUPERSEDED (${JSON.stringify(retired.versions.map((v: Json) => `${v.versionNumber}:${v.status}`))})`,
    );
    refusal(await gig('POST', `/gigs/${gigId}/versions`, token, {}), [409], ['GIG_RETIRED'], '(18) a new draft on a retired Gig');
    refusal(await save(token, { ...valid2, expectedRevision: 2 }), [409], ['GIG_RETIRED', 'NO_DRAFT', 'STALE_DRAFT'], '(18) saving on a retired Gig');
    refusal(
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: 2 }),
      [409],
      ['GIG_RETIRED', 'NO_DRAFT', 'STALE_DRAFT'],
      '(18) publishing on a retired Gig',
    );
    const retireAgain = await gig('POST', `/gigs/${gigId}/retire`, token, {});
    assert(
      retireAgain.status === 200 || (retireAgain.status === 409 && isCode(retireAgain.json?.error?.code, 'GIG_RETIRED')),
      `(18) retiring twice is idempotent or GIG_RETIRED, never a reactivation (${retireAgain.status})`,
    );
    assert((await publishedCount()) === 0, '(18) no PUBLISHED version is left');
    const menu18 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(18) GET /gigs after retiring');
    assert(
      menu18.gigs.length === 1 &&
        menu18.gigs[0].gig.status === 'RETIRED' &&
        menu18.readiness.hasPublishedGig === false &&
        menu18.readiness.publishedGigCount === 0 &&
        menu18.readiness.draftVersionCount === 0 &&
        menu18.limits.activeCount === 0,
      `(18) the retired Gig stays in the menu and no longer counts as published (${JSON.stringify(menu18.readiness)})`,
    );

    // (19) history stays readable after the Gig AND its template are retired; a new Gig starts from the template's CURRENT version; a retired template accepts no new Gig
    const gigB = read(
      GigDetailResponse,
      await gig('POST', '/gigs', token, { gigTemplateCode: tpl }),
      201,
      '(19) a second Gig (a retired one is never reactivated)',
    );
    assert(
      gigB.gig.gigId !== gigId && gigB.draftVersion.template.gigTemplateVersionId === tplV2 && gigB.draftVersion.template.gigTemplateVersionNumber === 2,
      '(19) a new Gig binds the ACTIVE template version 2',
    );
    const gigBId: string = gigB.gig.gigId;
    assert(gigB.draftVersion.constraints.duration.minMinutes === 90, '(19) its constraints come from template version 2');
    const retiredB = read(GigDetailResponse, await gig('POST', `/gigs/${gigBId}/retire`, token, {}), 200, '(19) retiring a Gig that was never published');
    assert(
      retiredB.gig.status === 'RETIRED' && retiredB.versions.length === 1 && retiredB.versions[0].status === 'RETIRED',
      '(19) a DRAFT Gig can be retired (its draft becomes RETIRED)',
    );
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'RETIRED', reason: 'DEV/TEST ONLY cleanup' });
    templateRetired = true;
    const afterRetire = read(GigDetailResponse, await gig('GET', `/gigs/${gigId}`, token), 200, '(19) GET the Gig after the template was retired');
    assert(
      afterRetire.gig.status === 'RETIRED' && afterRetire.versions.length === 2 && afterRetire.gig.gigTemplateCode === tpl,
      '(19) the history of a Gig of a retired template stays readable',
    );
    for (const n of [1, 2]) {
      const vr = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/${n}`, token), 200, `(19) GET version ${n}`);
      assert(
        vr.template.templateStatus === 'RETIRED' && vr.template.gigTemplateVersionId === tplV1,
        `(19) version ${n} still names its template version (template ${vr.template.templateStatus})`,
      );
    }
    assert(
      read(GigTemplateChoicesResponse, await gig('GET', '/gig-templates', token), 200, '(19) choices').templates.every((t: Json) => t.gigTemplateCode !== tpl),
      '(19) a retired template is no longer offered',
    );
    const lateGig = refusal(
      await gig('POST', '/gigs', token, { gigTemplateCode: tpl }),
      [409],
      ['GIG_TEMPLATE_NOT_AVAILABLE'],
      '(19) a Gig from a retired template',
    );
    assert(
      ['TEMPLATE_RETIRED', 'TEMPLATE_INACTIVE', 'NO_ACTIVE_VERSION'].includes(lateGig.json.error.details?.reason),
      `(19) the refusal names why (${lateGig.json.error.details?.reason})`,
    );

    // (20) a Gig is NOT live: Go-Live is never evaluated, and no later-checkpoint capability exists in any response (variants, add-ons and media arrived with CAT-004: they are proven by
    // the scenario 'Provider variants, add-ons and media'; this template has none of them, so here they must be empty)
    const forbidden =
      /^(mediaItems?|photos?|gallery|serviceAreas?|serviceArea|radius|availability|capacity|bookings?|searchRank|ranking|live|isLive|bookable|goLiveEligible)$/i;
    const walk = (value: Json, found: string[]): string[] => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, found));
      else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) {
          if (forbidden.test(k)) found.push(k);
          walk(v, found);
        }
      return found;
    };
    let goLiveSeen = 0;
    for (let i = 0; i < seen.length; i += 2) {
      let body: Json;
      try {
        body = JSON.parse(seen[i]!);
      } catch {
        continue;
      }
      const bad = walk(body, []);
      assert(bad.length === 0, `(20) a Gig response contains a field of a later checkpoint: ${bad.join()}`);
      const stack: Json[] = [body];
      while (stack.length) {
        const cur = stack.pop();
        if (Array.isArray(cur)) stack.push(...cur);
        else if (cur && typeof cur === 'object') {
          if ('goLive' in cur) {
            goLiveSeen++;
            assert(cur.goLive.evaluated === false && cur.goLive.eligible === false, '(20) Go-Live must never be evaluated or eligible');
          }
          stack.push(...Object.values(cur));
        }
      }
    }
    assert(goLiveSeen >= 1, '(20) the GigMenu readiness carries the Go-Live fact');
    const req20 = (await registration('GET', '/requirements', token)).json.data;
    assert(req20.overall.goLive.evaluated === false && req20.overall.goLive.eligible === false, '(20) the registration still does not evaluate Go-Live');
    const noGoLive = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'provider' AND table_name ~* 'availability|area|capacity|go_?live|search'`,
    );
    assert(noGoLive[0]!.n === 0, `(20) the provider schema has no table of a later checkpoint (${noGoLive[0]!.n})`);

    // (21) the database: bindings are exact, and the audit trail and outbox hold every change exactly once and never the provider's text
    const versions = await database.query<{ gig_id: string; version_number: number; status: string; tpl_version: number; bound: string }>(
      `SELECT v.gig_id, v.version_number, v.status, tv.version_number AS tpl_version, v.gig_template_version_id AS bound
         FROM provider.gig_versions v JOIN catalog.gig_template_versions tv ON tv.gig_template_version_id = v.gig_template_version_id
        WHERE v.gig_id IN ($1, $2) ORDER BY v.gig_id = $2, v.version_number`,
      [gigId, gigBId],
    );
    assert(
      versions.map((v) => `${v.version_number}:${v.status}:t${v.tpl_version}`).join() === '1:SUPERSEDED:t1,2:RETIRED:t1,1:RETIRED:t2' &&
        versions[0]!.bound === tplV1 &&
        versions[1]!.bound === tplV1 &&
        versions[2]!.bound === tplV2,
      `(21) the stored versions bind the exact template versions (${JSON.stringify(versions.map((v) => `${v.version_number}:${v.status}:t${v.tpl_version}`))})`,
    );
    const audit = await database.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM provider.gig_audit_events WHERE account_id = $1::uuid GROUP BY action`,
      [accountId],
    );
    const a = Object.fromEntries(audit.map((r) => [r.action, r.n]));
    assert(
      a.GIG_CREATED === 2 &&
        a.GIG_VERSION_PUBLISHED === 2 &&
        a.GIG_VERSION_SUPERSEDED === 1 &&
        a.GIG_RETIRED === 2 &&
        (a.GIG_DRAFT_CREATED ?? 0) >= 1 &&
        (a.GIG_DRAFT_UPDATED ?? 0) >= 2,
      `(21) the audit trail holds each change as often as it happened; refused calls wrote nothing (${JSON.stringify(a)})`,
    );
    const events = await database.query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%' AND payload_json->>'accountId' = $1::text GROUP BY event_type`,
      [accountId],
    );
    const e = Object.fromEntries(events.map((r) => [r.event_type, r.n]));
    assert(
      e['bananagig.provider.gig-created.v1'] === 2 && e['bananagig.provider.gig-version-published.v1'] === 2 && e['bananagig.provider.gig-retired.v1'] === 2,
      `(21) the outbox holds each Gig event exactly once (${JSON.stringify(e)})`,
    );
    const stored = await database.query<{ s: string }>(
      `SELECT coalesce((SELECT string_agg(changes::text, ' ') FROM provider.gig_audit_events WHERE account_id = $1::uuid), '') || ' ' ||
              coalesce((SELECT string_agg(payload_json::text, ' ') FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%' AND payload_json->>'accountId' = $1::text), '') AS s`,
      [accountId],
    );
    for (const text of providerText) assert(!stored[0]!.s.includes(text), `(21) provider text appears in the audit trail or the outbox: ${text.slice(0, 20)}`);
    assert(!stored[0]!.s.includes(email) && !stored[0]!.s.includes(e164), '(21) no contact in the audit trail or the outbox');

    // (22) la-oc is untouched, nothing leaked into responses or logs
    const laocAfter = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    assert(laocAfter === laocBefore, `(22) la-oc must stay as it was (${laocBefore} -> ${laocAfter})`);
    const everything = seen.join('\n');
    for (const [what, value] of [
      ['email', email],
      ['phone', e164],
      ['account id', accountId],
      ['access token', token],
      ['password', password],
    ] as const)
      assert(!everything.includes(value), `(22) a Gig API response contains the ${what}`);
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    for (const [what, q] of [
      ['Gig title', `{service_name=~"bananagig-.+"} |= \`${title1}\``],
      ['Gig description', `{service_name=~"bananagig-.+"} |= \`Smoke gig description ${runId}\``],
      ['vehicle notes', `{service_name=~"bananagig-.+"} |= \`${notes1}\``],
      ['email', `{service_name=~"bananagig-.+"} |= \`${email}\``],
      ['phone', `{service_name=~"bananagig-.+"} |= \`${e164}\``],
      ['access token', `{service_name=~"bananagig-.+"} |= \`${token}\``],
    ] as const)
      assert((await query(q)).data.result.length === 0, `(22) the ${what} appears in the logs`);

    return (
      `throwaway provider (registration COMPLETED through the real flows) in a DEV/TEST market; ${tpl}: customer not eligible (403), templates offered only for the selected service type; Gig created from the ACTIVE template version (exact link, idempotent token), ` +
      `eager draft validation (fixed/unknown/option/bounds/markup/length), incomplete publish blocked with identifiers, stale revisions 409, v1 published and frozen (GigMenu + GIGS step COMPLETE); template v2 did not move the Gig ` +
      `(next draft binds template v1), v2 published, v1 SUPERSEDED but readable and unchanged; web pages render behind Caddy; another account gets 404 on every route (same as a missing Gig); retire is terminal, history readable after the ` +
      `template was retired, a new Gig binds template v2; Go-Live never evaluated, no area/availability/search field anywhere; audit and outbox exact, no provider text in them or in the logs; la-oc ${laocBefore} untouched`
    );
  } finally {
    // cleanup: the Gig template, service type and category are RETIRED and the DEV/TEST market deactivated (entities are never deleted; Gigs stay as history); the throwaway user is removed
    try {
      if (admin && marketCreated) {
        if (!templateRetired) await request(`/catalog/gig-templates/${tpl}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/service-types/${serviceType}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/categories/${categoryCode}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/geography/markets/${marketCode}/activation`, 'POST', admin, { active: false, reason: 'smoke cleanup' });
      }
    } catch {
      // best effort: the failure that got us here is the one to report
    }
    try {
      if (kcUserId) await kcAdmin('DELETE', `/users/${kcUserId}`);
    } catch {
      // best effort
    }
    valkey.disconnect();
    await database.close();
  }
});

// ---------------------------------------------------------------- synthetic DEV/TEST images (CAT-004)
// Tiny images built in code, never a real photo. The server reads only the HEADER for the dimensions (it never decodes), so a bomb is just a header that claims a huge size.
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A valid 8-bit grayscale PNG; `rows` below `height` makes a deliberately truncated image whose HEADER still claims the full size (a decompression-bomb header). */
const synthPng = (width: number, height: number, shade: number, label: string, rows = height): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grayscale), compression, filter and interlace stay 0
  const raw = Buffer.alloc((width + 1) * rows, shade);
  for (let r = 0; r < rows; r++) raw[r * (width + 1)] = 0; // filter type "none"
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from(label, 'latin1')])),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};
/** A valid baseline grayscale JPEG (every 8x8 block is "DC difference 0, end of block": two bits of zeros per block). `edge` must be a multiple of 16. */
const synthJpeg = (edge: number, label: string): Buffer => {
  const seg = (marker: number, payload: Buffer): Buffer => {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(0xff00 | marker, 0);
    h.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([h, payload]);
  };
  const counts = (): Buffer => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xfe, Buffer.from(label, 'latin1')),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, Buffer.from([8, edge >> 8, edge & 255, edge >> 8, edge & 255, 1, 1, 0x11, 0])),
    seg(0xc4, Buffer.concat([Buffer.from([0x00]), counts(), Buffer.from([0])])), // DC table 0: one symbol (category 0), the code "0"
    seg(0xc4, Buffer.concat([Buffer.from([0x10]), counts(), Buffer.from([0])])), // AC table 0: one symbol (end of block), the code "0"
    seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    Buffer.alloc(((edge / 8) * (edge / 8)) / 4, 0),
    Buffer.from([0xff, 0xd9]),
  ]);
};
/** A valid lossless WebP (VP8L) of one flat colour: every prefix code has a single symbol, so the pixels take zero bits. */
const synthWebp = (edge: number, green: number, red: number, blue: number): Buffer => {
  const bits: number[] = [];
  const put = (value: number, n: number): void => {
    for (let i = 0; i < n; i++) bits.push((value >> i) & 1);
  };
  put(0, 1); // no transform
  put(0, 1); // no colour cache
  put(0, 1); // no meta prefix codes
  for (const symbol of [green, red, blue, 255, 0]) {
    put(1, 1); // simple code
    put(0, 1); // one symbol
    put(1, 1); // the symbol is 8 bits
    put(symbol, 8);
  }
  while (bits.length % 8) bits.push(0);
  const packed = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => {
    packed[i >> 3] = packed[i >> 3]! | (bit << (i & 7));
  });
  const head = Buffer.alloc(5);
  head[0] = 0x2f;
  head.writeUInt32LE((edge - 1) | ((edge - 1) << 14), 1);
  const data = Buffer.concat([head, packed]);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunk = Buffer.alloc(8);
  chunk.write('VP8L', 0, 'latin1');
  chunk.writeUInt32LE(data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + chunk.length + data.length + pad.length, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, chunk, data, pad]);
};

// ---------------------------------------------------------------- Provider variants, add-ons and media (CAT-004)
await check('Provider variants, add-ons and media', async () => {
  // Variants, add-ons and photos of a provider Gig VERSION (CAT-004) end to end with REAL Keycloak tokens and a THROWAWAY customer-only identity (created through the Keycloak admin API and
  // deleted at the end) that becomes a provider through the REAL flows, in an isolated DEV/TEST market (ZZ) with its own category, service type and Gig Template (published by admin.dev):
  // template version 1 allows FIXED_WITH_VARIANTS and ADD_ONS and has a REQUIRED photo field (1 to 3); template version 2 (published late) allows variants only and has no photo field.
  // Images are SYNTHETIC (generated in code, never a real photo). Photos go to the REAL private object store (SeaweedFS) through the one-object presigned PUT (S3_ENDPOINT must be
  // reachable from this container, as in 'Provider verification'), the scanner is the DEV/TEST fake (TRUST_SCANNER=fake: the harmless EICAR string is INFECTED).
  // Assumptions (checked against the real implementation by the lead): routes under /api/v1/provider (PUT /gigs/:id/draft/variants|add-ons|media/order, POST .../draft/media/uploads,
  // POST|PUT|DELETE .../draft/media/:mediaId[/finalize], GET .../draft/media/:mediaId/preview, GET .../versions/:n/media/:mediaId/preview), the seeded media policy (10 MiB, JPEG/PNG/WebP,
  // edges 200 to 12000, 50 M pixels, 200 characters of alt text, 10 variants, 20 add-ons), DATABASE_URL (read-only SELECTs), LOKI_URL, MAILPIT_URL, VALKEY_URL, KEYCLOAK_ADMIN*.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any; // parsed response bodies are checked field by field below
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cid = `smoke-gigmedia-${runId}`;
  const flowStart = Date.now() * 1e6;
  const marketCode = `devtest-gigm-${runId}`;
  const categoryCode = `devtest_gigmc_${runId}`;
  const serviceType = `devtest_gigms_${runId}`;
  const tpl = `devtest_gigm_${runId}`;
  const key = (suffix: string): string => `catalog.gig_template.${tpl}.${suffix}`;
  const username = `cat004.${runId}`;
  const password = `Pw-${randomBytes(9).toString('hex')}`; // secret-scan:allow throwaway DEV/TEST identity, deleted at the end
  const email = `cat004-${runId}@bananagig.localhost`;
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const itemKeyRe = /^[a-z][a-z0-9_]{1,39}$/;
  const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  // the provider text of this run (plain text; unique per run so it can be searched for in the audit trail, the outbox and the logs)
  const title = `Smoke Media Gig ${runId}`;
  const text = {
    pitch: `Smoke media pitch ${runId}`,
    description: `Smoke media description ${runId}.`,
    basic: `Basic wash ${runId}`,
    basicDesc: `Basic wash description ${runId}`,
    deluxe: `Deluxe wash ${runId}`,
    premium: `Premium wash ${runId}`,
    wax: `Extra wax ${runId}`,
    waxDesc: `Extra wax description ${runId}`,
    hair: `Pet hair removal ${runId}`,
    shine: `Wheel shine ${runId}`,
    altA: `Front of the car ${runId}`,
    altA2: `Front of the car, edited ${runId}`,
    altC: `Back of the car ${runId}`,
    altD: `Interior ${runId}`,
    editedDeluxe: `Deluxe wash plus ${runId}`,
  };
  const providerText = Object.values(text);
  const seen: string[] = []; // every PROVIDER Gig response (body and headers) except the one-time upload authorizations and previews, which hold a signed URL by design
  const secretsOfUrls: string[] = []; // the signature of every presigned URL handed out in this run
  await clearLimiterBuckets('email-verification');
  await clearLimiterBuckets('phone-verification');

  type Reply = { status: number; text: string; json: Json; headers: Headers };
  const request = async (path: string, method: string, token: string | null, body?: unknown): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: cid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const bodyText = await r.text();
    let json: Json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    return { status: r.status, text: bodyText, json, headers: r.headers };
  };
  const mgmt = async (
    module: 'catalog' | 'geography' | 'content',
    admin: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses = [200, 201],
  ): Promise<Reply> => {
    const r = await request(`/${module}${path}`, method, admin, body);
    assert(okStatuses.includes(r.status), `${method} /${module}${path} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };
  /** The provider Gig API. Every response must be no-store; it is kept for the scans at the end unless `keep` is false (upload authorizations and previews carry a signed URL). */
  const gig = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string | null, body?: unknown, keep = true): Promise<Reply> => {
    const r = await request(`/provider${path}`, method, token, body);
    if (keep) seen.push(r.text, JSON.stringify([...r.headers]));
    assert(
      r.headers.get('cache-control') === 'no-store',
      `${method} /provider${path.replace(/[0-9a-f-]{36}/g, ':id')}: every Gig response must be Cache-Control: no-store (${r.status})`,
    );
    return r;
  };
  const registration = (method: 'GET' | 'POST' | 'PUT', path: string, token: string | null, body?: unknown): Promise<Reply> =>
    request(`/provider/registration${path}`, method, token, body);
  const account = (token: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Reply> =>
    request(`/account${path}`, method, token, body);
  const isCode = (wire: unknown, code: string): boolean => wire === code || wire === `GIG_${code}`;
  const refusal = (r: Reply, statuses: number[], codes: string[], what: string): Reply => {
    assert(
      statuses.includes(r.status) && codes.some((c) => isCode(r.json?.error?.code, c)),
      `${what}: expected ${statuses.join('|')} ${codes.join('|')}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`,
    );
    const mk = r.json.error.details?.messageKey;
    if (mk !== undefined)
      assert(
        codes.some((c) => mk === gigErrorKey(c as never)),
        `${what}: the error message key ${mk} does not belong to ${codes.join('|')}`,
      );
    return r;
  };
  const hasIssue = (r: Reply, reason: string): boolean =>
    Array.isArray(r.json?.error?.details?.issues) &&
    r.json.error.details.issues.some((i: Json) => i.reason === reason && i.messageKey === `provider.gig.issue.${reason.toLowerCase()}`);
  type Parser = { safeParse(v: unknown): Json };
  /** An expected success whose body must match the published contract. Returns the `data` member. */
  const read = (schema: Parser, r: Reply, status: number, what: string): Json => {
    assert(r.status === status, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`);
    const p = schema.safeParse(r.json);
    if (!p.success) throw new Error(`${what}: the response does not match its contract: ${String(p.error?.message).slice(0, 400)}`);
    return p.data.data;
  };
  const reasons: Record<string, string> = {}; // the refusal reasons the API reported (allow-listed codes), echoed in the result note

  // ---- Keycloak: the throwaway identity (customer realm role only; the account starts as a customer)
  const kcToken = await kcMasterToken();
  const kcAdmin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; location: string | null }> => {
    const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, {
      method,
      headers: { authorization: `Bearer ${kcToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const bodyText = await res.text();
    let json: Json;
    try {
      json = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      json = bodyText;
    }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  let kcUserId = '';
  const database = createDatabase(env('DATABASE_URL', ''), { role: 'tests' });
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = new FakeSmsInbox(valkey);
  let admin = '';
  let marketCreated = false;
  try {
    // (1) the throwaway identity and an admin token for the catalogue
    const created = await kcAdmin('POST', '/users', {
      username,
      enabled: true,
      email: `kc-${email}`,
      emailVerified: true,
      firstName: 'Media',
      lastName: 'Smoke',
      attributes: { 'bananagig.devOnly': ['true'] },
    });
    assert(created.status === 201 && !!created.location, `(1) creating the throwaway Keycloak user -> ${created.status} ${JSON.stringify(created.json)}`);
    kcUserId = created.location!.split('/').pop()!;
    const role = await kcAdmin('GET', '/roles/customer');
    assert(role.status === 200, `(1) the customer realm role -> ${role.status}`);
    assert((await kcAdmin('POST', `/users/${kcUserId}/role-mappings/realm`, [role.json])).status === 204, '(1) mapping the customer realm role');
    assert(
      (await kcAdmin('PUT', `/users/${kcUserId}/reset-password`, { type: 'password', value: password, temporary: false })).status === 204,
      '(1) setting the throwaway password',
    );
    const login = async (
      clientId: 'bananagig-web' | 'bananagig-admin',
      redirectUri: string,
      creds: { username: string; password: string },
    ): Promise<string> => {
      const l = await authorizationCodeLogin(kc, { clientId, redirectUri, ...creds });
      return (await exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId, redirectUri, code: l.code, codeVerifier: l.verifier })).accessToken;
    };
    const token = await login('bananagig-web', WEB_REDIRECT_URI, { username, password });
    const me = AccountResponse.parse((await account(token, '/me')).json).data;
    const accountId = me.accountId;
    assert(uuidRe.test(accountId) && me.status === 'ACTIVE', '(1) the account is created on the first request and ACTIVE');
    admin = await login('bananagig-admin', ADMIN_REDIRECT_URI, DEV_USERS.admin);
    const laocBefore = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;

    // (2) the platform side: a DEV/TEST market, category, service type and an ACTIVE Gig Template (v1 published) offered in the market. FIXED_WITH_VARIANTS + ADD_ONS, a REQUIRED photo field (1..3).
    await ensureDevtestGeography(admin);
    await mgmt('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST gig media smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    });
    marketCreated = true;
    const publishCopy = async (k: string, copy: string): Promise<void> => {
      await mgmt('content', admin, 'POST', '/entries', {
        key: k,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY Gig media smoke entry',
        approvalPolicy: 'NONE',
      });
      const v = (await mgmt('content', admin, 'POST', `/entries/${k}/versions`, { locale: 'en-US', body: copy, reason: 'smoke test' })).json.data;
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/submit`, {});
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/publish`, {});
    };
    await publishCopy(`catalog.category.${categoryCode}.name`, `Smoke Media Category ${runId}`);
    await publishCopy(`catalog.service_type.${serviceType}.name`, `Smoke Media Service ${runId}`);
    await publishCopy(key('name'), `Smoke Media Template ${runId}`);
    await mgmt('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/service-types', { code: serviceType, categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/gig-templates', {
      code: tpl,
      serviceTypeCode: serviceType,
      withDescription: false,
      withInstructions: false,
      reason: 'DEV/TEST ONLY smoke template',
    });
    await mgmt('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/service-types/${serviceType}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'launch' });
    await publishCopy(key('field.inclusions.label'), 'What is included');
    await publishCopy(key('field.inclusions.default'), 'Exterior wash, interior vacuum, windows.');
    await publishCopy(key('field.finish.label'), 'Finish');
    await publishCopy(key('field.finish.option.wax.label'), 'Wax');
    await publishCopy(key('field.finish.option.sealant.label'), 'Sealant');
    await publishCopy(key('field.photos.label'), 'Work photos');
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'DEV/TEST ONLY first draft' });
    const fieldsBase = [
      { fieldKey: 'inclusions', fieldType: 'LONG_TEXT', section: 'INCLUSIONS', behavior: 'PLATFORM_FIXED', withDefaultText: true },
      { fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }] },
    ];
    const definition = {
      expectedRevision: 1,
      duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
      pricingModels: ['FIXED_WITH_VARIANTS', 'ADD_ONS'],
      areaModes: ['RADIUS'],
      fields: [...fieldsBase, { fieldKey: 'photos', fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 3 }],
      requirements: [{ requirementType: 'INSURANCE' }],
      reason: 'DEV/TEST ONLY fields',
    };
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, definition);
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${serviceType}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' });

    // (3) before anything: every new route needs the caller's own token
    const someGig = randomUUID();
    const someMedia = randomUUID();
    const newRoutes: [string, string, unknown][] = [
      ['PUT', `/gigs/${someGig}/draft/variants`, { expectedRevision: 1, variants: [] }],
      ['PUT', `/gigs/${someGig}/draft/add-ons`, { expectedRevision: 1, addOns: [] }],
      ['POST', `/gigs/${someGig}/draft/media/uploads`, { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 100, altText: null }],
      ['POST', `/gigs/${someGig}/draft/media/${someMedia}/finalize`, { expectedRevision: 1 }],
      ['PUT', `/gigs/${someGig}/draft/media/${someMedia}`, { expectedRevision: 1, altText: null }],
      ['DELETE', `/gigs/${someGig}/draft/media/${someMedia}`, { expectedRevision: 1 }],
      ['PUT', `/gigs/${someGig}/draft/media/order`, { expectedRevision: 1, mediaIds: [] }],
      ['GET', `/gigs/${someGig}/draft/media/${someMedia}/preview`, undefined],
      ['GET', `/gigs/${someGig}/versions/1/media/${someMedia}/preview`, undefined],
    ];
    for (const [method, path, body] of newRoutes)
      assert(
        (await gig(method as 'GET', path, null, body)).status === 401,
        `(3) ${method} /provider${path.replace(/[0-9a-f-]{36}/g, ':id')} without a token must be 401`,
      );

    // (4) become a provider through the real flows: verified contacts, the market and service type, consent, submit
    assert((await account(token, '/email', 'POST', { email })).status === 200, '(4) setting the email');
    assert((await account(token, '/email/verification/send', 'POST', {})).status === 200, '(4) sending the email verification');
    const message = await retry(
      async () => {
        const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
          messages: { ID: string }[] | null;
        };
        if (!found.messages?.length) throw new Error('the verification email has not arrived');
        return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
      },
      10,
      1000,
    );
    const emailCode = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
    assert(!!emailCode, '(4) the email code is missing from the delivered message');
    assert((await account(token, '/email/verification/confirm-code', 'POST', { code: emailCode })).status === 200, '(4) confirming the email code');
    let tail = '';
    do tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    while (['901', '902', '903', '904', '905'].includes(tail.slice(-3)));
    const e164 = `+1202555${tail}`;
    await inbox.clear(e164);
    assert((await account(token, '/phone', 'POST', { phone: `(202) 555-${tail}`, country: 'US' })).status === 200, '(4) setting the phone number');
    assert((await account(token, '/phone/verification/send', 'POST', {})).status === 200, '(4) sending the SMS');
    const smsCode = extractSmsCode((await inbox.wait(e164, 1, 10_000))[0]!.body);
    assert(!!smsCode, '(4) the SMS code is missing');
    assert((await account(token, '/phone/verification/confirm-code', 'POST', { code: smsCode })).status === 200, '(4) confirming the SMS code');
    assert((await registration('POST', '', token, {})).status === 201, '(4) starting the provider registration');
    assert((await registration('PUT', '/market', token, { marketCode })).status === 200, '(4) choosing the test market');
    assert((await registration('PUT', '/services', token, { serviceTypeCodes: [serviceType] })).status === 200, '(4) choosing the service type');
    const consentReq = ConsentRequirementsResponse.parse((await account(token, '/consents/requirements')).json).data;
    const outstanding = consentReq.requirements.filter((r) => r.status === 'OUTSTANDING' || r.status === 'REACCEPTANCE_REQUIRED');
    assert(
      outstanding.every((r) => r.document),
      `(4) legal text must be in force (the Consent scenario publishes it): ${JSON.stringify(consentReq.requirements.map((r) => `${r.purposeCode}:${r.status}`))}`,
    );
    for (const r of outstanding) {
      const accepted = await account(token, `/consents/${r.purposeCode}/accept`, 'POST', {
        versionId: r.document!.versionId,
        locale: r.document!.locale,
        bodySha256: r.document!.bodySha256,
      });
      assert(accepted.status === 200, `(4) accepting ${r.purposeCode} -> ${accepted.status} ${accepted.json?.error?.code ?? ''}`);
    }
    const reg0 = (await registration('GET', '', token)).json.data.registration;
    const submitted = await registration('POST', '/submit', token, { expectedRevision: reg0.revision });
    assert(
      submitted.status === 200 && submitted.json.data.registration.status === 'COMPLETED' && submitted.json.data.providerRole === 'ACTIVE',
      `(4) submit -> ${submitted.status} ${submitted.json?.error?.code ?? ''} ${JSON.stringify(submitted.json?.error?.details ?? {})}`,
    );

    // (5) the Gig and its editor view: what the bound template version permits is explicit (variants, add-ons, photos with their per-field bounds)
    const detail = async (gid: string, t = token): Promise<Json> => read(GigDetailResponse, await gig('GET', `/gigs/${gid}`, t), 200, 'GET Gig');
    const draftOf = async (gid: string): Promise<Json> => (await detail(gid)).draftVersion;
    const created5 = read(GigDetailResponse, await gig('POST', '/gigs', token, { gigTemplateCode: tpl }), 201, '(5) POST /gigs');
    const gigId: string = created5.gig.gigId;
    const d5 = created5.draftVersion;
    const photosField = d5.fields.find((f: Json) => f.fieldKey === 'photos');
    assert(
      d5.constraints.variants.permitted === true &&
        d5.constraints.variants.maxCount >= 3 &&
        d5.constraints.addOns.permitted === true &&
        d5.constraints.addOns.maxCount >= 3 &&
        d5.constraints.media.permitted === true &&
        d5.constraints.media.maxFileSizeBytes > 0 &&
        d5.constraints.media.allowedMimeTypes.join() !== '' &&
        d5.constraints.media.allowedMimeTypes.every((m: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(m)) &&
        !d5.constraints.media.allowedMimeTypes.some((m: string) => /svg|heic/.test(m)) &&
        photosField?.fieldType === 'MEDIA' &&
        photosField.behavior === 'PROVIDER_REQUIRED' &&
        photosField.supported === true &&
        photosField.minItems === 1 &&
        photosField.maxItems === 3 &&
        d5.variants.length === 0 &&
        d5.addOns.length === 0 &&
        d5.media.length === 0 &&
        d5.children.variantCount === 0 &&
        d5.children.addOnCount === 0 &&
        d5.children.mediaCount === 0 &&
        d5.children.mediaRequirementSatisfied === false,
      `(5) the draft's constraints name the permissions and the photo bounds (${JSON.stringify({ c: d5.constraints, p: photosField, ch: d5.children })})`,
    );
    const maxVariants: number = d5.constraints.variants.maxCount;
    const maxAddOns: number = d5.constraints.addOns.maxCount;
    const altMax: number = d5.constraints.media.altTextMaxLength;
    const maxFile: number = d5.constraints.media.maxFileSizeBytes;
    const minEdge: number = d5.constraints.media.minEdgePixels;
    const maxEdge: number = d5.constraints.media.maxEdgePixels;
    const nameMax: number = d5.constraints.variants.nameMaxLength;
    const descMax: number = d5.constraints.variants.descriptionMaxLength;
    assert(
      maxFile > 0 && maxFile <= 26_214_400 && minEdge <= 256 && maxEdge >= 8000,
      `(5) this smoke assumes the seeded media policy (file ${maxFile}, edges ${minEdge}-${maxEdge})`,
    );
    // the base content: a draft can only be published once the photo requirement is met too
    const saveBase = {
      expectedRevision: 1,
      title,
      shortPitch: text.pitch,
      description: text.description,
      priceAmountMinor: 15000,
      durationMinutes: 120,
      fieldValues: [{ fieldKey: 'finish', value: 'wax' }],
    };
    const base = read(GigDetailResponse, await gig('PUT', `/gigs/${gigId}/draft`, token, saveBase), 200, '(5) PUT draft');
    assert(
      base.draftVersion.revision === 2 &&
        base.draftVersion.publishable === false &&
        base.draftVersion.issues.length === 1 &&
        base.draftVersion.issues[0].reason === 'MEDIA_REQUIRED' &&
        base.draftVersion.issues[0].messageKey === 'provider.gig.issue.media_required',
      `(5) with the content saved the only thing missing is the required photo (${JSON.stringify(base.draftVersion.issues)})`,
    );
    // a MEDIA field is satisfied by attachments, never by a field value
    const mediaValue = await gig('PUT', `/gigs/${gigId}/draft`, token, {
      ...saveBase,
      expectedRevision: 2,
      fieldValues: [...saveBase.fieldValues, { fieldKey: 'photos', value: 'x' }],
    });
    refusal(mediaValue, [400], ['VALIDATION_FAILED'], '(5) a value for a MEDIA field');
    assert(hasIssue(mediaValue, 'FIELD_MEDIA_NOT_A_VALUE'), '(5) a MEDIA field value is refused with FIELD_MEDIA_NOT_A_VALUE');
    const menu5 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(5) GET /gigs');
    const row5 = menu5.gigs.find((g: Json) => g.gig.gigId === gigId);
    assert(
      row5.draftVersion.children.mediaRequirementSatisfied === false &&
        row5.draftVersion.children.variantCount === 0 &&
        row5.draftVersion.children.mediaCount === 0 &&
        row5.currentVersion === null,
      `(5) the GigMenu says the photo requirement of the draft is unmet (${JSON.stringify(row5.draftVersion)})`,
    );

    // (6) VARIANTS: the whole list is replaced under the revision; every refusal changes nothing; keys are minted by the server; order is the array order
    const putOpts = (kind: 'variants' | 'add-ons', rev: number, items: unknown, extra: Record<string, unknown> = {}): Promise<Reply> =>
      gig('PUT', `/gigs/${gigId}/draft/${kind}`, token, { expectedRevision: rev, [kind === 'variants' ? 'variants' : 'addOns']: items, ...extra });
    const opt = (name: string, description: string | null, priceDeltaMinor: number, durationDeltaMinutes: number, k?: string): Json => ({
      ...(k ? { key: k } : {}),
      name,
      description,
      priceDeltaMinor,
      durationDeltaMinutes,
    });
    const optShape = ['description', 'displayOrder', 'durationDeltaMinutes', 'key', 'name', 'priceDeltaMinor'];
    const stateOf = async (): Promise<string> => {
      const d = await draftOf(gigId);
      return JSON.stringify({ r: d.revision, v: d.variants, a: d.addOns, m: d.media.map((x: Json) => x.mediaId) });
    };
    const stuff = async (kind: 'variants' | 'add-ons', what: string, items: unknown, extra: Record<string, unknown>, reason?: string): Promise<void> => {
      const before = await stateOf();
      const rev = (await draftOf(gigId)).revision;
      const r = await putOpts(kind, rev, items, extra);
      if (reason) {
        refusal(r, [400], ['VALIDATION_FAILED'], `(6) ${kind}: ${what}`);
        assert(hasIssue(r, reason), `(6) ${kind}: ${what}: expected the issue ${reason} (${JSON.stringify(r.json?.error?.details?.issues)})`);
      } else assert(r.status === 400, `(6) ${kind}: ${what} must be 400 (got ${r.status} ${r.json?.error?.code ?? ''})`);
      assert((await stateOf()) === before, `(6) ${kind}: ${what} wrote something`);
    };
    const NFC = 'Caf' + String.fromCodePoint(0xe9);
    const NFD = 'Cafe' + String.fromCodePoint(0x301);
    for (const kind of ['variants', 'add-ons'] as const) {
      const max = kind === 'variants' ? maxVariants : maxAddOns;
      await stuff(kind, 'a blank name', [opt('   ', null, 0, 0)], {}, 'OPTION_NAME_REQUIRED');
      await stuff(kind, 'a name beyond the configured length', [opt('N'.repeat(nameMax + 1), null, 0, 0)], {}, 'OPTION_NAME_TOO_LONG');
      await stuff(kind, 'a description beyond the configured length', [opt('Ok name', 'D'.repeat(descMax + 1), 0, 0)], {}, 'OPTION_DESCRIPTION_TOO_LONG');
      await stuff(kind, 'the same name twice (case and spaces)', [opt('Alpha', null, 0, 0), opt('  alpha ', null, 5, 5)], {}, 'OPTION_NAME_DUPLICATE');
      await stuff(kind, 'the same name twice (NFC and NFD)', [opt(NFC, null, 0, 0), opt(NFD, null, 5, 5)], {}, 'OPTION_NAME_DUPLICATE');
      await stuff(kind, 'a key the draft does not have', [opt('Alpha', null, 0, 0, 'opt_deadbeef0000')], {}, 'OPTION_KEY_INVALID');
      await stuff(
        kind,
        'more items than the configured maximum',
        Array.from({ length: max + 1 }, (_, i) => opt(`Item ${i}`, null, 0, 0)),
        {},
        'OPTIONS_COUNT_EXCEEDED',
      );
      // the coerced-body table: nothing here is a valid body
      await stuff(kind, 'a fractional price delta', [opt('Alpha', null, 1.5, 0)], {});
      await stuff(kind, 'a negative price delta', [opt('Alpha', null, -1, 0)], {});
      await stuff(kind, 'a negative duration delta', [opt('Alpha', null, 0, -5)], {});
      await stuff(kind, 'a price delta as a string', [{ ...opt('Alpha', null, 0, 0), priceDeltaMinor: '10' }], {});
      await stuff(kind, 'a price delta of true', [{ ...opt('Alpha', null, 0, 0), priceDeltaMinor: true }], {});
      await stuff(kind, 'a currency on an item', [{ ...opt('Alpha', null, 0, 0), currency: 'EUR' }], {});
      await stuff(kind, 'an absolute price on an item', [{ ...opt('Alpha', null, 0, 0), priceAmountMinor: 100 }], {});
      await stuff(kind, 'a default flag on an item', [{ ...opt('Alpha', null, 0, 0), isDefault: true }], {});
      await stuff(kind, 'a quantity on an item', [{ ...opt('Alpha', null, 0, 0), quantity: 2 }], {});
      await stuff(kind, 'an account id in the body', [opt('Alpha', null, 0, 0)], { accountId });
      await stuff(kind, 'a currency in the body', [opt('Alpha', null, 0, 0)], { currency: 'EUR' });
      await stuff(kind, 'an item that is not an object', ['Alpha'], {});
      await stuff(kind, 'a list that is not a list', { 0: opt('Alpha', null, 0, 0) }, {});
      await stuff(kind, 'null instead of a list', null, {});
      await stuff(kind, 'the same key twice', [opt('Alpha', null, 0, 0, 'opt_aaaaaaaaaaaa'), opt('Beta', null, 0, 0, 'opt_aaaaaaaaaaaa')], {});
      const rev = (await draftOf(gigId)).revision;
      assert((await gig('PUT', `/gigs/${gigId}/draft/${kind}`, token, '[]')).status === 400, `(6) ${kind}: a body that is not an object must be 400`);
      assert(
        (await gig('PUT', `/gigs/${gigId}/draft/${kind}`, token, { [kind === 'variants' ? 'variants' : 'addOns']: [] })).status === 400,
        `(6) ${kind}: a missing revision must be 400`,
      );
      assert((await putOpts(kind, 0, [])).status === 400, `(6) ${kind}: a revision of zero must be 400`);
      assert((await putOpts(kind, rev + 0.5, [])).status === 400, `(6) ${kind}: a fractional revision must be 400`);
    }
    // a variant key is not an add-on key
    let variantUpdates = 0;
    let addOnUpdates = 0;
    const dv0 = await draftOf(gigId);
    const v1put = read(
      GigDetailResponse,
      await putOpts('variants', dv0.revision, [opt(text.basic, text.basicDesc, 0, 0), opt(text.deluxe, null, 2500, 30), opt(text.premium, null, 6000, 60)]),
      200,
      '(6) PUT variants',
    );
    variantUpdates++;
    const dv1 = v1put.draftVersion;
    assert(
      dv1.revision === dv0.revision + 1 &&
        dv1.variants.length === 3 &&
        dv1.variants.map((v: Json) => v.name).join('|') === [text.basic, text.deluxe, text.premium].join('|') &&
        dv1.variants.map((v: Json) => v.displayOrder).join() === '1,2,3' &&
        dv1.variants.every((v: Json) => itemKeyRe.test(v.key) && Object.keys(v).sort().join() === optShape.join()) &&
        new Set(dv1.variants.map((v: Json) => v.key)).size === 3 &&
        dv1.variants[0].description === text.basicDesc &&
        dv1.variants[1].description === null &&
        dv1.variants[1].priceDeltaMinor === 2500 &&
        dv1.variants[2].durationDeltaMinutes === 60 &&
        dv1.price.amountMinor === 15000 && // the base price is untouched: the deltas are added on top
        dv1.children.variantCount === 3 &&
        dv1.children.variantsValid === true,
      `(6) three variants saved in order, each with a server-minted key and no currency; the revision grew by exactly one (${JSON.stringify(dv1.variants)})`,
    );
    const key0 = Object.fromEntries(dv1.variants.map((v: Json) => [v.name, v.key])) as Record<string, string>;
    // an exact repeat changes nothing (no new revision, no audit row), a stale revision is refused
    const same = read(
      GigDetailResponse,
      await putOpts(
        'variants',
        dv1.revision,
        dv1.variants.map((v: Json) => opt(v.name, v.description, v.priceDeltaMinor, v.durationDeltaMinutes, v.key)),
      ),
      200,
      '(6) PUT variants (unchanged)',
    );
    assert(same.draftVersion.revision === dv1.revision, '(6) saving an unchanged list does not raise the revision');
    refusal(await putOpts('variants', dv0.revision, [opt('Stale', null, 0, 0)]), [409], ['STALE_DRAFT'], '(6) a stale revision');
    // deterministic order: the array order wins, keys stay, one item is edited in the same call
    const reordered = read(
      GigDetailResponse,
      await putOpts('variants', dv1.revision, [
        opt(text.premium, null, 6000, 60, key0[text.premium]),
        opt(text.basic, text.basicDesc, 0, 0, key0[text.basic]),
        opt(text.deluxe, null, 2750, 30, key0[text.deluxe]),
      ]),
      200,
      '(6) PUT variants (reordered)',
    );
    variantUpdates++;
    const dv2 = reordered.draftVersion;
    assert(
      dv2.revision === dv1.revision + 1 &&
        dv2.variants.map((v: Json) => v.name).join('|') === [text.premium, text.basic, text.deluxe].join('|') &&
        dv2.variants.map((v: Json) => v.displayOrder).join() === '1,2,3' &&
        dv2.variants.every((v: Json) => v.key === key0[v.name]) &&
        dv2.variants[2].priceDeltaMinor === 2750,
      `(6) the array order is the display order, keys are stable, the edit is applied (${JSON.stringify(dv2.variants)})`,
    );
    const afterReorder = await gig('GET', `/gigs/${gigId}`, token);
    assert(
      JSON.stringify(read(GigDetailResponse, afterReorder, 200, '(6) GET').draftVersion.variants) === JSON.stringify(dv2.variants),
      '(6) reading again gives the same order',
    );

    // (7) ADD-ONS: the same rules with their own list, key space and permission
    await stuff('add-ons', 'a variant key', [opt(text.wax, null, 0, 0, key0[text.basic])], {}, 'OPTION_KEY_INVALID');
    const da0 = await draftOf(gigId);
    const a1 = read(
      GigDetailResponse,
      await putOpts('add-ons', da0.revision, [opt(text.wax, text.waxDesc, 1500, 15), opt(text.hair, null, 2000, 20)]),
      200,
      '(7) PUT add-ons',
    );
    addOnUpdates++;
    const da1 = a1.draftVersion;
    assert(
      da1.revision === da0.revision + 1 &&
        da1.addOns.length === 2 &&
        da1.addOns.map((a: Json) => a.name).join('|') === [text.wax, text.hair].join('|') &&
        da1.addOns.map((a: Json) => a.displayOrder).join() === '1,2' &&
        da1.addOns.every((a: Json) => itemKeyRe.test(a.key) && Object.keys(a).sort().join() === optShape.join()) &&
        JSON.stringify(da1.variants) === JSON.stringify(dv2.variants) && // the variants are a separate list: untouched
        da1.children.addOnCount === 2 &&
        da1.children.addOnsValid === true &&
        da1.children.variantCount === 3,
      `(7) two add-ons saved in order; the variants did not move (${JSON.stringify(da1.addOns)})`,
    );
    const addOnKeys = da1.addOns.map((a: Json) => a.key);
    assert(
      addOnKeys.every((k: string) => !Object.values(key0).includes(k)),
      '(7) an add-on key is never a variant key',
    );
    const sameA = read(
      GigDetailResponse,
      await putOpts(
        'add-ons',
        da1.revision,
        da1.addOns.map((a: Json) => opt(a.name, a.description, a.priceDeltaMinor, a.durationDeltaMinutes, a.key)),
      ),
      200,
      '(7) PUT add-ons (unchanged)',
    );
    assert(sameA.draftVersion.revision === da1.revision, '(7) an unchanged add-on list does not raise the revision');
    refusal(await putOpts('add-ons', da0.revision, []), [409], ['STALE_DRAFT'], '(7) a stale revision');

    // (8) publishing is blocked without a photo; the issue is an identifier with its content key
    const blocked8 = refusal(
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: da1.revision }),
      [409, 422],
      ['PUBLISH_BLOCKED'],
      '(8) publishing without the required photo',
    );
    assert(hasIssue(blocked8, 'MEDIA_REQUIRED'), `(8) the refusal names MEDIA_REQUIRED (${JSON.stringify(blocked8.json.error.details?.issues)})`);
    assert((await draftOf(gigId)).revision === da1.revision, '(8) a refused publish changes nothing');

    // (9) photos: the authorization is refused for everything the policy does not allow, and writes nothing
    const png = (shade: number, label: string): Buffer => synthPng(256, 256, shade, `${label} ${runId}`);
    const imgA = png(90, 'a');
    const imgB = synthJpeg(256, `b ${runId}`);
    const imgC = synthWebp(256, 128, 200, 60);
    const imgD = synthWebp(256, 30, 90, 200);
    const authorize = (
      rev: number,
      o: { mimeType: string; sizeBytes: number; fieldKey?: string; sha256?: string; altText?: string | null },
      extra: Record<string, unknown> = {},
    ): Promise<Reply> =>
      gig(
        'POST',
        `/gigs/${gigId}/draft/media/uploads`,
        token,
        {
          expectedRevision: rev,
          fieldKey: o.fieldKey ?? 'photos',
          mimeType: o.mimeType,
          sizeBytes: o.sizeBytes,
          ...(o.sha256 ? { sha256: o.sha256 } : {}),
          altText: o.altText ?? null,
          ...extra,
        },
        false,
      );
    const noChange = async (what: string, fn: () => Promise<Reply>, statuses: number[], codes: string[]): Promise<Reply> => {
      const before = await stateOf();
      const r = await fn();
      refusal(r, statuses, codes, `(9) ${what}`);
      if (codes.includes('MEDIA_REFUSED') && isCode(r.json?.error?.code, 'MEDIA_REFUSED')) {
        const reason = r.json.error.details?.reason;
        assert(
          typeof reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(reason),
          `(9) ${what}: a media refusal names an allow-listed reason (${JSON.stringify(r.json.error.details)})`,
        );
        reasons[what] = reason;
      }
      assert((await stateOf()) === before, `(9) ${what} wrote something`);
      return r;
    };
    const rev9 = (await draftOf(gigId)).revision;
    for (const mime of ['image/gif', 'image/svg+xml', 'text/html', 'application/pdf', 'image/heic'])
      await noChange(`a file type that is not allowed (${mime})`, () => authorize(rev9, { mimeType: mime, sizeBytes: 1000 }), [400], ['MEDIA_REFUSED']);
    await noChange('a size above the configured maximum', () => authorize(rev9, { mimeType: 'image/png', sizeBytes: maxFile + 1 }), [400], ['MEDIA_REFUSED']);
    await noChange(
      'a field that is not a photo field',
      () => authorize(rev9, { mimeType: 'image/png', sizeBytes: 1000, fieldKey: 'finish' }),
      [400, 404],
      ['MEDIA_REFUSED', 'VALIDATION_FAILED'],
    );
    await noChange(
      'a field the template does not have',
      () => authorize(rev9, { mimeType: 'image/png', sizeBytes: 1000, fieldKey: 'no_such_field' }),
      [400, 404],
      ['MEDIA_REFUSED', 'VALIDATION_FAILED'],
    );
    await noChange(
      'an alt text beyond the configured length',
      () => authorize(rev9, { mimeType: 'image/png', sizeBytes: 1000, altText: 'x'.repeat(altMax + 1) }),
      [400],
      ['VALIDATION_FAILED', 'MEDIA_REFUSED'],
    );
    await noChange('a stale revision', () => authorize(rev9 - 1, { mimeType: 'image/png', sizeBytes: 1000 }), [409], ['STALE_DRAFT']);
    for (const [what, extra] of [
      ['an account id', { accountId }],
      ['an object key', { objectKey: 'provider/gig-media/x' }],
      ['a url', { url: 'http://example.test/x' }],
      ['a gig version id', { gigVersionId: randomUUID() }],
      ['a status', { status: 'READY' }],
    ] as const)
      assert((await authorize(rev9, { mimeType: 'image/png', sizeBytes: 1000 }, extra)).status === 400, `(9) an upload request naming ${what} must be 400`);
    for (const [what, patch] of [
      ['a size of zero', { sizeBytes: 0 }],
      ['a negative size', { sizeBytes: -1 }],
      ['a fractional size', { sizeBytes: 10.5 }],
      ['a size above the structural ceiling', { sizeBytes: 30_000_000 }],
      ['a size as a string', { sizeBytes: '1000' }],
      ['a malformed hash', { sha256: 'xyz' }],
      ['an upper-case hash', { sha256: 'A'.repeat(64) }],
    ] as const) {
      const body: Record<string, unknown> = { expectedRevision: rev9, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1000, altText: null };
      Object.assign(body, patch);
      const r = await gig('POST', `/gigs/${gigId}/draft/media/uploads`, token, body, false);
      assert(r.status === 400, `(9) an upload request with ${what} must be 400 (got ${r.status})`);
    }
    assert((await stateOf()) === JSON.stringify({ r: rev9, v: dv2.variants, a: da1.addOns, m: [] }), '(9) refused authorizations wrote nothing');

    // (10) uploaded files that lie, are hostile or do not match: each is refused at finalize, and nothing of it stays in the draft. The presigned PUT goes straight to the store.
    let authorizations = 0;
    const putTo = async (upload: Json, bytes: Buffer, type: string): Promise<number> => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((upload.headers ?? {}) as Record<string, unknown>))
        if (!['content-length', 'host'].includes(k.toLowerCase())) headers[k] = String(v);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
      const r = await fetch(upload.url, { method: 'PUT', headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(10_000) });
      return r.status;
    };
    const noteUrl = (u: string): void => {
      const url = new URL(u);
      const sig = url.searchParams.get('X-Amz-Signature') ?? url.search.slice(1);
      if (sig.length >= 16) secretsOfUrls.push(sig);
    };
    /** Authorizes an upload (201) and checks the answer; returns the pending photo and the one-time target. */
    const authorizeOk = async (
      bytes: Buffer,
      mime: string,
      altText: string | null,
      withHash = false,
      fieldKey = 'photos',
    ): Promise<{ media: Json; upload: Json; revision: number }> => {
      const rev = (await draftOf(gigId)).revision;
      const r = await authorize(rev, { mimeType: mime, sizeBytes: bytes.length, altText, fieldKey, ...(withHash ? { sha256: sha256(bytes) } : {}) });
      const data = read(GigMediaUploadResponse, r, 201, '(10) authorize an upload');
      authorizations++;
      assert(
        data.media.status === 'UPLOADING' &&
          data.media.fieldKey === fieldKey &&
          data.media.mimeType === mime &&
          data.media.sizeBytes === bytes.length &&
          data.media.width === null &&
          data.media.altText === altText &&
          uuidRe.test(data.media.mediaId) &&
          data.revision === rev + 1 &&
          data.maxSizeBytes > 0 &&
          typeof data.upload.url === 'string' &&
          data.upload.url.startsWith('http') &&
          typeof data.upload.expiresAt === 'string' &&
          !Object.keys(data.media).some((k) => k !== 'fieldKey' && /key|sha|asset|url|hash/i.test(k)),
        `(10) the authorization reserves a pending photo and names a one-object target (${JSON.stringify(data.media)})`,
      );
      noteUrl(data.upload.url);
      return data;
    };
    const finalize = (mediaId: string, rev: number, sha?: string, t: string | null = token): Promise<Reply> =>
      gig('POST', `/gigs/${gigId}/draft/media/${mediaId}/finalize`, t, { expectedRevision: rev, ...(sha ? { sha256: sha } : {}) });
    const refusedFile = async (what: string, bytes: Buffer, mime: string, o: { sha?: string; body?: Buffer; skipPut?: boolean } = {}): Promise<void> => {
      const a = await authorizeOk(bytes, mime, null);
      if (!o.skipPut) assert((await putTo(a.upload, o.body ?? bytes, mime)) < 300, `(10) ${what}: the store accepts the PUT of the authorized object`);
      const r = await finalize(a.media.mediaId, (await draftOf(gigId)).revision, o.sha);
      refusal(r, [400], ['MEDIA_REFUSED'], `(10) ${what}`);
      const reason = r.json.error.details?.reason;
      assert(
        typeof reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(reason),
        `(10) ${what}: the refusal names an allow-listed reason (${JSON.stringify(r.json.error.details)})`,
      );
      reasons[what] = reason;
      assert(!r.text.includes('gig-media/') && !r.text.includes('X-Amz'), `(10) ${what}: the refusal names no object key or link`);
      const left = (await draftOf(gigId)).media.find((m: Json) => m.mediaId === a.media.mediaId);
      if (left) {
        // an object that is merely missing may stay pending (repeatable); anything else must be gone
        assert(o.skipPut === true && left.status === 'UPLOADING', `(10) ${what}: a refused photo must not stay in the draft (${JSON.stringify(left)})`);
        assert(
          (await gig('DELETE', `/gigs/${gigId}/draft/media/${a.media.mediaId}`, token, { expectedRevision: (await draftOf(gigId)).revision })).status === 200,
          `(10) ${what}: remove the pending photo`,
        );
      }
    };
    const html = Buffer.from(`<html><body>not an image ${runId}</body></html>`.padEnd(300, ' '));
    await refusedFile('a web page declared as a PNG', html, 'image/png');
    await refusedFile('a PNG declared as a JPEG', imgA, 'image/jpeg');
    await refusedFile('a JPEG declared as a WebP', imgB, 'image/webp');
    await refusedFile('a hash that differs from the stored bytes', imgA, 'image/png', { sha: '0'.repeat(64) });
    await refusedFile('a body longer than the authorized size', imgA, 'image/png', { body: Buffer.concat([imgA, Buffer.alloc(64, 0)]) }).catch(
      async (e: Error) => {
        // the store may refuse the longer body itself (the signed length): then there is nothing to finalize and the pending photo is removed
        if (!/PUT of the authorized object/.test(e.message)) throw e;
        for (const m of (await draftOf(gigId)).media)
          await gig('DELETE', `/gigs/${gigId}/draft/media/${m.mediaId}`, token, { expectedRevision: (await draftOf(gigId)).revision });
      },
    );
    await refusedFile(
      'an infected file (the harmless EICAR test string inside a PNG)',
      synthPng(256, 256, 90, `EICAR X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H* ${runId}`),
      'image/png',
    );
    await refusedFile('an image below the minimum edge', synthPng(16, 16, 90, `tiny ${runId}`), 'image/png');
    await refusedFile('a header claiming an edge beyond the maximum', synthPng(maxEdge + 1000, 64, 90, `wide ${runId}`, 1), 'image/png');
    await refusedFile('a header claiming more pixels than allowed (decompression bomb)', synthPng(8000, 8000, 90, `bomb ${runId}`, 1), 'image/png');
    await refusedFile('an object that was never uploaded', imgA, 'image/png', { skipPut: true });
    const afterRefusals = await draftOf(gigId);
    assert(
      afterRefusals.media.length === 0 && afterRefusals.children.mediaCount === 0,
      `(10) none of the refused photos is in the draft (${JSON.stringify(afterRefusals.media)})`,
    );

    // (11) the good path: authorize, PUT the bytes to the presigned URL, finalize; the photo is READY, verified and scanned, and no object key is in any answer
    const pendingA = await authorizeOk(imgA, 'image/png', text.altA, true);
    const pendingState = await draftOf(gigId);
    assert(
      pendingState.media.length === 1 &&
        pendingState.media[0].status === 'UPLOADING' &&
        pendingState.children.mediaCount === 0 && // the count of the menu and of PRO-003 is READY photos only
        pendingState.children.mediaRequirementSatisfied === false,
      '(11) an authorized photo is pending and does not satisfy the requirement',
    );
    const blocked11 = refusal(
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: pendingState.revision }),
      [409, 422],
      ['PUBLISH_BLOCKED'],
      '(11) publishing with a pending photo',
    );
    assert(hasIssue(blocked11, 'MEDIA_NOT_READY') || hasIssue(blocked11, 'MEDIA_REQUIRED'), '(11) the refusal names the photo that is not ready');
    assert((await putTo(pendingA.upload, imgA, 'image/png')) < 300, '(11) PUT of the PNG to the presigned URL');
    const fin = read(GigDetailResponse, await finalize(pendingA.media.mediaId, pendingState.revision, sha256(imgA)), 200, '(11) finalize');
    const mediaA = fin.draftVersion.media[0];
    assert(
      fin.draftVersion.media.length === 1 &&
        mediaA.mediaId === pendingA.media.mediaId &&
        mediaA.status === 'READY' &&
        mediaA.mimeType === 'image/png' &&
        mediaA.sizeBytes === imgA.length &&
        mediaA.width === 256 &&
        mediaA.height === 256 &&
        mediaA.altText === text.altA &&
        mediaA.displayOrder === 1 &&
        mediaA.fieldKey === 'photos' &&
        Object.keys(mediaA).sort().join() === ['altText', 'displayOrder', 'fieldKey', 'height', 'mediaId', 'mimeType', 'sizeBytes', 'status', 'width'].join() &&
        fin.draftVersion.revision === pendingState.revision + 1 &&
        fin.draftVersion.children.mediaRequirementSatisfied === true &&
        fin.draftVersion.publishable === true,
      `(11) the finalized photo is READY with verified size, type and dimensions; the requirement is met (${JSON.stringify(mediaA)})`,
    );
    const again = read(GigDetailResponse, await finalize(pendingA.media.mediaId, fin.draftVersion.revision), 200, '(11) finalize again (idempotent)');
    assert(
      again.draftVersion.revision === fin.draftVersion.revision && again.draftVersion.media[0].status === 'READY',
      '(11) finalizing again changes nothing',
    );
    const keysOfAssets = await database.query<{
      id: string;
      object_key: string;
      sha256: string | null;
      scan_status: string;
      status: string;
      mime_type: string;
      width: number | null;
      height: number | null;
    }>(
      `SELECT media_asset_id::text AS id, object_key, sha256, scan_status, status, mime_type, width, height FROM provider.media_assets WHERE account_id = $1::uuid`,
      [accountId],
    );
    const readyA = keysOfAssets.filter((a) => a.sha256 === sha256(imgA));
    assert(
      readyA.length === 1 &&
        readyA[0]!.status === 'READY' &&
        readyA[0]!.scan_status === 'CLEAN' &&
        readyA[0]!.mime_type === 'image/png' &&
        readyA[0]!.width === 256 &&
        readyA[0]!.height === 256,
      `(11) the stored asset is READY, scanned CLEAN, with the SHA-256 of the file (${JSON.stringify(readyA)})`,
    );
    assert(
      keysOfAssets.filter((a) => a.status === 'READY').length === 1 && keysOfAssets.filter((a) => a.status === 'ABANDONED').length >= 8,
      `(11) the refused uploads are ABANDONED and only the good one is READY (${keysOfAssets.map((a) => a.status).join()})`,
    );
    // the replay: the presigned PUT is still valid after finalize; other bytes of the same size and type must change nothing the owner sees (the final key is separate from the upload key)
    const swapped = Buffer.from(imgA);
    swapped[swapped.length - 20] = swapped[swapped.length - 20]! ^ 0xff;
    await putTo(pendingA.upload, swapped, 'image/png').catch(() => 0);

    // (12) three photos (the maximum), the fourth is refused; alt text, order, detach
    const pendingB = await authorizeOk(imgB, 'image/jpeg', null);
    assert((await putTo(pendingB.upload, imgB, 'image/jpeg')) < 300, '(12) PUT of the JPEG');
    const finB = read(GigDetailResponse, await finalize(pendingB.media.mediaId, (await draftOf(gigId)).revision), 200, '(12) finalize the JPEG');
    const mediaB = finB.draftVersion.media.find((m: Json) => m.mediaId === pendingB.media.mediaId);
    assert(
      mediaB.status === 'READY' && mediaB.mimeType === 'image/jpeg' && mediaB.width === 256 && mediaB.height === 256 && mediaB.displayOrder === 2,
      `(12) the JPEG is READY at 256x256, second (${JSON.stringify(mediaB)})`,
    );
    const pendingC = await authorizeOk(imgC, 'image/webp', text.altC);
    assert((await putTo(pendingC.upload, imgC, 'image/webp')) < 300, '(12) PUT of the WebP');
    const finC = read(GigDetailResponse, await finalize(pendingC.media.mediaId, (await draftOf(gigId)).revision), 200, '(12) finalize the WebP');
    const mediaC = finC.draftVersion.media.find((m: Json) => m.mediaId === pendingC.media.mediaId);
    assert(
      mediaC.status === 'READY' && mediaC.mimeType === 'image/webp' && mediaC.width === 256 && mediaC.height === 256 && mediaC.displayOrder === 3,
      `(12) the WebP is READY at 256x256, third (${JSON.stringify(mediaC)})`,
    );
    assert(finC.draftVersion.media.length === 3 && finC.draftVersion.children.mediaCount === 3, '(12) three photos in the draft');
    await noChange(
      'a fourth photo beyond the field maximum',
      async () => authorize((await draftOf(gigId)).revision, { mimeType: 'image/png', sizeBytes: imgA.length }),
      [400, 409],
      ['VALIDATION_FAILED', 'MEDIA_REFUSED'],
    );
    const [idA, idB, idC] = [mediaA.mediaId as string, mediaB.mediaId as string, mediaC.mediaId as string];
    const updateAlt = (mediaId: string, rev: number, altText: string | null, extra: Record<string, unknown> = {}): Promise<Reply> =>
      gig('PUT', `/gigs/${gigId}/draft/media/${mediaId}`, token, { expectedRevision: rev, altText, ...extra });
    let rev12 = (await draftOf(gigId)).revision;
    refusal(await updateAlt(idA, rev12 - 1, text.altA2), [409], ['STALE_DRAFT'], '(12) alt text with a stale revision');
    assert((await updateAlt(idA, rev12, 'x'.repeat(altMax + 1))).status === 400, '(12) an alt text beyond the configured length must be 400');
    assert((await updateAlt(idA, rev12, text.altA2, { sha256: '0'.repeat(64) })).status === 400, '(12) an alt text request naming a hash must be 400');
    assert((await updateAlt(idA, rev12, text.altA2, { displayOrder: 1 })).status === 400, '(12) an alt text request naming a display order must be 400');
    refusal(await updateAlt(randomUUID(), rev12, text.altA2), [404], ['MEDIA_NOT_FOUND'], '(12) alt text of a photo that does not exist');
    const alted = read(GigDetailResponse, await updateAlt(idA, rev12, text.altA2), 200, '(12) alt text');
    assert(
      alted.draftVersion.revision === rev12 + 1 && alted.draftVersion.media.find((m: Json) => m.mediaId === idA).altText === text.altA2,
      '(12) the alt text is saved and the revision grew by one',
    );
    rev12 = alted.draftVersion.revision;
    // the whole order: a partial, repeated, foreign or unknown list is refused and nothing moves
    const order = (rev: number, ids: string[], extra: Record<string, unknown> = {}): Promise<Reply> =>
      gig('PUT', `/gigs/${gigId}/draft/media/order`, token, { expectedRevision: rev, mediaIds: ids, ...extra });
    const orderBefore = await stateOf();
    for (const [what, ids] of [
      ['a list missing a photo', [idC, idA]],
      ['a list with a photo twice', [idC, idA, idA]],
      ['a list with an unknown photo', [idC, idA, randomUUID()]],
      ['an empty list', []],
    ] as const)
      refusal(await order(rev12, [...ids]), [400, 404], ['VALIDATION_FAILED', 'MEDIA_REFUSED', 'MEDIA_NOT_FOUND'], `(12) ${what}`);
    assert((await order(rev12, [idC, idA, idB], { displayOrder: 1 })).status === 400, '(12) an order request with extra keys must be 400');
    refusal(await order(rev12 - 1, [idC, idA, idB]), [409], ['STALE_DRAFT'], '(12) an order with a stale revision');
    assert((await stateOf()) === orderBefore, '(12) refused order changes wrote nothing');
    const ordered = read(GigDetailResponse, await order(rev12, [idC, idA, idB]), 200, '(12) reorder');
    assert(
      ordered.draftVersion.media.map((m: Json) => m.mediaId).join() === [idC, idA, idB].join() &&
        ordered.draftVersion.media.every((m: Json, i: number, all: Json[]) => i === 0 || all[i - 1].displayOrder < m.displayOrder) &&
        ordered.draftVersion.revision === rev12 + 1,
      `(12) the photos follow the submitted order, strictly increasing (${JSON.stringify(ordered.draftVersion.media.map((m: Json) => [m.mediaId === idC ? 'c' : m.mediaId === idA ? 'a' : 'b', m.displayOrder]))})`,
    );
    // detach the JPEG: the draft loses it; a second detach is not found; the stored asset is kept (it may be attached elsewhere) until the clean-up decides
    const detach = (mediaId: string, rev: number, t: string | null = token, extra: Record<string, unknown> = {}): Promise<Reply> =>
      gig('DELETE', `/gigs/${gigId}/draft/media/${mediaId}`, t, { expectedRevision: rev, ...extra });
    refusal(await detach(idB, ordered.draftVersion.revision - 1), [409], ['STALE_DRAFT'], '(12) detach with a stale revision');
    assert(
      (await detach(idB, ordered.draftVersion.revision, token, { deleteObject: true })).status === 400,
      '(12) a detach request with extra keys must be 400',
    );
    const detached = read(GigDetailResponse, await detach(idB, ordered.draftVersion.revision), 200, '(12) detach');
    assert(
      detached.draftVersion.media.map((m: Json) => m.mediaId).join() === [idC, idA].join() &&
        detached.draftVersion.children.mediaCount === 2 &&
        detached.draftVersion.children.mediaRequirementSatisfied === true,
      '(12) the JPEG left the draft; two photos remain and the requirement still holds',
    );
    refusal(await detach(idB, detached.draftVersion.revision), [404], ['MEDIA_NOT_FOUND'], '(12) detaching it again');
    // a pending upload that is detached is abandoned
    const pendingGone = await authorizeOk(imgD, 'image/webp', null);
    const detachedPending = read(
      GigDetailResponse,
      await detach(pendingGone.media.mediaId, (await draftOf(gigId)).revision),
      200,
      '(12) detach a pending photo',
    );
    assert(detachedPending.draftVersion.media.length === 2, '(12) a pending photo can be removed before it is finalized');
    const orphan = await database.query<{ status: string }>(
      `SELECT status FROM provider.media_assets WHERE account_id = $1::uuid AND sha256 IS NULL AND status = 'UPLOAD_PENDING'`,
      [accountId],
    );
    assert(orphan.length === 0, `(12) no asset is left pending after the detach (${orphan.length})`);

    // (13) the owner's preview: a short-lived one-object GET URL (never in the HTML or the logs), no-store; the bytes are the ones that were verified, also after the replay
    const preview = async (path: string, t: string | null = token): Promise<Reply> => gig('GET', path, t, undefined, false);
    const pv = read(GigMediaPreviewResponse, await preview(`/gigs/${gigId}/draft/media/${idA}/preview`), 200, '(13) preview');
    noteUrl(pv.url);
    const fetched = await fetch(pv.url, { signal: AbortSignal.timeout(10_000) });
    const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
    assert(
      fetched.status === 200 && sha256(fetchedBytes) === sha256(imgA) && (fetched.headers.get('content-type') ?? '').startsWith('image/png'),
      `(13) the preview URL serves the verified bytes with the stored content type, not the replayed ones (${fetched.status} ${fetched.headers.get('content-type')})`,
    );
    refusal(await preview(`/gigs/${gigId}/draft/media/${randomUUID()}/preview`), [404], ['MEDIA_NOT_FOUND'], '(13) preview of a photo that does not exist');
    assert((await preview(`/gigs/${gigId}/draft/media/not-a-uuid/preview`)).status === 400, '(13) a malformed media id must be 400');

    // (14) publish version 1: the counts reach the audit trail and the event; the version and ALL its children are frozen
    const rev14 = (await draftOf(gigId)).revision;
    const published1 = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: rev14 }), 200, '(14) publish v1');
    const v1 = published1.currentVersion;
    assert(
      published1.gig.status === 'ACTIVE' &&
        v1.versionNumber === 1 &&
        v1.status === 'PUBLISHED' &&
        published1.draftVersion === null &&
        v1.variants.length === 3 &&
        v1.addOns.length === 2 &&
        v1.media.length === 2 &&
        v1.media.every((m: Json) => m.status === 'READY') &&
        v1.children.variantCount === 3 &&
        v1.children.addOnCount === 2 &&
        v1.children.mediaCount === 2 &&
        v1.children.variantsValid === true &&
        v1.children.addOnsValid === true &&
        v1.children.mediaRequirementSatisfied === true,
      `(14) version 1 is PUBLISHED with its 3 variants, 2 add-ons and 2 photos (${JSON.stringify(v1.children)})`,
    );
    const v1Children = JSON.stringify({ v: v1.variants, a: v1.addOns, m: v1.media });
    const v1Id = {
      a: v1.media.find((m: Json) => m.fieldKey === 'photos' && m.altText === text.altA2).mediaId as string,
      c: v1.media.find((m: Json) => m.altText === text.altC).mediaId as string,
    };
    const frozen = async (when: string, rev: number, mediaId: string): Promise<void> => {
      const nodraft = ['NO_DRAFT', 'STALE_DRAFT'];
      refusal(await putOpts('variants', rev, []), [409], nodraft, `${when}: replacing the variants`);
      refusal(await putOpts('add-ons', rev, []), [409], nodraft, `${when}: replacing the add-ons`);
      refusal(await authorize(rev, { mimeType: 'image/png', sizeBytes: imgA.length }), [409], nodraft, `${when}: authorizing a photo`);
      refusal(await updateAlt(mediaId, rev, 'changed'), [404, 409], [...nodraft, 'MEDIA_NOT_FOUND'], `${when}: changing an alt text`);
      refusal(await detach(mediaId, rev), [404, 409], [...nodraft, 'MEDIA_NOT_FOUND'], `${when}: detaching a photo`);
      refusal(
        await order(rev, [mediaId]),
        [400, 404, 409],
        [...nodraft, 'MEDIA_NOT_FOUND', 'VALIDATION_FAILED', 'MEDIA_REFUSED'],
        `${when}: reordering the photos`,
      );
      refusal(await finalize(mediaId, rev), [404, 409], [...nodraft, 'MEDIA_NOT_FOUND'], `${when}: finalizing a photo`);
    };
    await frozen('(14) once published', rev14, v1Id.a);
    const v1Read = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/1`, token), 200, '(14) GET version 1');
    assert(JSON.stringify({ v: v1Read.variants, a: v1Read.addOns, m: v1Read.media }) === v1Children, '(14) version 1 still holds exactly its children');
    const pv1 = read(GigMediaPreviewResponse, await preview(`/gigs/${gigId}/versions/1/media/${v1Id.a}/preview`), 200, '(14) preview of a published photo');
    noteUrl(pv1.url);
    refusal(
      await preview(`/gigs/${gigId}/draft/media/${v1Id.a}/preview`),
      [404, 409],
      ['MEDIA_NOT_FOUND', 'NO_DRAFT'],
      '(14) the draft route does not serve a published photo',
    );

    // (15) the GigMenu: counts and facts, no links; Go-Live is never evaluated
    const menu15 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(15) GET /gigs');
    const row15 = menu15.gigs.find((g: Json) => g.gig.gigId === gigId);
    assert(
      row15.currentVersion.children.variantCount === 3 &&
        row15.currentVersion.children.addOnCount === 2 &&
        row15.currentVersion.children.mediaCount === 2 &&
        row15.currentVersion.children.variantsValid === true &&
        row15.currentVersion.children.addOnsValid === true &&
        row15.currentVersion.children.mediaRequirementSatisfied === true &&
        row15.draftVersion === null &&
        menu15.readiness.hasPublishedGig === true &&
        menu15.readiness.goLive.evaluated === false &&
        menu15.readiness.goLive.eligible === false,
      `(15) the GigMenu row carries the counts and facts of the published version (${JSON.stringify(row15.currentVersion.children)})`,
    );

    // (16) the next draft COPIES the variants and add-ons (same keys, same order) and RE-ATTACHES the same photos (no new asset); version 1 stays as it was
    const assetCount = async (): Promise<number> =>
      (await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider.media_assets WHERE account_id = $1::uuid`, [accountId]))[0]!.n;
    const assetsBeforeCopy = await assetCount();
    const next = read(GigDetailResponse, await gig('POST', `/gigs/${gigId}/versions`, token, {}), 201, '(16) POST /versions');
    const d2 = next.draftVersion;
    assert(
      d2.versionNumber === 2 &&
        d2.revision === 1 &&
        JSON.stringify(d2.variants) === JSON.stringify(v1.variants) &&
        JSON.stringify(d2.addOns) === JSON.stringify(v1.addOns) &&
        d2.media.length === 2 &&
        d2.media.map((m: Json) => `${m.fieldKey}|${m.displayOrder}|${m.status}|${m.mimeType}|${m.sizeBytes}|${m.width}x${m.height}|${m.altText}`).join() ===
          v1.media.map((m: Json) => `${m.fieldKey}|${m.displayOrder}|${m.status}|${m.mimeType}|${m.sizeBytes}|${m.width}x${m.height}|${m.altText}`).join() &&
        d2.media.every((m: Json) => !v1.media.some((o: Json) => o.mediaId === m.mediaId)) && // a photo of a version is its own attachment
        d2.children.variantCount === 3 &&
        d2.children.addOnCount === 2 &&
        d2.children.mediaCount === 2 &&
        d2.children.mediaRequirementSatisfied === true &&
        d2.publishable === true,
      `(16) draft 2 starts with the same variants (same keys and order), add-ons and photos (${JSON.stringify(d2.children)})`,
    );
    assert((await assetCount()) === assetsBeforeCopy, '(16) copying the photos created no new stored asset (no binary copy)');
    const mediaOfVersion = async (n: number): Promise<{ asset: string; order: number; alt: string | null }[]> =>
      database.query<{ asset: string; order: number; alt: string | null }>(
        `SELECT m.media_asset_id::text AS asset, m.display_order AS "order", m.alt_text AS alt
           FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
          WHERE v.gig_id = $1::uuid AND v.version_number = $2::int ORDER BY m.display_order`,
        [gigId, n],
      );
    const att1 = await mediaOfVersion(1);
    const att2 = await mediaOfVersion(2);
    assert(
      att1.length === 2 && att2.length === 2 && att1.every((a, i) => a.asset === att2[i]!.asset),
      `(16) both versions point at the very same stored assets (${att1.map((a) => a.asset.slice(0, 8))} / ${att2.map((a) => a.asset.slice(0, 8))})`,
    );
    const menu16 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(16) GET /gigs');
    assert(
      menu16.gigs[0].draftVersion.children.mediaCount === 2 &&
        menu16.gigs[0].currentVersion.children.mediaCount === 2 &&
        menu16.readiness.draftVersionCount === 1,
      '(16) the menu shows the counts of the draft next to the published version',
    );

    // (17) edit draft 2: an edited variant (same key), a third add-on, an edited alt text and one more photo; version 1 does not change
    let d2now = await draftOf(gigId);
    const edited = read(
      GigDetailResponse,
      await putOpts(
        'variants',
        d2now.revision,
        d2now.variants.map((v: Json) =>
          v.name === text.deluxe ? opt(text.editedDeluxe, null, 3000, 45, v.key) : opt(v.name, v.description, v.priceDeltaMinor, v.durationDeltaMinutes, v.key),
        ),
      ),
      200,
      '(17) edit a variant in draft 2',
    );
    variantUpdates++;
    d2now = edited.draftVersion;
    assert(
      d2now.variants.find((v: Json) => v.key === key0[text.deluxe]).name === text.editedDeluxe &&
        d2now.variants.find((v: Json) => v.key === key0[text.deluxe]).priceDeltaMinor === 3000,
      '(17) the variant keeps its key and takes the edit',
    );
    const addedA = read(
      GigDetailResponse,
      await putOpts('add-ons', d2now.revision, [
        ...d2now.addOns.map((a: Json) => opt(a.name, a.description, a.priceDeltaMinor, a.durationDeltaMinutes, a.key)),
        opt(text.shine, null, 800, 10),
      ]),
      200,
      '(17) add a third add-on in draft 2',
    );
    addOnUpdates++;
    d2now = addedA.draftVersion;
    assert(
      d2now.addOns.length === 3 && d2now.addOns.slice(0, 2).every((a: Json, i: number) => a.key === v1.addOns[i].key) && itemKeyRe.test(d2now.addOns[2].key),
      '(17) the new add-on is last, the first two keep their keys',
    );
    const d2a = d2now.media.find((m: Json) => m.altText === text.altA2).mediaId as string;
    d2now = read(GigDetailResponse, await updateAlt(d2a, d2now.revision, text.altD), 200, '(17) alt text in draft 2').draftVersion;
    const pendingD = await authorizeOk(imgD, 'image/webp', text.altA);
    assert((await putTo(pendingD.upload, imgD, 'image/webp')) < 300, '(17) PUT of the second WebP');
    d2now = read(
      GigDetailResponse,
      await finalize(pendingD.media.mediaId, (await draftOf(gigId)).revision, sha256(imgD)),
      200,
      '(17) finalize the new photo',
    ).draftVersion;
    assert(
      d2now.media.length === 3 && d2now.media[2].status === 'READY' && d2now.media[2].altText === text.altA && d2now.children.mediaCount === 3,
      '(17) draft 2 holds three READY photos, the new one last',
    );
    const att2b = await mediaOfVersion(2);
    const att1b = await mediaOfVersion(1);
    assert(
      att1b.map((a) => `${a.asset}|${a.alt}`).join() === att1.map((a) => `${a.asset}|${a.alt}`).join() &&
        att2b.length === 3 &&
        att2b.slice(0, 2).every((a, i) => a.asset === att1b[i]!.asset) &&
        att2b[2]!.asset !== att1b[0]!.asset &&
        (await assetCount()) === assetsBeforeCopy + 1,
      '(17) the old photos are shared by both versions and only the new one is a new asset',
    );
    const v1After = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/1`, token), 200, '(17) GET version 1');
    assert(
      JSON.stringify({ v: v1After.variants, a: v1After.addOns, m: v1After.media }) === v1Children && v1After.status === 'PUBLISHED',
      '(17) version 1 is untouched by every edit of draft 2',
    );

    // (18) another account cannot see or touch any of it: 404, indistinguishable from nothing at all (customer.dev and provider.dev)
    const nowhere = randomUUID();
    const nowhereMedia = randomUUID();
    for (const who of ['customer', 'provider'] as const) {
      const other = await login('bananagig-web', WEB_REDIRECT_URI, DEV_USERS[who]);
      const probes: [string, 'GET' | 'POST' | 'PUT' | 'DELETE', string, unknown][] = [
        ['replace the variants', 'PUT', '/draft/variants', { expectedRevision: 1, variants: [] }],
        ['replace the add-ons', 'PUT', '/draft/add-ons', { expectedRevision: 1, addOns: [] }],
        [
          'authorize an upload',
          'POST',
          '/draft/media/uploads',
          { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1000, altText: null },
        ],
        ['finalize', 'POST', `/draft/media/${pendingD.media.mediaId}/finalize`, { expectedRevision: 1 }],
        ['alt text', 'PUT', `/draft/media/${pendingD.media.mediaId}`, { expectedRevision: 1, altText: null }],
        ['detach', 'DELETE', `/draft/media/${pendingD.media.mediaId}`, { expectedRevision: 1 }],
        ['reorder', 'PUT', '/draft/media/order', { expectedRevision: 1, mediaIds: [] }],
        ['preview a draft photo', 'GET', `/draft/media/${pendingD.media.mediaId}/preview`, undefined],
        ['preview a published photo', 'GET', `/versions/1/media/${v1Id.a}/preview`, undefined],
      ];
      for (const [what, method, suffix, body] of probes) {
        const theirs = refusal(
          await gig(method, `/gigs/${gigId}${suffix}`, other, body, false),
          [404],
          ['GIG_NOT_FOUND', 'GIG_VERSION_NOT_FOUND', 'MEDIA_NOT_FOUND', 'NO_DRAFT'],
          `(18) ${who}.dev: ${what}`,
        );
        const none = await gig(
          method,
          `/gigs/${nowhere}${suffix.split(pendingD.media.mediaId).join(nowhereMedia).split(v1Id.a).join(nowhereMedia)}`,
          other,
          body,
          false,
        );
        assert(
          none.status === theirs.status && none.json?.error?.code === theirs.json?.error?.code,
          `(18) ${who}.dev: ${what}: someone else's Gig must answer exactly like one that does not exist (${theirs.json?.error?.code} vs ${none.json?.error?.code})`,
        );
        assert(
          !theirs.text.includes(gigId) && !theirs.text.includes(pendingD.media.mediaId) && !theirs.text.includes(text.basic),
          `(18) ${who}.dev: ${what}: the refusal must not echo the Gig or the photo`,
        );
      }
    }
    assert(JSON.stringify(await draftOf(gigId)) === JSON.stringify(d2now), '(18) the refused calls changed nothing in draft 2');
    // the owner naming a photo that is not in this draft is just as unknown
    refusal(await finalize(randomUUID(), d2now.revision), [404], ['MEDIA_NOT_FOUND'], '(18) the owner finalizing an unknown photo');
    refusal(await detach(v1Id.c, d2now.revision), [404], ['MEDIA_NOT_FOUND'], '(18) a published version photo is not a draft photo');

    // (19) the web pages behind Caddy (server-rendered, signed in with the same throwaway identity): the draft editor shows the sections, no link or key is rendered, and the thumbnail
    // route answers with a redirect to a short-lived URL for the owner only
    type Hop = { status: number; location: string | undefined; body: string; cookies: string[]; cacheControl: string | undefined };
    const caddy = (method: 'GET', path: string, cookieHeader?: string): Promise<Hop> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: 'caddy-proxy', port: 80, path, method, headers: { host: 'app.localhost', ...(cookieHeader ? { cookie: cookieHeader } : {}) } },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                body,
                cookies: res.headers['set-cookie'] ?? [],
                cacheControl: res.headers['cache-control'],
              }),
            );
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${path} through Caddy timed out`)));
        req.on('error', reject);
        req.end();
      });
    const jar = new Map<string, string>();
    const absorb = (h: Hop): void => {
      for (const line of h.cookies) {
        const [pair] = line.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const start = await caddy('GET', '/auth/login?returnTo=/provider/gigs');
    absorb(start);
    assert(start.status === 302 && (start.location ?? '').includes('code_challenge_method=S256'), `(19) web login did not start a PKCE flow (${start.status})`);
    const callbackUrl = await completeLogin(kc, start.location!, { redirectUri: `${webPublic}/auth/callback`, username, password });
    const callback = await caddy('GET', `/auth/callback${new URL(callbackUrl).search}`, cookie());
    absorb(callback);
    assert(callback.status === 302 && jar.has('bg_session'), `(19) web callback failed (${callback.status} ${callback.location})`);
    const webPage = async (path: string): Promise<string> => {
      const p = await caddy('GET', path, cookie());
      assert(p.status === 200, `(19) GET ${path.replace(gigId, ':gigId')} -> ${p.status}`);
      assert(
        !/eyJ[A-Za-z0-9_-]{10,}\./.test(p.body) && !p.body.includes(token) && !p.body.includes(accountId) && !p.body.includes(email) && !p.body.includes(e164),
        `(19) ${path.replace(gigId, ':gigId')} leaked a token, the account id or a contact`,
      );
      assert(!/gig-media\/|X-Amz|\.upload\b/.test(p.body), `(19) ${path.replace(gigId, ':gigId')} renders an object key or a signed link`);
      assert(![imgA, imgB, imgC, imgD].some((b) => p.body.includes(sha256(b))), `(19) ${path.replace(gigId, ':gigId')} renders a file hash`);
      return p.body;
    };
    const editorPage = await webPage(`/provider/gigs/${gigId}`);
    assert(
      editorPage.includes(text.editedDeluxe) && editorPage.includes(text.shine) && editorPage.includes(text.wax) && editorPage.includes(text.premium),
      '(19) the draft editor lists the variants and add-ons by name (plain text)',
    );
    const versionPage = await webPage(`/provider/gigs/${gigId}/versions/1`);
    assert(
      versionPage.includes(text.deluxe) && !versionPage.includes(text.editedDeluxe) && !versionPage.includes(text.shine),
      '(19) the page of version 1 shows version 1 only',
    );
    const menuPage = await webPage('/provider/gigs');
    assert(menuPage.includes(title), '(19) the GigMenu page lists the Gig');
    const thumb = await caddy('GET', `/provider/gigs/${gigId}/media/${d2now.media[2].mediaId}`, cookie());
    assert(
      thumb.status === 303 && /^https?:\/\//.test(thumb.location ?? '') && (thumb.cacheControl ?? '').includes('no-store'),
      `(19) the thumbnail route answers 303 with no-store (${thumb.status} ${thumb.cacheControl})`,
    );
    noteUrl(thumb.location!);
    const thumbV1 = await caddy('GET', `/provider/gigs/${gigId}/media/${v1Id.a}?version=1`, cookie());
    assert(thumbV1.status === 303 && /^https?:\/\//.test(thumbV1.location ?? ''), `(19) the thumbnail of a published photo answers 303 (${thumbV1.status})`);
    noteUrl(thumbV1.location!);
    const thumbAnon = await caddy('GET', `/provider/gigs/${gigId}/media/${d2now.media[2].mediaId}`);
    assert(
      thumbAnon.status !== 303 && !thumbAnon.location?.includes('X-Amz') && !thumbAnon.body.includes('X-Amz'),
      `(19) a signed-out visitor gets no redirect to the photo (${thumbAnon.status})`,
    );
    const thumbUnknown = await caddy('GET', `/provider/gigs/${gigId}/media/${randomUUID()}`, cookie());
    assert(thumbUnknown.status === 404, `(19) an unknown photo is 404 (${thumbUnknown.status})`);

    // (20) publish version 2: version 1 is SUPERSEDED with the children it was published with; the new counts are on the version; the children are frozen again
    const published2 = read(
      GigDetailResponse,
      await gig('POST', `/gigs/${gigId}/publish`, token, { expectedRevision: d2now.revision }),
      200,
      '(20) publish v2',
    );
    const v2 = published2.currentVersion;
    assert(
      v2.versionNumber === 2 &&
        v2.status === 'PUBLISHED' &&
        v2.variants.length === 3 &&
        v2.addOns.length === 3 &&
        v2.media.length === 3 &&
        v2.children.variantCount === 3 &&
        v2.children.addOnCount === 3 &&
        v2.children.mediaCount === 3 &&
        published2.versions.find((v: Json) => v.versionNumber === 1).status === 'SUPERSEDED',
      `(20) version 2 is PUBLISHED with 3 variants, 3 add-ons and 3 photos; version 1 is SUPERSEDED (${JSON.stringify(v2.children)})`,
    );
    const v1Final = read(GigVersionResponse, await gig('GET', `/gigs/${gigId}/versions/1`, token), 200, '(20) GET version 1');
    assert(
      v1Final.status === 'SUPERSEDED' && JSON.stringify({ v: v1Final.variants, a: v1Final.addOns, m: v1Final.media }) === v1Children,
      '(20) the superseded version 1 still holds exactly the children it was published with',
    );
    await frozen('(20) once version 2 is published', v2.revision, v2.media[0].mediaId);
    noteUrl(
      read(GigMediaPreviewResponse, await preview(`/gigs/${gigId}/versions/2/media/${v2.media[0].mediaId}/preview`), 200, '(20) preview of a version 2 photo')
        .url,
    );
    const menu20 = read(GigMenuResponse, await gig('GET', '/gigs', token), 200, '(20) GET /gigs');
    assert(
      menu20.gigs[0].currentVersion.children.variantCount === 3 &&
        menu20.gigs[0].currentVersion.children.addOnCount === 3 &&
        menu20.gigs[0].currentVersion.children.mediaCount === 3 &&
        menu20.gigs[0].draftVersion === null &&
        menu20.readiness.goLive.evaluated === false &&
        menu20.readiness.goLive.eligible === false,
      `(20) the GigMenu counts follow the published version; Go-Live stays not evaluated (${JSON.stringify(menu20.gigs[0].currentVersion.children)})`,
    );

    // (21) a template version without the permissions: a Gig built on it is refused variants/add-ons/photos the template does not allow. Template version 2 allows variants only, no photo field.
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { copyFromVersion: 1, reason: 'DEV/TEST ONLY second draft' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/2`, {
      ...definition,
      expectedRevision: 1,
      pricingModels: ['FIXED_WITH_VARIANTS'],
      fields: fieldsBase,
      reason: 'DEV/TEST ONLY second definition',
    });
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/2/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish 2' });
    const gigB = read(GigDetailResponse, await gig('POST', '/gigs', token, { gigTemplateCode: tpl }), 201, '(21) POST /gigs (template version 2)');
    const gigBId: string = gigB.gig.gigId;
    const dB = gigB.draftVersion;
    assert(
      dB.template.gigTemplateVersionNumber === 2 &&
        dB.constraints.variants.permitted === true &&
        dB.constraints.addOns.permitted === false &&
        dB.constraints.media.permitted === false &&
        !dB.fields.some((f: Json) => f.fieldType === 'MEDIA'),
      `(21) the constraints of a Gig on template version 2 allow variants only (${JSON.stringify({ v: dB.constraints.variants, a: dB.constraints.addOns, m: dB.constraints.media })})`,
    );
    const putB = (kind: 'variants' | 'add-ons', rev: number, items: unknown): Promise<Reply> =>
      gig('PUT', `/gigs/${gigBId}/draft/${kind}`, token, { expectedRevision: rev, [kind === 'variants' ? 'variants' : 'addOns']: items });
    const addOnsB = refusal(
      await putB('add-ons', dB.revision, [opt(text.wax, null, 100, 5)]),
      [400],
      ['VALIDATION_FAILED'],
      '(21) add-ons on a template that does not allow them',
    );
    assert(hasIssue(addOnsB, 'OPTIONS_NOT_PERMITTED'), `(21) the refusal names OPTIONS_NOT_PERMITTED (${JSON.stringify(addOnsB.json.error.details?.issues)})`);
    const photoB = await gig(
      'POST',
      `/gigs/${gigBId}/draft/media/uploads`,
      token,
      { expectedRevision: dB.revision, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: imgA.length, altText: null },
      false,
    );
    refusal(photoB, [400, 404], ['MEDIA_REFUSED', 'VALIDATION_FAILED'], '(21) a photo on a template that has no photo field');
    assert((await detail(gigBId)).draftVersion.revision === dB.revision, '(21) the refused calls changed nothing');
    const variantB = read(GigDetailResponse, await putB('variants', dB.revision, [opt(text.basic, null, 0, 0)]), 200, '(21) a variant on template version 2');
    assert(
      variantB.draftVersion.variants.length === 1 && variantB.draftVersion.revision === dB.revision + 1,
      '(21) variants are accepted where the template allows them',
    );
    // the same names in another Gig are fine (names are unique within one list only), and Gig B's photos cannot be Gig A's
    refusal(
      await gig('PUT', `/gigs/${gigBId}/draft/media/${v1Id.a}`, token, { expectedRevision: 2, altText: null }, false),
      [404],
      ['MEDIA_NOT_FOUND'],
      '(21) a photo of another Gig by id',
    );

    // (22) the database: exact rows, the audit trail and outbox hold counts only, nothing of the provider's text, keys, hashes or links is stored in them
    const events = await database.query<{ payload_json: Json }>(
      `SELECT payload_json FROM integration.outbox_events WHERE event_type = 'bananagig.provider.gig-version-published.v1' AND payload_json->>'accountId' = $1::text ORDER BY created_at`,
      [accountId],
    );
    const published = events
      .filter((e) => e.payload_json.gigId === gigId)
      .map((e) => `${e.payload_json.versionNumber}:${e.payload_json.variantCount}/${e.payload_json.addOnCount}/${e.payload_json.mediaCount}`);
    assert(published.join() === '1:3/2/2,2:3/3/3', `(22) the publish events carry the counts and nothing else (${published.join()})`);
    assert(
      events.every(
        (e) =>
          Object.keys(e.payload_json).sort().join() ===
          [
            'accountId',
            'addOnCount',
            'gigId',
            'gigTemplateVersionId',
            'gigVersionId',
            'mediaCount',
            'supersededGigVersionId',
            'variantCount',
            'versionNumber',
          ].join(),
      ),
      '(22) the publish event payload has exactly the contract fields',
    );
    const audit = await database.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM provider.gig_audit_events WHERE account_id = $1::uuid GROUP BY action`,
      [accountId],
    );
    const a = Object.fromEntries(audit.map((r) => [r.action, r.n])) as Record<string, number>;
    assert(
      a.GIG_VARIANTS_UPDATED === variantUpdates + 1 && // + the variant saved on Gig B
        a.GIG_ADD_ONS_UPDATED === addOnUpdates &&
        a.GIG_MEDIA_UPLOAD_AUTHORIZED === authorizations &&
        (a.GIG_MEDIA_ATTACHED ?? 0) >= 4 &&
        (a.GIG_MEDIA_UPLOAD_REFUSED ?? 0) >= 8 &&
        (a.GIG_MEDIA_DETACHED ?? 0) >= 1 &&
        (a.GIG_MEDIA_REORDERED ?? 0) === 1 &&
        (a.GIG_MEDIA_UPDATED ?? 0) >= 2 &&
        a.GIG_VERSION_PUBLISHED === 2,
      `(22) the audit trail holds each change as often as it happened; refused calls wrote nothing (${JSON.stringify(a)}; expected variants ${variantUpdates + 1}, add-ons ${addOnUpdates}, authorizations ${authorizations})`,
    );
    const assets = await database.query<{ id: string; object_key: string; sha256: string | null; status: string; scan_status: string }>(
      `SELECT media_asset_id::text AS id, object_key, sha256, status, scan_status FROM provider.media_assets WHERE account_id = $1::uuid`,
      [accountId],
    );
    const ready = assets.filter((x) => x.status === 'READY');
    assert(
      ready.length === 4 &&
        ready.every((x) => x.scan_status === 'CLEAN') &&
        assets.filter((x) => x.status === 'UPLOAD_PENDING').length === 0 &&
        assets.every((x) => x.status !== 'DELETED'),
      `(22) four verified assets (PNG, JPEG, two WebP) are READY and CLEAN; nothing is pending or deleted (${assets.map((x) => x.status).join()})`,
    );
    const shas = [imgA, imgB, imgC, imgD].map(sha256);
    assert(
      shas.every((s) => ready.some((x) => x.sha256 === s)),
      '(22) every READY asset carries the SHA-256 of its file',
    );
    const attachments = await database.query<{ n: number; d: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT m.media_asset_id)::int AS d FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id WHERE v.gig_id = $1::uuid`,
      [gigId],
    );
    assert(
      attachments[0]!.n === 5 && attachments[0]!.d === 3,
      `(22) five attachments over three assets: the photos are shared across versions, not copied (${JSON.stringify(attachments[0])})`,
    );
    const children = await database.query<{ v: number; a: number }>(
      `SELECT (SELECT count(*)::int FROM provider.gig_version_variants x JOIN provider.gig_versions g ON g.gig_version_id = x.gig_version_id WHERE g.gig_id = $1::uuid) AS v,
              (SELECT count(*)::int FROM provider.gig_version_add_ons x JOIN provider.gig_versions g ON g.gig_version_id = x.gig_version_id WHERE g.gig_id = $1::uuid) AS a`,
      [gigId],
    );
    assert(
      children[0]!.v === 6 && children[0]!.a === 5,
      `(22) the children of Gig A are stored per version (variants 3+3, add-ons 2+3): ${JSON.stringify(children[0])}`,
    );
    const noCurrency = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'provider' AND table_name IN ('gig_version_variants', 'gig_version_add_ons') AND column_name ~* 'currency|quantity|default'`,
    );
    assert(noCurrency[0]!.n === 0, '(22) variants and add-ons store no currency, quantity or default flag (the currency belongs to the version)');
    const stored = await database.query<{ s: string }>(
      `SELECT coalesce((SELECT string_agg(changes::text, ' ') FROM provider.gig_audit_events WHERE account_id = $1::uuid), '') || ' ' ||
              coalesce((SELECT string_agg(payload_json::text, ' ') FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%' AND payload_json->>'accountId' = $1::text), '') AS s`,
      [accountId],
    );
    const objectKeys = assets.map((x) => x.object_key);
    const assetIds = assets.map((x) => x.id);
    assert(objectKeys.length >= 10 && objectKeys.every((k) => k.length > 8), '(22) every upload reserved an object key (kept for the scans)');
    for (const needle of [...providerText, ...objectKeys, ...assetIds, ...shas, ...secretsOfUrls, 'X-Amz', 'gig-media/'])
      assert(!stored[0]!.s.includes(needle), `(22) the audit trail or the outbox holds a name, alt text, key, hash or link: ${needle.slice(0, 24)}`);
    assert(!stored[0]!.s.includes(email) && !stored[0]!.s.includes(e164), '(22) no contact in the audit trail or the outbox');

    // (23) nothing leaked into any Gig response: no object key, asset id, hash or link outside the two documented answers; no later-checkpoint field; Go-Live never evaluated; la-oc untouched
    const everything = seen.join('\n');
    for (const needle of [...objectKeys, ...assetIds, ...shas, ...secretsOfUrls, 'X-Amz', 'gig-media/', accountId, email, e164, token, password])
      assert(!everything.includes(needle), `(23) a Gig API response contains a key, asset id, hash, link, contact or token: ${needle.slice(0, 24)}`);
    const forbiddenKeys =
      /^(objectKey|object_key|storageKey|bucket|sha256|bodySha256|mediaAssetId|assetId|scanStatus|serviceAreas?|serviceArea|radius|availability|capacity|bookings?|cart|quantity|searchRank|ranking|live|isLive|bookable|goLiveEligible|dropEligible)$/i;
    const walk = (value: Json, found: string[]): string[] => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, found));
      else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) {
          if (forbiddenKeys.test(k)) found.push(k);
          walk(v, found);
        }
      return found;
    };
    let goLiveSeen = 0;
    for (let i = 0; i < seen.length; i += 2) {
      let body: Json;
      try {
        body = JSON.parse(seen[i]!);
      } catch {
        continue;
      }
      const bad = walk(body, []);
      assert(bad.length === 0, `(23) a Gig response contains a field that does not belong to a default payload: ${bad.join()}`);
      const stack: Json[] = [body];
      while (stack.length) {
        const cur = stack.pop();
        if (Array.isArray(cur)) stack.push(...cur);
        else if (cur && typeof cur === 'object') {
          if ('goLive' in cur) {
            goLiveSeen++;
            assert(cur.goLive.evaluated === false && cur.goLive.eligible === false, '(23) Go-Live must never be evaluated or eligible');
          }
          stack.push(...Object.values(cur));
        }
      }
    }
    assert(goLiveSeen >= 1, '(23) the GigMenu readiness carries the Go-Live fact');
    const req23 = (await registration('GET', '/requirements', token)).json.data;
    assert(req23.overall.goLive.evaluated === false && req23.overall.goLive.eligible === false, '(23) the registration still does not evaluate Go-Live');
    const laocAfter = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    assert(laocAfter === laocBefore, `(23) la-oc must stay as it was (${laocBefore} -> ${laocAfter})`);
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    const logNeedles: [string, string][] = [
      ['variant name', text.basic],
      ['add-on name', text.wax],
      ['alt text', text.altA],
      ['Gig title', title],
      ['email', email],
      ['phone', e164],
      ['access token', token],
      ...objectKeys.slice(0, 6).map((k): [string, string] => ['object key', k]),
      ...assetIds.slice(0, 4).map((k): [string, string] => ['asset id', k]),
      ...shas.map((k): [string, string] => ['file hash', k]),
      ...secretsOfUrls.slice(0, 8).map((k): [string, string] => ['URL signature', k]),
      ['signed URL parameter', 'X-Amz-Signature'],
    ];
    for (const [what, needle] of logNeedles)
      assert((await query(`{service_name=~"bananagig-.+"} |= \`${needle}\``)).data.result.length === 0, `(23) the ${what} appears in the logs`);

    return (
      `throwaway provider (registration COMPLETED through the real flows) in a DEV/TEST market; template v1 FIXED_WITH_VARIANTS + ADD_ONS + required photos 1..3: variants and add-ons replaced as whole lists under the revision ` +
      `(server-minted keys, array order, ${variantUpdates} + ${addOnUpdates} effective saves, no-op saves do not move the revision, every invalid body refused without a write); publish blocked without a READY photo, then allowed; ` +
      `PNG, JPEG and WebP uploaded through the presigned PUT, verified (type, signature, header dimensions, SHA-256), scanned CLEAN, no key/URL/hash in any response; refused: ${Object.entries(reasons).filter(([k]) => /declared|hash|longer|infected|below|beyond|claiming|never/.test(k)).length} hostile or mismatching files ` +
      `(reasons: ${[...new Set(Object.values(reasons))].sort().join(',')}); 4th photo, alt text, order and detach rules; replay after finalize cannot change the stored bytes; children frozen once published; ` +
      `next draft copies options and re-attaches the SAME stored assets (no binary copy), edits never touch v1; another account gets 404 on every route; template v2 (variants only, no photo field) refuses add-ons and photos; ` +
      `GigMenu counts and facts, Go-Live not evaluated, la-oc ${laocBefore} untouched; audit/outbox/logs hold counts only (no names, alt text, keys, hashes or links)`
    );
  } finally {
    // cleanup: the Gig template, service type and category are RETIRED and the DEV/TEST market deactivated (entities are never deleted; Gigs stay as history); the throwaway user is removed
    try {
      if (admin && marketCreated) {
        await request(`/catalog/gig-templates/${tpl}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/service-types/${serviceType}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/categories/${categoryCode}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/geography/markets/${marketCode}/activation`, 'POST', admin, { active: false, reason: 'smoke cleanup' });
      }
    } catch {
      // best effort: the failure that got us here is the one to report
    }
    try {
      if (kcUserId) await kcAdmin('DELETE', `/users/${kcUserId}`);
    } catch {
      // best effort
    }
    valkey.disconnect();
    await database.close();
  }
});

// ---------------------------------------------------------------- Provider public profile (PRO-002)
await check('Provider public profile', () =>
  providerPublicProfileScenario({
    api,
    kcUrl,
    loginAs: async (client, creds) => {
      const clientId = client === 'web' ? 'bananagig-web' : 'bananagig-admin';
      const redirectUri = client === 'web' ? WEB_REDIRECT_URI : ADMIN_REDIRECT_URI;
      const l = await authorizationCodeLogin(kc, { clientId, redirectUri, ...creds });
      return (await exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId, redirectUri, code: l.code, codeVerifier: l.verifier })).accessToken;
    },
    adminCreds: DEV_USERS.admin,
    openSmsInbox: (valkey) => new FakeSmsInbox(valkey),
    extractSmsCode,
    env,
    get,
    retry,
    sleep,
    expectOk,
    clearLimiterBuckets,
    ensureDevtestGeography,
    kcMasterToken,
  }),
);

await check('Caddy Proxy auth routes', async () => {
  const expectStatus = async (host: string, path: string, ok: (s: number) => boolean, what: string) => {
    const r = await proxy(host, path);
    if (!ok(r.status)) throw new Error(`${what}: ${host}${path} -> ${r.status}`);
  };
  await expectStatus('auth.localhost', '/realms/bananagig/.well-known/openid-configuration', (s) => s === 200, 'realm discovery must be public');
  await expectStatus('auth.localhost', `/realms/bananagig/protocol/openid-connect/certs`, (s) => s === 200, 'JWKS must be public');
  for (const path of [
    '/admin/master/console/',
    '/admin/realms',
    '/realms/master/.well-known/openid-configuration',
    '/health/ready',
    '/health',
    '/metrics',
    '/',
    '/q/health',
  ])
    await expectStatus('auth.localhost', path, (s) => s === 404, 'management/admin path exposed on the public identity host');
  await expectStatus('keycloak-admin.localhost', '/admin/master/console/', (s) => s === 200, 'dev admin console host');
  await expectStatus('api.localhost', '/internal/diagnostics', (s) => s === 404, '/internal must stay blocked');
  await expectStatus('api.localhost', '/api/v1/system/whoami', (s) => s === 401, 'whoami through the proxy must require authentication');
  await expectStatus('app.localhost', '/auth/session', (s) => s === 200, 'web auth routes');
  await expectStatus('admin.localhost', '/', (s) => s === 503, 'admin host is reserved, not served by the customer web app');
  return 'public identity host exposes only realm endpoints; admin/management/internal paths blocked';
});
await check('Feature Flags', async () => {
  await expectOk(`${env('FLAGD_HEALTH_URL', 'http://flagd-flags:8014')}/healthz`);
});
for (const [name, base] of [
  ['Web App', web],
  ['API Service', api],
  ['Worker Service', worker],
] as const) {
  await check(name, async () => {
    await expectOk(`${base}/healthz`);
    await expectOk(`${base}/readyz`);
    return 'healthz + readyz ok';
  });
}

const order = [
  'Postgres DB',
  'PostGIS',
  'Valkey Cache',
  'Keycloak Auth',
  'Keycloak Auth token flow',
  'API Service auth',
  'Web App session',
  'Caddy Proxy auth routes',
  'Configuration Registry',
  'Content Registry',
  'Geography',
  'Addresses',
  'Accounts',
  'Email verification',
  'Phone verification',
  'Sessions and security',
  'Consent',
  'Provider registration',
  'Provider verification',
  'Provider public profile',
  'NATS Events',
  'JetStream',
  'SeaweedFS Storage',
  'OpenSearch Search',
  'Feature Flags',
  'Feature Flags (SDK)',
  'OTel Collector',
  'Prometheus Metrics',
  'Grafana Dashboard',
  'Loki Logs',
  'Tempo Traces',
  'Mailpit Email',
  'Web App',
  'API Service',
  'Worker Service',
  'Worker runtime',
  'API contract + correlation',
  'Web -> API (SSR /system)',
  'Database telemetry',
];
results.sort((a, b) => ((order.indexOf(a.name) + 100) % 100) - ((order.indexOf(b.name) + 100) % 100));
for (const r of results) console.log(`${r.name.padEnd(30)}${r.ok ? (r.label ?? 'healthy').padEnd(10) : 'FAILED    '} ${r.note}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nSMOKE FAILED (${failed.length}/${results.length})` : `\nSMOKE PASSED (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
