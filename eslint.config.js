import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }] } },
  // Architecture rules (see docs/engineering/APPLICATION_ARCHITECTURE.md)
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bananagig/database', '@bananagig/database/*', '@bananagig/platform', '@bananagig/platform/*', 'pg', 'kysely', 'pg-boss'],
              message: 'web must not access the database or infrastructure adapters; call the API.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@bananagig/*', '**/apps/**'], message: 'contracts must not import workspace packages or apps.' }] },
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
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', setTimeout: 'readonly', URL: 'readonly' } },
  },
);
