import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/next-env.d.ts', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }] } },
  // Architecture rules (see docs/engineering/APPLICATION_ARCHITECTURE.md)
  {
    // web (production code): no database/infrastructure access, no DEV/TEST-only identity helpers
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@bananagig/database',
                '@bananagig/database/*',
                '@bananagig/platform',
                '@bananagig/platform/*',
                '@bananagig/content',
                '@bananagig/content/*',
                '@bananagig/geography',
                '@bananagig/geography/*',
                '@bananagig/configuration',
                '@bananagig/configuration/*',
                'pg',
                'kysely',
                'pg-boss',
              ],
              message: 'web must not access the database, infrastructure adapters or the server-side content/configuration/geography registries; call the API.',
            },
            { group: ['@bananagig/identity/testing'], message: 'identity test helpers are DEV/TEST ONLY.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@bananagig/database',
                '@bananagig/database/*',
                '@bananagig/platform',
                '@bananagig/platform/*',
                '@bananagig/content',
                '@bananagig/content/*',
                '@bananagig/geography',
                '@bananagig/geography/*',
                '@bananagig/configuration',
                '@bananagig/configuration/*',
                'pg',
                'kysely',
                'pg-boss',
              ],
              message: 'web must not access the database, infrastructure adapters or the server-side content/configuration/geography registries.',
            },
          ],
        },
      ],
    },
  },
  {
    // DEV/TEST-ONLY identity helpers (password grant, forged tokens) must never reach production code.
    files: [
      'apps/api/src/**/*.ts',
      'apps/worker/src/**/*.ts',
      'packages/platform/src/**/*.ts',
      'packages/database/src/**/*.ts',
      'packages/config/src/**/*.ts',
      'packages/observability/src/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/*.itest.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@bananagig/identity/testing'], message: 'identity test helpers are DEV/TEST ONLY; use them from tests and the smoke app.' }] },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts', 'packages/identity/src/index.ts', 'packages/identity/src/verifier.ts', 'packages/identity/src/oidc.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@bananagig/*', '**/apps/**'], message: 'contracts and identity must not import workspace packages or apps.' }] },
      ],
    },
  },
  {
    files: ['packages/database/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bananagig/web', '@bananagig/api', '@bananagig/worker', 'react', 'next', 'next/*'],
              message: 'database must not depend on UI or applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
);
