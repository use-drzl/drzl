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
      // One pattern rather than a name per spec, for the reason `.gitignore` carries the same
      // rule: the enumerated list works until a new spec picks a directory nobody added to it.
      // `cli-errors.e2e.spec.ts` writes a schema that deliberately does not parse, so a run
      // interrupted before its cleanup leaves a file that fails lint outright rather than
      // warning, and the failure is in a fixture nobody is looking at.
      '**/.tmp-*/**',
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
