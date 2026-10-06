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
