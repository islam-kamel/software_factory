// ============================================================
// vite.config.ts
// Purpose : Bundle the configuration loader as a Node ESM library
// Feature : Build
// Role    : Build Configuration
// API Doc : https://vite.dev/config/
// ============================================================
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    lib: { entry: "src/engine/config_loader.ts", formats: ["es"], fileName: "config_loader" },
    rollupOptions: { external: ["node:fs", "node:path", "yaml", "zod"] },
  },
});
