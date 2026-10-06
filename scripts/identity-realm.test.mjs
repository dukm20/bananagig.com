import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProductionRealm, lintRealm } from './lib/realm.mjs';

const dev = () => JSON.parse(readFileSync('infra/keycloak/bananagig-realm.json', 'utf8'));
const client = (r, id) => r.clients.find((c) => c.clientId === id);
const ORIGINS = { webUrl: 'https://app.example.com', adminUrl: 'https://admin.example.com' };

describe('identity realm (infra/keycloak/bananagig-realm.json)', () => {
  it('complies with the identity policy', () => {
    expect(lintRealm(dev())).toEqual([]);
  });
  it('defines the three product clients, one flagged dev-only test client, and a disabled built-in admin-cli', () => {
    const ids = dev()
      .clients.map((c) => c.clientId)
      .sort();
    expect(ids).toEqual(['admin-cli', 'bananagig-admin', 'bananagig-api', 'bananagig-dev-test', 'bananagig-web']);
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
    expect(r.roles.client['bananagig-admin'].map((x) => x.name)).toEqual(['admin-console-access']);
    expect(r.roles.realm.map((x) => x.name).sort()).toEqual(['customer', 'provider']);
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
  it('only dev users exist and all are flagged dev-only with obviously dev-only passwords', () => {
    for (const u of dev().users) {
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
    expect(prod.clients.map((c) => c.clientId).sort()).toEqual(['admin-cli', 'bananagig-admin', 'bananagig-api', 'bananagig-web']);
    expect(prod.users).toEqual([]);
    expect(prod.clients.some((c) => c.directAccessGrantsEnabled)).toBe(false); // no password grant anywhere in production
    expect(JSON.stringify(prod)).not.toMatch(/localhost|devOnly|dev_only/);
    expect(client(prod, 'bananagig-web').redirectUris).toEqual(['https://app.example.com/auth/callback']);
    expect(client(prod, 'bananagig-admin').redirectUris).toEqual(['https://admin.example.com/auth/callback']);
    expect(prod.sslRequired).toBe('all');
    const forms = prod.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-forms');
    expect(forms.authenticationExecutions.find((e) => e.flowAlias === 'bananagig-admin-browser-otp').requirement).toBe('REQUIRED');
    const otp = prod.authenticationFlows.find((f) => f.alias === 'bananagig-admin-browser-otp');
    expect(otp.authenticationExecutions.map((e) => e.authenticator)).toEqual(['auth-otp-form']);
    expect(lintRealm(prod, { production: true })).toEqual([]);
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
