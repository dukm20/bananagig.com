// Durable scheduled activation of content versions (pg-boss). The registry stays correct without it (the resolver uses effective
// timestamps); this advances workflow state (SCHEDULED -> PUBLISHED), supersedes the replaced version, emits events and invalidates caches.
// Idempotent and safe to run concurrently or late: it only touches versions whose start has already passed (FOR UPDATE SKIP LOCKED).
import type { PgBoss } from 'pg-boss';
import type { ContentService } from '@bananagig/content';
import { log } from '@bananagig/observability';
import { jobHandler } from '../runtime/job';

export const CONTENT_ACTIVATION_QUEUE = 'content.activate-due';
/** Every minute: the sweep is a safety net, so versions become PUBLISHED at most about a minute after their effective time. */
export const CONTENT_ACTIVATION_CRON = '* * * * *';

export async function registerContentJobs(boss: PgBoss, content: ContentService, concurrency = 1): Promise<void> {
  await boss.createQueue(CONTENT_ACTIVATION_QUEUE);
  await boss.schedule(CONTENT_ACTIVATION_QUEUE, CONTENT_ACTIVATION_CRON);
  await boss.work(
    CONTENT_ACTIVATION_QUEUE,
    { localConcurrency: concurrency },
    jobHandler<Record<string, never>>(CONTENT_ACTIVATION_QUEUE, async () => {
      const activated = await content.activateDue();
      if (activated) log('info', 'content versions activated', { activated });
    }),
  );
}
