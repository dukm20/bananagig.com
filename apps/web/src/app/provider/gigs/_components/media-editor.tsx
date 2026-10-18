import type { ReactNode } from 'react';
import type { GigFieldDto, GigMediaDto, GigVersionDto } from '@bananagig/contracts';
import { gigKey } from '../../../../lib/provider-gigs';
import { NoteWithValue, type AlertTarget } from './options-editor';
import type { Text } from './version-view';

/** `provider.gig.media.<suffix>` */
export const mediaKey = (suffix: string): string => gigKey(`media.${suffix}`);

const MEDIA_KEYS = [
  'heading',
  'intro',
  'rule_required',
  'rule_optional',
  'rule_prohibited',
  'no_field',
  'count',
  'status_uploading',
  'status_ready',
  'upload',
  'file',
  'alt_text',
  'alt_hint',
  'save_alt',
  'remove',
  'move_up',
  'move_down',
  'finish',
  'preview',
  'types_note',
  'size_note',
  'unavailable',
];
/** The registry keys the Photos section needs (the field labels are listed by the caller with the other template copy). */
export const mediaCopyKeys = (): string[] => [...MEDIA_KEYS.map(mediaKey), gigKey('editor.issues_heading')];

/** The MEDIA fields a provider can attach photos to (platform-fixed ones belong to the template). */
export const mediaFieldsOf = (v: GigVersionDto): GigFieldDto[] =>
  v.fields.filter((f) => f.fieldType === 'MEDIA' && f.supported && !f.fixed).sort((a, b) => a.displayOrder - b.displayOrder);

/** Where the controlled thumbnail route serves a photo: the draft's (no version) or a version's. Same origin; the route answers a 303 to a short-lived target. */
export const photoPath = (gigId: string, mediaId: string, version?: number): string =>
  `/provider/gigs/${gigId}/media/${mediaId}${version === undefined ? '' : `?version=${version}`}`;

const byOrder = (a: GigMediaDto, b: GigMediaDto): number => a.displayOrder - b.displayOrder;

/** A thumbnail of a READY photo through the controlled route, and a text link to it. The alt text is the provider's own and is an attribute value (escaped), never markup. */
export function Photo({
  gigId,
  photo,
  version,
  text,
  captionId,
}: {
  gigId: string;
  photo: GigMediaDto;
  version?: number;
  text: Text;
  /** The id of the caption of this photo ("2 / 3", its status and alt text): the "Preview" link is named by its own text AND this caption, so the links of a list differ. */
  captionId?: string;
}) {
  if (photo.status !== 'READY') return null;
  const src = photoPath(gigId, photo.mediaId, version);
  return (
    <>
      {/* a plain img on purpose: the bytes come through the controlled same-origin route (next/image would proxy and cache them) */}
      <img
        src={src}
        alt={photo.altText ?? ''}
        loading="lazy"
        className="gig-thumb"
        {...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {})}
      />
      {text(mediaKey('preview')) ? (
        <p>
          <a href={src} {...(captionId ? { id: `${captionId}-preview`, 'aria-labelledby': `${captionId}-preview ${captionId}` } : {})}>
            {text(mediaKey('preview'))}
          </a>
        </p>
      ) : null}
    </>
  );
}

/** What names a photo wherever it is listed: its position among the photos of its field ("2 / 3"), its status as text and its alt text (the provider's own, a React text node). */
export function PhotoCaption({ id, position, count, photo, text }: { id: string; position: number; count: number; photo: GigMediaDto; text: Text }) {
  const status = text(mediaKey(photo.status === 'READY' ? 'status_ready' : 'status_uploading'));
  return (
    <p id={id}>
      <strong>
        {position + 1} / {count}
      </strong>
      {status ? <span className="gig-status"> {status}</span> : null}
      {photo.altText ? <span className="gig-text"> {photo.altText}</span> : null}
    </p>
  );
}

/** The ids of the issues (shown on the page) that are about the photos, optionally of one template field. */
function issueIds(draft: GigVersionDto, text: Text, fieldKey?: string): string[] {
  if (!text(gigKey('editor.issues_heading'))) return [];
  const out: string[] = [];
  draft.issues.forEach((issue, n) => {
    if (issue.target !== 'media' || !text(issue.messageKey)) return;
    if (fieldKey === undefined ? issue.fieldKey === undefined : issue.fieldKey === fieldKey) out.push(`gig-issue-${n}`);
  });
  return out;
}

const megabytes = (bytes: number): string => (bytes >= 1_048_576 ? `${Math.floor(bytes / 1_048_576)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);

interface Props {
  gigId: string;
  draft: GigVersionDto;
  text: Text;
  alert?: AlertTarget | undefined;
  /** The message of the notice or alert that is about this section, repeated here in sight (hidden from assistive technology: the live regions announce it). */
  echo?: string | undefined;
}

/**
 * The Photos section of the draft: per MEDIA field of the bound template version the RULE as text (required, optional or not available, with the numbers), the photos with their
 * status as text (Uploading or Ready), a thumbnail through the controlled route, an alt text form, Remove / Move up / Move down / Finish as plain POST forms, and an upload form
 * (`multipart/form-data`: file, alt text) while the field and the version have room. No script, no drag-and-drop, nothing that depends on colour.
 */
export function MediaEditor({ gigId, draft, text, alert, echo }: Props) {
  const heading = text(mediaKey('heading'));
  if (!heading) return null;
  const t = (s: string): ReactNode => text(mediaKey(s));
  const c = draft.constraints.media;
  const fields = mediaFieldsOf(draft);
  const all = [...draft.media].sort(byOrder);
  const totalRoom = all.length < c.maxItems;
  const sectionIssues = issueIds(draft, text);
  // an alert that names a problem of the photos but of no particular photo describes the section and the upload forms
  const sectionAlertId = alert && alert.target === 'media' && !alert.item ? alert.id : undefined;

  const hiddenIds = (mediaId: string): ReactNode => (
    <>
      <input type="hidden" name="gigId" value={gigId} />
      <input type="hidden" name="expectedRevision" value={draft.revision} />
      <input type="hidden" name="mediaId" value={mediaId} />
    </>
  );
  /** One small POST form for one photo; its button is named by its own text AND the photo's caption ("Remove" + "2 / 3 Ready Front door"). */
  const act = (action: string, mediaId: string, label: ReactNode, suffix: string, extra?: ReactNode): ReactNode => {
    const buttonId = `gig-photo-${mediaId}-${suffix}`;
    return label ? (
      <form method="post" action={`/auth/provider/gigs/${action}`} className="gig-inline-form">
        {hiddenIds(mediaId)}
        {extra}
        <button type="submit" id={buttonId} aria-labelledby={`${buttonId} gig-photo-${mediaId}`}>
          {label}
        </button>
      </form>
    ) : null;
  };

  const photoItem = (m: GigMediaDto, position: number, ofField: number, groupIssue: string[]): ReactNode => {
    const titleId = `gig-photo-${m.mediaId}`;
    const altId = `${titleId}-alt`;
    const hintId = `${titleId}-hint`;
    const flagged = alert && alert.target === 'media' && alert.item === m.mediaId;
    return (
      <li key={m.mediaId} className="gig-photo">
        <div role="group" aria-labelledby={titleId}>
          <PhotoCaption id={titleId} position={position} count={ofField} photo={m} text={text} />
          <Photo gigId={gigId} photo={m} text={text} captionId={titleId} />
          {t('alt_text') && t('save_alt') ? (
            <form method="post" action="/auth/provider/gigs/photo-alt" className="gig-field">
              {hiddenIds(m.mediaId)}
              <label htmlFor={altId}>{t('alt_text')}</label>
              {t('alt_hint') ? (
                <p id={hintId} className="muted">
                  {t('alt_hint')}
                </p>
              ) : null}
              <input
                type="text"
                id={altId}
                name="altText"
                defaultValue={m.altText ?? ''}
                maxLength={c.altTextMaxLength}
                aria-describedby={[...(t('alt_hint') ? [hintId] : []), ...groupIssue, ...(flagged && alert ? [alert.id] : []), titleId].join(' ')}
                {...(flagged ? { 'aria-invalid': true as const } : {})}
              />
              <button type="submit" id={`${titleId}-save-alt`} aria-labelledby={`${titleId}-save-alt ${titleId}`}>
                {t('save_alt')}
              </button>
            </form>
          ) : null}
          <div className="gig-actions">
            {m.status === 'UPLOADING' ? act('photo-finish', m.mediaId, t('finish'), 'finish') : null}
            {position > 0 ? act('photo-move', m.mediaId, t('move_up'), 'up', <input type="hidden" name="direction" value="up" />) : null}
            {position < ofField - 1 ? act('photo-move', m.mediaId, t('move_down'), 'down', <input type="hidden" name="direction" value="down" />) : null}
            {act('photo-remove', m.mediaId, t('remove'), 'remove')}
          </div>
        </div>
      </li>
    );
  };

  const fieldSection = (f: GigFieldDto): ReactNode => {
    const photos = all.filter((m) => m.fieldKey === f.fieldKey);
    const prohibited = f.maxItems === 0;
    const max = f.maxItems ?? c.maxItems;
    const min = f.minItems ?? (f.required ? 1 : 0);
    const rule = prohibited ? t('rule_prohibited') : f.required ? t('rule_required') : t('rule_optional');
    const fid = `gig-photos-${f.fieldKey}`;
    const issues = issueIds(draft, text, f.fieldKey);
    const room = !prohibited && photos.length < max && totalRoom && c.permitted;
    const types = c.allowedMimeTypes;
    return (
      <section key={f.fieldKey} id={fid} aria-labelledby={`${fid}-label`} className="gig-photo-field" tabIndex={-1}>
        <h4 id={`${fid}-label`}>{text(f.labelContentKey) ?? f.fieldKey}</h4>
        {rule ? <p id={`${fid}-rule`}>{rule}</p> : null}
        {!prohibited && t('count') ? (
          <p id={`${fid}-count`} className="muted">
            <NoteWithValue note={t('count')} value={`${photos.length} (${min}–${max})`} />
          </p>
        ) : null}
        {!c.permitted && !prohibited && t('unavailable') ? <p>{t('unavailable')}</p> : null}
        {photos.length > 0 ? <ol className="gig-photos">{photos.map((m, i) => photoItem(m, i, photos.length, issues))}</ol> : null}
        {room && t('upload') && t('file') ? (
          <form
            method="post"
            action={`/auth/provider/gigs/photo-upload?gigId=${gigId}`}
            encType="multipart/form-data"
            {...(issues.length > 0 || sectionAlertId ? { 'aria-describedby': [...issues, ...(sectionAlertId ? [sectionAlertId] : [])].join(' ') } : {})}
          >
            <input type="hidden" name="expectedRevision" value={draft.revision} />
            <input type="hidden" name="fieldKey" value={f.fieldKey} />
            <div className="gig-field">
              <label htmlFor={`${fid}-file`}>{t('file')}</label>
              {types.length > 0 && t('types_note') ? (
                <p id={`${fid}-types`} className="muted">
                  <NoteWithValue note={t('types_note')} value={types.join(', ')} />
                </p>
              ) : null}
              {t('size_note') ? (
                <p id={`${fid}-size`} className="muted">
                  <NoteWithValue note={t('size_note')} value={megabytes(c.maxFileSizeBytes)} />
                </p>
              ) : null}
              <input
                type="file"
                id={`${fid}-file`}
                name="file"
                required
                {...(types.length > 0 ? { accept: types.join(',') } : {})}
                aria-describedby={
                  [...(types.length > 0 && t('types_note') ? [`${fid}-types`] : []), ...(t('size_note') ? [`${fid}-size`] : [])].join(' ') || undefined
                }
              />
            </div>
            {t('alt_text') ? (
              <div className="gig-field">
                <label htmlFor={`${fid}-alt`}>{t('alt_text')}</label>
                {t('alt_hint') ? (
                  <p id={`${fid}-alt-hint`} className="muted">
                    {t('alt_hint')}
                  </p>
                ) : null}
                <input
                  type="text"
                  id={`${fid}-alt`}
                  name="altText"
                  maxLength={c.altTextMaxLength}
                  {...(t('alt_hint') ? { 'aria-describedby': `${fid}-alt-hint` } : {})}
                />
              </div>
            ) : (
              <input type="hidden" name="altText" value="" />
            )}
            <button type="submit">{t('upload')}</button>
          </form>
        ) : null}
      </section>
    );
  };

  return (
    <section
      id="gig-photos"
      aria-labelledby="gig-photos-heading"
      className="gig-children"
      tabIndex={-1}
      {...(sectionIssues.length > 0 || sectionAlertId ? { 'aria-describedby': [...sectionIssues, ...(sectionAlertId ? [sectionAlertId] : [])].join(' ') } : {})}
    >
      <h3 id="gig-photos-heading">{heading}</h3>
      {echo ? (
        <p className="gig-note" aria-hidden="true">
          {echo}
        </p>
      ) : null}
      {t('intro') ? <p className="muted">{t('intro')}</p> : null}
      {fields.length === 0 ? t('no_field') ? <p>{t('no_field')}</p> : null : fields.map(fieldSection)}
    </section>
  );
}
