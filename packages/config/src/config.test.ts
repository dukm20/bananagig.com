import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig } from './index';

describe('loadConfig', () => {
  it('applies dev defaults outside production', () => {
    const cfg = loadConfig({ service: 't', env: {} });
    expect(cfg.env).toBe('development');
    expect(cfg.serviceName).toBe('t');
    expect(cfg.worker.concurrency).toBe(2);
  });
  it('rejects invalid values', () => {
    expect(() => loadConfig({ service: 't', env: { NODE_ENV: 'staging' } })).toThrow(ConfigError);
    expect(() => loadConfig({ service: 't', env: { DATABASE_URL: 'not a url' } })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ service: 't', env: { PORT: '99999' } })).toThrow(/PORT/);
  });
  it('requires explicit infrastructure settings in production', () => {
    expect(() => loadConfig({ service: 't', env: { NODE_ENV: 'production' } })).toThrow(/DATABASE_URL: required in production/);
  });
  it('requires only the role-specific settings in production', () => {
    const web = {
      NODE_ENV: 'production',
      API_INTERNAL_URL: 'http://api-service:3000',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      KEYCLOAK_URL: 'http://keycloak-auth:8080',
      KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
      WEB_PUBLIC_URL: 'https://app.example.com',
      VALKEY_URL: 'redis://valkey-cache:6379',
    };
    expect(loadConfig({ service: 'w', role: 'web', env: web }).apiInternalUrl).toBe('http://api-service:3000');
    expect(() => loadConfig({ service: 'a', role: 'api', env: web })).toThrow(/DATABASE_URL/);
  });
  it('derives the pinned issuer and back-channel JWKS URL for identity', () => {
    const cfg = loadConfig({ service: 't', env: { KEYCLOAK_PUBLIC_URL: 'https://auth.example.com/', KEYCLOAK_URL: 'http://keycloak-auth:8080' } });
    expect(cfg.identity.issuer).toBe('https://auth.example.com/realms/bananagig');
    expect(cfg.identity.jwksUrl).toBe('http://keycloak-auth:8080/realms/bananagig/protocol/openid-connect/certs');
    expect(cfg.identity).toMatchObject({ apiAudience: 'bananagig-api', webClientId: 'bananagig-web', adminClientId: 'bananagig-admin' });
  });
  it('redacts secrets and URL credentials', () => {
    const cfg = loadConfig({ service: 't', env: { DATABASE_URL: 'postgres://u:pw@h:5432/d', S3_SECRET_KEY: 'shh' } });
    const out = JSON.stringify(redactConfig(cfg));
    expect(out).not.toContain('pw@');
    expect(out).not.toContain('shh');
  });
});

describe('loadConfig: VERIFICATION_HASH_SECRET (ID-002)', () => {
  // A deployment value is built from pieces so no line of this file looks like a committed credential.
  const explicitKey = 'explicit-hash-key-'.concat('0123456789abcdef'.repeat(2));
  const prodApi = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:pw@db:5432/d',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    KEYCLOAK_URL: 'http://keycloak-auth:8080',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    WEB_PUBLIC_URL: 'https://app.example.com',
  };
  const configErrorIssues = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues;
    }
    throw new Error('expected loadConfig to throw a ConfigError');
  };

  it('has a development default of at least 32 characters outside production', () => {
    const cfg = loadConfig({ service: 't', env: {} });
    expect(typeof cfg.verification.hashSecret).toBe('string');
    expect(cfg.verification.hashSecret.length).toBeGreaterThanOrEqual(32);
    expect(cfg.verification.hashSecret).toMatch(/dev/i);
  });
  it('applies the development default for every role outside production', () => {
    for (const role of ['web', 'api', 'worker', 'tool'] as const) {
      expect(loadConfig({ service: 't', role, env: {} }).verification.hashSecret.length, role).toBeGreaterThanOrEqual(32);
    }
  });
  it('treats an empty value as unset and falls back to the development default', () => {
    const dflt = loadConfig({ service: 't', env: {} }).verification.hashSecret;
    expect(loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: '' } }).verification.hashSecret).toBe(dflt);
  });
  it('uses an explicit value instead of the default', () => {
    const cfg = loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: explicitKey } });
    expect(cfg.verification.hashSecret).toBe(explicitKey);
    expect(cfg.verification.hashSecret).not.toBe(loadConfig({ service: 't', env: {} }).verification.hashSecret);
  });
  it.each([32, 33, 64, 256])('accepts an explicit value of %s characters', (length) => {
    expect(loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: 'k'.repeat(length) } }).verification.hashSecret).toHaveLength(length);
  });
  it.each([1, 16, 31])('rejects a value of %s characters with a ConfigError that names the variable', (length) => {
    const issues = configErrorIssues(() => loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: 'k'.repeat(length) } }));
    expect(issues.join('\n')).toMatch(/VERIFICATION_HASH_SECRET/);
    expect(() => loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: 'k'.repeat(length) } })).toThrow(/VERIFICATION_HASH_SECRET/);
  });
  it('rejects a value above 256 characters', () => {
    expect(() => loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: 'k'.repeat(257) } })).toThrow(/VERIFICATION_HASH_SECRET/);
  });
  it('does not echo a rejected value in the error', () => {
    const rejected = 'short-hash-key-'.concat('x'.repeat(5));
    const issues = configErrorIssues(() => loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: rejected } }));
    expect(issues.join('\n')).not.toContain(rejected);
  });
  it('rejects a too-short value in production too, even for a role that does not require it', () => {
    expect(() => loadConfig({ service: 'w', role: 'worker', env: { NODE_ENV: 'production', VERIFICATION_HASH_SECRET: 'short' } })).toThrow(
      /VERIFICATION_HASH_SECRET/,
    );
  });
  it('requires it in production for the api role, listing it together with WEB_PUBLIC_URL', () => {
    const { WEB_PUBLIC_URL: _web, ...withoutWebUrl } = prodApi;
    const issues = configErrorIssues(() => loadConfig({ service: 'a', role: 'api', env: withoutWebUrl }));
    expect(issues).toContain('VERIFICATION_HASH_SECRET: required in production');
    expect(issues).toContain('WEB_PUBLIC_URL: required in production');
  });
  it('names VERIFICATION_HASH_SECRET even when it is the only missing setting', () => {
    const issues = configErrorIssues(() => loadConfig({ service: 'a', role: 'api', env: prodApi }));
    expect(issues).toEqual(['VERIFICATION_HASH_SECRET: required in production']);
  });
  it('accepts the api role in production once the value is set explicitly', () => {
    const cfg = loadConfig({ service: 'a', role: 'api', env: { ...prodApi, VERIFICATION_HASH_SECRET: explicitKey } });
    expect(cfg.verification.hashSecret).toBe(explicitKey);
    expect(cfg.identity.webPublicUrl).toBe('https://app.example.com');
  });
  it('never falls back to the development default in production', () => {
    const dflt = loadConfig({ service: 't', env: {} }).verification.hashSecret;
    expect(() => loadConfig({ service: 'a', role: 'api', env: prodApi })).toThrow(ConfigError);
    const cfg = loadConfig({ service: 'a', role: 'api', env: { ...prodApi, VERIFICATION_HASH_SECRET: explicitKey } });
    expect(cfg.verification.hashSecret).not.toBe(dflt);
  });
  it('requires it in production when no role is given (the strictest set)', () => {
    const issues = configErrorIssues(() => loadConfig({ service: 't', env: { NODE_ENV: 'production' } }));
    expect(issues).toContain('VERIFICATION_HASH_SECRET: required in production');
  });
  it('does not require it in production for the worker role', () => {
    const worker = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:pw@db:5432/d',
      NATS_URL: 'nats://nats:4222',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    };
    const cfg = loadConfig({ service: 'w', role: 'worker', env: worker });
    expect(cfg.env).toBe('production');
    expect(cfg.verification.hashSecret).toBe('');
  });
  it('does not require it in production for the web role', () => {
    const web = {
      NODE_ENV: 'production',
      API_INTERNAL_URL: 'http://api-service:3000',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      KEYCLOAK_URL: 'http://keycloak-auth:8080',
      KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
      WEB_PUBLIC_URL: 'https://app.example.com',
      VALKEY_URL: 'redis://valkey-cache:6379',
    };
    const cfg = loadConfig({ service: 'w', role: 'web', env: web });
    expect(cfg.env).toBe('production');
    expect(cfg.verification.hashSecret).toBe('');
  });
  it('does not require it in production for the tool role', () => {
    const cfg = loadConfig({ service: 't', role: 'tool', env: { NODE_ENV: 'production' } });
    expect(cfg.verification.hashSecret).toBe('');
  });
  it('now requires WEB_PUBLIC_URL for the api role in production (the verification link is built from it)', () => {
    const { WEB_PUBLIC_URL: _web, ...withoutWebUrl } = prodApi;
    expect(() => loadConfig({ service: 'a', role: 'api', env: { ...withoutWebUrl, VERIFICATION_HASH_SECRET: explicitKey } })).toThrow(
      /WEB_PUBLIC_URL: required in production/,
    );
  });
  it('exposes the value only under verification.hashSecret', () => {
    const cfg = loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: explicitKey } });
    expect(Object.keys(cfg.verification)).toEqual(['hashSecret']);
  });
  it('freezes the loaded configuration', () => {
    const cfg = loadConfig({ service: 't', env: {} });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe('redactConfig: VERIFICATION_HASH_SECRET (ID-002)', () => {
  const explicitKey = 'explicit-hash-key-'.concat('0123456789abcdef'.repeat(2));
  it('never prints the explicit hash secret', () => {
    const cfg = loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: explicitKey } });
    const out = redactConfig(cfg);
    expect(JSON.stringify(out)).not.toContain(explicitKey);
    expect((out.verification as { hashSecret: string }).hashSecret).toBe('***');
  });
  it('never prints the development default either', () => {
    const cfg = loadConfig({ service: 't', env: {} });
    expect(JSON.stringify(redactConfig(cfg))).not.toContain(cfg.verification.hashSecret);
    expect((redactConfig(cfg).verification as { hashSecret: string }).hashSecret).toBe('***');
  });
  it('keeps the other fields readable', () => {
    const cfg = loadConfig({
      service: 'svc',
      env: { VERIFICATION_HASH_SECRET: explicitKey, WEB_PUBLIC_URL: 'https://app.example.com', PORT: '4321', MAIL_FROM: 'no-reply@example.com' },
    });
    const out = redactConfig(cfg) as {
      serviceName: string;
      port: number;
      mailFrom: string;
      identity: { webPublicUrl: string; realm: string };
      verification: Record<string, unknown>;
    };
    expect(out.serviceName).toBe('svc');
    expect(out.port).toBe(4321);
    expect(out.mailFrom).toBe('no-reply@example.com');
    expect(out.identity.webPublicUrl).toBe('https://app.example.com');
    expect(out.identity.realm).toBe(cfg.identity.realm);
    expect(Object.keys(out.verification)).toEqual(['hashSecret']);
  });
  it('still redacts the other credentials in the same pass', () => {
    const cfg = loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: explicitKey, DATABASE_URL: 'postgres://u:pw@h:5432/d', S3_SECRET_KEY: 'shh' } });
    const out = JSON.stringify(redactConfig(cfg));
    expect(out).not.toContain(explicitKey);
    expect(out).not.toContain('pw@');
    expect(out).not.toContain('shh');
  });
  it('does not mutate the loaded configuration', () => {
    const cfg = loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: explicitKey } });
    redactConfig(cfg);
    expect(cfg.verification.hashSecret).toBe(explicitKey);
  });
});
