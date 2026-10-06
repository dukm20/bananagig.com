import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '@bananagig/config';
import { createApiClient } from './api-client';

let cached: Readonly<AppConfig> | undefined;
/** Validated once per process on first use (fails fast on invalid env), never at build time. */
export const serverConfig = (): Readonly<AppConfig> => (cached ??= loadConfig({ service: 'bananagig-web', role: 'web' }));
export const serverApi = () => createApiClient({ baseUrl: serverConfig().apiInternalUrl, correlationId: () => randomUUID() });
