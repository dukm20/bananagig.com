import { dropStaleTestDatabases } from './packages/testing/src/index';

export default async function setup(): Promise<void> {
  const dropped = await dropStaleTestDatabases();
  if (dropped.length) console.log(`removed ${dropped.length} stale test database(s)`);
}
