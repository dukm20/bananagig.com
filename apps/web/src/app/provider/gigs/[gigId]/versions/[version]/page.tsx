import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { GigVersionDto } from '@bananagig/contracts';
import { getSession } from '../../../../../../lib/auth/handlers';
import { authDeps } from '../../../../../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../../../../../lib/content';
import { GENERIC_GIG_ERROR_KEY, UUID, gigCopy, gigKey, loadGig } from '../../../../../../lib/provider-gigs';
import { serverApi } from '../../../../../../lib/server';
import { VersionView, versionCopyKeys } from '../../../_components/version-view';

// One version of a Gig, READ-ONLY (CAT-003): any status, including a superseded or retired one. The owner can always read their own history. A version of another account's Gig
// is a 404 from the API and the same not-found page here. There is no form on this page; the provider's own text is rendered as plain text nodes only. No script.
export const metadata: Metadata = { title: 'Gig version', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const k = gigKey;
const VERSION = /^[1-9][0-9]{0,8}$/;

export default async function ProviderGigVersionPage({ params }: { params: Promise<{ gigId: string; version: string }> }) {
  const { gigId, version } = await params;
  if (!UUID.test(gigId) || !VERSION.test(version)) notFound();
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([k('editor.version'), 'common.action.sign_in']);
    const title = renderContent(copy[k('editor.version')]);
    return (
      <>
        {title ? <h1>{title}</h1> : null}
        <p>
          <a href={`/auth/login?returnTo=/provider/gigs/${gigId}/versions/${version}`}>
            {renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}
          </a>
        </p>
      </>
    );
  }

  const api = serverApi(session.record.accessToken);
  const result = await loadGig<GigVersionDto>(() => api.getGigVersion(gigId, Number(version), { activeRole: session.record.activeRole }));
  if (!result.ok && result.status === 404) notFound(); // not found, or not the caller's: the same answer
  const v = result.ok ? result.value : null;

  const text = await gigCopy([k('editor.back'), k('editor.version'), ...(v ? versionCopyKeys(v) : [GENERIC_GIG_ERROR_KEY])]);
  const failure = v ? null : text(GENERIC_GIG_ERROR_KEY);

  return (
    <div className="provider-registration provider-gigs">
      {text(k('editor.back')) ? (
        <p>
          <a href={`/provider/gigs/${gigId}`}>{text(k('editor.back'))}</a>
        </p>
      ) : null}
      {text(k('editor.version')) ? (
        <h1>
          {text(k('editor.version'))} {version}
        </h1>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {v ? <VersionView version={v} text={text} /> : null}
    </div>
  );
}
