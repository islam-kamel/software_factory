// ============================================================
// test_verifier.ts
// Purpose : Verify ordered deterministic checks and first-failure stopping
// Feature : Quality verification
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Deterministic Verifier
// ============================================================
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createVerifier, type CheckRunner } from "@/self_healing/verifier";
import type { ResolvedRepository } from "@/engine/config_schemas";

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
