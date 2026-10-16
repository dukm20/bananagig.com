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
  it('refuses the published development key in production (ID-003 review)', () => {
    const dev = 'bananagig-dev-only-verification-hash-key-0001';
    expect(() => loadConfig({ service: 't', env: { NODE_ENV: 'production', VERIFICATION_HASH_SECRET: dev } })).toThrow(
      /development value is not allowed in production/,
    );
    expect(loadConfig({ service: 't', env: { VERIFICATION_HASH_SECRET: dev } }).verification.hashSecret).toBe(dev); // development keeps it
  });
  // A deployment value is built from pieces so no line of this file looks like a committed credential.
  const explicitKey = 'explicit-hash-key-'.concat('0123456789abcdef'.repeat(2));
  const prodApi = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:pw@db:5432/d',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    KEYCLOAK_URL: 'http://keycloak-auth:8080',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    WEB_PUBLIC_URL: 'https://app.example.com',
    // required in production for the api role since ID-003 (DEBT-0055)
    TRUSTED_PROXY_HOPS: '1',
    // required in production for the api role since ID-004
    KEYCLOAK_SECURITY_CLIENT_SECRET: 'prod-security-client-secret-'.concat('0123456789abcdef'),
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

// ====================================================================== ID-003: SMS_TRANSPORT, PHONE_INTELLIGENCE, TRUSTED_PROXY_HOPS
describe('loadConfig: SMS_TRANSPORT and PHONE_INTELLIGENCE (ID-003)', () => {
  const hashKey = 'prod-hash-key-'.concat('0123456789abcdef'.repeat(2));
  // every setting a production process with no role (the strictest set) needs, so the tests below isolate the variable under test
  const prodAll = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:pw@db:5432/d',
    VALKEY_URL: 'redis://valkey:6379',
    NATS_URL: 'nats://nats:4222',
    S3_ENDPOINT: 'http://s3:8333',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'shh-value',
    OPENSEARCH_URL: 'http://search:9200',
    FLAGD_HOST: 'flagd',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    SMTP_HOST: 'smtp',
    KEYCLOAK_URL: 'http://keycloak-auth:8080',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    WEB_PUBLIC_URL: 'https://app.example.com',
    API_INTERNAL_URL: 'http://api-service:3000',
    VERIFICATION_HASH_SECRET: hashKey,
    TRUSTED_PROXY_HOPS: '1',
    KEYCLOAK_SECURITY_CLIENT_SECRET: 'prod-security-client-secret-'.concat('0123456789abcdef'),
  };
  const issuesOf = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues;
    }
    throw new Error('expected loadConfig to throw a ConfigError');
  };

  it('has a loadable production baseline for these tests', () => {
    const cfg = loadConfig({ service: 't', env: prodAll });
    expect(cfg.env).toBe('production');
  });

  describe('defaults', () => {
    it('defaults to the fake SMS transport and the fake phone intelligence in development', () => {
      const cfg = loadConfig({ service: 't', env: {} });
      expect(cfg.sms).toEqual({ transport: 'fake' });
      expect(cfg.phoneIntelligence).toBe('fake');
    });
    it('defaults to fake in the test environment', () => {
      const cfg = loadConfig({ service: 't', env: { NODE_ENV: 'test' } });
      expect(cfg.env).toBe('test');
      expect(cfg.sms.transport).toBe('fake');
      expect(cfg.phoneIntelligence).toBe('fake');
    });
    it('defaults to disabled SMS and unknown phone intelligence in production', () => {
      const cfg = loadConfig({ service: 't', env: prodAll });
      expect(cfg.sms.transport).toBe('disabled');
      expect(cfg.phoneIntelligence).toBe('unknown');
    });
    it('treats empty values as unset', () => {
      const dev = loadConfig({ service: 't', env: { SMS_TRANSPORT: '', PHONE_INTELLIGENCE: '' } });
      expect(dev.sms.transport).toBe('fake');
      expect(dev.phoneIntelligence).toBe('fake');
      const prod = loadConfig({ service: 't', env: { ...prodAll, SMS_TRANSPORT: '', PHONE_INTELLIGENCE: '' } });
      expect(prod.sms.transport).toBe('disabled');
      expect(prod.phoneIntelligence).toBe('unknown');
    });
    it.each(['web', 'api', 'worker', 'tool'] as const)('applies the development defaults for the %s role', (role) => {
      const cfg = loadConfig({ service: 't', role, env: {} });
      expect(cfg.sms.transport).toBe('fake');
      expect(cfg.phoneIntelligence).toBe('fake');
    });
  });

  describe('SMS_TRANSPORT', () => {
    it.each(['fake', 'disabled'] as const)('accepts %s outside production', (value) => {
      expect(loadConfig({ service: 't', env: { SMS_TRANSPORT: value } }).sms.transport).toBe(value);
      expect(loadConfig({ service: 't', env: { NODE_ENV: 'test', SMS_TRANSPORT: value } }).sms.transport).toBe(value);
    });
    it('accepts disabled in production', () => {
      expect(loadConfig({ service: 't', env: { ...prodAll, SMS_TRANSPORT: 'disabled' } }).sms.transport).toBe('disabled');
    });
    it.each(['twilio', 'FAKE', 'Disabled', 'true', 'none', 'smtp', ' fake'])('rejects the unknown value %j and names the variable', (value) => {
      expect(() => loadConfig({ service: 't', env: { SMS_TRANSPORT: value } })).toThrow(/SMS_TRANSPORT/);
      expect(issuesOf(() => loadConfig({ service: 't', env: { SMS_TRANSPORT: value } })).join('\n')).toMatch(/SMS_TRANSPORT/);
    });
    it('refuses the fake transport in production and the ConfigError names the variable', () => {
      const issues = issuesOf(() => loadConfig({ service: 't', env: { ...prodAll, SMS_TRANSPORT: 'fake' } }));
      expect(issues.some((i) => i.startsWith('SMS_TRANSPORT'))).toBe(true);
      expect(issues.join('\n')).toMatch(/plaintext codes/);
    });
    it.each(['web', 'api', 'worker', 'tool'] as const)('refuses the fake transport in production for the %s role', (role) => {
      const env = { ...prodAll, SMS_TRANSPORT: 'fake' };
      expect(() => loadConfig({ service: 't', role, env })).toThrow(/SMS_TRANSPORT/);
    });
    it('does not refuse the fake transport outside production', () => {
      expect(() => loadConfig({ service: 't', env: { SMS_TRANSPORT: 'fake' } })).not.toThrow();
    });
  });

  describe('PHONE_INTELLIGENCE', () => {
    it.each(['fake', 'unknown'] as const)('accepts %s outside production', (value) => {
      expect(loadConfig({ service: 't', env: { PHONE_INTELLIGENCE: value } }).phoneIntelligence).toBe(value);
      expect(loadConfig({ service: 't', env: { NODE_ENV: 'test', PHONE_INTELLIGENCE: value } }).phoneIntelligence).toBe(value);
    });
    it('accepts unknown in production', () => {
      expect(loadConfig({ service: 't', env: { ...prodAll, PHONE_INTELLIGENCE: 'unknown' } }).phoneIntelligence).toBe('unknown');
    });
    it.each(['twilio', 'FAKE', 'Unknown', 'none', 'disabled', 'true'])('rejects the unknown value %j and names the variable', (value) => {
      expect(() => loadConfig({ service: 't', env: { PHONE_INTELLIGENCE: value } })).toThrow(/PHONE_INTELLIGENCE/);
    });
    it('refuses the fake classifier in production and the ConfigError names the variable', () => {
      const issues = issuesOf(() => loadConfig({ service: 't', env: { ...prodAll, PHONE_INTELLIGENCE: 'fake' } }));
      expect(issues.some((i) => i.startsWith('PHONE_INTELLIGENCE'))).toBe(true);
    });
    it.each(['web', 'api', 'worker', 'tool'] as const)('refuses the fake classifier in production for the %s role', (role) => {
      expect(() => loadConfig({ service: 't', role, env: { ...prodAll, PHONE_INTELLIGENCE: 'fake' } })).toThrow(/PHONE_INTELLIGENCE/);
    });
    it('reports both fake settings together in one ConfigError', () => {
      const issues = issuesOf(() => loadConfig({ service: 't', env: { ...prodAll, SMS_TRANSPORT: 'fake', PHONE_INTELLIGENCE: 'fake' } }));
      expect(issues.filter((i) => /^(SMS_TRANSPORT|PHONE_INTELLIGENCE)/.test(i))).toHaveLength(2);
    });
    it('the two settings are independent', () => {
      const cfg = loadConfig({ service: 't', env: { SMS_TRANSPORT: 'disabled', PHONE_INTELLIGENCE: 'fake' } });
      expect(cfg.sms.transport).toBe('disabled');
      expect(cfg.phoneIntelligence).toBe('fake');
      const cfg2 = loadConfig({ service: 't', env: { SMS_TRANSPORT: 'fake', PHONE_INTELLIGENCE: 'unknown' } });
      expect(cfg2.sms.transport).toBe('fake');
      expect(cfg2.phoneIntelligence).toBe('unknown');
    });
  });

  describe('TRUSTED_PROXY_HOPS', () => {
    it('defaults to 1 outside production', () => {
      expect(loadConfig({ service: 't', env: {} }).trustedProxyHops).toBe(1);
      expect(loadConfig({ service: 't', env: { NODE_ENV: 'test' } }).trustedProxyHops).toBe(1);
    });
    it.each(['0', '1', '2', '3', '4'])('accepts the numeric string %s', (value) => {
      expect(loadConfig({ service: 't', env: { TRUSTED_PROXY_HOPS: value } }).trustedProxyHops).toBe(Number(value));
    });
    it('keeps an explicit 0 (does not fall back to the default of 1)', () => {
      expect(loadConfig({ service: 't', env: { TRUSTED_PROXY_HOPS: '0' } }).trustedProxyHops).toBe(0);
      expect(loadConfig({ service: 't', env: { ...prodAll, TRUSTED_PROXY_HOPS: '0' } }).trustedProxyHops).toBe(0);
    });
    it.each(['5', '-1', '1.5', 'abc', '10', '100', '0.5', '1e1x', 'one', '--1'])('rejects %j and names the variable', (value) => {
      expect(() => loadConfig({ service: 't', env: { TRUSTED_PROXY_HOPS: value } })).toThrow(/TRUSTED_PROXY_HOPS/);
      expect(issuesOf(() => loadConfig({ service: 't', env: { TRUSTED_PROXY_HOPS: value } })).join('\n')).toMatch(/TRUSTED_PROXY_HOPS/);
    });
    it('rejects out-of-range values in production too', () => {
      expect(() => loadConfig({ service: 't', env: { ...prodAll, TRUSTED_PROXY_HOPS: '5' } })).toThrow(/TRUSTED_PROXY_HOPS/);
      expect(() => loadConfig({ service: 't', env: { ...prodAll, TRUSTED_PROXY_HOPS: '-1' } })).toThrow(/TRUSTED_PROXY_HOPS/);
    });
    it('is REQUIRED in production for the api role', () => {
      const { TRUSTED_PROXY_HOPS: _hops, ...without } = prodAll;
      const issues = issuesOf(() => loadConfig({ service: 'a', role: 'api', env: without }));
      expect(issues.some((i) => i.startsWith('TRUSTED_PROXY_HOPS'))).toBe(true);
      expect(issues.join('\n')).toMatch(/TRUSTED_PROXY_HOPS: required in production/);
    });
    it('is REQUIRED in production when no role is given (the strictest set)', () => {
      const { TRUSTED_PROXY_HOPS: _hops, ...without } = prodAll;
      const issues = issuesOf(() => loadConfig({ service: 't', env: without }));
      expect(issues.some((i) => i.startsWith('TRUSTED_PROXY_HOPS'))).toBe(true);
    });
    it.each(['worker', 'web', 'tool'] as const)('is NOT required in production for the %s role', (role) => {
      const { TRUSTED_PROXY_HOPS: _hops, ...without } = prodAll;
      expect(() => loadConfig({ service: 't', role, env: without })).not.toThrow();
      expect(loadConfig({ service: 't', role, env: without }).trustedProxyHops).toBe(1);
    });
    it('does not require it for the api role when it is set, including 0', () => {
      for (const value of ['0', '1', '4']) {
        const cfg = loadConfig({ service: 'a', role: 'api', env: { ...prodAll, TRUSTED_PROXY_HOPS: value } });
        expect(cfg.trustedProxyHops).toBe(Number(value));
      }
    });
    it('treats an empty value as unset: still required for the api role in production', () => {
      expect(() => loadConfig({ service: 'a', role: 'api', env: { ...prodAll, TRUSTED_PROXY_HOPS: '' } })).toThrow(/TRUSTED_PROXY_HOPS/);
    });
    it('lists it together with the other missing api settings', () => {
      const issues = issuesOf(() => loadConfig({ service: 'a', role: 'api', env: { NODE_ENV: 'production' } }));
      expect(issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
      expect(issues.some((i) => i.startsWith('TRUSTED_PROXY_HOPS'))).toBe(true);
    });
  });

  describe('redactConfig', () => {
    it('keeps the new fields readable', () => {
      const cfg = loadConfig({ service: 't', env: { SMS_TRANSPORT: 'disabled', PHONE_INTELLIGENCE: 'unknown', TRUSTED_PROXY_HOPS: '2' } });
      const out = redactConfig(cfg) as { sms: { transport: string }; phoneIntelligence: string; trustedProxyHops: number };
      expect(out.sms).toEqual({ transport: 'disabled' });
      expect(out.phoneIntelligence).toBe('unknown');
      expect(out.trustedProxyHops).toBe(2);
    });
    it('keeps the development defaults readable too', () => {
      const out = redactConfig(loadConfig({ service: 't', env: {} })) as { sms: { transport: string }; phoneIntelligence: string; trustedProxyHops: number };
      expect(out.sms.transport).toBe('fake');
      expect(out.phoneIntelligence).toBe('fake');
      expect(out.trustedProxyHops).toBe(1);
    });
    it('does not mask the new fields while still masking credentials in the same pass', () => {
      const cfg = loadConfig({ service: 't', env: { DATABASE_URL: 'postgres://u:pw@h:5432/d', S3_SECRET_KEY: 'shh', SMS_TRANSPORT: 'disabled' } });
      const text = JSON.stringify(redactConfig(cfg));
      expect(text).toContain('"transport":"disabled"');
      expect(text).not.toContain('pw@');
      expect(text).not.toContain('shh');
    });
  });
});

// ====================================================================== ID-004: the Keycloak security (admin REST) client
describe('loadConfig: KEYCLOAK_SECURITY_CLIENT_ID / KEYCLOAK_SECURITY_CLIENT_SECRET (ID-004)', () => {
  const devSecret = 'bananagig_security_dev_only_secret_0001';
  const prodSecret = 'prod-security-client-secret-'.concat('0123456789abcdef');
  const hashKey = 'prod-hash-key-'.concat('0123456789abcdef'.repeat(2));
  const prodApi = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:pw@db:5432/d',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
    KEYCLOAK_URL: 'http://keycloak-auth:8080/',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    WEB_PUBLIC_URL: 'https://app.example.com',
    VERIFICATION_HASH_SECRET: hashKey,
    TRUSTED_PROXY_HOPS: '1',
  };
  const issuesOf = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues;
    }
    throw new Error('expected loadConfig to throw a ConfigError');
  };

  describe('defaults outside production', () => {
    it('defaults the client id and the development secret', () => {
      expect(loadConfig({ service: 't', env: {} }).keycloakAdmin).toEqual({
        baseUrl: 'http://127.0.0.1:18081',
        realm: 'bananagig',
        clientId: 'bananagig-security',
        clientSecret: devSecret,
      });
    });
    it('the development secret is long enough for its own validation', () => {
      expect(devSecret.length).toBeGreaterThanOrEqual(32);
    });
    it.each(['development', 'test'])('applies in the %s environment', (env) => {
      expect(loadConfig({ service: 't', env: { NODE_ENV: env } }).keycloakAdmin.clientSecret).toBe(devSecret);
    });
    it.each(['web', 'api', 'worker', 'tool'] as const)('applies for the %s role', (role) => {
      expect(loadConfig({ service: 't', role, env: {} }).keycloakAdmin.clientId).toBe('bananagig-security');
    });
    it('treats empty values as unset', () => {
      const cfg = loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_ID: '', KEYCLOAK_SECURITY_CLIENT_SECRET: '' } });
      expect(cfg.keycloakAdmin.clientId).toBe('bananagig-security');
      expect(cfg.keycloakAdmin.clientSecret).toBe(devSecret);
    });
  });

  describe('AppConfig.keycloakAdmin', () => {
    it('takes the INTERNAL Keycloak URL (no trailing slash), the realm and the explicit client settings', () => {
      const secret = 'explicit-security-secret-'.concat('0123456789abcdef'); // secret-scan:allow (a made-up fixture value, not a credential)
      const cfg = loadConfig({
        service: 't',
        env: {
          KEYCLOAK_URL: 'http://keycloak-auth:8080/',
          KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
          KEYCLOAK_REALM: 'other',
          KEYCLOAK_SECURITY_CLIENT_ID: 'my-security',
          KEYCLOAK_SECURITY_CLIENT_SECRET: secret,
        },
      });
      expect(cfg.keycloakAdmin).toEqual({ baseUrl: 'http://keycloak-auth:8080', realm: 'other', clientId: 'my-security', clientSecret: secret });
      expect(cfg.keycloakAdmin.baseUrl).not.toContain('auth.example.com'); // never the public URL
    });
    it('is part of the frozen configuration object', () => {
      const cfg = loadConfig({ service: 't', env: {} });
      expect(Object.isFrozen(cfg)).toBe(true);
    });
    it('does not change keycloakUrl or identity', () => {
      const cfg = loadConfig({ service: 't', env: {} });
      expect(cfg.keycloakUrl).toBe('http://127.0.0.1:18081');
      expect(cfg.identity.adminClientId).toBe('bananagig-admin');
    });
  });

  describe('validation', () => {
    it.each(['short', 'k'.repeat(31)])('rejects a secret shorter than 32 characters (%j) and names the variable but not the value', (value) => {
      const issues = issuesOf(() => loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_SECRET: value } }));
      expect(issues.join('\n')).toMatch(/KEYCLOAK_SECURITY_CLIENT_SECRET/);
      expect(issues.join('\n')).not.toContain(value);
    });
    it('rejects a secret longer than 256 characters', () => {
      expect(() => loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_SECRET: 'k'.repeat(257) } })).toThrow(/KEYCLOAK_SECURITY_CLIENT_SECRET/);
      expect(loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_SECRET: 'k'.repeat(256) } }).keycloakAdmin.clientSecret).toHaveLength(256);
    });
    it('rejects a too-short secret in production for any role, even one that does not require it', () => {
      expect(() => loadConfig({ service: 'w', role: 'worker', env: { NODE_ENV: 'production', KEYCLOAK_SECURITY_CLIENT_SECRET: 'short' } })).toThrow(
        /KEYCLOAK_SECURITY_CLIENT_SECRET/,
      );
    });
  });

  describe('production', () => {
    it('requires the secret for the api role and names it', () => {
      expect(issuesOf(() => loadConfig({ service: 'a', role: 'api', env: prodApi }))).toEqual(['KEYCLOAK_SECURITY_CLIENT_SECRET: required in production']);
    });
    it('requires it when no role is given (the strictest set)', () => {
      expect(issuesOf(() => loadConfig({ service: 't', env: { NODE_ENV: 'production' } }))).toContain(
        'KEYCLOAK_SECURITY_CLIENT_SECRET: required in production',
      );
    });
    it('lists it together with the other missing api settings', () => {
      const { WEB_PUBLIC_URL: _w, VERIFICATION_HASH_SECRET: _v, ...rest } = prodApi;
      const issues = issuesOf(() => loadConfig({ service: 'a', role: 'api', env: rest }));
      expect(issues).toEqual(
        expect.arrayContaining([
          'WEB_PUBLIC_URL: required in production',
          'VERIFICATION_HASH_SECRET: required in production',
          'KEYCLOAK_SECURITY_CLIENT_SECRET: required in production',
        ]),
      );
    });
    it('accepts the api role once the secret is explicit and keeps the default client id', () => {
      const cfg = loadConfig({ service: 'a', role: 'api', env: { ...prodApi, KEYCLOAK_SECURITY_CLIENT_SECRET: prodSecret } });
      expect(cfg.keycloakAdmin).toEqual({ baseUrl: 'http://keycloak-auth:8080', realm: 'bananagig', clientId: 'bananagig-security', clientSecret: prodSecret });
    });
    it('treats an empty secret as missing in production', () => {
      expect(issuesOf(() => loadConfig({ service: 'a', role: 'api', env: { ...prodApi, KEYCLOAK_SECURITY_CLIENT_SECRET: '' } }))).toContain(
        'KEYCLOAK_SECURITY_CLIENT_SECRET: required in production',
      );
    });
    it.each(['web', 'worker', 'tool'] as const)('does not require it for the %s role', (role) => {
      const env =
        role === 'web'
          ? {
              NODE_ENV: 'production',
              API_INTERNAL_URL: 'http://api-service:3000',
              OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
              KEYCLOAK_URL: 'http://keycloak-auth:8080',
              KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
              WEB_PUBLIC_URL: 'https://app.example.com',
              VALKEY_URL: 'redis://valkey:6379',
            }
          : role === 'worker'
            ? {
                NODE_ENV: 'production',
                DATABASE_URL: 'postgres://u:pw@db:5432/d',
                NATS_URL: 'nats://nats:4222',
                OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
              }
            : { NODE_ENV: 'production' };
      expect(() => loadConfig({ service: 't', role, env })).not.toThrow();
    });
    it('REFUSES the development secret in production and the ConfigError names the variable', () => {
      const issues = issuesOf(() => loadConfig({ service: 'a', role: 'api', env: { ...prodApi, KEYCLOAK_SECURITY_CLIENT_SECRET: devSecret } }));
      expect(issues).toEqual(['KEYCLOAK_SECURITY_CLIENT_SECRET: the development value is not allowed in production']);
    });
    it.each(['web', 'worker', 'tool'] as const)('refuses the development secret in production for the %s role too', (role) => {
      expect(() => loadConfig({ service: 't', role, env: { NODE_ENV: 'production', KEYCLOAK_SECURITY_CLIENT_SECRET: devSecret } })).toThrow(
        /KEYCLOAK_SECURITY_CLIENT_SECRET: the development value is not allowed in production/,
      );
    });
    it('does not refuse the development secret outside production, set explicitly', () => {
      expect(loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_SECRET: devSecret } }).keycloakAdmin.clientSecret).toBe(devSecret);
    });
    it('never falls back to the development secret in production', () => {
      expect(() => loadConfig({ service: 'a', role: 'api', env: prodApi })).toThrow(ConfigError);
      const cfg = loadConfig({ service: 'a', role: 'api', env: { ...prodApi, KEYCLOAK_SECURITY_CLIENT_SECRET: prodSecret } });
      expect(cfg.keycloakAdmin.clientSecret).not.toBe(devSecret);
    });
    it('does not echo the secret in a ConfigError', () => {
      const issues = issuesOf(() => loadConfig({ service: 'a', role: 'api', env: { ...prodApi, KEYCLOAK_SECURITY_CLIENT_SECRET: devSecret } }));
      expect(issues.join('\n')).not.toContain(devSecret);
    });
  });

  describe('redactConfig', () => {
    it('masks the secret and nothing else of the block', () => {
      const secret = 'explicit-security-secret-'.concat('0123456789abcdef'); // secret-scan:allow (a made-up fixture value, not a credential)
      const cfg = loadConfig({ service: 't', env: { KEYCLOAK_SECURITY_CLIENT_SECRET: secret } });
      const text = JSON.stringify(redactConfig(cfg));
      expect(text).not.toContain(secret);
      expect(text).not.toContain(devSecret);
      const out = redactConfig(cfg) as { keycloakAdmin: Record<string, string> };
      expect(out.keycloakAdmin).toEqual({ baseUrl: 'http://127.0.0.1:18081', realm: 'bananagig', clientId: 'bananagig-security', clientSecret: '***' });
    });
    it('masks the development default too', () => {
      expect(JSON.stringify(redactConfig(loadConfig({ service: 't', env: {} })))).not.toContain(devSecret);
    });
  });
});
