// Unit tests of the device helpers (ID-004): the closed-vocabulary user agent classifier and the keyed device hash. No database, no network.
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BROWSER_FAMILIES, DEVICE_CLASSES, DEVICE_SECRET_SHAPE, OS_FAMILIES, USER_AGENT_MAX_LENGTH } from '@bananagig/contracts';
import { DEVICE_HASH_DOMAIN, DEVICE_VOCABULARIES, classifyUserAgent, hashDeviceSecret, isDeviceSecretShape } from './security-device';

const SECRET = 'test-hash-secret-0123456789abcdef';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'A'.repeat(43);

// ====================================================================== classifyUserAgent
const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0',
  edgeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0.0.0 Mobile/15E148 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
  firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  chromeAndroidPhone: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  operaWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  operaMini: 'Opera/9.80 (Android; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  windowsPhone:
    'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  curl: 'curl/8.4.0',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

describe('classifyUserAgent: real-world user agents', () => {
  const cases: [string, string, { browser: string; os: string; deviceClass: string }][] = [
    ['Chrome on Windows', UA.chromeWindows, { browser: 'CHROME', os: 'WINDOWS', deviceClass: 'DESKTOP' }],
    ['Chrome on macOS', UA.chromeMac, { browser: 'CHROME', os: 'MACOS', deviceClass: 'DESKTOP' }],
    ['Chrome on Linux', UA.chromeLinux, { browser: 'CHROME', os: 'LINUX', deviceClass: 'DESKTOP' }],
    ['Edge on Windows (contains Chrome and Safari tokens)', UA.edgeWindows, { browser: 'EDGE', os: 'WINDOWS', deviceClass: 'DESKTOP' }],
    ['Edge on Android', UA.edgeAndroid, { browser: 'EDGE', os: 'ANDROID', deviceClass: 'MOBILE' }],
    ['Edge on iOS', UA.edgeIos, { browser: 'EDGE', os: 'IOS', deviceClass: 'MOBILE' }],
    ['Firefox on Linux', UA.firefoxLinux, { browser: 'FIREFOX', os: 'LINUX', deviceClass: 'DESKTOP' }],
    ['Firefox on Windows', UA.firefoxWindows, { browser: 'FIREFOX', os: 'WINDOWS', deviceClass: 'DESKTOP' }],
    ['Firefox on Android phone', UA.firefoxAndroid, { browser: 'FIREFOX', os: 'ANDROID', deviceClass: 'MOBILE' }],
    ['Firefox on iOS', UA.firefoxIos, { browser: 'FIREFOX', os: 'IOS', deviceClass: 'MOBILE' }],
    ['Safari on macOS', UA.safariMac, { browser: 'SAFARI', os: 'MACOS', deviceClass: 'DESKTOP' }],
    ['Safari on iPhone', UA.safariIphone, { browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' }],
    ['Safari on iPad', UA.safariIpad, { browser: 'SAFARI', os: 'IOS', deviceClass: 'TABLET' }],
    ['Chrome on iOS', UA.chromeIos, { browser: 'CHROME', os: 'IOS', deviceClass: 'MOBILE' }],
    ['Chrome on an Android phone', UA.chromeAndroidPhone, { browser: 'CHROME', os: 'ANDROID', deviceClass: 'MOBILE' }],
    ['Chrome on an Android tablet (no Mobile token)', UA.chromeAndroidTablet, { browser: 'CHROME', os: 'ANDROID', deviceClass: 'TABLET' }],
    ['Opera on Windows (contains Chrome)', UA.operaWindows, { browser: 'OPERA', os: 'WINDOWS', deviceClass: 'DESKTOP' }],
    ['Opera Mini', UA.operaMini, { browser: 'OPERA', os: 'ANDROID', deviceClass: 'MOBILE' }],
    ['Samsung Internet (not reported as Chrome)', UA.samsung, { browser: 'OTHER', os: 'ANDROID', deviceClass: 'MOBILE' }],
    ['legacy Edge on Windows Phone (the user agent also says Android)', UA.windowsPhone, { browser: 'EDGE', os: 'WINDOWS', deviceClass: 'MOBILE' }],
    ['Chrome OS is another system', UA.chromeOs, { browser: 'CHROME', os: 'OTHER', deviceClass: 'OTHER' }],
    ['curl', UA.curl, { browser: 'OTHER', os: 'OTHER', deviceClass: 'OTHER' }],
    ['a crawler', UA.googlebot, { browser: 'OTHER', os: 'OTHER', deviceClass: 'OTHER' }],
  ];
  it.each(cases)('%s', (_name, ua, expected) => {
    expect(classifyUserAgent(ua)).toEqual(expected);
  });
});

describe('classifyUserAgent: robustness', () => {
  it('answers OTHER/OTHER/OTHER for anything that is not a usable string', () => {
    const unknown = { browser: 'OTHER', os: 'OTHER', deviceClass: 'OTHER' };
    for (const v of [undefined, null, 0, 1, true, {}, [], ['Chrome/1'], Symbol.iterator, () => 'Chrome/1', '', ' ', '\t\n', 'x']) {
      expect(classifyUserAgent(v as unknown)).toEqual(unknown);
    }
  });
  it('never throws and always returns members of the closed vocabularies', () => {
    const pieces = [
      'Chrome/1',
      'Edg/1',
      'OPR/1',
      'Firefox/1',
      'Safari/1',
      'Version/1',
      'Android',
      'iPhone',
      'iPad',
      'Windows NT',
      'Macintosh',
      'Linux',
      'Mobile',
      'Tablet',
      '\u0000',
      '\n',
      'é',
      '',
    ];
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const ua = Array.from({ length: 1 + rnd(8) }, () => pieces[rnd(pieces.length)]).join(rnd(2) ? ' ' : '/');
      const c = classifyUserAgent(ua);
      expect(BROWSER_FAMILIES).toContain(c.browser);
      expect(OS_FAMILIES).toContain(c.os);
      expect(DEVICE_CLASSES).toContain(c.deviceClass);
    }
  });
  it('returns a fresh object each time (a caller cannot corrupt a shared default)', () => {
    const a = classifyUserAgent(undefined);
    a.browser = 'CHROME';
    expect(classifyUserAgent(undefined).browser).toBe('OTHER');
  });
  it('only looks at the first USER_AGENT_MAX_LENGTH characters', () => {
    const padding = 'x'.repeat(USER_AGENT_MAX_LENGTH);
    expect(classifyUserAgent(`${padding} Firefox/1`).browser).toBe('OTHER');
    expect(classifyUserAgent(`Firefox/1 ${padding}`).browser).toBe('FIREFOX');
  });
  it('is fast on hostile, very long input (no catastrophic backtracking)', () => {
    const started = Date.now();
    for (const ua of [
      `Version/${'1.'.repeat(300000)}`,
      `Version/1 ${'Safari'.repeat(100000)}`,
      'a'.repeat(5_000_000),
      `Mozilla ${'(Windows NT '.repeat(50000)}`,
    ])
      classifyUserAgent(ua);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it('does not echo the user agent: the result holds three vocabulary words only', () => {
    const ua = `${UA.chromeWindows} secret-marker-9f3a`;
    const r = classifyUserAgent(ua);
    expect(Object.keys(r).sort()).toEqual(['browser', 'deviceClass', 'os']);
    expect(inspect(r)).not.toContain('secret-marker');
  });
  it('exposes the vocabularies of the contracts (the CHECK constraints of migration 0012)', () => {
    expect(DEVICE_VOCABULARIES.browsers).toBe(BROWSER_FAMILIES);
    expect(DEVICE_VOCABULARIES.operatingSystems).toBe(OS_FAMILIES);
    expect(DEVICE_VOCABULARIES.classes).toBe(DEVICE_CLASSES);
  });
});

// ====================================================================== hashDeviceSecret
describe('hashDeviceSecret', () => {
  it('is the length-prefixed, domain-separated HMAC-SHA-256 (hex) of the account id and the secret', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${DEVICE_HASH_DOMAIN}\0${[ACCOUNT_A, DEVICE].map((p) => `${p.length}:${p}`).join('\0')}`)
      .digest('hex');
    expect(DEVICE_HASH_DOMAIN).toBe('bananagig:device:v1');
    expect(hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE)).toBe(expected);
  });
  it('is 64 lower-case hex characters (the shape the database CHECK requires) and deterministic', () => {
    const h = hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE)).toBe(h);
  });
  it('binds the account: the same browser has a different hash on every account', () => {
    expect(hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE)).not.toBe(hashDeviceSecret(SECRET, ACCOUNT_B, DEVICE));
  });
  it('depends on the server key', () => {
    expect(hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE)).not.toBe(hashDeviceSecret(`${SECRET}x`, ACCOUNT_A, DEVICE));
  });
  it('depends on every character of the secret', () => {
    const base = hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE);
    for (let i = 0; i < DEVICE.length; i++) expect(hashDeviceSecret(SECRET, ACCOUNT_A, `${DEVICE.slice(0, i)}B${DEVICE.slice(i + 1)}`)).not.toBe(base);
  });
  it('is injective across the account/secret boundary (length-prefixed encoding)', () => {
    expect(hashDeviceSecret(SECRET, 'ab', 'c\0d')).not.toBe(hashDeviceSecret(SECRET, 'ab\0c', 'd'));
    expect(hashDeviceSecret(SECRET, 'a', 'bc')).not.toBe(hashDeviceSecret(SECRET, 'ab', 'c'));
  });
  it('is domain separated from the verification code, magic token and dimension hashes', () => {
    const other = (domain: string): string =>
      createHmac('sha256', SECRET)
        .update(`${domain}\0${[ACCOUNT_A, DEVICE].map((p) => `${p.length}:${p}`).join('\0')}`)
        .digest('hex');
    const h = hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE);
    for (const domain of ['bananagig:email-code:v1', 'bananagig:email-link:v1', 'bananagig:rate-dimension:v1', 'bananagig:phone-code:v1'])
      expect(h).not.toBe(other(domain));
  });
  it('does not contain the secret or the account id', () => {
    const h = hashDeviceSecret(SECRET, ACCOUNT_A, DEVICE);
    expect(h).not.toContain(DEVICE.toLowerCase());
    expect(h).not.toContain(ACCOUNT_A.replace(/-/g, ''));
  });
});

// ====================================================================== isDeviceSecretShape
describe('isDeviceSecretShape', () => {
  it('accepts exactly 43 base64url characters (32 random bytes)', () => {
    expect(isDeviceSecretShape('A'.repeat(43))).toBe(true);
    expect(isDeviceSecretShape('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEF')).toBe(false); // 44
    expect(isDeviceSecretShape('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE')).toBe(true); // 43
    expect(DEVICE_SECRET_SHAPE.test('A'.repeat(43))).toBe(true);
  });
  it('refuses a wrong length, a wrong alphabet, padding, whitespace and non-strings', () => {
    for (const v of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(42)} `,
      ` ${'A'.repeat(42)}`,
      `${'A'.repeat(42)}\n`,
      `${'A'.repeat(42)}é`,
    ])
      expect(isDeviceSecretShape(v), JSON.stringify(v)).toBe(false);
    for (const v of [undefined, null, 1, {}, [], 'A'.repeat(43).split('')]) expect(isDeviceSecretShape(v as unknown)).toBe(false);
  });
});
