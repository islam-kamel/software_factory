// ============================================================
// vitest.config.ts
// Purpose : Configure unit tests and the source import alias
// Feature : Shared
// Role    : Test Configuration
// API Doc : https://vitest.dev/config/
// ============================================================
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/**/*.ts"] },
});
