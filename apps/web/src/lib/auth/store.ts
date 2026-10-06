import type { AuthTransaction, SessionRecord, SessionStore } from './types';

/** In-memory store for tests. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly transactions = new Map<string, AuthTransaction>();
  async putSession(id: string, record: SessionRecord): Promise<void> {
    this.sessions.set(id, record);
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

interface ValkeyLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
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
