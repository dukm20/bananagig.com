import type { Copy } from '../../../lib/account-area';

/** The result of a save, after the redirect: an error (role=alert) and/or a notice (role=status), each registry copy. Never a submitted value. */
export function Feedback({ copy, notice, error }: { copy: Copy; notice?: string; error?: string }) {
  const failure = copy.node(error);
  const done = copy.node(notice);
  return (
    <>
      {failure ? <p role="alert">{failure}</p> : null}
      {done ? <p role="status">{done}</p> : null}
    </>
  );
}

/** The message of a part that could not be loaded (registry copy; nothing when the registry is down too). */
export function Unavailable({ copy, unavailableKey }: { copy: Copy; unavailableKey: string }) {
  const message = copy.node(unavailableKey);
  return message ? <p role="alert">{message}</p> : null;
}
