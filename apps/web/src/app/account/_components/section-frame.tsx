import type { ReactNode } from 'react';
import type { AccountSectionDto } from '@bananagig/contracts';
import { C, type Copy } from '../../../lib/account-area';

/**
 * The frame every section page shares: on a phone the menu is hidden while a section is open (see globals.css, `data-view`), so the page starts with a link back to the list;
 * from tablet width the menu stands beside the content and the link is hidden. The one h1 of the page is the section label from the registry.
 */
export function SectionFrame({ copy, section, children }: { copy: Copy; section: AccountSectionDto; children: ReactNode }) {
  const back = copy.plain(C.navBack);
  const title = copy.node(section.labelContentKey);
  const description = copy.node(section.descriptionContentKey);
  return (
    <div data-view="section">
      {back ? (
        <a className="account-back" href="/account">
          {back}
        </a>
      ) : null}
      {title ? <h1>{title}</h1> : null}
      {description ? <p className="muted">{description}</p> : null}
      {children}
    </div>
  );
}
