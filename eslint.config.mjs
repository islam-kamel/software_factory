// ============================================================
// eslint.config.mjs
// Purpose : Apply TypeScript lint rules and project complexity limits
// Feature : Shared
// Role    : Lint Configuration
// API Doc : https://eslint.org/docs/latest/use/configure/configuration-files
// ============================================================
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "max-depth": ["error", 3],
      complexity: ["error", 10],
      "max-lines": ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-len": ["error", { code: 120, comments: 120, ignoreUrls: true }],
      "max-params": ["error", 3],
    },
  },
  prettier,
);
