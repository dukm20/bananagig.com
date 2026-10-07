// Unit tests of the account contracts (ID-001): the status machine, role vocabulary and bootstrap mapping, the profile name rules, the public display
// name, the request and read-model schemas, the identity events and the error codes. Escapes of special characters are built with String.fromCodePoint
// so no source line holds an irregular character.
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ERROR_CODES,
  ACCOUNT_ROLE_STATUSES,
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_TRANSITIONS,
  ACTIVE_ROLE_HEADER,
  APPLICATION_ROLE_CODES,
  AccountCreatedPayload,
  AccountDto,
  AccountResponse,
  AccountRolePayload,
  AccountStatus,
  AccountStatusChangedPayload,
  BOOTSTRAP_ROLE_BY_IDENTITY_ROLE,
  ExternalIdentityLinkedPayload,
  IDENTITY_EVENTS,
  IDENTITY_PROVIDER_TYPES,
  PROFILE_ISSUE_CODES,
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
  ROLE_GRANT_SOURCES,
  RoleCode,
  SetActiveRoleRequest,
  UpdateProfileRequest,
  accountStatusLabelKey,
  isAccountStatusTransitionAllowed,
  isAccountUsable,
  normalizeProfileName,
  profileIssueMessageKey,
  publicDisplayName,
  validateProfileName,
  type AccountStatus as AccountStatusType,
} from './account';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN, EventEnvelope } from './index';
import { containsForbiddenText } from './text';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const WORD_JOINER = cp(0x2060);
const MONGOLIAN_VOWEL_SEPARATOR = cp(0x180e);
const BOM = cp(0xfeff);
const ZWJ = cp(0x200d);
const NBSP = cp(0xa0);
const COMBINING_ACUTE = cp(0x301);
const RLO = cp(0x202e);
const LRE = cp(0x202a);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const GRIN = cp(0x1f600);
const NEL = cp(0x85);
const codePointLength = (s: string): number => [...s].length;

// ====================================================================== status machine
const ALLOWED_TRANSITIONS = new Set([
  'PENDING>ACTIVE',
  'PENDING>CLOSED',
  'ACTIVE>SUSPENDED',
  'ACTIVE>CLOSURE_REQUESTED',
  'SUSPENDED>ACTIVE',
  'SUSPENDED>CLOSURE_REQUESTED',
  'SUSPENDED>CLOSED',
  'CLOSURE_REQUESTED>ACTIVE',
  'CLOSURE_REQUESTED>CLOSED',
]);
const ALL_PAIRS = ACCOUNT_STATUSES.flatMap((from) => ACCOUNT_STATUSES.map((to) => [from, to] as const));

describe('account statuses', () => {
  it('lists the five statuses in lifecycle order', () => {
    expect([...ACCOUNT_STATUSES]).toEqual(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED']);
    expect(AccountStatus.options).toEqual([...ACCOUNT_STATUSES]);
  });
  it('accepts exactly the listed statuses', () => {
    for (const s of ACCOUNT_STATUSES) expect(AccountStatus.safeParse(s).success).toBe(true);
    for (const s of ['active', 'Active', 'DELETED', 'CLOSED ', '', null, 1, undefined]) expect(AccountStatus.safeParse(s).success, String(s)).toBe(false);
  });
  it('has the membership statuses, grant sources and provider types the schema uses', () => {
    expect([...ACCOUNT_ROLE_STATUSES]).toEqual(['PENDING', 'ACTIVE', 'INACTIVE']);
    expect([...ROLE_GRANT_SOURCES]).toEqual(['BOOTSTRAP', 'SIGNUP', 'ADMIN', 'SYSTEM']);
    expect([...IDENTITY_PROVIDER_TYPES]).toEqual(['KEYCLOAK']);
  });
});

describe('account status transition table', () => {
  it('has exactly 9 allowed transitions out of 25 ordered pairs', () => {
    expect(ALL_PAIRS).toHaveLength(25);
    expect(ALL_PAIRS.filter(([from, to]) => isAccountStatusTransitionAllowed(from, to))).toHaveLength(ALLOWED_TRANSITIONS.size);
  });
  it.each(ALL_PAIRS)('%s -> %s', (from, to) => {
    expect(isAccountStatusTransitionAllowed(from, to)).toBe(ALLOWED_TRANSITIONS.has(`${from}>${to}`));
  });
  it('allows every documented transition', () => {
    for (const pair of ALLOWED_TRANSITIONS) {
      const [from, to] = pair.split('>') as [AccountStatusType, AccountStatusType];
      expect(isAccountStatusTransitionAllowed(from, to), pair).toBe(true);
    }
  });
  it('never allows a status to transition to itself (an unchanged status is a no-op, not a transition)', () => {
    for (const s of ACCOUNT_STATUSES) expect(isAccountStatusTransitionAllowed(s, s), s).toBe(false);
  });
  it('treats CLOSED as terminal: nothing leaves it', () => {
    expect(ACCOUNT_STATUS_TRANSITIONS.CLOSED).toEqual([]);
    for (const to of ACCOUNT_STATUSES) expect(isAccountStatusTransitionAllowed('CLOSED', to), `CLOSED -> ${to}`).toBe(false);
  });
  it('never goes back to PENDING and only PENDING can reach CLOSED without a prior hold', () => {
    for (const from of ACCOUNT_STATUSES) expect(isAccountStatusTransitionAllowed(from, 'PENDING'), `${from} -> PENDING`).toBe(false);
    expect(isAccountStatusTransitionAllowed('ACTIVE', 'CLOSED')).toBe(false);
  });
  it('covers every status as a key and only names known statuses', () => {
    expect(Object.keys(ACCOUNT_STATUS_TRANSITIONS).sort()).toEqual([...ACCOUNT_STATUSES].sort());
    for (const targets of Object.values(ACCOUNT_STATUS_TRANSITIONS)) for (const t of targets) expect(ACCOUNT_STATUSES).toContain(t);
  });
});

describe('isAccountUsable', () => {
  it.each([
    ['PENDING', true],
    ['ACTIVE', true],
    ['SUSPENDED', false],
    ['CLOSURE_REQUESTED', true],
    ['CLOSED', false],
  ] as const)('%s -> %s', (status, usable) => {
    expect(isAccountUsable(status)).toBe(usable);
  });
});

describe('accountStatusLabelKey and profileIssueMessageKey', () => {
  it('derives the managed content key of every status', () => {
    expect(ACCOUNT_STATUSES.map(accountStatusLabelKey)).toEqual([
      'account.status.pending',
      'account.status.active',
      'account.status.suspended',
      'account.status.closure_requested',
      'account.status.closed',
    ]);
  });
  it('derives the managed content key of every name issue', () => {
    expect(PROFILE_ISSUE_CODES.map(profileIssueMessageKey)).toEqual([
      'account.error.name_required',
      'account.error.name_too_long',
      'account.error.name_invalid_characters',
    ]);
  });
  it('produces keys that are valid content keys', () => {
    for (const s of ACCOUNT_STATUSES) expect(ContentKey.safeParse(accountStatusLabelKey(s)).success, s).toBe(true);
    for (const c of PROFILE_ISSUE_CODES) expect(ContentKey.safeParse(profileIssueMessageKey(c)).success, c).toBe(true);
  });
});

// ====================================================================== roles
describe('RoleCode', () => {
  it.each(['CUSTOMER', 'PROVIDER', 'AB', 'A1', 'A_B', 'A0_9', `A${'B'.repeat(29)}`])('accepts %s', (code) => {
    expect(RoleCode.safeParse(code).success).toBe(true);
  });
  it.each([
    ['a single character', 'A'],
    ['31 characters', `A${'B'.repeat(30)}`],
    ['lower case', 'customer'],
    ['mixed case', 'Customer'],
    ['a leading digit', '1ABC'],
    ['a leading underscore', '_ABC'],
    ['a hyphen', 'ABC-D'],
    ['a space', 'ABC D'],
    ['surrounding space', ' CUSTOMER'],
    ['a trailing newline', 'CUSTOMER\n'],
    ['an accented letter', 'CUSTOMER' + cp(0xd6)],
    ['an empty string', ''],
    ['SQL text', 'A; DROP TABLE x'],
  ])('rejects %s', (_label, code) => {
    expect(RoleCode.safeParse(code).success).toBe(false);
  });
  it.each([1, true, null, undefined, ['CUSTOMER'], { code: 'CUSTOMER' }])('rejects the non-string %j', (value) => {
    expect(RoleCode.safeParse(value).success).toBe(false);
  });
  it('accepts the seeded application role codes', () => {
    expect(APPLICATION_ROLE_CODES).toEqual({ customer: 'CUSTOMER', provider: 'PROVIDER' });
    for (const code of Object.values(APPLICATION_ROLE_CODES)) expect(RoleCode.safeParse(code).success, code).toBe(true);
  });
});

describe('BOOTSTRAP_ROLE_BY_IDENTITY_ROLE', () => {
  it('maps the Keycloak realm roles customer and provider to the application roles, in that order', () => {
    expect(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE).toEqual({ customer: 'CUSTOMER', provider: 'PROVIDER' });
    expect(Object.keys(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE)).toEqual(['customer', 'provider']);
  });
  it('maps to valid role codes only and never to an administrative role', () => {
    for (const code of Object.values(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE)) {
      expect(RoleCode.safeParse(code).success, code).toBe(true);
      expect(Object.values(APPLICATION_ROLE_CODES)).toContain(code);
    }
    for (const adminLike of ['admin', 'ADMIN', 'administrator', 'admin-console-access']) {
      expect(Object.keys(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE)).not.toContain(adminLike);
      expect(Object.values(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE)).not.toContain(adminLike);
    }
  });
});

describe('ACTIVE_ROLE_HEADER', () => {
  it('is the lower-case x-active-role header (Node lower-cases incoming header names)', () => {
    expect(ACTIVE_ROLE_HEADER).toBe('x-active-role');
    expect(ACTIVE_ROLE_HEADER).toBe(ACTIVE_ROLE_HEADER.toLowerCase());
  });
});

// ====================================================================== name rules
describe('profile name bounds', () => {
  it('are the structural constraints 1 and 50', () => {
    expect(PROFILE_NAME_MIN).toBe(1);
    expect(PROFILE_NAME_MAX).toBe(50);
    expect([...PROFILE_ISSUE_CODES]).toEqual(['REQUIRED', 'TOO_LONG', 'INVALID_CHARACTERS']);
  });
});

describe('validateProfileName: accepted names', () => {
  it('accepts a plain name and returns it', () => {
    expect(validateProfileName('Ana')).toEqual({ ok: true, value: 'Ana' });
  });
  it('accepts a single character (1 code point)', () => {
    expect(validateProfileName('A')).toEqual({ ok: true, value: 'A' });
    expect(validateProfileName(GRIN)).toEqual({ ok: true, value: GRIN });
  });
  it('accepts exactly 50 characters and rejects 51 with TOO_LONG', () => {
    expect(validateProfileName('a'.repeat(50))).toEqual({ ok: true, value: 'a'.repeat(50) });
    expect(validateProfileName('a'.repeat(51))).toEqual({ ok: false, code: 'TOO_LONG' });
  });
  it('counts code points, not UTF-16 units: 50 emoji (100 units) pass, 51 do not', () => {
    const fifty = GRIN.repeat(50);
    expect(fifty.length).toBe(100);
    expect(validateProfileName(fifty)).toEqual({ ok: true, value: fifty });
    expect(validateProfileName(GRIN.repeat(51))).toEqual({ ok: false, code: 'TOO_LONG' });
  });
  it('counts a combining mark that has no precomposed form as its own code point', () => {
    const decomposed = `x${COMBINING_ACUTE}`; // no precomposed x-acute exists: stays 2 code points after NFC
    expect(codePointLength(normalizeProfileName(decomposed))).toBe(2);
    expect(validateProfileName(decomposed.repeat(25)).ok).toBe(true);
    expect(validateProfileName(decomposed.repeat(26))).toEqual({ ok: false, code: 'TOO_LONG' });
  });
  it('composes a decomposed letter to NFC before counting: 50 e + combining acute is 50 characters', () => {
    const decomposed = `e${COMBINING_ACUTE}`.repeat(50);
    expect(codePointLength(decomposed)).toBe(100);
    expect(validateProfileName(decomposed)).toEqual({ ok: true, value: cp(0xe9).repeat(50) });
  });
  it('normalizes to NFC so equivalent spellings are one value', () => {
    const decomposed = validateProfileName(`Jose${COMBINING_ACUTE}`);
    const composed = validateProfileName(`Jos${cp(0xe9)}`);
    expect(decomposed).toEqual(composed);
    expect(decomposed).toEqual({ ok: true, value: `Jos${cp(0xe9)}` });
  });
  it('trims and collapses whitespace', () => {
    expect(validateProfileName('  Ana  ')).toEqual({ ok: true, value: 'Ana' });
    expect(validateProfileName('Ana    Maria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName(`${NBSP}Ana${NBSP}${NBSP}Maria${NBSP}`)).toEqual({ ok: true, value: 'Ana Maria' });
  });
  it('trims before counting: 50 characters padded with spaces is still 50', () => {
    expect(validateProfileName(` ${'a'.repeat(50)} `)).toEqual({ ok: true, value: 'a'.repeat(50) });
    expect(validateProfileName(`${'a'.repeat(24)}${' '.repeat(40)}${'a'.repeat(25)}`)).toEqual({ ok: true, value: `${'a'.repeat(24)} ${'a'.repeat(25)}` });
  });
  it('turns tabs and line breaks into single spaces instead of rejecting them', () => {
    expect(validateProfileName('Ana\tMaria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName('Ana\nMaria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName('Ana\r\nMaria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName('Ana\n\n\t\tMaria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName('Ana\v\fMaria')).toEqual({ ok: true, value: 'Ana Maria' });
    expect(validateProfileName('\t\nAna\r\n ')).toEqual({ ok: true, value: 'Ana' });
  });
  it('removes invisible characters inside a name', () => {
    expect(validateProfileName(`An${ZWSP}a`)).toEqual({ ok: true, value: 'Ana' });
    expect(validateProfileName(`A${WORD_JOINER}n${MONGOLIAN_VOWEL_SEPARATOR}a${BOM}`)).toEqual({ ok: true, value: 'Ana' });
  });
  it('keeps zero-width joiners (they build emoji sequences and some scripts)', () => {
    const family = `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}${ZWJ}${cp(0x1f467)}`;
    expect(validateProfileName(family)).toEqual({ ok: true, value: family });
    expect(codePointLength(family)).toBe(5);
  });
  it('accepts non-Latin names', () => {
    expect(validateProfileName(cp(0x674e, 0x660e))).toEqual({ ok: true, value: cp(0x674e, 0x660e) });
    expect(validateProfileName(`O${cp(0x2019)}Brien`)).toEqual({ ok: true, value: `O${cp(0x2019)}Brien` });
  });
  it('accepts a well-formed surrogate pair', () => {
    expect(validateProfileName(`a${GRIN}b`).ok).toBe(true);
  });
});

describe('validateProfileName: REQUIRED', () => {
  it.each([
    ['empty', ''],
    ['spaces', '    '],
    ['a tab and a newline', '\t\n'],
    ['non-breaking spaces', `${NBSP}${NBSP}`],
    ['zero-width space only', ZWSP],
    ['several zero-width characters', `${ZWSP}${WORD_JOINER}${MONGOLIAN_VOWEL_SEPARATOR}${BOM}`],
    ['spaces and zero-width characters', ` ${ZWSP} ${BOM} `],
  ])('rejects %s', (_label, raw) => {
    expect(validateProfileName(raw)).toEqual({ ok: false, code: 'REQUIRED' });
  });
  it.each([undefined, null, 0, 5, true, {}, [], ['Ana'], () => 'Ana', Symbol('x')])('rejects a non-string value (%s) as REQUIRED', (raw) => {
    expect(validateProfileName(raw)).toEqual({ ok: false, code: 'REQUIRED' });
  });
});

describe('validateProfileName: INVALID_CHARACTERS', () => {
  const nul = cp(0);
  it.each([
    ['NUL', `Ana${nul}`],
    ['BEL', `A${cp(7)}na`],
    ['ESC', `A${cp(0x1b)}na`],
    ['DEL', `Ana${cp(0x7f)}`],
    ['a C1 control (NEL)', `Ana${NEL}`],
    ['another C1 control', `${cp(0x9f)}Ana`],
    ['right-to-left override', `Ana${RLO}`],
    ['left-to-right embedding', `${LRE}Ana`],
    ['left-to-right isolate', `Ana${LRI}Maria`],
    ['pop directional isolate', `Ana${PDI}`],
    ['a lone high surrogate', `Ana${HIGH_SURROGATE}`],
    ['a lone low surrogate', `${LOW_SURROGATE}Ana`],
    ['a reversed surrogate pair', `${LOW_SURROGATE}${HIGH_SURROGATE}`],
  ])('rejects %s', (_label, raw) => {
    expect(validateProfileName(raw)).toEqual({ ok: false, code: 'INVALID_CHARACTERS' });
  });
  it('reports forbidden characters before length, so a long value with a control character is INVALID_CHARACTERS', () => {
    expect(validateProfileName(`${'a'.repeat(100)}${nul}`)).toEqual({ ok: false, code: 'INVALID_CHARACTERS' });
  });
  it('does not let whitespace conversion hide a control character that is not whitespace', () => {
    expect(validateProfileName(`Ana\t${nul}\tMaria`)).toEqual({ ok: false, code: 'INVALID_CHARACTERS' });
  });
  it('reports a blank name made only of tabs and zero-width characters as REQUIRED, not INVALID_CHARACTERS', () => {
    expect(validateProfileName(`\t${ZWSP}\n`)).toEqual({ ok: false, code: 'REQUIRED' });
  });
});

describe('validateProfileName: never returns the rejected value', () => {
  const rejected: unknown[] = [
    '',
    '   ',
    ZWSP,
    'SecretFirstName'.repeat(10),
    `SecretFirstName${cp(0)}`,
    `SecretFirstName${RLO}`,
    `SecretFirstName${HIGH_SURROGATE}`,
    { secret: 'SecretFirstName' },
    ['SecretFirstName'],
    undefined,
    null,
  ];
  it.each(rejected.map((raw, i) => [i, raw] as const))(
    'rejected input #%s yields exactly { ok: false, code } and nothing derived from the input',
    (_i, raw) => {
      const result = validateProfileName(raw);
      expect(result.ok).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
      expect(JSON.stringify(result)).not.toContain('Secret');
      expect(PROFILE_ISSUE_CODES).toContain((result as { code: string }).code);
    },
  );
});

describe('normalizeProfileName', () => {
  it('applies NFC, whitespace collapsing, invisible removal and trimming', () => {
    expect(normalizeProfileName(`  Jose${COMBINING_ACUTE}\t${ZWSP}\n Maria  `)).toBe(`Jos${cp(0xe9)} Maria`);
  });
  it('is idempotent', () => {
    const once = normalizeProfileName(`  A\t${ZWSP}b  c${COMBINING_ACUTE} `);
    expect(normalizeProfileName(once)).toBe(once);
  });
  it('turns an all-blank value into the empty string', () => {
    expect(normalizeProfileName(` \t${ZWSP}\n`)).toBe('');
  });
});

// ====================================================================== public display
describe('publicDisplayName', () => {
  it('is the first name and the upper-cased initial of the last name with a period', () => {
    expect(publicDisplayName('Ana', 'Martinez')).toBe('Ana M.');
    expect(publicDisplayName('Ana', 'martinez')).toBe('Ana M.');
  });
  it('uses the first character of a single-word last name', () => {
    expect(publicDisplayName('Madonna', 'Cher')).toBe('Madonna C.');
  });
  it('uses the first character of a multi-word last name', () => {
    expect(publicDisplayName('Ana', 'de la Cruz')).toBe('Ana D.');
  });
  it('upper-cases an accented initial', () => {
    expect(publicDisplayName('Ana', `${cp(0xc9)}lodie`)).toBe(`Ana ${cp(0xc9)}.`);
    expect(publicDisplayName('Ana', `${cp(0xe9)}lodie`)).toBe(`Ana ${cp(0xc9)}.`);
  });
  it('composes a decomposed initial first, so the accent is not dropped', () => {
    expect(publicDisplayName('Ana', `e${COMBINING_ACUTE}lodie`)).toBe(`Ana ${cp(0xc9)}.`);
  });
  it('takes a surrogate-pair initial as ONE code point and never splits it', () => {
    const deseretSmall = cp(0x10428);
    const deseretCapital = cp(0x10400);
    expect(publicDisplayName('Ana', `${deseretSmall}x`)).toBe(`Ana ${deseretCapital}.`);
    const emoji = publicDisplayName('Ana', `${GRIN}smith`);
    expect(emoji).toBe(`Ana ${GRIN}.`);
    expect(containsForbiddenText(emoji)).toBe(false);
  });
  it('returns the first name only when the last name is empty or blank', () => {
    expect(publicDisplayName('Ana', '')).toBe('Ana');
    expect(publicDisplayName('Ana', '   ')).toBe('Ana');
    expect(publicDisplayName('Ana', `${ZWSP}\t`)).toBe('Ana');
  });
  it('normalizes whitespace in both names', () => {
    expect(publicDisplayName('  Ana \t Maria ', '\n  martinez ')).toBe('Ana Maria M.');
  });
  it('never contains the full last name', () => {
    for (const last of ['Martinez', 'Smith-Jones', 'de la Cruz', `${GRIN}smith`, `${cp(0xc9)}lodie`, 'Zz']) {
      const shown = publicDisplayName('Ana', last);
      expect(shown, last).not.toContain(last);
      expect(shown.endsWith('.'), last).toBe(true);
    }
  });
  it('shows a single initial: the display is at most the first name, a space, one character and a period', () => {
    const shown = publicDisplayName('Ana', 'Martinez');
    expect(codePointLength(shown)).toBe('Ana'.length + 1 + 1 + 1);
  });
});

// ====================================================================== read model and requests
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const validAccount = {
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
  primaryRole: 'CUSTOMER',
  activeRole: 'CUSTOMER',
  profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AccountDto', () => {
  it('parses a complete account', () => {
    expect(AccountDto.parse(validAccount)).toEqual(validAccount);
  });
  it('accepts an account with no role, no profile and null locale or zone', () => {
    const bare = { ...validAccount, roles: [], primaryRole: null, activeRole: null, profile: null };
    expect(AccountDto.parse(bare)).toEqual(bare);
    const noOverrides = { ...validAccount, profile: { firstName: 'A', lastName: 'B', preferredLocale: null, timeZone: null } };
    expect(AccountDto.parse(noOverrides)).toEqual(noOverrides);
  });
  it.each([
    ['not a uuid', { accountId: 'abc' }],
    ['an unknown status', { status: 'DELETED' }],
    ['a role without a content key', { roles: [{ code: 'CUSTOMER' }] }],
    ['a missing profile', { profile: undefined }],
    ['a numeric primary role', { primaryRole: 1 }],
    ['a missing createdAt', { createdAt: undefined }],
  ])('rejects an account with %s', (_label, over) => {
    expect(AccountDto.safeParse({ ...validAccount, ...over }).success).toBe(false);
  });
  it('carries exactly the documented fields and none that identify the Keycloak identity', () => {
    expect(Object.keys(AccountDto.shape).sort()).toEqual(['accountId', 'activeRole', 'createdAt', 'primaryRole', 'profile', 'roles', 'status']);
    expect(Object.keys(AccountDto.shape.roles.element.shape).sort()).toEqual(['code', 'nameContentKey']);
    expect(Object.keys(AccountDto.shape.profile.unwrap().shape).sort()).toEqual(['firstName', 'lastName', 'preferredLocale', 'timeZone']);
    const json = JSON.stringify(Object.keys(AccountDto.shape));
    for (const word of ['subject', 'issuer', 'token', 'sub', 'email', 'password']) expect(json).not.toContain(`"${word}"`);
  });
  it('wraps the account in the standard data and meta envelope', () => {
    expect(AccountResponse.parse({ data: validAccount, meta: { correlationId: 'c-1' } })).toEqual({ data: validAccount, meta: { correlationId: 'c-1' } });
    expect(AccountResponse.safeParse({ data: validAccount }).success).toBe(false);
  });
});

describe('SetActiveRoleRequest', () => {
  it.each(['CUSTOMER', 'PROVIDER', 'AB'])('accepts { role: %s }', (role) => {
    expect(SetActiveRoleRequest.parse({ role })).toEqual({ role });
  });
  it.each([
    ['an empty object', {}],
    ['a lower-case code', { role: 'provider' }],
    ['a number', { role: 1 }],
    ['a boolean', { role: true }],
    ['null', { role: null }],
    ['an array', { role: ['PROVIDER'] }],
    ['an object', { role: { code: 'PROVIDER' } }],
    ['an over-long code', { role: `A${'B'.repeat(30)}` }],
    ['an unknown extra key', { role: 'PROVIDER', extra: 1 }],
    ['an account id', { role: 'PROVIDER', accountId: ACCOUNT_ID }],
    ['a Keycloak subject', { role: 'PROVIDER', sub: 'abc' }],
  ])('rejects %s', (_label, body) => {
    expect(SetActiveRoleRequest.safeParse(body).success).toBe(false);
  });
  it.each([null, undefined, 'PROVIDER', 5, true, ['PROVIDER']])('rejects the non-object body %j', (body) => {
    expect(SetActiveRoleRequest.safeParse(body).success).toBe(false);
  });
  it('names an unknown key in the issue and nothing else of its value', () => {
    const r = SetActiveRoleRequest.safeParse({ role: 'PROVIDER', accountId: 'secret-account-value' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
    expect(JSON.stringify(r.error.issues)).not.toContain('secret-account-value');
  });
});

describe('UpdateProfileRequest', () => {
  const base = { firstName: 'Ana', lastName: 'Martinez' };
  it('accepts names only; locale and time zone are optional', () => {
    expect(UpdateProfileRequest.parse(base)).toEqual(base);
  });
  it('accepts a locale and an IANA time zone', () => {
    const body = { ...base, preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
    expect(UpdateProfileRequest.parse(body)).toEqual(body);
  });
  it('accepts null and undefined locale and time zone (they clear the override)', () => {
    expect(UpdateProfileRequest.parse({ ...base, preferredLocale: null, timeZone: null })).toEqual({ ...base, preferredLocale: null, timeZone: null });
    expect(UpdateProfileRequest.parse({ ...base, preferredLocale: undefined, timeZone: undefined })).toEqual(base);
  });
  it('lets the service decide name validity: any string up to 500 characters passes the contract (the service trims and applies 1 to 50)', () => {
    expect(UpdateProfileRequest.safeParse({ firstName: '', lastName: '   ' }).success).toBe(true);
    expect(UpdateProfileRequest.safeParse({ firstName: 'a'.repeat(500), lastName: 'b'.repeat(500) }).success).toBe(true);
  });
  it('rejects a name above the 500 character ceiling', () => {
    expect(UpdateProfileRequest.safeParse({ ...base, firstName: 'a'.repeat(501) }).success).toBe(false);
    expect(UpdateProfileRequest.safeParse({ ...base, lastName: 'b'.repeat(501) }).success).toBe(false);
  });
  it.each([
    ['a numeric first name', { firstName: 1 }],
    ['a boolean last name', { lastName: true }],
    ['a null first name', { firstName: null }],
    ['an array last name', { lastName: ['Martinez'] }],
    ['a missing first name', { firstName: undefined }],
    ['a missing last name', { lastName: undefined }],
    ['an unknown extra key', { extra: 'x' }],
    ['an account id', { accountId: ACCOUNT_ID }],
    ['a role', { role: 'PROVIDER' }],
    ['an underscore locale', { preferredLocale: 'en_US' }],
    ['a numeric locale', { preferredLocale: 1 }],
    ['a padded locale', { preferredLocale: ' en-US' }],
    ['an over-long locale', { preferredLocale: 'en-US-extra-extra-extra' }],
    ['a numeric time zone', { timeZone: 5 }],
    ['an offset time zone', { timeZone: '+05:00' }],
    ['a time zone with a space', { timeZone: 'America/Los Angeles' }],
    ['a path-like time zone', { timeZone: '../../etc/passwd' }],
    ['an empty time zone', { timeZone: '' }],
    ['an over-long time zone', { timeZone: `Etc/${'A'.repeat(70)}` }],
  ])('rejects %s', (_label, over) => {
    expect(UpdateProfileRequest.safeParse({ ...base, ...over }).success).toBe(false);
  });
  it.each([null, undefined, 'Ana', 1, ['Ana']])('rejects the non-object body %j', (body) => {
    expect(UpdateProfileRequest.safeParse(body).success).toBe(false);
  });
});

// ====================================================================== events
describe('IDENTITY_EVENTS', () => {
  it('defines exactly the five identity events', () => {
    expect(IDENTITY_EVENTS).toEqual({
      accountCreated: 'bananagig.identity.account-created.v1',
      externalIdentityLinked: 'bananagig.identity.external-identity-linked.v1',
      accountRoleGranted: 'bananagig.identity.account-role-granted.v1',
      accountRoleDeactivated: 'bananagig.identity.account-role-deactivated.v1',
      accountStatusChanged: 'bananagig.identity.account-status-changed.v1',
    });
  });
  it('uses event types that match the shared pattern, are unique and live in the identity domain', () => {
    const types = Object.values(IDENTITY_EVENTS);
    expect(types).toHaveLength(5);
    expect(new Set(types).size).toBe(5);
    for (const t of types) {
      expect(t, t).toMatch(EVENT_TYPE_PATTERN);
      expect(t.startsWith('bananagig.identity.'), t).toBe(true);
    }
  });
  it('fits the event envelope with an identity payload', () => {
    const envelope = {
      eventId: '0b9d0e2a-6d0b-4b8c-8f5e-0f6f3f2f9c11',
      eventType: IDENTITY_EVENTS.accountCreated,
      eventVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'c-1',
      causationId: null,
      actor: { type: 'system' as const, id: 'system:account-bootstrap' },
      aggregateType: 'identity_account',
      aggregateId: ACCOUNT_ID,
      payload: { accountId: ACCOUNT_ID, status: 'ACTIVE' },
    };
    expect(EventEnvelope.safeParse(envelope).success).toBe(true);
    for (const eventType of Object.values(IDENTITY_EVENTS)) expect(EventEnvelope.safeParse({ ...envelope, eventType }).success, eventType).toBe(true);
  });
});

describe('identity event payloads', () => {
  it('AccountCreatedPayload carries the account id and the status', () => {
    expect(AccountCreatedPayload.parse({ accountId: ACCOUNT_ID, status: 'ACTIVE' })).toEqual({ accountId: ACCOUNT_ID, status: 'ACTIVE' });
    expect(AccountCreatedPayload.safeParse({ accountId: ACCOUNT_ID, status: 'BOGUS' }).success).toBe(false);
    expect(AccountCreatedPayload.safeParse({ status: 'ACTIVE' }).success).toBe(false);
    expect(AccountCreatedPayload.safeParse({ accountId: ACCOUNT_ID }).success).toBe(false);
    expect(AccountCreatedPayload.safeParse({ accountId: 5, status: 'ACTIVE' }).success).toBe(false);
  });
  it('ExternalIdentityLinkedPayload carries the provider type and never the subject or issuer', () => {
    expect(ExternalIdentityLinkedPayload.parse({ accountId: ACCOUNT_ID, providerType: 'KEYCLOAK' })).toEqual({
      accountId: ACCOUNT_ID,
      providerType: 'KEYCLOAK',
    });
    expect(ExternalIdentityLinkedPayload.safeParse({ accountId: ACCOUNT_ID, providerType: 'GOOGLE' }).success).toBe(false);
    expect(ExternalIdentityLinkedPayload.safeParse({ accountId: ACCOUNT_ID }).success).toBe(false);
    expect(Object.keys(ExternalIdentityLinkedPayload.shape).sort()).toEqual(['accountId', 'providerType']);
    expect(ExternalIdentityLinkedPayload.parse({ accountId: ACCOUNT_ID, providerType: 'KEYCLOAK', subject: 'kc-sub', issuer: 'http://iss' })).toEqual({
      accountId: ACCOUNT_ID,
      providerType: 'KEYCLOAK',
    });
  });
  it('AccountRolePayload carries the role code and an optional, known grant source', () => {
    expect(AccountRolePayload.parse({ accountId: ACCOUNT_ID, roleCode: 'CUSTOMER', source: 'BOOTSTRAP' })).toEqual({
      accountId: ACCOUNT_ID,
      roleCode: 'CUSTOMER',
      source: 'BOOTSTRAP',
    });
    expect(AccountRolePayload.parse({ accountId: ACCOUNT_ID, roleCode: 'CUSTOMER' })).toEqual({ accountId: ACCOUNT_ID, roleCode: 'CUSTOMER' });
    for (const source of ROLE_GRANT_SOURCES)
      expect(AccountRolePayload.safeParse({ accountId: ACCOUNT_ID, roleCode: 'PROVIDER', source }).success, source).toBe(true);
    expect(AccountRolePayload.safeParse({ accountId: ACCOUNT_ID, roleCode: 'CUSTOMER', source: 'HACKER' }).success).toBe(false);
    expect(AccountRolePayload.safeParse({ accountId: ACCOUNT_ID }).success).toBe(false);
    expect(AccountRolePayload.safeParse({ roleCode: 'CUSTOMER' }).success).toBe(false);
  });
  it('AccountStatusChangedPayload carries the previous status (nullable) and the new one', () => {
    expect(AccountStatusChangedPayload.parse({ accountId: ACCOUNT_ID, fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' })).toEqual({
      accountId: ACCOUNT_ID,
      fromStatus: 'ACTIVE',
      toStatus: 'SUSPENDED',
    });
    expect(AccountStatusChangedPayload.safeParse({ accountId: ACCOUNT_ID, fromStatus: null, toStatus: 'ACTIVE' }).success).toBe(true);
    expect(AccountStatusChangedPayload.safeParse({ accountId: ACCOUNT_ID, toStatus: 'ACTIVE' }).success).toBe(false);
    expect(AccountStatusChangedPayload.safeParse({ accountId: ACCOUNT_ID, fromStatus: 'ACTIVE' }).success).toBe(false);
    expect(AccountStatusChangedPayload.safeParse({ accountId: ACCOUNT_ID, fromStatus: 'BOGUS', toStatus: 'ACTIVE' }).success).toBe(false);
    expect(AccountStatusChangedPayload.safeParse({ accountId: ACCOUNT_ID, fromStatus: 'ACTIVE', toStatus: null }).success).toBe(false);
  });
  it('carry identifiers only: no payload names a name, a token, a subject or an issuer', () => {
    const shapes = [AccountCreatedPayload, ExternalIdentityLinkedPayload, AccountRolePayload, AccountStatusChangedPayload].flatMap((s) => Object.keys(s.shape));
    expect([...new Set(shapes)].sort()).toEqual(['accountId', 'fromStatus', 'providerType', 'roleCode', 'source', 'status', 'toStatus']);
  });
});

describe('ACCOUNT_ERROR_CODES', () => {
  it('lists the typed account error codes', () => {
    expect([...ACCOUNT_ERROR_CODES]).toEqual([
      'NOT_FOUND',
      'SUSPENDED',
      'CLOSED',
      'ROLE_NOT_FOUND',
      'ROLE_NOT_HELD',
      'ROLE_NOT_ACTIVE',
      'VALIDATION_FAILED',
      'CONFLICT',
      'INVALID_STATE',
      'UNAVAILABLE',
    ]);
  });
  it('has unique upper-case codes, usable as the ACCOUNT_<code> API error code suffix', () => {
    expect(new Set(ACCOUNT_ERROR_CODES).size).toBe(ACCOUNT_ERROR_CODES.length);
    for (const c of ACCOUNT_ERROR_CODES) expect(`ACCOUNT_${c}`, c).toMatch(/^ACCOUNT_[A-Z][A-Z_]*$/);
  });
});

describe('publicDisplayName edge cases', () => {
  it('shows ONE character as the initial: an upper-casing that expands keeps the original letter', () => {
    expect(publicDisplayName('Ana', String.fromCodePoint(0xdf) + 'mith')).toBe('Ana ' + String.fromCodePoint(0xdf) + '.');
    expect(publicDisplayName('Ana', 'martin')).toBe('Ana M.');
  });
  it('does not start with a space when the first name is empty', () => {
    expect(publicDisplayName('', 'X')).toBe('X.');
    expect(publicDisplayName('   ', 'x')).toBe('X.');
  });
});
