import { requireAccountArea, accountMetadata, C, feedbackKeys } from '../../lib/account-area';
import { Feedback } from './_components/feedback';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata();

/** `?error=` words of the home page (the role switch of the Roles section returns here when it was started from this page). */
const ERROR_KEYS: Readonly<Record<string, string>> = { role: C.rolesSwitchFailed };

// The account area home. The list of sections is the menu of the shell (menu-first on a phone, with each description); this page is the heading and the introduction, or the
// empty-state message when the active role has no section (or the account no usable role).
export default async function AccountHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const area = await requireAccountArea('/account');
  if (area.kind !== 'ready') return null;
  const { copy, nav } = area;
  const feedback = feedbackKeys({ error: query.error }, ERROR_KEYS);
  const title = copy.node(C.title);
  const text = copy.node(nav.sections.length === 0 ? C.overviewEmpty : C.overviewIntro);
  return (
    <div data-view="home">
      {title ? <h1>{title}</h1> : null}
      <Feedback copy={copy} error={feedback.error} />
      {text ? <p {...(nav.sections.length === 0 ? { role: 'status' } : {})}>{text}</p> : null}
    </div>
  );
}
