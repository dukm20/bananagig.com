import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Every section the registry lists that has no page of its own yet (today notifications and close account, and any section a later checkpoint registers before its page exists)
// ends here. The six real pages are static segments next to this one, which Next prefers. A page is never invented from a registry row.
export default function UnknownAccountSection(): never {
  notFound();
}
