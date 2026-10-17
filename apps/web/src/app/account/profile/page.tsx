import { PROFILE_NAME_MAX, ACCOUNT_SECTIONS, profileIssueMessageKey } from '@bananagig/contracts';
import { accountMetadata, C, feedbackKeys, readSection, requireAccountArea, sectionOrNotFound } from '../../../lib/account-area';
import { NAME_ERROR_WORDS } from '../../../lib/auth/account-handlers';
import { serverApi } from '../../../lib/server';
import { Feedback, Unavailable } from '../_components/feedback';
import { SectionFrame } from '../_components/section-frame';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => accountMetadata(ACCOUNT_SECTIONS.profile);

/** `?error=` words of the names form that are not about one field (the BFF handler's closed list) -> the content key of their message. */
const ERROR_KEYS: Readonly<Record<string, string>> = { save: C.errorSaveFailed };

/**
 * The name errors of the redirect: each closed word names its field and issue; the first word per field counts and any other value is ignored (nothing is echoed). The message
 * is shown next to that field, so the page does not also announce it at the top.
 */
function nameErrors(error: string | string[] | undefined): Partial<Record<'firstName' | 'lastName', string>> {
  const out: Partial<Record<'firstName' | 'lastName', string>> = {};
  for (const word of Array.isArray(error) ? error : error === undefined ? [] : [error]) {
    const hit = Object.hasOwn(NAME_ERROR_WORDS, word) ? NAME_ERROR_WORDS[word] : undefined;
    if (hit && out[hit.field] === undefined) out[hit.field] = profileIssueMessageKey(hit.code);
  }
  return out;
}

// Profile section: the two names (the form posts to /auth/account/profile, no script) and the name other people see, which the API derives.
export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const area = await requireAccountArea('/account/profile');
  if (area.kind !== 'ready') return null;
  const section = sectionOrNotFound(area, ACCOUNT_SECTIONS.profile);
  const { copy } = area;
  const data = await readSection(() => serverApi(area.accessToken).getAccountProfile(area.call));
  const words = Array.isArray(query.error) ? query.error : query.error === undefined ? [] : [query.error];
  const feedback = feedbackKeys({ saved: query.saved, unchanged: query.unchanged, error: words.find((w) => Object.hasOwn(ERROR_KEYS, w)) }, ERROR_KEYS);
  const problems = nameErrors(query.error);
  const firstProblem = copy.node(problems.firstName);
  const lastProblem = copy.node(problems.lastName);
  const profile = data?.profile ?? null;
  const first = copy.plain(C.profileFirstName);
  const last = copy.plain(C.profileLastName);
  const save = copy.plain(C.actionSave);
  return (
    <SectionFrame copy={copy} section={section}>
      <Feedback copy={copy} notice={feedback.notice} error={feedback.error} />
      {!data ? <Unavailable copy={copy} unavailableKey={C.unavailable} /> : null}
      {data && !profile && copy.node(C.profileEmpty) ? <p>{copy.node(C.profileEmpty)}</p> : null}
      {profile && copy.plain(C.profilePublicLabel) ? (
        <dl>
          <dt>{copy.plain(C.profilePublicLabel)}</dt>
          <dd>{profile.displayName}</dd>
        </dl>
      ) : null}
      {profile && copy.node(C.profilePublicHint) ? <p className="muted">{copy.node(C.profilePublicHint)}</p> : null}
      {data && first && last && save ? (
        <form className="account-form" method="post" action="/auth/account/profile">
          <div className="account-field">
            <label htmlFor="account-first-name">{first}</label>
            <input
              id="account-first-name"
              name="firstName"
              type="text"
              autoComplete="given-name"
              maxLength={PROFILE_NAME_MAX}
              defaultValue={profile?.firstName ?? ''}
              required
              {...(firstProblem ? { 'aria-invalid': true, 'aria-describedby': 'account-first-name-error' } : {})}
            />
            {firstProblem ? (
              <p id="account-first-name-error" role="alert">
                {firstProblem}
              </p>
            ) : null}
          </div>
          <div className="account-field">
            <label htmlFor="account-last-name">{last}</label>
            <input
              id="account-last-name"
              name="lastName"
              type="text"
              autoComplete="family-name"
              maxLength={PROFILE_NAME_MAX}
              defaultValue={profile?.lastName ?? ''}
              required
              {...(lastProblem ? { 'aria-invalid': true, 'aria-describedby': 'account-last-name-error' } : {})}
            />
            {lastProblem ? (
              <p id="account-last-name-error" role="alert">
                {lastProblem}
              </p>
            ) : null}
          </div>
          <button type="submit">{save}</button>
        </form>
      ) : null}
    </SectionFrame>
  );
}
