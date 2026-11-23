// ============================================================
// test_verifier.ts
// Purpose : Verify ordered deterministic checks and first-failure stopping
// Feature : Quality verification
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Deterministic Verifier
// ============================================================
import { access, chmod, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVerifier, type CheckRunner } from "@/self_healing/verifier";
import { DEFAULT_RESOURCE_LIMITS, type ResolvedRepository } from "@/engine/config_schemas";
import * as runLog from "@/engine/run_log";

vi.mock("@/adapters/cli_runner/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters/cli_runner/sandbox")>()),
  runSandboxed: vi.fn(),
}));
import { runSandboxed, SandboxCleanupError } from "@/adapters/cli_runner/sandbox";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "factory-verify-test-"));
  roots.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeRepository(verification: ResolvedRepository["verification"]): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: "/tmp/sample",
    use_worktree: true,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true, ignore_paths: [".env*"] },
    tracker: { provider: "local_md" },
    verification,
  };
}

it("runs secret scan, lint, typecheck and test in order and stops at the first failure", async () => {
  const calls: string[] = [];
  const runner: CheckRunner = async (step, command) => {
    calls.push(`${step}:${command}`);
    return {
      exitCode: step === "typecheck" ? 1 : 0,
      stdout: "",
      stderr: "type error",
      timedOut: false,
      outputLimit: false,
    };
  };
  const verify = createVerifier(runner);
  const result = await verify({
    repository: makeRepository({ secret_scan: "scan", lint: "lint", typecheck: "types", test: "tests" }),
    workspace: await makeWorkspace(),
    timeoutMs: 1000,
  });
  expect(calls).toEqual(["secret_scan:scan", "lint:lint", "typecheck:types"]);
  expect(result).toMatchObject({ passed: false, attempt: 1, failed_step: "typecheck", summary: "type error" });
});

it("always runs verifier steps with offline isolation", async () => {
  vi.mocked(runSandboxed).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputLimit: false,
  });
  const runtimeProfile = { mounts: [], commands: { bash: "/bin/bash" }, path: "/tmp/runtime-profile.yaml" };
  const result = await createVerifier()({
    repository: makeRepository({ secret_scan: "scan", lint: "lint", typecheck: "types", test: "tests" }),
    workspace: await makeWorkspace(),
    runtimeProfile,
  });

  expect(result.passed).toBe(true);
  expect(vi.mocked(runSandboxed)).toHaveBeenCalledTimes(4);
  expect(vi.mocked(runSandboxed).mock.calls.every((call) => call[2].offline === true)).toBe(true);
  expect(vi.mocked(runSandboxed).mock.calls.every((call) => call[2].resourceLimits === DEFAULT_RESOURCE_LIMITS)).toBe(
    true,
  );
  vi.mocked(runSandboxed).mockReset();
});

it("reports configured command timeouts as a failed verification step", async () => {
  const runner: CheckRunner = async () => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
    outputLimit: false,
  });
  const result = await createVerifier(runner)({
    repository: makeRepository({ test: "tests" }),
    workspace: await makeWorkspace(),
    timeoutMs: 1000,
  });
  expect(result).toMatchObject({ passed: false, failed_step: "test" });
  expect(result.summary).toMatch(/timed out/i);
});

it("fails closed when no verification commands are configured", async () => {
  const result = await createVerifier(async () => {
    throw new Error("must not run");
  })({ repository: makeRepository(undefined), workspace: "/tmp/sample", timeoutMs: 1000 });
  expect(result).toMatchObject({ passed: false, failed_step: "configuration" });
});

it("provides an external scratch directory and removes it after the default checks", async () => {
  let scratchDirectory = "";
  const runner: CheckRunner = async (_step, _command, options) => {
    scratchDirectory = options.scratchDirectory;
    await access(scratchDirectory);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputLimit: false };
  };
  const result = await createVerifier(runner)({
    repository: makeRepository({ test: "tests" }),
    workspace: await makeWorkspace(),
  });

  expect(result.passed).toBe(true);
  await expect(access(scratchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("saves captured output from cleanup failures through the private run log", async () => {
  const repository = await makeWorkspace();
  const workspace = await makeWorkspace();
  const logDirectory = await makeWorkspace();
  await chmod(logDirectory, 0o700);
  const secret = "synthetic-unredacted-secret";
  vi.mocked(runSandboxed).mockRejectedValue(
    new SandboxCleanupError({
      exitCode: 1,
      stdout: "stdout detail",
      stderr: secret,
      timedOut: false,
      outputLimit: false,
    }),
  );

  const result = await createVerifier()({
    repository: { ...makeRepository({ test: "tests" }), local_path: repository },
    workspace,
    runtimeProfile: { mounts: [], commands: { bash: "/bin/bash" }, path: "/tmp/runtime-profile.yaml" },
    logDirectory,
  });

  expect(result).toMatchObject({
    passed: false,
    failed_step: "test",
  });
  expect(result.summary).not.toContain(secret);
  expect(result.summary).toMatch(/^Unable to confirm sandbox cleanup: \/.*\.log$/);
  const files = await readdir(logDirectory);
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (!fileName) throw new Error("Expected one verifier log file");
  const logPath = join(await realpath(logDirectory), fileName);
  expect(result.summary).toContain(logPath);
  expect(await readFile(logPath, "utf8")).toBe(`${secret}\nstdout detail`);
  expect((await stat(logPath)).mode & 0o777).toBe(0o600);
});

it("preserves the existing raw output format for ordinary failed checks", async () => {
  const repository = await makeWorkspace();
  const workspace = await makeWorkspace();
  const logDirectory = await makeWorkspace();
  await chmod(logDirectory, 0o700);
  const secret = "raw-check-output";
  const result = await createVerifier(async () => ({
    exitCode: 1,
    stdout: "stdout detail",
    stderr: secret,
    timedOut: false,
    outputLimit: false,
  }))({
    repository: { ...makeRepository({ test: "tests" }), local_path: repository },
    workspace,
    logDirectory,
  });

  expect(result).toMatchObject({ passed: false, failed_step: "test" });
  const files = await readdir(logDirectory);
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (!fileName) throw new Error("Expected one verifier log file");
  expect(await readFile(join(await realpath(logDirectory), fileName), "utf8")).toBe(`${secret}\nstdout detail`);
  expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
});

it("keeps failed verification explicit when the central writer rejects", async () => {
  const repository = await makeWorkspace();
  const workspace = await makeWorkspace();
  const logDirectory = await makeWorkspace();
  await chmod(logDirectory, 0o700);
  const write = vi.spyOn(runLog, "writeRunLog").mockRejectedValue(new Error("disk full"));
  const result = await createVerifier(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "sensitive output",
    timedOut: false,
    outputLimit: false,
  }))({
    repository: { ...makeRepository({ test: "tests" }), local_path: repository },
    workspace,
    logDirectory,
  });
  write.mockRestore();

  expect(result).toMatchObject({
    passed: false,
    failed_step: "logging",
    summary: "Unable to save verification failure log",
  });
  expect(await readdir(logDirectory)).toEqual([]);
});
