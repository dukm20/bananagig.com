// Variants and add-ons of a Gig version (CAT-004): validation (pure), reads, whole-set replacement support and the copy into the next draft. Contract:
// packages/contracts/src/gig.ts (CAT-004 section) and .checkpoint/CAT-004-SPEC.md.
//
// Pricing rule (one rule): the Gig price is the BASE; a variant or an add-on adds a non-negative delta in minor units of the SAME currency (inherited from the parent version, never
// stored here) and a non-negative number of minutes. Variants are mutually exclusive alternatives, add-ons independent extras. Every item has a stable KEY and an explicit order.
// Provider names and descriptions are plain text (the CAT-003 normaliser); an issue holds the reason, the target and the item KEY, never the provider's text.
import {
  GIG_DELTA_MINUTES_CEILING,
  GIG_PRICE_MINOR_CEILING,
  gigIssueKey,
  normalizeProviderText,
  textLength,
  type GigIssueDto,
  type GigIssueReason,
  type GigOptionDto,
  type GigOptionInput,
  type ProviderGigOptionsPolicy,
  type ProviderGigPolicy,
} from '@bananagig/contracts';
import { sql } from '@bananagig/database';
import type { Executor } from './gig-sql';
import type { GigTemplateStructure } from './gig-types';

export type OptionKind = 'variants' | 'addOns';
/** An option after validation: normalised text, the key (kept or minted) and its display order (1..n, the array order). */
export interface ValidatedOption {
  key: string;
  name: string;
  description: string | null;
  priceDeltaMinor: number;
  durationDeltaMinutes: number;
  displayOrder: number;
}

const optionIssue = (kind: OptionKind, reason: GigIssueReason, itemKey?: string): GigIssueDto => ({
  target: kind,
  reason,
  messageKey: gigIssueKey(reason),
  ...(itemKey === undefined ? {} : { itemKey }),
});

/** Whether the exact template version lets the Gig carry this kind of option (variants: pricing FIXED_WITH_VARIANTS; add-ons: the explicit `addOnsAllowed` permission). */
export function optionsPermitted(kind: OptionKind, structure: GigTemplateStructure): boolean {
  return kind === 'variants' ? structure.pricing.fixedWithVariants : structure.addOnsAllowed;
}

/** The limit on the number of items of a kind. */
const maxCountOf = (kind: OptionKind, policy: ProviderGigOptionsPolicy): number => (kind === 'variants' ? policy.variantMaxCount : policy.addOnMaxCount);

/** The key two names collide on: compatibility-folded (NFKC: fullwidth letters, ligatures) and case-folded through upper case (so `Straße` and `STRASSE` collide). */
const nameIdentity = (name: string): string => name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');

/** Eager validation of a whole-set replacement against the template version, the limits and the keys that exist in the draft. Returns the items or every issue found (identifiers only). */
export function validateOptions(
  kind: OptionKind,
  input: readonly GigOptionInput[],
  existingKeys: ReadonlySet<string>,
  structure: GigTemplateStructure,
  policy: ProviderGigOptionsPolicy,
  mintKey: () => string,
): { ok: true; items: ValidatedOption[] } | { ok: false; issues: GigIssueDto[] } {
  const issues: GigIssueDto[] = [];
  if (input.length > 0 && !optionsPermitted(kind, structure)) issues.push(optionIssue(kind, 'OPTIONS_NOT_PERMITTED'));
  else if (input.length > maxCountOf(kind, policy)) issues.push(optionIssue(kind, 'OPTIONS_COUNT_EXCEEDED'));

  const used = new Set<string>();
  const names = new Set<string>();
  const staged: { key: string | undefined; name: string; description: string | null; priceDeltaMinor: number; durationDeltaMinutes: number }[] = [];
  for (const raw of input) {
    const at = raw.key;
    let ok = true;
    if (at !== undefined) {
      if (!existingKeys.has(at)) {
        issues.push(optionIssue(kind, 'OPTION_KEY_INVALID', at));
        ok = false;
      } else if (used.has(at)) {
        issues.push(optionIssue(kind, 'OPTION_KEY_DUPLICATE', at));
        ok = false;
      } else used.add(at);
    }
    const name = normalizeProviderText(raw.name, { multiline: false });
    let nameValue = '';
    if (!name.ok) {
      issues.push(optionIssue(kind, name.reason, at));
      ok = false;
    } else if (name.value === '') {
      issues.push(optionIssue(kind, 'OPTION_NAME_REQUIRED', at));
      ok = false;
    } else if (textLength(name.value) > policy.nameMaxLength) {
      issues.push(optionIssue(kind, 'OPTION_NAME_TOO_LONG', at));
      ok = false;
    } else {
      nameValue = name.value;
      const id = nameIdentity(nameValue);
      if (names.has(id)) {
        issues.push(optionIssue(kind, 'OPTION_NAME_DUPLICATE', at));
        ok = false;
      } else names.add(id);
    }
    let description: string | null = null;
    if (raw.description !== null) {
      const d = normalizeProviderText(raw.description, { multiline: true });
      if (!d.ok) {
        issues.push(optionIssue(kind, d.reason, at));
        ok = false;
      } else if (d.value !== '') {
        if (textLength(d.value) > policy.descriptionMaxLength) {
          issues.push(optionIssue(kind, 'OPTION_DESCRIPTION_TOO_LONG', at));
          ok = false;
        } else description = d.value;
      }
    }
    if (!Number.isSafeInteger(raw.priceDeltaMinor) || raw.priceDeltaMinor < 0 || raw.priceDeltaMinor > GIG_PRICE_MINOR_CEILING) {
      issues.push(optionIssue(kind, 'OPTION_PRICE_DELTA_INVALID', at));
      ok = false;
    }
    if (!Number.isSafeInteger(raw.durationDeltaMinutes) || raw.durationDeltaMinutes < 0 || raw.durationDeltaMinutes > GIG_DELTA_MINUTES_CEILING) {
      issues.push(optionIssue(kind, 'OPTION_DURATION_DELTA_INVALID', at));
      ok = false;
    }
    if (ok) staged.push({ key: at, name: nameValue, description, priceDeltaMinor: raw.priceDeltaMinor, durationDeltaMinutes: raw.durationDeltaMinutes });
  }
  if (issues.length > 0) return { ok: false, issues };

  const items: ValidatedOption[] = staged.map((s, i) => {
    let key = s.key;
    if (key === undefined) {
      // a minted key is unique among the kept keys and the keys minted so far (a collision of 48 random bits is a retry, never a failure)
      for (let attempt = 0; attempt < 8 && (key === undefined || used.has(key) || existingKeys.has(key)); attempt++) key = mintKey();
      if (key === undefined || used.has(key) || existingKeys.has(key)) throw new Error('could not mint a unique option key');
      used.add(key);
    }
    return {
      key,
      name: s.name,
      description: s.description,
      priceDeltaMinor: s.priceDeltaMinor,
      durationDeltaMinutes: s.durationDeltaMinutes,
      displayOrder: i + 1,
    };
  });
  return { ok: true, items };
}

type OptionRow = Record<string, unknown>;
const toOptionDto = (r: OptionRow): GigOptionDto => ({
  key: r.item_key as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  priceDeltaMinor: Number(r.price_delta_minor),
  durationDeltaMinutes: Number(r.duration_delta_minutes),
  displayOrder: Number(r.display_order),
});

/** One query for both kinds: the options of the given versions, ordered by (version, display order). */
export async function loadOptions(ex: Executor, versionIds: readonly string[]): Promise<Map<string, { variants: GigOptionDto[]; addOns: GigOptionDto[] }>> {
  const out = new Map<string, { variants: GigOptionDto[]; addOns: GigOptionDto[] }>(versionIds.map((id) => [id, { variants: [], addOns: [] }]));
  if (versionIds.length === 0) return out;
  const rows = (
    await sql<OptionRow>`SELECT 'variants' AS kind, gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order
        FROM provider.gig_version_variants WHERE gig_version_id = ANY(${versionIds}::uuid[])
      UNION ALL
      SELECT 'addOns' AS kind, gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order
        FROM provider.gig_version_add_ons WHERE gig_version_id = ANY(${versionIds}::uuid[])
      ORDER BY gig_version_id, kind, display_order`.execute(ex)
  ).rows;
  for (const r of rows) {
    const slot = out.get(r.gig_version_id as string);
    if (!slot) continue;
    (r.kind === 'variants' ? slot.variants : slot.addOns).push(toOptionDto(r));
  }
  return out;
}

/** Aggregates of the options of one kind of one version (the GigMenu never loads names or descriptions). Lengths are in code points. */
export interface OptionKindStats {
  count: number;
  maxNameLength: number;
  maxDescriptionLength: number;
}
export interface OptionStats {
  variants: OptionKindStats;
  addOns: OptionKindStats;
}
/** One query: the count and the longest name and description per version and kind. */
export async function loadOptionStats(ex: Executor, versionIds: readonly string[]): Promise<Map<string, OptionStats>> {
  const out = new Map<string, OptionStats>();
  if (versionIds.length === 0) return out;
  const rows = (
    await sql<OptionRow>`SELECT 'variants' AS kind, gig_version_id, count(*) AS n, max(char_length(name)) AS max_name, max(char_length(description)) AS max_description
        FROM provider.gig_version_variants WHERE gig_version_id = ANY(${[...versionIds]}::uuid[]) GROUP BY gig_version_id
      UNION ALL
      SELECT 'addOns' AS kind, gig_version_id, count(*) AS n, max(char_length(name)) AS max_name, max(char_length(description)) AS max_description
        FROM provider.gig_version_add_ons WHERE gig_version_id = ANY(${[...versionIds]}::uuid[]) GROUP BY gig_version_id`.execute(ex)
  ).rows;
  for (const r of rows) {
    const id = r.gig_version_id as string;
    const slot = out.get(id) ?? {
      variants: { count: 0, maxNameLength: 0, maxDescriptionLength: 0 },
      addOns: { count: 0, maxNameLength: 0, maxDescriptionLength: 0 },
    };
    slot[r.kind === 'variants' ? 'variants' : 'addOns'] = {
      count: Number(r.n),
      maxNameLength: Number(r.max_name ?? 0),
      maxDescriptionLength: Number(r.max_description ?? 0),
    };
    out.set(id, slot);
  }
  return out;
}
/** Whether the stored options of one kind satisfy the permission and the limits (the same rules as `optionsIssues`, from aggregates). */
export function optionKindValid(kind: OptionKind, stats: OptionKindStats, structure: GigTemplateStructure, options: ProviderGigOptionsPolicy): boolean {
  if (stats.count === 0) return true;
  return (
    optionsPermitted(kind, structure) &&
    stats.count <= maxCountOf(kind, options) &&
    stats.maxNameLength <= options.nameMaxLength &&
    stats.maxDescriptionLength <= options.descriptionMaxLength
  );
}

/** Re-validation of the STORED options of a draft at publish time (limits may have changed, the template permission is checked again). */
export function optionsIssues(
  variants: readonly GigOptionDto[],
  addOns: readonly GigOptionDto[],
  structure: GigTemplateStructure,
  options: ProviderGigOptionsPolicy,
  _gig: ProviderGigPolicy,
): GigIssueDto[] {
  const issues: GigIssueDto[] = [];
  const check = (kind: OptionKind, items: readonly GigOptionDto[]) => {
    if (items.length === 0) return;
    if (!optionsPermitted(kind, structure)) issues.push(optionIssue(kind, 'OPTIONS_NOT_PERMITTED'));
    else if (items.length > maxCountOf(kind, options)) issues.push(optionIssue(kind, 'OPTIONS_COUNT_EXCEEDED'));
    for (const it of items) {
      if (textLength(it.name) > options.nameMaxLength) issues.push(optionIssue(kind, 'OPTION_NAME_TOO_LONG', it.key));
      if (it.description !== null && textLength(it.description) > options.descriptionMaxLength)
        issues.push(optionIssue(kind, 'OPTION_DESCRIPTION_TOO_LONG', it.key));
    }
  };
  check('variants', variants);
  check('addOns', addOns);
  return issues;
}

/** Whether two ordered lists are semantically identical (key, text, deltas; the order is the array order). */
export function sameOptions(a: readonly GigOptionDto[], b: readonly ValidatedOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return (
        x.key === y.key &&
        x.name === y.name &&
        x.description === y.description &&
        x.priceDeltaMinor === y.priceDeltaMinor &&
        x.durationDeltaMinutes === y.durationDeltaMinutes &&
        x.displayOrder === y.displayOrder
      );
    })
  );
}

/** Writes a whole list of one kind for a DRAFT version (the caller's transaction, which has deleted the previous list). The database guards re-check the draft state and the template permission. */
export async function insertOptions(trx: Executor, kind: OptionKind, versionId: string, items: readonly ValidatedOption[]): Promise<void> {
  if (items.length === 0) return;
  const keys = items.map((i) => i.key);
  const names = items.map((i) => i.name);
  const descriptions = items.map((i) => i.description);
  const prices = items.map((i) => i.priceDeltaMinor);
  const durations = items.map((i) => i.durationDeltaMinutes);
  const orders = items.map((i) => i.displayOrder);
  if (kind === 'variants')
    await sql`INSERT INTO provider.gig_version_variants (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
      SELECT ${versionId}::uuid, k, n, d, p, m, o
        FROM unnest(${keys}::text[], ${names}::text[], ${descriptions}::text[], ${prices}::bigint[], ${durations}::integer[], ${orders}::integer[]) AS t(k, n, d, p, m, o)
       ORDER BY o`.execute(trx);
  else
    await sql`INSERT INTO provider.gig_version_add_ons (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
      SELECT ${versionId}::uuid, k, n, d, p, m, o
        FROM unnest(${keys}::text[], ${names}::text[], ${descriptions}::text[], ${prices}::bigint[], ${durations}::integer[], ${orders}::integer[]) AS t(k, n, d, p, m, o)
       ORDER BY o`.execute(trx);
}

/** Removes every item of one kind of a DRAFT version. */
export async function deleteOptions(trx: Executor, kind: OptionKind, versionId: string): Promise<void> {
  if (kind === 'variants') await sql`DELETE FROM provider.gig_version_variants WHERE gig_version_id = ${versionId}`.execute(trx);
  else await sql`DELETE FROM provider.gig_version_add_ons WHERE gig_version_id = ${versionId}`.execute(trx);
}

/** Starts the next draft: copies the variants and add-ons (same keys, same order) from the published version. Runs inside the caller's transaction. */
export async function copyOptions(trx: Executor, fromVersionId: string, toVersionId: string): Promise<{ variants: number; addOns: number }> {
  const r = (
    await sql<OptionRow>`WITH v AS (
        INSERT INTO provider.gig_version_variants (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
        SELECT ${toVersionId}::uuid, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order
          FROM provider.gig_version_variants WHERE gig_version_id = ${fromVersionId} ORDER BY display_order RETURNING 1),
      a AS (
        INSERT INTO provider.gig_version_add_ons (gig_version_id, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order)
        SELECT ${toVersionId}::uuid, item_key, name, description, price_delta_minor, duration_delta_minutes, display_order
          FROM provider.gig_version_add_ons WHERE gig_version_id = ${fromVersionId} ORDER BY display_order RETURNING 1)
      SELECT (SELECT count(*) FROM v) AS variants, (SELECT count(*) FROM a) AS add_ons`.execute(trx)
  ).rows[0]!;
  return { variants: Number(r.variants), addOns: Number(r.add_ons) };
}
