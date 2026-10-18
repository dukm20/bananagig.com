import type { ReactNode } from 'react';
import type { GigFieldDto, GigFieldValue, GigVersionDto } from '@bananagig/contracts';
import { gigKey } from '../../../../lib/provider-gigs';
import type { Text } from './version-view';

/** The registry keys the editor needs on top of the read-only ones (hints, help texts, defaults and option labels). */
export function editorCopyKeys(v: GigVersionDto): string[] {
  return [
    ...[
      'title',
      'title_hint',
      'short_pitch',
      'short_pitch_hint',
      'description',
      'description_hint',
      'price',
      'price_hint',
      'currency',
      'duration',
      'duration_hint',
    ].map((k) => gigKey(`editor.${k}`)),
    ...['fields_heading', 'required', 'optional', 'save', 'unsupported_note', 'select_empty', 'draft_heading', 'yes', 'no'].map((k) => gigKey(`editor.${k}`)),
    ...v.fields.flatMap((f) => [
      f.labelContentKey,
      ...(f.helpContentKey ? [f.helpContentKey] : []),
      ...(f.defaultContentKey ? [f.defaultContentKey] : []),
      ...f.options.flatMap((o) => (o.labelContentKey ? [o.labelContentKey] : [])),
    ]),
  ];
}

/** The ids of the issues (the list of what stands in the way of publishing) that concern each editor control: `title`, `shortPitch`, `description`, `price`, `duration` or `field:<fieldKey>`. */
export function issueIdsByTarget(v: GigVersionDto): Map<string, string[]> {
  const out = new Map<string, string[]>();
  v.issues.forEach((issue, n) => {
    const target = issue.target === 'field' ? `field:${issue.fieldKey ?? ''}` : issue.target;
    out.set(target, [...(out.get(target) ?? []), `gig-issue-${n}`]);
  });
  return out;
}

/** The form-field name of a template field: `field.<kind>.<fieldKey>` (the kind says how the handler reads the string; the API validates the value against the template). */
const KIND: Partial<Record<GigFieldDto['fieldType'], string>> = {
  TEXT: 't',
  LONG_TEXT: 't',
  INTEGER: 'n',
  DURATION: 'n',
  DECIMAL: 'd',
  BOOLEAN: 'b',
  ENUM: 'e',
};
export const fieldInputName = (f: GigFieldDto): string | undefined => (KIND[f.fieldType] ? `field.${KIND[f.fieldType]}.${f.fieldKey}` : undefined);

const asText = (value: GigFieldValue | undefined): string => (value === undefined || value === null ? '' : String(value));

interface Props {
  gigId: string;
  draft: GigVersionDto;
  text: Text;
  /** Ids the form is described by (the error and the issue summary, when they are on the page). */
  formDescribedBy: string[];
}

/**
 * The draft editor: one no-JS form that posts the WHOLE editable content (title, short pitch, description, price, duration and one control per editable template field) with the
 * revision last read. Every control has a visible label bound with `for`/`id`, its hint and its issues are linked with aria-describedby, "required"/"optional" is TEXT, and the
 * platform-fixed and not-yet-supported fields are never inputs (they are shown by the page as read-only facts). A control whose registry label is missing is left out rather than
 * shown unlabelled; a template field whose label is missing is labelled with its key.
 */
export function DraftEditor({ gigId, draft, text, formDescribedBy }: Props) {
  const issues = issueIdsByTarget(draft);
  const describe = (own: Array<string | null>, target: string): { 'aria-describedby'?: string; 'aria-invalid'?: true } => {
    const ids = [...own.filter((x): x is string => x !== null), ...(issues.get(target) ?? [])];
    return { ...(ids.length > 0 ? { 'aria-describedby': ids.join(' ') } : {}), ...(issues.has(target) ? { 'aria-invalid': true as const } : {}) };
  };
  const marker = (required: boolean): ReactNode => {
    const t = text(gigKey(required ? 'editor.required' : 'editor.optional'));
    return t ? <span className="gig-req"> ({t})</span> : null;
  };
  const c = draft.constraints;
  const editable = draft.fields.filter((f) => f.supported && !f.fixed && fieldInputName(f) !== undefined).sort((a, b) => a.displayOrder - b.displayOrder);
  const unsupported = draft.fields.filter((f) => !f.supported && !f.fixed);
  const valueOf = (f: GigFieldDto): GigFieldValue | undefined => draft.fieldValues.find((x) => x.fieldKey === f.fieldKey)?.value ?? undefined;

  const control = (f: GigFieldDto): ReactNode => {
    const id = `gig-field-${f.fieldKey}`;
    const name = fieldInputName(f)!;
    const help = f.helpContentKey && text(f.helpContentKey) ? `${id}-help` : null;
    const aria = describe([help], `field:${f.fieldKey}`);
    const current = valueOf(f);
    const label = text(f.labelContentKey) ?? f.fieldKey;
    const base = { id, name, ...aria };
    let input: ReactNode;
    if (f.fieldType === 'LONG_TEXT') {
      const placeholder = f.defaultContentKey ? text(f.defaultContentKey) : null;
      input = (
        <textarea
          {...base}
          rows={4}
          defaultValue={asText(current)}
          {...(f.maxLength !== null ? { maxLength: f.maxLength } : {})}
          {...(typeof placeholder === 'string' ? { placeholder } : {})}
        />
      );
    } else if (f.fieldType === 'TEXT') {
      const placeholder = f.defaultContentKey ? text(f.defaultContentKey) : null;
      input = (
        <input
          type="text"
          {...base}
          defaultValue={asText(current)}
          {...(f.maxLength !== null ? { maxLength: f.maxLength } : {})}
          {...(typeof placeholder === 'string' ? { placeholder } : {})}
        />
      );
    } else if (f.fieldType === 'INTEGER' || f.fieldType === 'DURATION') {
      input = (
        <input
          type="number"
          inputMode="numeric"
          step={1}
          {...base}
          defaultValue={asText(current)}
          {...(f.minNumber !== null ? { min: f.minNumber } : {})}
          {...(f.maxNumber !== null ? { max: f.maxNumber } : {})}
          {...(f.defaultNumber !== null ? { placeholder: String(f.defaultNumber) } : {})}
        />
      );
    } else if (f.fieldType === 'DECIMAL') {
      input = (
        <input
          type="text"
          inputMode="decimal"
          pattern="-?[0-9]+([.][0-9]+)?"
          {...base}
          defaultValue={asText(current)}
          {...(f.defaultNumber !== null ? { placeholder: String(f.defaultNumber) } : {})}
        />
      );
    } else if (f.fieldType === 'BOOLEAN') {
      input = (
        <select {...base} defaultValue={typeof current === 'boolean' ? String(current) : ''}>
          <option value="">{text(gigKey('editor.select_empty'))}</option>
          <option value="true">{text(gigKey('editor.yes'))}</option>
          <option value="false">{text(gigKey('editor.no'))}</option>
        </select>
      );
    } else {
      input = (
        <select {...base} defaultValue={typeof current === 'string' ? current : ''}>
          <option value="">{text(gigKey('editor.select_empty'))}</option>
          {[...f.options]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((o) => (
              <option key={o.optionCode} value={o.optionCode}>
                {text(o.labelContentKey) ?? o.optionCode}
              </option>
            ))}
        </select>
      );
    }
    return (
      <div className="gig-field" key={f.fieldKey}>
        <label htmlFor={id}>
          {label}
          {marker(f.required)}
        </label>
        {help ? (
          <p id={help} className="muted">
            {text(f.helpContentKey)}
          </p>
        ) : null}
        {input}
      </div>
    );
  };

  const titleLabel = text(gigKey('editor.title'));
  const pitchLabel = text(gigKey('editor.short_pitch'));
  const descriptionLabel = text(gigKey('editor.description'));
  const priceLabel = text(gigKey('editor.price'));
  const durationLabel = text(gigKey('editor.duration'));
  const hint = (suffix: string, id: string): ReactNode =>
    text(gigKey(`editor.${suffix}`)) ? (
      <p id={id} className="muted">
        {text(gigKey(`editor.${suffix}`))}
      </p>
    ) : null;
  const hintId = (suffix: string, id: string): string | null => (text(gigKey(`editor.${suffix}`)) ? id : null);

  return (
    <form method="post" action="/auth/provider/gigs/save" noValidate {...(formDescribedBy.length > 0 ? { 'aria-describedby': formDescribedBy.join(' ') } : {})}>
      <input type="hidden" name="gigId" value={gigId} />
      <input type="hidden" name="expectedRevision" value={draft.revision} />

      {titleLabel ? (
        <div className="gig-field">
          <label htmlFor="gig-title">
            {titleLabel}
            {marker(true)}
          </label>
          {hint('title_hint', 'gig-title-hint')}
          <input
            type="text"
            id="gig-title"
            name="title"
            defaultValue={draft.title ?? ''}
            maxLength={c.title.maxLength}
            {...describe([hintId('title_hint', 'gig-title-hint')], 'title')}
          />
        </div>
      ) : (
        <input type="hidden" name="title" value={draft.title ?? ''} />
      )}
      {pitchLabel ? (
        <div className="gig-field">
          <label htmlFor="gig-short-pitch">
            {pitchLabel}
            {marker(true)}
          </label>
          {hint('short_pitch_hint', 'gig-short-pitch-hint')}
          <textarea
            id="gig-short-pitch"
            name="shortPitch"
            rows={3}
            defaultValue={draft.shortPitch ?? ''}
            maxLength={c.shortPitch.maxLength}
            {...describe([hintId('short_pitch_hint', 'gig-short-pitch-hint')], 'shortPitch')}
          />
        </div>
      ) : (
        <input type="hidden" name="shortPitch" value={draft.shortPitch ?? ''} />
      )}
      {descriptionLabel ? (
        <div className="gig-field">
          <label htmlFor="gig-description">
            {descriptionLabel}
            {marker(true)}
          </label>
          {hint('description_hint', 'gig-description-hint')}
          <textarea
            id="gig-description"
            name="description"
            rows={8}
            defaultValue={draft.description ?? ''}
            maxLength={c.description.maxLength}
            {...describe([hintId('description_hint', 'gig-description-hint')], 'description')}
          />
        </div>
      ) : (
        <input type="hidden" name="description" value={draft.description ?? ''} />
      )}

      {c.price.permitted && priceLabel ? (
        <div className="gig-field">
          <label htmlFor="gig-price">
            {priceLabel}
            {marker(c.price.required)}
          </label>
          {hint('price_hint', 'gig-price-hint')}
          {c.price.currency && text(gigKey('editor.currency')) ? (
            <p id="gig-currency">
              {text(gigKey('editor.currency'))}: {c.price.currency}
            </p>
          ) : null}
          <input
            type="text"
            id="gig-price"
            name="price"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={draft.price ? String(draft.price.amountMinor) : ''}
            {...describe([hintId('price_hint', 'gig-price-hint'), c.price.currency && text(gigKey('editor.currency')) ? 'gig-currency' : null], 'price')}
          />
        </div>
      ) : c.price.permitted ? (
        <input type="hidden" name="price" value={draft.price ? String(draft.price.amountMinor) : ''} />
      ) : null}
      {c.duration.permitted && durationLabel ? (
        <div className="gig-field">
          <label htmlFor="gig-duration">
            {durationLabel}
            {marker(c.duration.required)}
          </label>
          {hint('duration_hint', 'gig-duration-hint')}
          <input
            type="number"
            inputMode="numeric"
            step={1}
            id="gig-duration"
            name="duration"
            defaultValue={draft.durationMinutes ?? ''}
            {...(c.duration.minMinutes !== null ? { min: c.duration.minMinutes } : {})}
            {...(c.duration.maxMinutes !== null ? { max: c.duration.maxMinutes } : {})}
            {...(c.duration.suggestedMinutes !== null ? { placeholder: String(c.duration.suggestedMinutes) } : {})}
            {...describe([hintId('duration_hint', 'gig-duration-hint')], 'duration')}
          />
        </div>
      ) : c.duration.permitted ? (
        <input type="hidden" name="duration" value={draft.durationMinutes ?? ''} />
      ) : null}

      {editable.length > 0 ? (
        <fieldset className="gig-fields">
          {text(gigKey('editor.fields_heading')) ? <legend>{text(gigKey('editor.fields_heading'))}</legend> : null}
          {editable.map(control)}
        </fieldset>
      ) : null}

      {unsupported.length > 0 && text(gigKey('editor.unsupported_note')) ? (
        <ul className="gig-unsupported">
          {unsupported.map((f) => (
            <li key={f.fieldKey} id={`gig-field-${f.fieldKey}`}>
              {text(f.labelContentKey) ?? f.fieldKey}
              {marker(f.behavior === 'PROVIDER_REQUIRED')}: {text(gigKey('editor.unsupported_note'))}
            </li>
          ))}
        </ul>
      ) : null}

      {text(gigKey('editor.save')) ? <button type="submit">{text(gigKey('editor.save'))}</button> : null}
    </form>
  );
}
