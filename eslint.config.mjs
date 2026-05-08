// ESLint v9 flat config — applies to all TypeScript/JavaScript in the monorepo.
// web/ keeps its own eslint.config.mjs that extends this via spreading, adding
// Next.js-specific rules. All other workspaces are governed by this root config.
//
// Adoption strategy: most rules ship as warnings for v1 so the existing codebase
// can land lint without a flag-day fix-up. Tighten to errors in a follow-up
// once the warnings have been driven to zero.

import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      ".terraform/**",
      "web/**", // web/ is governed by web/eslint.config.mjs
      "**/*.config.{mjs,js,ts}",
      "**/scripts/**", // simple build/CI scripts; not part of any tsconfig project
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      // No `parserOptions.project` here — type-aware lint rules require a
      // tsconfig per file, which is brittle across a workspace monorepo. We
      // forgo type-aware rules in v1 (no-floating-promises etc. become noop).
      // Revisit once the workspace tsconfigs settle.
    },
    plugins: { "@typescript-eslint": tsEslint, import: importPlugin },
    rules: {
      // typescript-eslint — non-type-aware subset
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "warn",
      // import hygiene
      "import/order": ["warn", { "newlines-between": "always" }],
      // general — keep these as errors; they catch real bugs
      "prefer-const": "error",
      "no-console": ["warn", { allow: ["warn", "error", "log"] }], // log allowed for ingestion logs
    },
  },
  prettierConfig, // disables formatting-conflicting ESLint rules
];
