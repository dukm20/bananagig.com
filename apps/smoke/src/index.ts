// Connectivity smoke test. Runs inside the Compose network (pnpm smoke) and verifies real
// round-trips, not just container status. Exits non-zero if any check fails.
import http from 'node:http';
import { AccountService } from '@bananagig/accounts';
import { ACTIVE_ROLE_HEADER, AccountResponse, CORRELATION_HEADER, ErrorResponse, SystemInfoResponse, WhoAmIResponse } from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import { createTokenVerifier, exchangeAuthorizationCode, oidcEndpoints } from '@bananagig/identity';
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
