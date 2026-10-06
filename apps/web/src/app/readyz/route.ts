export const dynamic = 'force-dynamic';
// Web can accept work whenever the process is up; /system degrades gracefully if the API is down.
export function GET() {
  return Response.json({ status: 'ready', service: 'bananagig-web', checks: {} });
}
