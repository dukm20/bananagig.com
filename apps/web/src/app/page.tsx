import Link from 'next/link';

// Temporary infrastructure/bootstrap copy only. No marketplace content.
export default function Home() {
  return (
    <>
      <h1>BananaGig</h1>
      <p>Local help. Done fast.</p>
      <p className="muted">Platform initialization successful.</p>
      <p>
        <Link href="/system">System</Link> · <Link href="/health">Health</Link>
      </p>
    </>
  );
}
