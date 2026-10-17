// Unit tests of the account area registry reader (ACC-001) that need no PostgreSQL: the service against a scripted pg connection (a fake pool client that records every
// statement and answers by statement), the single definition of "available" in the SQL text, the one-statement budget, the corrupted-registry refusal, the not-found
// answer and the in-memory FakeAccountArea that the API unit tests use. Behaviour that needs the real tables, triggers and indexes is in account-area.itest.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRoleDto, AccountSectionDto, ContactsVerificationDto } from '@bananagig/contracts';
import { Database } from '@bananagig/database';
import { AccountAreaService, FakeAccountArea, sectionNotFound } from './account-area';
import { AccountError } from './errors';

type Row = Record<string, unknown>;
interface Recorded {
  sql: string;
  params: unknown[];
}

const openDatabases: Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openDatabases.splice(0).map((d) => d.close()));
});

/** A real Database whose pool hands out a fake client: every statement is recorded and answered by `reply` (no server, no network). */
const scripted = (reply: (q: Recorded) => Row[] | Error) => {
  const log: Recorded[] = [];
  const database = new Database('postgresql://app:pw@db.invalid:5432/app');
  openDatabases.push(database);
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const q = { sql: text.replace(/\s+/g, ' ').trim(), params };
      log.push(q);
      const r = reply(q);
      if (r instanceof Error) throw r;
      return { command: 'SELECT', rowCount: r.length, rows: r };
    },
    release: () => undefined,
  };
  const connect = vi.spyOn(database.pool, 'connect').mockResolvedValue(client as never);
  return { database, log, connect };
};
/** A Database that fails the test loudly if anything touches it. */
const untouchable = (): Database =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the database was touched (${String(prop)})`);
      },
    },
  ) as unknown as Database;

const row = (
  code: string,
  route: string,
  label = `account.area.section.${code.toLowerCase()}.label`,
  description: string | null = `account.area.section.${code.toLowerCase()}.description`,
): Row => ({
  section_code: code,
  route_path: route,
  label_content_key: label,
  description_content_key: description,
});
const MENU: Row[] = [row('PROFILE', '/account/profile'), row('SECURITY', '/account/security'), row('ROLES', '/account/roles')];
const caught = async (p: Promise<unknown>): Promise<AccountError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError);
    return err as AccountError;
  }
  throw new Error('expected the call to reject');
};

describe('AccountAreaService.sectionsOf', () => {
  it('answers an empty list for a null role without touching the database (an account with no usable role has no sections)', async () => {
    const svc = new AccountAreaService({ database: untouchable() });
    expect(await svc.sectionsOf(null)).toEqual([]);
  });

  it('maps every row to the section DTO (code, route, label key, description key) in the order the database returned them', async () => {
    const { database } = scripted(() => [
      row('SECURITY', '/account/security'),
      row('PROFILE', '/account/profile', 'k.label', null),
      row('LANGUAGE_REGION', '/account/language-region'),
    ]);
    expect(await new AccountAreaService({ database }).sectionsOf('CUSTOMER')).toEqual([
      {
        code: 'SECURITY',
        route: '/account/security',
        labelContentKey: 'account.area.section.security.label',
        descriptionContentKey: 'account.area.section.security.description',
      },
      { code: 'PROFILE', route: '/account/profile', labelContentKey: 'k.label', descriptionContentKey: null },
      {
        code: 'LANGUAGE_REGION',
        route: '/account/language-region',
        labelContentKey: 'account.area.section.language_region.label',
        descriptionContentKey: 'account.area.section.language_region.description',
      },
    ]);
  });

  it('turns a missing or NULL description key into null (never undefined) and carries nothing else from the row', async () => {
    const { database } = scripted(() => [
      { section_code: 'A1', route_path: '/account/aa', label_content_key: 'a.b', description_content_key: null, extra: 'must not leak', status: 'ACTIVE' },
      { section_code: 'B1', route_path: '/account/bb', label_content_key: 'a.c' },
    ]);
    const sections = await new AccountAreaService({ database }).sectionsOf('CUSTOMER');
    expect(sections).toEqual([
      { code: 'A1', route: '/account/aa', labelContentKey: 'a.b', descriptionContentKey: null },
      { code: 'B1', route: '/account/bb', labelContentKey: 'a.c', descriptionContentKey: null },
    ]);
    for (const s of sections) expect(Object.keys(s).sort()).toEqual(['code', 'descriptionContentKey', 'labelContentKey', 'route']);
  });

  it('returns an empty list when the registry has no row for the role (an unknown role, a role with nothing enabled)', async () => {
    const { database, log } = scripted(() => []);
    expect(await new AccountAreaService({ database }).sectionsOf('NO_SUCH_ROLE')).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it('issues exactly ONE statement, outside any transaction, whatever the number of sections', async () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`SEC_${i}`, `/account/sec-${i}`));
    const { database, log } = scripted(() => many);
    const sections = await new AccountAreaService({ database }).sectionsOf('PROVIDER');
    expect(sections).toHaveLength(40);
    expect(log).toHaveLength(1);
    expect(log.map((q) => q.sql).filter((s) => /^(begin|start transaction|commit|rollback|insert|update|delete)/i.test(s))).toEqual([]);
  });

  it('holds the single definition of "available" in its SQL: an enabled matrix row, an ACTIVE section, an ACTIVE role, in menu order', async () => {
    const { database, log } = scripted(() => []);
    await new AccountAreaService({ database }).sectionsOf('CUSTOMER');
    const text = log[0]!.sql;
    expect(text).toMatch(/^select s\.section_code, s\.route_path, s\.label_content_key, s\.description_content_key from identity\.roles r /i);
    expect(text).toMatch(/join identity\.account_section_roles sr on sr\.role_id = r\.role_id and sr\.enabled\b/i);
    expect(text).toMatch(/join identity\.account_sections s on s\.section_code = sr\.section_code and s\.status = 'ACTIVE'/i);
    expect(text).toMatch(/where r\.code = \$1 and r\.status = 'ACTIVE'/i);
    expect(text).toMatch(/order by sr\.display_order$/i);
    // the section status test is on the JOIN or the WHERE, never absent: a section that is not ACTIVE must not be offered
    expect((text.match(/status = 'ACTIVE'/gi) ?? []).length).toBe(2);
    expect(text).not.toMatch(/\bdesc\b/i);
  });

  it('passes the role as the one bound parameter and never puts it in the statement text (a hostile role string changes nothing but the parameter)', async () => {
    const roles = ['CUSTOMER', "CUSTOMER' OR '1'='1", 'customer', '', 'PROVIDER; DROP TABLE identity.roles;--', 'A\\B%_'];
    const texts = new Set<string>();
    for (const role of roles) {
      const { database, log } = scripted(() => []);
      await new AccountAreaService({ database }).sectionsOf(role);
      expect(log[0]!.params, role).toEqual([role]);
      texts.add(log[0]!.sql);
      if (role !== '') expect(log[0]!.sql, role).not.toContain(role);
    }
    expect(texts.size).toBe(1);
  });

  it('refuses a route that violates the registry shape as UNAVAILABLE (REGISTRY_INVALID) and offers none of the sections, not even the valid ones', async () => {
    const bad = [
      '/account',
      '/account/',
      '/Account/x',
      '/account/Profile',
      '/account/x',
      '/account/a/b',
      'account/profile',
      '',
      '/account/a b',
      'https://example.test/account/profile',
      '/account/profile?x=1',
    ];
    for (const route of bad) {
      const { database } = scripted(() => [row('PROFILE', '/account/profile'), row('BROKEN', route), row('SECURITY', '/account/security')]);
      const e = await caught(new AccountAreaService({ database }).sectionsOf('CUSTOMER'));
      expect({ code: e.code, details: e.details, message: e.message }, JSON.stringify(route)).toEqual({
        code: 'UNAVAILABLE',
        details: { reason: 'REGISTRY_INVALID' },
        message: 'the account area registry is not valid',
      });
    }
  });

  it('refuses a missing route or a non-string route the same way, without echoing the value', async () => {
    for (const route of [undefined, null, 5, {}]) {
      const { database } = scripted(() => [{ section_code: 'X1', route_path: route, label_content_key: 'a.b', description_content_key: null }]);
      const e = await caught(new AccountAreaService({ database }).sectionsOf('CUSTOMER'));
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.details).toEqual({ reason: 'REGISTRY_INVALID' });
    }
  });

  it('accepts the boundary routes (a 2-character and a 40-character slug, digits and dashes)', async () => {
    const { database } = scripted(() => [row('A1', '/account/ab'), row('B1', `/account/${'a'.repeat(40)}`), row('C1', '/account/a-1-b')]);
    expect((await new AccountAreaService({ database }).sectionsOf('CUSTOMER')).map((s) => s.route)).toEqual([
      '/account/ab',
      `/account/${'a'.repeat(40)}`,
      '/account/a-1-b',
    ]);
  });

  it('maps a database outage to UNAVAILABLE without the driver text, and rethrows a programming error unchanged', async () => {
    const outage = scripted(() => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' }));
    const e = await caught(new AccountAreaService({ database: outage.database }).sectionsOf('CUSTOMER'));
    expect(e.code).toBe('UNAVAILABLE');
    expect(JSON.stringify([e.message, e.details])).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    const bug = new TypeError('cannot read properties of undefined');
    const broken = scripted(() => bug);
    await expect(new AccountAreaService({ database: broken.database }).sectionsOf('CUSTOMER')).rejects.toBe(bug);
  });

  it('reports a deadlock-class or serialization failure as the retryable CONFLICT of the account errors', async () => {
    const { database } = scripted(() => Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const e = await caught(new AccountAreaService({ database }).sectionsOf('CUSTOMER'));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
  });

  it('reads on every call (no cache): two calls issue two statements and see the registry as it is at the second call', async () => {
    let current: Row[] = [row('PROFILE', '/account/profile')];
    const { database, log } = scripted(() => current);
    const svc = new AccountAreaService({ database });
    expect((await svc.sectionsOf('CUSTOMER')).map((s) => s.code)).toEqual(['PROFILE']);
    current = [row('PROFILE', '/account/profile'), row('SECURITY', '/account/security')];
    expect((await svc.sectionsOf('CUSTOMER')).map((s) => s.code)).toEqual(['PROFILE', 'SECURITY']);
    expect(log).toHaveLength(2);
  });
});

describe('AccountAreaService.navigation', () => {
  const roles: AccountRoleDto[] = [
    { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' },
    { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' },
  ];
  const contacts: ContactsVerificationDto = { emailVerified: true, phoneVerified: false, contactsVerified: false };

  it('composes the read model from what the caller already loaded plus ONE registry read: no extra query', async () => {
    const { database, log } = scripted(() => MENU);
    const nav = await new AccountAreaService({ database }).navigation({ activeRole: 'CUSTOMER', roles, contacts });
    expect(log).toHaveLength(1);
    expect(log[0]!.params).toEqual(['CUSTOMER']);
    expect(nav).toEqual({
      activeRole: 'CUSTOMER',
      roles,
      sections: MENU.map((r) => ({
        code: r.section_code,
        route: r.route_path,
        labelContentKey: r.label_content_key,
        descriptionContentKey: r.description_content_key,
      })),
      contacts,
    });
  });

  it('reads the sections of the ACTIVE role only, not of any other role the account holds', async () => {
    const { database, log } = scripted(() => []);
    await new AccountAreaService({ database }).navigation({ activeRole: 'PROVIDER', roles, contacts });
    expect(log.map((q) => q.params)).toEqual([['PROVIDER']]);
  });

  it('answers sections [] for a null active role without any statement, and keeps the roles and the contacts', async () => {
    const svc = new AccountAreaService({ database: untouchable() });
    expect(await svc.navigation({ activeRole: null, roles: [], contacts })).toEqual({ activeRole: null, roles: [], sections: [], contacts });
    expect(await svc.navigation({ activeRole: null, roles, contacts })).toEqual({ activeRole: null, roles, sections: [], contacts });
  });

  it('copies the roles list (a caller that mutates the result does not change its own list) and leaves the input untouched', async () => {
    const { database } = scripted(() => MENU);
    const input = { activeRole: 'CUSTOMER', roles: [...roles], contacts: { ...contacts } };
    const frozen = JSON.stringify(input);
    const nav = await new AccountAreaService({ database }).navigation(input);
    expect(nav.roles).not.toBe(input.roles);
    nav.roles.pop();
    nav.sections.length = 0;
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('does not invent a role: the active role is passed through verbatim, even one the account does not list, and the registry decides the sections', async () => {
    const { database, log } = scripted(() => []);
    const nav = await new AccountAreaService({ database }).navigation({ activeRole: 'ADMIN', roles, contacts });
    expect(nav.activeRole).toBe('ADMIN');
    expect(nav.sections).toEqual([]);
    expect(log[0]!.params).toEqual(['ADMIN']);
  });

  it('propagates the corrupted-registry refusal and a database outage instead of returning a partial navigation', async () => {
    const corrupt = scripted(() => [row('X1', '/nope')]);
    expect((await caught(new AccountAreaService({ database: corrupt.database }).navigation({ activeRole: 'CUSTOMER', roles, contacts }))).details).toEqual({
      reason: 'REGISTRY_INVALID',
    });
    const down = scripted(() => Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    expect((await caught(new AccountAreaService({ database: down.database }).navigation({ activeRole: 'CUSTOMER', roles, contacts }))).code).toBe(
      'UNAVAILABLE',
    );
  });
});

describe('AccountAreaService.assertSection', () => {
  it('resolves for a section in the enabled set of the role, with ONE statement', async () => {
    const { database, log } = scripted(() => MENU);
    await expect(new AccountAreaService({ database }).assertSection('CUSTOMER', 'SECURITY')).resolves.toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]!.params).toEqual(['CUSTOMER']);
  });

  it('throws SECTION_NOT_FOUND for a section outside the set: unknown, wrong case, empty, padded, or a code that merely contains a visible one', async () => {
    for (const code of ['NOTIFICATIONS', 'profile', 'Profile', '', ' PROFILE', 'PROFILE ', 'PROF', 'PROFILE_2', 'ADMIN', "PROFILE' OR '1'='1"]) {
      const { database } = scripted(() => MENU);
      const e = await caught(new AccountAreaService({ database }).assertSection('CUSTOMER', code));
      expect({ code: e.code, message: e.message, details: e.details }, JSON.stringify(code)).toEqual({
        code: 'SECTION_NOT_FOUND',
        message: 'the account section was not found',
        details: {},
      });
    }
  });

  it('throws SECTION_NOT_FOUND for a null role without any statement', async () => {
    const e = await caught(new AccountAreaService({ database: untouchable() }).assertSection(null, 'PROFILE'));
    expect(e.code).toBe('SECTION_NOT_FOUND');
  });

  it('gives the same answer for a hidden section and an unknown one, and never names the section or the role in it', async () => {
    const a = await caught(new AccountAreaService({ database: scripted(() => MENU).database }).assertSection('CUSTOMER', 'NOTIFICATIONS'));
    const b = await caught(new AccountAreaService({ database: scripted(() => MENU).database }).assertSection('PROVIDER_SECRET_ROLE', 'NO_SUCH_SECTION'));
    expect({ code: a.code, message: a.message, details: a.details }).toEqual({ code: b.code, message: b.message, details: b.details });
    const text = JSON.stringify([a.message, a.details, b.message, b.details]);
    for (const needle of ['NOTIFICATIONS', 'PROVIDER_SECRET_ROLE', 'NO_SUCH_SECTION', 'CUSTOMER']) expect(text).not.toContain(needle);
  });

  it('lets a registry or database failure through as that failure, not as "not found" (an outage must not look like a hidden section)', async () => {
    const down = scripted(() => Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect((await caught(new AccountAreaService({ database: down.database }).assertSection('CUSTOMER', 'PROFILE'))).code).toBe('UNAVAILABLE');
    const corrupt = scripted(() => [row('PROFILE', 'nope')]);
    expect((await caught(new AccountAreaService({ database: corrupt.database }).assertSection('CUSTOMER', 'PROFILE'))).details).toEqual({
      reason: 'REGISTRY_INVALID',
    });
  });
});

describe('sectionNotFound', () => {
  it('is a typed AccountError with the fixed message, no details and a stack that does not carry a section or a role', () => {
    const e = sectionNotFound();
    expect(e).toBeInstanceOf(AccountError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AccountError');
    expect(e.code).toBe('SECTION_NOT_FOUND');
    expect(e.message).toBe('the account section was not found');
    expect(e.details).toEqual({});
  });
  it('returns a fresh error every time (an error is never shared between requests)', () => {
    expect(sectionNotFound()).not.toBe(sectionNotFound());
  });
});

describe('FakeAccountArea', () => {
  const profile: AccountSectionDto = { code: 'PROFILE', route: '/account/profile', labelContentKey: 'a.b', descriptionContentKey: null };
  const security: AccountSectionDto = { code: 'SECURITY', route: '/account/security', labelContentKey: 'a.c', descriptionContentKey: 'a.d' };
  const roles: AccountRoleDto[] = [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }];
  const contacts: ContactsVerificationDto = { emailVerified: false, phoneVerified: false, contactsVerified: false };
  const make = () => new FakeAccountArea({ CUSTOMER: [profile, security], PROVIDER: [security] });

  it('answers the sections of the role, [] for a null role and [] for a role it does not know', async () => {
    const fake = make();
    expect(await fake.sectionsOf('CUSTOMER')).toEqual([profile, security]);
    expect(await fake.sectionsOf('PROVIDER')).toEqual([security]);
    expect(await fake.sectionsOf(null)).toEqual([]);
    expect(await fake.sectionsOf('ADMIN')).toEqual([]);
    expect(await fake.sectionsOf('customer')).toEqual([]);
  });

  it('hands out copies: a caller that changes a returned section or list does not change the registry of the fake', async () => {
    const fake = make();
    const first = await fake.sectionsOf('CUSTOMER');
    first[0]!.code = 'CHANGED';
    first.pop();
    expect(await fake.sectionsOf('CUSTOMER')).toEqual([profile, security]);
    expect(profile.code).toBe('PROFILE');
  });

  it('records every call with its method and role, and the composed calls record the inner sectionsOf too', async () => {
    const fake = make();
    await fake.sectionsOf('CUSTOMER');
    await fake.navigation({ activeRole: 'PROVIDER', roles, contacts });
    await fake.assertSection('CUSTOMER', 'PROFILE');
    await fake.sectionsOf(null);
    expect(fake.calls).toEqual([
      { method: 'sectionsOf', role: 'CUSTOMER' },
      { method: 'navigation', role: 'PROVIDER' },
      { method: 'sectionsOf', role: 'PROVIDER' },
      { method: 'assertSection', role: 'CUSTOMER' },
      { method: 'sectionsOf', role: 'CUSTOMER' },
      { method: 'sectionsOf', role: null },
    ]);
  });

  it('composes the navigation like the real service (sections of the active role, a copy of the roles, the contacts) and an empty one for a null role', async () => {
    const fake = make();
    const nav = await fake.navigation({ activeRole: 'CUSTOMER', roles, contacts });
    expect(nav).toEqual({ activeRole: 'CUSTOMER', roles, sections: [profile, security], contacts });
    expect(nav.roles).not.toBe(roles);
    expect(await fake.navigation({ activeRole: null, roles, contacts })).toEqual({ activeRole: null, roles, sections: [], contacts });
  });

  it('asserts like the real service: resolves for a visible section, throws the same SECTION_NOT_FOUND for a hidden one, an unknown role and a null role', async () => {
    const fake = make();
    await expect(fake.assertSection('CUSTOMER', 'PROFILE')).resolves.toBeUndefined();
    for (const [role, code] of [
      ['PROVIDER', 'PROFILE'],
      ['CUSTOMER', 'NOTIFICATIONS'],
      ['ADMIN', 'PROFILE'],
      [null, 'PROFILE'],
      ['CUSTOMER', 'profile'],
    ] as const) {
      const e = await caught(fake.assertSection(role, code));
      expect({ code: e.code, message: e.message }).toEqual({ code: 'SECTION_NOT_FOUND', message: 'the account section was not found' });
    }
  });
});
