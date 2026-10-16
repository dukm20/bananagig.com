import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHORIZE_ACR_VALUES,
  AuthorizeParamError,
  buildAuthorizeUrl,
  createTokenVerifier,
  KC_ACTION_STATUSES,
  kcActionStatusFromCallback,
  KEYCLOAK_ACTIONS,
  MAX_AGE_LIMIT_SECONDS,
  type AuthorizeParams,
} from './index';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from './testing';

const base: AuthorizeParams = {
  authorizationEndpoint: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/auth',
  clientId: 'bananagig-web',
  redirectUri: 'http://app.localhost:8080/auth/callback',
  state: 's',
  nonce: 'n',
  codeChallenge: 'c',
};
const params = (extra: Partial<AuthorizeParams> = {}): URLSearchParams => new URL(buildAuthorizeUrl({ ...base, ...extra })).searchParams;
const paramError = (extra: Partial<AuthorizeParams>): string | undefined => {
  try {
    buildAuthorizeUrl({ ...base, ...extra });
  } catch (e) {
    expect(e).toBeInstanceOf(AuthorizeParamError);
    return (e as AuthorizeParamError).param;
  }
  return undefined;
};

describe('buildAuthorizeUrl: step-up extras', () => {
  it('emits none of the extras unless they are given', () => {
    const p = params();
    for (const k of ['prompt', 'max_age', 'acr_values', 'kc_action']) expect(p.has(k)).toBe(false);
    expect(p.get('code_challenge_method')).toBe('S256');
  });
  it('emits each extra only when given', () => {
    expect(params({ prompt: 'login' }).get('prompt')).toBe('login');
    expect(params({ maxAge: 900 }).get('max_age')).toBe('900');
    expect(params({ acrValues: 'bananagig:mfa' }).get('acr_values')).toBe('bananagig:mfa');
    expect(params({ kcAction: 'CONFIGURE_TOTP' }).get('kc_action')).toBe('CONFIGURE_TOTP');
    const only = params({ maxAge: 900 });
    expect(only.has('prompt') || only.has('acr_values') || only.has('kc_action')).toBe(false);
  });
  it('emits all of them together next to the unchanged PKCE parameters', () => {
    const p = params({ prompt: 'login', maxAge: 0, acrValues: 'bananagig:mfa', kcAction: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    expect(Object.fromEntries(p)).toMatchObject({
      response_type: 'code',
      code_challenge_method: 'S256',
      prompt: 'login',
      max_age: '0',
      acr_values: 'bananagig:mfa',
      kc_action: 'CONFIGURE_RECOVERY_AUTHN_CODES',
      scope: 'openid',
    });
  });
  it('max_age 0 is emitted (it forces re-authentication) and is not treated as absent', () => {
    expect(params({ maxAge: 0 }).get('max_age')).toBe('0');
  });
  it.each(AUTHORIZE_ACR_VALUES)('accepts the acr %s', (acr) => {
    expect(params({ acrValues: acr }).get('acr_values')).toBe(acr);
  });
  it.each(KEYCLOAK_ACTIONS)('accepts the Keycloak action %s', (a) => {
    expect(params({ kcAction: a }).get('kc_action')).toBe(a);
  });
  it('accepts the integer bounds of max_age', () => {
    expect(params({ maxAge: MAX_AGE_LIMIT_SECONDS }).get('max_age')).toBe('86400');
    expect(MAX_AGE_LIMIT_SECONDS).toBe(86_400);
  });

  it.each(['none', 'consent', 'select_account', 'Login', 'login ', 'login consent', 'login none', '', 'login&x=1'])('refuses the prompt %j', (prompt) => {
    expect(paramError({ prompt: prompt as 'login' })).toBe('prompt');
  });
  it.each([-1, 86_401, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '900' as unknown as number, null as unknown as number])(
    'refuses max_age %j',
    (maxAge) => {
      expect(paramError({ maxAge })).toBe('max_age');
    },
  );
  it.each([
    'bananagig:unknown',
    'BANANAGIG:MFA',
    'bananagig:mfa bananagig:password',
    'bananagig:mfa,bananagig:password',
    ' bananagig:mfa',
    'urn:mace:incommon:iap:silver',
    '1',
    '',
    'bananagig:mfa&prompt=none',
  ])('refuses acr_values %j', (acrValues) => {
    expect(paramError({ acrValues })).toBe('acr_values');
  });
  it.each([
    'UPDATE_PASSWORD',
    'VERIFY_EMAIL',
    'delete_credential:abc',
    'configure_totp',
    'CONFIGURE_TOTP ',
    'CONFIGURE_TOTP&prompt=none',
    '',
    'TERMS_AND_CONDITIONS',
  ])('refuses the Keycloak action %j', (kcAction) => {
    expect(paramError({ kcAction })).toBe('kc_action');
  });
  it('names the parameter and never the rejected value in the error', () => {
    try {
      buildAuthorizeUrl({ ...base, kcAction: 'evil-value-123' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe('invalid authorize parameter: kc_action');
      expect((e as Error).message).not.toContain('evil-value-123');
    }
  });
  it('rejects before building anything, whatever the order of the bad value', () => {
    expect(paramError({ prompt: 'login', maxAge: 1, acrValues: 'bananagig:mfa', kcAction: 'nope' })).toBe('kc_action');
    expect(paramError({ maxAge: -5, kcAction: 'CONFIGURE_TOTP' })).toBe('max_age');
  });
  it('an undefined extra is the same as an absent one', () => {
    const p = params({ prompt: undefined, maxAge: undefined, acrValues: undefined, kcAction: undefined });
    for (const k of ['prompt', 'max_age', 'acr_values', 'kc_action']) expect(p.has(k)).toBe(false);
  });
  it('the whitelists equal the vocabularies of @bananagig/contracts (identity may not import it, so the source is compared)', () => {
    const src = readFileSync(new URL('../../contracts/src/security.ts', import.meta.url), 'utf8');
    const acr = [...src.matchAll(/export const ACR_(?:PASSWORD|MFA) = '([^']+)'/g)].map((m) => m[1]);
    expect([...acr].sort()).toEqual([...AUTHORIZE_ACR_VALUES].sort());
    const actions = src.match(/KEYCLOAK_ACTION_OF_METHOD[^=]*=\s*\{([^}]*)\}/)?.[1] ?? '';
    const values = [...actions.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect([...values].sort()).toEqual([...KEYCLOAK_ACTIONS].sort());
  });
});

describe('kcActionStatusFromCallback', () => {
  const cb = 'http://app.localhost:8080/auth/callback';
  it.each(KC_ACTION_STATUSES)('reads %s', (s) => {
    expect(kcActionStatusFromCallback(`${cb}?code=abc&state=x&kc_action_status=${s}`)).toBe(s);
  });
  it('accepts a URL, URLSearchParams and a relative path', () => {
    expect(kcActionStatusFromCallback(new URL(`${cb}?kc_action_status=success`))).toBe('success');
    expect(kcActionStatusFromCallback(new URLSearchParams('kc_action_status=cancelled'))).toBe('cancelled');
    expect(kcActionStatusFromCallback('/auth/callback?kc_action_status=error')).toBe('error');
  });
  it('is undefined when the parameter is absent', () => {
    expect(kcActionStatusFromCallback(`${cb}?code=abc`)).toBeUndefined();
    expect(kcActionStatusFromCallback(cb)).toBeUndefined();
    expect(kcActionStatusFromCallback('')).toBeUndefined();
    expect(kcActionStatusFromCallback(new URLSearchParams())).toBeUndefined();
  });
  it.each(['Success', 'SUCCESS', 'succeeded', 'ok', 'true', '', ' success', 'success ', 'success,error', '<script>', 'cancelled%0A', '../x', 'canceled'])(
    'refuses the value %j (whitelist, case-sensitive)',
    (v) => {
      expect(kcActionStatusFromCallback(`${cb}?kc_action_status=${encodeURIComponent(v)}`)).toBeUndefined();
    },
  );
  it('refuses a repeated parameter (ambiguous), even when one value is valid', () => {
    expect(kcActionStatusFromCallback(`${cb}?kc_action_status=success&kc_action_status=success`)).toBeUndefined();
    expect(kcActionStatusFromCallback(`${cb}?kc_action_status=success&kc_action_status=error`)).toBeUndefined();
  });
  it('ignores the fragment and similarly named parameters', () => {
    expect(kcActionStatusFromCallback(`${cb}#kc_action_status=success`)).toBeUndefined();
    expect(kcActionStatusFromCallback(`${cb}?xkc_action_status=success`)).toBeUndefined();
    expect(kcActionStatusFromCallback(`${cb}?kc_action_status_x=success`)).toBeUndefined();
    expect(kcActionStatusFromCallback(`${cb}?kc_action=success`)).toBeUndefined();
  });
  it('does not throw on garbage', () => {
    expect(kcActionStatusFromCallback('http://[bad')).toBeUndefined();
    expect(kcActionStatusFromCallback('%%%')).toBeUndefined();
  });
});

describe('Principal.authTime and the test helpers', () => {
  let keys: TestKeys;
  beforeAll(async () => {
    keys = await createTestKeys('k-auth');
  });
  const verifier = () => createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: keys.getKey, webClientId: 'bananagig-web' });

  it('has no authTime when the token has no auth_time claim (existing default tokens are unchanged)', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys));
    expect(p.authTime).toBeUndefined();
    expect(p.sessionId).toBe('test-session-1');
    expect(p.acr).toBe('bananagig:password');
  });
  it('reads auth_time as epoch seconds', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { authTime: 1_760_000_000 }));
    expect(p.authTime).toBe(1_760_000_000);
  });
  it('signToken: authTimeAgoSec is relative to now; authTime wins when both are given', async () => {
    const now = Math.floor(Date.now() / 1000);
    const p = await verifier().verifyAccessToken(await signToken(keys, { authTimeAgoSec: 120 }));
    expect(p.authTime).toBeGreaterThanOrEqual(now - 121);
    expect(p.authTime).toBeLessThanOrEqual(now - 119);
    const both = await verifier().verifyAccessToken(await signToken(keys, { authTime: 5, authTimeAgoSec: 120 }));
    expect(both.authTime).toBe(5);
  });
  it('signToken: sid and acr options set the claims', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { sid: 'sid-xyz', acr: 'bananagig:mfa' }));
    expect(p.sessionId).toBe('sid-xyz');
    expect(p.acr).toBe('bananagig:mfa');
  });
  it('signToken: omit still removes a claim set through an option', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { sid: 'x', acr: 'y', authTime: 1, omit: ['sid', 'acr', 'auth_time'] }));
    expect(p.sessionId).toBeUndefined();
    expect(p.acr).toBeUndefined();
    expect(p.authTime).toBeUndefined();
  });
  it('signToken: the options win over claims', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { claims: { sid: 'from-claims', auth_time: 9 }, sid: 'from-option', authTime: 10 }));
    expect(p.sessionId).toBe('from-option');
    expect(p.authTime).toBe(10);
  });
  it.each([
    ['a string', '1760000000'],
    ['a negative number', -5],
    ['null', null],
    ['an object', {}],
    ['a boolean', true],
  ])('ignores an auth_time that is %s', async (_n, value) => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { claims: { auth_time: value } }));
    expect(p.authTime).toBeUndefined();
  });
  it('does not put the auth time into anything but the principal (no raw token material)', async () => {
    const p = await verifier().verifyAccessToken(await signToken(keys, { authTime: 1_760_000_000 }));
    expect(Object.keys(p).sort()).toEqual(
      [
        'acr',
        'audience',
        'authContext',
        'authTime',
        'clientId',
        'clientRoles',
        'expiresAt',
        'issuedAt',
        'issuer',
        'realmRoles',
        'scopes',
        'sessionId',
        'subject',
      ].sort(),
    );
  });
});
