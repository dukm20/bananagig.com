import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { gigIssueKey, gigMediaRefusedKey, gigVersionStatusKey, type GigDetailDto, type GigIssueDto } from '@bananagig/contracts';
import { GIG_ISSUE_TARGETS, isGigIssueReason, isGigMediaRefusalReason, itemWordOf } from '../../../../lib/auth/gig-handlers';
import { getSession } from '../../../../lib/auth/handlers';
import { authDeps } from '../../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../../lib/content';
import { GENERIC_GIG_ERROR_KEY, GIG_ERROR_KEYS, GIG_NOTICE_KEYS, UUID, day, gigCopy, gigKey, loadGig, one } from '../../../../lib/provider-gigs';
import { serverApi } from '../../../../lib/server';
import { DraftEditor, editorCopyKeys } from '../_components/draft-editor';
import { MediaEditor, mediaCopyKeys } from '../_components/media-editor';
import { OptionsEditor, optionsCopyKeys } from '../_components/options-editor';
import { VersionView, versionCopyKeys } from '../_components/version-view';

// One Gig of the provider (CAT-003): the published version, the editable draft, what stands in the way of publishing, the history, "next draft" and "retire". A deliberately
// MINIMAL, server-rendered page. It decides nothing: whether Publish is OFFERED is what the API computed for the draft (`publishable`), the issues listed are the API's, and the
// server decides again on every POST. Every platform string is registry copy (`provider.gig.*`); what the provider wrote is rendered as plain text nodes only (never as markup).
// Another account's Gig is a 404 from the API and the same not-found page here. No script; nothing in the URL is echoed except through closed lists of words.
export const metadata: Metadata = { title: 'Gig', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const k = gigKey;
interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
  /** A named problem of a refused value (CAT-004): a closed reason, a closed target and a safe item identifier; shown only with GIG_VALIDATION_FAILED. */
  issue?: string | string[];
  target?: string | string[];
  item?: string | string[];
  /** A closed refusal reason of a photo (GIG_MEDIA_REFUSED only). */
  reason?: string | string[];
}

/** Where an issue's link goes: the control it is about. */
const anchorOf = (i: GigIssueDto): string | undefined => {
  const t = i.target;
  if (t === 'title') return '#gig-title';
  if (t === 'shortPitch') return '#gig-short-pitch';
  if (t === 'description') return '#gig-description';
  if (t === 'price') return '#gig-price';
  if (t === 'duration') return '#gig-duration';
  if (t === 'variants') return '#gig-variants';
  if (t === 'addOns') return '#gig-add-ons';
  if (t === 'media') return i.fieldKey ? `#gig-photos-${i.fieldKey}` : '#gig-photos';
  return t === 'field' && i.fieldKey ? `#gig-field-${i.fieldKey}` : undefined;
};

export default async function ProviderGigPage({ params, searchParams }: { params: Promise<{ gigId: string }>; searchParams: Promise<SearchParams> }) {
  const { gigId: rawId } = await params;
  if (!UUID.test(rawId)) notFound();
  const gigId = rawId;
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([k('editor.heading'), 'common.action.sign_in']);
    const title = renderContent(copy[k('editor.heading')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href={`/auth/login?returnTo=/provider/gigs/${gigId}`}>{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const o = { activeRole: session.record.activeRole };
  const result = await loadGig<GigDetailDto>(() => api.getGig(gigId, o));
  if (!result.ok && result.status === 404) notFound(); // not found, or not the caller's: the same answer
  const detail = result.ok ? result.value : null;
  const gig = detail?.gig ?? null;
  const current = detail?.currentVersion ?? null;
  const draft = detail && detail.gig.status !== 'RETIRED' && detail.draftVersion?.status === 'DRAFT' ? detail.draftVersion : null;
  const retired = gig?.status === 'RETIRED';
  const canStartDraft = gig !== null && gig.status === 'ACTIVE' && draft === null;

  const noticeWord = one(query.notice);
  // a notice is only shown when the data proves what it claims (the words in the URL can be typed by anyone)
  const noticeKey =
    noticeWord !== undefined &&
    Object.hasOwn(GIG_NOTICE_KEYS, noticeWord) &&
    detail !== null &&
    (noticeWord === 'created' ||
      ((noticeWord === 'saved' || noticeWord === 'draft_created') && draft !== null) ||
      ((noticeWord === 'variants_saved' ||
        noticeWord === 'add_ons_saved' ||
        noticeWord === 'photo_removed' ||
        noticeWord === 'photo_order_saved' ||
        noticeWord === 'photo_saved') &&
        draft !== null) ||
      (noticeWord === 'photo_added' && draft !== null && draft.media.length > 0) ||
      (noticeWord === 'published' && current !== null) ||
      (noticeWord === 'retired' && retired))
      ? GIG_NOTICE_KEYS[noticeWord]
      : undefined;
  const errorWord = one(query.error);
  const errorKey = errorWord !== undefined ? (Object.hasOwn(GIG_ERROR_KEYS, errorWord) ? GIG_ERROR_KEYS[errorWord] : GENERIC_GIG_ERROR_KEY) : undefined;
  const everythingDown = !result.ok;
  // the problem the handler named: all three words are checked against closed lists or a strict identifier pattern, and the message is registry copy
  const issueWord = one(query.issue);
  const targetWord = one(query.target);
  const flagged =
    errorWord === 'GIG_VALIDATION_FAILED' && isGigIssueReason(issueWord) && targetWord !== undefined && GIG_ISSUE_TARGETS.includes(targetWord)
      ? { reason: issueWord, target: targetWord, item: itemWordOf(one(query.item)) }
      : undefined;
  // the specific reason a photo was refused: a closed word of the contract's list, shown through its registry key (the generic refused message when the registry has none)
  const reasonWord = one(query.reason);
  const refusalKey = errorWord === 'GIG_MEDIA_REFUSED' && isGigMediaRefusalReason(reasonWord) ? gigMediaRefusedKey(reasonWord) : undefined;

  const text = await gigCopy([
    k('editor.heading'),
    k('editor.back'),
    ...(noticeKey ? [noticeKey] : []),
    ...(errorKey ? [errorKey] : everythingDown ? [GENERIC_GIG_ERROR_KEY] : []),
    ...(flagged ? [gigIssueKey(flagged.reason)] : []),
    ...(refusalKey ? [refusalKey] : []),
    ...(detail
      ? [
          detail.gig.nameContentKey,
          detail.gig.statusKey,
          k('editor.history_heading'),
          k('editor.version'),
          k('editor.published_at'),
          ...detail.versions.map((v) => gigVersionStatusKey(v.status)),
          ...(current ? [k('editor.current_heading'), ...versionCopyKeys(current)] : []),
          ...(draft
            ? [
                k('editor.draft_heading'),
                k('editor.issues_heading'),
                k('editor.publish'),
                ...editorCopyKeys(draft),
                ...optionsCopyKeys(),
                ...mediaCopyKeys(),
                ...draft.issues.map((i) => i.messageKey),
              ]
            : []),
          ...(canStartDraft ? [k('editor.new_draft')] : []),
          ...(!retired ? [k('editor.retire'), k('editor.retire_note')] : [k('editor.not_editable')]),
        ]
      : []),
  ]);

  const failureText = (refusalKey ? text(refusalKey) : null) ?? (errorKey ? text(errorKey) : everythingDown ? text(GENERIC_GIG_ERROR_KEY) : null);
  const issueText = flagged ? text(gigIssueKey(flagged.reason)) : null;
  // the alert says what failed and, when the problem is named, which rule was broken (both registry copy)
  const failure = failureText && issueText ? `${failureText} ${issueText}` : (failureText ?? issueText);
  const alert = failure && flagged ? { id: 'gig-error', target: flagged.target, item: flagged.item } : undefined;
  const notice = noticeKey ? text(noticeKey) : null;
  // a visible copy of the notice or the alert inside the section it is about (the redirect lands on that section, so the message at the top of the page may be out of sight);
  // it is hidden from assistive technology because the live regions above already announce it
  const sectionOf = (word: string | undefined): string | undefined =>
    word === 'variants_saved' ? 'variants' : word === 'add_ons_saved' ? 'addOns' : word?.startsWith('photo_') ? 'media' : undefined;
  const echoSection = noticeKey ? sectionOf(noticeWord) : flagged ? flagged.target : errorWord?.startsWith('GIG_MEDIA_') ? 'media' : undefined;
  const echoText = noticeKey ? notice : failure;
  const echoFor = (section: string): string | undefined => (echoSection === section && echoText ? String(echoText) : undefined);
  const title = text(k('editor.heading'));
  const errorId = 'gig-error';
  const issues = draft ? draft.issues.map((issue, n) => ({ issue, n, message: text(issue.messageKey) })).filter((x) => x.message) : [];
  const issuesShown = issues.length > 0 && text(k('editor.issues_heading')) !== null;
  const describedBy = [...(failure ? [errorId] : []), ...(issuesShown ? ['gig-issues'] : [])];
  const formDescribedBy = describedBy.length > 0 ? { 'aria-describedby': describedBy.join(' ') } : {};

  return (
    <div className="provider-registration provider-gigs">
      {text(k('editor.back')) ? (
        <p>
          <a href="/provider/gigs">{text(k('editor.back'))}</a>
        </p>
      ) : null}
      {title ? <h1>{title}</h1> : null}
      {failure ? (
        <p id={errorId} role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}

      {detail ? (
        <>
          {text(detail.gig.nameContentKey) ? <h2>{text(detail.gig.nameContentKey)}</h2> : null}
          {text(detail.gig.statusKey) ? <p className="gig-status">{text(detail.gig.statusKey)}</p> : null}

          {draft ? (
            <section aria-labelledby="gig-draft">
              {text(k('editor.draft_heading')) ? <h2 id="gig-draft">{text(k('editor.draft_heading'))}</h2> : null}
              {issuesShown ? (
                <section id="gig-issues" aria-labelledby="gig-issues-heading" tabIndex={-1}>
                  <h3 id="gig-issues-heading">{text(k('editor.issues_heading'))}</h3>
                  <ul>
                    {issues.map(({ issue, n, message }) => {
                      const anchor = anchorOf(issue);
                      return (
                        <li key={n} id={`gig-issue-${n}`}>
                          {anchor ? <a href={anchor}>{message}</a> : message}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              <DraftEditor gigId={gigId} draft={draft} text={text} formDescribedBy={describedBy} />
              <OptionsEditor gigId={gigId} draft={draft} kind="variants" text={text} alert={alert} echo={echoFor('variants')} />
              <OptionsEditor gigId={gigId} draft={draft} kind="addOns" text={text} alert={alert} echo={echoFor('addOns')} />
              <MediaEditor gigId={gigId} draft={draft} text={text} alert={alert} echo={echoFor('media')} />
              {draft.publishable === true && text(k('editor.publish')) ? (
                <form method="post" action="/auth/provider/gigs/publish" {...formDescribedBy}>
                  <input type="hidden" name="gigId" value={gigId} />
                  <input type="hidden" name="expectedRevision" value={draft.revision} />
                  <button type="submit">{text(k('editor.publish'))}</button>
                </form>
              ) : null}
            </section>
          ) : null}

          {canStartDraft && text(k('editor.new_draft')) ? (
            <form method="post" action="/auth/provider/gigs/draft" {...(failure ? { 'aria-describedby': errorId } : {})}>
              <input type="hidden" name="gigId" value={gigId} />
              <button type="submit">{text(k('editor.new_draft'))}</button>
            </form>
          ) : null}
          {retired && text(k('editor.not_editable')) ? <p>{text(k('editor.not_editable'))}</p> : null}

          {current ? (
            <section aria-labelledby="gig-current">
              {text(k('editor.current_heading')) ? <h2 id="gig-current">{text(k('editor.current_heading'))}</h2> : null}
              <VersionView version={current} text={text} gigId={gigId} />
            </section>
          ) : null}

          {detail.versions.length > 0 && text(k('editor.history_heading')) ? (
            <section aria-labelledby="gig-history">
              <h2 id="gig-history">{text(k('editor.history_heading'))}</h2>
              <ul className="gig-history">
                {detail.versions.map((v) => (
                  <li key={v.gigVersionId}>
                    <a href={`/provider/gigs/${gigId}/versions/${v.versionNumber}`}>
                      {text(k('editor.version'))} {v.versionNumber}
                    </a>{' '}
                    {text(gigVersionStatusKey(v.status)) ? <span className="gig-status">{text(gigVersionStatusKey(v.status))}</span> : null}
                    {v.publishedAt && text(k('editor.published_at')) ? (
                      <span>
                        {' '}
                        ({text(k('editor.published_at'))} {day(v.publishedAt)})
                      </span>
                    ) : null}
                    {v.title ? <span>: {v.title}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!retired && text(k('editor.retire')) ? (
            <section aria-labelledby="gig-retire">
              <h2 id="gig-retire">{text(k('editor.retire'))}</h2>
              {text(k('editor.retire_note')) ? <p id="gig-retire-note">{text(k('editor.retire_note'))}</p> : null}
              <form method="post" action="/auth/provider/gigs/retire" {...(text(k('editor.retire_note')) ? { 'aria-describedby': 'gig-retire-note' } : {})}>
                <input type="hidden" name="gigId" value={gigId} />
                <button type="submit">{text(k('editor.retire'))}</button>
              </form>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
