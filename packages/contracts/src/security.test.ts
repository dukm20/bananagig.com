// Unit tests of the security contracts (ID-004): the vocabularies (values AND order), the derived session status, the acr check, the content-key helpers (every
// produced key must be a valid content key), the strict request bodies (nothing is coerced, nothing unknown is accepted), the read models and operation results
// (no IP, user agent, token, secret, hash, Keycloak id, address or code can ride along), the identity events (identifiers only) and the audit action list
// (it must match the CHECK constraint widened by migration 0012).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN } from './index';
import {
  ACR_MFA,
  ACR_PASSWORD,
  AUTH_SECURITY_ERROR_CODES,
  BROWSER_FAMILIES,
  BrowserFamily,
  DEVICE_CLASSES,
  DEVICE_SECRET_SHAPE,
  DeviceClass,
  DeviceRemovedDto,
  DeviceRemovedResponse,
  DeviceSummaryDto,
  DeviceTrustDto,
  DeviceTrustResponse,
  KEYCLOAK_ACTION_OF_METHOD,
  KEYCLOAK_PROPAGATION_OUTCOMES,
  MFA_METHODS,
  MfaChangedPayload,
  MfaEnrollmentDto,
  MfaEnrollmentResponse,
  MfaMethod,
  OS_FAMILIES,
  OsFamily,
  PASSWORD_RESET_EMAIL_MAX_LENGTH,
  PasswordResetAcceptedDto,
  PasswordResetAcceptedResponse,
  PasswordResetCompletedPayload,
  PasswordResetRequest,
  PasswordResetRequestedPayload,
  RegisterSessionRequest,
  RegisteredSessionDto,
  RegisteredSessionResponse,
  RevokeAllSessionsRequest,
  SECURITY_ACTIVITY_DEFAULT_LIMIT,
  SECURITY_ACTIVITY_MAX_LIMIT,
  SECURITY_ACTIVITY_TYPES,
  SECURITY_AUDIT_ACTIONS,
  SECURITY_ERROR_CODES,
  SECURITY_EVENTS,
  SECURITY_TIMELINE_CONTACT_ACTIONS,
  SESSION_REVOCATION_REASONS,
  SESSION_STATUSES,
  STEP_UP_REQUIREMENTS,
  SecurityActivityDto,
  SecurityActivityEntryDto,
  SecurityActivityResponse,
  SecurityActivityType,
  SecurityDeviceDto,
  SecurityDeviceIdParam,
  SecurityDevicesDto,
  SecurityDevicesResponse,
  SecurityOverviewDto,
  SecurityOverviewResponse,
  SecurityPolicyDto,
  SecuritySessionDto,
  SecuritySessionIdParam,
  SecuritySessionsDto,
  SecuritySessionsResponse,
  SessionCreatedPayload,
  SessionRevocationReason,
  SessionRevokedDto,
  SessionRevokedPayload,
  SessionRevokedResponse,
  SessionStatus,
  SessionsRevokedAllDto,
  SessionsRevokedAllPayload,
  SessionsRevokedAllResponse,
  SignedOutDto,
  SignedOutResponse,
  StartMfaEnrollmentRequest,
  StepUpDetails,
  USER_AGENT_MAX_LENGTH,
  authSecurityErrorMessageKey,
  browserLabelKey,
  deviceClassLabelKey,
  isMfaAcr,
  osLabelKey,
  securityActivityLabelKey,
  securityErrorMessageKey,
  sessionStatusOf,
  type AuthSecurityErrorCode,
  type SecurityErrorCode,
  type SessionRevocationReason as SessionRevocationReasonType,
} from './security';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0012_application_sessions.sql', import.meta.url)), 'utf8');

// ---------------------------------------------------------------- zod shape walker (same technique as phone.test.ts)
type Entry = { path: string; key: string; type: string };
type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown; catchall?: { def: { type: string } } };
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;
function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  if ((def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) return unwrap(def.innerType);
  return schema;
}
function walk(schema: unknown, prefix = ''): Entry[] {
  const def = defOf(schema);
  if (def.type === 'object' && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const inner = unwrap(child);
      return [{ path, key, type: defOf(inner).type }, ...walk(inner, path)];
    });
  }
  if (def.type === 'array' && def.element) return walk(def.element, `${prefix}[]`);
  return [];
}
const keysOf = (schema: unknown): string[] => walk(schema).map((e) => e.key);

// ---------------------------------------------------------------- fixtures
const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const UUID_B = '9b2f6d0e-5c1a-4e0b-8a77-0d3c5f9a1e21';
const ISO = '2026-10-16T12:00:00.000Z';
const DEVICE_SECRET = 'A'.repeat(43);
const META = { correlationId: 'corr-1' };
const device = { browser: 'CHROME', os: 'MACOS', deviceClass: 'DESKTOP' } as const;
const wrap = (data: unknown) => ({ data, meta: META });

const sessionDto = {
  sessionId: UUID_A,
  current: true,
  status: 'ACTIVE',
  device,
  deviceId: UUID_B,
  createdAt: ISO,
  lastSeenAt: ISO,
  trusted: true,
  trustedUntil: ISO,
};
const deviceDto = { deviceId: UUID_B, current: false, device, firstSeenAt: ISO, lastSeenAt: ISO, trusted: false, trustedUntil: null };
const activityEntry = {
  id: UUID_A,
  type: 'SESSION_CREATED',
  occurredAt: ISO,
  outcome: 'SUCCESS',
  labelContentKey: 'account.security.activity.session_created',
  sessionId: UUID_B,
  device,
};
const overviewDto = {
  mfa: { available: true, totpConfigured: true, recoveryCodesConfigured: false },
  stepUp: { authenticatedAt: ISO, mfaSatisfied: true, recentUntil: ISO },
  currentSession: { sessionId: UUID_A, deviceId: UUID_B, deviceTrusted: true, trustedUntil: ISO },
  policy: { trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 },
};
const registeredSession = { sessionId: UUID_A, deviceId: null, deviceTrusted: false, trustedUntil: null };
const sessionRevoked = { sessionId: UUID_A, changed: true, current: false, keycloak: 'ENDED' };
const sessionsRevokedAll = { revokedCount: 3, keycloak: 'UNAVAILABLE' };
const signedOut = { changed: true, keycloak: 'NOT_NEEDED' };
const deviceTrust = { deviceId: UUID_B, trusted: true, trustedUntil: ISO };
const deviceRemoved = { deviceId: UUID_B, changed: true, sessionsRevoked: 2, keycloak: 'ENDED' };
const mfaEnrollment = { method: 'TOTP', keycloakAction: 'CONFIGURE_TOTP' };

// ====================================================================== vocabularies
describe('vocabularies (exact values and order)', () => {
  it.each([
    [
      'SESSION_REVOCATION_REASONS',
      SESSION_REVOCATION_REASONS,
      ['SIGN_OUT', 'REVOKED_BY_USER', 'SIGN_OUT_EVERYWHERE', 'KEYCLOAK_ENDED', 'DEVICE_REMOVED', 'PASSWORD_CHANGED'],
    ],
    ['SESSION_STATUSES', SESSION_STATUSES, ['ACTIVE', 'ENDED', 'REVOKED']],
    ['BROWSER_FAMILIES', BROWSER_FAMILIES, ['CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OPERA', 'OTHER']],
    ['OS_FAMILIES', OS_FAMILIES, ['WINDOWS', 'MACOS', 'LINUX', 'IOS', 'ANDROID', 'OTHER']],
    ['DEVICE_CLASSES', DEVICE_CLASSES, ['DESKTOP', 'MOBILE', 'TABLET', 'OTHER']],
    ['MFA_METHODS', MFA_METHODS, ['TOTP', 'RECOVERY_CODES']],
    [
      'SECURITY_AUDIT_ACTIONS',
      SECURITY_AUDIT_ACTIONS,
      [
        'SESSION_CREATED',
        'SESSION_ENDED',
        'SESSION_REVOKED',
        'SESSIONS_REVOKED_ALL',
        'DEVICE_TRUSTED',
        'DEVICE_UNTRUSTED',
        'DEVICE_REMOVED',
        'MFA_ENROLLMENT_REQUESTED',
        'MFA_ENABLED',
        'MFA_DISABLED',
        'RECOVERY_CODES_REQUESTED',
        'RECOVERY_CODES_ENABLED',
        'RECOVERY_CODES_DISABLED',
        'PASSWORD_RESET_REQUESTED',
        'PASSWORD_CHANGED',
        'PASSWORD_RESET_COMPLETED',
      ],
    ],
    [
      'SECURITY_TIMELINE_CONTACT_ACTIONS',
      SECURITY_TIMELINE_CONTACT_ACTIONS,
      ['EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED', 'PHONE_VERIFIED', 'PHONE_PRIMARY_CHANGED'],
    ],
    ['STEP_UP_REQUIREMENTS', STEP_UP_REQUIREMENTS, ['RECENT_AUTHENTICATION', 'MFA']],
    ['AUTH_SECURITY_ERROR_CODES', AUTH_SECURITY_ERROR_CODES, ['SESSION_REVOKED', 'STEP_UP_REQUIRED', 'MFA_ENROLLMENT_REQUIRED']],
    [
      'SECURITY_ERROR_CODES',
      SECURITY_ERROR_CODES,
      ['SESSION_NOT_FOUND', 'DEVICE_NOT_FOUND', 'DEVICE_REQUIRED', 'SECURITY_UNAVAILABLE', 'PASSWORD_RESET_RATE_LIMITED'],
    ],
    ['KEYCLOAK_PROPAGATION_OUTCOMES', KEYCLOAK_PROPAGATION_OUTCOMES, ['ENDED', 'UNAVAILABLE', 'NOT_NEEDED']],
  ] as const)('%s', (_name, actual, expected) => {
    expect([...actual]).toEqual([...expected]);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('has the documented sizes', () => {
    expect(SESSION_REVOCATION_REASONS).toHaveLength(6);
    expect(SECURITY_AUDIT_ACTIONS).toHaveLength(16);
    expect(SECURITY_TIMELINE_CONTACT_ACTIONS).toHaveLength(4);
    expect(SECURITY_ACTIVITY_TYPES).toHaveLength(20);
  });

  it('SECURITY_ACTIVITY_TYPES is the audit actions followed by the contact actions', () => {
    expect([...SECURITY_ACTIVITY_TYPES]).toEqual([...SECURITY_AUDIT_ACTIONS, ...SECURITY_TIMELINE_CONTACT_ACTIONS]);
    expect(new Set(SECURITY_ACTIVITY_TYPES).size).toBe(20);
  });

  it('the audit actions and the contact actions do not overlap', () => {
    for (const a of SECURITY_TIMELINE_CONTACT_ACTIONS) expect(SECURITY_AUDIT_ACTIONS as readonly string[]).not.toContain(a);
  });

  it('every vocabulary is upper snake case', () => {
    const all = [
      ...SESSION_REVOCATION_REASONS,
      ...SESSION_STATUSES,
      ...BROWSER_FAMILIES,
      ...OS_FAMILIES,
      ...DEVICE_CLASSES,
      ...MFA_METHODS,
      ...SECURITY_ACTIVITY_TYPES,
      ...STEP_UP_REQUIREMENTS,
      ...AUTH_SECURITY_ERROR_CODES,
      ...SECURITY_ERROR_CODES,
      ...KEYCLOAK_PROPAGATION_OUTCOMES,
    ];
    for (const v of all) expect(v).toMatch(/^[A-Z][A-Z_]*$/);
  });

  it.each([
    ['SessionRevocationReason', SessionRevocationReason, SESSION_REVOCATION_REASONS],
    ['SessionStatus', SessionStatus, SESSION_STATUSES],
    ['BrowserFamily', BrowserFamily, BROWSER_FAMILIES],
    ['OsFamily', OsFamily, OS_FAMILIES],
    ['DeviceClass', DeviceClass, DEVICE_CLASSES],
    ['MfaMethod', MfaMethod, MFA_METHODS],
    ['SecurityActivityType', SecurityActivityType, SECURITY_ACTIVITY_TYPES],
  ] as const)('the %s schema accepts exactly its vocabulary', (_n, schema, values) => {
    for (const v of values) expect(schema.safeParse(v).success).toBe(true);
    for (const bad of ['', 'nope', 'chrome', 'Chrome', ' CHROME', 'CHROME ', 1, null, undefined, {}, []]) expect(schema.safeParse(bad).success).toBe(false);
  });

  it('constants', () => {
    expect(ACR_PASSWORD).toBe('bananagig:password');
    expect(ACR_MFA).toBe('bananagig:mfa');
    expect(SECURITY_ACTIVITY_MAX_LIMIT).toBe(100);
    expect(SECURITY_ACTIVITY_DEFAULT_LIMIT).toBe(25);
    expect(SECURITY_ACTIVITY_DEFAULT_LIMIT).toBeLessThanOrEqual(SECURITY_ACTIVITY_MAX_LIMIT);
    expect(PASSWORD_RESET_EMAIL_MAX_LENGTH).toBe(320);
    expect(USER_AGENT_MAX_LENGTH).toBe(512);
  });

  it('KEYCLOAK_ACTION_OF_METHOD maps every method to its kc_action and nothing else', () => {
    expect(KEYCLOAK_ACTION_OF_METHOD).toEqual({ TOTP: 'CONFIGURE_TOTP', RECOVERY_CODES: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    expect(Object.keys(KEYCLOAK_ACTION_OF_METHOD).sort()).toEqual([...MFA_METHODS].sort());
  });
});

// ====================================================================== migration 0012 parity
describe('audit actions match migration 0012', () => {
  const checkBody = /ADD CONSTRAINT ck_account_audit_events__action CHECK \(\s*action IN \(([^)]*)\)/.exec(migration)?.[1] ?? '';
  const migrationActions = [...checkBody.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);

  it('parsed the CHECK list', () => {
    expect(migrationActions.length).toBeGreaterThanOrEqual(37);
    expect(new Set(migrationActions).size).toBe(migrationActions.length);
  });

  it('contains every security audit action', () => {
    for (const a of SECURITY_AUDIT_ACTIONS) expect(migrationActions, a).toContain(a);
  });

  it('contains every contact action shown on the timeline', () => {
    for (const a of SECURITY_TIMELINE_CONTACT_ACTIONS) expect(migrationActions, a).toContain(a);
  });

  it('keeps the older actions (the widening removes nothing)', () => {
    for (const a of [
      'ACCOUNT_CREATED',
      'EXTERNAL_IDENTITY_LINKED',
      'ROLE_GRANTED',
      'ROLE_ACTIVATED',
      'ROLE_DEACTIVATED',
      'PRIMARY_ROLE_CHANGED',
      'PROFILE_UPDATED',
      'EMAIL_ADDED',
      'EMAIL_CHANGE_REQUESTED',
      'EMAIL_VERIFICATION_REQUESTED',
      'EMAIL_VERIFICATION_FAILED',
      'EMAIL_VERIFICATION_LOCKED',
      'EMAIL_VERIFIED',
      'EMAIL_PRIMARY_CHANGED',
      'PHONE_ADDED',
      'PHONE_CHANGE_REQUESTED',
      'PHONE_VERIFICATION_REQUESTED',
      'PHONE_VERIFICATION_FAILED',
      'PHONE_VERIFICATION_LOCKED',
      'PHONE_VERIFIED',
      'PHONE_PRIMARY_CHANGED',
    ])
      expect(migrationActions, a).toContain(a);
  });

  it('the migration has no security action the contract lacks', () => {
    const securityLike = migrationActions.filter((a) => /^(SESSION|SESSIONS|DEVICE|MFA|RECOVERY_CODES|PASSWORD)_/.test(a));
    expect([...securityLike].sort()).toEqual([...SECURITY_AUDIT_ACTIONS].sort());
  });

  it('the migration says sixteen security actions were added', () => {
    expect(migrationActions.length - 21).toBe(SECURITY_AUDIT_ACTIONS.length);
  });
});

// ====================================================================== sessionStatusOf / isMfaAcr
describe('sessionStatusOf', () => {
  it('null is ACTIVE', () => expect(sessionStatusOf(null)).toBe('ACTIVE'));
  it.each<[SessionRevocationReasonType, string]>([
    ['SIGN_OUT', 'ENDED'],
    ['KEYCLOAK_ENDED', 'ENDED'],
    ['REVOKED_BY_USER', 'REVOKED'],
    ['SIGN_OUT_EVERYWHERE', 'REVOKED'],
    ['DEVICE_REMOVED', 'REVOKED'],
    ['PASSWORD_CHANGED', 'REVOKED'],
  ])('%s is %s', (reason, status) => expect(sessionStatusOf(reason)).toBe(status));
  it('covers every reason with a valid status', () => {
    for (const r of SESSION_REVOCATION_REASONS) expect(SessionStatus.safeParse(sessionStatusOf(r)).success).toBe(true);
    // only a null reason is ACTIVE
    for (const r of SESSION_REVOCATION_REASONS) expect(sessionStatusOf(r)).not.toBe('ACTIVE');
  });
});

describe('isMfaAcr', () => {
  it('accepts only the exact MFA acr', () => expect(isMfaAcr('bananagig:mfa')).toBe(true));
  it.each([
    undefined,
    '',
    'bananagig:password',
    'BANANAGIG:MFA',
    'Bananagig:mfa',
    'bananagig:MFA',
    'mfa',
    '2',
    '1',
    ' bananagig:mfa',
    'bananagig:mfa ',
    'bananagig:mfa\n',
    'bananagig: mfa',
    'bananagig:mfa:extra',
    'urn:bananagig:mfa',
  ])('rejects %j', (acr) => expect(isMfaAcr(acr)).toBe(false));
  it('rejects the password acr', () => expect(isMfaAcr(ACR_PASSWORD)).toBe(false));
});

// ====================================================================== label keys
describe('content-key helpers', () => {
  const produced: string[] = [];
  const checkAll = <T extends string>(values: readonly T[], fn: (v: T) => string, prefix: string) => {
    for (const v of values) {
      const key = fn(v);
      produced.push(key);
      expect(key).toBe(`${prefix}${v.toLowerCase()}`);
      expect(key).toBe(key.toLowerCase());
      expect(key.startsWith('account.security.')).toBe(true);
      expect(ContentKey.safeParse(key).success, key).toBe(true);
    }
  };

  it('securityActivityLabelKey', () => checkAll(SECURITY_ACTIVITY_TYPES, securityActivityLabelKey, 'account.security.activity.'));
  it('browserLabelKey', () => checkAll(BROWSER_FAMILIES, browserLabelKey, 'account.security.browser.'));
  it('osLabelKey', () => checkAll(OS_FAMILIES, osLabelKey, 'account.security.os.'));
  it('deviceClassLabelKey', () => checkAll(DEVICE_CLASSES, deviceClassLabelKey, 'account.security.device_class.'));
  it('securityErrorMessageKey', () => checkAll(SECURITY_ERROR_CODES, securityErrorMessageKey, 'account.security.error.'));
  it('authSecurityErrorMessageKey', () => checkAll(AUTH_SECURITY_ERROR_CODES, authSecurityErrorMessageKey, 'account.security.error.'));

  it('the two error helpers agree where they overlap (none do today) and never collide otherwise', () => {
    const security = new Set<string>(SECURITY_ERROR_CODES);
    for (const c of AUTH_SECURITY_ERROR_CODES) expect(security.has(c), `${c} is in both error vocabularies`).toBe(false);
  });

  it('no two helpers (or two values) produce the same key', () => {
    const all = [
      ...SECURITY_ACTIVITY_TYPES.map(securityActivityLabelKey),
      ...BROWSER_FAMILIES.map(browserLabelKey),
      ...OS_FAMILIES.map(osLabelKey),
      ...DEVICE_CLASSES.map(deviceClassLabelKey),
      ...SECURITY_ERROR_CODES.map(securityErrorMessageKey),
      ...AUTH_SECURITY_ERROR_CODES.map(authSecurityErrorMessageKey),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20 + 6 + 6 + 4 + 5 + 3);
  });

  it('the label key of an activity entry in a DTO example is the helper output', () => {
    expect(activityEntry.labelContentKey).toBe(securityActivityLabelKey('SESSION_CREATED'));
  });

  it('the produced keys include the messages seeded by migration 0012 (spot check)', () => {
    const seeded = new Set([...migration.matchAll(/'(account\.security\.[a-z0-9_.]+)'/g)].map((m) => m[1] as string));
    expect(seeded.has(securityErrorMessageKey('DEVICE_REQUIRED'))).toBe(true);
  });

  it('every key is typed as the declared error codes', () => {
    const a: SecurityErrorCode = 'SESSION_NOT_FOUND';
    const b: AuthSecurityErrorCode = 'SESSION_REVOKED';
    expect(securityErrorMessageKey(a)).toBe('account.security.error.session_not_found');
    expect(authSecurityErrorMessageKey(b)).toBe('account.security.error.session_revoked');
  });
});

// ====================================================================== requests
describe('RegisterSessionRequest', () => {
  const ok = { device: DEVICE_SECRET };
  it('accepts a device secret alone, and with a user agent', () => {
    expect(RegisterSessionRequest.safeParse(ok).success).toBe(true);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: 'Mozilla/5.0' }).success).toBe(true);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: undefined }).success).toBe(true);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: '' }).success).toBe(true);
  });

  it('DEVICE_SECRET_SHAPE is exactly 43 base64url characters', () => {
    expect(DEVICE_SECRET_SHAPE.test('A'.repeat(43))).toBe(true);
    expect(DEVICE_SECRET_SHAPE.test('A'.repeat(42))).toBe(false);
    expect(DEVICE_SECRET_SHAPE.test('A'.repeat(44))).toBe(false);
    expect(DEVICE_SECRET_SHAPE.test(`${'A'.repeat(43)}\n`)).toBe(false);
  });

  it('accepts every base64url character class', () => {
    const all = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    for (let i = 0; i + 43 <= all.length + 43; i += 7) {
      const s = (all + all).slice(i, i + 43);
      expect(RegisterSessionRequest.safeParse({ device: s }).success, s).toBe(true);
    }
    expect(RegisterSessionRequest.safeParse({ device: `-_${'a'.repeat(41)}` }).success).toBe(true);
  });

  it.each([
    ['42 chars', 'A'.repeat(42)],
    ['44 chars', 'A'.repeat(44)],
    ['empty', ''],
    ['std base64 plus', `+${'A'.repeat(42)}`],
    ['std base64 slash', `/${'A'.repeat(42)}`],
    ['padding =', `${'A'.repeat(42)}=`],
    ['padding == at 43', `${'A'.repeat(41)}==`],
    ['leading space', ` ${'A'.repeat(42)}`],
    ['trailing space', `${'A'.repeat(42)} `],
    ['trailing newline', `${'A'.repeat(43)}\n`],
    ['inner space', `${'A'.repeat(21)} ${'A'.repeat(21)}`],
    ['tab', `${'A'.repeat(42)}\t`],
    ['dot', `${'A'.repeat(42)}.`],
    ['cyrillic \u0410 lookalike', `${'A'.repeat(42)}\u0410`],
    ['greek \u0391 lookalike', `${'A'.repeat(42)}\u0391`],
    ['fullwidth A', `${'A'.repeat(42)}\uff21`],
    ['zero width space', `${'A'.repeat(42)}\u200b`],
    ['emoji', `${'A'.repeat(41)}\u{1F34C}`],
    ['null byte', `${'A'.repeat(42)}\u0000`],
  ])('refuses a device secret that is %s', (_n, device) => {
    expect(RegisterSessionRequest.safeParse({ device }).success).toBe(false);
  });

  it.each([[123], [null], [undefined], [true], [[DEVICE_SECRET]], [{ 0: 'A' }], [43]])('refuses a non-string device %j', (device) => {
    expect(RegisterSessionRequest.safeParse({ device }).success).toBe(false);
  });

  it('refuses a missing device', () => {
    expect(RegisterSessionRequest.safeParse({}).success).toBe(false);
    expect(RegisterSessionRequest.safeParse({ userAgent: 'x' }).success).toBe(false);
  });

  it('userAgent: 512 characters accepted, 513 refused', () => {
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: 'u'.repeat(512) }).success).toBe(true);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: 'u'.repeat(513) }).success).toBe(false);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: 'u'.repeat(USER_AGENT_MAX_LENGTH) }).success).toBe(true);
    expect(RegisterSessionRequest.safeParse({ ...ok, userAgent: 'u'.repeat(USER_AGENT_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('refuses a non-string userAgent (no coercion)', () => {
    for (const userAgent of [1, null, true, ['Mozilla'], { ua: 1 }]) expect(RegisterSessionRequest.safeParse({ ...ok, userAgent }).success).toBe(false);
  });

  it.each(['accountId', 'sid', 'trusted', 'sessionId', 'deviceId', 'ip', 'token', 'role', 'extra'])('refuses the unknown field %s', (field) => {
    const r = RegisterSessionRequest.safeParse({ ...ok, [field]: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses prototype keys', () => {
    expect(RegisterSessionRequest.safeParse(JSON.parse(`{"device":"${DEVICE_SECRET}","__proto__":{"admin":true}}`)).success).toBe(false);
    expect(RegisterSessionRequest.safeParse(JSON.parse(`{"device":"${DEVICE_SECRET}","constructor":{}}`)).success).toBe(false);
    expect(RegisterSessionRequest.safeParse(JSON.parse(`{"device":"${DEVICE_SECRET}","prototype":{}}`)).success).toBe(false);
  });

  it('refuses non-objects', () => {
    for (const v of [null, undefined, 'x', 1, [], [ok]]) expect(RegisterSessionRequest.safeParse(v).success).toBe(false);
  });

  it('parse returns exactly the accepted fields', () => {
    expect(RegisterSessionRequest.parse({ device: DEVICE_SECRET, userAgent: 'UA' })).toEqual({ device: DEVICE_SECRET, userAgent: 'UA' });
  });
});

describe('RevokeAllSessionsRequest', () => {
  it('accepts an empty body', () => expect(RevokeAllSessionsRequest.parse({})).toEqual({}));
  it('accepts includeCurrent true and false', () => {
    expect(RevokeAllSessionsRequest.parse({ includeCurrent: true })).toEqual({ includeCurrent: true });
    expect(RevokeAllSessionsRequest.parse({ includeCurrent: false })).toEqual({ includeCurrent: false });
    expect(RevokeAllSessionsRequest.safeParse({ includeCurrent: undefined }).success).toBe(true);
  });
  it.each([['true'], ['false'], [1], [0], [null], [[]], [{}], ['']])('refuses includeCurrent %j (no coercion)', (v) => {
    expect(RevokeAllSessionsRequest.safeParse({ includeCurrent: v }).success).toBe(false);
  });
  it('refuses unknown fields', () => {
    expect(RevokeAllSessionsRequest.safeParse({ includeAll: true }).success).toBe(false);
    expect(RevokeAllSessionsRequest.safeParse({ includeCurrent: true, accountId: UUID_A }).success).toBe(false);
    expect(RevokeAllSessionsRequest.safeParse(JSON.parse('{"__proto__":{"includeCurrent":true}}')).success).toBe(false);
  });
  it('refuses non-objects', () => {
    for (const v of [null, undefined, 'x', 1, true, []]) expect(RevokeAllSessionsRequest.safeParse(v).success).toBe(false);
  });
});

describe('StartMfaEnrollmentRequest', () => {
  it.each(MFA_METHODS)('accepts %s', (method) => expect(StartMfaEnrollmentRequest.parse({ method })).toEqual({ method }));
  it.each([['totp'], ['recovery_codes'], ['Totp'], ['SMS'], ['EMAIL'], [''], [' TOTP'], ['TOTP '], [1], [null], [undefined], [['TOTP']]])(
    'refuses method %j',
    (method) => expect(StartMfaEnrollmentRequest.safeParse({ method }).success).toBe(false),
  );
  it('refuses a missing method, an empty body and unknown fields', () => {
    expect(StartMfaEnrollmentRequest.safeParse({}).success).toBe(false);
    expect(StartMfaEnrollmentRequest.safeParse({ method: 'TOTP', secret: 'x' }).success).toBe(false);
    expect(StartMfaEnrollmentRequest.safeParse({ method: 'TOTP', keycloakAction: 'CONFIGURE_TOTP' }).success).toBe(false);
  });
});

describe('PasswordResetRequest', () => {
  it('accepts a string of up to 320 characters exactly', () => {
    expect(PasswordResetRequest.safeParse({ email: 'a@example.com' }).success).toBe(true);
    expect(PasswordResetRequest.safeParse({ email: 'e'.repeat(320) }).success).toBe(true);
    expect(PasswordResetRequest.safeParse({ email: 'e'.repeat(PASSWORD_RESET_EMAIL_MAX_LENGTH) }).success).toBe(true);
    expect(PasswordResetRequest.safeParse({ email: '' }).success).toBe(true);
  });
  it('refuses 321 characters', () => {
    expect(PasswordResetRequest.safeParse({ email: 'e'.repeat(321) }).success).toBe(false);
    expect(PasswordResetRequest.safeParse({ email: 'e'.repeat(PASSWORD_RESET_EMAIL_MAX_LENGTH + 1) }).success).toBe(false);
  });
  it('does not validate the address shape (the answer must not reveal whether an account exists)', () => {
    expect(PasswordResetRequest.safeParse({ email: 'not-an-email' }).success).toBe(true);
  });
  it.each([[1], [null], [undefined], [true], [['a@b.c']], [{ address: 'a@b.c' }]])('refuses a non-string email %j', (email) => {
    expect(PasswordResetRequest.safeParse({ email }).success).toBe(false);
  });
  it('refuses a missing email and extra fields', () => {
    expect(PasswordResetRequest.safeParse({}).success).toBe(false);
    expect(PasswordResetRequest.safeParse({ email: 'a@b.c', accountId: UUID_A }).success).toBe(false);
    expect(PasswordResetRequest.safeParse({ email: 'a@b.c', redirectUri: 'https://evil.example' }).success).toBe(false);
  });
});

describe('SecuritySessionIdParam / SecurityDeviceIdParam', () => {
  const cases = [
    ['SecuritySessionIdParam', SecuritySessionIdParam, 'sessionId', 'deviceId'],
    ['SecurityDeviceIdParam', SecurityDeviceIdParam, 'deviceId', 'sessionId'],
  ] as const;
  describe.each(cases)('%s', (_n, schema, field, other) => {
    it('accepts a uuid (lower case)', () => expect(schema.parse({ [field]: UUID_A })).toEqual({ [field]: UUID_A }));
    it('accepts an upper-case uuid and does not normalise it (zod uuid is case-insensitive)', () => {
      const upper = UUID_A.toUpperCase();
      expect(schema.parse({ [field]: upper })).toEqual({ [field]: upper });
    });
    it('accepts the nil and max uuids (zod 4 special-cases them)', () => {
      expect(schema.safeParse({ [field]: '00000000-0000-0000-0000-000000000000' }).success).toBe(true);
      expect(schema.safeParse({ [field]: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }).success).toBe(true);
    });
    it('refuses a uuid with an invalid version nibble', () => {
      expect(schema.safeParse({ [field]: '123e4567-e89b-02d3-a456-426614174000' }).success).toBe(false);
    });
    it.each([
      [''],
      ['abc'],
      ['123'],
      [' '],
      [` ${UUID_A}`],
      [`${UUID_A} `],
      [`${UUID_A}\n`],
      [`{${UUID_A}}`],
      [UUID_A.replaceAll('-', '')],
      [`${UUID_A}0`],
      [UUID_A.slice(0, -1)],
      [UUID_A.replace('4', 'g')],
      [`urn:uuid:${UUID_A}`],
      [1],
      [null],
      [undefined],
      [[UUID_A]],
      [{}],
    ])('refuses %j', (v) => expect(schema.safeParse({ [field]: v }).success).toBe(false));
    it('refuses a missing id, the other id name and extra keys', () => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ [other]: UUID_A }).success).toBe(false);
      expect(schema.safeParse({ [field]: UUID_A, [other]: UUID_B }).success).toBe(false);
      expect(schema.safeParse({ [field]: UUID_A, extra: 1 }).success).toBe(false);
    });
  });
});

// ====================================================================== StepUpDetails
describe('StepUpDetails', () => {
  it.each(STEP_UP_REQUIREMENTS)('accepts requirement %s', (requirement) => {
    expect(StepUpDetails.parse({ requirement, maxAgeSeconds: 900 })).toEqual({ requirement, maxAgeSeconds: 900 });
  });
  it('acrValues is optional and a string', () => {
    expect(StepUpDetails.parse({ requirement: 'MFA', maxAgeSeconds: 60, acrValues: ACR_MFA })).toEqual({
      requirement: 'MFA',
      maxAgeSeconds: 60,
      acrValues: ACR_MFA,
    });
    expect(StepUpDetails.safeParse({ requirement: 'MFA', maxAgeSeconds: 60, acrValues: 1 }).success).toBe(false);
    expect(StepUpDetails.safeParse({ requirement: 'MFA', maxAgeSeconds: 60, acrValues: null }).success).toBe(false);
  });
  it('maxAgeSeconds must be a positive integer', () => {
    expect(StepUpDetails.safeParse({ requirement: 'MFA', maxAgeSeconds: 1 }).success).toBe(true);
    for (const maxAgeSeconds of [0, -1, 1.5, '900', null, undefined, NaN, Infinity])
      expect(StepUpDetails.safeParse({ requirement: 'MFA', maxAgeSeconds }).success, String(maxAgeSeconds)).toBe(false);
  });
  it('refuses an unknown or missing requirement', () => {
    for (const requirement of ['mfa', 'PASSWORD', '', null, undefined, 1])
      expect(StepUpDetails.safeParse({ requirement, maxAgeSeconds: 60 }).success).toBe(false);
    expect(StepUpDetails.safeParse({ maxAgeSeconds: 60 }).success).toBe(false);
  });
  it('is not strict: unknown keys are stripped, never returned', () => {
    expect(StepUpDetails.parse({ requirement: 'MFA', maxAgeSeconds: 60, token: 'x' })).toEqual({ requirement: 'MFA', maxAgeSeconds: 60 });
  });
});

// ====================================================================== responses
describe('response schemas', () => {
  const cases: [string, z.ZodType, unknown][] = [
    ['SecuritySessionsResponse', SecuritySessionsResponse, { sessions: [sessionDto], reconciled: true }],
    ['SecurityDevicesResponse', SecurityDevicesResponse, { devices: [deviceDto] }],
    ['SecurityActivityResponse', SecurityActivityResponse, { entries: [activityEntry], nextBefore: null }],
    ['SecurityOverviewResponse', SecurityOverviewResponse, overviewDto],
    ['RegisteredSessionResponse', RegisteredSessionResponse, registeredSession],
    ['SessionRevokedResponse', SessionRevokedResponse, sessionRevoked],
    ['SessionsRevokedAllResponse', SessionsRevokedAllResponse, sessionsRevokedAll],
    ['SignedOutResponse', SignedOutResponse, signedOut],
    ['DeviceTrustResponse', DeviceTrustResponse, deviceTrust],
    ['DeviceRemovedResponse', DeviceRemovedResponse, deviceRemoved],
    ['MfaEnrollmentResponse', MfaEnrollmentResponse, mfaEnrollment],
    ['PasswordResetAcceptedResponse', PasswordResetAcceptedResponse, { accepted: true }],
  ];

  describe.each(cases)('%s', (_n, schema, data) => {
    it('accepts a valid example', () => expect(schema.parse(wrap(data))).toEqual(wrap(data)));
    it('requires the envelope: data and meta.correlationId', () => {
      expect(schema.safeParse(data).success).toBe(false);
      expect(schema.safeParse({ data }).success).toBe(false);
      expect(schema.safeParse({ meta: META }).success).toBe(false);
      expect(schema.safeParse({ data, meta: {} }).success).toBe(false);
      expect(schema.safeParse({ data, meta: { correlationId: 1 } }).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });
    it('strips (never returns) unknown top-level and data fields', () => {
      const out = schema.parse({ data: { ...(data as object), ip: '203.0.113.9', token: 't' }, meta: META, extra: 1 }) as Record<string, unknown>;
      expect(out).not.toHaveProperty('extra');
      expect(out.data).not.toHaveProperty('ip');
      expect(out.data).not.toHaveProperty('token');
    });
  });

  it('SecuritySessionsDto', () => {
    expect(SecuritySessionsDto.safeParse({ sessions: [], reconciled: false }).success).toBe(true);
    expect(SecuritySessionsDto.safeParse({ sessions: [] }).success).toBe(false);
    expect(SecuritySessionsDto.safeParse({ reconciled: true }).success).toBe(false);
    expect(SecuritySessionsDto.safeParse({ sessions: [{}], reconciled: true }).success).toBe(false);
    expect(SecuritySessionsDto.safeParse({ sessions: [sessionDto], reconciled: 'true' }).success).toBe(false);
  });

  describe('SecuritySessionDto', () => {
    it('accepts a valid example and the nullable fields as null', () => {
      expect(SecuritySessionDto.parse(sessionDto)).toEqual(sessionDto);
      const nulls = { ...sessionDto, device: null, deviceId: null, trusted: false, trustedUntil: null };
      expect(SecuritySessionDto.parse(nulls)).toEqual(nulls);
    });
    it.each(['device', 'deviceId', 'trustedUntil'])('%s is nullable but required (not optional)', (k) => {
      const copy: Record<string, unknown> = { ...sessionDto };
      delete copy[k];
      expect(SecuritySessionDto.safeParse(copy).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, [k]: null }).success).toBe(true);
    });
    it.each(['sessionId', 'current', 'status', 'createdAt', 'lastSeenAt', 'trusted'])('%s is required and not nullable', (k) => {
      const copy: Record<string, unknown> = { ...sessionDto };
      delete copy[k];
      expect(SecuritySessionDto.safeParse(copy).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, [k]: null }).success).toBe(false);
    });
    it('dates are strings, not Date objects or numbers', () => {
      expect(SecuritySessionDto.safeParse({ ...sessionDto, createdAt: new Date() }).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, lastSeenAt: 1_760_000_000 }).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, trustedUntil: new Date() }).success).toBe(false);
    });
    it('status is the session status vocabulary', () => {
      for (const status of SESSION_STATUSES) expect(SecuritySessionDto.safeParse({ ...sessionDto, status }).success).toBe(true);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, status: 'active' }).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, status: 'EXPIRED' }).success).toBe(false);
    });
    it('booleans are not coerced', () => {
      expect(SecuritySessionDto.safeParse({ ...sessionDto, current: 'true' }).success).toBe(false);
      expect(SecuritySessionDto.safeParse({ ...sessionDto, trusted: 1 }).success).toBe(false);
    });
    it('a Keycloak sid, a user agent and an IP are stripped, not returned', () => {
      const out = SecuritySessionDto.parse({ ...sessionDto, keycloakSessionId: 'kc', userAgent: 'UA', ip: '1.2.3.4' });
      expect(Object.keys(out).sort()).toEqual(Object.keys(sessionDto).sort());
    });
  });

  describe('DeviceSummaryDto', () => {
    it('accepts every browser/os/class combination of the vocabularies', () => {
      for (const browser of BROWSER_FAMILIES)
        for (const os of OS_FAMILIES)
          for (const deviceClass of DEVICE_CLASSES) expect(DeviceSummaryDto.safeParse({ browser, os, deviceClass }).success).toBe(true);
    });
    it('refuses a partial or free-text summary', () => {
      expect(DeviceSummaryDto.safeParse({ browser: 'CHROME', os: 'MACOS' }).success).toBe(false);
      expect(DeviceSummaryDto.safeParse({ ...device, browser: 'Chrome 120.0.1' }).success).toBe(false);
      expect(DeviceSummaryDto.safeParse({ ...device, os: 'macOS 14.2' }).success).toBe(false);
      expect(DeviceSummaryDto.safeParse(null).success).toBe(false);
    });
  });

  describe('SecurityDeviceDto / SecurityDevicesDto', () => {
    it('accepts a valid example', () => {
      expect(SecurityDeviceDto.parse(deviceDto)).toEqual(deviceDto);
      expect(SecurityDevicesDto.parse({ devices: [] })).toEqual({ devices: [] });
    });
    it('device is required and NOT nullable (a registered device always has a summary)', () => {
      expect(SecurityDeviceDto.safeParse({ ...deviceDto, device: null }).success).toBe(false);
      const copy: Record<string, unknown> = { ...deviceDto };
      delete copy.device;
      expect(SecurityDeviceDto.safeParse(copy).success).toBe(false);
    });
    it('trustedUntil is nullable; dates are strings', () => {
      expect(SecurityDeviceDto.safeParse({ ...deviceDto, trustedUntil: null }).success).toBe(true);
      expect(SecurityDeviceDto.safeParse({ ...deviceDto, firstSeenAt: new Date() }).success).toBe(false);
      expect(SecurityDeviceDto.safeParse({ ...deviceDto, firstSeenAt: null }).success).toBe(false);
    });
    it('refuses a non-array devices', () => {
      expect(SecurityDevicesDto.safeParse({ devices: deviceDto }).success).toBe(false);
      expect(SecurityDevicesDto.safeParse({}).success).toBe(false);
    });
  });

  describe('SecurityActivityEntryDto / SecurityActivityDto', () => {
    it('accepts every activity type and both outcomes', () => {
      for (const type of SECURITY_ACTIVITY_TYPES) expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, type }).success, type).toBe(true);
      for (const outcome of ['SUCCESS', 'FAILURE']) expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, outcome }).success).toBe(true);
    });
    it('refuses an audit action outside the timeline (for example a wrong verification code)', () => {
      for (const type of ['EMAIL_VERIFICATION_FAILED', 'PHONE_VERIFICATION_FAILED', 'ACCOUNT_CREATED', 'ROLE_GRANTED', 'session_created'])
        expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, type }).success, type).toBe(false);
    });
    it('refuses an unknown outcome', () => {
      for (const outcome of ['success', 'PENDING', '', null]) expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, outcome }).success).toBe(false);
    });
    it('sessionId and device are nullable but required', () => {
      expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, sessionId: null, device: null }).success).toBe(true);
      const copy: Record<string, unknown> = { ...activityEntry };
      delete copy.sessionId;
      expect(SecurityActivityEntryDto.safeParse(copy).success).toBe(false);
      expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, id: null }).success).toBe(false);
      expect(SecurityActivityEntryDto.safeParse({ ...activityEntry, labelContentKey: null }).success).toBe(false);
    });
    it('the page carries nextBefore, null at the end, a string otherwise', () => {
      expect(SecurityActivityDto.safeParse({ entries: [], nextBefore: null }).success).toBe(true);
      expect(SecurityActivityDto.safeParse({ entries: [activityEntry], nextBefore: 'cursor' }).success).toBe(true);
      expect(SecurityActivityDto.safeParse({ entries: [] }).success).toBe(false);
      expect(SecurityActivityDto.safeParse({ entries: [], nextBefore: 1 }).success).toBe(false);
    });
  });

  describe('SecurityOverviewDto / SecurityPolicyDto', () => {
    it('accepts a valid example', () => expect(SecurityOverviewDto.parse(overviewDto)).toEqual(overviewDto));
    it('nullable timestamps accept null', () => {
      const o = {
        ...overviewDto,
        stepUp: { authenticatedAt: null, mfaSatisfied: false, recentUntil: null },
        currentSession: { sessionId: UUID_A, deviceId: null, deviceTrusted: false, trustedUntil: null },
      };
      expect(SecurityOverviewDto.parse(o)).toEqual(o);
    });
    it('every block is required', () => {
      for (const k of ['mfa', 'stepUp', 'currentSession', 'policy']) {
        const copy: Record<string, unknown> = { ...overviewDto };
        delete copy[k];
        expect(SecurityOverviewDto.safeParse(copy).success, k).toBe(false);
      }
    });
    it('the mfa flags are booleans', () => {
      expect(SecurityOverviewDto.safeParse({ ...overviewDto, mfa: { ...overviewDto.mfa, available: 'yes' } }).success).toBe(false);
      expect(SecurityOverviewDto.safeParse({ ...overviewDto, mfa: { available: true, totpConfigured: true } }).success).toBe(false);
    });
    it('policy values are integers', () => {
      expect(SecurityPolicyDto.safeParse({ trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 }).success).toBe(true);
      expect(SecurityPolicyDto.safeParse({ trustedBrowserDays: 30.5, stepUpValidMinutes: 15, activityLogDays: 90 }).success).toBe(false);
      expect(SecurityPolicyDto.safeParse({ trustedBrowserDays: '30', stepUpValidMinutes: 15, activityLogDays: 90 }).success).toBe(false);
      expect(SecurityPolicyDto.safeParse({ trustedBrowserDays: 30, stepUpValidMinutes: 15 }).success).toBe(false);
    });
  });

  describe('operation results', () => {
    it('RegisteredSessionDto', () => {
      expect(RegisteredSessionDto.parse(registeredSession)).toEqual(registeredSession);
      expect(RegisteredSessionDto.safeParse({ ...registeredSession, deviceTrusted: 'false' }).success).toBe(false);
      expect(RegisteredSessionDto.safeParse({ sessionId: UUID_A }).success).toBe(false);
    });
    it('SessionRevokedDto accepts every propagation outcome and refuses others', () => {
      for (const keycloak of KEYCLOAK_PROPAGATION_OUTCOMES) expect(SessionRevokedDto.safeParse({ ...sessionRevoked, keycloak }).success).toBe(true);
      for (const keycloak of ['ended', 'FAILED', null, true]) expect(SessionRevokedDto.safeParse({ ...sessionRevoked, keycloak }).success).toBe(false);
    });
    it('SessionsRevokedAllDto: revokedCount is an integer', () => {
      expect(SessionsRevokedAllDto.safeParse({ revokedCount: 0, keycloak: 'ENDED' }).success).toBe(true);
      expect(SessionsRevokedAllDto.safeParse({ revokedCount: 1.5, keycloak: 'ENDED' }).success).toBe(false);
      expect(SessionsRevokedAllDto.safeParse({ revokedCount: '3', keycloak: 'ENDED' }).success).toBe(false);
    });
    it('SignedOutDto', () => {
      expect(SignedOutDto.parse(signedOut)).toEqual(signedOut);
      expect(SignedOutDto.safeParse({ changed: true }).success).toBe(false);
    });
    it('DeviceTrustDto', () => {
      expect(DeviceTrustDto.parse(deviceTrust)).toEqual(deviceTrust);
      expect(DeviceTrustDto.safeParse({ ...deviceTrust, trustedUntil: null, trusted: false }).success).toBe(true);
      expect(DeviceTrustDto.safeParse({ deviceId: UUID_B, trusted: true }).success).toBe(false);
    });
    it('DeviceRemovedDto', () => {
      expect(DeviceRemovedDto.parse(deviceRemoved)).toEqual(deviceRemoved);
      expect(DeviceRemovedDto.safeParse({ ...deviceRemoved, sessionsRevoked: 1.2 }).success).toBe(false);
      expect(DeviceRemovedDto.safeParse({ ...deviceRemoved, keycloak: 'X' }).success).toBe(false);
    });
    it('MfaEnrollmentDto carries the method and the kc_action, nothing secret', () => {
      for (const method of MFA_METHODS) {
        const dto = { method, keycloakAction: KEYCLOAK_ACTION_OF_METHOD[method] };
        expect(MfaEnrollmentDto.parse(dto)).toEqual(dto);
      }
      expect(MfaEnrollmentDto.safeParse({ method: 'totp', keycloakAction: 'CONFIGURE_TOTP' }).success).toBe(false);
      expect(MfaEnrollmentDto.safeParse({ method: 'TOTP' }).success).toBe(false);
      expect(Object.keys(MfaEnrollmentDto.parse({ ...mfaEnrollment, secret: 'JBSWY3DP' })).sort()).toEqual(['keycloakAction', 'method']);
    });
    it('PasswordResetAcceptedDto is exactly { accepted: true }', () => {
      expect(PasswordResetAcceptedDto.parse({ accepted: true })).toEqual({ accepted: true });
      for (const accepted of [false, 'true', 1, null, undefined]) expect(PasswordResetAcceptedDto.safeParse({ accepted }).success).toBe(false);
      expect(PasswordResetAcceptedDto.parse({ accepted: true, exists: true })).toEqual({ accepted: true });
    });
  });
});

// ====================================================================== events
describe('SECURITY_EVENTS', () => {
  it('names (exact, in order)', () => {
    expect(SECURITY_EVENTS).toEqual({
      sessionCreated: 'bananagig.identity.session-created.v1',
      sessionRevoked: 'bananagig.identity.session-revoked.v1',
      sessionsRevokedAll: 'bananagig.identity.sessions-revoked-all.v1',
      mfaEnabled: 'bananagig.identity.mfa-enabled.v1',
      mfaDisabled: 'bananagig.identity.mfa-disabled.v1',
      passwordResetRequested: 'bananagig.identity.password-reset-requested.v1',
      passwordResetCompleted: 'bananagig.identity.password-reset-completed.v1',
    });
    expect(Object.keys(SECURITY_EVENTS)).toEqual([
      'sessionCreated',
      'sessionRevoked',
      'sessionsRevokedAll',
      'mfaEnabled',
      'mfaDisabled',
      'passwordResetRequested',
      'passwordResetCompleted',
    ]);
  });
  it('every name is bananagig.identity.<kebab>.v1, unique, and matches the platform event pattern', () => {
    const names = Object.values(SECURITY_EVENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^bananagig\.identity\.[a-z]+(-[a-z]+)*\.v1$/);
      expect(EVENT_TYPE_PATTERN.test(n), n).toBe(true);
    }
  });
  it('each key is the camelCase of its kebab name', () => {
    for (const [key, name] of Object.entries(SECURITY_EVENTS)) {
      const kebab = /^bananagig\.identity\.(.+)\.v1$/.exec(name)?.[1] ?? '';
      const camel = kebab.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(key).toBe(camel);
    }
  });
});

describe('event payloads', () => {
  const payloads: [string, z.ZodType, unknown][] = [
    ['SessionCreatedPayload', SessionCreatedPayload, { accountId: UUID_A, applicationSessionId: UUID_B, accountDeviceId: null }],
    ['SessionRevokedPayload', SessionRevokedPayload, { accountId: UUID_A, applicationSessionId: UUID_B, reason: 'PASSWORD_CHANGED' }],
    ['SessionsRevokedAllPayload', SessionsRevokedAllPayload, { accountId: UUID_A, revokedCount: 4, includeCurrent: false }],
    ['MfaChangedPayload', MfaChangedPayload, { accountId: UUID_A, method: 'RECOVERY_CODES' }],
    ['PasswordResetRequestedPayload', PasswordResetRequestedPayload, { accountId: UUID_A }],
    ['PasswordResetCompletedPayload', PasswordResetCompletedPayload, { accountId: UUID_A }],
  ];
  const FORBIDDEN = /email|phone|ip|token|secret|code|sid|useragent|user_agent|subject|password|hash|address|keycloak/i;
  // Allowed payload keys are listed explicitly: identifiers, the revocation reason, a count, a flag and the MFA method.
  const ALLOWED_PAYLOAD_KEYS = new Set(['accountId', 'applicationSessionId', 'accountDeviceId', 'reason', 'revokedCount', 'includeCurrent', 'method']);

  describe.each(payloads)('%s', (_n, schema, example) => {
    it('accepts a valid example', () => expect(schema.parse(example)).toEqual(example));
    it('carries identifiers only: every key is on the explicit allowlist and none looks sensitive', () => {
      for (const e of walk(schema)) {
        expect(ALLOWED_PAYLOAD_KEYS.has(e.key), e.path).toBe(true);
        expect(FORBIDDEN.test(e.key), e.path).toBe(false);
      }
    });
    it('strips sensitive extras instead of returning them', () => {
      const out = schema.parse({ ...(example as object), email: 'a@b.c', ip: '1.2.3.4', token: 't', sid: 's', userAgent: 'UA', subject: 'sub' });
      expect(out).toEqual(example);
    });
    it('requires accountId', () => {
      const copy: Record<string, unknown> = { ...(example as object) };
      delete copy.accountId;
      expect(schema.safeParse(copy).success).toBe(false);
    });
  });

  it('SessionCreatedPayload: accountDeviceId is nullable but required', () => {
    expect(SessionCreatedPayload.safeParse({ accountId: UUID_A, applicationSessionId: UUID_B }).success).toBe(false);
    expect(SessionCreatedPayload.safeParse({ accountId: UUID_A, applicationSessionId: UUID_B, accountDeviceId: UUID_A }).success).toBe(true);
    expect(SessionCreatedPayload.safeParse({ accountId: UUID_A, applicationSessionId: null, accountDeviceId: null }).success).toBe(false);
  });
  it('SessionRevokedPayload.reason is the revocation vocabulary', () => {
    for (const reason of SESSION_REVOCATION_REASONS)
      expect(SessionRevokedPayload.safeParse({ accountId: UUID_A, applicationSessionId: UUID_B, reason }).success).toBe(true);
    for (const reason of [null, 'ACTIVE', 'sign_out', undefined])
      expect(SessionRevokedPayload.safeParse({ accountId: UUID_A, applicationSessionId: UUID_B, reason }).success).toBe(false);
  });
  it('SessionsRevokedAllPayload: integer count and boolean includeCurrent', () => {
    expect(SessionsRevokedAllPayload.safeParse({ accountId: UUID_A, revokedCount: 1.5, includeCurrent: true }).success).toBe(false);
    expect(SessionsRevokedAllPayload.safeParse({ accountId: UUID_A, revokedCount: 1, includeCurrent: 'true' }).success).toBe(false);
    expect(SessionsRevokedAllPayload.safeParse({ accountId: UUID_A, revokedCount: 1 }).success).toBe(false);
  });
  it('MfaChangedPayload.method is an MFA method', () => {
    for (const method of MFA_METHODS) expect(MfaChangedPayload.safeParse({ accountId: UUID_A, method }).success).toBe(true);
    expect(MfaChangedPayload.safeParse({ accountId: UUID_A, method: 'SMS' }).success).toBe(false);
  });
  it('the password payloads are the account id and nothing else', () => {
    expect(keysOf(PasswordResetRequestedPayload)).toEqual(['accountId']);
    expect(keysOf(PasswordResetCompletedPayload)).toEqual(['accountId']);
  });
});

// ====================================================================== privacy walk over every read model / result
describe('privacy: no read model can carry an address, a secret or a protocol identifier', () => {
  const dtos: [string, z.ZodType][] = [
    ['SecuritySessionDto', SecuritySessionDto],
    ['SecuritySessionsDto', SecuritySessionsDto],
    ['SecurityDeviceDto', SecurityDeviceDto],
    ['SecurityDevicesDto', SecurityDevicesDto],
    ['DeviceSummaryDto', DeviceSummaryDto],
    ['SecurityActivityEntryDto', SecurityActivityEntryDto],
    ['SecurityActivityDto', SecurityActivityDto],
    ['SecurityOverviewDto', SecurityOverviewDto],
    ['SecurityPolicyDto', SecurityPolicyDto],
    ['RegisteredSessionDto', RegisteredSessionDto],
    ['SessionRevokedDto', SessionRevokedDto],
    ['SessionsRevokedAllDto', SessionsRevokedAllDto],
    ['SignedOutDto', SignedOutDto],
    ['DeviceTrustDto', DeviceTrustDto],
    ['DeviceRemovedDto', DeviceRemovedDto],
    ['MfaEnrollmentDto', MfaEnrollmentDto],
    ['PasswordResetAcceptedDto', PasswordResetAcceptedDto],
    ['SecuritySessionsResponse', SecuritySessionsResponse],
    ['SecurityDevicesResponse', SecurityDevicesResponse],
    ['SecurityActivityResponse', SecurityActivityResponse],
    ['SecurityOverviewResponse', SecurityOverviewResponse],
    ['RegisteredSessionResponse', RegisteredSessionResponse],
    ['SessionRevokedResponse', SessionRevokedResponse],
    ['SessionsRevokedAllResponse', SessionsRevokedAllResponse],
    ['SignedOutResponse', SignedOutResponse],
    ['DeviceTrustResponse', DeviceTrustResponse],
    ['DeviceRemovedResponse', DeviceRemovedResponse],
    ['MfaEnrollmentResponse', MfaEnrollmentResponse],
    ['PasswordResetAcceptedResponse', PasswordResetAcceptedResponse],
  ];
  const SENSITIVE = /ip|address|token|secret|hash|sid|keycloak|useragent|user_agent|email|phone|subject|password|code/i;
  // Explicit allowlist (key => why it is safe). A key not on this list that matches SENSITIVE fails the test.
  const ALLOWED: Record<string, string> = {
    // "code" substring
    recoveryCodesConfigured: 'a boolean status flag; the recovery codes themselves are never returned',
    // "keycloak" substring
    keycloak: 'the propagation OUTCOME enum (ENDED | UNAVAILABLE | NOT_NEEDED), not a Keycloak id or token',
    keycloakAction: 'the kc_action NAME (CONFIGURE_TOTP ...), a public constant, not a credential',
  };

  it('the sensitive-word regex really bites (sanity check on the walker)', () => {
    for (const k of [
      'ip',
      'ipAddress',
      'userAgent',
      'accessToken',
      'secretKey',
      'deviceHash',
      'sid',
      'keycloakSessionId',
      'email',
      'phone',
      'subject',
      'passwordHash',
      'code',
    ])
      expect(SENSITIVE.test(k), k).toBe(true);
  });

  it('walks every DTO and finds keys', () => {
    for (const [n, s] of dtos) expect(walk(s).length, n).toBeGreaterThan(0);
  });

  it.each(dtos)('%s has no sensitive key outside the allowlist', (_n, schema) => {
    for (const e of walk(schema)) {
      if (SENSITIVE.test(e.key)) expect(ALLOWED[e.key], `${e.path} matches the sensitive-word list and is not allowlisted`).toBeDefined();
    }
  });

  it('every allowlisted key is actually used (the allowlist cannot rot)', () => {
    const used = new Set(dtos.flatMap(([, s]) => keysOf(s)));
    for (const k of Object.keys(ALLOWED)) expect(used.has(k), k).toBe(true);
  });

  it('the allowlisted keys have the expected, harmless types', () => {
    const entries = dtos.flatMap(([, s]) => walk(s));
    for (const e of entries.filter((x) => x.key === 'keycloak')) expect(e.type).toBe('enum');
    for (const e of entries.filter((x) => x.key === 'keycloakAction')) expect(e.type).toBe('string');
    for (const e of entries.filter((x) => x.key === 'recoveryCodesConfigured')) expect(e.type).toBe('boolean');
  });

  it('no session read model exposes the Keycloak session id or the device secret', () => {
    for (const s of [SecuritySessionDto, SecurityDeviceDto, SecurityOverviewDto, RegisteredSessionDto, SecurityActivityEntryDto]) {
      const keys = keysOf(s).map((k) => k.toLowerCase());
      for (const bad of ['sid', 'keycloaksessionid', 'device_secret', 'devicesecret', 'secret', 'devicehash', 'ip', 'ipaddress', 'useragent', 'rawuseragent'])
        expect(keys, bad).not.toContain(bad);
    }
  });

  it('request bodies: the only free-text fields are the device secret, the user agent and the reset email', () => {
    expect(Object.keys(defOf(RegisterSessionRequest).shape ?? {}).sort()).toEqual(['device', 'userAgent']);
    expect(Object.keys(defOf(PasswordResetRequest).shape ?? {})).toEqual(['email']);
    expect(Object.keys(defOf(RevokeAllSessionsRequest).shape ?? {})).toEqual(['includeCurrent']);
    expect(Object.keys(defOf(StartMfaEnrollmentRequest).shape ?? {})).toEqual(['method']);
  });

  it('every request schema is strict (catchall never)', () => {
    for (const s of [
      RegisterSessionRequest,
      RevokeAllSessionsRequest,
      StartMfaEnrollmentRequest,
      PasswordResetRequest,
      SecuritySessionIdParam,
      SecurityDeviceIdParam,
    ])
      expect(defOf(s).catchall?.def.type).toBe('never');
  });
});
