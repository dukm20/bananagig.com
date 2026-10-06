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
