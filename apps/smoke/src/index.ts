// Connectivity smoke test. Runs inside the Compose network (pnpm smoke) and verifies real
// round-trips, not just container status. Exits non-zero if any check fails.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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
