// Unit tests of the email delivery boundary (ID-002): the SMTP adapter with an injected fake transport and a fake renderer, the failure translation
// (permanent vs retryable, render failure, a recipient that could inject a header), the guarantee that errors never carry the recipient, the subject, a code
// or a body, the plain-text alternative, and the recording sender the domain tests use. No test opens a network connection.
import nodemailer, { type Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailDeliveryError, RecordingEmailSender, SmtpEmailSender, htmlToPlainText, type EmailMessage, type EmailRenderer, type RenderedEmail } from './email';

// Distinctive values so a leak into an error message is unmistakable.
const RECIPIENT = 'private.person@mailbox.example.test';
const VERIFICATION_CODE = '482913';
const SUBJECT = 'Your BananaGig verification code 482913';
const HTML = '<p>Your verification code is <strong>482913</strong>.</p>';
const TEXT = 'Your verification code is 482913.';
const LINK = 'https://app.example.test/verify-email?token=LINKMARKER';

const rendered: RenderedEmail = { subject: SUBJECT, html: HTML, text: TEXT, templateVersion: 'v7' };

interface RenderCall {
  templateKey: string;
  variables: Readonly<Record<string, string | number>>;
  locale: string | undefined;
}
function fakeRenderer(result: RenderedEmail | Error = rendered): EmailRenderer & { calls: RenderCall[] } {
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

type SentMail = Record<string, unknown> & { headers: Record<string, string> };
function fakeTransport(reply: (mail: SentMail) => unknown = () => ({ messageId: '<m-1@mail.example.test>', response: '250 queued as SECRETQUEUE' })) {
  const sent: SentMail[] = [];
  const transport = {
    async sendMail(mail: SentMail) {
      sent.push(mail);
      const r = reply(mail);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { sent, transport: transport as unknown as Transporter };
}
const smtpError = (message: string, extra: Record<string, unknown>): Error => Object.assign(new Error(message), extra);

const OPTIONS = { host: 'smtp.example.test', port: 2525, from: 'BananaGig <no-reply@bananagig.example.test>' };
const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: RECIPIENT,
  templateKey: 'account.email.verification',
  variables: { verification_code: VERIFICATION_CODE, verification_url: LINK, expiry_minutes: 10 },
  locale: 'en-US',
  correlationId: 'corr-123',
  ...over,
});
async function failureOf(promise: Promise<unknown>): Promise<EmailDeliveryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EmailDeliveryError);
    return err as EmailDeliveryError;
  }
  throw new Error('expected the send to fail');
}
/** Everything an error could expose: its message, its name, its fields, its text form, its stack and any cause. */
const surfaceOf = (err: EmailDeliveryError): string =>
  [
    err.message,
    err.name,
    err.code,
    String(err.retryable),
    String(err),
    err.stack ?? '',
    JSON.stringify(err),
    String((err as { cause?: unknown }).cause ?? ''),
  ].join('\n');

// ====================================================================== SmtpEmailSender: sending
describe('SmtpEmailSender: a successful send', () => {
  it('renders the template and hands the transport the From, To, subject, text, html and the three headers', async () => {
    const { sent, transport } = fakeTransport();
    const renderer = fakeRenderer();
    const sender = new SmtpEmailSender(OPTIONS, renderer, transport);
    await sender.send(message());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      from: 'BananaGig <no-reply@bananagig.example.test>',
      to: RECIPIENT,
      subject: SUBJECT,
      text: TEXT,
      html: HTML,
      headers: { 'X-Correlation-Id': 'corr-123', 'X-BananaGig-Template': 'account.email.verification', 'Auto-Submitted': 'auto-generated' },
    });
  });
  it('sends to exactly one recipient, as given (no cc, bcc, reply-to or list)', async () => {
    const { sent, transport } = fakeTransport();
    await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message());
    expect(Object.keys(sent[0]!).sort()).toEqual(['from', 'headers', 'html', 'subject', 'text', 'to']);
    expect(typeof sent[0]!.to).toBe('string');
  });
  it('marks the message as automatically generated, so auto-responders do not answer it', async () => {
    const { sent, transport } = fakeTransport();
    await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message());
    expect(sent[0]!.headers['Auto-Submitted']).toBe('auto-generated');
  });
  it('returns the provider message id and the template version of the renderer', async () => {
    const { transport } = fakeTransport();
    const result = await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message());
    expect(result).toEqual({ messageId: '<m-1@mail.example.test>', templateVersion: 'v7' });
  });
  it('returns nothing else from the provider reply (its response text can hold the recipient or a queue id)', async () => {
    const { transport } = fakeTransport();
    const result = await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message());
    expect(Object.keys(result).sort()).toEqual(['messageId', 'templateVersion']);
    expect(JSON.stringify(result)).not.toContain('SECRETQUEUE');
  });
  it.each([
    ['no message id', {}],
    ['a numeric message id', { messageId: 42 }],
    ['a null message id', { messageId: null }],
    ['an empty reply', undefined],
  ])('reports a null message id when the provider returns %s', async (_label, reply) => {
    const { transport } = fakeTransport(() => reply ?? {});
    const result = await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message());
    expect(result.messageId).toBeNull();
  });
  it('passes a null template version through', async () => {
    const { transport } = fakeTransport();
    const renderer = fakeRenderer({ ...rendered, templateVersion: null });
    expect((await new SmtpEmailSender(OPTIONS, renderer, transport).send(message())).templateVersion).toBeNull();
  });
  it('passes the template key, the variables and the locale to the renderer', async () => {
    const { transport } = fakeTransport();
    const renderer = fakeRenderer();
    const variables = { verification_code: VERIFICATION_CODE, expiry_minutes: 10 };
    await new SmtpEmailSender(OPTIONS, renderer, transport).send(message({ variables, locale: 'es-MX' }));
    expect(renderer.calls).toEqual([{ templateKey: 'account.email.verification', variables, locale: 'es-MX' }]);
    expect(renderer.calls[0]!.variables).toBe(variables);
  });
  it('passes an absent locale as undefined (the renderer falls back along its chain)', async () => {
    const { transport } = fakeTransport();
    const renderer = fakeRenderer();
    const { locale: _locale, ...noLocale } = message();
    await new SmtpEmailSender(OPTIONS, renderer, transport).send(noLocale);
    expect(renderer.calls[0]!.locale).toBeUndefined();
  });
  it('renders once and sends once per call, and keeps calls independent', async () => {
    const { sent, transport } = fakeTransport();
    const renderer = fakeRenderer();
    const sender = new SmtpEmailSender(OPTIONS, renderer, transport);
    await sender.send(message({ to: 'one@example.test', correlationId: 'c-1' }));
    await sender.send(message({ to: 'two@example.test', correlationId: 'c-2' }));
    expect(renderer.calls).toHaveLength(2);
    expect(sent.map((m) => m.to)).toEqual(['one@example.test', 'two@example.test']);
    expect(sent.map((m) => m.headers['X-Correlation-Id'])).toEqual(['c-1', 'c-2']);
  });
  it('uses the template key of the message in the template header', async () => {
    const { sent, transport } = fakeTransport();
    await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message({ templateKey: 'account.email.other' }));
    expect(sent[0]!.headers['X-BananaGig-Template']).toBe('account.email.other');
  });
  it("accepts a recipient that merely contains an at sign (validation of the address itself is the domain's job)", async () => {
    const { sent, transport } = fakeTransport();
    await new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message({ to: 'a@b' }));
    expect(sent[0]!.to).toBe('a@b');
  });
});

// ====================================================================== SmtpEmailSender: failures
describe('SmtpEmailSender: delivery failures are translated', () => {
  it.each([
    [500, 'a syntax error'],
    [550, 'a mailbox that does not exist'],
    [551, 'a user not local'],
    [552, 'an exceeded storage allocation'],
    [553, 'a mailbox name that is not allowed'],
    [554, 'a transaction failure'],
    [599, 'the end of the 5xx range'],
  ])('a %s reply (%s) is a permanent REJECTED, not retryable', async (responseCode) => {
    const { transport } = fakeTransport(() =>
      smtpError(`${responseCode} no such user ${RECIPIENT}`, { responseCode, response: `${responseCode} ${RECIPIENT}` }),
    );
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err.code).toBe('REJECTED');
    expect(err.retryable).toBe(false);
  });
  it.each([
    [421, 'service not available'],
    [450, 'mailbox busy'],
    [451, 'local error in processing'],
    [452, 'insufficient storage'],
    [499, 'the end of the 4xx range'],
  ])('a %s reply (%s) is a retryable UNAVAILABLE', async (responseCode) => {
    const { transport } = fakeTransport(() => smtpError(`${responseCode} try later`, { responseCode }));
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
  it.each([
    ['a refused connection', smtpError('connect ECONNREFUSED 127.0.0.1:25', { code: 'ECONNREFUSED' })],
    ['a reset connection', smtpError('read ECONNRESET', { code: 'ECONNRESET' })],
    ['a timeout', smtpError('Connection timeout', { code: 'ETIMEDOUT' })],
    ['a greeting timeout', smtpError('Greeting never received', { code: 'ETIMEDOUT', command: 'CONN' })],
    ['a DNS failure', smtpError('getaddrinfo ENOTFOUND smtp.example.test', { code: 'EDNS' })],
    ['a TLS failure', smtpError('self-signed certificate', { code: 'ESOCKET' })],
    ['a bare error with no code at all', new Error('boom')],
    ['a reply code outside 4xx and 5xx', smtpError('odd', { responseCode: 250 })],
    ['a reply code of 600', smtpError('odd', { responseCode: 600 })],
  ])('%s is a retryable UNAVAILABLE', async (_label, failure) => {
    const { transport } = fakeTransport(() => failure);
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a plain object', { responseCode: 'x' }],
  ])('treats a thrown %s as a retryable UNAVAILABLE instead of crashing', async (_label, thrown) => {
    const transport = {
      async sendMail() {
        throw thrown;
      },
    } as unknown as Transporter;
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
  it('is an Error with the EmailDeliveryError name, code and retryable flag', async () => {
    const { transport } = fakeTransport(() => smtpError('550', { responseCode: 550 }));
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmailDeliveryError');
    expect(err.message).toBe('the mail server rejected the message');
  });
  it('explains an unavailable server without detail', async () => {
    const { transport } = fakeTransport(() => smtpError('connect ECONNREFUSED', { code: 'ECONNREFUSED' }));
    const err = await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(err.message).toBe('the mail server is unavailable');
  });
  it('does not retry by itself: one failed call makes exactly one transport call', async () => {
    const { sent, transport } = fakeTransport(() => smtpError('421', { responseCode: 421 }));
    await failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
    expect(sent).toHaveLength(1);
  });
});

describe('SmtpEmailSender: a template that cannot be rendered', () => {
  it('is RENDER_FAILED, not retryable, and nothing is sent', async () => {
    const { sent, transport } = fakeTransport();
    const renderer = fakeRenderer(new Error(`missing variable verification_code for ${RECIPIENT} (${VERIFICATION_CODE})`));
    const err = await failureOf(new SmtpEmailSender(OPTIONS, renderer, transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    expect(err.retryable).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('does not leak the underlying renderer message', async () => {
    const { transport } = fakeTransport();
    const renderer = fakeRenderer(new Error(`the registry said SECRET-REGISTRY-DETAIL for ${RECIPIENT}`));
    const err = await failureOf(new SmtpEmailSender(OPTIONS, renderer, transport).send(message()));
    expect(err.message).toBe('the message could not be rendered');
    expect(surfaceOf(err)).not.toContain('SECRET-REGISTRY-DETAIL');
    expect(surfaceOf(err)).not.toContain(RECIPIENT);
  });
  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['a plain object', { reason: 'x' }],
  ])('translates a renderer that rejects with %s', async (_label, thrown) => {
    const { transport } = fakeTransport();
    const renderer: EmailRenderer = {
      async render() {
        throw thrown;
      },
    };
    const err = await failureOf(new SmtpEmailSender(OPTIONS, renderer, transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
  });
  it('translates a renderer that throws synchronously', async () => {
    const { sent, transport } = fakeTransport();
    const renderer: EmailRenderer = {
      render() {
        throw new Error('sync failure');
      },
    };
    const err = await failureOf(new SmtpEmailSender(OPTIONS, renderer, transport).send(message()));
    expect(err.code).toBe('RENDER_FAILED');
    expect(sent).toHaveLength(0);
  });
});

describe('SmtpEmailSender: a recipient that could inject a header or is not an address', () => {
  it.each([
    ['a CRLF and a second header', 'victim@example.test\r\nBcc: attacker@example.test'],
    ['a trailing line feed', 'victim@example.test\n'],
    ['a leading carriage return', '\rvictim@example.test'],
    ['a line feed in the middle', 'vic\ntim@example.test'],
    ['a bare carriage return', 'victim@example.test\r'],
    ['no at sign', 'victim.example.test'],
    ['an empty string', ''],
    ['a display name without an address', 'Victim'],
  ])('rejects %s BEFORE rendering or sending', async (_label, to) => {
    const { sent, transport } = fakeTransport();
    const renderer = fakeRenderer();
    const err = await failureOf(new SmtpEmailSender(OPTIONS, renderer, transport).send(message({ to })));
    expect(err.code).toBe('REJECTED');
    expect(err.retryable).toBe(false);
    expect(renderer.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
  it('does not echo the rejected recipient', async () => {
    const { transport } = fakeTransport();
    const err = await failureOf(
      new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message({ to: 'victim@example.test\r\nBcc: attacker@example.test' })),
    );
    expect(err.message).toBe('the recipient is not a valid address');
    expect(surfaceOf(err)).not.toContain('victim');
    expect(surfaceOf(err)).not.toContain('attacker');
  });
});

describe('SmtpEmailSender: errors never carry the recipient, the subject, a code or a body', () => {
  const FORBIDDEN = [
    RECIPIENT,
    'private.person',
    'mailbox.example.test',
    SUBJECT,
    'BananaGig verification code',
    VERIFICATION_CODE,
    'LINKMARKER',
    HTML,
    TEXT,
    'corr-123',
  ];
  const scenarios: [string, () => Promise<EmailDeliveryError>][] = [
    [
      'a permanent rejection whose raw reply names the recipient',
      () => {
        const { transport } = fakeTransport(() =>
          smtpError(`550 5.1.1 <${RECIPIENT}> user unknown. ${SUBJECT} ${HTML} ${TEXT}`, {
            responseCode: 550,
            response: `550 <${RECIPIENT}> ${VERIFICATION_CODE}`,
            command: `RCPT TO:<${RECIPIENT}>`,
            rejected: [RECIPIENT],
          }),
        );
        return failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
      },
    ],
    [
      'a temporary failure whose raw reply names the recipient',
      () => {
        const { transport } = fakeTransport(() => smtpError(`421 try later for ${RECIPIENT} ${LINK}`, { responseCode: 421, response: `421 ${RECIPIENT}` }));
        return failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
      },
    ],
    [
      'a network error',
      () => {
        const { transport } = fakeTransport(() => smtpError(`connect ECONNREFUSED while sending to ${RECIPIENT}`, { code: 'ECONNREFUSED' }));
        return failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), transport).send(message()));
      },
    ],
    [
      'a render failure whose message holds the variables',
      () =>
        failureOf(
          new SmtpEmailSender(OPTIONS, fakeRenderer(new Error(`bad variables ${VERIFICATION_CODE} ${LINK} ${RECIPIENT}`)), fakeTransport().transport).send(
            message(),
          ),
        ),
    ],
    [
      'a rejected recipient',
      () => failureOf(new SmtpEmailSender(OPTIONS, fakeRenderer(), fakeTransport().transport).send(message({ to: `${RECIPIENT}\r\nBcc: x@example.test` }))),
    ],
  ];
  it.each(scenarios)('%s', async (_label, run) => {
    const surface = surfaceOf(await run());
    for (const secret of FORBIDDEN) expect(surface, secret).not.toContain(secret);
  });
  it('uses a fixed message for each failure kind', async () => {
    const messages = new Set<string>();
    for (const [, run] of scenarios) messages.add((await run()).message);
    expect([...messages].sort()).toEqual([
      'the mail server is unavailable',
      'the mail server rejected the message',
      'the message could not be rendered',
      'the recipient is not a valid address',
    ]);
  });
});

// ====================================================================== SmtpEmailSender: construction
describe('SmtpEmailSender: default transport', () => {
  afterEach(() => vi.restoreAllMocks());

  const captureTransportOptions = (build: () => unknown): Record<string, unknown> => {
    const spy = vi.spyOn(nodemailer, 'createTransport').mockReturnValue(fakeTransport().transport as never);
    build();
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]![0] as Record<string, unknown>;
  };

  it('does not connect at construction (nodemailer opens a connection on the first send only)', () => {
    expect(() => new SmtpEmailSender({ host: '127.0.0.1', port: 9, from: 'a@example.test' }, fakeRenderer())).not.toThrow();
  });
  it('does not call createTransport when a transport is injected', () => {
    const spy = vi.spyOn(nodemailer, 'createTransport');
    new SmtpEmailSender(OPTIONS, fakeRenderer(), fakeTransport().transport);
    expect(spy).not.toHaveBeenCalled();
  });
  it('requires STARTTLS and certificate validation by default (production behaviour)', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender(OPTIONS, fakeRenderer()));
    expect(options).toMatchObject({ host: 'smtp.example.test', port: 2525, secure: false, requireTLS: true });
    expect(options).not.toHaveProperty('tls');
  });
  it('requires STARTTLS when insecureLocal is explicitly false', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender({ ...OPTIONS, insecureLocal: false }, fakeRenderer()));
    expect(options.requireTLS).toBe(true);
    expect(options).not.toHaveProperty('tls');
  });
  it('accepts self-signed certificates and no STARTTLS only when insecureLocal is true (Mailpit, local and CI)', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender({ ...OPTIONS, insecureLocal: true }, fakeRenderer()));
    expect(options).toMatchObject({ host: 'smtp.example.test', port: 2525, secure: false, tls: { rejectUnauthorized: false } });
    expect(options).not.toHaveProperty('requireTLS');
  });
  it('bounds every SMTP phase by default: 5 s to connect and greet, 10 s on the socket', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender(OPTIONS, fakeRenderer()));
    expect(options).toMatchObject({ connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
  });
  it('takes the connection and socket timeouts from the options', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender({ ...OPTIONS, connectionTimeoutMs: 1200, socketTimeoutMs: 3400 }, fakeRenderer()));
    expect(options).toMatchObject({ connectionTimeout: 1200, greetingTimeout: 1200, socketTimeout: 3400 });
  });
  it('never uses an implicit-TLS port setting (secure stays false: STARTTLS is negotiated)', () => {
    const options = captureTransportOptions(() => new SmtpEmailSender({ ...OPTIONS, port: 465 }, fakeRenderer()));
    expect(options.secure).toBe(false);
  });
});

// ====================================================================== htmlToPlainText
describe('htmlToPlainText', () => {
  it.each([
    ['a link becomes text (url)', '<a href="https://app.example.test/verify">confirm your email</a>', 'confirm your email (https://app.example.test/verify)'],
    ['a link with other attributes first', '<a class="x" rel="noopener" href="https://x.test/a">go</a>', 'go (https://x.test/a)'],
    ['a link with attributes after the href', '<a href="https://x.test/a" rel="noopener noreferrer">go</a>', 'go (https://x.test/a)'],
    ['a link whose text holds markup', '<a href="https://x.test/a"><strong>bold</strong> link</a>', 'bold link (https://x.test/a)'],
    ['a link inside a sentence', '<p>Open <a href="https://x.test/a">this</a> now.</p>', 'Open this (https://x.test/a) now.'],
    ['two links', '<a href="https://x.test/1">one</a> and <a href="https://x.test/2">two</a>', 'one (https://x.test/1) and two (https://x.test/2)'],
    ['a link text broken over two lines', '<a href="https://x.test/a">first\nsecond</a>', 'first\nsecond (https://x.test/a)'],
    ['a link with an escaped ampersand in the url', '<a href="https://x.test/?a=1&amp;b=2">go</a>', 'go (https://x.test/?a=1&b=2)'],
    ['a link with an empty href', '<a href="">go</a>', 'go ()'],
  ])('%s', (_label, html, expected) => {
    expect(htmlToPlainText(html)).toBe(expected);
  });

  it.each([
    ['one paragraph', '<p>Hello</p>', 'Hello'],
    ['two paragraphs are separated by a blank line', '<p>One</p><p>Two</p>', 'One\n\nTwo'],
    ['paragraphs written on separate lines', '<p>One</p>\n<p>Two</p>', 'One\n\nTwo'],
    ['a br tag', 'a<br>b', 'a\nb'],
    ['a self-closing br tag', 'a<br/>b', 'a\nb'],
    ['a br tag with a space', 'a<br />b', 'a\nb'],
    ['an upper-case br tag', 'a<BR>b', 'a\nb'],
    ['an unordered list', '<ul><li>One</li><li>Two</li></ul>', '- One\n- Two'],
    ['an ordered list', '<ol><li>One</li><li>Two</li></ol>', '- One\n- Two'],
    ['a list after a paragraph', '<p>Steps:</p><ul><li>One</li></ul><p>Done</p>', 'Steps:\n\n- One\n\nDone'],
    ['a heading followed by a paragraph', '<h2>Title</h2><p>Body</p>', 'Title\n\nBody'],
    ['a level 3 heading', '<h3>Title</h3><p>Body</p>', 'Title\n\nBody'],
    ['a level 4 heading', '<h4>Title</h4><p>Body</p>', 'Title\n\nBody'],
    ['a blockquote', '<blockquote>Quoted</blockquote><p>After</p>', 'Quoted\n\nAfter'],
    ['strong, em and code are reduced to their text', '<strong>bold</strong> and <em>italic</em> and <code>mono</code>', 'bold and italic and mono'],
    ['unknown tags are removed with their attributes', '<span class="x" style="color:red">text</span>', 'text'],
    ['plain text is left alone', 'just some text', 'just some text'],
    ['an empty string', '', ''],
    ['only tags', '<p></p><br>', ''],
    ['surrounding whitespace is trimmed', '  \n<p>x</p>\n  ', 'x'],
  ])('%s', (_label, html, expected) => {
    expect(htmlToPlainText(html)).toBe(expected);
  });

  it.each([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#39;', "'"],
  ])('decodes %s', (entity, decoded) => {
    expect(htmlToPlainText(`a ${entity} b`)).toBe(`a ${decoded} b`);
  });
  it.each(['&nbsp;', '&copy;', '&apos;', '&#x27;', '&#8364;', '&#39', '&amp', '&AMP;', '&euro;', '&#0039;'])(
    'leaves the entity %s alone (only the five escapes of the sanitizer are decoded)',
    (entity) => {
      expect(htmlToPlainText(`a ${entity} b`)).toBe(`a ${entity} b`);
    },
  );
  it('decodes in a single pass: an escaped entity stays an entity', () => {
    expect(htmlToPlainText('&amp;lt;')).toBe('&lt;');
    expect(htmlToPlainText('&amp;amp;')).toBe('&amp;');
    expect(htmlToPlainText('&amp;#39;')).toBe('&#39;');
  });
  it('keeps escaped markup as literal text: it is decoded AFTER tags are stripped', () => {
    expect(htmlToPlainText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
    expect(htmlToPlainText('<p>&lt;b&gt;not bold&lt;/b&gt;</p>')).toBe('<b>not bold</b>');
  });
  it('strips real tags but keeps their text content', () => {
    expect(htmlToPlainText('<script>alert(1)</script>')).toBe('alert(1)');
    expect(htmlToPlainText('<div><img src="x" onerror="y">text</div>')).toBe('text');
  });
  it('never emits more than one blank line in a row', () => {
    const out = htmlToPlainText('<p>a</p>\n\n\n\n<p>b</p><br><br><br><br><p>c</p><ul><li>d</li></ul><ul><li>e</li></ul>');
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toBe('a\n\nb\n\nc\n\n- d\n\n- e');
  });
  it('collapses several line breaks into one blank line', () => {
    expect(htmlToPlainText('a<br><br><br>b')).toBe('a\n\nb');
    expect(htmlToPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
  it('turns the sanitized verification body into a readable text with the link spelled out', () => {
    const html =
      '<p>Your BananaGig verification code is <strong>123456</strong>.</p><p>It expires in 10 minutes. You can also <a href="https://app.example.test/verify-email?token=abc" rel="noopener noreferrer">confirm your email address</a>.</p><p>If you did not ask for this, you can ignore this email.</p>';
    expect(htmlToPlainText(html)).toBe(
      'Your BananaGig verification code is 123456.\n\nIt expires in 10 minutes. You can also confirm your email address (https://app.example.test/verify-email?token=abc).\n\nIf you did not ask for this, you can ignore this email.',
    );
  });
  it('contains no angle-bracketed tag after conversion of sanitized html', () => {
    const out = htmlToPlainText(
      '<h2>T</h2><p>a <strong>b</strong> <em>c</em> <code>d</code> <a href="https://x.test">e</a></p><ul><li>f</li></ul><blockquote>g</blockquote>',
    );
    expect(out).not.toMatch(/<[a-z/][^>]*>/i);
  });
  it('is idempotent on its own output when the output has no markup or entities', () => {
    const once = htmlToPlainText('<p>One</p><p>Two <a href="https://x.test">link</a></p>');
    expect(htmlToPlainText(once)).toBe(once);
  });
});

// ====================================================================== RecordingEmailSender
describe('RecordingEmailSender', () => {
  it('records each message in order and answers with a recorded id and no template version', async () => {
    const sender = new RecordingEmailSender();
    const one = message({ to: 'one@example.test' });
    const two = message({ to: 'two@example.test' });
    expect(await sender.send(one)).toEqual({ messageId: 'recorded-1', templateVersion: null });
    expect(await sender.send(two)).toEqual({ messageId: 'recorded-2', templateVersion: null });
    expect(sender.sent).toEqual([one, two]);
    expect(sender.sent[0]).toBe(one);
  });
  it('starts with nothing recorded and no pending failure', () => {
    const sender = new RecordingEmailSender();
    expect(sender.sent).toEqual([]);
    expect(sender.failNext).toBeUndefined();
  });
  it('fails the next send once with the given error and does not record it', async () => {
    const sender = new RecordingEmailSender();
    const failure = new EmailDeliveryError('UNAVAILABLE', 'down', true);
    sender.failNext = failure;
    await expect(sender.send(message())).rejects.toBe(failure);
    expect(sender.sent).toHaveLength(0);
    expect(sender.failNext).toBeUndefined();
  });
  it('succeeds again after the one failure and numbers the first recorded message 1', async () => {
    const sender = new RecordingEmailSender();
    sender.failNext = new EmailDeliveryError('REJECTED', 'no', false);
    await expect(sender.send(message())).rejects.toBeInstanceOf(EmailDeliveryError);
    const retry = message({ to: 'retry@example.test' });
    expect(await sender.send(retry)).toEqual({ messageId: 'recorded-1', templateVersion: null });
    expect(sender.sent).toEqual([retry]);
  });
  it('can fail again when failNext is set again', async () => {
    const sender = new RecordingEmailSender();
    for (let i = 0; i < 3; i++) {
      sender.failNext = new EmailDeliveryError('UNAVAILABLE', `down ${i}`, true);
      await expect(sender.send(message())).rejects.toThrow(`down ${i}`);
    }
    expect(sender.sent).toHaveLength(0);
  });
  it('implements the EmailSender port', async () => {
    const sender = new RecordingEmailSender();
    const asPort: { send(m: EmailMessage): Promise<{ messageId: string | null; templateVersion: string | null }> } = sender;
    expect((await asPort.send(message())).messageId).toBe('recorded-1');
  });
});

describe('EmailDeliveryError', () => {
  it.each([
    ['UNAVAILABLE', true],
    ['REJECTED', false],
    ['RENDER_FAILED', false],
  ] as const)('carries the code %s and retryable=%s', (code, retryable) => {
    const err = new EmailDeliveryError(code, 'text', retryable);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmailDeliveryError');
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.message).toBe('text');
  });
});
