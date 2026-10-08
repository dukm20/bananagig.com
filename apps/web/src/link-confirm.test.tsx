// @vitest-environment jsdom
// ID-002 web side: the magic-link landing (client component). The token arrives in the URL FRAGMENT, which no server ever receives; the component reads
// it in the browser, REMOVES it from the address bar, and offers a form that POSTs it in a body to the same-origin handler. Opening the link verifies
// nothing. This file runs in a DOM (jsdom) because the behaviour lives in an effect that reads window.location.hash.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkConfirm, type LinkConfirmCopy } from './app/verify-email/link-confirm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COPY: LinkConfirmCopy = { title: 'Registry link title', body: 'Registry link body', confirm: 'Registry link confirm' };
const OTHER_COPY: LinkConfirmCopy = { title: 'Autre titre', body: 'Autre texte', confirm: 'Autre bouton' };
/** A well-formed token: 32 random bytes as unpadded base64url, 43 characters. Built, never typed as a literal. */
const TOKEN = `Ab-_${'x'.repeat(20)}${'0'.repeat(19)}`;
const PAGE = '/verify-email';

describe('LinkConfirm (the magic-link landing)', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  const mount = async (copy: LinkConfirmCopy = COPY): Promise<void> => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<LinkConfirm copy={copy} />);
    });
  };
  /** Opens the page the way the emailed link does: a path, maybe a query, and the fragment. */
  const arriveAt = (hash: string, search = ''): void => {
    window.history.replaceState(null, '', `${PAGE}${search}`);
    window.location.hash = hash; // set BEFORE the render, like a browser loading the link
  };
  const form = (): HTMLFormElement | null => container.querySelector('form');
  const hiddenToken = (): HTMLInputElement | null => container.querySelector('input[type="hidden"][name="token"]');

  beforeEach(() => {
    window.history.replaceState(null, '', PAGE);
    window.localStorage.clear();
    window.sessionStorage.clear();
    for (const cookie of document.cookie.split(';')) document.cookie = `${cookie.split('=')[0]!.trim()}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
  });

  it('with a well-formed #token=<43 chars> fragment: shows a POST form to /auth/email/confirm-link holding the token in a hidden field, with the copy from props', async () => {
    arriveAt(`#token=${TOKEN}`);
    await mount();
    const f = form();
    expect(f).not.toBeNull();
    expect(f!.getAttribute('method')).toBe('post');
    expect(f!.getAttribute('action')).toBe('/auth/email/confirm-link');
    const hidden = hiddenToken();
    expect(hidden).not.toBeNull();
    expect(hidden!.value).toBe(TOKEN);
    expect(f!.querySelectorAll('input')).toHaveLength(1);
    // the strings are the props, element by element
    expect(container.querySelector('h2')!.textContent).toBe(COPY.title);
    expect(container.querySelector('p')!.textContent).toBe(COPY.body);
    expect(f!.querySelector('button')!.textContent).toBe(COPY.confirm);
    expect(f!.querySelector('button')!.getAttribute('type')).toBe('submit');
    // the form is named by its title for assistive technology
    const labelledBy = f!.getAttribute('aria-labelledby')!;
    expect(container.querySelector(`#${labelledBy}`)).toBe(container.querySelector('h2'));
    // the token is a form value only: no visible text, no other attribute, no link
    expect(container.textContent).not.toContain(TOKEN);
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML.split(TOKEN).length - 1).toBe(1); // exactly one place: the hidden input's value
  });

  it('shows whatever copy it is given (no text of its own)', async () => {
    arriveAt(`#token=${TOKEN}`);
    await mount(OTHER_COPY);
    expect(container.querySelector('h2')!.textContent).toBe(OTHER_COPY.title);
    expect(container.querySelector('p')!.textContent).toBe(OTHER_COPY.body);
    expect(container.querySelector('button')!.textContent).toBe(OTHER_COPY.confirm);
    expect(container.textContent).toBe(`${OTHER_COPY.title}${OTHER_COPY.body}${OTHER_COPY.confirm}`);
  });

  it('removes the token from the address bar: the hash is empty, replaceState was called once without a fragment, and the path and query are kept', async () => {
    arriveAt(`#token=${TOKEN}`, '?utm=1&lang=fr');
    expect(window.location.hash).toBe(`#token=${TOKEN}`);
    const replace = vi.spyOn(window.history, 'replaceState');
    await mount();
    expect(hiddenToken()!.value).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.href).not.toContain('#');
    expect(window.location.pathname + window.location.search).toBe('/verify-email?utm=1&lang=fr');
    expect(replace).toHaveBeenCalledTimes(1);
    const [state, unused, url] = replace.mock.calls[0]!;
    expect(state).toBeNull(); // no history state either
    expect(unused).toBe('');
    expect(url).toBe('/verify-email?utm=1&lang=fr');
    expect(String(url)).not.toContain('#');
    expect(String(url)).not.toContain(TOKEN);
    expect(window.history.state).toBeNull();
    expect(window.history.length).toBeGreaterThan(0);
  });

  it('removes the token in place (replaceState, never pushState): no history entry keeps it', async () => {
    arriveAt(`#token=${TOKEN}`);
    const push = vi.spyOn(window.history, 'pushState');
    await mount();
    expect(hiddenToken()).not.toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('never writes the token to localStorage, sessionStorage or a cookie, nor into the window name or the document title', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const nameBefore = window.name;
    const titleBefore = document.title;
    arriveAt(`#token=${TOKEN}`);
    await mount();
    expect(hiddenToken()!.value).toBe(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(document.cookie).toBe('');
    expect(document.cookie).not.toContain(TOKEN);
    expect(window.name).toBe(nameBefore);
    expect(document.title).toBe(titleBefore);
    expect(document.title).not.toContain(TOKEN);
  });

  it('keeps the token in memory only: after unmounting nothing of it is left in the page, the address or any storage', async () => {
    arriveAt(`#token=${TOKEN}`);
    await mount();
    expect(hiddenToken()).not.toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    expect(container.innerHTML).toBe('');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('accepts every character of the base64url alphabet, in either case', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const token of [
      alphabet.slice(0, 43),
      alphabet.slice(21),
      alphabet.slice(0, 43).toLowerCase(),
      alphabet.slice(0, 43).toUpperCase(),
      '-'.repeat(43),
      '_'.repeat(43),
    ]) {
      arriveAt(`#token=${token}`);
      await mount();
      expect(token, 'a 43 character token').toHaveLength(43);
      expect(hiddenToken()?.value, token).toBe(token);
      expect(window.location.hash).toBe('');
      await act(async () => root!.unmount());
      root = undefined;
    }
  });

  it('renders nothing and leaves the address untouched for a fragment that is not exactly #token=<43 base64url characters>', async () => {
    const invalid: [string, string][] = [
      ['42 characters', `#token=${TOKEN.slice(0, 42)}`],
      ['44 characters', `#token=${TOKEN}x`],
      ['empty value', '#token='],
      ['wrong key', `#tok=${TOKEN}`],
      ['key in upper case', `#TOKEN=${TOKEN}`],
      ['key in mixed case', `#Token=${TOKEN}`],
      ['code instead of token', `#code=${TOKEN}`],
      ['extra parameter after', `#token=${TOKEN}&x=1`],
      ['extra parameter before', `#x=1&token=${TOKEN}`],
      ['token twice', `#token=${TOKEN}&token=${TOKEN}`],
      ['no hash sign inside the key', `#/token=${TOKEN}`],
      ['query-like prefix', `#?token=${TOKEN}`],
      ['value with padding', `#token=${TOKEN.slice(0, 42)}=`],
      ['value with a dot', `#token=${TOKEN.slice(0, 42)}.`],
      ['value with a slash', `#token=${TOKEN.slice(0, 42)}/`],
      ['value with a plus', `#token=${TOKEN.slice(0, 42)}+`],
      ['value with a percent escape', `#token=${TOKEN.slice(0, 40)}%41`],
      ['value with a space', `#token=${TOKEN.slice(0, 20)} ${TOKEN.slice(21)}`],
      ['a bare hash', '#'],
      ['only the token', `#${TOKEN}`],
      ['a path-like fragment', '#/verify-email'],
    ];
    for (const [what, hash] of invalid) {
      arriveAt(hash);
      const hashBefore = window.location.hash;
      const hrefBefore = window.location.href;
      const replace = vi.spyOn(window.history, 'replaceState');
      await mount();
      expect(container.innerHTML, what).toBe('');
      expect(form(), what).toBeNull();
      expect(window.location.hash, what).toBe(hashBefore);
      expect(window.location.href, what).toBe(hrefBefore);
      expect(replace, what).not.toHaveBeenCalled();
      await act(async () => root!.unmount());
      root = undefined;
      replace.mockRestore();
    }
  });

  it('renders nothing for a URL without a fragment, and does not touch the history', async () => {
    arriveAt('', '?token=' + TOKEN); // a token in the QUERY is not a landing: only the fragment counts
    const replace = vi.spyOn(window.history, 'replaceState');
    await mount();
    expect(container.innerHTML).toBe('');
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?token=${TOKEN}`);
  });

  it('server-renders nothing (the fragment never reaches a server, so the markup cannot contain a token)', () => {
    expect(renderToString(<LinkConfirm copy={COPY} />)).toBe('');
    expect(renderToString(<LinkConfirm copy={OTHER_COPY} />)).toBe('');
  });

  it('the form carries exactly one field, named "token" (what the handler reads)', async () => {
    arriveAt(`#token=${TOKEN}`);
    await mount();
    const data = new FormData(form()!);
    expect([...data.entries()]).toEqual([['token', TOKEN]]);
  });
});
