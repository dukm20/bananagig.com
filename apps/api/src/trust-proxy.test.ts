// DEBT-0055: the client address behind the reverse proxy. request.ip must be the address the API can trust: with N trusted proxy hops it is the entry the
// Nth proxy wrote (counted from the right of X-Forwarded-For), never a client-chosen leftmost entry, and with 0 hops always the socket address. This file
// proves the trust function, the real Fastify behaviour for 0, 1 and 2 hops, the configuration rule and (statically) the deployment files that make the
// model true: Caddy REPLACES X-Forwarded-For and the API and web containers publish no port of their own.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '@bananagig/config';
import type { AccountService, EmailVerificationService, PhoneVerificationService } from '@bananagig/accounts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, trustHops } from './app';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const SOCKET = '10.9.8.7';

let keys: TestKeys;

const accountSvc = {
  ensureAccountForIdentity: vi.fn(),
  getAccountContext: vi.fn(),
  selectActiveRole: vi.fn(),
  upsertProfile: vi.fn(),
};
const phoneSvc = { getPhoneDetail: vi.fn(), setPhone: vi.fn(), sendVerification: vi.fn(), confirmCode: vi.fn(), getPhoneSummary: vi.fn() };
const emailSvc = {
  getEmailDetail: vi.fn(),
  setEmail: vi.fn(),
  sendVerification: vi.fn(),
  confirmCode: vi.fn(),
  confirmLink: vi.fn(),
  getEmailSummary: vi.fn(),
};

const context = () => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
  memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
  primaryRole: 'CUSTOMER',
  activeRole: 'CUSTOMER',
  profile: null,
  email: { emailVerificationStatus: 'NONE', primary: null, pending: null },
  phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null },
  contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  created: false,
});

const apps = new Map<number, FastifyInstance>();
async function appWith(hops: number): Promise<FastifyInstance> {
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', TRUSTED_PROXY_HOPS: String(hops) } });
  expect(cfg.trustedProxyHops).toBe(hops);
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const app = await buildApp({
    cfg,
    verifier,
    configuration: {} as never,
    accounts: accountSvc as unknown as AccountService,
    emailVerification: emailSvc as unknown as EmailVerificationService,
    phoneVerification: phoneSvc as unknown as PhoneVerificationService,
    readiness: async () => ({}),
  });
  // a probe route that exposes what Fastify resolved (routes can still be added before ready())
  app.get('/__test/ip', { schema: { hide: true } }, async (req) => ({ ip: req.ip, ips: req.ips ?? null }));
  await app.ready();
  return app;
}
const appOf = (hops: number): FastifyInstance => apps.get(hops)!;

beforeAll(async () => {
  keys = await createTestKeys('k1');
  for (const hops of [0, 1, 2, 3, 4]) apps.set(hops, await appWith(hops));
});
afterAll(async () => {
  for (const a of apps.values()) await a.close();
});
beforeEach(() => {
  for (const f of [...Object.values(accountSvc), ...Object.values(phoneSvc), ...Object.values(emailSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async () => context());
  phoneSvc.sendVerification.mockImplementation(async () => ({
    sentAt: new Date(),
    expiresAt: new Date(),
    resendAvailableAt: new Date(),
    codeLength: 6,
    validityMinutes: 10,
    phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null },
  }));
  phoneSvc.setPhone.mockImplementation(async () => ({ changed: false, phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null } }));
  phoneSvc.confirmCode.mockImplementation(async () => ({ changed: false, phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null } }));
  emailSvc.sendVerification.mockImplementation(async () => ({
    sentAt: new Date(),
    expiresAt: new Date(),
    resendAvailableAt: new Date(),
    codeLength: 6,
    validityMinutes: 10,
    email: { emailVerificationStatus: 'NONE', primary: null, pending: null },
  }));
});

/** The address request.ip resolved for a request with the given socket address and X-Forwarded-For header (undefined: no header). */
async function ipOf(hops: number, forwardedFor?: string | string[], remoteAddress: string = SOCKET): Promise<string> {
  const res = await appOf(hops).inject({
    method: 'GET',
    url: '/__test/ip',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { ip: string }).ip;
}

/** The address the PHONE service receives as ctx.clientIp for the same request (the value that feeds the abuse limits). */
async function serviceIpOf(hops: number, forwardedFor?: string, remoteAddress: string = SOCKET): Promise<string> {
  phoneSvc.sendVerification.mockClear();
  const token = await signToken(keys, { claims: { sub: 'proxy-subject', azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
  const res = await appOf(hops).inject({
    method: 'POST',
    url: '/api/v1/account/phone/verification/send',
    remoteAddress,
    headers: { authorization: `Bearer ${token}`, ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }) },
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
  return (phoneSvc.sendVerification.mock.calls[0]![1] as { clientIp: string }).clientIp;
}

// ====================================================================== the trust function
describe('trustHops(n): a hop is trusted while its index is below the count', () => {
  const table: [number, number, boolean][] = [];
  for (let n = 0; n <= 4; n++) for (let hop = 0; hop <= 6; hop++) table.push([n, hop, hop < n]);
  it.each(table)('trustHops(%i)(address, hop %i) is %s', (n, hop, expected) => {
    expect(trustHops(n)('203.0.113.1', hop)).toBe(expected);
  });
  it('does not look at the address: only the hop index counts', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '::1', 'garbage', '', '203.0.113.9']) {
      expect(trustHops(1)(address, 0)).toBe(true);
      expect(trustHops(1)(address, 1)).toBe(false);
      expect(trustHops(0)(address, 0)).toBe(false);
    }
  });
  it('trusts nothing with 0 hops, whatever the hop index', () => {
    for (let hop = 0; hop < 10; hop++) expect(trustHops(0)('10.0.0.1', hop)).toBe(false);
  });
  it('is wired as the Fastify trustProxy of the app (the app really uses the configured hop count)', async () => {
    for (const hops of [0, 1, 2, 3, 4]) {
      // with a chain of 5 entries the resolved address identifies the number of trusted hops exactly
      const chain = 'e1, e2, e3, e4, e5';
      const expected = hops === 0 ? SOCKET : `e${5 - hops + 1}`;
      expect(await ipOf(hops, chain), `hops ${hops}`).toBe(expected);
    }
  });
});

// ====================================================================== 0 hops: the socket address, always
describe('TRUSTED_PROXY_HOPS=0: request.ip is always the socket address', () => {
  it.each([
    ['no header', undefined],
    ['a single entry', '203.0.113.9'],
    ['a chain', '198.51.100.1, 203.0.113.9'],
    ['a spoofed internal address', '127.0.0.1'],
    ['an IPv6 entry', '2001:db8::1'],
    ['garbage', 'not-an-address'],
    ['an empty header', ''],
    ['a header with spaces only', '   '],
  ])('ignores X-Forwarded-For (%s)', async (_label, header) => {
    expect(await ipOf(0, header)).toBe(SOCKET);
  });
  it('ignores a repeated X-Forwarded-For header', async () => {
    expect(await ipOf(0, ['198.51.100.1', '203.0.113.9'])).toBe(SOCKET);
  });
  it('ignores Forwarded, X-Real-IP and X-Client-IP as well', async () => {
    const res = await appOf(0).inject({
      method: 'GET',
      url: '/__test/ip',
      remoteAddress: SOCKET,
      headers: { forwarded: 'for=198.51.100.1', 'x-real-ip': '198.51.100.2', 'x-client-ip': '198.51.100.3', 'cf-connecting-ip': '198.51.100.4' },
    });
    expect((res.json() as { ip: string }).ip).toBe(SOCKET);
  });
  it('hands the socket address to the phone service whatever the header says', async () => {
    expect(await serviceIpOf(0, '203.0.113.9')).toBe(SOCKET);
    expect(await serviceIpOf(0, 'a, b, c')).toBe(SOCKET);
    expect(await serviceIpOf(0)).toBe(SOCKET);
  });
  it('uses an IPv6 socket address as is', async () => {
    expect(await ipOf(0, '203.0.113.9', '2001:db8::7')).toBe('2001:db8::7');
  });
  it('exposes only the socket in request.ips... as a one element chain or none', async () => {
    const res = await appOf(0).inject({ method: 'GET', url: '/__test/ip', remoteAddress: SOCKET, headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } });
    const { ips } = res.json() as { ips: string[] | null };
    expect(ips === null || ips.every((i) => i === SOCKET)).toBe(true);
  });
});

// ====================================================================== 1 hop: the LAST entry
describe('TRUSTED_PROXY_HOPS=1: request.ip is the LAST X-Forwarded-For entry (the one the proxy wrote)', () => {
  it('uses the socket address when there is no header', async () => {
    expect(await ipOf(1)).toBe(SOCKET);
  });
  it('uses the socket address for an empty header', async () => {
    expect(await ipOf(1, '')).toBe(SOCKET);
  });
  it('uses the single entry the proxy wrote', async () => {
    expect(await ipOf(1, '203.0.113.9')).toBe('203.0.113.9');
  });
  it('"spoofed, real" resolves to "real": the client-chosen leftmost entry is never used', async () => {
    expect(await ipOf(1, '198.51.100.66, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipOf(1, 'spoofed, real')).toBe('real');
  });
  it('a long client-supplied chain still resolves to the last entry', async () => {
    const spoof = Array.from({ length: 40 }, (_, i) => `198.51.100.${i + 1}`).join(', ');
    expect(await ipOf(1, `${spoof}, 203.0.113.9`)).toBe('203.0.113.9');
  });
  it('a single spoofed entry IS what the trusted proxy wrote (documented model: Caddy replaces the header, so a client cannot choose it)', async () => {
    expect(await ipOf(1, '198.51.100.66')).toBe('198.51.100.66');
  });
  it('trims spaces around entries', async () => {
    expect(await ipOf(1, '  198.51.100.66 ,   203.0.113.9  ')).toBe('203.0.113.9');
  });
  it('treats two spoofed prefixes with the same real address as the SAME address (one rate-limit bucket)', async () => {
    const a = await ipOf(1, 'spoof-a, 203.0.113.9');
    const b = await ipOf(1, 'spoof-b, 203.0.113.9');
    expect(a).toBe(b);
    expect(a).toBe('203.0.113.9');
  });
  it('merges a repeated X-Forwarded-For header as one chain (the last entry of the last header wins)', async () => {
    expect(await ipOf(1, ['198.51.100.1', '203.0.113.9'])).toBe('203.0.113.9');
  });
  it.each([
    ['2001:db8::1', '2001:db8::1'],
    ['198.51.100.1, 2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3::8a2e:370:7334'],
    ['2001:db8::dead, 203.0.113.9', '203.0.113.9'],
    ['203.0.113.9, ::1', '::1'],
  ])('handles IPv6 entries: "%s" -> "%s"', async (header, expected) => {
    expect(await ipOf(1, header)).toBe(expected);
  });
  it('uses an IPv6 socket address when there is no header', async () => {
    expect(await ipOf(1, undefined, '2001:db8::7')).toBe('2001:db8::7');
  });
  it('uses an IPv4-mapped IPv6 socket address as the socket reports it', async () => {
    expect(await ipOf(1, undefined, '::ffff:10.0.0.1')).toBe('::ffff:10.0.0.1');
  });
  it('is independent of the socket address when the header is present (the proxy is trusted whoever it is)', async () => {
    expect(await ipOf(1, '203.0.113.9', '192.0.2.1')).toBe('203.0.113.9');
    expect(await ipOf(1, '203.0.113.9', '2001:db8::7')).toBe('203.0.113.9');
  });
  it('hands exactly that address to the phone service (ctx.clientIp)', async () => {
    expect(await serviceIpOf(1, 'spoofed-by-client, 203.0.113.9')).toBe('203.0.113.9');
    expect(await serviceIpOf(1, '203.0.113.9')).toBe('203.0.113.9');
    expect(await serviceIpOf(1)).toBe(SOCKET);
  });
  it('hands exactly that address to the email service as well', async () => {
    const token = await signToken(keys, { claims: { sub: 'proxy-subject', azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
    await appOf(1).inject({
      method: 'POST',
      url: '/api/v1/account/email/verification/send',
      remoteAddress: SOCKET,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': 'spoofed, 203.0.113.9' },
      payload: {},
    });
    expect((emailSvc.sendVerification.mock.calls[0]![1] as { clientIp: string }).clientIp).toBe('203.0.113.9');
  });
  it.each([
    ['set-phone', '/api/v1/account/phone', { phone: '+12025550142' }, 'setPhone', 2],
    ['send', '/api/v1/account/phone/verification/send', {}, 'sendVerification', 1],
    ['confirm-code', '/api/v1/account/phone/verification/confirm-code', { code: '123456' }, 'confirmCode', 2],
  ] as const)('the %s route hands the resolved address to the service in its context', async (_name, url, payload, fn, ctxIndex) => {
    const token = await signToken(keys, { claims: { sub: 'proxy-subject', azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
    const res = await appOf(1).inject({
      method: 'POST',
      url,
      remoteAddress: SOCKET,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': 'x, 203.0.113.50' },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((phoneSvc[fn].mock.calls[0]![ctxIndex] as { clientIp: string }).clientIp).toBe('203.0.113.50');
  });
});

// ====================================================================== 2 hops: the second from the right
describe('TRUSTED_PROXY_HOPS=2: request.ip is the second entry from the right', () => {
  it('uses the last entry when the chain holds one entry less than the hops (the first proxy is the socket)', async () => {
    expect(await ipOf(2, '203.0.113.9')).toBe('203.0.113.9');
  });
  it('uses the socket address when there is no header', async () => {
    expect(await ipOf(2)).toBe(SOCKET);
  });
  it('resolves "client, proxy1" to the client (the entry the second proxy wrote)', async () => {
    expect(await ipOf(2, '203.0.113.9, 10.1.1.1')).toBe('203.0.113.9');
  });
  it('resolves "spoofed, client, proxy1" to the client, never the spoofed leftmost entry', async () => {
    expect(await ipOf(2, 'spoofed, 203.0.113.9, 10.1.1.1')).toBe('203.0.113.9');
  });
  it('is different from the 1-hop answer on the same request', async () => {
    const header = 'spoofed, 203.0.113.9, 10.1.1.1';
    expect(await ipOf(1, header)).toBe('10.1.1.1');
    expect(await ipOf(2, header)).toBe('203.0.113.9');
  });
  it('falls back to the leftmost entry when the chain is shorter than the trusted hops (all hops trusted)', async () => {
    expect(await ipOf(3, '203.0.113.9, 10.1.1.1')).toBe('203.0.113.9');
    expect(await ipOf(4, '203.0.113.9')).toBe('203.0.113.9');
  });
  it('handles an IPv6 client behind two proxies', async () => {
    expect(await ipOf(2, 'junk, 2001:db8::1, 10.1.1.1')).toBe('2001:db8::1');
  });
  it('hands exactly that address to the phone service', async () => {
    expect(await serviceIpOf(2, 'spoofed, 203.0.113.9, 10.1.1.1')).toBe('203.0.113.9');
  });
});

// ====================================================================== the DEBT-0055 attack, summarized
describe('a client cannot choose its rate-limit identity', () => {
  it.each([0, 1, 2])('with %i hops, varying only the leftmost (client-chosen) entries never changes the resolved address', async (hops) => {
    const tail = hops === 2 ? '203.0.113.9, 10.1.1.1' : '203.0.113.9';
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(await ipOf(hops, `198.51.100.${i}, ${tail}`));
    expect(seen.size).toBe(1);
  });
  it('with 1 hop the old behaviour (leftmost entry) would have produced 25 identities; now there is one', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(await ipOf(1, `198.51.100.${i}, 203.0.113.9`));
    expect([...seen]).toEqual(['203.0.113.9']);
  });
});

// ====================================================================== configuration
describe('TRUSTED_PROXY_HOPS configuration', () => {
  const prodApi = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:pw@db:5432/d',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    KEYCLOAK_URL: 'http://keycloak-auth:8080',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    WEB_PUBLIC_URL: 'https://app.example.com',
    VERIFICATION_HASH_SECRET: 'production-hash-key-'.concat('0123456789abcdef'.repeat(2)),
    KEYCLOAK_SECURITY_CLIENT_SECRET: 'production-security-client-secret-'.concat('0123456789abcdef'.repeat(2)),
  };
  const issues = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues;
    }
    throw new Error('expected a ConfigError');
  };

  it('defaults to 1 hop outside production', () => {
    expect(loadConfig({ service: 't', env: { NODE_ENV: 'test' } }).trustedProxyHops).toBe(1);
  });
  it.each(['0', '1', '2', '3', '4'])('accepts %s', (value) => {
    expect(loadConfig({ service: 't', env: { NODE_ENV: 'test', TRUSTED_PROXY_HOPS: value } }).trustedProxyHops).toBe(Number(value));
  });
  it.each(['-1', '5', '1.5', 'one', '1e1'])('rejects %s', (value) => {
    expect(() => loadConfig({ service: 't', env: { NODE_ENV: 'test', TRUSTED_PROXY_HOPS: value } })).toThrow(/TRUSTED_PROXY_HOPS/);
  });
  it('is REQUIRED in production for the api role (the exact number of reverse proxies must be stated)', () => {
    const list = issues(() => loadConfig({ service: 'a', role: 'api', env: prodApi }));
    expect(list.some((i) => i.startsWith('TRUSTED_PROXY_HOPS: required in production'))).toBe(true);
  });
  it('is accepted in production once set, including 0', () => {
    for (const value of ['0', '1', '2']) {
      expect(loadConfig({ service: 'a', role: 'api', env: { ...prodApi, TRUSTED_PROXY_HOPS: value } }).trustedProxyHops).toBe(Number(value));
    }
  });
  it('an empty value in production counts as unset', () => {
    const list = issues(() => loadConfig({ service: 'a', role: 'api', env: { ...prodApi, TRUSTED_PROXY_HOPS: '' } }));
    expect(list.some((i) => i.startsWith('TRUSTED_PROXY_HOPS'))).toBe(true);
  });
  it('the app built from a 0-hop configuration really ignores the header (end to end through loadConfig)', async () => {
    expect(await ipOf(0, '203.0.113.9')).toBe(SOCKET);
  });
});

// ====================================================================== deployment files (static)
describe('deployment: Caddy replaces X-Forwarded-For and the upstreams are reachable only through Caddy', () => {
  const caddyfile = readFileSync(resolve(ROOT, 'infra/caddy/Caddyfile'), 'utf8');
  const compose = readFileSync(resolve(ROOT, 'compose.yaml'), 'utf8');
  const composeDev = readFileSync(resolve(ROOT, 'compose.dev.yaml'), 'utf8');

  /** Every reverse_proxy directive with its target and the text of its block (empty when it has no block). */
  const reverseProxies = (): { target: string; block: string; line: string }[] => {
    const lines = caddyfile.split('\n');
    const out: { target: string; block: string; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*reverse_proxy\s+(?:@\S+\s+)?(\S+)(\s*\{)?\s*$/.exec(lines[i]!);
      if (!m) continue;
      let block = '';
      if (m[2]) {
        for (let j = i + 1; j < lines.length && !/^\s*\}\s*$/.test(lines[j]!); j++) block += `${lines[j]}\n`;
      }
      out.push({ target: m[1]!, block, line: lines[i]!.trim() });
    }
    return out;
  };
  const upstreams = () => reverseProxies().filter((p) => /^(api-service|web-app):/.test(p.target));

  it('finds the three reverse_proxy directives to the API and the web app', () => {
    expect(upstreams().map((p) => p.target)).toEqual(['api-service:3000', 'web-app:3000', 'api-service:3000']);
  });
  it('every reverse_proxy to web-app and api-service replaces X-Forwarded-For with {remote_host}', () => {
    for (const p of upstreams()) expect(p.block, p.line).toMatch(/^\s*header_up\s+X-Forwarded-For\s+\{remote_host\}\s*$/m);
  });
  it('never appends to or forwards the client-sent X-Forwarded-For (no +, no request-header placeholder)', () => {
    for (const p of upstreams()) {
      expect(p.block, p.line).not.toMatch(/header_up\s+\+/);
      expect(p.block, p.line).not.toMatch(/\{http\.request\.header\.X-Forwarded-For\}/i);
      expect(p.block, p.line).not.toMatch(/\{http\.request\.header\.x-forwarded-for\}/i);
    }
    expect(caddyfile).not.toMatch(/trusted_proxies/);
  });
  it('sets X-Forwarded-For exactly once per upstream block', () => {
    for (const p of upstreams()) expect((p.block.match(/X-Forwarded-For/gi) ?? []).length, p.line).toBe(1);
  });
  it('no other site block forwards to the API or the web app without the header', () => {
    const all = caddyfile.match(/reverse_proxy[^\n]*(api-service|web-app)[^\n]*/g) ?? [];
    expect(all).toHaveLength(upstreams().length);
  });

  /** The text of one top-level service of a compose file: from its `  name:` line to the next two-space key. */
  const serviceBlock = (text: string, name: string): string => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    expect(start, `${name} is a service`).toBeGreaterThan(-1);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!) || /^\S/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  };
  const publishesPorts = (block: string): boolean => /^\s{4}ports:/m.test(block);

  it('the api-service block publishes no port (no ports: key)', () => {
    expect(publishesPorts(serviceBlock(compose, 'api-service'))).toBe(false);
    expect(serviceBlock(compose, 'api-service')).not.toMatch(/\bexpose:|\bports:/);
  });
  it('the web-app block publishes no port', () => {
    expect(publishesPorts(serviceBlock(compose, 'web-app'))).toBe(false);
    expect(serviceBlock(compose, 'web-app')).not.toMatch(/\bports:/);
  });
  it('the worker-service block publishes no port either', () => {
    expect(publishesPorts(serviceBlock(compose, 'worker-service'))).toBe(false);
  });
  it('the development override publishes no port for the api-service or the web-app (host-run apps use their own ports)', () => {
    for (const name of ['api-service', 'web-app']) expect(composeDev, name).not.toMatch(new RegExp(`^ {2}${name}:`, 'm'));
  });
  it('the proxy is the only application entry: caddy-proxy publishes a port bound to 127.0.0.1', () => {
    const caddy = serviceBlock(compose, 'caddy-proxy');
    expect(publishesPorts(caddy)).toBe(true);
    expect(caddy).toMatch(/ports:\s*\["127\.0\.0\.1:/);
  });
  it('the API container is on the internal network only and carries no host network mode', () => {
    const api = serviceBlock(compose, 'api-service');
    expect(api).toMatch(/networks:\s*\[bananagig\]/);
    expect(api).not.toMatch(/network_mode/);
  });
  it('Caddy depends on both upstreams (so the header is set for every path to them)', () => {
    const caddy = serviceBlock(compose, 'caddy-proxy');
    expect(caddy).toMatch(/web-app:/);
    expect(caddy).toMatch(/api-service:/);
  });
  it('.env.example states TRUSTED_PROXY_HOPS=1, matching the single Caddy hop', () => {
    const env = readFileSync(resolve(ROOT, '.env.example'), 'utf8');
    expect(env).toMatch(/^TRUSTED_PROXY_HOPS=1\s*$/m);
  });
});

// ====================================================================== the web server reads the same model
describe('the web server reads the LAST X-Forwarded-For entry too (clientIpOf)', () => {
  const source = readFileSync(resolve(ROOT, 'apps/web/src/lib/auth/email-handlers.ts'), 'utf8');
  it('takes the last entry of the chain, not the first', () => {
    expect(source).toMatch(/clientIpOf/);
    const body = /clientIpOf[\s\S]{0,600}/.exec(source)?.[0] ?? '';
    expect(body).toMatch(/\.at\(-1\)|\[[^\]]*length\s*-\s*1\]|\.pop\(\)/);
    expect(body).not.toMatch(/\[0\]/);
  });
});
