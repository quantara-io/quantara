// ESLint v9 flat config — applies to all TypeScript/JavaScript in the monorepo.
// web/ keeps its own eslint.config.mjs that extends this via spreading, adding
// Next.js-specific rules. All other workspaces are governed by this root config.

import tsEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '.terraform/**',
      'web/**', // web/ is governed by web/eslint.config.mjs
    ],
  },
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json', './*/tsconfig.json', './packages/*/tsconfig.json'],
      },
    },
    plugins: { '@typescript-eslint': tsEslint, import: importPlugin },
    rules: {
      // typescript-eslint recommended subset
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      // import hygiene
      'import/no-cycle': 'error',
      'import/order': ['error', { 'newlines-between': 'always' }],
      // general
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }], // log allowed for ingestion logs
    },
  },
  prettierConfig, // disables formatting-conflicting ESLint rules
];
