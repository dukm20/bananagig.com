// Guards the generated OpenAPI against a silent omission (found in ID-004: the ID-003 phone routes were missing from docs/api/openapi.yaml because
// scripts/generate-specs.mjs never passed the phone service to buildApp; `specs:check` could not notice, since the committed file and the generated file were equally incomplete).
// Every optional service of AppDeps enables a route module, so the generator must pass each one, and the committed spec must contain routes of each module.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');

/** The property names of `interface AppDeps` in app.ts. */
const appDepsKeys = (): string[] => {
  const src = read('apps/api/src/app.ts');
  const body = /export interface AppDeps \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]!);
};

/** The keys passed to buildApp({...}) by the spec generator. */
const generatorKeys = (): string[] => {
  const src = read('scripts/generate-specs.mjs');
  const body = /await buildApp\(\{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/^ {2}([a-zA-Z]+)\b/gm)].map((m) => m[1]!);
};

describe('the spec generator covers every route module of the app', () => {
  it('reads both lists (the parsing itself is not silently empty)', () => {
    expect(appDepsKeys().length).toBeGreaterThanOrEqual(10);
    expect(generatorKeys().length).toBeGreaterThanOrEqual(10);
  });

  it('passes every AppDeps property to buildApp', () => {
    const passed = new Set(generatorKeys());
    // diagnostics is a runtime-only hook; everything else enables routes or is required
    const missing = appDepsKeys().filter((k) => k !== 'diagnostics' && !passed.has(k));
    expect(missing, `scripts/generate-specs.mjs does not pass: ${missing.join(', ')}`).toEqual([]);
  });

  it.each([
    ['account', '/api/v1/account/me'],
    ['email', '/api/v1/account/email'],
    ['phone', '/api/v1/account/phone'],
    ['security', '/api/v1/account/security'],
    ['consent', '/api/v1/account/consents'],
    ['password reset', '/api/v1/auth/password-reset'],
    ['geography', '/api/v1/geography/countries'],
    ['content', '/api/v1/content/resolve'],
    ['configuration', '/api/v1/configuration/parameters'],
  ])('the committed OpenAPI documents the %s routes', (_name, prefix) => {
    const spec = read('docs/api/openapi.yaml');
    expect(spec, `docs/api/openapi.yaml has no path starting with ${prefix}`).toMatch(
      new RegExp(`^ {2}${prefix.replace(/[/]/g, '\\/')}[A-Za-z0-9/_{}:.-]*:`, 'm'),
    );
  });
});
