import { randomUUID } from 'node:crypto';
import type { Job } from 'pg-boss';
import { JobMeta } from '@bananagig/contracts';
import { getCorrelationId, log, runWithCorrelation, withSpan } from '@bananagig/observability';

export type WithMeta<T> = T & { _meta: JobMeta };

/** Stamp the current correlation id onto job data so it survives the hop into the worker. */
export const withJobMeta = <T extends object>(data: T): WithMeta<T> => ({ ...data, _meta: { correlationId: getCorrelationId() ?? randomUUID() } });

/**
 * Wraps a job handler: restores the correlation context, opens a span and logs outcome.
 * All job handlers must be registered through this wrapper.
 */
export function jobHandler<T extends object>(name: string, handler: (data: WithMeta<T>) => Promise<void>) {
  return async (jobs: Job<WithMeta<T>>[]): Promise<void> => {
    for (const job of jobs) {
      const parsed = JobMeta.safeParse(job.data?._meta);
      const correlationId = parsed.success ? parsed.data.correlationId : randomUUID();
      await runWithCorrelation(correlationId, () =>
        withSpan(
          `job ${name}`,
          async () => {
            log('info', 'job started', { job: name, jobId: job.id });
            await handler(job.data);
            log('info', 'job completed', { job: name, jobId: job.id });
          },
          { 'job.name': name },
        ),
      );
    }
  };
}
