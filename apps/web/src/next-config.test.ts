// The Next configuration: clickjacking headers on every route (ID-005 security review), and the settings the standalone image depends on.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { FRAME_PROTECTION_HEADERS, frameProtection } from '../next.config';

describe('next.config', () => {
  it('sends frame-ancestors none and X-Frame-Options DENY for every route', async () => {
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    expect(rules[0]!.headers).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Frame-Options', value: 'DENY' },
    ]);
    expect(await frameProtection()).toEqual(rules);
  });
  it('the source pattern covers the root, a page, a deep path and a BFF route, the account area pages and its form routes', async () => {
    // Next compiles `/:path*` to "zero or more segments"; check the pattern the same way
    const source = (await config.headers!())[0]!.source;
    const re = new RegExp(`^${source.replace('/:path*', '(?:/.*)?')}$`);
    for (const p of ['/', '/consents', '/security', '/a/b/c/d', '/auth/consents/accept', '/auth/security/revoke-all']) expect(re.test(p), p).toBe(true);
    for (const p of [
      '/account',
      '/account/profile',
      '/account/contact',
      '/account/security',
      '/account/language-region',
      '/account/privacy',
      '/account/roles',
      '/account/notifications',
      '/auth/account/profile',
      '/auth/account/language-region',
      '/auth/active-role',
    ])
      expect(re.test(p), p).toBe(true);
  });
  it('sends nothing but those two headers (no partial CSP)', async () => {
    const rules = await config.headers!();
    expect(rules[0]!.headers.map((h) => h.key).sort()).toEqual(['Content-Security-Policy', 'X-Frame-Options']);
    expect(FRAME_PROTECTION_HEADERS.map((h) => h.value).join(' ')).not.toMatch(/default-src|script-src|style-src/);
  });
  it('keeps the standalone output, the traced root, the transpiled workspace packages and the other settings', () => {
    expect(config.output).toBe('standalone');
    expect(config.outputFileTracingRoot).toBe(path.resolve(import.meta.dirname, '../../..'));
    expect(config.transpilePackages).toEqual(['@bananagig/contracts', '@bananagig/config', '@bananagig/observability', '@bananagig/identity']);
    expect(config.serverExternalPackages).toContain('iovalkey');
    expect(config.poweredByHeader).toBe(false);
    expect(config.typedRoutes).toBe(true);
  });
});
