// Scheduled clean-up of provider Gig photos (CAT-004, pg-boss): expired or stuck never-finalized uploads are abandoned, READY photos that NO Gig version references (after the configured
// grace period) are deleted, and the stored objects of every terminal photo are RECONCILED (a deletion that failed is repeated until it is confirmed; the upload object a replayed
// presigned PUT may have recreated is removed once its authorization has ended). The logic lives in the provider domain (GigMediaService.cleanup: reference-aware, lock-ordered, SKIP LOCKED); this
// file only schedules it and gives it what it needs in the worker: the database, the private object store and the media policy read from the configuration registry.
// Idempotent and safe to run concurrently or late. Logs carry COUNTS only: never an object key, a URL, a hash or provider text.
import type { PgBoss } from 'pg-boss';
import type { ConfigurationService } from '@bananagig/configuration';
import type { Database } from '@bananagig/database';
import { log } from '@bananagig/observability';
import type { PrivateObjectStore } from '@bananagig/platform';
import {
  DisabledGigMediaScanner,
  GigError,
  GigMediaService,
  gigMediaPolicyKeys,
  gigOptionsPolicyKeys,
  gigPolicyKeys,
  parseGigMediaPolicy,
  parseGigOptionsPolicy,
  parseGigPolicy,
  type DraftMutator,
  type GigPolicyProvider,
} from '@bananagig/provider';
import { jobHandler } from '../runtime/job';

export const GIG_MEDIA_CLEANUP_QUEUE = 'provider.gig-media-cleanup';
/** Every 15 minutes: abandoned uploads and unreferenced photos are not urgent, the grace period (configuration, hours) is what protects a photo, not the schedule. */
export const GIG_MEDIA_CLEANUP_CRON = '*/15 * * * *';
/** Rows handled per sweep and per run (the upload sweep and the orphan sweep each take up to this many); a backlog is worked off over several runs. A structural batch size, not a business value. */
export const GIG_MEDIA_CLEANUP_LIMIT = 200;

export interface GigMediaCleaner {
  cleanup(opts: { limit: number }): Promise<{ abandoned: number; deleted: number; reconciled?: number }>;
}

export async function registerGigMediaJobs(boss: PgBoss, media: GigMediaCleaner, concurrency = 1): Promise<void> {
  await boss.createQueue(GIG_MEDIA_CLEANUP_QUEUE);
  await boss.schedule(GIG_MEDIA_CLEANUP_QUEUE, GIG_MEDIA_CLEANUP_CRON);
  await boss.work(
    GIG_MEDIA_CLEANUP_QUEUE,
    { localConcurrency: concurrency },
    jobHandler<Record<string, never>>(GIG_MEDIA_CLEANUP_QUEUE, async () => {
      const { abandoned, deleted, reconciled = 0 } = await media.cleanup({ limit: GIG_MEDIA_CLEANUP_LIMIT });
      if (abandoned || deleted || reconciled) log('info', 'gig photos cleaned up', { abandoned, deleted, reconciled });
    }),
  );
}

/**
 * The Gig policy from the configuration registry (CFG-001): typed PLATFORM values with no code default; a missing, malformed or unreadable value fails the run (UNAVAILABLE), so a
 * clean-up never works with a guessed grace period. The clean-up needs the media policy only; the other two are read the same strict way for completeness.
 */
export function createWorkerGigPolicy(configuration: Pick<ConfigurationService, 'resolveMany'>): GigPolicyProvider {
  const read = async (keys: readonly string[]): Promise<Record<string, unknown>> => {
    try {
      const { values } = await configuration.resolveMany([...keys]);
      return Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value]));
    } catch {
      throw new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_UNREADABLE' });
    }
  };
  return {
    async policy() {
      return parseGigPolicy(await read(gigPolicyKeys()));
    },
    async options() {
      return parseGigOptionsPolicy(await read(gigOptionsPolicyKeys()));
    },
    async media() {
      return parseGigMediaPolicy(await read(gigMediaPolicyKeys()));
    },
  };
}

/** The worker never edits a draft: the draft primitive of the Gig service does not exist here, and the clean-up never asks for it. */
const noDrafts: DraftMutator = {
  async readDraft() {
    throw new GigError('UNAVAILABLE', 'drafts are not available in the worker', { reason: 'NOT_AVAILABLE' });
  },
  async mutateDraft() {
    throw new GigError('UNAVAILABLE', 'drafts are not available in the worker', { reason: 'NOT_AVAILABLE' });
  },
};

/** The media service the worker runs the clean-up with: database + object store + configuration (no scanner: the clean-up never finalizes an upload). */
export function createGigMediaCleaner(deps: {
  database: Database;
  store: PrivateObjectStore;
  configuration: Pick<ConfigurationService, 'resolveMany'>;
}): GigMediaCleaner {
  return new GigMediaService({
    database: deps.database,
    store: deps.store,
    scanner: DisabledGigMediaScanner,
    policy: createWorkerGigPolicy(deps.configuration),
    drafts: noDrafts,
  });
}
