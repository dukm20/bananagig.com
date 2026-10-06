import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ApiError } from '../../lib/api-client';
import { getSession } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import { serverApi } from '../../lib/server';

export const metadata: Metadata = { title: 'Session' };
export const dynamic = 'force-dynamic';

// Infrastructure page: shows whether the browser has a session and the minimal identity the API sees. No account pages yet.
export default async function SessionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    return (
      <>
        <h1>Session</h1>
        {error === 'login_failed' ? <p role="alert">Sign-in could not be completed. Please try again.</p> : null}
        <p role="status">Not signed in</p>
        <p>
          <a href="/auth/login?returnTo=/session">Sign in</a>
        </p>
      </>
    );
  }
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
      <p role="status">Signed in</p>
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
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
