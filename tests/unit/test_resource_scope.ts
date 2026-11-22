// ============================================================
// test_resource_scope.ts
// Purpose : Verify systemd process-tree resource-scope arguments
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
// ============================================================
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSystemdScopeArgs,
  isSystemdScopeInactive,
  stopSystemdScope,
  systemdControlEnvironment,
  SYSTEMD_RUN_EXECUTABLE,
} from "@/adapters/cli_runner/resource_scope";

it("applies CPU, memory, PID and wall-clock limits to the full process scope", () => {
  const args = createSystemdScopeArgs({
    unitName: "factory-01234567-89ab-cdef-0123-456789abcdef.scope",
    resourceLimits: { cpu_quota_percent: 100, memory_mb: 2048, max_pids: 256 },
    timeoutMs: 60_001,
    command: "/usr/bin/bwrap",
    args: ["--unshare-net", "--", "/usr/bin/node"],
  });

  expect(args).toEqual([
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    "--expand-environment=no",
    "--unit=factory-01234567-89ab-cdef-0123-456789abcdef.scope",
    "--property=CPUQuota=100%",
    "--property=MemoryMax=2048M",
    "--property=MemorySwapMax=0",
    "--property=TasksMax=256",
    "--property=RuntimeMaxSec=61s",
    "--property=TimeoutStopSec=2s",
    "--property=OOMPolicy=kill",
    "--",
    "/usr/bin/bwrap",
    "--unshare-net",
    "--",
    "/usr/bin/node",
  ]);
  expect(args).not.toContain("--wait");
  expect(args).not.toContain("--pipe");
});

it("only accepts terminal systemd states with an empty process tree", () => {
  expect(isSystemdScopeInactive("inactive", 0)).toBe(true);
  expect(isSystemdScopeInactive("failed", 0)).toBe(true);
  expect(isSystemdScopeInactive("deactivating", 0)).toBe(false);
  expect(isSystemdScopeInactive("activating", 0)).toBe(false);
  expect(isSystemdScopeInactive("inactive", 1)).toBe(false);
  expect(isSystemdScopeInactive("inactive", Number.NaN)).toBe(false);
});

it.skipIf(process.platform !== "linux" || process.env.SOFTWARE_FACTORY_RESOURCE_SCOPE_TEST !== "1")(
  "stops detached descendants that outlive the scoped command",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-resource-scope-"));
    const heartbeat = join(directory, "heartbeat.txt");
    await writeFile(heartbeat, "");
    const unitName = `factory-${randomUUID()}.scope`;
    const childCode = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], '.'), 50)";
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)},`,
      `${JSON.stringify(heartbeat)}], { detached: true, stdio: 'ignore' });`,
      "child.unref();",
      "setTimeout(() => process.exit(0), 150);",
    ].join("\n");
    const env = systemdControlEnvironment();
    const args = createSystemdScopeArgs({
      unitName,
      resourceLimits: { cpu_quota_percent: 100, memory_mb: 128, max_pids: 32 },
      timeoutMs: 5_000,
      command: process.execPath,
      args: ["-e", parentCode],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const scoped = spawn(SYSTEMD_RUN_EXECUTABLE, args, { env, stdio: "ignore" });
        scoped.once("error", () => reject(new Error("Unable to start the systemd scope")));
        scoped.once("close", (code) => (code === 0 ? resolve() : reject(new Error("Systemd scope failed"))));
      });
      const before = (await readFile(heartbeat, "utf8")).length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await readFile(heartbeat, "utf8")).length).toBeGreaterThan(before);
      await stopSystemdScope(unitName, env);
      const stopped = (await readFile(heartbeat, "utf8")).length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await readFile(heartbeat, "utf8")).length).toBe(stopped);
    } finally {
      await stopSystemdScope(unitName, env).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
