/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', 'packages/**/test/tmp', 'packages/**/test/fixtures'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  overrides: [
    {
      files: ['**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-empty': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
      },
    },
  ],
};
