import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { EMAIL_ERROR_CODES, emailErrorMessageKey, emailIssueMessageKey, emailStatusLabelKey, type AccountEmailDetailDto } from '@bananagig/contracts';
import { getSession } from '../../lib/auth/handlers';
import { authDeps } from '../../lib/auth/runtime';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../lib/content';
import { serverApi } from '../../lib/server';
import { LinkConfirm } from './link-confirm';

// The page never carries the code or the token in a URL the server sees. `no-referrer` keeps even the page address out of requests it triggers.
export const metadata: Metadata = { title: 'Verify your email', referrer: 'no-referrer', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** API error codes the handler redirects with -> the content key of their message (managed copy; no message text lives in the web app). */
const ERROR_COPY: Readonly<Record<string, string>> = Object.fromEntries([
  ...EMAIL_ERROR_CODES.filter((c) => c !== 'EMAIL_INVALID').map((c) => [
    `ACCOUNT_${c}`,
    emailErrorMessageKey(c as Exclude<(typeof EMAIL_ERROR_CODES)[number], 'EMAIL_INVALID'>),
  ]),
  ['ACCOUNT_EMAIL_INVALID', emailIssueMessageKey('INVALID_FORMAT')],
]);

const KEYS = {
  title: 'account.email.verify.title',
  intro: 'account.email.verify.intro',
  codeLabel: 'account.email.verify.code_label',
  submit: 'account.email.verify.submit',
  resend: 'account.email.verify.resend',
  resendWait: 'account.email.verify.resend_wait',
  change: 'account.email.verify.change',
  sent: 'account.email.verify.sent',
  success: 'account.email.verify.success',
  linkTitle: 'account.email.link.title',
  linkBody: 'account.email.link.body',
  linkConfirm: 'account.email.link.confirm',
  signInRequired: 'account.email.link.sign_in_required',
  unavailable: 'session.account.unavailable',
} as const;

const secondsLeft = (iso: string | null): number => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000)) : 0);

// Email verification screen (S-03a): the code form, the resend control with its countdown, the change-address form and the magic-link landing.
// Every string comes from the managed content registry (a string the registry cannot serve is omitted, never replaced by a literal), except the sign-in label.
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const session = await getSession((await headers()).get('cookie'), authDeps());
  if (!session) {
    const copy = await getContentMany([KEYS.title, KEYS.signInRequired, 'common.action.sign_in']);
    return (
      <>
        <h1>{renderContent(copy[KEYS.title])}</h1>
        {copy[KEYS.signInRequired] ? <p role="status">{renderContent(copy[KEYS.signInRequired])}</p> : null}
        {/* the magic link's token lives only in the URL fragment, which a login redirect drops: the person opens the link again after signing in */}
        <p>
          <a href="/auth/login?returnTo=/verify-email">{renderContent(copy['common.action.sign_in']) ?? BOOTSTRAP_COPY.signIn}</a>
        </p>
      </>
    );
  }

  let state: AccountEmailDetailDto | undefined;
  try {
    state = await serverApi(session.record.accessToken).getAccountEmail({ activeRole: session.record.activeRole });
  } catch {
    state = undefined;
  }
  // own properties only: `?error=constructor` must be an unknown code, not a member of Object.prototype
  const errorKey = error ? (Object.hasOwn(ERROR_COPY, error) ? ERROR_COPY[error]! : KEYS.unavailable) : undefined;
  const pending = state?.pending ?? null;
  const wait = secondsLeft(state?.resendAvailableAt ?? null);
  // the set-address form is offered until the address is verified (and while a replacement is pending)
  const showSetForm = Boolean((state && state.emailVerificationStatus !== 'VERIFIED') || pending);
  const copy = await getContentMany(
    [
      KEYS.title,
      KEYS.change,
      KEYS.linkTitle,
      KEYS.linkBody,
      KEYS.linkConfirm,
      ...(state ? [emailStatusLabelKey(state.emailVerificationStatus)] : [KEYS.unavailable]),
      ...(errorKey ? [errorKey] : []),
      ...(ok === 'sent' ? [KEYS.sent] : []),
      ...(ok === 'verified' ? [KEYS.success] : []),
      ...(showSetForm ? [KEYS.submit] : []),
      ...(pending ? [KEYS.intro, KEYS.codeLabel, KEYS.resend, ...(wait > 0 ? [KEYS.resendWait] : [])] : []),
    ],
    {
      variables: { ...(pending ? { [KEYS.intro]: { masked_email: pending.maskedEmail } } : {}), ...(wait > 0 ? { [KEYS.resendWait]: { seconds: wait } } : {}) },
    },
  );
  const text = (key: string) => renderContent(copy[key]);
  const linkTitle = copy[KEYS.linkTitle];
  const linkBody = copy[KEYS.linkBody];
  const linkConfirm = copy[KEYS.linkConfirm];
  const linkCopy = linkTitle && linkBody && linkConfirm ? { title: linkTitle.value, body: linkBody.value, confirm: linkConfirm.value } : undefined;
  const notice = ok === 'sent' ? text(KEYS.sent) : ok === 'verified' ? text(KEYS.success) : null;
  const failure = errorKey ? text(errorKey) : null;
  const codeLength = state?.codeLength ?? 6;

  // an element whose copy the registry cannot serve is omitted (never replaced by a literal), like the session page
  const title = text(KEYS.title);
  const statusLabel = state ? text(emailStatusLabelKey(state.emailVerificationStatus)) : null;
  const unavailable = !state ? text(KEYS.unavailable) : null;
  const intro = pending ? text(KEYS.intro) : null;
  const submit = text(KEYS.submit);
  const resend = text(KEYS.resend);
  const resendWait = wait > 0 ? text(KEYS.resendWait) : null;

  return (
    <>
      {title ? <h1>{title}</h1> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {unavailable ? <p role="status">{unavailable}</p> : null}
      {state && (statusLabel || state.primary) ? (
        <p role="status">
          {statusLabel}
          {state.primary ? `${statusLabel ? ' ' : ''}${state.primary.maskedEmail}` : ''}
        </p>
      ) : null}
      {/* the magic-link landing: a client component reads the token from the URL fragment and offers the confirm button */}
      {linkCopy && pending ? <LinkConfirm copy={linkCopy} /> : null}
      {pending ? (
        <>
          {intro ? <p>{intro}</p> : null}
          <form method="post" action="/auth/email/confirm-code">
            <label>
              {text(KEYS.codeLabel)}
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern={`[0-9]{${codeLength}}`} maxLength={codeLength} required />
            </label>
            {submit ? <button type="submit">{submit}</button> : null}
          </form>
          <form method="post" action="/auth/email/send">
            {resend ? (
              <button type="submit" disabled={wait > 0}>
                {resend}
              </button>
            ) : null}
            {resendWait ? <p role="timer">{resendWait}</p> : null}
          </form>
        </>
      ) : null}
      {showSetForm ? (
        <form method="post" action="/auth/email/set">
          <label>
            {text(KEYS.change)}
            <input name="email" type="email" autoComplete="email" maxLength={254} required />
          </label>
          {submit ? <button type="submit">{submit}</button> : null}
        </form>
      ) : null}
    </>
  );
}
