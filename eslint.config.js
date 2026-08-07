import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      // Adopted 2026-08-07 from the quorum repo, where they were never linted
      // (quorum is a Python project). They are the measurement harness for the
      // fold-vs-compaction study, not package source — nothing here ships to
      // npm, since package.json `files` is [extensions, README.md, LICENSE].
      // Ignored rather than conformed so the move stayed verbatim: `npm run
      // lint` keeps meaning "the package is clean" instead of going red on
      // 18 pre-existing unused-variable findings in imported code. Drop these
      // entries once the harness is conformed.
      "scripts/**",
      "tests/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "none" }],
      "no-useless-assignment": "off",
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "always"],
    },
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint,
    },
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
];
