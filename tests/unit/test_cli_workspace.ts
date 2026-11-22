// ============================================================
// test_cli_workspace.ts
// Purpose : Verify safe Builder worktree checks and review diffs
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : src/adapters/cli_runner/workspace.ts
// ============================================================
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertBuilderWorkspace, getWorkspaceDiff } from "@/adapters/cli_runner/workspace";

function git(workspace: string, args: string[]): void {
  execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
}

it("accepts only an isolated ai worktree linked to its configured repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-workspace-"));
  const repository = join(parent, "repo");
  const workspace = join(parent, "repo-worktree");
  await mkdir(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  await writeFile(join(repository, "README.md"), "base\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  git(repository, ["worktree", "add", "-b", "ai/test", workspace]);

  try {
    await expect(assertBuilderWorkspace({ workspace, repository })).resolves.toBeUndefined();
    git(repository, ["switch", "-c", "ai/local"]);
    await expect(assertBuilderWorkspace({ workspace: repository, repository })).rejects.toThrow(/linked ai worktree/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("includes safe tracked and new files while filtering ignored files before reading", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-diff-"));
  await mkdir(join(workspace, "secrets"));
  git(workspace, ["init", "-b", "ai/test"]);
  git(workspace, ["config", "user.email", "test@example.invalid"]);
  git(workspace, ["config", "user.name", "Factory Test"]);
  await writeFile(join(workspace, "app.ts"), "const value = 1;\n");
  await writeFile(join(workspace, "secrets", "token.txt"), "SENSITIVE_BASE\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "base"]);
  await writeFile(join(workspace, "app.ts"), "const value = 2;\n");
  await writeFile(join(workspace, "secrets", "token.txt"), "SENSITIVE_CURRENT\n");
  await writeFile(join(workspace, "new.ts"), "export const added = true;\n");
  await writeFile(join(workspace, "secrets", "new-token.txt"), "SENSITIVE_NEW\n");

  try {
    const diff = await getWorkspaceDiff({ workspace, ignorePaths: ["secrets/**"] });
    expect(diff).toContain("app.ts");
    expect(diff).toContain("new.ts");
    expect(diff).not.toContain("SENSITIVE");
    expect(await readFile(join(workspace, "secrets", "token.txt"), "utf8")).toContain("SENSITIVE_CURRENT");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
