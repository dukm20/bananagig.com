import type { Metadata } from 'next';
import { PASSWORD_RESET_STATUSES } from '../../lib/auth/security-handlers';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../../lib/content';

// The address is submitted in a form body and never appears in a URL or a redirect; `no-referrer` keeps even this page's address out of requests it triggers.
export const metadata: Metadata = { title: 'Reset your password', referrer: 'no-referrer', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const K = {
  title: 'account.password_reset.title',
  intro: 'account.password_reset.intro',
  emailLabel: 'account.password_reset.email_label',
  submit: 'account.password_reset.submit',
  accepted: 'account.password_reset.accepted',
  backToSignIn: 'account.password_reset.back_to_sign_in',
  invalid: 'account.password_reset.error.invalid_email',
  rateLimited: 'account.password_reset.error.rate_limited',
  unavailable: 'account.security.error.security_unavailable',
} as const;
/** `?status=` words -> the content key of the message (an unknown word shows nothing). */
const STATUS_KEYS: Readonly<Record<string, string>> = { accepted: K.accepted, invalid: K.invalid, rate_limited: K.rateLimited, unavailable: K.unavailable };

// Password reset request (S-03b). Public: the visitor is typically signed out. The page says the same thing whether or not an account exists: that is decided by the API,
// which always answers the same way. Every string comes from the managed content registry (omitted when it cannot be served).
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const { status } = await searchParams;
  const word = typeof status === 'string' && (PASSWORD_RESET_STATUSES as readonly string[]).includes(status) ? status : undefined;
  const statusKey = word ? STATUS_KEYS[word] : undefined;
  const copy = await getContentMany([K.title, K.intro, K.emailLabel, K.submit, K.backToSignIn, ...(statusKey ? [statusKey] : [])]);
  const text = (k: string) => renderContent(copy[k]);
  const message = statusKey ? text(statusKey) : null;
  const submit = text(K.submit);
  return (
    <>
      {text(K.title) ? <h1>{text(K.title)}</h1> : null}
      {message ? <p role={word === 'accepted' ? 'status' : 'alert'}>{message}</p> : null}
      {text(K.intro) ? <p>{text(K.intro)}</p> : null}
      {/* POST + same-origin check; the address travels in the body only */}
      <form method="post" action="/auth/password-reset">
        <label>
          {text(K.emailLabel)}
          <input name="email" type="email" autoComplete="email" maxLength={320} required />
        </label>
        {submit ? <button type="submit">{submit}</button> : null}
      </form>
      <p>
        <a href="/auth/login?returnTo=/session">{text(K.backToSignIn) ?? BOOTSTRAP_COPY.signIn}</a>
      </p>
    </>
  );
}
