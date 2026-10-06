import type { AppConfig } from '@bananagig/config';
import { API_VERSION, type SystemInfo, type VersionResponse } from '@bananagig/contracts';

export interface SystemDeps {
  cfg: AppConfig;
  startedAt: number;
}

export const buildVersion = ({ cfg }: SystemDeps): VersionResponse => ({
  service: cfg.serviceName,
  version: cfg.version.version,
  commit: cfg.version.commit,
  buildTime: cfg.version.buildTime,
  environment: cfg.env,
});

export const buildSystemInfo = ({ cfg, startedAt }: SystemDeps): SystemInfo => ({
  service: cfg.serviceName,
  environment: cfg.env,
  version: cfg.version.version,
  apiVersion: API_VERSION,
  serverTime: new Date().toISOString(),
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
});
