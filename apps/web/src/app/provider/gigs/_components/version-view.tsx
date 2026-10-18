import type { ReactNode } from 'react';
import type { GigFieldDto, GigFieldValue, GigVersionDto } from '@bananagig/contracts';
import { day, gigKey } from '../../../../lib/provider-gigs';

/** Resolves a registry key to its text (or nothing when the registry cannot serve it). */
export type Text = (key: string | null | undefined) => ReactNode;

/** The registry keys a read-only version needs (labels of the page, the status, the field labels, default texts and option labels). */
export function versionCopyKeys(v: GigVersionDto): string[] {
  return [
    v.template.nameContentKey,
    v.statusKey,
    gigKey('editor.version'),
    gigKey('editor.template'),
    gigKey('editor.template_version'),
    gigKey('editor.published_at'),
    gigKey('editor.title'),
    gigKey('editor.short_pitch'),
    gigKey('editor.description'),
    gigKey('editor.price'),
    gigKey('editor.duration'),
    gigKey('editor.yes'),
    gigKey('editor.no'),
    gigKey('editor.fixed_heading'),
    gigKey('editor.fixed_note'),
    gigKey('editor.fields_heading'),
    ...v.fields.flatMap((f) => [
      f.labelContentKey,
      ...(f.defaultContentKey ? [f.defaultContentKey] : []),
      ...f.options.flatMap((o) => (o.labelContentKey ? [o.labelContentKey] : [])),
    ]),
  ];
}

const valueOf = (v: GigVersionDto, f: GigFieldDto): GigFieldValue | undefined => v.fieldValues.find((x) => x.fieldKey === f.fieldKey)?.value ?? undefined;

/** The provider's value of a field as text: a boolean as the registry's yes/no, an option as its label (its code when the registry has none), anything else as is. Provider text stays a plain string. */
function show(text: Text, f: GigFieldDto, value: GigFieldValue | undefined): ReactNode {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return text(gigKey(value ? 'editor.yes' : 'editor.no'));
  if (f.fieldType === 'ENUM') return text(f.options.find((o) => o.optionCode === value)?.labelContentKey) ?? String(value);
  return String(value);
}

/** The template's own (platform-fixed) value of a field: its default. */
function fixedValue(text: Text, f: GigFieldDto): ReactNode {
  if (f.defaultContentKey) return text(f.defaultContentKey);
  if (f.defaultBoolean !== null) return text(gigKey(f.defaultBoolean ? 'editor.yes' : 'editor.no'));
  if (f.defaultNumber !== null) return String(f.defaultNumber);
  if (f.defaultOption !== null) return text(f.options.find((o) => o.optionCode === f.defaultOption)?.labelContentKey) ?? f.defaultOption;
  return null;
}

function Row({ label, children, id }: { label: ReactNode; children: ReactNode; id?: string }) {
  if (!label || children === null || children === undefined || children === '') return null;
  return (
    <div className="gig-row" id={id}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A read-only version: the provider's own copy and values, the price and duration the server stored, and the template facts. Provider text is rendered as React text nodes only
 * (escaped; newlines kept by CSS); there is no HTML injection anywhere in this component.
 */
export function VersionView({ version: v, text }: { version: GigVersionDto; text: Text }) {
  const editable = v.fields.filter((f) => f.supported && !f.fixed);
  const fixed = v.fields.filter((f) => f.fixed);
  const own = editable.map((f) => ({ f, shown: show(text, f, valueOf(v, f)) })).filter((x) => x.shown !== null);
  const fixedRows = fixed.map((f) => ({ f, shown: fixedValue(text, f) })).filter((x) => x.shown !== null);
  return (
    <>
      {text(v.statusKey) ? <p className="gig-status">{text(v.statusKey)}</p> : null}
      <dl className="gig-facts">
        <Row label={text(gigKey('editor.version'))}>{v.versionNumber}</Row>
        <Row label={text(gigKey('editor.template'))}>{text(v.template.nameContentKey)}</Row>
        <Row label={text(gigKey('editor.template_version'))}>{v.template.gigTemplateVersionNumber}</Row>
        <Row label={text(gigKey('editor.published_at'))}>{day(v.publishedAt)}</Row>
        <Row label={text(gigKey('editor.title'))}>{v.title}</Row>
        <Row label={text(gigKey('editor.short_pitch'))}>{v.shortPitch === null ? null : <span className="gig-text">{v.shortPitch}</span>}</Row>
        <Row label={text(gigKey('editor.description'))}>{v.description === null ? null : <span className="gig-text">{v.description}</span>}</Row>
        <Row label={text(gigKey('editor.price'))}>{v.price ? `${v.price.amountMinor} ${v.price.currency}` : null}</Row>
        <Row label={text(gigKey('editor.duration'))}>{v.durationMinutes}</Row>
      </dl>
      {own.length > 0 && text(gigKey('editor.fields_heading')) ? (
        <>
          <h3>{text(gigKey('editor.fields_heading'))}</h3>
          <dl className="gig-facts">
            {own.map(({ f, shown }) => (
              <Row key={f.fieldKey} label={text(f.labelContentKey) ?? f.fieldKey}>
                <span className="gig-text">{shown}</span>
              </Row>
            ))}
          </dl>
        </>
      ) : null}
      {fixedRows.length > 0 && text(gigKey('editor.fixed_heading')) ? (
        <>
          <h3>{text(gigKey('editor.fixed_heading'))}</h3>
          {text(gigKey('editor.fixed_note')) ? <p className="muted">{text(gigKey('editor.fixed_note'))}</p> : null}
          <dl className="gig-facts">
            {fixedRows.map(({ f, shown }) => (
              <Row key={f.fieldKey} label={text(f.labelContentKey) ?? f.fieldKey}>
                {shown}
              </Row>
            ))}
          </dl>
        </>
      ) : null}
    </>
  );
}
