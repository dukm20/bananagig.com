import { describe, expect, it, vi } from 'vitest';
import { getCorrelationId, log, resolveCorrelationId, runWithCorrelation } from './index';

describe('correlation', () => {
  it('keeps safe incoming ids and mints UUIDs otherwise', () => {
    expect(resolveCorrelationId('client-abc12345')).toBe('client-abc12345');
    expect(resolveCorrelationId('bad id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('is visible in async context and in log lines', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runWithCorrelation('corr-12345678', async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('corr-12345678');
      log('info', 'hello', { password: 'hunter2', nested: { token: 'abc' }, ok: 1 });
    });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    spy.mockRestore();
    expect(line).toMatchObject({ message: 'hello', correlationId: 'corr-12345678', password: '[REDACTED]', nested: { token: '[REDACTED]' }, ok: 1 });
    for (const f of ['timestamp', 'level', 'service', 'environment']) expect(line).toHaveProperty(f);
  });
});

describe('log redaction of personal data (addresses)', () => {
  const capture = (attrs: Record<string, unknown>): Record<string, unknown> => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      log('info', 'address event', attrs);
      return JSON.parse(spy.mock.calls[0]![0] as string);
    } finally {
      spy.mockRestore();
    }
  };

  it.each([
    'address',
    'postalCode',
    'postal_code',
    'zip',
    'zipCode',
    'latitude',
    'longitude',
    'rawInput',
    'raw_input',
    'addressLine1',
    'shippingAddress',
    'ADDRESS',
  ])('redacts the %s key', (key) => {
    expect(capture({ [key]: 'value that must never appear', ok: 1 })).toMatchObject({ [key]: '[REDACTED]', ok: 1 });
  });
  it('redacts structured values, whole objects and nested keys, and keeps unrelated keys', () => {
    const line = capture({
      address: { addressLine1: '1 Main St', postalCode: '90210' },
      location: { latitude: 34.1, longitude: -118.4 },
      list: [{ zip: '90210', country: 'US' }],
      country: 'US',
    });
    expect(line.address).toBe('[REDACTED]');
    expect(line.location).toEqual({ latitude: '[REDACTED]', longitude: '[REDACTED]' });
    expect(line.list).toEqual([{ zip: '[REDACTED]', country: 'US' }]);
    expect(line.country).toBe('US');
  });
  it('never writes a redacted value anywhere in the log line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('info', 'address event', {
      address: '1 Main St',
      postalCode: '90210',
      latitude: 34.0522,
      longitude: -118.2437,
      rawInput: { q: 'secret street' },
      zip: '90210',
    });
    const text = spy.mock.calls[0]![0] as string;
    spy.mockRestore();
    for (const leaked of ['1 Main St', '90210', '34.0522', '118.2437', 'secret street']) expect(text).not.toContain(leaked);
  });
});
