// Keycloak realm policy checks and production-build transform. Pure functions over the realm JSON in
// infra/keycloak/bananagig-realm.json (the declarative source of truth for local identity configuration).
const isDevOnly = (c) => c?.attributes?.['bananagig.devOnly'] === 'true';
const isLocalhost = (u) => /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?(\/|$)/i.test(u);

/** The ONE client allowed to use a service account (client credentials): the server-side security administration of ID-004. */
export const SECURITY_CLIENT_ID = 'bananagig-security';
/** Realm-management roles its service account may hold. manage-users is the minimum for credentials, sessions, logout and the reset email (lab R5). */
export const SECURITY_SERVICE_ACCOUNT_ROLES = ['manage-users'];
/** The ACR the web client must be floored to (client attribute minimum.acr.value). */
export const WEB_MINIMUM_ACR = 'bananagig:mfa';
/** PRD brute-force rule: 5 failures within 15 minutes lock the user for 15 minutes (temporary, never permanent). */
export const BRUTE_FORCE_RULE = { permanentLockout: false, failureFactor: 5, maxDeltaTimeSeconds: 900, waitIncrementSeconds: 900, maxFailureWaitSeconds: 900 };
/** 30 days: MUST equal the default of the configuration parameter session.keep_signed_in_days (migration 0012; a test checks it). */
export const REMEMBER_ME_SECONDS = 2592000;
/** Refresh-token rotation: one reuse is tolerated so two racing refreshes of the web server do not kill the chain (lab R9). */
export const REFRESH_TOKEN_MAX_REUSE = 1;
/** Keycloak built-in clients that offer self-service account management (console, REST API, application-initiated actions) outside BananaGig. */
export const DISABLED_BUILT_IN_CLIENTS = ['account', 'account-console'];
/** Required actions the product relies on. A realm file that declares `requiredActions` REPLACES Keycloak's defaults, so each of these must be listed and enabled. */
export const REQUIRED_ACTIONS_ENABLED = ['CONFIGURE_TOTP', 'CONFIGURE_RECOVERY_AUTHN_CODES', 'UPDATE_PASSWORD'];
/** Required actions a signed-in user could start with `kc_action=` on any client to change their own credentials unseen by BananaGig. */
export const REQUIRED_ACTIONS_DISABLED = ['delete_credential', 'webauthn-register', 'webauthn-register-passwordless', 'idp_link'];
const REENABLE_NOTE = 'it is re-enabled when the feature that uses it is built (WebAuthn: DEBT-0018; brokered login)';
const isDevSmtpHost = (h) => /^(mailpit|localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(String(h ?? '')) || /\.localhost$/i.test(String(h ?? ''));

/** Finds a flow by alias and returns it with every nested sub-flow's executions flattened (the authenticators used anywhere under it). */
function flowAuthenticators(realm, alias, seen = new Set()) {
  if (seen.has(alias)) return [];
  seen.add(alias);
  const flow = (realm.authenticationFlows ?? []).find((f) => f.alias === alias);
  const out = [];
  for (const e of flow?.authenticationExecutions ?? []) {
    if (e.authenticator) out.push(e);
    if (e.flowAlias) out.push(...flowAuthenticators(realm, e.flowAlias, seen));
  }
  return out;
}

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
    if (c.serviceAccountsEnabled && c.clientId !== SECURITY_CLIENT_ID)
      p.push(`${where}: service accounts are only allowed on ${SECURITY_CLIENT_ID} (no other client may enable them)`);
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
  lintSecurityClient(realm, byId[SECURITY_CLIENT_ID], production, p);
  lintWebSecurity(realm, web, admin, byId, p);
  lintRealmSecurity(realm, production, p);
  lintBuiltInSurface(realm, byId, p);
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

/** bananagig-security: confidential, client credentials only, secret only as a dev_only value (dev) or absent (production), roles from the allowlist. */
function lintSecurityClient(realm, c, production, p) {
  const where = `client ${SECURITY_CLIENT_ID}`;
  const users = realm.users ?? [];
  for (const u of users) {
    if (u.serviceAccountClientId && u.serviceAccountClientId !== SECURITY_CLIENT_ID)
      p.push(`user ${u.username}: service-account user of ${u.serviceAccountClientId}; only ${SECURITY_CLIENT_ID} may have one`);
  }
  if (!c) {
    p.push(`clients: ${SECURITY_CLIENT_ID} is missing (the account security layer needs it)`);
    return;
  }
  if (!c.serviceAccountsEnabled) p.push(`${where}: service accounts must be enabled (client credentials)`);
  if (c.publicClient) p.push(`${where}: must be confidential`);
  if (c.clientAuthenticatorType && c.clientAuthenticatorType !== 'client-secret') p.push(`${where}: must authenticate with a client secret`);
  if (c.standardFlowEnabled || c.directAccessGrantsEnabled || c.implicitFlowEnabled)
    p.push(`${where}: client credentials only (standard, direct-access and implicit flows must be off)`);
  if (c.fullScopeAllowed !== false) p.push(`${where}: fullScopeAllowed must be false`);
  if ((c.redirectUris ?? []).length || (c.webOrigins ?? []).length) p.push(`${where}: must have no redirect URIs or web origins`);
  if (c.authenticationFlowBindingOverrides?.browser) p.push(`${where}: must not bind a browser flow`);
  if (isDevOnly(c)) p.push(`${where}: must not be flagged dev-only (the production build keeps it)`);
  if (production) {
    if (c.secret) p.push(`${where}: the production realm must carry no secret (Keycloak generates one; inject the real one from the secret store)`);
  } else if (typeof c.secret !== 'string' || !/dev_only/.test(c.secret)) {
    p.push(`${where}: the development secret must be present and a dev_only value`);
  }
  // roles: the service-account user, the scope mapping and nothing else
  const sa = users.filter((u) => u.serviceAccountClientId === SECURITY_CLIENT_ID);
  if (sa.length !== 1) p.push(`${where}: exactly one service-account user is required (found ${sa.length})`);
  const allowed = [...SECURITY_SERVICE_ACCOUNT_ROLES].sort();
  for (const u of sa) {
    const held = u.clientRoles ?? {};
    const rm = [...(held['realm-management'] ?? [])].sort();
    if (JSON.stringify(rm) !== JSON.stringify(allowed))
      p.push(`${where}: service-account realm-management roles must be exactly ${allowed.join(', ')} (found ${rm.join(', ') || 'none'})`);
    if (Object.keys(held).some((k) => k !== 'realm-management')) p.push(`${where}: service account must hold no roles of other clients`);
    if ((u.realmRoles ?? []).length) p.push(`${where}: service account must hold no realm roles`);
    if ((u.groups ?? []).length) p.push(`${where}: service account must be in no group`);
    if ((u.credentials ?? []).length) p.push(`${where}: service account must have no credentials`);
  }
  const mapped = (realm.clientScopeMappings?.['realm-management'] ?? []).filter((m) => m.client === SECURITY_CLIENT_ID).flatMap((m) => m.roles ?? []);
  if (JSON.stringify([...mapped].sort()) !== JSON.stringify(allowed))
    p.push(`${where}: scope mapping must be exactly ${allowed.join(', ')} (found ${mapped.join(', ') || 'none'})`);
  for (const [client, maps] of Object.entries(realm.clientScopeMappings ?? []))
    if (client !== 'realm-management')
      for (const m of maps) if (m.client === SECURITY_CLIENT_ID) p.push(`${where}: must not be scope-mapped to roles of ${client}`);
  if ((realm.scopeMappings ?? []).some((m) => m.client === SECURITY_CLIENT_ID)) p.push(`${where}: must not be mapped to realm roles`);
}

/** bananagig-web: own bound browser flow (never the admin one), the MFA floor, and the flow's LoA condition consistent with the realm map. */
function lintWebSecurity(realm, web, admin, byId, p) {
  if (!web) return;
  const flowId = web.authenticationFlowBindingOverrides?.browser;
  const flow = flowId ? (realm.authenticationFlows ?? []).find((f) => f.id === flowId) : undefined;
  if (!flowId) p.push('client bananagig-web: must bind its own browser authentication flow (second factor for users that have one)');
  else if (!flow) p.push(`client bananagig-web: bound browser flow ${flowId} does not exist in the realm`);
  else {
    if (!flow.topLevel) p.push('client bananagig-web: bound flow must be a top-level flow');
    const adminFlowId = admin?.authenticationFlowBindingOverrides?.browser;
    const adminFlow = (realm.authenticationFlows ?? []).find((f) => f.id === adminFlowId);
    if (flowId === adminFlowId || (adminFlow && flow.alias === adminFlow.alias) || /admin/i.test(flow.alias))
      p.push('client bananagig-web: must not be bound to the admin authentication flow');
    for (const c of Object.values(byId))
      if (c !== web && c.authenticationFlowBindingOverrides?.browser === flowId) p.push(`client ${c.clientId}: must not use the web browser flow`);
    const execs = flowAuthenticators(realm, flow.alias);
    const loa = execs.find((e) => e.authenticator === 'conditional-level-of-authentication');
    const level = (realm.authenticatorConfig ?? []).find((a) => a.alias === loa?.authenticatorConfig)?.config?.['loa-condition-level'];
    let map = {};
    try {
      map = JSON.parse(realm.attributes?.['acr.loa.map'] ?? '{}');
    } catch {
      p.push('realm: attributes.acr.loa.map is not valid JSON');
    }
    if (!loa) p.push('client bananagig-web: bound flow must contain a Level of Authentication condition (the MFA floor)');
    else if (String(map[WEB_MINIMUM_ACR]) !== String(level))
      p.push(`client bananagig-web: flow LoA condition level (${level}) must equal acr.loa.map[${WEB_MINIMUM_ACR}] (${map[WEB_MINIMUM_ACR]})`);
    if (!execs.some((e) => e.authenticator === 'auth-otp-form')) p.push('client bananagig-web: bound flow must offer the OTP form');
    if (!execs.some((e) => e.authenticator === 'conditional-user-configured'))
      p.push('client bananagig-web: second factor must be conditional on the user having one (no forced enrolment)');
  }
  if (web.attributes?.['minimum.acr.value'] !== WEB_MINIMUM_ACR)
    p.push(
      `client bananagig-web: attribute minimum.acr.value must be ${WEB_MINIMUM_ACR} (without the floor an authorization request without acr_values skips the second factor)`,
    );
}

/**
 * Keycloak's built-in self-service surface: the account console clients must be declared AND disabled (an undeclared one is created enabled by the import), and the
 * required actions must be declared explicitly (the product ones enabled, the credential-removal one disabled).
 */
function lintBuiltInSurface(realm, byId, p) {
  for (const id of DISABLED_BUILT_IN_CLIENTS) {
    const c = byId[id];
    if (!c)
      p.push(
        `clients: ${id} must be declared with enabled=false (Keycloak otherwise creates the built-in ${id} client enabled: account management outside BananaGig)`,
      );
    else if (c.enabled !== false) p.push(`client ${id}: must be disabled (account management belongs to BananaGig: step-up, audit, session registry)`);
  }
  const actions = realm.requiredActions;
  if (!Array.isArray(actions)) {
    p.push(
      'realm: requiredActions must be declared (Keycloak otherwise leaves delete_credential enabled: a signed-in user could remove their second factor with kc_action)',
    );
    return;
  }
  const by = Object.fromEntries(actions.map((a) => [a.alias, a]));
  for (const alias of REQUIRED_ACTIONS_ENABLED)
    if (!by[alias] || by[alias].enabled !== true) p.push(`realm: required action ${alias} must be declared and enabled (the product uses it)`);
  for (const alias of REQUIRED_ACTIONS_DISABLED)
    if (!by[alias]) p.push(`realm: required action ${alias} must be declared and disabled (${REENABLE_NOTE})`);
    else if (by[alias].enabled !== false)
      p.push(`realm: required action ${alias} must be disabled (credentials are changed through BananaGig step-up, not kc_action; ${REENABLE_NOTE})`);
}

/** Realm-wide security settings fixed by the PRD: brute force, remember-me, refresh rotation, reset ownership, SMTP. */
function lintRealmSecurity(realm, production, p) {
  for (const [k, v] of Object.entries(BRUTE_FORCE_RULE)) if (realm[k] !== v) p.push(`realm: ${k} must be ${v} (PRD brute-force rule), found ${realm[k]}`);
  if (realm.rememberMe !== true) p.push('realm: rememberMe must be enabled (keep me signed in)');
  for (const k of ['ssoSessionIdleTimeoutRememberMe', 'ssoSessionMaxLifespanRememberMe'])
    if (realm[k] !== REMEMBER_ME_SECONDS) p.push(`realm: ${k} must be ${REMEMBER_ME_SECONDS} (= session.keep_signed_in_days default), found ${realm[k]}`);
  if (realm.revokeRefreshToken !== true) p.push('realm: revokeRefreshToken must be true (refresh-token rotation)');
  if (realm.refreshTokenMaxReuse !== REFRESH_TOKEN_MAX_REUSE)
    p.push(`realm: refreshTokenMaxReuse must be ${REFRESH_TOKEN_MAX_REUSE}, found ${realm.refreshTokenMaxReuse}`);
  if (realm.resetPasswordAllowed)
    p.push('realm: resetPasswordAllowed must be false (the BananaGig endpoint starts resets so they are rate limited and recorded)');
  const smtp = realm.smtpServer;
  if (production) {
    if (smtp && isDevSmtpHost(smtp.host))
      p.push('realm: the development SMTP server must not exist in a production realm (provision the production SMTP server separately)');
  } else if (!smtp?.host) p.push('realm: smtpServer.host is required in the development realm (password-reset emails go to Mailpit)');
  if (production)
    for (const u of realm.users ?? []) if (!u.serviceAccountClientId) p.push(`user ${u.username}: only service-account users may exist in a production realm`);
}

/**
 * Production realm build: removes dev-only clients and users (KEEPING the service-account users, and only them: dropping the
 * bananagig-security user would drop its manage-users mapping and Keycloak would recreate it without roles), strips the dev
 * client secret of bananagig-security (Keycloak generates one in the target realm; read it at GET clients/{id}/client-secret or
 * inject it from the secret store, and set KEYCLOAK_SECURITY_CLIENT_SECRET), removes the dev SMTP server (Mailpit; production must
 * provision its own SMTP server for the password-reset email, see SMTP_NOTICE), requires TOTP for the admin browser flow, requires https for all
 * traffic, and replaces the dev origins with the real ones. Throws if origins are missing (no localhost in production).
 */
export function buildProductionRealm(dev, { webUrl, adminUrl }) {
  if (!webUrl || !adminUrl) throw new Error('production realm requires --web-url and --admin-url (https origins)');
  if (!webUrl.startsWith('https://') || !adminUrl.startsWith('https://')) throw new Error('production origins must be https');
  const realm = structuredClone(dev);
  const removed = new Set(realm.clients.filter(isDevOnly).map((c) => c.clientId));
  realm.clients = realm.clients.filter((c) => !isDevOnly(c));
  // no committed identities in production (admins arrive by invitation only), except the service-account users: they carry the
  // role mapping of the service-account clients and hold no credential, attribute or personal data
  realm.users = realm.users.filter((u) => u.serviceAccountClientId);
  for (const c of realm.clients) if (c.serviceAccountsEnabled) delete c.secret; // Keycloak generates the production secret
  delete realm.smtpServer; // the dev one is Mailpit; production provisions its own (SMTP_NOTICE)
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

/** Printed by the CLI after a production build: the build removes the SMTP server, so the reset email works only once one is provisioned. */
export const SMTP_NOTICE =
  'production realm has NO smtpServer (the development one is Mailpit): provision the production SMTP server and the bananagig-security client secret (KEYCLOAK_SECURITY_CLIENT_SECRET) in the target realm before enabling password reset';
