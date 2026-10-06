import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Health' };
export default function HealthPage() {
  return (
    <>
      <h1>Health</h1>
      <p role="status">web: ok</p>
      <p className="muted">Machine-readable endpoints: /healthz (liveness), /readyz (readiness).</p>
    </>
  );
}
