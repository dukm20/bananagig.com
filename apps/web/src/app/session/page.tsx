import type { Metadata } from 'next';
import { Fragment } from 'react';
import { headers } from 'next/headers';
import type { AccountDto } from '@bananagig/contracts';
import { accountStatusLabelKey } from '@bananagig/contracts';
import { ApiError } from '../../lib/api-client';
import { forgetActiveRole, getSession } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import type { SessionRecord } from '../../lib/auth/types';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../lib/content';
import { serverApi } from '../../lib/server';

export const metadata: Metadata = { title: 'Session' };
export const dynamic = 'force-dynamic';

/** API refusals that mean the role remembered by the session is no longer an ACTIVE role of the account. */
const STALE_ROLE_CODES = new Set(['ACCOUNT_ROLE_NOT_HELD', 'ACCOUNT_ROLE_NOT_ACTIVE']);

/**
 * The caller's account for the session, acting as the role the session remembers. A remembered role the account no longer holds (removed or
 * deactivated while the session lived) is forgotten and the account is read with its default role instead. Any other failure is "unavailable".
 */
async function loadAccount(id: string, record: SessionRecord): Promise<AccountDto | undefined> {
  const api = () => serverApi(record.accessToken);
  try {
    return await api().getAccount({ activeRole: record.activeRole });
  } catch (err) {
    if (!record.activeRole || !(err instanceof ApiError) || err.status !== 403 || !STALE_ROLE_CODES.has(err.code)) return undefined;
  }
  try {
    await forgetActiveRole(id, authDeps());
    return await api().getAccount();
  } catch {
    return undefined;
  }
}

// Infrastructure page: shows whether the browser has a session, the minimal identity the API sees and the application account of the caller
// (id, status, application roles, the role this session acts as, and a switch when the account holds more than one role). No account pages yet.
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
  const [account, who] = await Promise.all([
    loadAccount(session.id, session.record),
    serverApi(session.record.accessToken)
      .getWhoAmI()
      .then(
        (view) => ({ view, error: undefined }),
        (err: unknown) => ({ view: undefined, error: err instanceof ApiError ? err.code : 'API_ERROR' }),
      ),
  ]);
  // one batched registry call for everything this page says: the status line, the controls, the account labels, the status label and the role names
  const copy = await getContentMany([
    'session.status.signed_in',
    'common.action.sign_out',
    ...(account
      ? [
          'session.account.id',
          'session.account.status',
          'session.account.roles',
          'session.account.active_role',
          accountStatusLabelKey(account.status),
          ...account.roles.map((r) => r.nameContentKey),
        ]
      : ['session.account.unavailable']),
  ]);
  const status = renderContent(copy['session.status.signed_in']);
  const signOut = renderContent(copy['common.action.sign_out']) ?? BOOTSTRAP_COPY.signOut;
  const roleName = (role: { nameContentKey: string }) => renderContent(copy[role.nameContentKey]);
  const label = (key: string) => renderContent(copy[key]);
  const unavailable = account ? null : label('session.account.unavailable');
  const activeRole = account?.roles.find((r) => r.code === account.activeRole);
  const roleNames = account ? account.roles.flatMap((r) => (roleName(r) ? [{ code: r.code, name: roleName(r) }] : [])) : [];
  // the role switch: one small POST form per OTHER role, labelled with the role name from the registry (a role without a name has no control)
  const switches = account && account.roles.length > 1 ? roleNames.filter((r) => r.code !== account.activeRole) : [];
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
        <dd>{who.view ? `${who.view.authContext} client (${who.view.clientId})` : `unavailable (${who.error})`}</dd>
        {account && label('session.account.id') ? (
          <>
            <dt>{label('session.account.id')}</dt>
            <dd>{account.accountId}</dd>
          </>
        ) : null}
        {account && label('session.account.status') && label(accountStatusLabelKey(account.status)) ? (
          <>
            <dt>{label('session.account.status')}</dt>
            <dd>{label(accountStatusLabelKey(account.status))}</dd>
          </>
        ) : null}
        {account && label('session.account.roles') && roleNames.length > 0 ? (
          <>
            <dt>{label('session.account.roles')}</dt>
            <dd>
              {roleNames.map((r, i) => (
                <Fragment key={r.code}>
                  {i > 0 ? ', ' : null}
                  {r.name}
                </Fragment>
              ))}
            </dd>
          </>
        ) : null}
        {account && label('session.account.active_role') && activeRole && roleName(activeRole) ? (
          <>
            <dt>{label('session.account.active_role')}</dt>
            <dd>{roleName(activeRole)}</dd>
          </>
        ) : null}
      </dl>
      {unavailable ? <p role="status">{unavailable}</p> : null}
      {switches.map((r) => (
        // POST + same-origin check; the server session remembers the role, the browser never holds it
        <form key={r.code} method="post" action="/auth/active-role">
          <input type="hidden" name="role" value={r.code} />
          <button type="submit">{r.name}</button>
        </form>
      ))}
      {/* POST + same-origin check; there is deliberately no GET logout link (CSRF). */}
      <form method="post" action="/auth/logout">
        <button type="submit">{signOut}</button>
      </form>
    </>
  );
}
