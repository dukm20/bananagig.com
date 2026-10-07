// Unit tests of the pure account helpers (identity.ts): the verified identity key, the one-time bootstrap roles and the active-role resolution.
// No database, no network. Control characters are built with String.fromCharCode so no source line holds an irregular character.
import { describe, expect, it } from 'vitest';
import type { IdentityProviderType } from '@bananagig/contracts';
import { AccountError } from './errors';
import {
  MAX_ISSUER_LENGTH,
  MAX_SUBJECT_LENGTH,
  bootstrapRoleCodes,
  externalIdentityKey,
  parseVerifiedIdentity,
  resolveActiveRole,
  type MembershipView,
  type VerifiedIdentity,
} from './identity';

const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const SUBJECT = '3f1b6c9e-8a5d-4c7e-9b0a-1d2e3f4a5b6c';
const KEYCLOAK_ROLES = ['offline_access', 'uma_authorization', 'default-roles-bananagig', 'customer'];
const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  providerType: 'KEYCLOAK',
  issuer: ISSUER,
  subject: SUBJECT,
  identityRoles: KEYCLOAK_ROLES,
  ...over,
});
const ctl = (code: number): string => String.fromCharCode(code);

const thrown = (fn: () => unknown): AccountError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('expected the call to throw');
};

// ====================================================================== parseVerifiedIdentity
describe('parseVerifiedIdentity', () => {
  it('accepts the real Keycloak shape and returns the four fields', () => {
    expect(parseVerifiedIdentity(identity())).toEqual({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: SUBJECT, identityRoles: KEYCLOAK_ROLES });
  });
  it('copies identityRoles: the result neither shares nor follows the caller array', () => {
    const roles = ['customer'];
    const parsed = parseVerifiedIdentity(identity({ identityRoles: roles }));
    expect(parsed.identityRoles).toEqual(['customer']);
    expect(parsed.identityRoles).not.toBe(roles);
    roles.push('provider');
    expect(parsed.identityRoles).toEqual(['customer']);
  });
  it('accepts an empty role list', () => {
    expect(parseVerifiedIdentity(identity({ identityRoles: [] })).identityRoles).toEqual([]);
  });
  it('returns a new object and drops any property that is not part of the identity key', () => {
    const input = { ...identity(), email: 'ana@example.com', accessToken: 'tok', name: 'Ana' } as VerifiedIdentity;
    const parsed = parseVerifiedIdentity(input);
    expect(parsed).not.toBe(input);
    expect(Object.keys(parsed).sort()).toEqual(['identityRoles', 'issuer', 'providerType', 'subject']);
  });
  it('uses the issuer and subject verbatim: no trimming, no case folding', () => {
    const parsed = parseVerifiedIdentity(identity({ issuer: ` ${ISSUER}/ `, subject: ` ${SUBJECT.toUpperCase()} ` }));
    expect(parsed.issuer).toBe(` ${ISSUER}/ `);
    expect(parsed.subject).toBe(` ${SUBJECT.toUpperCase()} `);
  });
  it('accepts non-ASCII and punctuation in the subject (Keycloak subjects are opaque)', () => {
    expect(parseVerifiedIdentity(identity({ subject: 'user:a b/c|d@e' })).subject).toBe('user:a b/c|d@e');
    expect(parseVerifiedIdentity(identity({ subject: String.fromCodePoint(0x674e, 0x660e) })).subject).toBe(String.fromCodePoint(0x674e, 0x660e));
  });

  describe('limits', () => {
    it('exposes the database column limits 512 and 255', () => {
      expect(MAX_ISSUER_LENGTH).toBe(512);
      expect(MAX_SUBJECT_LENGTH).toBe(255);
    });
    it('accepts an issuer of exactly 512 characters and rejects 513', () => {
      expect(parseVerifiedIdentity(identity({ issuer: 'i'.repeat(512) })).issuer).toHaveLength(512);
      expect(thrown(() => parseVerifiedIdentity(identity({ issuer: 'i'.repeat(513) }))).details).toEqual({ reason: 'INVALID_IDENTITY', field: 'issuer' });
    });
    it('accepts a subject of exactly 255 characters and rejects 256', () => {
      expect(parseVerifiedIdentity(identity({ subject: 's'.repeat(255) })).subject).toHaveLength(255);
      expect(thrown(() => parseVerifiedIdentity(identity({ subject: 's'.repeat(256) }))).details).toEqual({ reason: 'INVALID_IDENTITY', field: 'subject' });
    });
  });

  describe('rejections', () => {
    it.each([
      ['an empty issuer', { issuer: '' }, 'issuer'],
      ['a blank issuer', { issuer: '   ' }, 'issuer'],
      ['an issuer that is only whitespace characters', { issuer: ' \t ' }, 'issuer'],
      ['a non-string issuer', { issuer: 5 as unknown as string }, 'issuer'],
      ['an undefined issuer', { issuer: undefined as unknown as string }, 'issuer'],
      ['a null issuer', { issuer: null as unknown as string }, 'issuer'],
      ['an empty subject', { subject: '' }, 'subject'],
      ['a blank subject', { subject: '    ' }, 'subject'],
      ['a non-string subject', { subject: 42 as unknown as string }, 'subject'],
      ['an undefined subject', { subject: undefined as unknown as string }, 'subject'],
      ['an object subject', { subject: { toString: () => 'x' } as unknown as string }, 'subject'],
      ['an unknown provider type', { providerType: 'GOOGLE' as IdentityProviderType }, 'providerType'],
      ['a lower-case provider type', { providerType: 'keycloak' as IdentityProviderType }, 'providerType'],
      ['an empty provider type', { providerType: '' as IdentityProviderType }, 'providerType'],
      ['an undefined provider type', { providerType: undefined as unknown as IdentityProviderType }, 'providerType'],
    ])('rejects %s', (_label, over, field) => {
      const err = thrown(() => parseVerifiedIdentity(identity(over)));
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.details).toEqual({ reason: 'INVALID_IDENTITY', field });
    });
    it.each([
      ['NUL', 0],
      ['TAB', 9],
      ['LF', 10],
      ['CR', 13],
      ['ESC', 27],
      ['US', 31],
      ['DEL', 127],
    ])('rejects a %s character in the issuer and in the subject', (_name, code) => {
      expect(thrown(() => parseVerifiedIdentity(identity({ issuer: `${ISSUER}${ctl(code)}` }))).details).toMatchObject({ field: 'issuer' });
      expect(thrown(() => parseVerifiedIdentity(identity({ subject: `${SUBJECT}${ctl(code)}` }))).details).toMatchObject({ field: 'subject' });
      expect(thrown(() => parseVerifiedIdentity(identity({ subject: `${ctl(code)}${SUBJECT}` }))).details).toMatchObject({ field: 'subject' });
    });
    it('reports the first failing field in the order provider type, issuer, subject', () => {
      expect(thrown(() => parseVerifiedIdentity(identity({ providerType: 'X' as IdentityProviderType, issuer: '', subject: '' }))).details).toMatchObject({
        field: 'providerType',
      });
      expect(thrown(() => parseVerifiedIdentity(identity({ issuer: '', subject: '' }))).details).toMatchObject({ field: 'issuer' });
    });
    it('never echoes the rejected value in the message, the details or the stack', () => {
      const secretIssuer = `http://issuer-marker-6c1d.example/realms/${'x'.repeat(520)}`;
      const secretSubject = `subject-marker-91ab${'y'.repeat(260)}`;
      const cases: Partial<VerifiedIdentity>[] = [
        { issuer: secretIssuer },
        { subject: secretSubject },
        { issuer: `issuer-marker-6c1d${ctl(0)}` },
        { subject: `subject-marker-91ab${ctl(10)}` },
      ];
      for (const over of cases) {
        const err = thrown(() => parseVerifiedIdentity(identity(over)));
        const text = [err.message, err.name, JSON.stringify(err.details), err.stack ?? ''].join('\n');
        expect(text).not.toContain('marker');
        expect(err.message).toBe('the verified identity is not usable');
      }
    });
    it('does not leak the VALID identity fields either when another field is invalid', () => {
      const err = thrown(() => parseVerifiedIdentity(identity({ issuer: '' })));
      expect(JSON.stringify(err.details) + err.message + (err.stack ?? '')).not.toContain(SUBJECT);
    });
  });
});

// ====================================================================== externalIdentityKey
describe('externalIdentityKey', () => {
  const key = (over: Partial<Pick<VerifiedIdentity, 'providerType' | 'issuer' | 'subject'>> = {}) =>
    externalIdentityKey({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: SUBJECT, ...over });

  it('is stable: the same identity always yields the same key', () => {
    expect(key()).toBe(key());
    expect(externalIdentityKey(identity())).toBe(key());
  });
  it('ignores everything but provider type, issuer and subject (the roles never change the key)', () => {
    expect(externalIdentityKey(identity({ identityRoles: [] }))).toBe(externalIdentityKey(identity({ identityRoles: ['provider', 'customer'] })));
  });
  it('distinguishes identities that differ by a single character of the subject', () => {
    expect(key({ subject: `${SUBJECT.slice(0, -1)}d` })).not.toBe(key());
    expect(key({ subject: SUBJECT.toUpperCase() })).not.toBe(key());
    expect(key({ subject: `${SUBJECT} ` })).not.toBe(key());
  });
  it('distinguishes identities that differ by a single character of the issuer', () => {
    expect(key({ issuer: `${ISSUER}x` })).not.toBe(key());
    expect(key({ issuer: `${ISSUER}/` })).not.toBe(key());
    expect(key({ issuer: ISSUER.replace('bananagig', 'bananagik') })).not.toBe(key());
    expect(key({ issuer: ISSUER.replace('http:', 'https:') })).not.toBe(key());
  });
  it('distinguishes the provider type', () => {
    expect(key({ providerType: 'OTHER' as IdentityProviderType })).not.toBe(key());
  });
  it('does not collapse canonically equivalent Unicode: values are used verbatim', () => {
    const composed = String.fromCodePoint(0xe9);
    const decomposed = `e${String.fromCodePoint(0x301)}`;
    expect(key({ subject: composed })).not.toBe(key({ subject: decomposed }));
  });
  it('has no collisions through delimiter tricks', () => {
    const pairs: [string, string][] = [
      ['a|b', 'c'],
      ['a', 'b|c'],
      ['a:b', 'c'],
      ['a', 'b:c'],
      ['a/b', 'c'],
      ['a', 'b/c'],
      ['a,b', 'c'],
      ['a', 'b,c'],
      ['a","b', 'c'],
      ['a', 'b","c'],
      ['a\\', '"b'],
      ['a', '\\"b'],
      ['a]', '[b'],
      ['a', ']["b'],
      ['', 'a'],
      ['a', ''],
      ['a b', 'c'],
      ['a', 'b c'],
    ];
    const keys = pairs.map(([issuer, subject]) => key({ issuer, subject }));
    expect(new Set(keys).size).toBe(pairs.length);
  });
  it('is injective over every issuer and subject built from a small alphabet of delimiters and quotes', () => {
    const alphabet = ['a', '"', ',', '\\', '|'];
    const strings: string[] = [''];
    let frontier = [''];
    for (let len = 1; len <= 3; len++) {
      frontier = frontier.flatMap((s) => alphabet.map((c) => s + c));
      strings.push(...frontier);
    }
    const seen = new Map<string, string>();
    for (const issuer of strings) {
      for (const subject of strings) {
        const k = key({ issuer, subject });
        const label = JSON.stringify([issuer, subject]);
        expect(seen.has(k), `${label} collides with ${seen.get(k)}`).toBe(false);
        seen.set(k, label);
      }
    }
    expect(seen.size).toBe(strings.length ** 2);
  });
});

// ====================================================================== bootstrapRoleCodes
describe('bootstrapRoleCodes', () => {
  it('maps customer to CUSTOMER', () => {
    expect(bootstrapRoleCodes(['customer'])).toEqual(['CUSTOMER']);
  });
  it('maps provider to PROVIDER only (a provider-first account is not also a customer)', () => {
    expect(bootstrapRoleCodes(['provider'])).toEqual(['PROVIDER']);
  });
  it('returns both roles in the order of the mapping, whatever the order of the token roles', () => {
    expect(bootstrapRoleCodes(['customer', 'provider'])).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(bootstrapRoleCodes(['provider', 'customer'])).toEqual(['CUSTOMER', 'PROVIDER']);
  });
  it('maps the realm roles of a real dev token and ignores the Keycloak defaults', () => {
    expect(bootstrapRoleCodes(['offline_access', 'uma_authorization', 'default-roles-bananagig', 'provider'])).toEqual(['PROVIDER']);
  });
  it('returns nothing for no roles', () => {
    expect(bootstrapRoleCodes([])).toEqual([]);
  });
  it('ignores unknown roles', () => {
    expect(bootstrapRoleCodes(['offline_access', 'uma_authorization', 'default-roles-bananagig', 'operator', 'support'])).toEqual([]);
  });
  it.each(['admin', 'ADMIN', 'administrator', 'super-admin', 'platform_admin', 'admin-console-access', 'realm-admin'])(
    'never maps the admin-like role %s',
    (role) => {
      expect(bootstrapRoleCodes([role])).toEqual([]);
      expect(bootstrapRoleCodes([role, 'customer'])).toEqual(['CUSTOMER']);
    },
  );
  it('is case-sensitive and exact', () => {
    expect(bootstrapRoleCodes(['Customer', 'PROVIDER', 'CUSTOMER', 'Provider'])).toEqual([]);
    expect(bootstrapRoleCodes([' customer', 'provider '])).toEqual([]);
    expect(bootstrapRoleCodes(['customers', 'provider.dev', 'customer.dev'])).toEqual([]);
  });
  it('removes duplicates', () => {
    expect(bootstrapRoleCodes(['customer', 'customer', 'provider', 'provider', 'customer'])).toEqual(['CUSTOMER', 'PROVIDER']);
  });
  it('does not read inherited object properties as roles', () => {
    expect(bootstrapRoleCodes(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])).toEqual([]);
  });
  it('does not mutate the input and returns a fresh array on every call', () => {
    const roles = Object.freeze(['provider', 'customer']);
    const first = bootstrapRoleCodes(roles);
    first.push('TAMPERED');
    expect(roles).toEqual(['provider', 'customer']);
    expect(bootstrapRoleCodes(roles)).toEqual(['CUSTOMER', 'PROVIDER']);
  });
});

// ====================================================================== resolveActiveRole
const m = (code: string, status: MembershipView['status']): MembershipView => ({ code, status });
const CUSTOMER_ACTIVE = m('CUSTOMER', 'ACTIVE');
const PROVIDER_ACTIVE = m('PROVIDER', 'ACTIVE');

describe('resolveActiveRole: a requested role', () => {
  it('accepts a requested ACTIVE role', () => {
    expect(resolveActiveRole({ requested: 'PROVIDER', memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('PROVIDER');
  });
  it('lets the request win over the primary role', () => {
    expect(resolveActiveRole({ requested: 'CUSTOMER', memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: 'PROVIDER' })).toBe('CUSTOMER');
  });
  it('accepts an ACTIVE role that is not the primary role, with no primary role at all', () => {
    expect(resolveActiveRole({ requested: 'PROVIDER', memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: null })).toBe('PROVIDER');
  });
  it.each(['INACTIVE', 'PENDING'] as const)('rejects a held role whose membership is %s with ROLE_NOT_ACTIVE', (status) => {
    const err = thrown(() => resolveActiveRole({ requested: 'PROVIDER', memberships: [CUSTOMER_ACTIVE, m('PROVIDER', status)], primaryRole: 'CUSTOMER' }));
    expect(err.code).toBe('ROLE_NOT_ACTIVE');
    expect(err.details).toEqual({ role: 'PROVIDER' });
  });
  it('rejects an INACTIVE or PENDING role even when it is the only membership and the primary role', () => {
    expect(thrown(() => resolveActiveRole({ requested: 'PROVIDER', memberships: [m('PROVIDER', 'INACTIVE')], primaryRole: 'PROVIDER' })).code).toBe(
      'ROLE_NOT_ACTIVE',
    );
    expect(thrown(() => resolveActiveRole({ requested: 'PROVIDER', memberships: [m('PROVIDER', 'PENDING')], primaryRole: null })).code).toBe('ROLE_NOT_ACTIVE');
  });
  it('rejects a role the account does not hold with ROLE_NOT_HELD', () => {
    const err = thrown(() => resolveActiveRole({ requested: 'PROVIDER', memberships: [CUSTOMER_ACTIVE], primaryRole: 'CUSTOMER' }));
    expect(err.code).toBe('ROLE_NOT_HELD');
    expect(err.details).toEqual({ role: 'PROVIDER' });
  });
  it('rejects every role when the account holds none', () => {
    expect(thrown(() => resolveActiveRole({ requested: 'CUSTOMER', memberships: [], primaryRole: null })).code).toBe('ROLE_NOT_HELD');
  });
  it('is ROLE_NOT_HELD, not an escalation, for a well-formed role code that does not exist at all', () => {
    expect(thrown(() => resolveActiveRole({ requested: 'SUPERUSER', memberships: [CUSTOMER_ACTIVE], primaryRole: 'CUSTOMER' })).code).toBe('ROLE_NOT_HELD');
  });
  it.each([
    ['a lower-case code', 'provider'],
    ['an empty string', ''],
    ['a single character', 'A'],
    ['surrounding space', 'PROVIDER '],
    ['a comma list', 'CUSTOMER,PROVIDER'],
    ['SQL text', 'X; DROP TABLE identity.roles'],
    ['an over-long code', `A${'B'.repeat(30)}`],
    ['a trailing newline', 'PROVIDER\n'],
  ])('rejects a malformed code (%s) as ROLE_NOT_HELD with reason INVALID_ROLE_CODE and without echoing it', (_label, requested) => {
    const err = thrown(() => resolveActiveRole({ requested, memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' }));
    expect(err.code).toBe('ROLE_NOT_HELD');
    expect(err.details).toEqual({ reason: 'INVALID_ROLE_CODE' });
    if (requested.length > 1) expect(err.message + JSON.stringify(err.details)).not.toContain(requested);
  });
  it('checks the format before looking at memberships: a malformed code is rejected even when a membership carries it', () => {
    const err = thrown(() => resolveActiveRole({ requested: 'bad-code', memberships: [m('bad-code', 'ACTIVE')], primaryRole: null }));
    expect(err.details).toEqual({ reason: 'INVALID_ROLE_CODE' });
  });
  it('treats an empty string as a request (it is rejected), not as no request', () => {
    expect(thrown(() => resolveActiveRole({ requested: '', memberships: [CUSTOMER_ACTIVE], primaryRole: 'CUSTOMER' })).details).toEqual({
      reason: 'INVALID_ROLE_CODE',
    });
  });
  it('treats undefined and null as no request', () => {
    expect(resolveActiveRole({ requested: undefined, memberships: [CUSTOMER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('CUSTOMER');
    expect(resolveActiveRole({ requested: null, memberships: [CUSTOMER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('CUSTOMER');
    expect(resolveActiveRole({ memberships: [CUSTOMER_ACTIVE], primaryRole: null })).toBe('CUSTOMER');
  });
});

describe('resolveActiveRole: no request', () => {
  it('uses the primary role when it is active, even with other active roles', () => {
    expect(resolveActiveRole({ memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: 'PROVIDER' })).toBe('PROVIDER');
    expect(resolveActiveRole({ memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('CUSTOMER');
  });
  it('uses the only active role when there is no primary role', () => {
    expect(resolveActiveRole({ memberships: [CUSTOMER_ACTIVE], primaryRole: null })).toBe('CUSTOMER');
    expect(resolveActiveRole({ memberships: [m('CUSTOMER', 'INACTIVE'), PROVIDER_ACTIVE], primaryRole: null })).toBe('PROVIDER');
  });
  it('returns null for two active roles and no primary role (the client must choose)', () => {
    expect(resolveActiveRole({ memberships: [CUSTOMER_ACTIVE, PROVIDER_ACTIVE], primaryRole: null })).toBeNull();
  });
  it('ignores an inactive primary role and falls back to the single active role', () => {
    expect(resolveActiveRole({ memberships: [m('CUSTOMER', 'INACTIVE'), PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('PROVIDER');
  });
  it('ignores a PENDING primary role', () => {
    expect(resolveActiveRole({ memberships: [m('CUSTOMER', 'PENDING'), PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('PROVIDER');
  });
  it('ignores a primary role that is not among the memberships', () => {
    expect(resolveActiveRole({ memberships: [PROVIDER_ACTIVE], primaryRole: 'CUSTOMER' })).toBe('PROVIDER');
  });
  it('returns null when the primary role is inactive and two other roles are active', () => {
    expect(resolveActiveRole({ memberships: [m('A_ROLE', 'ACTIVE'), m('B_ROLE', 'ACTIVE'), m('CUSTOMER', 'INACTIVE')], primaryRole: 'CUSTOMER' })).toBeNull();
  });
  it('returns null when no role is active', () => {
    expect(resolveActiveRole({ memberships: [m('CUSTOMER', 'INACTIVE'), m('PROVIDER', 'PENDING')], primaryRole: 'CUSTOMER' })).toBeNull();
    expect(resolveActiveRole({ memberships: [], primaryRole: null })).toBeNull();
    expect(resolveActiveRole({ memberships: [], primaryRole: 'CUSTOMER' })).toBeNull();
  });
  it('does not depend on the order of the memberships and does not mutate them', () => {
    const memberships = Object.freeze([PROVIDER_ACTIVE, CUSTOMER_ACTIVE]);
    expect(resolveActiveRole({ memberships, primaryRole: 'CUSTOMER' })).toBe('CUSTOMER');
    expect(resolveActiveRole({ memberships: [...memberships].reverse(), primaryRole: 'CUSTOMER' })).toBe('CUSTOMER');
    expect(memberships).toEqual([PROVIDER_ACTIVE, CUSTOMER_ACTIVE]);
  });
});
