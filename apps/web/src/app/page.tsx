import Link from 'next/link';
import { BOOTSTRAP_COPY, getContentMany, renderContent } from '../lib/content';

// Reads registry copy per request (locale negotiated from Accept-Language), so it must never be prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const copy = await getContentMany(['brand.name', 'brand.tagline', 'system.home.initialized']);
  const tagline = renderContent(copy['brand.tagline']);
  const initialized = renderContent(copy['system.home.initialized']);
  return (
    <>
      {/* BOOTSTRAP EXCEPTION: the BananaGig wordmark is a proper noun and the only static fallback. Every other managed string is omitted when the registry is unavailable. */}
      <h1>{renderContent(copy['brand.name']) ?? BOOTSTRAP_COPY.wordmark}</h1>
      {tagline ? <p>{tagline}</p> : null}
      {initialized ? <p className="muted">{initialized}</p> : null}
      <p>
        <Link href="/system">System</Link> · <Link href="/health">Health</Link>
      </p>
    </>
  );
}
