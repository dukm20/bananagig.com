import type { TokenVerifier } from '@bananagig/identity';

export interface AuthConfig {
  clientId: string;
  /** Allowed Origin for state-changing requests (logout), derived from WEB_PUBLIC_URL. */
  webOrigin: string;
  webPublicUrl: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  endpoints: { authorization: string; endSession: string; token: string };
  /** `Secure` cookies and the `__Host-` prefix apply when the public URL is https (production). */
  cookieSecure: boolean;
  sessionCookie: string;
  txCookie: string;
}

/** Server-side session record. Tokens live ONLY here (Valkey), never in the browser. */
export interface SessionRecord {
  subject: string;
  realmRoles: string[];
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch seconds. */
  accessExpiresAt: number;
  createdAt: number;
}

export interface AuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export interface SessionStore {
  putSession(id: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  putTransaction(id: string, tx: AuthTransaction, ttlSeconds: number): Promise<void>;
  /** Atomically read and delete (a login transaction can be consumed once). */
  takeTransaction(id: string): Promise<AuthTransaction | null>;
}

export interface AuthDeps {
  cfg: AuthConfig;
  store: SessionStore;
  verifier: TokenVerifier;
  fetch?: typeof fetch;
  /** Epoch seconds (injectable for tests). */
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>) => void;
}
