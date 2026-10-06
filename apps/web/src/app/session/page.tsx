import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ApiError } from '../../lib/api-client';
import { getSession } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../lib/content';
import { serverApi } from '../../lib/server';

export const metadata: Metadata = { title: 'Session' };
export const dynamic = 'force-dynamic';

// Infrastructure page: shows whether the browser has a session and the minimal identity the API sees. No account pages yet.
export default async function SessionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  // Managed copy comes from the registry only; when it is unavailable the element is omitted (no hardcoded replacement), EXCEPT the
  // two authentication controls, which fall back to the bootstrap labels so login/logout still work when the registry is down.
  if (!session) {
    const copy = await getContentMany([
      'session.status.signed_out',
      'common.action.sign_in',
      ...(error === 'login_failed' ? ['session.error.login_failed'] : []),
    ]);
    const failure = error === 'login_failed' ? renderContent(copy['session.error.login_failed']) : null;
    const status = renderContent(copy['session.status.signed_out']);
    const signIn = renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn;
    return (
      <>
        <h1>Session</h1>
        {failure ? <p role="alert">{failure}</p> : null}
        {status ? <p role="status">{status}</p> : null}
        <p>
          <a href="/auth/login?returnTo=/session">{signIn}</a>
        </p>
      </>
    );
  }
  const copy = await getContentMany(['session.status.signed_in', 'common.action.sign_out']);
  const status = renderContent(copy['session.status.signed_in']);
  const signOut = renderContent(copy['common.action.sign_out']) ?? BOOTSTRAP_COPY.signOut;
  let apiView: { authContext: string; clientId: string } | undefined;
  let apiError: string | undefined;
  try {
    apiView = await serverApi(session.record.accessToken).getWhoAmI();
  } catch (err) {
    apiError = err instanceof ApiError ? err.code : 'API_ERROR';
  }
  return (
    <>
      <h1>Session</h1>
      {status ? <p role="status">{status}</p> : null}
      <dl>
        <dt>subject</dt>
        <dd>{session.record.subject}</dd>
        <dt>roles</dt>
        <dd>{session.record.realmRoles.join(', ') || 'none'}</dd>
        <dt>api sees</dt>
        <dd>{apiView ? `${apiView.authContext} client (${apiView.clientId})` : `unavailable (${apiError})`}</dd>
      </dl>
      {/* POST + same-origin check; there is deliberately no GET logout link (CSRF). */}
      <form method="post" action="/auth/logout">
        <button type="submit">{signOut}</button>
      </form>
    </>
  );
}
