// ============================================================
// vite.config.ts
// Purpose : Bundle configuration, agent, and orchestration APIs as Node ESM entries
// Feature : Build
// Role    : Build Configuration
// API Doc : https://vite.dev/config/
// ============================================================
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    lib: {
      entry: {
        config_loader: "src/engine/config_loader.ts",
        run_agent: "src/agents/run_agent.ts",
        orchestrator: "src/engine/orchestrator.ts",
      },
      formats: ["es"],
      fileName: "[name]",
    },
    rollupOptions: { external: (id) => id.startsWith("node:") || id === "yaml" || id === "zod" },
  },
});
