// DEV/TEST adapters of the evidence ports (TRUST-001) and the fail-closed production ones. There is no real malware scanner and no real external verification vendor yet
// (DEBT-0087); production uses the disabled adapters, which report ERROR / unavailable, so nothing is ever treated as scanned or externally verified by a stand-in.
import { randomUUID } from 'node:crypto';
import type { TrustExternalStatus } from '@bananagig/contracts';
import { TrustError } from './errors';
import type { EvidenceScanner, ExternalVerificationRequest, ExternalVerificationSummary, ScanInput, ScanResult, VerificationProvider } from './types';

/** The standard EICAR antivirus TEST string (harmless by design): the fake scanner reports a file that contains it as INFECTED so the infected path can be tested for real. */
export const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** DEV/TEST ONLY: scans nothing; CLEAN unless the file contains the EICAR test string. Refused in production configuration. */
export class FakeEvidenceScanner implements EvidenceScanner {
  async scan(i: ScanInput): Promise<ScanResult> {
    return { status: i.bytes.includes(Buffer.from(EICAR_TEST_STRING, 'latin1')) ? 'INFECTED' : 'CLEAN' };
  }
}

/** Production default until a real scanner exists: reports ERROR, so with clean scans required (the default) no document can be attached (fail closed). */
export class DisabledEvidenceScanner implements EvidenceScanner {
  async scan(): Promise<ScanResult> {
    return { status: 'ERROR' };
  }
}

/**
 * DEV/TEST ONLY external provider. `create` returns a PENDING verification; a later `status` call reports APPROVED unless the outcome was set (`setOutcome`). It stands for the
 * contract an adapter must honour; it calls nothing and stores nothing outside memory.
 */
export class FakeVerificationProvider implements VerificationProvider {
  readonly name = 'fake';
  private readonly runs = new Map<string, { status: TrustExternalStatus; validUntil: Date | null; polls: number }>();
  /** Test hook: decide the outcome of a verification. */
  setOutcome(externalId: string, status: TrustExternalStatus, validUntil: Date | null = null): void {
    const run = this.runs.get(externalId);
    if (!run) throw new Error('unknown external verification');
    run.status = status;
    run.validUntil = validUntil;
    run.polls = Number.MAX_SAFE_INTEGER;
  }
  async create(_r: ExternalVerificationRequest): Promise<{ externalId: string; status: 'CREATED' | 'PENDING' }> {
    const externalId = `fake-${randomUUID()}`;
    this.runs.set(externalId, { status: 'PENDING', validUntil: null, polls: 0 });
    return { externalId, status: 'PENDING' };
  }
  async status(externalId: string): Promise<ExternalVerificationSummary> {
    const run = this.runs.get(externalId);
    if (!run) throw new TrustError('NOT_FOUND', 'unknown external verification');
    run.polls += 1;
    // the first poll still says PENDING; later polls resolve to APPROVED unless an outcome was set
    if (run.status === 'PENDING' && run.polls >= 2) run.status = 'APPROVED';
    return { status: run.status, validUntil: run.status === 'APPROVED' ? run.validUntil : null };
  }
  async cancel(externalId: string): Promise<void> {
    const run = this.runs.get(externalId);
    if (run && run.status !== 'APPROVED' && run.status !== 'REJECTED') run.status = 'CANCELLED';
  }
  async evidenceSummary(externalId: string): Promise<ExternalVerificationSummary & { checkedAt: Date }> {
    return { ...(await this.status(externalId)), checkedAt: new Date() };
  }
}

/** Production default until a vendor adapter exists: every call is "unavailable". */
export class DisabledVerificationProvider implements VerificationProvider {
  readonly name = 'disabled';
  private fail(): never {
    throw new TrustError('EXTERNAL_UNAVAILABLE', 'no external verification provider is configured');
  }
  async create(): Promise<never> {
    return this.fail();
  }
  async status(): Promise<never> {
    return this.fail();
  }
  async cancel(): Promise<never> {
    return this.fail();
  }
  async evidenceSummary(): Promise<never> {
    return this.fail();
  }
}
