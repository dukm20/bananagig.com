// SMS delivery boundary (ID-003): a provider-neutral `SmsSender` port, the `SmsRenderer` port that turns a template key and typed variables into text, the
// vendor-facing `SmsTransport` port, and the adapters that exist today: a DEV/TEST sink in Valkey, a disabled transport, and a recording double.
//
// Domain services (the identity service) depend on `SmsSender` only: no vendor SDK and no template engine leaks into them. A production provider (Twilio,
// Vonage, ...) is one class implementing `SmsTransport`; none is selected yet (DEBT-0059). Rendering uses the content registry (CFG-002) through `SmsRenderer`.
//
// Secrets: a verification SMS carries a one-time code. It exists in memory for one `send` call and in the delivered text. This module never logs a number, a body
// or a variable value. The Valkey sink HOLDS the plaintext on purpose (it is the test inbox), so it refuses to exist in production.
import { createHash } from 'node:crypto';
import { isE164 } from '@bananagig/contracts';

export type SmsVariableValue = string | number;

/** What a domain asks to be sent: the recipient (E.164), WHICH template, the typed variables and the correlation id. Provider-neutral. */
export interface SmsMessage {
  /** The recipient in E.164. */
  to: string;
  /** The template, as a stable key (for example `sms.verification.phone`). The renderer maps it to its content entry. */
  templateKey: string;
  variables: Readonly<Record<string, SmsVariableValue>>;
  locale?: string;
  correlationId: string;
}
export interface SmsSendResult {
  messageId: string | null;
  templateVersion: string | null;
}

/** Why a send failed. `retryable` tells the caller whether trying again later can succeed; the message never carries a number or a provider payload. */
export class SmsDeliveryError extends Error {
  constructor(
    public readonly code: 'UNAVAILABLE' | 'REJECTED' | 'RENDER_FAILED' | 'NOT_CONFIGURED',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

/** The delivery port the identity domain uses. */
export interface SmsSender {
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export interface RenderedSms {
  body: string;
  templateVersion: string | null;
}
/** Renders a template to SMS text. The composition root implements it over the content registry (CFG-002); no user-visible copy lives in code. */
export interface SmsRenderer {
  render(templateKey: string, variables: Readonly<Record<string, SmsVariableValue>>, locale?: string): Promise<RenderedSms>;
}

/** What a vendor adapter implements: deliver already-rendered text to an E.164 number. */
export interface SmsTransport {
  deliver(to: string, body: string, meta: { correlationId: string }): Promise<{ messageId: string | null }>;
}

/** A rendered verification text must stay short: it is one or two SMS segments, never a page. */
export const SMS_BODY_MAX_LENGTH = 320;

/** Renders through the injected SmsRenderer and delivers through the SmsTransport. Failures are translated; no number, body or code appears in an error. */
export class RenderingSmsSender implements SmsSender {
  constructor(
    private readonly renderer: SmsRenderer,
    private readonly transport: SmsTransport,
  ) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (!isE164(message.to)) throw new SmsDeliveryError('REJECTED', 'the recipient is not an E.164 number', false);
    let rendered: RenderedSms;
    try {
      rendered = await this.renderer.render(message.templateKey, message.variables, message.locale);
    } catch {
      throw new SmsDeliveryError('RENDER_FAILED', 'the message could not be rendered', false);
    }
    if (rendered.body.length === 0 || rendered.body.length > SMS_BODY_MAX_LENGTH)
      throw new SmsDeliveryError('RENDER_FAILED', 'the rendered message has an invalid length', false);
    try {
      const { messageId } = await this.transport.deliver(message.to, rendered.body, { correlationId: message.correlationId });
      return { messageId, templateVersion: rendered.templateVersion };
    } catch (err) {
      if (err instanceof SmsDeliveryError) throw err;
      throw new SmsDeliveryError('UNAVAILABLE', 'the SMS provider is unavailable', true);
    }
  }
}

/** The production default until a provider is chosen: nothing is delivered and every send is a (non-retryable) delivery failure. */
export class DisabledSmsTransport implements SmsTransport {
  async deliver(): Promise<{ messageId: string | null }> {
    throw new SmsDeliveryError('NOT_CONFIGURED', 'no SMS provider is configured', false);
  }
}

// ---------------------------------------------------------------- DEV/TEST sink
/** The Valkey key of the fake inbox of one number: a SHA-256 of the E.164 (tests compute the same), so a raw number is not part of the key. */
export const fakeSmsInboxKey = (e164: string): string => `bananagig:fake-sms:${createHash('sha256').update(e164).digest('hex')}`;
export const FAKE_SMS_TTL_SECONDS = 900;
export const FAKE_SMS_MAX_MESSAGES = 50;

export interface FakeSmsMessage {
  at: string;
  body: string;
  correlationId: string;
}

interface ValkeyPipeline {
  rpush(key: string, value: string): ValkeyPipeline;
  ltrim(key: string, start: number, stop: number): ValkeyPipeline;
  expire(key: string, seconds: number): ValkeyPipeline;
  exec(): Promise<unknown>;
}
interface ValkeyListLike {
  multi(): ValkeyPipeline;
}

/**
 * DEV/TEST transport: appends the text to a Valkey list keyed by the number, with a short TTL, so the API container can "send" and a test or the smoke test can
 * read. It holds the PLAINTEXT code by design and therefore refuses to be constructed in production.
 */
export class ValkeyFakeSmsTransport implements SmsTransport {
  constructor(
    private readonly client: ValkeyListLike,
    private readonly env: string,
  ) {
    if (env === 'production') throw new Error('the fake SMS transport is not allowed in production');
  }
  async deliver(to: string, body: string, meta: { correlationId: string }): Promise<{ messageId: string | null }> {
    const entry: FakeSmsMessage = { at: new Date().toISOString(), body, correlationId: meta.correlationId };
    const key = fakeSmsInboxKey(to);
    try {
      await this.client.multi().rpush(key, JSON.stringify(entry)).ltrim(key, -FAKE_SMS_MAX_MESSAGES, -1).expire(key, FAKE_SMS_TTL_SECONDS).exec();
    } catch {
      throw new SmsDeliveryError('UNAVAILABLE', 'the fake SMS sink is unavailable', true);
    }
    return { messageId: `fake-${meta.correlationId}` };
  }
}

/** Records messages instead of sending them (unit tests of the domain). */
export class RecordingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  /** When set, the next send fails with this error (and is not recorded). */
  failNext: SmsDeliveryError | undefined;
  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.sent.push(message);
    return { messageId: `recorded-${this.sent.length}`, templateVersion: null };
  }
}
