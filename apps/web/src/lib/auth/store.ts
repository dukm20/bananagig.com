import type { AuthTransaction, SessionRecord, SessionStore } from './types';

/** In-memory store for tests. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly transactions = new Map<string, AuthTransaction>();
  async putSession(id: string, record: SessionRecord): Promise<void> {
    this.sessions.set(id, record);
  }
  async updateSession(id: string, record: SessionRecord): Promise<boolean> {
    if (!this.sessions.has(id)) return false;
    this.sessions.set(id, record);
    return true;
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
  async putTransaction(id: string, tx: AuthTransaction): Promise<void> {
    this.transactions.set(id, tx);
  }
  async takeTransaction(id: string): Promise<AuthTransaction | null> {
    const tx = this.transactions.get(id) ?? null;
    this.transactions.delete(id);
    return tx;
  }
}

export interface ValkeyLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  /** Overwrite an existing key only (XX) and keep its TTL: the reply is 'OK' when written, null when the key does not exist. */
  set(key: string, value: string, keepTtl: 'KEEPTTL', onlyIfExists: 'XX'): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/**
 * Valkey-backed store. Namespace `bg:<env>:web:<kind>:<id>`, TTL on every key. Valkey is non-authoritative (ADR-0003):
 * losing it only signs users out; Keycloak remains the owner of sessions and credentials.
 */
export class ValkeySessionStore implements SessionStore {
  constructor(
    private readonly client: ValkeyLike,
    private readonly env: string,
  ) {}
  private key = (kind: 'session' | 'authtx', id: string): string => `bg:${this.env}:web:${kind}:${id}`;
  async putSession(id: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key('session', id), JSON.stringify(record), 'EX', Math.max(1, Math.floor(ttlSeconds)));
  }
  async updateSession(id: string, record: SessionRecord): Promise<boolean> {
    return (await this.client.set(this.key('session', id), JSON.stringify(record), 'KEEPTTL', 'XX')) === 'OK';
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    const raw = await this.client.get(this.key('session', id));
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }
  async deleteSession(id: string): Promise<void> {
    await this.client.del(this.key('session', id));
  }
  async putTransaction(id: string, tx: AuthTransaction, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key('authtx', id), JSON.stringify(tx), 'EX', ttlSeconds);
  }
  async takeTransaction(id: string): Promise<AuthTransaction | null> {
    const raw = await this.client.getdel(this.key('authtx', id));
    return raw ? (JSON.parse(raw) as AuthTransaction) : null;
  }
}
