// Connection pool and timeout policy per process role. Defaults live here (infrastructure), never in business code;
// every value can be overridden from environment configuration (see @bananagig/config `db`).
export type PoolRole = 'api' | 'worker' | 'migrations' | 'tests';

export interface PoolPolicy {
  /** Maximum connections in the pool (pg opens lazily; the effective minimum is 0). */
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  /** Server-side per-statement limit. 0 disables (only migrations/maintenance may use long or no limits). */
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  /** Kills sessions that sit idle inside an open transaction (leak protection). */
  idleInTransactionTimeoutMs: number;
  applicationName: string;
}

export const POOL_POLICIES: Readonly<Record<PoolRole, PoolPolicy>> = {
  api: {
    max: 10,
    idleTimeoutMs: 30_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 15_000,
    lockTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 30_000,
    applicationName: 'bananagig-api',
  },
  worker: {
    max: 10,
    idleTimeoutMs: 30_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 60_000,
    lockTimeoutMs: 10_000,
    idleInTransactionTimeoutMs: 60_000,
    applicationName: 'bananagig-worker',
  },
  migrations: {
    max: 1,
    idleTimeoutMs: 1_000,
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
    idleInTransactionTimeoutMs: 0,
    applicationName: 'bananagig-migrator',
  },
  tests: {
    max: 5,
    idleTimeoutMs: 1_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    lockTimeoutMs: 3_000,
    idleInTransactionTimeoutMs: 30_000,
    applicationName: 'bananagig-tests',
  },
};

/** pg-boss keeps its own pool inside the worker process. */
export const PG_BOSS_POOL_MAX = 5;
/** Rough allowance for other databases' clients on the same server (Keycloak's own pool). */
export const KEYCLOAK_POOL_ALLOWANCE = 20;

export interface ConnectionBudget {
  /** Worst case for one api replica, one worker replica, one migration run and one test run at the same time. */
  perRole: Record<string, number>;
  total: number;
}

/** Worst-case connections the local stack can open, used to validate against the server's max_connections. */
export function connectionBudget(replicas: { api?: number; worker?: number } = {}): ConnectionBudget {
  const api = (replicas.api ?? 1) * POOL_POLICIES.api.max;
  const worker = (replicas.worker ?? 1) * (POOL_POLICIES.worker.max + PG_BOSS_POOL_MAX);
  const perRole = { api, worker, migrations: POOL_POLICIES.migrations.max, tests: POOL_POLICIES.tests.max, keycloak: KEYCLOAK_POOL_ALLOWANCE };
  return { perRole, total: Object.values(perRole).reduce((a, b) => a + b, 0) };
}

export interface PolicyOverrides {
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export function resolvePolicy(role: PoolRole, overrides: PolicyOverrides = {}): PoolPolicy {
  const base = POOL_POLICIES[role];
  return {
    ...base,
    max: overrides.poolMax ?? base.max,
    idleTimeoutMs: overrides.idleTimeoutMs ?? base.idleTimeoutMs,
    connectionTimeoutMs: overrides.connectionTimeoutMs ?? base.connectionTimeoutMs,
    statementTimeoutMs: overrides.statementTimeoutMs ?? base.statementTimeoutMs,
  };
}
