// Email delivery boundary (ID-002): a provider-neutral `EmailSender` port, the `EmailRenderer` port that turns a template key and typed variables into a
// message, and the SMTP adapter used for Mailpit (local and CI) and for any SMTP relay.
//
// Domain services (the identity service) depend on the PORT only: no SMTP, no vendor SDK and no template engine leaks into them. A production provider
// (SES, Postmark, SendGrid, ...) is a new class that implements `EmailSender`; none is selected yet (DEBT in docs/project/TECH_DEBT.md).
//
// Secrets: a verification message carries a one-time code and a magic link. They exist in memory for the duration of one `send` call and in the message
// itself; this module never logs a recipient, a subject, a body, a variable value or a provider response beyond its message id.
import nodemailer, { type Transporter } from 'nodemailer';

export type EmailVariableValue = string | number;

/** What a domain asks to be sent: the recipient, WHICH template, the typed variables and the correlation id. Provider-neutral. */
export interface EmailMessage {
  /** The recipient: a canonical email address (never a display name or a list). */
  to: string;
  /** The template, as a stable key (for example `account.email.verification`). The renderer maps it to its subject and body content. */
  templateKey: string;
  /** Pins a template version when a provider needs it; when omitted the version in force is used and reported in the result. */
  templateVersion?: string | null;
  /** Typed template variables by name (strings and numbers only, as the content registry's canonical encodings). */
  variables: Readonly<Record<string, EmailVariableValue>>;
  /** The locale to render in; the content registry falls back along its locale chain. */
  locale?: string;
  correlationId: string;
}

export interface EmailSendResult {
  /** The provider's message id, when it returns one. */
  messageId: string | null;
  /** The template version that was rendered and sent. */
  templateVersion: string | null;
}

/** Why a send failed. `retryable` tells the caller whether trying again later can succeed; the message never carries an address or a provider payload. */
export class EmailDeliveryError extends Error {
  constructor(
    public readonly code: 'UNAVAILABLE' | 'REJECTED' | 'RENDER_FAILED',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/** The delivery port. Implementations send the message and throw EmailDeliveryError on failure. */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface RenderedEmail {
  subject: string;
  /** Sanitized HTML (from the managed content registry). */
  html: string;
  /** The plain-text alternative. */
  text: string;
  templateVersion: string | null;
}

/** Renders a template to a message. The composition root implements it over the content registry (CFG-002), so no user-visible copy lives in code. */
export interface EmailRenderer {
  render(templateKey: string, variables: Readonly<Record<string, EmailVariableValue>>, locale?: string): Promise<RenderedEmail>;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
/**
 * A plain-text alternative of the SANITIZED html the content registry produces (its output allow-list is p, br, strong, em, code, a, ul, ol, li,
 * blockquote and headings, and every text node is escaped). Links keep their destination: `text (url)`.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_m, href: string, text: string) => `${text} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h2|h3|h4|blockquote|ul|ol)>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  /** The From header (for example `no-reply@bananagig.localhost`). */
  from: string;
  /** Accept self-signed certificates and no STARTTLS (Mailpit, local and CI ONLY). Never true in production. */
  insecureLocal?: boolean;
  /** Bounds every SMTP phase so a hung relay cannot hold a request. Default 5000 ms connect and greeting, 10000 ms socket. */
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * SMTP adapter: renders through the injected EmailRenderer and delivers with nodemailer. Mailpit in development and CI; any SMTP relay elsewhere.
 * Failures are translated: a network/timeout problem or a 4xx reply is retryable UNAVAILABLE, a 5xx reply is a permanent REJECTED.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    private readonly options: SmtpEmailSenderOptions,
    private readonly renderer: EmailRenderer,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: false,
        ...(options.insecureLocal ? { tls: { rejectUnauthorized: false } } : { requireTLS: true }),
        connectionTimeout: options.connectionTimeoutMs ?? 5000,
        greetingTimeout: options.connectionTimeoutMs ?? 5000,
        socketTimeout: options.socketTimeoutMs ?? 10000,
      });
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (/[\r\n]/.test(message.to) || !message.to.includes('@')) throw new EmailDeliveryError('REJECTED', 'the recipient is not a valid address', false);
    let rendered: RenderedEmail;
    try {
      rendered = await this.renderer.render(message.templateKey, message.variables, message.locale);
    } catch {
      throw new EmailDeliveryError('RENDER_FAILED', 'the message could not be rendered', false);
    }
    try {
      const info = await this.transport.sendMail({
        from: this.options.from,
        to: message.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          'X-Correlation-Id': message.correlationId,
          'X-BananaGig-Template': message.templateKey,
          'Auto-Submitted': 'auto-generated',
        },
      });
      return { messageId: typeof info.messageId === 'string' ? info.messageId : null, templateVersion: rendered.templateVersion };
    } catch (err) {
      const responseCode = (err as { responseCode?: unknown } | null)?.responseCode;
      const permanent = typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600;
      throw new EmailDeliveryError(
        permanent ? 'REJECTED' : 'UNAVAILABLE',
        permanent ? 'the mail server rejected the message' : 'the mail server is unavailable',
        !permanent,
      );
    }
  }
}

/** Records messages instead of sending them (unit tests of the domain). */
export class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  /** When set, the next send fails with this error (and is not recorded). */
  failNext: EmailDeliveryError | undefined;
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.sent.push(message);
    return { messageId: `recorded-${this.sent.length}`, templateVersion: null };
  }
}
