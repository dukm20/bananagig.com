// The executor type shared by the Gig SQL helpers (a Kysely instance or a transaction).
import type { DatabaseSchema, Kysely, Trx } from '@bananagig/database';

export type Executor = Kysely<DatabaseSchema> | Trx;
