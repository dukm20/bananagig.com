// Connectivity smoke test. Runs inside the Compose network (pnpm smoke) and verifies real
// round-trips, not just container status. Exits non-zero if any check fails.
import http from 'node:http';
import { CORRELATION_HEADER, ErrorResponse, SystemInfoResponse, WhoAmIResponse } from '@bananagig/contracts';
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
  // DEV/TEST-only records (devtest.* keys are refused in production). Two real administrators, real PKCE logins, real HTTP.
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
  await publish('MARKET', 'smoke-market', base + 1); // 3. market override
  const resolve = async (market?: string) =>
    (await call(a, 'POST', '/resolve', { keys: [key], context: market ? { market } : {} })).json.data.values[0] as {
      value: number;
      sourceScope: string;
      version: number;
    };
  const inMarket = await resolve('smoke-market'); // 4. resolve with market context
  if (inMarket.value !== base + 1 || inMarket.sourceScope !== 'MARKET') throw new Error('market override did not win'); // 5.
  const elsewhere = await resolve('other-market');
  if (elsewhere.value !== base || elsewhere.sourceScope !== 'PLATFORM') throw new Error('platform value should apply outside the override market');
  const snap = (await call(a, 'POST', '/snapshots', { keys: [key], context: { market: 'smoke-market' }, purpose: 'smoke test' })).json.data; // 6.
  await publish('MARKET', 'smoke-market', base + 2); // 7. change active configuration
  const now = await resolve('smoke-market');
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
