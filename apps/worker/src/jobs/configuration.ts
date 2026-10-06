// Durable scheduled activation of configuration changes (pg-boss). The registry stays correct without it (the resolver uses
// effective timestamps); this advances workflow state (SCHEDULED -> ACTIVE), emits events and invalidates caches.
// Idempotent and safe to run concurrently or late: it only touches changes whose version is already effective.
import type { PgBoss } from 'pg-boss';
import type { ConfigurationService } from '@bananagig/configuration';
import { log } from '@bananagig/observability';
import { jobHandler } from '../runtime/job';

export const CONFIGURATION_ACTIVATION_QUEUE = 'configuration.activate-due';
/** Every minute: the sweep is a safety net, so changes become ACTIVE at most about a minute after their effective time. */
export const CONFIGURATION_ACTIVATION_CRON = '* * * * *';

export async function registerConfigurationJobs(boss: PgBoss, configuration: ConfigurationService, concurrency = 1): Promise<void> {
  await boss.createQueue(CONFIGURATION_ACTIVATION_QUEUE);
  await boss.schedule(CONFIGURATION_ACTIVATION_QUEUE, CONFIGURATION_ACTIVATION_CRON);
  await boss.work(
    CONFIGURATION_ACTIVATION_QUEUE,
    { localConcurrency: concurrency },
    jobHandler<Record<string, never>>(CONFIGURATION_ACTIVATION_QUEUE, async () => {
      const activated = await configuration.activateDue();
      if (activated) log('info', 'configuration changes activated', { activated });
    }),
  );
}
