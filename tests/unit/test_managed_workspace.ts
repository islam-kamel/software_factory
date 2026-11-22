// ============================================================
// test_managed_workspace.ts
// Purpose : Verify factory-owned Git worktree lifecycle boundaries
// Feature : Phase 2 workspace isolation
// Role    : Unit Tests
// API Doc : src/engine/workspace.ts
// ============================================================
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ResolvedRepository } from "@/engine/config_schemas";
import { createWorkspace, removeWorkspace, resolvePotentialPath } from "@/engine/workspace";

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function createRepository(parent: string): Promise<string> {
  const repository = join(parent, "repo");
  await mkdir(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  await writeFile(join(repository, "source.txt"), "base\n");
  git(repository, ["add", "source.txt"]);
  git(repository, ["commit", "-m", "base"]);
  return repository;
}

function repositoryConfig(localPath: string, overrides: Partial<ResolvedRepository> = {}): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: localPath,
    use_worktree: true,
    base_branch: "main",
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true },
    tracker: { provider: "local_md" },
    ...overrides,
  };
}

it("resolves a missing root path without creating it", async () => {
  const target = join("/", `factory-missing-${randomUUID()}`, "worktrees");
  expect(await resolvePotentialPath(target)).toBe(target);
  await expect(access(target)).rejects.toThrow();
});

it("creates an ai issue worktree and removes its dirty contents without changing the source checkout", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-managed-workspace-"));
  const repository = await createRepository(parent);
  const worktreeRoot = join(parent, "managed");
  const hookMarker = join(parent, "hook-ran");
  await writeFile(join(repository, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${hookMarker}'\n`);
  await chmod(join(repository, ".git", "hooks", "post-checkout"), 0o700);
  await writeFile(join(repository, "source.txt"), "owner change\n");
  const before = git(repository, ["status", "--porcelain"]);

  try {
    const workspace = await createWorkspace({ repository: repositoryConfig(repository), worktreeRoot, ticketId: "17" });
    expect(workspace.path).toBe(join(await realpath(worktreeRoot), "sample-issue-17"));
    expect(workspace.branch).toBe("ai/issue-17");
    expect(await readFile(join(workspace.path, "source.txt"), "utf8")).toBe("base\n");
    await expect(readFile(hookMarker, "utf8")).rejects.toThrow();
    await writeFile(join(workspace.path, "builder.txt"), "uncommitted\n");
    await removeWorkspace(workspace);

    expect(git(repository, ["status", "--porcelain"])).toBe(before);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe("owner change\n");
    expect(git(repository, ["branch", "--list", "ai/issue-17"])).toBe("");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects unsafe identifiers, invalid base refs, overlapping roots and existing paths or branches", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-managed-reject-"));
  const repository = await createRepository(parent);
  const root = join(parent, "managed");

  try {
    await expect(
      createWorkspace({ repository: repositoryConfig(repository), worktreeRoot: root, ticketId: "../17" }),
    ).rejects.toThrow(/identifiers/);
    await expect(
      createWorkspace({
        repository: repositoryConfig(repository, { base_branch: "../main" }),
        worktreeRoot: root,
        ticketId: "18",
      }),
    ).rejects.toThrow();
    await expect(
      createWorkspace({
        repository: repositoryConfig(repository),
        worktreeRoot: join(repository, "managed"),
        ticketId: "19",
      }),
    ).rejects.toThrow(/outside the repository/);

    await mkdir(root);
    await mkdir(join(root, "sample-issue-20"));
    await expect(
      createWorkspace({ repository: repositoryConfig(repository), worktreeRoot: root, ticketId: "20" }),
    ).rejects.toThrow(/path already exists/);
    git(repository, ["branch", "ai/issue-21"]);
    await expect(
      createWorkspace({ repository: repositoryConfig(repository), worktreeRoot: root, ticketId: "21" }),
    ).rejects.toThrow(/branch already exists/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects forged handles, tampered ownership and replaced symlink paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-managed-owner-"));
  const repository = await createRepository(parent);
  const worktreeRoot = join(parent, "managed");
  const outside = join(parent, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep\n");

  try {
    const workspace = await createWorkspace({ repository: repositoryConfig(repository), worktreeRoot, ticketId: "30" });
    await expect(removeWorkspace({ ...workspace, token: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(
      /ownership/,
    );
    await rm(workspace.path, { recursive: true, force: true });
    await symlink(outside, workspace.path);
    await expect(removeWorkspace(workspace)).rejects.toThrow(/replaced/);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");

    const tampered = await createWorkspace({ repository: repositoryConfig(repository), worktreeRoot, ticketId: "31" });
    await writeFile(tampered.metadataPath, "{}");
    await expect(removeWorkspace(tampered)).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects repositories disabled for worktrees", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-managed-disabled-"));
  const repository = await createRepository(parent);

  try {
    await expect(
      createWorkspace({
        repository: repositoryConfig(repository, { use_worktree: false }),
        worktreeRoot: join(parent, "managed"),
        ticketId: "40",
      }),
    ).rejects.toThrow(/not enabled/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
