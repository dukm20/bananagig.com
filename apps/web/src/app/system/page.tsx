import type { Metadata } from 'next';
import { ApiError } from '../../lib/api-client';
import { serverApi } from '../../lib/server';

export const metadata: Metadata = { title: 'System' };
export const dynamic = 'force-dynamic';

export default async function SystemPage() {
  try {
    const info = await serverApi().getSystemInfo();
    return (
      <>
        <h1>System</h1>
        <p role="status">api reachable</p>
        <dl>
          <dt>service</dt>
          <dd>{info.service}</dd>
          <dt>environment</dt>
          <dd>{info.environment}</dd>
          <dt>version</dt>
          <dd>{info.version}</dd>
          <dt>api version</dt>
          <dd>{info.apiVersion}</dd>
          <dt>server time</dt>
          <dd>{info.serverTime}</dd>
        </dl>
      </>
    );
  } catch (err) {
    const e = err instanceof ApiError ? err : undefined;
    return (
      <>
        <h1>System</h1>
        <p role="alert">api unavailable{e ? ` (${e.code})` : ''}</p>
      </>
    );
  }
}
