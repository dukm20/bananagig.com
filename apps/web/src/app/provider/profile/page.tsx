import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import {
  gigMediaRefusedKey,
  profileIssueKey,
  profileVisibilityKey,
  type OwnerProfileStateDto,
  type ProfileFieldName,
  type ProfileIssueReason,
} from '@bananagig/contracts';
import { getSession } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../lib/content';
import { gigKey, one } from '../../../lib/provider-gigs';
import {
  GENERIC_PROFILE_ERROR_KEY,
  PAGE_UNAVAILABLE_REGISTRATION_KEY,
  PROFILE_ERROR_KEYS,
  PROFILE_ISSUE_FIELD,
  charCount,
  isMediaRefusalReason,
  isProfileIssueReason,
  loadProfile,
  profileCopy,
  profileKey,
  REGISTRATION_TITLE_KEY,
} from '../../../lib/provider-profile';
import { serverApi } from '../../../lib/server';

// The provider's own public profile (PRO-002): a deliberately MINIMAL, server-rendered page where a signed-in provider writes the display name and the bio, adds or removes ONE photo,
// sees which facts are still missing, chooses whether the profile is shown to customers (PRIVATE or PUBLIC) and opens the preview. It decides nothing: the limits, the readiness facts
// and the visibility are what the API computed for THIS account, and the server decides again on every POST. A PUBLIC profile is NOT live and NOT bookable (Go-Live is a later
// checkpoint); the page says so in words. All platform text is registry copy; what the provider wrote is rendered as plain text nodes and attribute values only. No script; the
// counters are the stored text's length against the configured limit, as text. Nothing in the URL is echoed except through closed lists of words.
export const metadata: Metadata = { title: 'Your public profile', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

interface SearchParams {
  notice?: string | string[];
  error?: string | string[];
  /** Named problems of a refused text or an incomplete profile: closed reasons (shown only with PROFILE_VALIDATION_FAILED / PROFILE_INCOMPLETE). */
  issue?: string | string[];
  /** A closed refusal reason of a photo (PROFILE_MEDIA_REFUSED only). */
  reason?: string | string[];
}

/** Notice word -> the page-copy path of its message. */
const NOTICE_PATHS: Readonly<Record<string, string>> = {
  created: 'notice.created',
  saved: 'notice.saved',
  published: 'notice.published',
  unpublished: 'notice.unpublished',
  photo_added: 'notice.photo_added',
  photo_removed: 'notice.photo_removed',
};
const ANCHOR: Record<ProfileFieldName, string> = {
  displayName: '#profile-name',
  bio: '#profile-bio',
  photo: '#profile-photo-file',
  visibility: '#profile-visibility',
};
const many = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

/** A note followed by a value (the note's own full stop is kept; a note without end punctuation gets a colon). */
function NoteWithValue({ note, value }: { note: ReactNode; value: ReactNode }) {
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

export default async function ProviderProfilePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([profileKey('title'), 'common.action.sign_in']);
    const title = renderContent(copy[profileKey('title')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/provider/profile">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const loaded = await loadProfile<OwnerProfileStateDto>(() => api.getProviderProfile({ activeRole: session.record.activeRole }));
  const state = loaded.ok ? loaded.value : null;
  const profile = state?.profile ?? null;

  const errorWord = one(query.error);
  const errorKey =
    errorWord !== undefined ? (Object.hasOwn(PROFILE_ERROR_KEYS, errorWord) ? PROFILE_ERROR_KEYS[errorWord] : GENERIC_PROFILE_ERROR_KEY) : undefined;
  // a named problem is only shown with the error that can carry it (the words in the URL can be typed by anyone)
  const issues: ProfileIssueReason[] =
    errorWord === 'PROFILE_VALIDATION_FAILED' || errorWord === 'PROFILE_INCOMPLETE'
      ? [...new Set(many(query.issue))].filter(isProfileIssueReason).slice(0, 4)
      : [];
  const refusal = errorWord === 'PROFILE_MEDIA_REFUSED' ? one(query.reason) : undefined;
  const refusalKey = isMediaRefusalReason(refusal) ? gigMediaRefusedKey(refusal) : undefined;
  const noticeWord = one(query.notice);
  // a notice is only shown when the data proves what it claims
  const noticeProven =
    state !== null &&
    noticeWord !== undefined &&
    Object.hasOwn(NOTICE_PATHS, noticeWord) &&
    ((noticeWord === 'created' && profile !== null) ||
      (noticeWord === 'saved' && profile !== null) ||
      (noticeWord === 'published' && profile?.visibility === 'PUBLIC') ||
      (noticeWord === 'unpublished' && profile?.visibility === 'PRIVATE') ||
      (noticeWord === 'photo_added' && profile?.photo != null) ||
      (noticeWord === 'photo_removed' && profile !== null && profile.photo === null && !profile.photoPending));
  const everythingDown = !loaded.ok;
  // WHY the page could not load: an account that is not a registered provider yet is pointed to the registration; an outage gets the calm message
  const notRegistered = !loaded.ok && loaded.failure === 'registration';

  const text = await profileCopy(
    [
      'title',
      'intro',
      'name.label',
      'name.hint',
      'name.fallback_note',
      'bio.label',
      'bio.hint',
      'save',
      ...(noticeProven ? [NOTICE_PATHS[noticeWord!]!] : []),
      ...(profile
        ? [
            'photo.heading',
            'photo.hint',
            'photo.upload',
            'photo.remove',
            'photo.none',
            'visibility.heading',
            'visibility.save_first_note',
            'visibility.also_shown_note',
            'visibility.view_public',
            'visibility.private_note',
            'visibility.public_note',
            'visibility.make_public',
            'visibility.make_private',
            'visibility.not_live_note',
            'readiness.heading',
            'readiness.required_heading',
            'readiness.shown_heading',
            'readiness.name',
            'readiness.bio',
            'readiness.photo',
            'readiness.gig',
            'readiness.trust',
            'readiness.complete',
            'preview.heading',
          ]
        : []),
    ],
    [
      ...(errorKey
        ? [errorKey]
        : notRegistered
          ? [PAGE_UNAVAILABLE_REGISTRATION_KEY, REGISTRATION_TITLE_KEY]
          : everythingDown
            ? [GENERIC_PROFILE_ERROR_KEY]
            : []),
      ...(refusalKey ? [refusalKey] : []),
      ...issues.map(profileIssueKey),
      ...(profile
        ? [profileVisibilityKey(profile.visibility), gigKey('editor.yes'), gigKey('editor.no'), gigKey('media.types_note'), gigKey('media.size_note')]
        : []),
      'provider.gig.page.title',
    ],
  );
  const { t, k } = text;

  const failure =
    refusalKey && k(refusalKey)
      ? k(refusalKey)
      : errorKey
        ? k(errorKey)
        : notRegistered
          ? k(PAGE_UNAVAILABLE_REGISTRATION_KEY)
          : everythingDown
            ? k(GENERIC_PROFILE_ERROR_KEY)
            : null;
  const notice = noticeProven ? t(NOTICE_PATHS[noticeWord!]!) : null;
  const title = t('title');
  const errorId = 'profile-error';
  const describedBy = failure ? { 'aria-describedby': errorId } : {};
  const issueRows = issues
    .map((reason, n) => ({ id: `profile-issue-${n}`, field: PROFILE_ISSUE_FIELD[reason], text: k(profileIssueKey(reason)) }))
    .filter((i) => i.text);
  const issueIdsOf = (field: ProfileFieldName): string[] => issueRows.filter((i) => i.field === field).map((i) => i.id);

  const limits = state?.limits;
  const canEditDetails = Boolean(state && limits && t('name.label') && t('bio.label') && t('save'));
  const readiness = state?.readiness;
  const yes = k(gigKey('editor.yes'));
  const no = k(gigKey('editor.no'));
  // what the API's configuration REQUIRES for a public profile (the name always; the bio and the photo only when the limits say so) and what is merely SHOWN when it exists
  const requiredFacts: Array<[string, boolean]> = readiness
    ? [
        ['readiness.name', readiness.publicNameAvailable],
        ...(limits?.bioRequired ? ([['readiness.bio', readiness.bioPresent]] as Array<[string, boolean]>) : []),
        ...(limits?.photoRequired ? ([['readiness.photo', readiness.profilePhotoPresent]] as Array<[string, boolean]>) : []),
      ]
    : [];
  const shownFacts: Array<[string, boolean]> = readiness
    ? [
        ['readiness.gig', readiness.hasPublishedGig],
        ['readiness.trust', readiness.trustSummaryAvailable],
      ]
    : [];
  const factsOf = (facts: Array<[string, boolean]>): Array<[string, boolean]> => (yes && no ? facts.filter(([path]) => t(path)) : []);
  const requiredRows = t('readiness.required_heading') ? factsOf(requiredFacts) : [];
  const shownRows = t('readiness.shown_heading') ? factsOf(shownFacts) : [];
  const typesNote = k(gigKey('media.types_note'));
  const sizeNote = k(gigKey('media.size_note'));
  const megabytes = (bytes: number): string => (bytes >= 1_048_576 ? `${Math.floor(bytes / 1_048_576)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);

  /** The hidden revision of a form on an existing profile. */
  const revisionField = profile ? <input type="hidden" name="expectedRevision" value={profile.revision} /> : null;
  const nameIds = [
    t('name.hint') ? 'profile-name-hint' : '',
    t('name.fallback_note') ? 'profile-name-fallback' : '',
    'profile-name-count',
    ...issueIdsOf('displayName'),
  ].filter(Boolean);
  const bioIds = [t('bio.hint') ? 'profile-bio-hint' : '', 'profile-bio-count', ...issueIdsOf('bio')].filter(Boolean);

  return (
    <div className="provider-registration provider-gigs provider-profile">
      {title ? <h1>{title}</h1> : null}
      {failure ? (
        <p id={errorId} role="alert" tabIndex={-1}>
          {failure}
        </p>
      ) : null}
      {notRegistered && k(REGISTRATION_TITLE_KEY) ? (
        <p>
          <a href="/provider/registration">{k(REGISTRATION_TITLE_KEY)}</a>
        </p>
      ) : null}
      {issueRows.length > 0 ? (
        <ul id="profile-issues" tabIndex={-1}>
          {issueRows.map((i) => (
            <li key={i.id} id={i.id}>
              <a href={ANCHOR[i.field]}>{i.text}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? (
        <p id="profile-notice" role="status" tabIndex={-1}>
          {notice}
        </p>
      ) : null}
      {t('intro') ? <p>{t('intro')}</p> : null}

      {canEditDetails && state && limits ? (
        <div id="profile-details" tabIndex={-1}>
          <form method="post" action="/auth/provider/profile/save" {...describedBy}>
            {revisionField}
            <div className="gig-field">
              <label htmlFor="profile-name">{t('name.label')}</label>
              {t('name.hint') ? (
                <p id="profile-name-hint" className="muted">
                  {t('name.hint')}
                </p>
              ) : null}
              {t('name.fallback_note') ? (
                <p id="profile-name-fallback" className="muted">
                  {profile && profile.displayName === null && profile.publicName ? (
                    <NoteWithValue note={t('name.fallback_note')} value={profile.publicName} />
                  ) : (
                    t('name.fallback_note')
                  )}
                </p>
              ) : null}
              <input
                type="text"
                id="profile-name"
                name="displayName"
                defaultValue={profile?.displayName ?? ''}
                maxLength={limits.displayNameMaxLength}
                autoComplete="off"
                aria-describedby={nameIds.join(' ')}
                {...(issueIdsOf('displayName').length > 0 ? { 'aria-invalid': true as const } : {})}
              />
              <p id="profile-name-count" className="muted">
                {charCount(profile?.displayName ?? null)} / {limits.displayNameMaxLength}
              </p>
            </div>
            <div className="gig-field">
              <label htmlFor="profile-bio">{t('bio.label')}</label>
              {t('bio.hint') ? (
                <p id="profile-bio-hint" className="muted">
                  {t('bio.hint')}
                </p>
              ) : null}
              <textarea
                id="profile-bio"
                name="bio"
                rows={6}
                defaultValue={profile?.bio ?? ''}
                maxLength={limits.bioMaxLength}
                aria-describedby={bioIds.join(' ')}
                {...(issueIdsOf('bio').length > 0 ? { 'aria-invalid': true as const } : {})}
              />
              <p id="profile-bio-count" className="muted">
                {charCount(profile?.bio ?? null)} / {limits.bioMaxLength}
              </p>
            </div>
            <button type="submit">{t('save')}</button>
          </form>
        </div>
      ) : null}

      {profile && limits ? (
        <>
          {t('photo.heading') ? (
            <section id="profile-photo" aria-labelledby="profile-photo-heading" tabIndex={-1}>
              <h2 id="profile-photo-heading">{t('photo.heading')}</h2>
              {t('photo.hint') ? <p className="muted">{t('photo.hint')}</p> : null}
              {t('visibility.save_first_note') ? <p className="muted">{t('visibility.save_first_note')}</p> : null}
              {profile.photo ? (
                // a plain img on purpose: the bytes come through the controlled same-origin route (sanitised bytes, owner only)
                <img
                  src="/provider/profile/photo"
                  alt={profile.publicName ?? ''}
                  width={profile.photo.width}
                  height={profile.photo.height}
                  className="profile-photo"
                />
              ) : t('photo.none') ? (
                <p>{t('photo.none')}</p>
              ) : null}
              {t('photo.upload') ? (
                <form method="post" action="/auth/provider/profile/photo-upload" encType="multipart/form-data" {...describedBy}>
                  {revisionField}
                  <div className="gig-field">
                    <label htmlFor="profile-photo-file">{t('photo.upload')}</label>
                    {limits.photoMimeTypes.length > 0 && typesNote ? (
                      <p id="profile-photo-types" className="muted">
                        <NoteWithValue note={typesNote} value={limits.photoMimeTypes.join(', ')} />
                      </p>
                    ) : null}
                    {sizeNote ? (
                      <p id="profile-photo-size" className="muted">
                        <NoteWithValue note={sizeNote} value={megabytes(limits.photoMaxSizeBytes)} />
                      </p>
                    ) : null}
                    <input
                      type="file"
                      id="profile-photo-file"
                      name="file"
                      required
                      {...(limits.photoMimeTypes.length > 0 ? { accept: limits.photoMimeTypes.join(',') } : {})}
                      aria-describedby={
                        [
                          ...(limits.photoMimeTypes.length > 0 && typesNote ? ['profile-photo-types'] : []),
                          ...(sizeNote ? ['profile-photo-size'] : []),
                          ...issueIdsOf('photo'),
                        ].join(' ') || undefined
                      }
                      {...(issueIdsOf('photo').length > 0 ? { 'aria-invalid': true as const } : {})}
                    />
                  </div>
                  <button type="submit">{t('photo.upload')}</button>
                </form>
              ) : null}
              {(profile.photo || profile.photoPending) && t('photo.remove') ? (
                <form method="post" action="/auth/provider/profile/photo-remove" {...describedBy}>
                  {revisionField}
                  <button type="submit">{t('photo.remove')}</button>
                </form>
              ) : null}
            </section>
          ) : null}

          {t('readiness.heading') && (requiredRows.length > 0 || shownRows.length > 0) ? (
            <section id="profile-readiness" aria-labelledby="profile-readiness-heading">
              <h2 id="profile-readiness-heading">{t('readiness.heading')}</h2>
              {requiredRows.length > 0 ? (
                <>
                  <h3 id="profile-required-heading">{t('readiness.required_heading')}</h3>
                  <dl className="gig-facts" aria-labelledby="profile-required-heading">
                    {requiredRows.map(([path, ok]) => (
                      <div className="gig-row" key={path}>
                        <dt>{t(path)}</dt>
                        <dd>{ok ? yes : no}</dd>
                      </div>
                    ))}
                  </dl>
                  {readiness?.profileComplete && t('readiness.complete') ? <p>{t('readiness.complete')}</p> : null}
                </>
              ) : null}
              {shownRows.length > 0 ? (
                <>
                  <h3 id="profile-shown-heading">{t('readiness.shown_heading')}</h3>
                  <dl className="gig-facts" aria-labelledby="profile-shown-heading">
                    {shownRows.map(([path, ok]) => (
                      <div className="gig-row" key={path}>
                        <dt>{t(path)}</dt>
                        <dd>{ok ? yes : no}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
            </section>
          ) : null}

          {t('preview.heading') ? (
            <p>
              <a href="/provider/profile/preview">{t('preview.heading')}</a>
            </p>
          ) : null}

          {t('visibility.heading') ? (
            <section id="profile-visibility" aria-labelledby="profile-visibility-heading" tabIndex={-1}>
              <h2 id="profile-visibility-heading">{t('visibility.heading')}</h2>
              {k(profileVisibilityKey(profile.visibility)) ? <p className="gig-status">{k(profileVisibilityKey(profile.visibility))}</p> : null}
              {profile.visibility === 'PUBLIC' ? (
                t('visibility.public_note') ? (
                  <p>{t('visibility.public_note')}</p>
                ) : null
              ) : t('visibility.private_note') ? (
                <p>{t('visibility.private_note')}</p>
              ) : null}
              {t('visibility.not_live_note') ? <p className="gig-note">{t('visibility.not_live_note')}</p> : null}
              {t('visibility.also_shown_note') ? <p>{t('visibility.also_shown_note')}</p> : null}
              {profile.visibility === 'PUBLIC' && t('visibility.view_public') ? (
                <p>
                  <a href={`/providers/${profile.publicProfileId}`}>{t('visibility.view_public')}</a>
                </p>
              ) : null}
              {t('visibility.save_first_note') ? <p className="muted">{t('visibility.save_first_note')}</p> : null}
              {(profile.visibility === 'PRIVATE' ? t('visibility.make_public') : t('visibility.make_private')) ? (
                <form method="post" action="/auth/provider/profile/visibility" {...describedBy}>
                  {revisionField}
                  <input type="hidden" name="visibility" value={profile.visibility === 'PRIVATE' ? 'PUBLIC' : 'PRIVATE'} />
                  <button type="submit">{profile.visibility === 'PRIVATE' ? t('visibility.make_public') : t('visibility.make_private')}</button>
                </form>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      {state && k('provider.gig.page.title') ? (
        <p>
          <a href="/provider/gigs">{k('provider.gig.page.title')}</a>
        </p>
      ) : null}
    </div>
  );
}
