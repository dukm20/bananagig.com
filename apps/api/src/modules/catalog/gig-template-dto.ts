// Gig Template API shaping (CAT-002). Like the catalogue DTOs, every mapper builds the response field by field: the service already shapes its view, but the API never relies on that
// alone. The management-only fields (status, revision, availability flag, content keys, timestamps) are added only when the route authorized the management view.
import type {
  GigTemplateDetailDto,
  GigTemplateFieldDto,
  GigTemplateListItemDto,
  GigTemplateVersionDto,
  GigTemplateVersionSummaryDto,
} from '@bananagig/contracts';
import type { GigTemplateFieldView, GigTemplateVersionSummaryView, GigTemplateVersionView, GigTemplateView } from '@bananagig/catalog';
import type { Texts } from './dto';

const mediaRule = (f: GigTemplateFieldView): GigTemplateFieldDto['mediaRule'] =>
  f.fieldType !== 'MEDIA' ? null : f.maxItems === 0 ? 'PROHIBITED' : f.behavior === 'PROVIDER_REQUIRED' ? 'REQUIRED' : 'OPTIONAL';

/** The content keys a version needs to be shown (labels, help, default texts, option labels). */
export function versionKeys(v: GigTemplateVersionView | null | undefined): string[] {
  if (!v) return [];
  return v.fields.flatMap((f) => [
    f.labelContentKey,
    ...(f.helpContentKey ? [f.helpContentKey] : []),
    ...(f.defaultContentKey ? [f.defaultContentKey] : []),
    ...f.options.map((o) => o.labelContentKey),
  ]);
}
/** The keys of the template itself: the name and description always, the instructions on a detail read. */
export function templateKeys(t: GigTemplateView, detail: boolean): string[] {
  return [
    t.nameContentKey,
    ...(t.descriptionContentKey ? [t.descriptionContentKey] : []),
    ...(detail && t.instructionsContentKey ? [t.instructionsContentKey] : []),
  ];
}

function fieldDto(f: GigTemplateFieldView, texts: Texts, management: boolean): GigTemplateFieldDto {
  return {
    fieldKey: f.fieldKey,
    fieldType: f.fieldType,
    section: f.section,
    behavior: f.behavior,
    customerVisible: f.customerVisible,
    displayOrder: f.displayOrder,
    // publication guarantees the label in the default locale; the fallback keeps a field usable if its copy is withdrawn later (management: the key, so the gap is visible)
    label: texts.get(f.labelContentKey) ?? (management ? f.labelContentKey : f.fieldKey),
    help: f.helpContentKey === null ? null : (texts.get(f.helpContentKey) ?? null),
    defaultText: f.defaultContentKey === null ? null : (texts.get(f.defaultContentKey) ?? null),
    minLength: f.minLength,
    maxLength: f.maxLength,
    minNumber: f.minNumber,
    maxNumber: f.maxNumber,
    defaultNumber: f.defaultNumber,
    defaultBoolean: f.defaultBoolean,
    minItems: f.minItems,
    maxItems: f.maxItems,
    mediaRule: mediaRule(f),
    options: f.options.map((o) => ({
      optionCode: o.optionCode,
      label: texts.get(o.labelContentKey) ?? (management ? o.labelContentKey : o.optionCode),
      isDefault: o.isDefault,
      displayOrder: o.displayOrder,
      ...(management ? { labelContentKey: o.labelContentKey } : {}),
    })),
    ...(management ? { labelContentKey: f.labelContentKey, helpContentKey: f.helpContentKey, defaultContentKey: f.defaultContentKey } : {}),
  };
}

export function versionSummaryDto(v: GigTemplateVersionSummaryView, management: boolean): GigTemplateVersionSummaryDto {
  return {
    gigTemplateVersionId: v.gigTemplateVersionId,
    versionNumber: v.versionNumber,
    duration: { minMinutes: v.duration.minMinutes, maxMinutes: v.duration.maxMinutes, suggestedMinutes: v.duration.suggestedMinutes },
    pricingModels: [...v.pricingModels],
    areaModes: [...v.areaModes],
    fieldCount: v.fieldCount,
    ...(management
      ? {
          ...(v.status !== undefined ? { status: v.status } : {}),
          ...(v.revision !== undefined ? { revision: v.revision } : {}),
          ...(v.publishedAt !== undefined ? { publishedAt: v.publishedAt } : {}),
          ...(v.closedAt !== undefined ? { closedAt: v.closedAt } : {}),
          ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
        }
      : {}),
  };
}

export function versionDto(v: GigTemplateVersionView, texts: Texts, management: boolean): GigTemplateVersionDto {
  return {
    ...versionSummaryDto(v, management),
    fields: v.fields.map((f) => fieldDto(f, texts, management)),
    requirements: v.requirements.map((q) => ({ requirementType: q.requirementType, referenceCode: q.referenceCode })),
  };
}

/**
 * PUBLIC: a template whose NAME has no published text is not offered (null). MANAGEMENT: the name falls back to the content key so an administrator can see exactly what is missing.
 */
function base(t: GigTemplateView, texts: Texts, management: boolean, detail: boolean) {
  const name = texts.get(t.nameContentKey) ?? (management ? t.nameContentKey : undefined);
  if (name === undefined) return null;
  return {
    gigTemplateId: t.gigTemplateId,
    code: t.code,
    serviceTypeCode: t.serviceTypeCode,
    categoryCode: t.categoryCode,
    name,
    description: t.descriptionContentKey === null ? null : (texts.get(t.descriptionContentKey) ?? null),
    ...(detail ? { instructions: t.instructionsContentKey === null ? null : (texts.get(t.instructionsContentKey) ?? null) } : {}),
    displayOrder: management ? t.displayOrder : (t.displayOrder as number),
    ...(management
      ? {
          ...(t.status !== undefined ? { status: t.status } : {}),
          ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
          nameContentKey: t.nameContentKey,
          descriptionContentKey: t.descriptionContentKey,
          instructionsContentKey: t.instructionsContentKey,
          ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
          ...(t.updatedAt !== undefined ? { updatedAt: t.updatedAt } : {}),
        }
      : {}),
  };
}

export function gigTemplateListItemDto(t: GigTemplateView, texts: Texts, management: boolean): GigTemplateListItemDto | null {
  const b = base(t, texts, management, false);
  if (!b) return null;
  return { ...b, activeVersion: t.activeVersion ? versionSummaryDto(t.activeVersion, management) : null };
}

export function gigTemplateDetailDto(t: GigTemplateView, texts: Texts, management: boolean): GigTemplateDetailDto | null {
  const b = base(t, texts, management, true);
  if (!b) return null;
  return {
    ...b,
    activeVersion: t.activeVersion ? versionDto(t.activeVersion, texts, management) : null,
    ...(management && t.versions ? { versions: t.versions.map((v) => versionSummaryDto(v, true)) } : {}),
  };
}
