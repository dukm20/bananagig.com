// Fake SMS inbox helper (ID-003): the approved way for tests and the smoke test to read the verification SMS that the API "sent" through the DEV/TEST Valkey sink
// (SMS_TRANSPORT=fake), and to extract the one-time code from it. The sink is a Valkey list per number (`bananagig:fake-sms:<sha256 of the E.164>`); production code
// never reads it and configuration refuses the fake transport in production.
//
// Never imported by production code. Nothing here logs a message body.
import { createHash } from 'node:crypto';
import { Redis } from 'iovalkey';
import { sleep } from './helpers';

export const fakeSmsKey = (e164: string): string => `bananagig:fake-sms:${createHash('sha256').update(e164).digest('hex')}`;

export const fakeSmsValkeyUrl = (): string => process.env.VALKEY_URL ?? process.env.VALKEY_URL_HOST ?? 'redis://127.0.0.1:16379';

export interface FakeSmsMessage {
  at: string;
  body: string;
  correlationId: string;
}

interface InboxClient {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<number>;
}

export class FakeSmsInbox {
  constructor(private readonly client: InboxClient) {}

  /** The messages sent to the number, oldest first. */
  async messages(e164: string): Promise<FakeSmsMessage[]> {
    return (await this.client.lrange(fakeSmsKey(e164), 0, -1)).map((raw) => JSON.parse(raw) as FakeSmsMessage);
  }

  /** Waits until at least `count` messages exist for the number and returns them; throws on timeout. */
  async wait(e164: string, count = 1, timeoutMs = 10_000): Promise<FakeSmsMessage[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.messages(e164).catch(() => []);
      if (found.length >= count) return found;
      if (Date.now() > deadline) throw new Error(`the fake SMS inbox holds ${found.length} of ${count} expected message(s)`);
      await sleep(150);
    }
  }

  async clear(e164: string): Promise<void> {
    await this.client.del(fakeSmsKey(e164));
  }
}

/** Opens the inbox on a Valkey connection; call `close()` when done. */
export function openFakeSmsInbox(url = fakeSmsValkeyUrl()): { inbox: FakeSmsInbox; close: () => Promise<void> } {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  client.on('error', () => undefined);
  return { inbox: new FakeSmsInbox(client), close: async () => void (await client.quit().catch(() => client.disconnect())) };
}

/** The code of a verification SMS (the first run of 4 to 10 digits after "BananaGig:"), or null. */
export const extractSmsCode = (body: string): string | null => /^BananaGig:\s*([0-9]{4,10})\b/.exec(body)?.[1] ?? null;
