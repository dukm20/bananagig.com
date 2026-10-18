import type { ReactNode } from 'react';
import type { GigOptionDto, GigVersionDto } from '@bananagig/contracts';
import { gigKey } from '../../../../lib/provider-gigs';
import type { Text } from './version-view';

/** `provider.gig.options.<suffix>` */
export const optionsKey = (suffix: string): string => gigKey(`options.${suffix}`);

export type OptionsKind = 'variants' | 'addOns';
const SHARED = [
  'empty',
  'not_permitted',
  'name',
  'description',
  'price_delta',
  'duration_delta',
  'add',
  'remove',
  'move_up',
  'move_down',
  'save',
  'limit_note',
  'delta_note',
];

/** The registry keys the variants and add-ons editors need. */
export const optionsCopyKeys = (): string[] => [
  ...['variants.heading', 'variants.intro', 'add_ons.heading', 'add_ons.intro', ...SHARED].map(optionsKey),
  gigKey('editor.issues_heading'),
];

/** The ids of the issues (when they are shown on the page) that are about this list as a whole, or about the item with this key. */
function issueIds(draft: GigVersionDto, text: Text, kind: OptionsKind, key?: string): string[] {
  if (!text(gigKey('editor.issues_heading'))) return [];
  const out: string[] = [];
  draft.issues.forEach((issue, n) => {
    if (issue.target !== kind || !text(issue.messageKey)) return;
    if (key === undefined ? issue.itemKey === undefined : issue.itemKey === key) out.push(`gig-issue-${n}`);
  });
  return out;
}

/** A note followed by a value: the note's own full stop is kept ("…shown next to this list. 3 / 10"); a note without end punctuation gets a colon ("Photos: 2"). */
export function NoteWithValue({ note, value }: { note: ReactNode; value: ReactNode }) {
  const closed = typeof note === 'string' && /[.!?:;…。！？]$/.test(note.trim());
  return closed ? (
    <>
      {note} <span className="gig-values">{value}</span>
    </>
  ) : (
    <>
      {note}: {value}
    </>
  );
}

/** The alert of a refused save that names a problem: its id, what it is about (a section, and an item of it when the API named one). */
export interface AlertTarget {
  id: string;
  target: string;
  item: string | undefined;
}

interface Props {
  gigId: string;
  draft: GigVersionDto;
  kind: OptionsKind;
  text: Text;
  alert?: AlertTarget | undefined;
  /** The message of the notice or alert that is about this section, repeated here in sight (hidden from assistive technology: the live regions announce it). */
  echo?: string | undefined;
}

/**
 * The variants or the add-ons of the draft: ONE whole-set no-JS form. Each row has a name, a description, a price delta (minor units, the same convention as the base price) and a
 * duration delta (minutes); Remove / Move up / Move down are submit buttons whose `intent` the handler applies to the submitted rows before it saves the whole list. A trailing
 * "new item" row (while the limit allows) is saved when it is filled in and ignored when it is blank. The first submit button in the form is a hidden, unfocusable Save, so pressing
 * Enter in a text box saves and never removes or moves a row. Provider text is rendered as React text nodes and attribute values only.
 */
export function OptionsEditor({ gigId, draft, kind, text, alert, echo }: Props) {
  const variants = kind === 'variants';
  const prefix = variants ? 'variants' : 'add_ons';
  const id = variants ? 'gig-variants' : 'gig-add-ons';
  const limits = variants ? draft.constraints.variants : draft.constraints.addOns;
  const items: GigOptionDto[] = [...(variants ? draft.variants : draft.addOns)].sort((a, b) => a.displayOrder - b.displayOrder);
  const heading = text(optionsKey(`${prefix}.heading`));
  const intro = text(optionsKey(`${prefix}.intro`));
  const t = (s: string): ReactNode => text(optionsKey(s));
  const labelName = t('name');
  const save = t('save');
  const sectionIssues = issueIds(draft, text, kind);
  const deltaNote = t('delta_note');
  // a template that takes no duration has no use for a duration delta: the control is not offered (the value is kept as it is)
  const durationLabel = draft.constraints.duration.permitted ? t('duration_delta') : null;
  const sectionAlert = alert && alert.target === kind ? alert : undefined;
  const deltaNoteId = `${id}-delta-note`;
  const room = items.length < limits.maxCount && limits.permitted;
  const rows = room ? items.length + 1 : items.length;
  const editable = labelName && save && (limits.permitted || items.length > 0);
  const label = (rowId: string, node: ReactNode): ReactNode => (node ? <label htmlFor={rowId}>{node}</label> : null);

  /** One row: the existing item `i` (with `item`) or the blank "new item" row (without). */
  const row = (i: number, item: GigOptionDto | undefined): ReactNode => {
    const rid = `${id}-${i}`;
    const own = [...(item ? issueIds(draft, text, kind, item.key) : []), ...(sectionAlert && item && sectionAlert.item === item.key ? [sectionAlert.id] : [])];
    const bad = own.length > 0;
    const describeDelta = deltaNote ? { 'aria-describedby': deltaNoteId } : {};
    const hidden = (part: string, value: string): ReactNode => <input type="hidden" name={`row.${i}.${part}`} value={value} />;
    const control = (part: 'description' | 'price' | 'duration', labelNode: ReactNode, node: ReactNode, value: string): ReactNode =>
      labelNode ? (
        <div className="gig-field">
          {label(`${rid}-${part}`, labelNode)}
          {node}
        </div>
      ) : (
        hidden(part, value)
      );
    const legend = item ? (
      <>
        {i + 1}
        {item.name ? <>: {item.name}</> : null}
      </>
    ) : (
      t('add')
    );
    return (
      <li key={item ? item.key : 'new'} className="gig-option">
        <fieldset aria-labelledby={`${rid}-legend`}>
          <legend id={`${rid}-legend`}>{legend}</legend>
          {item ? hidden('key', item.key) : null}
          <div className="gig-field">
            {label(`${rid}-name`, labelName)}
            <input
              type="text"
              id={`${rid}-name`}
              name={`row.${i}.name`}
              defaultValue={item?.name ?? ''}
              maxLength={limits.nameMaxLength}
              {...(bad ? { 'aria-describedby': own.join(' '), 'aria-invalid': true as const } : {})}
            />
          </div>
          {control(
            'description',
            t('description'),
            <textarea
              id={`${rid}-description`}
              name={`row.${i}.description`}
              rows={2}
              defaultValue={item?.description ?? ''}
              maxLength={limits.descriptionMaxLength}
            />,
            item?.description ?? '',
          )}
          {control(
            'price',
            t('price_delta'),
            <input
              type="text"
              id={`${rid}-price`}
              name={`row.${i}.price`}
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={item ? String(item.priceDeltaMinor) : ''}
              {...describeDelta}
            />,
            item ? String(item.priceDeltaMinor) : '',
          )}
          {control(
            'duration',
            durationLabel,
            <input
              type="text"
              id={`${rid}-duration`}
              name={`row.${i}.duration`}
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={item ? String(item.durationDeltaMinutes) : ''}
              {...describeDelta}
            />,
            item ? String(item.durationDeltaMinutes) : '',
          )}
          {item ? (
            <div className="gig-actions">
              {i > 0 && t('move_up') ? (
                <button type="submit" id={`${rid}-up`} aria-labelledby={`${rid}-up ${rid}-legend`} name="intent" value={`up:${i}`}>
                  {t('move_up')}
                </button>
              ) : null}
              {i < items.length - 1 && t('move_down') ? (
                <button type="submit" id={`${rid}-down`} aria-labelledby={`${rid}-down ${rid}-legend`} name="intent" value={`down:${i}`}>
                  {t('move_down')}
                </button>
              ) : null}
              {t('remove') ? (
                <button type="submit" id={`${rid}-remove`} aria-labelledby={`${rid}-remove ${rid}-legend`} name="intent" value={`remove:${i}`}>
                  {t('remove')}
                </button>
              ) : null}
            </div>
          ) : t('add') ? (
            <div className="gig-actions">
              <button type="submit" name="intent" value="add">
                {t('add')}
              </button>
            </div>
          ) : null}
        </fieldset>
      </li>
    );
  };

  if (!heading) return null;
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="gig-children" tabIndex={-1}>
      <h3 id={`${id}-heading`}>{heading}</h3>
      {echo ? (
        <p className="gig-note" aria-hidden="true">
          {echo}
        </p>
      ) : null}
      {intro ? <p className="muted">{intro}</p> : null}
      {!limits.permitted && t('not_permitted') ? <p>{t('not_permitted')}</p> : null}
      {limits.permitted && items.length === 0 && t('empty') ? <p>{t('empty')}</p> : null}
      {limits.permitted && t('limit_note') ? (
        <p className="muted">
          <NoteWithValue note={t('limit_note')} value={`${items.length} / ${limits.maxCount}`} />
        </p>
      ) : null}
      {deltaNote && limits.permitted ? (
        <p id={deltaNoteId} className="muted">
          {deltaNote}
        </p>
      ) : null}
      {editable ? (
        <form
          method="post"
          action={`/auth/provider/gigs/${variants ? 'variants' : 'add-ons'}`}
          noValidate
          {...(sectionIssues.length > 0 || (sectionAlert && !sectionAlert.item)
            ? { 'aria-describedby': [...sectionIssues, ...(sectionAlert && !sectionAlert.item ? [sectionAlert.id] : [])].join(' ') }
            : {})}
        >
          <input type="hidden" name="gigId" value={gigId} />
          <input type="hidden" name="expectedRevision" value={draft.revision} />
          {/* the FIRST submit button of the form is the default one (Enter in a text box): it must save, never remove or move a row */}
          <button type="submit" name="intent" value="save" tabIndex={-1} aria-hidden="true" className="gig-default-submit">
            {save}
          </button>
          {rows > 0 ? (
            <ol className="gig-options">
              {items.map((item, i) => row(i, item))}
              {room ? row(items.length, undefined) : null}
            </ol>
          ) : null}
          <button type="submit" name="intent" value="save">
            {save}
          </button>
        </form>
      ) : null}
    </section>
  );
}
