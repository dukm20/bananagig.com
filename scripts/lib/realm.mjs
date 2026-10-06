// Keycloak realm policy checks and production-build transform. Pure functions over the realm JSON in
// infra/keycloak/bananagig-realm.json (the declarative source of truth for local identity configuration).
const isDevOnly = (c) => c?.attributes?.['bananagig.devOnly'] === 'true';
const isLocalhost = (u) => /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?(\/|$)/i.test(u);

/** Returns a list of policy violations (empty = compliant). `production: true` applies the stricter production rules. */
export function lintRealm(realm, { production = false } = {}) {
  const p = [];
  const clients = realm.clients ?? [];
  const byId = Object.fromEntries(clients.map((c) => [c.clientId, c]));
  if (realm.registrationAllowed) p.push('realm: public registration must be disabled (accounts are created through BananaGig flows)');
  if (!realm.bruteForceProtected) p.push('realm: brute-force protection must be enabled');
  if (!realm.sslRequired || realm.sslRequired === 'none') p.push('realm: sslRequired must not be none');
  if (production && realm.sslRequired !== 'all') p.push('realm: production requires sslRequired=all');
  if (!/length\((\d+)\)/.test(realm.passwordPolicy ?? '') || Number(/length\((\d+)\)/.exec(realm.passwordPolicy)[1]) < 12)
    p.push('realm: password policy must require length >= 12');
  if (realm.otpPolicyType !== 'totp') p.push('realm: TOTP must be the configured OTP policy type');
  const realmRoles = (realm.roles?.realm ?? []).map((r) => r.name).sort();
  if (JSON.stringify(realmRoles) !== JSON.stringify(['customer', 'provider']))
    p.push(`realm: realm roles must be exactly customer and provider (found ${realmRoles.join(', ') || 'none'}); admin roles are client roles`);
  for (const id of ['bananagig-web', 'bananagig-api', 'bananagig-admin']) if (!byId[id]) p.push(`clients: ${id} is missing`);

  for (const c of clients) {
    const where = `client ${c.clientId}`;
    if (c.implicitFlowEnabled) p.push(`${where}: implicit flow must be disabled`);
    if (c.serviceAccountsEnabled) p.push(`${where}: service accounts are not justified yet`);
    if (c.directAccessGrantsEnabled && !isDevOnly(c)) p.push(`${where}: password (direct) grant is only allowed on a client flagged bananagig.devOnly`);
    if (production && isDevOnly(c)) p.push(`${where}: dev-only clients must not exist in a production realm`);
    for (const u of [...(c.redirectUris ?? []), ...(c.webOrigins ?? [])]) {
      if (u.includes('*')) p.push(`${where}: wildcard in redirect URI/web origin (${u}); exact match only`);
      if (production && isLocalhost(u)) p.push(`${where}: localhost URI in production realm (${u})`);
      if (!production && u.startsWith('http://') && !isLocalhost(u)) p.push(`${where}: non-localhost URIs must use https (${u})`);
    }
    if (c.standardFlowEnabled) {
      if (!c.publicClient) p.push(`${where}: browser (standard flow) clients must be public: no client secret in or behind a browser`);
      if (c.attributes?.['pkce.code.challenge.method'] !== 'S256') p.push(`${where}: PKCE method must be S256`);
      if (!c.redirectUris?.length) p.push(`${where}: standard flow requires explicit redirect URIs`);
      if (c.secret) p.push(`${where}: public client must not carry a secret`);
    }
    if (c.fullScopeAllowed) p.push(`${where}: fullScopeAllowed must be false (tokens carry only mapped roles)`);
  }

  const web = byId['bananagig-web'];
  const admin = byId['bananagig-admin'];
  const api = byId['bananagig-api'];
  if (api && (api.standardFlowEnabled || api.directAccessGrantsEnabled || api.implicitFlowEnabled || api.serviceAccountsEnabled))
    p.push('client bananagig-api: resource server only, no token-issuing flows');
  if (web && admin) {
    const overlap = (web.redirectUris ?? []).filter((u) => (admin.redirectUris ?? []).includes(u));
    if (overlap.length) p.push(`admin client must not share redirect URIs with the web client (${overlap.join(', ')})`);
    if (!admin.authenticationFlowBindingOverrides?.browser)
      p.push('client bananagig-admin: must bind its own browser authentication flow (stricter MFA policy)');
    if (admin.authenticationFlowBindingOverrides?.browser === web.authenticationFlowBindingOverrides?.browser)
      p.push('admin and web clients must not share a browser flow');
    if (Number(admin.attributes?.['access.token.lifespan'] ?? Infinity) >= Number(web.attributes?.['access.token.lifespan'] ?? 0))
      p.push('admin access tokens must be shorter-lived than web access tokens');
  }
  if (!(realm.clientScopeMappings?.['bananagig-admin'] ?? []).some((m) => m.roles?.includes('admin-console-access')))
    p.push('bananagig-admin must map the admin-console-access client role');
  // Identity roles must never be granted to the admin client through realm-role scope mappings.
  for (const m of realm.scopeMappings ?? [])
    if (m.client === 'bananagig-admin') p.push('bananagig-admin must not be granted realm roles (customer/provider) via scope mappings');
  // Claim minimization: no profile/email/phone scopes may be attached as defaults.
  for (const c of clients)
    for (const s of c.defaultClientScopes ?? [])
      if (/^(profile|email|phone|address)$/.test(s)) p.push(`client ${c.clientId}: default scope ${s} would add personal data to tokens`);
  for (const s of realm.clientScopes ?? [])
    for (const m of s.protocolMappers ?? [])
      if (/phone|email|address|birth|attribute-mapper/.test(`${m.protocolMapper} ${m.name}`) && m.protocolMapper !== 'oidc-usermodel-realm-role-mapper')
        p.push(`scope ${s.name}: mapper ${m.name} adds personal data`);
  return p;
}

/**
 * Production realm build: removes dev-only clients and users, requires TOTP for the admin browser flow, requires https for all
 * traffic, and replaces the dev origins with the real ones. Throws if origins are missing (no localhost in production).
 */
export function buildProductionRealm(dev, { webUrl, adminUrl }) {
  if (!webUrl || !adminUrl) throw new Error('production realm requires --web-url and --admin-url (https origins)');
  if (!webUrl.startsWith('https://') || !adminUrl.startsWith('https://')) throw new Error('production origins must be https');
  const realm = structuredClone(dev);
  const removed = new Set(realm.clients.filter(isDevOnly).map((c) => c.clientId));
  realm.clients = realm.clients.filter((c) => !isDevOnly(c));
  realm.users = []; // no committed identities in production; admins arrive by invitation only
  realm.scopeMappings = (realm.scopeMappings ?? []).filter((m) => !removed.has(m.client));
  realm.sslRequired = 'all';
  const swap = (v) =>
    typeof v === 'string'
      ? v.replaceAll('http://app.localhost:8080', webUrl.replace(/\/$/, '')).replaceAll('http://admin.localhost:8080', adminUrl.replace(/\/$/, ''))
      : v;
  for (const c of realm.clients) {
    for (const k of ['redirectUris', 'webOrigins']) c[k] = (c[k] ?? []).map(swap);
    for (const k of ['rootUrl', 'baseUrl']) if (c[k]) c[k] = swap(c[k]);
    if (c.attributes?.['post.logout.redirect.uris']) c.attributes['post.logout.redirect.uris'] = swap(c.attributes['post.logout.redirect.uris']);
  }
  // Admin MFA: the OTP sub-flow becomes unconditional, so a user without a TOTP credential is forced to enrol before signing in.
  const forms = realm.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-forms');
  const otpExec = forms.authenticationExecutions.find((e) => e.flowAlias === 'bananagig-admin-browser-otp');
  otpExec.requirement = 'REQUIRED';
  const otp = realm.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-otp');
  otp.authenticationExecutions = otp.authenticationExecutions.filter((e) => e.authenticator !== 'conditional-user-configured');
  return realm;
}
