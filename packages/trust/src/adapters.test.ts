// Unit tests of the evidence adapters (TRUST-001): the fake scanner with the EICAR test string, the fail-closed disabled scanner, the contract of the fake external verification
// provider and the disabled provider.
import { describe, expect, it } from 'vitest';
import { DisabledEvidenceScanner, DisabledVerificationProvider, EICAR_TEST_STRING, FakeEvidenceScanner, FakeVerificationProvider } from './adapters';
import { TrustError } from './errors';

const scanInput = (bytes: Buffer) => ({ key: 'trust/evidence/c/d', size: bytes.byteLength, bytes });
const REQ = { reference: 'req-1', requirementType: 'BACKGROUND_CHECK' } as const;

describe('EICAR_TEST_STRING', () => {
  it('is the standard 68-character antivirus test string', () => {
    expect(EICAR_TEST_STRING).toHaveLength(68);
    expect(EICAR_TEST_STRING.startsWith('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')).toBe(true);
  });
});

describe('FakeEvidenceScanner', () => {
  const scanner = new FakeEvidenceScanner();
  it('reports CLEAN for ordinary bytes', async () => {
    expect(await scanner.scan(scanInput(Buffer.from('%PDF-1.4 synthetic fixture')))).toEqual({ status: 'CLEAN' });
    expect(await scanner.scan(scanInput(Buffer.alloc(0)))).toEqual({ status: 'CLEAN' });
  });
  it('reports INFECTED for a file that is exactly the EICAR string', async () => {
    expect(await scanner.scan(scanInput(Buffer.from(EICAR_TEST_STRING, 'latin1')))).toEqual({ status: 'INFECTED' });
  });
  it('reports INFECTED when the EICAR string is embedded anywhere in the file', async () => {
    expect((await scanner.scan(scanInput(Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF`, 'latin1')))).status).toBe('INFECTED');
    expect((await scanner.scan(scanInput(Buffer.concat([Buffer.alloc(4096, 0x41), Buffer.from(EICAR_TEST_STRING, 'latin1')])))).status).toBe('INFECTED');
  });
  it('stays CLEAN for a near miss (one character changed, or truncated)', async () => {
    expect((await scanner.scan(scanInput(Buffer.from(EICAR_TEST_STRING.replace('EICAR', 'EICAS'), 'latin1')))).status).toBe('CLEAN');
    expect((await scanner.scan(scanInput(Buffer.from(EICAR_TEST_STRING.slice(0, -1), 'latin1')))).status).toBe('CLEAN');
  });
  it('is deterministic and never reports ERROR or PENDING', async () => {
    const results = await Promise.all([1, 2, 3].map(() => scanner.scan(scanInput(Buffer.from('abc')))));
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(['CLEAN']));
  });
});

describe('DisabledEvidenceScanner', () => {
  it('reports ERROR for clean bytes and for the EICAR string alike (it scans nothing; fail closed)', async () => {
    const s = new DisabledEvidenceScanner();
    expect(await s.scan()).toEqual({ status: 'ERROR' });
    expect((await (s as unknown as FakeEvidenceScanner).scan(scanInput(Buffer.from(EICAR_TEST_STRING, 'latin1')))).status).toBe('ERROR');
    expect((await (s as unknown as FakeEvidenceScanner).scan(scanInput(Buffer.from('clean')))).status).toBe('ERROR');
  });
});

describe('FakeVerificationProvider', () => {
  it('is named fake', () => {
    expect(new FakeVerificationProvider().name).toBe('fake');
  });
  it('creates a PENDING verification with a fresh opaque id each time', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    const b = await p.create(REQ);
    expect(a.status).toBe('PENDING');
    expect(a.externalId).toMatch(/^fake-[0-9a-f-]{36}$/);
    expect(a.externalId).not.toBe(b.externalId);
    expect(a.externalId).not.toContain('req-1'); // the reference is not echoed into the external id
  });
  it('says PENDING on the first poll and APPROVED on the second and every later one', async () => {
    const p = new FakeVerificationProvider();
    const { externalId } = await p.create(REQ);
    expect(await p.status(externalId)).toEqual({ status: 'PENDING', validUntil: null });
    expect(await p.status(externalId)).toEqual({ status: 'APPROVED', validUntil: null });
    expect(await p.status(externalId)).toEqual({ status: 'APPROVED', validUntil: null });
  });
  it('keeps the runs independent', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    const b = await p.create(REQ);
    await p.status(a.externalId);
    await p.status(a.externalId);
    expect((await p.status(b.externalId)).status).toBe('PENDING');
  });
  it('setOutcome decides the answer immediately and permanently, with a validity end only for APPROVED', async () => {
    const p = new FakeVerificationProvider();
    const until = new Date('2030-01-01T00:00:00Z');
    const a = await p.create(REQ);
    p.setOutcome(a.externalId, 'APPROVED', until);
    expect(await p.status(a.externalId)).toEqual({ status: 'APPROVED', validUntil: until });
    expect(await p.status(a.externalId)).toEqual({ status: 'APPROVED', validUntil: until });
    const r = await p.create(REQ);
    p.setOutcome(r.externalId, 'REJECTED', until);
    expect(await p.status(r.externalId)).toEqual({ status: 'REJECTED', validUntil: null }); // no validity for a non-approval
    expect(await p.status(r.externalId)).toEqual({ status: 'REJECTED', validUntil: null });
  });
  it('setOutcome defaults validUntil to null', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    p.setOutcome(a.externalId, 'APPROVED');
    expect(await p.status(a.externalId)).toEqual({ status: 'APPROVED', validUntil: null });
  });
  it('setOutcome PENDING keeps the answer PENDING on later polls only if it is not resolved by polling (a set outcome is final)', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    p.setOutcome(a.externalId, 'PENDING');
    // polls were forced to the maximum, so the next poll resolves the PENDING run to APPROVED: documents the contract that PENDING is not a settable final outcome
    expect((await p.status(a.externalId)).status).toBe('APPROVED');
  });
  it('setOutcome on an unknown id throws', () => {
    expect(() => new FakeVerificationProvider().setOutcome('fake-nope', 'APPROVED')).toThrow('unknown external verification');
  });
  it('status of an unknown id is a typed NOT_FOUND', async () => {
    const err = await new FakeVerificationProvider().status('fake-nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrustError);
    expect((err as TrustError).code).toBe('NOT_FOUND');
  });
  it('cancel turns an unresolved run into CANCELLED', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    await p.cancel(a.externalId);
    expect((await p.status(a.externalId)).status).toBe('CANCELLED');
    expect((await p.status(a.externalId)).status).toBe('CANCELLED'); // polling never resurrects it
  });
  it('cancel does not undo a decided APPROVED or REJECTED outcome', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    p.setOutcome(a.externalId, 'APPROVED');
    await p.cancel(a.externalId);
    expect((await p.status(a.externalId)).status).toBe('APPROVED');
    const r = await p.create(REQ);
    p.setOutcome(r.externalId, 'REJECTED');
    await p.cancel(r.externalId);
    expect((await p.status(r.externalId)).status).toBe('REJECTED');
  });
  it('cancel after the polling approved the run does not undo it', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    await p.status(a.externalId);
    await p.status(a.externalId);
    await p.cancel(a.externalId);
    expect((await p.status(a.externalId)).status).toBe('APPROVED');
  });
  it('cancel of an unknown id is a quiet no-op', async () => {
    await expect(new FakeVerificationProvider().cancel('fake-nope')).resolves.toBeUndefined();
  });
  it('a non-APPROVED outcome never reports a validity end', async () => {
    const p = new FakeVerificationProvider();
    const a = await p.create(REQ);
    p.setOutcome(a.externalId, 'CANCELLED', new Date('2030-01-01T00:00:00Z'));
    expect((await p.status(a.externalId)).validUntil).toBeNull();
  });
  it('evidenceSummary returns the status shape plus checkedAt close to now, and counts as a poll', async () => {
    const p = new FakeVerificationProvider();
    const { externalId } = await p.create(REQ);
    const before = Date.now();
    const first = await p.evidenceSummary(externalId);
    expect(first.status).toBe('PENDING');
    expect(first.validUntil).toBeNull();
    expect(Math.abs(first.checkedAt.getTime() - before)).toBeLessThan(5000);
    expect((await p.evidenceSummary(externalId)).status).toBe('APPROVED'); // the second poll
  });
  it('evidenceSummary of an unknown id is NOT_FOUND', async () => {
    await expect(new FakeVerificationProvider().evidenceSummary('fake-nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('holds no state across instances', async () => {
    const a = new FakeVerificationProvider();
    const { externalId } = await a.create(REQ);
    await expect(new FakeVerificationProvider().status(externalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DisabledVerificationProvider', () => {
  const p = new DisabledVerificationProvider();
  it('is named disabled', () => {
    expect(p.name).toBe('disabled');
  });
  it.each([
    ['create', () => p.create()],
    ['status', () => p.status()],
    ['cancel', () => p.cancel()],
    ['evidenceSummary', () => p.evidenceSummary()],
  ] as const)('%s fails with EXTERNAL_UNAVAILABLE and a fixed message', async (_n, call) => {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrustError);
    expect((err as TrustError).code).toBe('EXTERNAL_UNAVAILABLE');
    expect((err as TrustError).message).toBe('no external verification provider is configured');
    expect((err as TrustError).details).toEqual({});
  });
});
