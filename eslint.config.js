// Flat ESLint config (ESLint 9) with typescript-eslint.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', 'backend/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Plain-node infrastructure scripts (e.g. infrastructure/packs/*.mjs).
    files: ['infrastructure/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Expo config plugins run in node at prebuild time, as CommonJS.
    files: ['apps/android/plugins/**/*.js'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
