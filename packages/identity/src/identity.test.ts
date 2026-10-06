import { beforeAll, describe, expect, it } from 'vitest';
import {
  bearerFromHeader,
  buildAuthorizeUrl,
  buildLogoutUrl,
  codeChallengeS256,
  createTokenVerifier,
  generateCodeVerifier,
  oidcEndpoints,
  safeReturnTo,
  TokenValidationError,
} from './index';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from './testing';

let keys: TestKeys;
let other: TestKeys;
beforeAll(async () => {
  keys = await createTestKeys('k1');
  other = await createTestKeys('k1'); // same kid, different key material: signature must fail
});
const verifier = () =>
  createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: keys.getKey, webClientId: 'bananagig-web', adminClientId: 'bananagig-admin' });
const category = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as TokenValidationError | undefined
  )?.category;

describe('access token verification', () => {
  it('accepts a valid token and extracts a minimal principal', async () => {
    const p = await verifier().verifyAccessToken(
      await signToken(keys, {
        claims: { realm_access: { roles: ['customer', 'provider'] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } } },
      }),
    );
    expect(p).toMatchObject({
      subject: 'test-subject-1',
      clientId: 'bananagig-web',
      authContext: 'web',
      realmRoles: ['customer', 'provider'],
      audience: ['bananagig-api'],
    });
    expect(p.clientRoles['bananagig-admin']).toEqual(['admin-console-access']);
  });
  it('distinguishes the admin client context', async () => {
    expect((await verifier().verifyAccessToken(await signToken(keys, { claims: { azp: 'bananagig-admin' } }))).authContext).toBe('admin');
    expect((await verifier().verifyAccessToken(await signToken(keys, { claims: { azp: 'something-else' } }))).authContext).toBe('other');
  });
  it('rejects an unsigned (alg none) token', async () => {
    expect(await category(verifier().verifyAccessToken(unsignedToken()))).toBe('unsupported_algorithm');
  });
  it('rejects an HMAC token (algorithm confusion)', async () => {
    expect(await category(verifier().verifyAccessToken(await hmacToken()))).toBe('unsupported_algorithm');
  });
  it('rejects a token signed by a different key', async () => {
    expect(await category(verifier().verifyAccessToken(await signToken(other)))).toBe('signature');
  });
  it('rejects the wrong issuer', async () => {
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } })))).toBe(
      'issuer_mismatch',
    );
  });
  it('rejects the wrong audience, including a missing audience', async () => {
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { claims: { aud: 'some-other-api' } })))).toBe('audience_mismatch');
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { omit: ['aud'] })))).toBe('audience_mismatch');
  });
  it('rejects expired tokens and tokens that are not valid yet', async () => {
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { expiresInSec: -120 })))).toBe('expired');
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { notBeforeInSec: 3600 })))).toBe('not_yet_valid');
  });
  it('rejects ID tokens and refresh tokens presented as access tokens', async () => {
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { claims: { typ: 'ID' } })))).toBe('wrong_token_type');
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { claims: { typ: 'Refresh' } })))).toBe('wrong_token_type');
  });
  it('requires sub, exp, iat and azp', async () => {
    for (const claim of ['sub', 'exp', 'iat'])
      expect(await category(verifier().verifyAccessToken(await signToken(keys, { omit: [claim] })))).toBe('claims_invalid');
    expect(await category(verifier().verifyAccessToken(await signToken(keys, { omit: ['azp'] })))).toBe('claims_invalid');
  });
  it('rejects garbage', async () => {
    expect(await category(verifier().verifyAccessToken('not-a-jwt'))).toBe('malformed');
  });
  it('reports an unreachable JWKS as jwks_unavailable, not as a bad token', async () => {
    const v = createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: { url: 'http://127.0.0.1:1/certs', timeoutMs: 500 } });
    expect(await category(v.verifyAccessToken(await signToken(keys)))).toBe('jwks_unavailable');
  });
  it('refuses to be configured with symmetric or none algorithms', () => {
    expect(() => createTokenVerifier({ issuer: 'i', apiAudience: 'a', jwks: keys.getKey, algorithms: ['HS256'] })).toThrow();
    expect(() => createTokenVerifier({ issuer: 'i', apiAudience: 'a', jwks: keys.getKey, algorithms: ['none'] })).toThrow();
  });
});

describe('id token verification', () => {
  it('checks audience, type and nonce', async () => {
    const v = verifier();
    const idToken = await signToken(keys, { claims: { typ: 'ID', aud: 'bananagig-web', nonce: 'n-1' } });
    expect((await v.verifyIdToken(idToken, 'bananagig-web', 'n-1')).sub).toBe('test-subject-1');
    expect(await category(v.verifyIdToken(idToken, 'bananagig-web', 'other-nonce'))).toBe('claims_invalid');
    expect(await category(v.verifyIdToken(idToken, 'bananagig-admin', 'n-1'))).toBe('audience_mismatch');
    expect(await category(v.verifyIdToken(await signToken(keys, { claims: { aud: 'bananagig-web', nonce: 'n-1' } }), 'bananagig-web', 'n-1'))).toBe(
      'wrong_token_type',
    );
  });
});

describe('bearer header parsing', () => {
  it('accepts only a single well-formed Bearer token', () => {
    expect(bearerFromHeader('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerFromHeader('bearer abc.def.ghi')).toBe('abc.def.ghi');
    for (const bad of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer a\nb', 'Bearer a;b'])
      expect(bearerFromHeader(bad as string)).toBeUndefined();
  });
});

describe('PKCE and OIDC helpers', () => {
  it('computes S256 challenges per RFC 7636 appendix B', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('generates verifiers within the RFC length bounds', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(generateCodeVerifier()).not.toBe(v);
  });
  it('builds an authorization request that is code + S256 with state and nonce and no secret', () => {
    const e = oidcEndpoints({ publicUrl: 'http://auth.localhost:8080', internalUrl: 'http://keycloak-auth:8080', realm: 'bananagig' });
    const u = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: e.authorization,
        clientId: 'bananagig-web',
        redirectUri: 'http://app.localhost:8080/auth/callback',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
      }),
    );
    expect(u.origin + u.pathname).toBe('http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: 'c',
      state: 's',
      nonce: 'n',
      client_id: 'bananagig-web',
    });
    expect(u.searchParams.has('client_secret')).toBe(false);
    expect(e.token).toBe('http://keycloak-auth:8080/realms/bananagig/protocol/openid-connect/token'); // back-channel uses the internal URL
    expect(e.issuer).toBe('http://auth.localhost:8080/realms/bananagig');
  });
  it('builds a logout URL with the id token hint', () => {
    const u = new URL(
      buildLogoutUrl({
        endSessionEndpoint: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/logout',
        clientId: 'bananagig-web',
        idTokenHint: 'tok',
        postLogoutRedirectUri: 'http://app.localhost:8080/',
      }),
    );
    expect(u.searchParams.get('id_token_hint')).toBe('tok');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://app.localhost:8080/');
  });
  it('only allows same-site relative return paths', () => {
    expect(safeReturnTo('/session?x=1')).toBe('/session?x=1');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
      '/a\nb',
      'relative',
      '',
      undefined,
      null,
      `/${'a'.repeat(600)}`,
    ])
      expect(safeReturnTo(bad as string)).toBe('/');
    expect(safeReturnTo('//evil', '/home')).toBe('/home');
  });
});
