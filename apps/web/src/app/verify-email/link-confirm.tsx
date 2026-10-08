'use client';
// The magic-link landing (ID-002). The token arrives in the URL FRAGMENT (`/verify-email#token=...`): a fragment is never sent to a server, so the token is
// in no access log, trace or Referer header. This component reads it in the browser, REMOVES it from the address bar and history, and offers a button.
// Opening the link verifies nothing (a mail scanner that prefetches it changes nothing): the person presses the button, the form POSTs the token in a body
// to the same-origin handler, which calls the API with the session's token. The token is held in memory only: never in storage, a cookie or a log.
import { useEffect, useState } from 'react';

const TOKEN_IN_FRAGMENT = /^#token=([A-Za-z0-9_-]{43})$/;

export interface LinkConfirmCopy {
  title: string;
  body: string;
  confirm: string;
}

export function LinkConfirm({ copy }: { copy: LinkConfirmCopy }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const match = TOKEN_IN_FRAGMENT.exec(window.location.hash);
    if (!match) return;
    setToken(match[1]!);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);
  if (!token) return null;
  return (
    <form method="post" action="/auth/email/confirm-link" aria-labelledby="link-confirm-title">
      <h2 id="link-confirm-title">{copy.title}</h2>
      <p>{copy.body}</p>
      <input type="hidden" name="token" value={token} />
      <button type="submit">{copy.confirm}</button>
    </form>
  );
}
