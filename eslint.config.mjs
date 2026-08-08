// ESLint v9 flat config
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'packages/**/dist/**',
      'packages/**/test/tmp/**',
      'packages/**/test/fixtures/**',
      'docs/.vitepress/**',
      'real-world-example/**',
      // Next's build output, which is generated JavaScript and generated route types. It is
      // gitignored, so this only matters to a lint run in a tree that has been built, which is
      // every CI run: `pnpm build` comes before `pnpm lint`.
      '**/.next/**',
      '**/.tmp-e2e/**',
      '**/.e2e-tmp/**',
      '**/.cmd-tmp/**',
      '**/*.mjs',
      '**/.wrangler/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
