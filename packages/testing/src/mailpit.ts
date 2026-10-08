// Mailpit test helper (ID-002): the approved way for tests to read the verification email that the SMTP adapter delivered to Mailpit (local and CI), and to
// extract the one-time code and the magic-link token from it. It talks to Mailpit's HTTP API; the SMTP side is the production adapter under test.
//
// Never imported by production code. Nothing here logs a message body.
import { sleep } from './helpers';

export const mailpitApiUrl = (): string => process.env.MAILPIT_API_URL ?? process.env.MAILPIT_URL ?? 'http://127.0.0.1:18025';

export interface MailpitMessage {
  id: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** The headers Mailpit reports (lower-cased names). */
  headers: Record<string, string[]>;
}

interface Summary {
  ID: string;
}
interface Detail {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Text: string;
  HTML: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${new URL(url).pathname} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Messages addressed to the recipient, oldest first. */
export async function mailpitMessagesTo(to: string, apiUrl = mailpitApiUrl()): Promise<MailpitMessage[]> {
  const found = await json<{ messages: Summary[] | null }>(`${apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const out: MailpitMessage[] = [];
  for (const m of [...(found.messages ?? [])].reverse()) {
    const d = await json<Detail>(`${apiUrl}/api/v1/message/${m.ID}`);
    const headers = await json<Record<string, string[]>>(`${apiUrl}/api/v1/message/${m.ID}/headers`).catch(() => ({}) as Record<string, string[]>);
    out.push({
      id: d.ID,
      to: d.To.map((t) => t.Address),
      subject: d.Subject,
      text: d.Text,
      html: d.HTML,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    });
  }
  return out;
}

/** Waits until at least `count` messages for the recipient exist and returns them (oldest first); throws on timeout. */
export async function waitForMailpitMessages(to: string, count = 1, opts: { timeoutMs?: number; apiUrl?: string } = {}): Promise<MailpitMessage[]> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const messages = await mailpitMessagesTo(to, opts.apiUrl).catch(() => []);
    if (messages.length >= count) return messages;
    if (Date.now() > deadline) throw new Error(`Mailpit received ${messages.length} of ${count} expected message(s) for the recipient`);
    await sleep(200);
  }
}

/** Removes every message for the recipient (isolates a test from earlier runs of the same address). */
export async function deleteMailpitMessagesTo(to: string, apiUrl = mailpitApiUrl()): Promise<void> {
  await fetch(`${apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`, { method: 'DELETE' });
}

export interface ExtractedVerification {
  /** The numeric code, or null when the message holds none. */
  code: string | null;
  /** The magic-link token from the `#token=` fragment, or null. */
  token: string | null;
  /** The whole link, or null. */
  url: string | null;
}

/** Extracts the code (`**123456**` in the text part is rendered plain: the first run of 4 to 10 digits after "code is") and the link from a verification message. */
export function extractVerification(message: Pick<MailpitMessage, 'text' | 'html'>): ExtractedVerification {
  const code = /code is\s+([0-9]{4,10})\b/i.exec(message.text)?.[1] ?? /code is\s*<strong>([0-9]{4,10})<\/strong>/i.exec(message.html)?.[1] ?? null;
  const url = /(https?:\/\/[^\s)"<>]+\/verify-email#token=[A-Za-z0-9_-]{43})/.exec(`${message.text}\n${message.html}`)?.[1] ?? null;
  const token = url ? (/#token=([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? null) : null;
  return { code, token, url };
}
