import { metrics } from '@bananagig/observability';
export const dynamic = 'force-dynamic';
export async function GET() {
  return new Response(await metrics.metrics(), { headers: { 'content-type': metrics.contentType } });
}
