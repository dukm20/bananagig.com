// Unit tests of the typed verification error and of the database-outage classifier (TRUST-001).
import { describe, expect, it } from 'vitest';
import { TrustError, isDatabaseOutage } from './errors';

const pg = (code: string, message = 'driver text'): Error & { code: string } => Object.assign(new Error(message), { code });

describe('TrustError', () => {
  it('carries code, message and details, and is an Error named TrustError', () => {
    const e = new TrustError('CONFLICT', 'msg', { reason: 'X' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TrustError');
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toBe('msg');
    expect(e.details).toEqual({ reason: 'X' });
  });
  it('defaults details to an empty object (not shared between instances)', () => {
    const a = new TrustError('CONFLICT', 'm');
    const b = new TrustError('CONFLICT', 'm');
    expect(a.details).toEqual({});
    expect(a.details).not.toBe(b.details);
  });
});

describe('isDatabaseOutage', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'is true for the connectivity code %s, whatever the message',
    (code) => {
      expect(isDatabaseOutage(pg(code, 'x'))).toBe(true);
    },
  );
  it.each(['08000', '08006', '08001', '53000', '53300', '57P01', '57014', '58000', '58P01'])(
    'is true for SQLSTATE %s (connection, resources, operator, system class)',
    (code) => {
      expect(isDatabaseOutage(pg(code, 'x'))).toBe(true);
    },
  );
  it.each(['22001', '22P02', '23000', '23502', '23503', '23505', '23514', '25P02', '40001', '40P01', '42601', '42703', '42P01'])(
    'is false for SQLSTATE %s (data, integrity, transaction, syntax: the database answered)',
    (code) => {
      expect(isDatabaseOutage(pg(code, 'x'))).toBe(false);
    },
  );
  it('the SQL-level classes win over a message that merely mentions a connection', () => {
    expect(isDatabaseOutage(pg('23505', 'duplicate key; connection timeout'))).toBe(false);
    expect(isDatabaseOutage(pg('42P01', 'relation does not exist (connection)'))).toBe(false);
  });
  it('is false for a TrustError, even one carrying an outage-like code or message', () => {
    expect(isDatabaseOutage(new TrustError('UNAVAILABLE', 'connection refused'))).toBe(false);
    const t = Object.assign(new TrustError('UNAVAILABLE', 'timeout'), { code: 'ECONNREFUSED' });
    expect(isDatabaseOutage(t)).toBe(false);
  });
  it.each([new TypeError('connection'), new RangeError('timeout'), new ReferenceError('socket'), new SyntaxError('connect')])(
    'is false for the programming error %s even with an outage-like message',
    (e) => {
      expect(isDatabaseOutage(e)).toBe(false);
      expect(isDatabaseOutage(Object.assign(e, { code: 'ECONNRESET' }))).toBe(false);
    },
  );
  it.each([
    'Connection terminated unexpectedly',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'timeout exceeded when trying to connect',
    'Query read timeout',
    'timed out',
    'socket hang up',
    'terminating connection due to administrator command',
    'ECONN something',
  ])('is true for a code-less error with the message %j', (message) => {
    expect(isDatabaseOutage(new Error(message))).toBe(true);
  });
  it('is false for a code-less error with an unrelated message', () => {
    expect(isDatabaseOutage(new Error('null value in column'))).toBe(false);
    expect(isDatabaseOutage(new Error(''))).toBe(false);
  });
  it('is false for an unknown code with an unrelated message and for a code-less non-Error', () => {
    expect(isDatabaseOutage(pg('XX000', 'internal'))).toBe(false);
    expect(isDatabaseOutage(pg('99999', 'boom'))).toBe(false);
  });
  it('does not treat a message of a non-Error value as an outage', () => {
    expect(isDatabaseOutage({ message: 'connection refused' })).toBe(false);
    expect(isDatabaseOutage('connection refused')).toBe(false);
  });
  it('is false for null, undefined and primitives', () => {
    for (const v of [null, undefined, 0, 1, '', true, Symbol('x')]) expect(isDatabaseOutage(v)).toBe(false);
  });
  it('requires a five-character SQLSTATE for the class prefixes', () => {
    expect(isDatabaseOutage(pg('08', 'x'))).toBe(false);
    expect(isDatabaseOutage(pg('08000X', 'x'))).toBe(false);
    expect(isDatabaseOutage(pg('53', 'x'))).toBe(false);
    expect(isDatabaseOutage(pg('s08000', 'x'))).toBe(false);
  });
  it('ignores a numeric code', () => {
    expect(isDatabaseOutage(Object.assign(new Error('x'), { code: 8000 }))).toBe(false);
  });
});
