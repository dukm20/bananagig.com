import type { ReactNode } from 'react';
import type { GigFieldDto, GigFieldValue, GigOptionDto, GigVersionDto } from '@bananagig/contracts';
import { day, gigKey } from '../../../../lib/provider-gigs';
import { Photo, PhotoCaption, mediaFieldsOf, mediaKey } from './media-editor';
import { optionsKey } from './options-editor';

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
    ...['variants.heading', 'add_ons.heading', 'description', 'price_delta', 'duration_delta'].map(optionsKey),
    ...['heading', 'status_uploading', 'status_ready', 'preview'].map(mediaKey),
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

/** A read-only list of variants or add-ons: the name, the description and the deltas, in display order. Provider text is a React text node. */
function OptionList({ items, heading, id, text, currency }: { items: GigOptionDto[]; heading: ReactNode; id: string; text: Text; currency: string | null }) {
  if (items.length === 0 || !heading) return null;
  const sorted = [...items].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{heading}</h3>
      <ol className="gig-options">
        {sorted.map((o) => (
          <li key={o.key} className="gig-option">
            <p>
              <strong>{o.name}</strong>
            </p>
            <dl className="gig-facts">
              <Row label={text(optionsKey('description'))}>{o.description === null ? null : <span className="gig-text">{o.description}</span>}</Row>
              <Row label={text(optionsKey('price_delta'))}>{currency ? `${o.priceDeltaMinor} ${currency}` : String(o.priceDeltaMinor)}</Row>
              <Row label={text(optionsKey('duration_delta'))}>{String(o.durationDeltaMinutes)}</Row>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A read-only version: the provider's own copy and values, the price and duration the server stored, and the template facts. Provider text is rendered as React text nodes only
 * (escaped; newlines kept by CSS); there is no HTML injection anywhere in this component.
 */
export function VersionView({ version: v, text, gigId }: { version: GigVersionDto; text: Text; gigId?: string }) {
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
      <OptionList
        items={v.variants}
        heading={text(optionsKey('variants.heading'))}
        id={`gig-v${v.versionNumber}-variants`}
        text={text}
        currency={v.price?.currency ?? null}
      />
      <OptionList
        items={v.addOns}
        heading={text(optionsKey('add_ons.heading'))}
        id={`gig-v${v.versionNumber}-add-ons`}
        text={text}
        currency={v.price?.currency ?? null}
      />
      {gigId && v.media.length > 0 && text(mediaKey('heading')) ? (
        <section aria-labelledby={`gig-v${v.versionNumber}-photos`}>
          <h3 id={`gig-v${v.versionNumber}-photos`}>{text(mediaKey('heading'))}</h3>
          {mediaFieldsOf(v).map((f) => {
            const photos = v.media.filter((m) => m.fieldKey === f.fieldKey).sort((a, b) => a.displayOrder - b.displayOrder);
            return photos.length === 0 ? null : (
              <div key={f.fieldKey}>
                <h4>{text(f.labelContentKey) ?? f.fieldKey}</h4>
                <ol className="gig-photos">
                  {photos.map((m, i) => (
                    <li key={m.mediaId} className="gig-photo">
                      <PhotoCaption id={`gig-v${v.versionNumber}-photo-${m.mediaId}`} position={i} count={photos.length} photo={m} text={text} />
                      <Photo gigId={gigId} photo={m} version={v.versionNumber} text={text} captionId={`gig-v${v.versionNumber}-photo-${m.mediaId}`} />
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </section>
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
