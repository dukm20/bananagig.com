// Pure paths of the public badge query (PRO-002): the answers that need no statement at all. The database behaviour is in public-badges.itest.ts.
import { describe, expect, it } from 'vitest';
import type { TrustRequirementType } from '@bananagig/contracts';
import type { Kysely, DatabaseSchema } from '@bananagig/database';
import { queryPublicBadgeTypes } from './public-badges';

// an executor that fails the test the moment anything touches it: proves "no query"
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was used');
    },
  },
) as unknown as Kysely<DatabaseSchema>;
const ACCOUNT = '0b6f6ab2-3a4a-4d3e-9d4e-7b9d3a1f2c10';
const NOW = new Date('2026-10-18T12:00:00Z');

describe('queryPublicBadgeTypes without a statement', () => {
  it('an empty allow-list answers [] without a query', async () => {
    expect(await queryPublicBadgeTypes(untouchable, ACCOUNT, [], NOW)).toEqual([]);
  });
  it('an allow-list of unknown codes only answers [] without a query', async () => {
    expect(await queryPublicBadgeTypes(untouchable, ACCOUNT, ['NOT_A_TYPE' as TrustRequirementType], NOW)).toEqual([]);
  });
  it('a malformed account id answers [] without a query', async () => {
    for (const bad of ['', 'not-a-uuid', "x' OR 1=1 --", ACCOUNT + '0', undefined as unknown as string]) {
      expect(await queryPublicBadgeTypes(untouchable, bad, ['IDENTITY'], NOW)).toEqual([]);
    }
  });
});
