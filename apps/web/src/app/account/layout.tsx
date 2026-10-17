import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ACCOUNT_AREA_HOME } from '@bananagig/contracts';
import { C, loadAccountArea } from '../../lib/account-area';
import { AccountNavLinks, type AccountNavItem } from './_components/nav-links';
import { Unavailable } from './_components/feedback';

// The shared account area shell (ACC-001): one layout for every persona. The menu is the navigation the API returned for the ACTIVE role of the session (registry data), read once
// per request (the page shares it through React's cache), and every word is registry copy resolved in one batch. Server-rendered; no script is needed for any of it.
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const area = await loadAccountArea();
  // signed out or revoked: the page redirects (it knows its own path); the shell has nothing to show
  if (area.kind === 'signed-out' || area.kind === 'revoked') return <>{children}</>;
  if (area.kind === 'unavailable') {
    // the page renders nothing in this state, so the heading (when its copy is available) is the one h1 of the page
    const title = area.copy.node(C.title);
    return (
      <div className="account-shell">
        <div id="account-content" className="account-content" tabIndex={-1}>
          {title ? <h1>{title}</h1> : null}
          <Unavailable copy={area.copy} unavailableKey={C.unavailable} />
          {children}
        </div>
      </div>
    );
  }
  const { copy, nav } = area;
  const items: AccountNavItem[] = nav.sections.flatMap((s) => {
    const label = copy.plain(s.labelContentKey);
    if (!label) return []; // a link without a name cannot be used: omitted, like any unavailable copy
    const description = copy.plain(s.descriptionContentKey);
    return [{ route: s.route, label, ...(description ? { description } : {}) }];
  });
  const skip = copy.plain(C.skipLink);
  const navLabel = copy.plain(C.navLabel);
  return (
    <div className="account-shell">
      {skip ? (
        <a className="skip-link" href="#account-content">
          {skip}
        </a>
      ) : null}
      <div className="account-side">
        {area.activeRoleLabel ? <p className="account-role muted">{area.activeRoleLabel}</p> : null}
        {items.length > 0 ? (
          <nav className="account-nav" {...(navLabel ? { 'aria-label': navLabel } : {})}>
            <AccountNavLinks items={items} homeRoute={ACCOUNT_AREA_HOME} />
          </nav>
        ) : null}
      </div>
      <div id="account-content" className="account-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
