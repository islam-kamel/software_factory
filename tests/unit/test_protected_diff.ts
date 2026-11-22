// ============================================================
// test_protected_diff.ts
// Purpose : Verify protected file gating and private verifier logs
// Feature : Phase 2 quality gate
// Role    : Unit Tests
// API Doc : src/self_healing/verifier.ts
// ============================================================
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ResolvedRepository } from "@/engine/config_schemas";
import { assertProtectedDiff, createVerifier, type CheckRunner } from "@/self_healing/verifier";

type Fixture = { parent: string; repositoryPath: string; workspace: string; repository: ResolvedRepository };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "factory-protected-diff-"));
  const repositoryPath = join(parent, "source");
  const workspace = join(parent, "builder");
  await mkdir(repositoryPath);
  git(repositoryPath, ["init", "-b", "main"]);
  git(repositoryPath, ["config", "user.email", "test@example.invalid"]);
  git(repositoryPath, ["config", "user.name", "Factory Test"]);
  await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
  await mkdir(join(repositoryPath, "config"), { recursive: true });
  await mkdir(join(repositoryPath, "private"), { recursive: true });
  await writeFile(join(repositoryPath, ".gitignore"), ".env*\n");
  await writeFile(join(repositoryPath, ".github", "workflows", "ci.yml"), "name: CI\n");
  await writeFile(join(repositoryPath, "config", "repos.yaml"), "repos: []\n");
  await writeFile(join(repositoryPath, "private", "key.txt"), "base\n");
  await writeFile(join(repositoryPath, "src.txt"), "base\n");
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "base"]);
  git(repositoryPath, ["worktree", "add", "-b", "ai/issue-1", workspace, "main"]);
  const repository: ResolvedRepository = {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: repositoryPath,
    use_worktree: true,
    base_branch: "main",
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true, ignore_paths: ["private/**"] },
    tracker: { provider: "local_md" },
    verification: { test: "test" },
  };
  return { parent, repositoryPath, workspace, repository };
}

async function expectProtected(current: Fixture): Promise<void> {
  await expect(
    assertProtectedDiff({ repository: current.repository, workspace: current.workspace, baseBranch: "main" }),
  ).rejects.toThrow(/Protected or ignored/);
}

it("blocks staged, unstaged, ignored untracked, renamed and privacy-ignored changes", async () => {
  const current = await fixture();
  try {
    await writeFile(join(current.workspace, ".github", "workflows", "ci.yml"), "name: changed\n");
    git(current.workspace, ["add", ".github/workflows/ci.yml"]);
    await expectProtected(current);
    git(current.workspace, ["reset", "--hard", "HEAD"]);

    await writeFile(join(current.workspace, "config", "repos.yaml"), "repos: [private]\n");
    await expectProtected(current);
    await writeFile(join(current.workspace, ".env.local"), "synthetic secret\n");
    await expectProtected(current);
    await rm(join(current.workspace, ".env.local"));

    await rm(join(current.workspace, "config", "repos.yaml"));
    await writeFile(join(current.workspace, "config", "repo-config.safe"), "repos: []\n");
    await expectProtected(current);
    await rm(join(current.workspace, "config", "repo-config.safe"));

    await writeFile(join(current.workspace, "private", "key.txt"), "changed\n");
    await expectProtected(current);
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

it("allows ordinary file changes and rejects symlinks that escape the worktree", async () => {
  const current = await fixture();
  const outside = join(current.parent, "outside.txt");
  try {
    await writeFile(join(current.workspace, "src.txt"), "ordinary change\n");
    await expect(
      assertProtectedDiff({ repository: current.repository, workspace: current.workspace, baseBranch: "main" }),
    ).resolves.toBeUndefined();
    await writeFile(outside, "keep\n");
    await symlink(outside, join(current.workspace, "escape"));
    await expect(
      assertProtectedDiff({ repository: current.repository, workspace: current.workspace, baseBranch: "main" }),
    ).rejects.toThrow(/escapes/);
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

it("accepts an immutable base commit and rejects missing or non-commit base objects", async () => {
  const current = await fixture();
  try {
    const baseCommit = git(current.repositoryPath, ["rev-parse", "refs/heads/main"]);
    await writeFile(join(current.workspace, "src.txt"), "ordinary change\n");
    await expect(
      assertProtectedDiff({ repository: current.repository, workspace: current.workspace, baseBranch: baseCommit }),
    ).resolves.toBeUndefined();

    await expect(
      assertProtectedDiff({
        repository: current.repository,
        workspace: current.workspace,
        baseBranch: "f".repeat(baseCommit.length),
      }),
    ).rejects.toThrow();
    const blob = git(current.repositoryPath, ["hash-object", "-w", "--stdin"]);
    await expect(
      assertProtectedDiff({ repository: current.repository, workspace: current.workspace, baseBranch: blob }),
    ).rejects.toThrow();
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

it("blocks fake secrets before starting verification", async () => {
  const current = await fixture();
  let calls = 0;
  const runner: CheckRunner = async () => {
    calls += 1;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputLimit: false };
  };
  try {
    await writeFile(join(current.workspace, ".env.synthetic"), "fake secret\n");
    const result = await createVerifier(runner)({
      repository: current.repository,
      workspace: current.workspace,
      baseBranch: "main",
    });
    expect(result).toMatchObject({ passed: false, failed_step: "protected_files" });
    expect(calls).toBe(0);
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

it("reruns the gate after checks and blocks protected files they create", async () => {
  const current = await fixture();
  const runner: CheckRunner = async (_step, _command, options) => {
    await mkdir(join(options.workspace, ".github", "workflows"), { recursive: true });
    await writeFile(join(options.workspace, ".github", "workflows", "created.yml"), "unsafe\n");
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputLimit: false };
  };
  try {
    const result = await createVerifier(runner)({
      repository: current.repository,
      workspace: current.workspace,
      baseBranch: "main",
    });
    expect(result).toMatchObject({ passed: false, failed_step: "protected_files" });
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

it("stores full failure output in a private external log and returns only a bounded summary", async () => {
  const current = await fixture();
  const logDirectory = join(current.parent, "verification-logs");
  const rawOutput = `\u001B[31mFAIL tests/example.test.ts\u001B[0m\n${"diagnostic detail\n".repeat(200)}`;
  const runner: CheckRunner = async () => ({
    exitCode: 1,
    stdout: rawOutput,
    stderr: "",
    timedOut: false,
    outputLimit: false,
  });
  try {
    const result = await createVerifier(runner)({
      repository: current.repository,
      workspace: current.workspace,
      baseBranch: "main",
      logDirectory,
    });
    const logName = (await readdir(logDirectory))[0];
    const logPath = join(logDirectory, logName ?? "missing");
    const log = await readFile(logPath, "utf8");
    const mode = (await stat(logPath)).mode & 0o777;

    expect(result.passed).toBe(false);
    expect(result.summary.length).toBeLessThanOrEqual(1800);
    expect(result.summary).not.toContain("\u001B");
    expect(log).toBe(`\n${rawOutput}`);
    expect(mode).toBe(0o600);
    expect(await realpath(logDirectory)).not.toBe(await realpath(current.workspace));
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});
