// The shared account area (ACC-001, docs/engineering/ACCOUNT_AREA.md): which sections of the account area a role sees.
//
// One framework for every persona. The sections, their pages, labels, order and the role that sees them are DATA (identity.account_sections and
// identity.account_section_roles, migration 0014), never a list in code. This service only READS that registry; it owns no profile, contact, security or consent state
// (the account area composes the domains that own them) and persists nothing (the active role is request context, ADR-0026; there is no per-person section preference).
//
// Rules this file keeps:
//  - The role comes from the caller (the API passes the ALREADY VALIDATED active role of the request); a client never names a role or a section set.
//  - "Available" has ONE definition, `AVAILABLE_SECTIONS_SQL`: an enabled matrix row of an ACTIVE role for an ACTIVE section. The navigation and every guard read it.
//  - One indexed query per call (the role's rows in menu order through uq_account_section_roles__role_order). No per-section query exists.
//  - A section the role does not have is the same answer as a section that does not exist (SECTION_NOT_FOUND, 404): hiding is never only a front-end matter.
import {
  SECTION_ROUTE_PATTERN,
  type AccountNavigationDto,
  type AccountRoleDto,
  type AccountSectionDto,
  type ContactsVerificationDto,
} from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { AccountError } from './errors';
import { mapDbError } from './service';

type Row = Record<string, unknown>;

export interface AccountAreaOperations {
  /** The enabled sections of an application role, in menu order. A null role (an account with no usable role) has none. */
  sectionsOf(roleCode: string | null): Promise<AccountSectionDto[]>;
  /** The whole navigation read model of the caller from what the account guard already loaded plus ONE registry read. */
  navigation(input: NavigationInput): Promise<AccountNavigationDto>;
  /** Throws AccountError('SECTION_NOT_FOUND') unless `sectionCode` is in the enabled set of the role. Reads the registry once per call; callers that check several sections use `sectionsOf`. */
  assertSection(roleCode: string | null, sectionCode: string): Promise<void>;
}

export interface NavigationInput {
  activeRole: string | null;
  roles: readonly AccountRoleDto[];
  contacts: ContactsVerificationDto;
}

export interface AccountAreaServiceDeps {
  database: Database;
}

export class AccountAreaService implements AccountAreaOperations {
  constructor(private readonly d: AccountAreaServiceDeps) {}

  async sectionsOf(roleCode: string | null): Promise<AccountSectionDto[]> {
    if (roleCode === null) return [];
    // the single definition of "available": the matrix row is enabled, the section is ACTIVE and the role is ACTIVE; menu order from the unique key (role_id, display_order)
    const rows = (
      await sql<Row>`SELECT s.section_code, s.route_path, s.label_content_key, s.description_content_key
          FROM identity.roles r
          JOIN identity.account_section_roles sr ON sr.role_id = r.role_id AND sr.enabled
          JOIN identity.account_sections s ON s.section_code = sr.section_code AND s.status = 'ACTIVE'
         WHERE r.code = ${roleCode} AND r.status = 'ACTIVE'
         ORDER BY sr.display_order`
        .execute(this.d.database.db)
        .catch(mapDbError)
    ).rows;
    return rows.map((r) => {
      const route = r.route_path as string;
      // the database CHECK guarantees the shape; a row that violates it is a corrupted registry and is not offered
      if (!SECTION_ROUTE_PATTERN.test(route)) throw new AccountError('UNAVAILABLE', 'the account area registry is not valid', { reason: 'REGISTRY_INVALID' });
      return {
        code: r.section_code as string,
        route,
        labelContentKey: r.label_content_key as string,
        descriptionContentKey: (r.description_content_key as string | null) ?? null,
      };
    });
  }

  async navigation(input: NavigationInput): Promise<AccountNavigationDto> {
    return { activeRole: input.activeRole, roles: [...input.roles], sections: await this.sectionsOf(input.activeRole), contacts: input.contacts };
  }

  async assertSection(roleCode: string | null, sectionCode: string): Promise<void> {
    const sections = await this.sectionsOf(roleCode);
    if (!sections.some((s) => s.code === sectionCode)) throw sectionNotFound();
  }
}

/** The one answer for "no such section for you": unknown, planned, retired and not enabled for the role are indistinguishable. Never names the section or the role. */
export const sectionNotFound = (): AccountError => new AccountError('SECTION_NOT_FOUND', 'the account section was not found');

/** An in-memory registry for unit tests of the callers (the API); the real service reads PostgreSQL. */
export class FakeAccountArea implements AccountAreaOperations {
  readonly calls: { method: 'sectionsOf' | 'navigation' | 'assertSection'; role: string | null }[] = [];
  constructor(private readonly bySection: Record<string, AccountSectionDto[]>) {}
  async sectionsOf(roleCode: string | null): Promise<AccountSectionDto[]> {
    this.calls.push({ method: 'sectionsOf', role: roleCode });
    return roleCode === null ? [] : (this.bySection[roleCode] ?? []).map((s) => ({ ...s }));
  }
  async navigation(input: NavigationInput): Promise<AccountNavigationDto> {
    this.calls.push({ method: 'navigation', role: input.activeRole });
    return { activeRole: input.activeRole, roles: [...input.roles], sections: await this.sectionsOf(input.activeRole), contacts: input.contacts };
  }
  async assertSection(roleCode: string | null, sectionCode: string): Promise<void> {
    this.calls.push({ method: 'assertSection', role: roleCode });
    if (!(await this.sectionsOf(roleCode)).some((s) => s.code === sectionCode)) throw sectionNotFound();
  }
}
