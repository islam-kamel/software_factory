// ============================================================
// eslint.config.mjs
// Purpose : Define baseline lint rules for TypeScript source
// Feature : Shared
// Role    : Tool Configuration
// API Doc : N/A
// ============================================================
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-len": ["error", { code: 120, ignoreUrls: true }],
      "max-params": ["error", 3],
      complexity: ["error", 10],
    },
  },
  prettier,
);
