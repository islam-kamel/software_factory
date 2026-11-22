// ============================================================
// test_agent_cli.ts
// Purpose : Verify the freshly built agent CLI entry from another directory
// Feature : Agent execution
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 1
// ============================================================
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrapper = resolve(root, "src/agents/run.sh");
const entry = resolve(root, "dist/run_agent.js");

beforeAll(() => {
  const build = spawnSync(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(build.status, build.stderr).toBe(0);
});

it("prints usage and rejects invalid arguments through the executable wrapper", () => {
  const help = spawnSync(wrapper, ["--help"], { cwd: "/tmp", encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage: src/agents/run.sh");

  const invalid = spawnSync(wrapper, ["--role", "unknown"], { cwd: "/tmp", encoding: "utf8" });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("Agent runner could not start");
});

it("keeps importing the compiled runtime side-effect free", () => {
  const moduleUrl = pathToFileURL(entry).href;
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(moduleUrl)})`], {
    cwd: "/tmp",
    encoding: "utf8",
  });
  expect(imported.status).toBe(0);
  expect(imported.stdout).toBe("");
  expect(imported.stderr).toBe("");
});
