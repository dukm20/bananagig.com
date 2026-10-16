// Unit tests of the in-memory security ports other test files rely on (ID-004): per-subject state, the call log, failure injection and holding a call.
import { describe, expect, it } from 'vitest';
import { FakeSecurityIdentityProvider } from './security-fakes';
import { SecurityProviderUnavailableError } from './security-types';

describe('FakeSecurityIdentityProvider', () => {
  it('serves the state set for a subject and defaults for an unknown one', async () => {
    const p = new FakeSecurityIdentityProvider();
    expect(await p.getUserSecurity('u1')).toEqual({ otpConfigured: false, recoveryCodesConfigured: false, passwordChangedAt: null, email: null });
    const at = new Date('2026-01-02T03:04:05Z');
    p.setUser('u1', { otpConfigured: true, passwordChangedAt: at, email: 'a@b.co' });
    expect(await p.getUserSecurity('u1')).toEqual({ otpConfigured: true, recoveryCodesConfigured: false, passwordChangedAt: at, email: 'a@b.co' });
    expect(await p.getUserSecurity('u2')).toMatchObject({ otpConfigured: false });
  });
  it('lists, ends one and ends all sessions of a subject', async () => {
    const p = new FakeSecurityIdentityProvider();
    p.addSession('u1', 's1');
    p.addSession('u1', 's2');
    p.addSession('u2', 's3');
    expect((await p.listSessions('u1')).map((s) => s.id)).toEqual(['s1', 's2']);
    await p.endSession('s1');
    await p.endSession('unknown');
    expect((await p.listSessions('u1')).map((s) => s.id)).toEqual(['s2']);
    await p.endAllSessions('u1');
    expect(await p.listSessions('u1')).toEqual([]);
    expect((await p.listSessions('u2')).map((s) => s.id)).toEqual(['s3']);
    expect(p.endedSessions).toEqual(['s1', 'unknown', 's2']);
  });
  it('returns copies: mutating a listed session does not change the provider', async () => {
    const p = new FakeSecurityIdentityProvider();
    p.addSession('u1', 's1');
    (await p.listSessions('u1'))[0]!.id = 'changed';
    expect((await p.listSessions('u1'))[0]!.id).toBe('s1');
  });
  it('records reset emails with their lifetime and logs every call', async () => {
    const p = new FakeSecurityIdentityProvider();
    await p.sendPasswordResetEmail('u1', { lifespanSeconds: 3600 });
    expect(p.sentResetEmails).toEqual([{ subject: 'u1', lifespanSeconds: 3600 }]);
    expect(p.callsOf('sendPasswordResetEmail')).toEqual([{ method: 'sendPasswordResetEmail', subject: 'u1', lifespanSeconds: 3600 }]);
  });
  it('failNext fails the next N calls of one method only, then recovers', async () => {
    const p = new FakeSecurityIdentityProvider();
    p.failNext('listSessions', 2);
    await expect(p.listSessions('u1')).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    await expect(p.listSessions('u1')).rejects.toMatchObject({ reason: 'INJECTED' });
    await expect(p.listSessions('u1')).resolves.toEqual([]);
    await expect(p.getUserSecurity('u1')).resolves.toBeDefined();
    p.failNext('endSession', Infinity);
    for (let i = 0; i < 5; i++) await expect(p.endSession('s')).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    p.clearFailures();
    await expect(p.endSession('s')).resolves.toBeUndefined();
  });
  it('behaves like the null provider when not available (every method throws NOT_CONFIGURED)', async () => {
    const p = new FakeSecurityIdentityProvider();
    p.available = false;
    await expect(p.getUserSecurity('u1')).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    await expect(p.listSessions('u1')).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    await expect(p.endSession('s')).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    await expect(p.endAllSessions('u1')).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    await expect(p.sendPasswordResetEmail('u1', { lifespanSeconds: 60 })).rejects.toBeInstanceOf(SecurityProviderUnavailableError);
    expect(p.sentResetEmails).toEqual([]);
  });
  it('hold keeps a call pending until released', async () => {
    const p = new FakeSecurityIdentityProvider();
    const release = p.hold('sendPasswordResetEmail');
    let done = false;
    const pending = p.sendPasswordResetEmail('u1', { lifespanSeconds: 60 }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(p.sentResetEmails).toEqual([]);
    release();
    await pending;
    expect(done).toBe(true);
    expect(p.sentResetEmails).toHaveLength(1);
  });
  it('reset clears state, calls, failures and availability', async () => {
    const p = new FakeSecurityIdentityProvider();
    p.setUser('u1', { otpConfigured: true });
    p.available = false;
    p.failNext('endSession');
    p.reset();
    expect(p.available).toBe(true);
    expect(p.calls).toEqual([]);
    await expect(p.getUserSecurity('u1')).resolves.toMatchObject({ otpConfigured: false });
    await expect(p.endSession('s')).resolves.toBeUndefined();
  });
});
