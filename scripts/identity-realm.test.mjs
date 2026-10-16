import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRUTE_FORCE_RULE,
  buildProductionRealm,
  DISABLED_BUILT_IN_CLIENTS,
  REQUIRED_ACTIONS_DISABLED,
  REQUIRED_ACTIONS_ENABLED,
  lintRealm,
  REMEMBER_ME_SECONDS,
  SECURITY_CLIENT_ID,
  SECURITY_SERVICE_ACCOUNT_ROLES,
  SMTP_NOTICE,
} from './lib/realm.mjs';

const dev = () => JSON.parse(readFileSync('infra/keycloak/bananagig-realm.json', 'utf8'));
const client = (r, id) => r.clients.find((c) => c.clientId === id);
const humans = (r) => r.users.filter((u) => !u.serviceAccountClientId);
const prodLint = (r) => lintRealm(r, { production: true }).join('\n');
const ORIGINS = { webUrl: 'https://app.example.com', adminUrl: 'https://admin.example.com' };

describe('identity realm (infra/keycloak/bananagig-realm.json)', () => {
  it('complies with the identity policy', () => {
    expect(lintRealm(dev())).toEqual([]);
  });
  it('defines the product clients, the security service client, one flagged dev-only test client, and a disabled built-in admin-cli', () => {
    const ids = dev()
      .clients.map((c) => c.clientId)
      .sort();
    expect(ids).toEqual([
      'account',
      'account-console',
      'admin-cli',
      'bananagig-admin',
      'bananagig-api',
      'bananagig-dev-test',
      'bananagig-security',
      'bananagig-web',
    ]);
    expect(client(dev(), 'admin-cli')).toMatchObject({ enabled: false, directAccessGrantsEnabled: false });
  });
  it('uses Authorization Code + PKCE S256, no implicit flow, no password grant, no secret on the browser clients', () => {
    for (const id of ['bananagig-web', 'bananagig-admin']) {
      const c = client(dev(), id);
      expect(c).toMatchObject({
        publicClient: true,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
      });
      expect(c.attributes['pkce.code.challenge.method']).toBe('S256');
      expect(c.secret).toBeUndefined();
    }
  });
  it('separates the admin client: own redirect URIs, own browser flow, shorter tokens, client role instead of realm roles', () => {
    const r = dev();
    const web = client(r, 'bananagig-web');
    const admin = client(r, 'bananagig-admin');
    expect(admin.redirectUris).not.toEqual(expect.arrayContaining(web.redirectUris));
    expect(admin.authenticationFlowBindingOverrides.browser).toBeTruthy();
    expect(Number(admin.attributes['access.token.lifespan'])).toBeLessThan(Number(web.attributes['access.token.lifespan']));
    expect(r.roles.client['bananagig-admin'].map((x) => x.name).sort()).toEqual([
      'admin-console-access',
      'configuration-approve',
      'configuration-read',
      'configuration-write',
      'content-approve',
      'content-legal',
      'content-read',
      'content-write',
      'geography-read',
      'geography-write',
    ]);
    expect(r.roles.realm.map((x) => x.name).sort()).toEqual(['customer', 'provider']);
  });
  it('defines the content-* roles as client roles of bananagig-admin only (never realm roles, never on another client)', () => {
    const r = dev();
    const names = ['content-read', 'content-write', 'content-approve', 'content-legal'];
    const adminRoles = r.roles.client['bananagig-admin'].map((x) => x.name);
    for (const n of names) {
      expect(adminRoles).toContain(n);
      expect(r.roles.realm.map((x) => x.name)).not.toContain(n);
    }
    expect(Object.keys(r.roles.client)).toEqual(['bananagig-admin']);
    for (const [clientId, roles] of Object.entries(r.roles.client))
      if (clientId !== 'bananagig-admin') expect(roles.map((x) => x.name).filter((n) => n.startsWith('content-'))).toEqual([]);
    // the admin client's tokens carry them (scope mapping), and the web/dev-test clients are never mapped to them
    expect(r.clientScopeMappings['bananagig-admin'][0].roles).toEqual(expect.arrayContaining(names));
    expect(JSON.stringify(r.scopeMappings)).not.toMatch(/content-/);
    // both dev administrators hold them, so a requester and a different approver exist; the customer and provider hold none
    for (const u of humans(r)) {
      const held = u.clientRoles?.['bananagig-admin'] ?? [];
      if (/^admin2?\.dev$/.test(u.username)) expect(held).toEqual(expect.arrayContaining(names));
      else expect(held.filter((n) => n.startsWith('content-'))).toEqual([]);
    }
    expect(
      humans(r)
        .map((u) => u.username)
        .sort(),
    ).toEqual(['admin.dev', 'admin2.dev', 'customer.dev', 'provider.dev']);
  });
  it('is MFA-capable: TOTP policy, admin flow with OTP step, ACR/LoA map for step-up', () => {
    const r = dev();
    expect(r).toMatchObject({ otpPolicyType: 'totp', otpPolicyDigits: 6, otpPolicyPeriod: 30 });
    expect(JSON.parse(r.attributes['acr.loa.map'])).toMatchObject({ 'bananagig:mfa': 2 });
    const otp = r.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-otp');
    expect(otp.authenticationExecutions.map((e) => e.authenticator)).toEqual(['conditional-user-configured', 'auth-otp-form']);
  });
  it('minimizes token claims: no profile/email/phone scopes, only sub/roles/acr/audience mappers', () => {
    const r = dev();
    expect(r.clientScopes.map((s) => s.name).sort()).toEqual(['acr', 'bananagig-api-audience', 'basic', 'roles']);
    for (const c of r.clients) expect(c.defaultClientScopes.some((s) => /profile|email|phone|address/.test(s))).toBe(false);
  });
  it('only dev users and the service-account user exist; every person is flagged dev-only with an obviously dev-only password', () => {
    expect(
      dev()
        .users.filter((u) => u.serviceAccountClientId)
        .map((u) => u.username),
    ).toEqual(['service-account-bananagig-security']);
    for (const u of humans(dev())) {
      expect(u.attributes['bananagig.devOnly']).toEqual(['true']);
      expect(u.credentials[0].value).toMatch(/^dev_only_/);
    }
  });
});

describe('policy linter catches regressions', () => {
  const mutate = (fn) => {
    const r = dev();
    fn(r);
    return lintRealm(r).join('\n');
  };
  it('implicit flow', () => expect(mutate((r) => (client(r, 'bananagig-web').implicitFlowEnabled = true))).toContain('implicit flow must be disabled'));
  it('password grant on a production client', () =>
    expect(mutate((r) => (client(r, 'bananagig-web').directAccessGrantsEnabled = true))).toContain('password (direct) grant is only allowed'));
  it('missing PKCE', () =>
    expect(mutate((r) => delete client(r, 'bananagig-web').attributes['pkce.code.challenge.method'])).toContain('PKCE method must be S256'));
  it('plain PKCE', () =>
    expect(mutate((r) => (client(r, 'bananagig-web').attributes['pkce.code.challenge.method'] = 'plain'))).toContain('PKCE method must be S256'));
  it('wildcard redirect URI', () => expect(mutate((r) => client(r, 'bananagig-web').redirectUris.push('http://app.localhost:8080/*'))).toContain('wildcard'));
  it('confidential browser client', () => expect(mutate((r) => (client(r, 'bananagig-web').publicClient = false))).toContain('must be public'));
  it('shared admin/web redirect', () =>
    expect(mutate((r) => client(r, 'bananagig-admin').redirectUris.push(client(r, 'bananagig-web').redirectUris[0]))).toContain(
      'must not share redirect URIs',
    ));
  it('admin client without its own flow', () =>
    expect(mutate((r) => delete client(r, 'bananagig-admin').authenticationFlowBindingOverrides)).toContain('must bind its own browser authentication flow'));
  it('open registration', () => expect(mutate((r) => (r.registrationAllowed = true))).toContain('registration must be disabled'));
  it('admin role leaking into realm roles', () => expect(mutate((r) => r.roles.realm.push({ name: 'admin' }))).toContain('realm roles must be exactly'));
  it('profile scope as default', () => expect(mutate((r) => client(r, 'bananagig-web').defaultClientScopes.push('profile'))).toContain('personal data'));
});

describe('production realm build', () => {
  it('removes dev-only clients and users, swaps in real origins, requires https and unconditional admin OTP', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    expect(prod.clients.map((c) => c.clientId).sort()).toEqual([
      'account',
      'account-console',
      'admin-cli',
      'bananagig-admin',
      'bananagig-api',
      'bananagig-security',
      'bananagig-web',
    ]);
    expect(humans(prod)).toEqual([]);
    expect(prod.clients.some((c) => c.directAccessGrantsEnabled)).toBe(false); // no password grant anywhere in production
    expect(JSON.stringify(prod)).not.toMatch(/localhost|devOnly|dev_only/);
    expect(client(prod, 'bananagig-web').redirectUris).toEqual(['https://app.example.com/auth/callback', 'https://app.example.com/session']);
    expect(client(prod, 'bananagig-admin').redirectUris).toEqual(['https://admin.example.com/auth/callback']);
    expect(prod.sslRequired).toBe('all');
    const forms = prod.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-forms');
    expect(forms.authenticationExecutions.find((e) => e.flowAlias === 'bananagig-admin-browser-otp').requirement).toBe('REQUIRED');
    const otp = prod.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-otp');
    expect(otp.authenticationExecutions.map((e) => e.authenticator)).toEqual(['auth-otp-form']);
    expect(lintRealm(prod, { production: true })).toEqual([]);
  });
  it('defines the geography-* roles as client roles of bananagig-admin only (never realm roles) and keeps them out of production users', () => {
    const r = dev();
    const adminRoles = r.roles.client['bananagig-admin'].map((x) => x.name);
    for (const n of ['geography-read', 'geography-write']) {
      expect(adminRoles).toContain(n);
      expect(r.roles.realm.map((x) => x.name)).not.toContain(n);
    }
    const prod = buildProductionRealm(r, ORIGINS);
    expect(prod.roles.client['bananagig-admin'].map((x) => x.name)).toEqual(expect.arrayContaining(['geography-read', 'geography-write']));
    expect(humans(prod)).toEqual([]);
  });
  it('keeps the content-* role definitions in production but creates no users to hold them', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    const adminRoles = prod.roles.client['bananagig-admin'].map((x) => x.name);
    for (const n of ['content-read', 'content-write', 'content-approve', 'content-legal']) expect(adminRoles).toContain(n);
    expect(prod.roles.realm.map((x) => x.name).sort()).toEqual(['customer', 'provider']);
    expect(humans(prod)).toEqual([]);
  });
  it('refuses to build without https origins', () => {
    expect(() => buildProductionRealm(dev(), {})).toThrow(/requires/);
    expect(() => buildProductionRealm(dev(), { webUrl: 'http://app.example.com', adminUrl: 'https://admin.example.com' })).toThrow(/https/);
  });
  it('does not mutate the development realm', () => {
    const r = dev();
    const before = JSON.stringify(r);
    buildProductionRealm(r, ORIGINS);
    expect(JSON.stringify(r)).toBe(before);
  });
});

const migration0012 = () => readFileSync('db/migrations/0012_application_sessions.sql', 'utf8');
const configSource = () => readFileSync('packages/config/src/index.ts', 'utf8');
const securityClient = (r) => client(r, SECURITY_CLIENT_ID);
const saUser = (r) => r.users.find((u) => u.serviceAccountClientId === SECURITY_CLIENT_ID);
const webFlow = (r) => r.authenticationFlows.find((f) => f.id === client(r, 'bananagig-web').authenticationFlowBindingOverrides.browser);

describe('ID-004 realm configuration (sessions, MFA, recovery)', () => {
  it('binds the web-only browser flow family: cookie, password, then a conditional OTP or recovery-code step; admin binding untouched', () => {
    const r = dev();
    const web = client(r, 'bananagig-web');
    const flow = webFlow(r);
    expect(flow).toMatchObject({ alias: 'bananagig-browser', topLevel: true, builtIn: false });
    expect(web.authenticationFlowBindingOverrides.browser).not.toBe(client(r, 'bananagig-admin').authenticationFlowBindingOverrides.browser);
    expect(r.clients.filter((c) => c.authenticationFlowBindingOverrides?.browser === flow.id).map((c) => c.clientId)).toEqual(['bananagig-web']);
    const mfa = r.authenticationFlows.find((f) => f.alias === 'bananagig-browser-mfa');
    expect(mfa.authenticationExecutions.map((e) => [e.authenticator, e.requirement])).toEqual([
      ['conditional-level-of-authentication', 'REQUIRED'],
      ['conditional-user-configured', 'REQUIRED'],
      ['auth-otp-form', 'ALTERNATIVE'],
      ['auth-recovery-authn-code-form', 'ALTERNATIVE'],
    ]);
    expect(r.authenticatorConfig).toEqual([{ alias: 'bananagig-web-loa2', config: { 'loa-condition-level': '2', 'loa-max-age': '2592000' } }]);
    expect(web.attributes['minimum.acr.value']).toBe('bananagig:mfa');
    expect(r.resetPasswordAllowed).toBe(false);
  });
  it('registers the password-reset return and the revoked-session post-logout URIs exactly (query string included)', () => {
    const web = client(dev(), 'bananagig-web');
    expect(web.redirectUris).toEqual(['http://app.localhost:8080/auth/callback', 'http://app.localhost:8080/session']);
    expect(web.attributes['post.logout.redirect.uris'].split('##')).toEqual([
      'http://app.localhost:8080/',
      'http://app.localhost:8080/session?error=session_revoked',
    ]);
  });
  it('configures brute force, remember-me, refresh rotation and the development SMTP server as required', () => {
    const r = dev();
    expect(r).toMatchObject({ ...BRUTE_FORCE_RULE, bruteForceProtected: true, rememberMe: true, revokeRefreshToken: true, refreshTokenMaxReuse: 1 });
    expect(BRUTE_FORCE_RULE).toEqual({
      permanentLockout: false,
      failureFactor: 5,
      maxDeltaTimeSeconds: 900,
      waitIncrementSeconds: 900,
      maxFailureWaitSeconds: 900,
    });
    expect(r.ssoSessionIdleTimeoutRememberMe).toBe(2592000);
    expect(r.ssoSessionMaxLifespanRememberMe).toBe(2592000);
    expect(r.smtpServer).toMatchObject({ host: 'mailpit-email', port: '1025', from: 'no-reply@bananagig.localhost' });
  });
  it('remember-me lifetimes equal the session.keep_signed_in_days default of migration 0012 (30 days)', () => {
    const row = /\(\d+, 'session\.keep_signed_in_days'[^\n]*ARRAY\['PLATFORM'\], '(\d+)'::jsonb/.exec(migration0012());
    expect(row, 'seed row of session.keep_signed_in_days not found in migration 0012').toBeTruthy();
    const days = Number(row[1]);
    expect(days).toBe(30);
    expect(dev().ssoSessionIdleTimeoutRememberMe).toBe(days * 86400);
    expect(dev().ssoSessionMaxLifespanRememberMe).toBe(days * 86400);
    expect(REMEMBER_ME_SECONDS).toBe(days * 86400);
    // the flow's LoA max-age keeps the MFA level for as long as the remembered session lives
    expect(Number(dev().authenticatorConfig[0].config['loa-max-age'])).toBe(days * 86400);
  });
  it('the dev client secret of bananagig-security equals the KEYCLOAK_SECURITY_CLIENT_SECRET development default of packages/config', () => {
    const m = /DEV_DEFAULTS[\s\S]*?KEYCLOAK_SECURITY_CLIENT_SECRET: '([^']+)'/.exec(configSource());
    expect(m, 'development default not found in packages/config').toBeTruthy();
    expect(securityClient(dev()).secret).toBe(m[1]);
    expect(m[1]).toBe('bananagig_security_dev_only_secret_0001');
    expect(m[1]).toMatch(/dev_only/);
  });
  it('bananagig-security is confidential, client credentials only, and its service account holds exactly manage-users', () => {
    const r = dev();
    expect(securityClient(r)).toMatchObject({
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      fullScopeAllowed: false,
      redirectUris: [],
      defaultClientScopes: ['roles'],
    });
    expect(SECURITY_SERVICE_ACCOUNT_ROLES).toEqual(['manage-users']);
    expect(saUser(r)).toMatchObject({ username: 'service-account-bananagig-security', clientRoles: { 'realm-management': ['manage-users'] } });
    expect(r.clientScopeMappings['realm-management']).toEqual([{ client: 'bananagig-security', roles: ['manage-users'] }]);
    expect(r.clients.filter((c) => c.serviceAccountsEnabled).map((c) => c.clientId)).toEqual(['bananagig-security']);
  });
});

describe('built-in account surface (Keycloak account console, kc_action)', () => {
  const action = (r, alias) => r.requiredActions.find((a) => a.alias === alias);
  const mutate = (fn, opts) => {
    const r = dev();
    fn(r);
    return lintRealm(r, opts).join('\n');
  };
  it('declares account and account-console disabled, with no flow and no redirect', () => {
    expect(DISABLED_BUILT_IN_CLIENTS).toEqual(['account', 'account-console']);
    for (const id of DISABLED_BUILT_IN_CLIENTS)
      expect(client(dev(), id)).toMatchObject({
        enabled: false,
        standardFlowEnabled: false,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        fullScopeAllowed: false,
        redirectUris: [],
      });
  });
  it('declares the required actions explicitly: the product ones enabled; credential removal, WebAuthn and IdP linking disabled', () => {
    const r = dev();
    for (const a of REQUIRED_ACTIONS_ENABLED) expect(action(r, a).enabled, a).toBe(true);
    for (const a of REQUIRED_ACTIONS_DISABLED) expect(action(r, a).enabled, a).toBe(false);
    expect(REQUIRED_ACTIONS_DISABLED).toEqual(['delete_credential', 'webauthn-register', 'webauthn-register-passwordless', 'idp_link']);
    for (const a of ['UPDATE_PROFILE', 'VERIFY_EMAIL', 'VERIFY_PROFILE']) expect(action(r, a).enabled, a).toBe(true);
    expect(r.requiredActions.map((a) => a.alias)).toEqual(expect.arrayContaining(['UPDATE_PROFILE', 'VERIFY_EMAIL', 'VERIFY_PROFILE', 'update_user_locale']));
    for (const a of r.requiredActions) expect(a).toMatchObject({ defaultAction: false, config: {} });
  });
  it('resetPasswordAllowed stays false: the self-service reset-credentials flow is refused by Keycloak', () => expect(dev().resetPasswordAllowed).toBe(false));
  for (const id of ['account', 'account-console']) {
    it(`${id} enabled`, () => expect(mutate((r) => (client(r, id).enabled = true))).toContain(`client ${id}: must be disabled`));
    it(`${id} undeclared`, () =>
      expect(
        mutate((r) => {
          r.clients = r.clients.filter((c) => c.clientId !== id);
        }),
      ).toContain(`${id} must be declared with enabled=false`));
  }
  for (const alias of REQUIRED_ACTIONS_DISABLED) {
    it(`${alias} enabled`, () => {
      const out = mutate((r) => (action(r, alias).enabled = true));
      expect(out).toContain(`required action ${alias} must be disabled`);
      expect(out).toContain('re-enabled when the feature that uses it is built');
    });
    it(`${alias} not declared`, () =>
      expect(
        mutate((r) => {
          r.requiredActions = r.requiredActions.filter((a) => a.alias !== alias);
        }),
      ).toContain(`${alias} must be declared and disabled`));
  }
  it('requiredActions not declared at all', () => expect(mutate((r) => delete r.requiredActions)).toContain('requiredActions must be declared'));
  for (const alias of REQUIRED_ACTIONS_ENABLED) {
    it(`${alias} disabled`, () => expect(mutate((r) => (action(r, alias).enabled = false))).toContain(`required action ${alias} must be declared and enabled`));
    it(`${alias} dropped (a partial list replaces the defaults)`, () =>
      expect(
        mutate((r) => {
          r.requiredActions = r.requiredActions.filter((a) => a.alias !== alias);
        }),
      ).toContain(`required action ${alias} must be declared and enabled`));
  }
  it('the production build keeps the closure and lints clean', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    for (const id of DISABLED_BUILT_IN_CLIENTS) expect(client(prod, id).enabled).toBe(false);
    expect(prod.requiredActions.find((a) => a.alias === 'delete_credential').enabled).toBe(false);
    expect(lintRealm(prod, { production: true })).toEqual([]);
    const r = buildProductionRealm(dev(), ORIGINS);
    client(r, 'account-console').enabled = true;
    expect(lintRealm(r, { production: true }).join('\n')).toContain('account-console: must be disabled');
  });
});

describe('Caddy: the public auth host does not expose the account console or the self-service reset flow', () => {
  const caddyfile = readFileSync('infra/caddy/Caddyfile', 'utf8');
  const authBlock = () => caddyfile.slice(caddyfile.indexOf('@auth host auth.localhost'), caddyfile.indexOf('@kcadmin host'));
  it('denies /realms/bananagig/account* and /realms/bananagig/login-actions/reset-credentials* with 404 BEFORE the wholesale realm proxy', () => {
    const block = authBlock();
    const deny = block.indexOf('@blocked');
    const allow = block.indexOf('@realm path');
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    const matcher = /@blocked path ([^\n]+)/.exec(block)[1].split(/\s+/);
    expect(matcher.sort()).toEqual(
      [
        '/realms/bananagig/account',
        '/realms/bananagig/account/*',
        '/realms/bananagig/login-actions/reset-credentials',
        '/realms/bananagig/login-actions/reset-credentials/*',
      ].sort(),
    );
    expect(/handle @blocked \{\s*respond "Not found" 404\s*\}/.test(block)).toBe(true);
    expect(block.indexOf('handle @blocked')).toBeLessThan(block.indexOf('handle @realm'));
  });
  it('still proxies only the realm endpoints and static resources, everything else is 404', () => {
    const block = authBlock();
    expect(/@realm path \/realms\/bananagig \/realms\/bananagig\/\* \/resources\/\*/.test(block)).toBe(true);
    expect(/handle \{\s*respond "Not found" 404\s*\}/.test(block)).toBe(true);
  });
});

describe('policy linter: ID-004 rules (negative cases)', () => {
  const mutate = (fn, opts) => {
    const r = dev();
    fn(r);
    return lintRealm(r, opts).join('\n');
  };
  describe('service accounts', () => {
    it('another client enabling service accounts', () =>
      expect(mutate((r) => (client(r, 'bananagig-web').serviceAccountsEnabled = true))).toContain('service accounts are only allowed on bananagig-security'));
    it('the api client enabling them', () =>
      expect(mutate((r) => (client(r, 'bananagig-api').serviceAccountsEnabled = true))).toContain('resource server only'));
    it('a service-account user of another client', () =>
      expect(mutate((r) => r.users.push({ username: 'service-account-x', serviceAccountClientId: 'bananagig-web' }))).toContain(
        'only bananagig-security may have one',
      ));
    it('missing client', () =>
      expect(
        mutate((r) => {
          r.clients = r.clients.filter((c) => c.clientId !== SECURITY_CLIENT_ID);
        }),
      ).toContain('bananagig-security is missing'));
    it('public client', () => expect(mutate((r) => (securityClient(r).publicClient = true))).toContain('must be confidential'));
    it('service accounts switched off', () =>
      expect(mutate((r) => (securityClient(r).serviceAccountsEnabled = false))).toContain('service accounts must be enabled'));
    for (const flag of ['standardFlowEnabled', 'directAccessGrantsEnabled', 'implicitFlowEnabled'])
      it(`${flag} on`, () => {
        const out = mutate((r) => {
          securityClient(r)[flag] = true;
          if (flag === 'standardFlowEnabled') securityClient(r).redirectUris = ['http://app.localhost:8080/x'];
        });
        expect(out).toContain('client credentials only');
      });
    it('fullScopeAllowed', () => expect(mutate((r) => (securityClient(r).fullScopeAllowed = true))).toContain('fullScopeAllowed must be false'));
    it('redirect URIs', () =>
      expect(mutate((r) => (securityClient(r).redirectUris = ['http://app.localhost:8080/x']))).toContain('no redirect URIs or web origins'));
    it('a browser flow binding', () =>
      expect(mutate((r) => (securityClient(r).authenticationFlowBindingOverrides = { browser: webFlow(r).id }))).toContain('must not bind a browser flow'));
    it('dev-only flag (the production build would delete the client)', () =>
      expect(mutate((r) => (securityClient(r).attributes['bananagig.devOnly'] = 'true'))).toContain('must not be flagged dev-only'));
    it('a secret that is not a dev_only value', () =>
      expect(mutate((r) => (securityClient(r).secret = 'a_real_looking_secret_value_0123456789'))).toContain('dev_only value')); // secret-scan:allow (a made-up fixture value, not a credential)
    it('no secret in the development realm', () => expect(mutate((r) => delete securityClient(r).secret)).toContain('dev_only value'));
    it('an extra realm-management role', () =>
      expect(mutate((r) => saUser(r).clientRoles['realm-management'].push('realm-admin'))).toContain('realm-management roles must be exactly manage-users'));
    it('no role at all', () =>
      expect(mutate((r) => (saUser(r).clientRoles = {}))).toContain('realm-management roles must be exactly manage-users (found none)'));
    it('a role of another client', () =>
      expect(mutate((r) => (saUser(r).clientRoles['bananagig-admin'] = ['configuration-approve']))).toContain('no roles of other clients'));
    it('a realm role', () => expect(mutate((r) => (saUser(r).realmRoles = ['customer']))).toContain('no realm roles'));
    it('a group', () => expect(mutate((r) => (saUser(r).groups = ['/ops']))).toContain('in no group'));
    it('a credential', () => expect(mutate((r) => (saUser(r).credentials = [{ type: 'password', value: 'x' }]))).toContain('no credentials'));
    it('a widened scope mapping', () =>
      expect(mutate((r) => r.clientScopeMappings['realm-management'][0].roles.push('view-users'))).toContain('scope mapping must be exactly manage-users'));
    it('a realm-role scope mapping', () =>
      expect(mutate((r) => r.scopeMappings.push({ client: SECURITY_CLIENT_ID, roles: ['customer'] }))).toContain('must not be mapped to realm roles'));
    it('a scope mapping to another client roles', () =>
      expect(mutate((r) => r.clientScopeMappings['bananagig-admin'].push({ client: SECURITY_CLIENT_ID, roles: ['configuration-approve'] }))).toContain(
        'must not be scope-mapped to roles of bananagig-admin',
      ));
    it('no service-account user', () =>
      expect(
        mutate((r) => {
          r.users = r.users.filter((u) => !u.serviceAccountClientId);
        }),
      ).toContain('exactly one service-account user'));
    it('a personal-data default scope on the security client', () =>
      expect(mutate((r) => securityClient(r).defaultClientScopes.push('email'))).toContain('personal data'));
  });
  describe('web client flow and floor', () => {
    it('no bound flow', () =>
      expect(mutate((r) => delete client(r, 'bananagig-web').authenticationFlowBindingOverrides)).toContain('must bind its own browser authentication flow'));
    it('bound flow does not exist', () =>
      expect(mutate((r) => (client(r, 'bananagig-web').authenticationFlowBindingOverrides.browser = 'b4a9c3e2-0000-4000-8000-0000000000ff'))).toContain(
        'does not exist',
      ));
    it('bound flow is the admin flow', () =>
      expect(
        mutate(
          (r) =>
            (client(r, 'bananagig-web').authenticationFlowBindingOverrides.browser = client(r, 'bananagig-admin').authenticationFlowBindingOverrides.browser),
        ),
      ).toContain('must not be bound to the admin authentication flow'));
    it('bound flow is not top level', () => expect(mutate((r) => (webFlow(r).topLevel = false))).toContain('must be a top-level flow'));
    it('another client uses the web flow', () =>
      expect(mutate((r) => (client(r, 'bananagig-api').authenticationFlowBindingOverrides = { browser: webFlow(r).id }))).toContain(
        'must not use the web browser flow',
      ));
    it('minimum.acr.value missing', () =>
      expect(mutate((r) => delete client(r, 'bananagig-web').attributes['minimum.acr.value'])).toContain('minimum.acr.value must be bananagig:mfa'));
    it('minimum.acr.value lowered', () =>
      expect(mutate((r) => (client(r, 'bananagig-web').attributes['minimum.acr.value'] = 'bananagig:password'))).toContain(
        'minimum.acr.value must be bananagig:mfa',
      ));
    it('the LoA condition removed from the flow', () =>
      expect(
        mutate((r) => {
          const f = r.authenticationFlows.find((x) => x.alias === 'bananagig-browser-mfa');
          f.authenticationExecutions = f.authenticationExecutions.filter((e) => e.authenticator !== 'conditional-level-of-authentication');
        }),
      ).toContain('Level of Authentication condition'));
    it('the LoA level drifting from the acr map', () =>
      expect(mutate((r) => (r.authenticatorConfig[0].config['loa-condition-level'] = '1'))).toContain('must equal acr.loa.map'));
    it('the OTP form removed', () =>
      expect(
        mutate((r) => {
          const f = r.authenticationFlows.find((x) => x.alias === 'bananagig-browser-mfa');
          f.authenticationExecutions = f.authenticationExecutions.filter((e) => e.authenticator !== 'auth-otp-form');
        }),
      ).toContain('must offer the OTP form'));
    it('forced enrolment (conditional-user-configured removed)', () =>
      expect(
        mutate((r) => {
          const f = r.authenticationFlows.find((x) => x.alias === 'bananagig-browser-mfa');
          f.authenticationExecutions = f.authenticationExecutions.filter((e) => e.authenticator !== 'conditional-user-configured');
        }),
      ).toContain('conditional on the user having one'));
  });
  describe('realm settings', () => {
    for (const [k, wrong] of [
      ['failureFactor', 10],
      ['maxDeltaTimeSeconds', 43200],
      ['waitIncrementSeconds', 60],
      ['maxFailureWaitSeconds', 1800],
      ['permanentLockout', true],
    ])
      it(`brute force ${k}=${wrong}`, () => expect(mutate((r) => (r[k] = wrong))).toContain(`${k} must be ${BRUTE_FORCE_RULE[k]}`));
    it('remember-me disabled', () => expect(mutate((r) => (r.rememberMe = false))).toContain('rememberMe must be enabled'));
    for (const k of ['ssoSessionIdleTimeoutRememberMe', 'ssoSessionMaxLifespanRememberMe'])
      it(`${k} different from 30 days`, () => expect(mutate((r) => (r[k] = 86400))).toContain(`${k} must be 2592000`));
    it('refresh-token rotation off', () => expect(mutate((r) => (r.revokeRefreshToken = false))).toContain('revokeRefreshToken must be true'));
    it('refresh-token reuse 0', () => expect(mutate((r) => (r.refreshTokenMaxReuse = 0))).toContain('refreshTokenMaxReuse must be 1'));
    it('realm-started password reset', () => expect(mutate((r) => (r.resetPasswordAllowed = true))).toContain('resetPasswordAllowed must be false'));
    it('missing SMTP server in the development realm', () => expect(mutate((r) => delete r.smtpServer)).toContain('smtpServer.host is required'));
    it('SMTP server without a host', () => expect(mutate((r) => (r.smtpServer.host = ''))).toContain('smtpServer.host is required'));
  });
  describe('production lint', () => {
    const prodRealm = () => buildProductionRealm(dev(), ORIGINS);
    it('refuses the dev secret', () => {
      const r = prodRealm();
      securityClient(r).secret = 'bananagig_security_dev_only_secret_0001';
      expect(prodLint(r)).toContain('no secret');
    });
    it('refuses the dev SMTP server', () => {
      const r = prodRealm();
      r.smtpServer = { host: 'mailpit-email', port: '1025' };
      expect(prodLint(r)).toContain('development SMTP server must not exist');
    });
    it('accepts a real SMTP server provisioned in the file', () => {
      const r = prodRealm();
      r.smtpServer = { host: 'smtp.mail.example.com', port: '587' };
      expect(prodLint(r)).toBe('');
    });
    it('refuses a person user in production', () => {
      const r = prodRealm();
      r.users.push({ username: 'someone' });
      expect(prodLint(r)).toContain('only service-account users may exist');
    });
    it('the security rules still apply in production (extra role)', () => {
      const r = prodRealm();
      saUser(r).clientRoles['realm-management'].push('manage-realm');
      expect(prodLint(r)).toContain('realm-management roles must be exactly manage-users');
    });
  });
});

describe('production realm build: ID-004 behaviour', () => {
  it('keeps the service-account user (and only it) with its manage-users mapping, and the scope mapping', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    expect(prod.users).toEqual([saUser(dev())]);
    expect(prod.users[0].clientRoles).toEqual({ 'realm-management': ['manage-users'] });
    expect(prod.clientScopeMappings['realm-management']).toEqual([{ client: 'bananagig-security', roles: ['manage-users'] }]);
    expect(lintRealm(prod, { production: true })).toEqual([]);
  });
  it('strips the dev client secret of bananagig-security (Keycloak generates one) and keeps the client otherwise', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    const c = securityClient(prod);
    expect(c).toBeTruthy();
    expect(c.secret).toBeUndefined();
    expect(c).toMatchObject({
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
    });
    expect(JSON.stringify(prod)).not.toContain('bananagig_security_dev_only_secret');
  });
  it('removes the dev SMTP server and says so', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    expect('smtpServer' in prod).toBe(false);
    expect(SMTP_NOTICE).toMatch(/provision the production SMTP server/);
    expect(JSON.stringify(prod)).not.toMatch(/mailpit|localhost/);
  });
  it('keeps the web flow, the MFA floor, the settings and swaps the new redirect URIs for the real origins', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    const web = client(prod, 'bananagig-web');
    expect(webFlow(prod).alias).toBe('bananagig-browser');
    expect(web.attributes['minimum.acr.value']).toBe('bananagig:mfa');
    expect(web.attributes['post.logout.redirect.uris']).toBe('https://app.example.com/##https://app.example.com/session?error=session_revoked');
    expect(prod).toMatchObject({ ...BRUTE_FORCE_RULE, rememberMe: true, revokeRefreshToken: true, refreshTokenMaxReuse: 1, resetPasswordAllowed: false });
    expect(prod.ssoSessionIdleTimeoutRememberMe).toBe(2592000);
  });
  it('does not touch the customer/provider flow when it makes the admin OTP unconditional', () => {
    const prod = buildProductionRealm(dev(), ORIGINS);
    const mfa = prod.authenticationFlows.find((f) => f.alias === 'bananagig-browser-mfa');
    expect(mfa.authenticationExecutions.map((e) => e.authenticator)).toContain('conditional-user-configured');
  });
  it('drops service-account users of dev-only clients but never a person', () => {
    const r = dev();
    r.users.push({ username: 'someone', serviceAccountClientId: undefined });
    expect(buildProductionRealm(r, ORIGINS).users.map((u) => u.username)).toEqual(['service-account-bananagig-security']);
  });
});
