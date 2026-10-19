import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { API_PREFIX, type PublicProviderProfileDto } from '@bananagig/contracts';
import { ApiError } from '../../../lib/api-client';
import { GENERIC_PROFILE_ERROR_KEY, profileCopy } from '../../../lib/provider-profile';
import { UUID } from '../../../lib/provider-gigs';
import { serverApi } from '../../../lib/server';
import { PROFILE_VIEW_PATHS, ProfileView, profileViewKeys } from '../_components/profile-view';

// The public provider profile (PRO-002): a deliberately MINIMAL, server-rendered page for ONE provider, found by the opaque public profile id (never the account id). It renders what
// the public API returns and nothing else: no email, phone, address, legal name, account id, trust detail, rating placeholder or BananaDrop placeholder. An unknown id, a private
// profile and a provider that is not publicly readable are the SAME 404 here and at the API (the standard not-found page). A PUBLIC profile is not "live" and not "bookable":
// this page offers no booking, no price commitment and no group price. It is not listed or searchable anywhere (SEARCH is a later checkpoint), so it is not indexed either. The
// photo is a same-origin image from the API's public photo route (sanitised bytes). No script; no cookie or session is read.
export const metadata: Metadata = { title: 'Provider profile', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function PublicProviderProfilePage({ params }: { params: Promise<{ publicProfileId: string }> }) {
  const { publicProfileId: rawId } = await params;
  if (!UUID.test(rawId)) notFound(); // not even shaped like an id: the same answer as an unknown one
  const publicProfileId = rawId;

  let profile: PublicProviderProfileDto;
  try {
    profile = await serverApi().getPublicProviderProfile(publicProfileId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404) notFound();
    // the API is down or answered something unexpected: say so calmly (registry copy; omitted when the registry is down too)
    const text = await profileCopy([], [GENERIC_PROFILE_ERROR_KEY]);
    const failure = text.k(GENERIC_PROFILE_ERROR_KEY);
    return failure ? <p role="alert">{failure}</p> : null;
  }

  const text = await profileCopy(PROFILE_VIEW_PATHS, profileViewKeys(profile));
  return (
    <div className="provider-registration provider-gigs provider-profile">
      <ProfileView profile={profile} text={text} photoSrc={`${API_PREFIX}/providers/${publicProfileId}/photo`} level={1} notBookableNote />
    </div>
  );
}
