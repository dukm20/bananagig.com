export const MIGRATION_LOCK_KEY: number;
export const HEADER_FIELDS: string[];
export interface MigrationFile { version: number; filename: string; sql: string; checksum: string }
export function loadMigrations(dir: string): { files: MigrationFile[]; errors: string[] };
export interface RunOptions { url: string; dir: string; mode?: 'apply' | 'check'; lockTimeoutMs?: number; statementTimeoutMs?: number; log?: (line: string) => void }
export function runMigrations(o: RunOptions): Promise<{ applied: string[]; skipped: string[]; pending: string[] }>;
