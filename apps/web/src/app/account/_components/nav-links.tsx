'use client';
// The list of account sections. A client component ONLY so that the current section can be marked: `usePathname` is also answered while the page is rendered on the
// server, so the markup that arrives (aria-current included) needs no script. Labels and descriptions are registry copy resolved by the server; the items are exactly the
// sections the API returned for the active role.
import { usePathname } from 'next/navigation';

export interface AccountNavItem {
  route: string;
  label: string;
  description?: string;
}

export function AccountNavLinks({ items, homeRoute }: { items: readonly AccountNavItem[]; homeRoute: string }) {
  const pathname = usePathname();
  const onHome = pathname === homeRoute;
  return (
    <ul className="account-nav-list">
      {items.map((item) => (
        <li key={item.route}>
          <a href={item.route} aria-current={pathname === item.route ? 'page' : undefined}>
            <span className="account-nav-label">{item.label}</span>
            {/* the descriptions help choosing, so they show on the home list (the menu on a phone) and not beside a section's content */}
            {onHome && item.description ? <span className="account-nav-description muted">{item.description}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}
