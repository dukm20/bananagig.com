import { ACCOUNT_SECTIONS } from '@bananagig/contracts';
import { accountMetadata, C, feedbackKeys, readSection, requireAccountArea, sectionOrNotFound } from '../../../lib/account-area';
import { getContent, renderContent } from '../../../lib/content';
import { serverApi } from '../../../lib/server';
import { Feedback, Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.roles);

/** `?error=` words of this page: the role switch (POST /auth/active-role) returns here with `role` when the API refused it. */
const ERROR_KEYS: Readonly<Record<string, string>> = { role: C.rolesSwitchFailed };

// Roles section: the roles the account holds with the current one marked, and one no-script switch form per OTHER role posting to the existing BFF route
// POST /auth/active-role (the server session remembers the role, the API validates it on every request; no new login). One role only: a message instead of a switch.
export default async function RolesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const area = await requireAccountArea('/account/roles');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.roles);
  const { copy } = area;
  const data = await readSection(() => serverApi(area.accessToken).getAccountRolesSection(area.call));
  const feedback = feedbackKeys(query, ERROR_KEYS);
  const roles = (data?.roles ?? []).flatMap((r) => {
    const name = copy.plain(r.nameContentKey);
    return name ? [{ code: r.code, name }] : [];
  });
  // "Switch to {role}" once per other role (the batch call takes one set of variables per key)
  const switches = await Promise.all(
    roles
      .filter((r) => data?.switchableTo.includes(r.code))
      .map(async (r) => ({ code: r.code, label: renderContent(await getContent(C.rolesSwitch, { variables: { role: r.name } })) })),
  );
  const current = copy.plain(C.rolesCurrent);
  return (
    <SectionFrame copy={copy} section={section}>
      <Feedback copy={copy} error={feedback.error} />
      {!data ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {data && roles.length > 0 ? (
        <section aria-labelledby="account-roles-held">
          {copy.node(C.rolesHeld) ? <h2 id="account-roles-held">{copy.node(C.rolesHeld)}</h2> : null}
          <ul>
            {roles.map((r) => (
              <li key={r.code}>
                <span>{r.name}</span>
                {r.code === data.activeRole && current ? <span className="account-badge">{current}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data && data.switchableTo.length === 0 && copy.node(C.rolesSingle) ? <p>{copy.node(C.rolesSingle)}</p> : null}
      {switches.map((s) =>
        s.label ? (
          // POST + same-origin check; `next` sends the browser to the account home (an allow-listed path that exists for EVERY role: the role it switches to may not have a Roles section), the browser never holds the role
          <form key={s.code} className="account-form" method="post" action="/auth/active-role">
            <input type="hidden" name="role" value={s.code} />
            <input type="hidden" name="next" value="/account" />
            <button type="submit">{s.label}</button>
          </form>
        ) : null,
      )}
    </SectionFrame>
  );
}
