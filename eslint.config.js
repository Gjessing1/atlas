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
    // Plain-node scripts (build tooling in scripts/, infrastructure/packs/*.mjs).
    files: ['scripts/**/*.mjs', 'infrastructure/**/*.mjs', 'apps/android/e2e/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Expo config plugins (prebuild) and the Metro config run in node as CommonJS.
    files: ['apps/android/plugins/**/*.js', 'apps/android/metro.config.js'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
