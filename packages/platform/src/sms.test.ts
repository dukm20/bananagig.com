// Unit tests of the SMS delivery boundary (ID-003): the rendering sender with a fake renderer and a fake transport, the failure translation, the guarantee that
// errors never carry the number, the body or the code, the disabled transport, the Valkey test sink with a recording fake client, and the recording sender.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DisabledSmsTransport,
  FAKE_SMS_MAX_MESSAGES,
  FAKE_SMS_TTL_SECONDS,
  RecordingSmsSender,
  RenderingSmsSender,
  SMS_BODY_MAX_LENGTH,
  SmsDeliveryError,
  ValkeyFakeSmsTransport,
  fakeSmsInboxKey,
  type RenderedSms,
  type SmsMessage,
  type SmsRenderer,
  type SmsTransport,
  type SmsVariableValue,
} from './sms';

// Distinctive values so a leak into an error message is unmistakable.
const RECIPIENT = '+12025550142';
const RECIPIENT_DIGITS = '12025550142';
const CODE = '482913';
const BODY = `Your BananaGig code is ${CODE}. It expires in 10 minutes.`;

const message = (over: Partial<SmsMessage> = {}): SmsMessage => ({
  to: RECIPIENT,
  templateKey: 'sms.verification.phone',
  variables: { verification_code: CODE, expiry_minutes: 10 },
  locale: 'en-US',
  correlationId: 'corr-1',
  ...over,
});

interface RenderCall {
  templateKey: string;
  variables: Readonly<Record<string, SmsVariableValue>>;
  locale: string | undefined;
}
function fakeRenderer(result: RenderedSms | Error = { body: BODY, templateVersion: 'v3' }): SmsRenderer & { calls: RenderCall[] } {
  const calls: RenderCall[] = [];
  return {
    calls,
    async render(templateKey, variables, locale) {
      calls.push({ templateKey, variables, locale });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
interface DeliverCall {
  to: string;
  body: string;
  correlationId: string;
}
function fakeTransport(behaviour: { messageId?: string | null; error?: unknown } = {}): SmsTransport & { calls: DeliverCall[] } {
  const calls: DeliverCall[] = [];
  return {
    calls,
    async deliver(to, body, meta) {
      calls.push({ to, body, correlationId: meta.correlationId });
      if (behaviour.error !== undefined) throw behaviour.error;
      return { messageId: behaviour.messageId === undefined ? 'sms-1' : behaviour.messageId };
    },
  };
}
async function failureOf(promise: Promise<unknown>): Promise<SmsDeliveryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SmsDeliveryError);
    return err as SmsDeliveryError;
  }
  throw new Error('expected the promise to reject');
}
const noLeak = (err: Error): void => {
  const text = `${err.message} ${err.name} ${JSON.stringify(err)} ${String(err.stack).split('\n')[0]}`;
  expect(text).not.toContain(RECIPIENT);
  expect(text).not.toContain(RECIPIENT_DIGITS);
  expect(text).not.toContain(CODE);
  expect(text).not.toContain('BananaGig code');
  expect(text).not.toContain('SECRETCAUSE');
};

// ====================================================================== SmsDeliveryError
describe('SmsDeliveryError', () => {
  it('carries the code, the message and the retryable flag', () => {
    const err = new SmsDeliveryError('UNAVAILABLE', 'down', true);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SmsDeliveryError');
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toBe('down');
    expect(err.retryable).toBe(true);
  });
  it.each(['UNAVAILABLE', 'REJECTED', 'RENDER_FAILED', 'NOT_CONFIGURED'] as const)('accepts the code %s', (code) => {
    expect(new SmsDeliveryError(code, 'x', false).code).toBe(code);
  });
});

// ====================================================================== RenderingSmsSender
describe('RenderingSmsSender: success', () => {
  it('renders the template and delivers the body to the recipient with the correlation id', async () => {
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    const result = await new RenderingSmsSender(renderer, transport).send(message());
    expect(transport.calls).toEqual([{ to: RECIPIENT, body: BODY, correlationId: 'corr-1' }]);
    expect(result).toEqual({ messageId: 'sms-1', templateVersion: 'v3' });
  });
  it('passes the template key, the variables and the locale to the renderer unchanged', async () => {
    const renderer = fakeRenderer();
    await new RenderingSmsSender(renderer, fakeTransport()).send(message({ locale: 'fr-CA', variables: { verification_code: '111222', expiry_minutes: 7 } }));
    expect(renderer.calls).toEqual([{ templateKey: 'sms.verification.phone', variables: { verification_code: '111222', expiry_minutes: 7 }, locale: 'fr-CA' }]);
  });
  it('passes an undefined locale through', async () => {
    const renderer = fakeRenderer();
    const { locale: _l, ...noLocale } = message();
    await new RenderingSmsSender(renderer, fakeTransport()).send(noLocale);
    expect(renderer.calls[0]?.locale).toBeUndefined();
  });
  it('returns a null message id when the transport reports none', async () => {
    const result = await new RenderingSmsSender(fakeRenderer(), fakeTransport({ messageId: null })).send(message());
    expect(result.messageId).toBeNull();
  });
  it('returns a null template version when the renderer reports none', async () => {
    const result = await new RenderingSmsSender(fakeRenderer({ body: BODY, templateVersion: null }), fakeTransport()).send(message());
    expect(result.templateVersion).toBeNull();
  });
  it('delivers exactly one message per send', async () => {
    const transport = fakeTransport();
    const sender = new RenderingSmsSender(fakeRenderer(), transport);
    await sender.send(message());
    await sender.send(message({ correlationId: 'corr-2' }));
    expect(transport.calls.map((c) => c.correlationId)).toEqual(['corr-1', 'corr-2']);
  });
  it('accepts a body of exactly SMS_BODY_MAX_LENGTH characters and of one character', async () => {
    for (const length of [1, SMS_BODY_MAX_LENGTH]) {
      const transport = fakeTransport();
      await new RenderingSmsSender(fakeRenderer({ body: 'x'.repeat(length), templateVersion: null }), transport).send(message());
      expect(transport.calls[0]?.body).toHaveLength(length);
    }
  });
  it('has a body limit of 320 characters', () => {
    expect(SMS_BODY_MAX_LENGTH).toBe(320);
  });
  it.each(['+1234567', '+442071838750', '+123456789012345'])('accepts the E.164 recipient %s', async (to) => {
    const transport = fakeTransport();
    await new RenderingSmsSender(fakeRenderer(), transport).send(message({ to }));
    expect(transport.calls[0]?.to).toBe(to);
  });
});

describe('RenderingSmsSender: recipient validation', () => {
  it.each([
    '',
    '2025550142',
    '12025550142',
    '+1 202 555 0142',
    '+1-202-555-0142',
    '(202) 555-0142',
    '+0123456789',
    '+123456',
    '+1234567890123456',
    'abc',
    ' +12025550142',
  ])('rejects the recipient %j as REJECTED and non-retryable', async (to) => {
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), fakeTransport()).send(message({ to })));
    expect(err.code).toBe('REJECTED');
    expect(err.retryable).toBe(false);
  });
  it('rejects BEFORE rendering and before any delivery', async () => {
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    await failureOf(new RenderingSmsSender(renderer, transport).send(message({ to: 'not-a-number' })));
    expect(renderer.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
  it('does not echo the rejected recipient or the code in the error', async () => {
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), fakeTransport()).send(message({ to: '2025550142' })));
    noLeak(err);
    expect(err.message).not.toContain('2025550142');
  });
});

describe('RenderingSmsSender: render failures', () => {
  it('translates a renderer error to RENDER_FAILED, non-retryable, without delivering', async () => {
    const transport = fakeTransport();
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(new Error('template missing SECRETCAUSE')), transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    expect(err.retryable).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
  it('does not leak the cause message into the error', async () => {
    const err = await failureOf(
      new RenderingSmsSender(fakeRenderer(new Error(`failed for ${RECIPIENT} code ${CODE} SECRETCAUSE`)), fakeTransport()).send(message()),
    );
    noLeak(err);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
  it('translates a renderer that rejects with a non-Error value', async () => {
    const renderer: SmsRenderer = {
      async render() {
        throw 'SECRETCAUSE';
      },
    };
    const err = await failureOf(new RenderingSmsSender(renderer, fakeTransport()).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    noLeak(err);
  });
  it('translates a synchronous renderer throw too', async () => {
    const renderer = {
      render() {
        throw new Error('SECRETCAUSE');
      },
    } as unknown as SmsRenderer;
    const err = await failureOf(new RenderingSmsSender(renderer, fakeTransport()).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
  });
  it('treats an empty body as RENDER_FAILED without delivering', async () => {
    const transport = fakeTransport();
    const err = await failureOf(new RenderingSmsSender(fakeRenderer({ body: '', templateVersion: 'v1' }), transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    expect(err.retryable).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
  it('treats a body over SMS_BODY_MAX_LENGTH as RENDER_FAILED without delivering', async () => {
    const transport = fakeTransport();
    const body = `${CODE}${'x'.repeat(SMS_BODY_MAX_LENGTH)}`;
    const err = await failureOf(new RenderingSmsSender(fakeRenderer({ body, templateVersion: 'v1' }), transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(CODE);
    expect(transport.calls).toHaveLength(0);
  });
  it('treats a body of SMS_BODY_MAX_LENGTH + 1 characters as too long', async () => {
    const err = await failureOf(
      new RenderingSmsSender(fakeRenderer({ body: 'x'.repeat(SMS_BODY_MAX_LENGTH + 1), templateVersion: null }), fakeTransport()).send(message()),
    );
    expect(err.code).toBe('RENDER_FAILED');
  });
});

describe('RenderingSmsSender: delivery failures', () => {
  it('translates a plain transport Error to UNAVAILABLE, retryable, without leaking it', async () => {
    const err = await failureOf(
      new RenderingSmsSender(fakeRenderer(), fakeTransport({ error: new Error(`connect ECONNREFUSED to ${RECIPIENT} body ${BODY} SECRETCAUSE`) })).send(
        message(),
      ),
    );
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
    noLeak(err);
  });
  it('translates a non-Error rejection to UNAVAILABLE', async () => {
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), fakeTransport({ error: 'SECRETCAUSE' })).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
    noLeak(err);
  });
  it('translates a TypeError from the transport to UNAVAILABLE', async () => {
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), fakeTransport({ error: new TypeError('x is not a function') })).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
  });
  it.each([
    ['REJECTED', false],
    ['NOT_CONFIGURED', false],
    ['UNAVAILABLE', true],
    ['RENDER_FAILED', false],
  ] as const)('passes a transport SmsDeliveryError %s (retryable %s) through unchanged', async (code, retryable) => {
    const original = new SmsDeliveryError(code, 'provider says no', retryable);
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), fakeTransport({ error: original })).send(message()));
    expect(err).toBe(original);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
  });
  it('has the sender with the disabled transport fail as NOT_CONFIGURED and non-retryable', async () => {
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), new DisabledSmsTransport()).send(message()));
    expect(err.code).toBe('NOT_CONFIGURED');
    expect(err.retryable).toBe(false);
    noLeak(err);
  });
  it('has the sender with the production-guarded sink fail as UNAVAILABLE when the client fails', async () => {
    const client = {
      multi() {
        throw new Error('SECRETCAUSE');
      },
    };
    const err = await failureOf(new RenderingSmsSender(fakeRenderer(), new ValkeyFakeSmsTransport(client, 'test')).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
    noLeak(err);
  });
});

describe('RenderingSmsSender: no secret reaches an error, whatever fails', () => {
  const sceneries: Array<[string, () => SmsTransport, () => SmsRenderer, Partial<SmsMessage>]> = [
    ['a bad recipient', () => fakeTransport(), () => fakeRenderer(), { to: '2025550142' }],
    ['a render failure', () => fakeTransport(), () => fakeRenderer(new Error(`${CODE} ${RECIPIENT} SECRETCAUSE`)), {}],
    ['an empty body', () => fakeTransport(), () => fakeRenderer({ body: '', templateVersion: null }), {}],
    ['a long body', () => fakeTransport(), () => fakeRenderer({ body: `${BODY}${'y'.repeat(400)}`, templateVersion: null }), {}],
    ['a transport failure', () => fakeTransport({ error: new Error(`${CODE} ${RECIPIENT} ${BODY} SECRETCAUSE`) }), () => fakeRenderer(), {}],
    ['a disabled transport', () => new DisabledSmsTransport(), () => fakeRenderer(), {}],
  ];
  it.each(sceneries)('%s', async (_name, transport, renderer, over) => {
    const err = await failureOf(new RenderingSmsSender(renderer(), transport()).send(message(over)));
    noLeak(err);
    expect(err.message.length).toBeLessThan(100);
  });
});

// ====================================================================== DisabledSmsTransport
describe('DisabledSmsTransport', () => {
  it('always fails with NOT_CONFIGURED and retryable false', async () => {
    const err = await failureOf(new DisabledSmsTransport().deliver());
    expect(err.code).toBe('NOT_CONFIGURED');
    expect(err.retryable).toBe(false);
  });
  it('fails again on every call', async () => {
    const transport = new DisabledSmsTransport();
    for (let i = 0; i < 3; i += 1) expect((await failureOf(transport.deliver())).code).toBe('NOT_CONFIGURED');
  });
  it('mentions no number', async () => {
    const err = await failureOf(new DisabledSmsTransport().deliver());
    expect(err.message).not.toMatch(/\+?\d{5,}/);
  });
});

// ====================================================================== ValkeyFakeSmsTransport
type Call = [string, ...unknown[]];
function fakeClient(opts: { failOn?: 'multi' | 'exec' } = {}) {
  const calls: Call[] = [];
  let multiCount = 0;
  const pipeline = {
    rpush(key: string, value: string) {
      calls.push(['rpush', key, value]);
      return pipeline;
    },
    ltrim(key: string, start: number, stop: number) {
      calls.push(['ltrim', key, start, stop]);
      return pipeline;
    },
    expire(key: string, seconds: number) {
      calls.push(['expire', key, seconds]);
      return pipeline;
    },
    async exec() {
      calls.push(['exec']);
      if (opts.failOn === 'exec') throw new Error('READONLY SECRETCAUSE');
      return [];
    },
  };
  return {
    calls,
    get multiCount() {
      return multiCount;
    },
    multi() {
      multiCount += 1;
      if (opts.failOn === 'multi') throw new Error('connection closed SECRETCAUSE');
      return pipeline;
    },
  };
}

describe('fakeSmsInboxKey', () => {
  it('is the sha-256 hex of the E.164 under the bananagig:fake-sms: prefix', () => {
    const digest = createHash('sha256').update(RECIPIENT).digest('hex');
    expect(fakeSmsInboxKey(RECIPIENT)).toBe(`bananagig:fake-sms:${digest}`);
    expect(fakeSmsInboxKey(RECIPIENT)).toMatch(/^bananagig:fake-sms:[0-9a-f]{64}$/);
  });
  it('does not contain the number', () => {
    expect(fakeSmsInboxKey(RECIPIENT)).not.toContain(RECIPIENT_DIGITS);
    expect(fakeSmsInboxKey(RECIPIENT)).not.toContain('2025550142');
  });
  it('is deterministic and distinct per number', () => {
    expect(fakeSmsInboxKey(RECIPIENT)).toBe(fakeSmsInboxKey(RECIPIENT));
    expect(fakeSmsInboxKey('+12025550143')).not.toBe(fakeSmsInboxKey(RECIPIENT));
  });
});

describe('ValkeyFakeSmsTransport', () => {
  it('pushes a JSON entry to the inbox list of the recipient, trims it and sets the TTL in one transaction', async () => {
    const client = fakeClient();
    await new ValkeyFakeSmsTransport(client, 'test').deliver(RECIPIENT, BODY, { correlationId: 'corr-9' });
    const key = fakeSmsInboxKey(RECIPIENT);
    expect(client.multiCount).toBe(1);
    expect(client.calls.map((c) => c[0])).toEqual(['rpush', 'ltrim', 'expire', 'exec']);
    expect(client.calls[0]?.[1]).toBe(key);
    expect(client.calls[1]).toEqual(['ltrim', key, -FAKE_SMS_MAX_MESSAGES, -1]);
    expect(client.calls[2]).toEqual(['expire', key, FAKE_SMS_TTL_SECONDS]);
  });
  it('stores {at, body, correlationId} as JSON, with an ISO timestamp', async () => {
    const client = fakeClient();
    const before = Date.now();
    await new ValkeyFakeSmsTransport(client, 'development').deliver(RECIPIENT, BODY, { correlationId: 'corr-9' });
    const value = JSON.parse(String(client.calls[0]?.[2])) as { at: string; body: string; correlationId: string };
    expect(Object.keys(value).sort()).toEqual(['at', 'body', 'correlationId']);
    expect(value.body).toBe(BODY);
    expect(value.correlationId).toBe('corr-9');
    expect(new Date(value.at).toISOString()).toBe(value.at);
    expect(new Date(value.at).getTime()).toBeGreaterThanOrEqual(before);
  });
  it('never puts the raw number in the key or in the stored value', async () => {
    const client = fakeClient();
    await new ValkeyFakeSmsTransport(client, 'test').deliver(RECIPIENT, BODY, { correlationId: 'corr-9' });
    expect(String(client.calls[0]?.[1])).not.toContain(RECIPIENT_DIGITS);
    expect(String(client.calls[0]?.[2])).not.toContain(RECIPIENT_DIGITS);
  });
  it('keeps the last 50 messages and expires after 900 seconds', () => {
    expect(FAKE_SMS_MAX_MESSAGES).toBe(50);
    expect(FAKE_SMS_TTL_SECONDS).toBe(900);
  });
  it('returns a message id derived from the correlation id', async () => {
    const result = await new ValkeyFakeSmsTransport(fakeClient(), 'test').deliver(RECIPIENT, BODY, { correlationId: 'corr-9' });
    expect(result).toEqual({ messageId: 'fake-corr-9' });
  });
  it('keeps the messages of different numbers in different lists', async () => {
    const client = fakeClient();
    const transport = new ValkeyFakeSmsTransport(client, 'test');
    await transport.deliver(RECIPIENT, BODY, { correlationId: 'a' });
    await transport.deliver('+12025550143', BODY, { correlationId: 'b' });
    const keys = client.calls.filter((c) => c[0] === 'rpush').map((c) => c[1]);
    expect(new Set(keys).size).toBe(2);
  });
  it('appends one rpush per delivery', async () => {
    const client = fakeClient();
    const transport = new ValkeyFakeSmsTransport(client, 'test');
    await transport.deliver(RECIPIENT, 'one', { correlationId: 'a' });
    await transport.deliver(RECIPIENT, 'two', { correlationId: 'b' });
    expect(client.calls.filter((c) => c[0] === 'rpush')).toHaveLength(2);
    expect(client.multiCount).toBe(2);
  });
  it.each(['development', 'test', 'ci'])('may be constructed in the %s environment', (env) => {
    expect(() => new ValkeyFakeSmsTransport(fakeClient(), env)).not.toThrow();
  });
  it('refuses to be constructed in production', () => {
    expect(() => new ValkeyFakeSmsTransport(fakeClient(), 'production')).toThrow(/not allowed in production/);
  });
  it.each(['exec', 'multi'] as const)('translates a client failure at %s to UNAVAILABLE, retryable, without leaking', async (failOn) => {
    const err = await failureOf(new ValkeyFakeSmsTransport(fakeClient({ failOn }), 'test').deliver(RECIPIENT, BODY, { correlationId: 'corr-9' }));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
    noLeak(err);
  });
});

// ====================================================================== RecordingSmsSender
describe('RecordingSmsSender', () => {
  it('records each message in order and returns a numbered message id', async () => {
    const sender = new RecordingSmsSender();
    const first = await sender.send(message({ correlationId: 'a' }));
    const second = await sender.send(message({ correlationId: 'b', to: '+12025550143' }));
    expect(sender.sent.map((m) => m.correlationId)).toEqual(['a', 'b']);
    expect(sender.sent[1]?.to).toBe('+12025550143');
    expect(first).toEqual({ messageId: 'recorded-1', templateVersion: null });
    expect(second).toEqual({ messageId: 'recorded-2', templateVersion: null });
  });
  it('records the full message with its variables', async () => {
    const sender = new RecordingSmsSender();
    await sender.send(message());
    expect(sender.sent[0]).toEqual(message());
  });
  it('fails the next send once with failNext, does not record it, then recovers', async () => {
    const sender = new RecordingSmsSender();
    const failure = new SmsDeliveryError('UNAVAILABLE', 'down', true);
    sender.failNext = failure;
    await expect(sender.send(message())).rejects.toBe(failure);
    expect(sender.sent).toHaveLength(0);
    expect(sender.failNext).toBeUndefined();
    await expect(sender.send(message())).resolves.toEqual({ messageId: 'recorded-1', templateVersion: null });
    expect(sender.sent).toHaveLength(1);
  });
  it('starts empty', () => {
    const sender = new RecordingSmsSender();
    expect(sender.sent).toEqual([]);
    expect(sender.failNext).toBeUndefined();
  });
  it('can fail again after failNext is set again', async () => {
    const sender = new RecordingSmsSender();
    sender.failNext = new SmsDeliveryError('REJECTED', 'no', false);
    await expect(sender.send(message())).rejects.toMatchObject({ code: 'REJECTED' });
    sender.failNext = new SmsDeliveryError('UNAVAILABLE', 'down', true);
    await expect(sender.send(message())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(sender.sent).toHaveLength(0);
  });
});
