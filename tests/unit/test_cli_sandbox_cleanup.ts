// ============================================================
// test_cli_sandbox_cleanup.ts
// Purpose : Preserve captured sandbox output when resource cleanup fails
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : https://nodejs.org/api/child_process.html
// ============================================================
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stopSystemdScope: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/adapters/cli_runner/resource_scope", () => ({
  createSystemdScopeArgs: vi.fn(() => []),
  stopSystemdScope: mocks.stopSystemdScope,
  systemdControlEnvironment: vi.fn(() => ({})),
  SYSTEMD_RUN_EXECUTABLE: "/usr/bin/systemd-run",
}));

import { runSandboxed, SandboxCleanupError } from "@/adapters/cli_runner/sandbox";

const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.skipIf(process.platform !== "linux")("retains captured stderr without exposing it in cleanup errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cleanup-test-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const scratchDirectory = join(root, "scratch");
  await mkdir(workspace);
  await mkdir(scratchDirectory);
  const stderr = "provider rejected request\napi_key=fake-secret-value\n";
  mocks.spawn.mockImplementation(() => createChild(stderr));
  mocks.stopSystemdScope.mockRejectedValue(new Error("private cleanup detail"));

  const result = runSandboxed("fake-cli", [], {
    workspace,
    ignorePaths: [],
    access: "read_only",
    timeoutMs: 2_000,
    scratchDirectory,
    runtimeProfile: {
      mounts: [],
      commands: { "fake-cli": "/runtime/fake-cli" },
      path: "/tmp/runtime-profile.yaml",
    },
    resourceLimits: { cpu_quota_percent: 100, memory_mb: 128, max_pids: 16 },
  });

  const error = await result.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SandboxCleanupError);
  if (!(error instanceof SandboxCleanupError)) throw new Error("Expected sandbox cleanup error");
  expect(error.result).toEqual({
    exitCode: 7,
    stdout: "",
    stderr,
    timedOut: false,
    outputLimit: false,
  });
  expect(String(error)).not.toContain(stderr);
  expect(Object.keys(error)).not.toContain("result");
  expect(JSON.stringify(error)).not.toContain(stderr);
  expect(inspect(error)).not.toContain(stderr);
  expect(inspect(error)).not.toContain("private cleanup detail");
});

function createChild(stderr: string): EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
} {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => undefined,
  });
  setImmediate(() => {
    child.stderr.end(stderr);
    child.stdout.end();
    setImmediate(() => child.emit("close", 7));
  });
  return child;
}
