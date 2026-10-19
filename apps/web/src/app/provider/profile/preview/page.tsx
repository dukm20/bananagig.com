import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { profileIssueKey, profileVisibilityKey, type PreviewProviderProfileDto } from '@bananagig/contracts';
import { getSession } from '../../../../lib/auth/handlers';
import { authDeps } from '../../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../../lib/content';
import {
  GENERIC_PROFILE_ERROR_KEY,
  PAGE_UNAVAILABLE_REGISTRATION_KEY,
  REGISTRATION_TITLE_KEY,
  loadProfile,
  profileCopy,
  profileKey,
} from '../../../../lib/provider-profile';
import { serverApi } from '../../../../lib/server';
import { PROFILE_VIEW_PATHS, ProfileView, profileViewKeys } from '../../../providers/_components/profile-view';

// The owner's preview of their public profile (PRO-002): exactly the public projection (ONE component and ONE API projection serve the preview and the public page), whatever the
// visibility, with a plain-text note that this is a preview and that a public profile is NOT live and NOT bookable. Only the signed-in owner sees it; a signed-in account with no
// profile gets the standard not-found page. A failed read says WHY in the registry's words: an account that is not a registered provider yet is pointed to the registration, a profile
// with no name to show is pointed to the name field, and only a real outage gets the calm "unavailable" message. The photo comes from the controlled owner route (a private profile has
// no public photo address). No script.
export const metadata: Metadata = { title: 'Profile preview', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function ProviderProfilePreviewPage() {
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([profileKey('preview.heading'), 'common.action.sign_in']);
    const title = renderContent(copy[profileKey('preview.heading')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href="/auth/login?returnTo=/provider/profile/preview">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const result = await loadProfile<PreviewProviderProfileDto>(() => api.getProviderProfilePreview({ activeRole: session.record.activeRole }));
  if (!result.ok && result.status === 404) notFound(); // no profile (or not a provider): the same answer
  const profile = result.ok ? result.value : null;
  const failure = result.ok ? null : result.failure;

  const text = await profileCopy(
    ['preview.heading', 'preview.note', 'preview.back', 'visibility.heading', 'visibility.not_live_note', ...PROFILE_VIEW_PATHS],
    profile
      ? [...profileViewKeys(profile), profileVisibilityKey(profile.visibility)]
      : [GENERIC_PROFILE_ERROR_KEY, PAGE_UNAVAILABLE_REGISTRATION_KEY, REGISTRATION_TITLE_KEY, profileIssueKey('PUBLIC_NAME_UNAVAILABLE')],
  );
  const { t, k } = text;
  const message =
    failure === 'registration'
      ? k(PAGE_UNAVAILABLE_REGISTRATION_KEY)
      : failure === 'public_name_unavailable'
        ? k(profileIssueKey('PUBLIC_NAME_UNAVAILABLE'))
        : failure
          ? k(GENERIC_PROFILE_ERROR_KEY)
          : null;

  return (
    <div className="provider-registration provider-gigs provider-profile">
      {t('preview.heading') ? <h1>{t('preview.heading')}</h1> : null}
      {message ? <p role="alert">{failure === 'public_name_unavailable' ? <a href="/provider/profile#profile-name">{message}</a> : message}</p> : null}
      {failure === 'registration' && k(REGISTRATION_TITLE_KEY) ? (
        <p>
          <a href="/provider/registration">{k(REGISTRATION_TITLE_KEY)}</a>
        </p>
      ) : null}
      {profile ? (
        <>
          {t('preview.note') ? <p className="gig-note">{t('preview.note')}</p> : null}
          {t('visibility.not_live_note') ? <p className="gig-note">{t('visibility.not_live_note')}</p> : null}
          {t('visibility.heading') && k(profileVisibilityKey(profile.visibility)) ? (
            <dl className="gig-facts">
              <div className="gig-row">
                <dt>{t('visibility.heading')}</dt>
                <dd className="gig-status">{k(profileVisibilityKey(profile.visibility))}</dd>
              </div>
            </dl>
          ) : null}
        </>
      ) : null}
      {t('preview.back') ? (
        <p>
          <a href="/provider/profile">{t('preview.back')}</a>
        </p>
      ) : null}
      {profile ? <ProfileView profile={profile} text={text} photoSrc="/provider/profile/photo" level={2} /> : null}
    </div>
  );
}
