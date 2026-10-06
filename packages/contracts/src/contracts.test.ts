import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ERROR_CATEGORIES, ERROR_STATUS, ErrorResponse, EventEnvelope, SystemInfoResponse, isSafeCorrelationId } from './index';

const event = () => ({
  eventId: randomUUID(),
  eventType: 'bananagig.infra.ping.v1',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'corr-12345678',
  causationId: null,
  actor: { type: 'system', id: null },
  aggregateType: 'infra',
  aggregateId: 'x',
  payload: {},
});

describe('contracts', () => {
  it('validates the event envelope and rejects malformed event types', () => {
    expect(EventEnvelope.safeParse(event()).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...event(), eventType: 'booking.created' }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...event(), eventId: 'nope' }).success).toBe(false);
  });
  it('validates error and system-info responses', () => {
    expect(ErrorResponse.safeParse({ error: { code: 'X', category: 'INTERNAL', message: 'm', correlationId: 'c' } }).success).toBe(true);
    expect(ErrorResponse.safeParse({ error: { code: 'X', category: 'BOGUS', message: 'm', correlationId: 'c' } }).success).toBe(false);
    const ok = { data: { service: 's', environment: 'test', version: '1', apiVersion: 'v1', serverTime: 't', uptimeSeconds: 1 }, meta: { correlationId: 'c' } };
    expect(SystemInfoResponse.safeParse(ok).success).toBe(true);
  });
  it('maps every error category to a status', () => {
    for (const c of ERROR_CATEGORIES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });
  it('accepts only safe correlation ids', () => {
    expect(isSafeCorrelationId('abc-12345678')).toBe(true);
    expect(isSafeCorrelationId('short')).toBe(false);
    expect(isSafeCorrelationId('has space and \n newline')).toBe(false);
  });
});
