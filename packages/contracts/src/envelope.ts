import { z } from 'zod';

/** Success envelope for /api/v1 responses. */
export const envelope = <T extends z.ZodType>(data: T) => z.object({ data, meta: z.object({ correlationId: z.string() }) });
