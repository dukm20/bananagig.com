// In-memory implementations of the security ports for tests (ID-004): a fake identity provider with per-subject state and failure injection, and a static policy
// provider. Never imported by production code. The fake records its calls (identifiers only) so tests can assert what the service asked the provider to do.
import {
  SecurityProviderUnavailableError,
  type IdentityProviderSession,
  type IdentityUserSecurity,
  type SecurityIdentityProvider,
  type SecurityPolicy,
  type SecurityPolicyProvider,
} from './security-types';
import { assertSecurityPolicy } from './security-policy';

/** The methods of the identity provider port, as named in the call log and in failure injection. */
export type FakeProviderMethod = 'getUserSecurity' | 'listSessions' | 'endSession' | 'endAllSessions' | 'sendPasswordResetEmail';

export interface FakeUser {
  otpConfigured: boolean;
  recoveryCodesConfigured: boolean;
  passwordChangedAt: Date | null;
  email: string | null;
  sessions: IdentityProviderSession[];
}
export interface FakeProviderCall {
  method: FakeProviderMethod;
  subject?: string;
  sessionId?: string;
  lifespanSeconds?: number;
}

const emptyUser = (): FakeUser => ({ otpConfigured: false, recoveryCodesConfigured: false, passwordChangedAt: null, email: null, sessions: [] });

export class FakeSecurityIdentityProvider implements SecurityIdentityProvider {
  /** Set to false to behave like the null provider (every method then throws SecurityProviderUnavailableError). */
  available = true;
  readonly calls: FakeProviderCall[] = [];
  /** Reset emails the provider accepted (identifiers and lifetime only). */
  readonly sentResetEmails: { subject: string; lifespanSeconds: number }[] = [];
  /** Session ids ended through endSession / endAllSessions, in order. */
  readonly endedSessions: string[] = [];

  private readonly users = new Map<string, FakeUser>();
  private readonly failing = new Map<FakeProviderMethod, number>();
  private readonly gates = new Map<FakeProviderMethod, Promise<void>>();

  // ------------------------------------------------------------------ test controls
  /** Creates or updates the state of one subject. */
  setUser(subject: string, patch: Partial<FakeUser> = {}): FakeUser {
    const user = { ...(this.users.get(subject) ?? emptyUser()), ...patch };
    this.users.set(subject, user);
    return user;
  }
  user(subject: string): FakeUser {
    return this.users.get(subject) ?? this.setUser(subject);
  }
  addSession(subject: string, id: string, at: Date = new Date()): void {
    const u = this.user(subject);
    this.users.set(subject, { ...u, sessions: [...u.sessions.filter((s) => s.id !== id), { id, startedAt: at, lastAccessAt: at }] });
  }
  /** Makes the next `times` calls of `method` throw SecurityProviderUnavailableError ('INJECTED'); Infinity = every call. */
  failNext(method: FakeProviderMethod, times = 1): void {
    this.failing.set(method, times);
  }
  clearFailures(): void {
    this.failing.clear();
  }
  /** Holds every call of `method` until the returned function is called (to observe that a caller does not wait for the provider). */
  hold(method: FakeProviderMethod): () => void {
    let release!: () => void;
    this.gates.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      this.gates.delete(method);
      release();
    };
  }
  callsOf(method: FakeProviderMethod): FakeProviderCall[] {
    return this.calls.filter((c) => c.method === method);
  }
  reset(): void {
    this.users.clear();
    this.calls.length = 0;
    this.sentResetEmails.length = 0;
    this.endedSessions.length = 0;
    this.failing.clear();
    this.gates.clear();
    this.available = true;
  }

  // ------------------------------------------------------------------ the port
  private async enter(call: FakeProviderCall): Promise<void> {
    this.calls.push(call);
    const gate = this.gates.get(call.method);
    if (gate) await gate;
    if (!this.available) throw new SecurityProviderUnavailableError('NOT_CONFIGURED');
    const remaining = this.failing.get(call.method);
    if (remaining !== undefined && remaining > 0) {
      if (Number.isFinite(remaining)) this.failing.set(call.method, remaining - 1);
      throw new SecurityProviderUnavailableError('INJECTED');
    }
  }

  async getUserSecurity(subject: string): Promise<IdentityUserSecurity> {
    await this.enter({ method: 'getUserSecurity', subject });
    const u = this.user(subject);
    return { otpConfigured: u.otpConfigured, recoveryCodesConfigured: u.recoveryCodesConfigured, passwordChangedAt: u.passwordChangedAt, email: u.email };
  }
  async listSessions(subject: string): Promise<IdentityProviderSession[]> {
    await this.enter({ method: 'listSessions', subject });
    return this.user(subject).sessions.map((s) => ({ ...s }));
  }
  async endSession(sessionId: string): Promise<void> {
    await this.enter({ method: 'endSession', sessionId });
    for (const [subject, u] of this.users) this.users.set(subject, { ...u, sessions: u.sessions.filter((s) => s.id !== sessionId) });
    this.endedSessions.push(sessionId);
  }
  async endAllSessions(subject: string): Promise<void> {
    await this.enter({ method: 'endAllSessions', subject });
    const u = this.user(subject);
    this.endedSessions.push(...u.sessions.map((s) => s.id));
    this.users.set(subject, { ...u, sessions: [] });
  }
  async sendPasswordResetEmail(subject: string, options: { lifespanSeconds: number }): Promise<void> {
    await this.enter({ method: 'sendPasswordResetEmail', subject, lifespanSeconds: options.lifespanSeconds });
    this.sentResetEmails.push({ subject, lifespanSeconds: options.lifespanSeconds });
  }
}

/** A provider with fixed values (validated on every read, like the real one). */
export class StaticSecurityPolicyProvider implements SecurityPolicyProvider {
  /** Number of reads, for tests that check a policy is read (or not) per operation. */
  reads = 0;
  constructor(private value: SecurityPolicy) {}
  /** Replaces the values (a configuration change between two calls). */
  set(value: SecurityPolicy): void {
    this.value = value;
  }
  async policy(): Promise<SecurityPolicy> {
    this.reads += 1;
    return assertSecurityPolicy(this.value);
  }
}

/** The seeded values of migration 0012 (3 PRD defaults, 3 assumptions). */
export const SEEDED_SECURITY_POLICY: SecurityPolicy = {
  trustedBrowserDays: 30,
  keepSignedInDays: 30,
  stepUpValidMinutes: 15,
  activityLogDays: 90,
  resetLinkValidityMinutes: 60,
  resetMaxRequestsPerHour: 5,
};
