import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/dist/", "**/public/", "coverage/", "playwright-report/", "test-results/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  unicorn.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Correctness and clarity
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-console": "error",
      "no-param-reassign": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-params": ["error", 6],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: false }],
      // Unicorn rules that clash with TSDoc or this code base's conventions
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "unicorn/no-null": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/name-replacements": "off",
      "unicorn/consistent-boolean-name": "off",
      "unicorn/single-line-block-comment-style": "off",
      "unicorn/no-asterisk-prefix-in-documentation-comments": "off",
      // parseInt/parseFloat are used on purpose for lenient parsing of tool output
      "unicorn/prefer-number-coercion": "off",
      "unicorn/prefer-ternary": ["error", "only-single-line"],
      "unicorn/no-array-reduce": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/prefer-top-level-await": "error",
      // Readability: these rewrite idiomatic code (guard clauses, switch in loops, `.catch(() =>
      // undefined)`) into harder to read forms.
      "unicorn/no-useless-undefined": "off",
      "unicorn/prefer-continue": "off",
      "unicorn/prefer-simple-condition-first": "off",
      "unicorn/consistent-class-member-order": "off",
      "unicorn/no-break-in-nested-loop": "off",
      "unicorn/import-style": "off",
      "unicorn/prefer-await": "off",
      "unicorn/prefer-event-target": "off",
    },
  },
  {
    files: ["apps/ui/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Android TV browsers lag behind: `.at()` and `toSorted()` are newer than the UI's ES2021 target.
      "unicorn/prefer-at": "off",
      "unicorn/no-array-sort": "off",
    },
  },
  {
    files: ["**/test/**/*.ts", "e2e/**/*.ts"],
    rules: {
      "max-lines": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "unicorn/no-await-expression-member": "off",
    },
  },
  prettier,
);
