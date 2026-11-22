// ============================================================
// test_cli_sandbox_git_linux.ts
// Purpose : Verify curated Git metadata snapshots for sandboxed worktrees
// Feature : Agent execution security
// Role    : Unit Test
// API Doc : N/A
// ============================================================
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareSandboxGit } from "@/adapters/cli_runner/sandbox_git";
import { runSandboxed } from "@/adapters/cli_runner/sandbox";
import { loadSandboxRuntimeProfile } from "@/adapters/cli_runner/runtime_profile";

const roots: string[] = [];
const READ_FILE =
  "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(process.argv[1], 'utf8'));";

async function readSandboxPath(options: Parameters<typeof runSandboxed>[2], path: string) {
  return runSandboxed("node", ["-e", READ_FILE, path], options);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

async function repository(
  linked: boolean,
  protectedFiles = false,
): Promise<{
  workspace: string;
  repository: string;
  commonDirectory: string;
  scratchDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "factory-sandbox-git-"));
  roots.push(root);
  const main = resolve(root, "main");
  const workspace = resolve(root, linked ? "ai-task" : "main");
  const scratchDirectory = resolve(root, "scratch");
  await mkdir(main);
  await mkdir(scratchDirectory);
  await git(root, ["init", "-q", "-b", "main", main]);
  await git(main, ["config", "user.name", "Synthetic Test"]);
  await git(main, ["config", "user.email", "test@example.invalid"]);
  if (protectedFiles) {
    await mkdir(join(main, "private"));
    await writeFile(join(main, "private/sentinel.txt"), "synthetic ignored sentinel\n");
    await writeFile(join(main, "AGENTS.md"), "synthetic blocked historical instructions\n");
  }
  await writeFile(join(main, "tracked.txt"), "base\n");
  await git(main, ["add", "--all"]);
  await git(main, ["commit", "-q", "-m", "base"]);
  if (linked) await git(main, ["worktree", "add", "-q", "-b", "ai/task", workspace]);
  await writeFile(join(workspace, "tracked.txt"), "changed\n");
  return { workspace, repository: main, commonDirectory: join(main, ".git"), scratchDirectory };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("exposes copied worktree metadata and selected repository objects only", async () => {
  const fixture = await repository(true);
  const prepared = await prepareSandboxGit(fixture);
  const environment = { ...prepared.env, GIT_COMMON_DIR: fixture.commonDirectory };
  const status = await git(fixture.workspace, ["status", "--short"], environment);
  const diff = await git(fixture.workspace, ["diff", "--", "tracked.txt"], environment);
  const config = await readFile(resolve(prepared.env.GIT_DIR ?? "", "config"), "utf8");

  expect(status).toContain("tracked.txt");
  expect(diff).toContain("+changed");
  expect(config).not.toContain("hooksPath");
  const repeated = await prepareSandboxGit(fixture);
  expect(repeated.env.GIT_DIR).not.toBe(prepared.env.GIT_DIR);
  expect(prepared.mounts.map((mount) => mount.source)).toEqual([
    await realpath(join(fixture.commonDirectory, "objects")),
    await realpath(join(fixture.commonDirectory, "refs")),
  ]);
  expect(prepared.mounts.some((mount) => mount.source.endsWith("/worktrees"))).toBe(false);
});

it("supports direct repositories and rejects object alternates", async () => {
  const fixture = await repository(false);
  const prepared = await prepareSandboxGit(fixture);
  const environment = { ...prepared.env, GIT_COMMON_DIR: fixture.commonDirectory };
  expect(await git(fixture.workspace, ["status", "--short"], environment)).toContain("tracked.txt");

  const alternate = join(fixture.workspace, ".git/objects/info/alternates");
  await writeFile(alternate, "/outside/objects\n");
  await expect(prepareSandboxGit(fixture)).rejects.toThrow("alternates");
});

it("rejects a linked worktree pointer into another repository", async () => {
  const selected = await repository(true);
  const unrelated = await repository(true);
  const pointer = await readFile(join(unrelated.workspace, ".git"), "utf8");
  await writeFile(join(selected.workspace, ".git"), pointer);
  const gitDirectory = pointer.trim().replace("gitdir: ", "");
  await writeFile(join(gitDirectory, "gitdir"), join(selected.workspace, ".git"));

  await expect(prepareSandboxGit(selected)).rejects.toThrow("configured repository");
});

it("rejects split indexes before creating a sandbox snapshot", async () => {
  const fixture = await repository(false);
  await writeFile(join(fixture.workspace, ".git/sharedindex.synthetic"), "synthetic\n");
  await expect(prepareSandboxGit(fixture)).rejects.toThrow("split index");
});

it("rejects object-store symlinks and index paths outside the worktree", async () => {
  const fixture = await repository(false);
  const objectStore = join(fixture.workspace, ".git/objects");
  const outside = join(fixture.scratchDirectory, "outside-objects");
  await mkdir(outside);
  await rm(objectStore, { recursive: true });
  await symlink(outside, objectStore);
  await expect(prepareSandboxGit(fixture)).rejects.toThrow("real directories");

  await rm(objectStore);
  await mkdir(objectStore, { recursive: true });
  const indexPath = join(fixture.workspace, ".git/index");
  const index = await readFile(indexPath);
  const originalPath = Buffer.from("tracked.txt");
  const escapedPath = Buffer.from("../outside/");
  const indexEntry = index.indexOf(originalPath);
  expect(indexEntry).toBeGreaterThan(0);
  escapedPath.copy(index, indexEntry);
  await writeFile(indexPath, index);
  await expect(prepareSandboxGit(fixture)).rejects.toThrow("index path escapes");
});

it.skipIf(process.platform !== "linux")("runs linked-worktree status and diff in Bubblewrap", async () => {
  const fixture = await repository(true);
  const runtimeProfile = await loadSandboxRuntimeProfile(resolve(process.cwd(), "config/runtime-profile.example.yaml"));
  const options = {
    ...fixture,
    runtimeProfile,
    ignorePaths: [],
    access: "workspace_write" as const,
    timeoutMs: 10_000,
  };
  const status = await runSandboxed("git", ["status", "--short"], options);
  const diff = await runSandboxed("git", ["diff", "--", "tracked.txt"], options);

  expect(status).toMatchObject({ exitCode: 0 });
  expect(status.stdout).toContain("tracked.txt");
  expect(diff).toMatchObject({ exitCode: 0 });
  expect(diff.stdout).toContain("+changed");
});

it.skipIf(process.platform !== "linux")("denies history reads for ignored and blocked workspace files", async () => {
  const fixture = await repository(true, true);
  const runtimeProfile = await loadSandboxRuntimeProfile(resolve(process.cwd(), "config/runtime-profile.example.yaml"));
  const baseOptions = {
    ...fixture,
    runtimeProfile,
    access: "read_only" as const,
    timeoutMs: 10_000,
  };
  const ignoredHistory = await runSandboxed("git", ["show", "HEAD:private/sentinel.txt"], {
    ...baseOptions,
    ignorePaths: ["private/**"],
  });
  await rm(join(fixture.workspace, "AGENTS.md"));
  const blockedHistory = await runSandboxed("git", ["show", "HEAD:AGENTS.md"], {
    ...baseOptions,
    ignorePaths: [],
    blockedPaths: [join(fixture.workspace, "AGENTS.md")],
  });

  expect(ignoredHistory.exitCode).not.toBe(0);
  expect(`${ignoredHistory.stdout}${ignoredHistory.stderr}`).not.toContain("synthetic ignored sentinel");
  expect(blockedHistory.exitCode).not.toBe(0);
  expect(`${blockedHistory.stdout}${blockedHistory.stderr}`).not.toContain("synthetic blocked historical instructions");
});

it.skipIf(process.platform !== "linux")(
  "hides repository config, hooks, other worktrees, and unrelated repos",
  async () => {
    const fixture = await repository(true);
    const unrelated = await repository(false);
    const otherWorkspace = resolve(dirname(fixture.workspace), "other-task");
    await git(fixture.repository, ["config", "private.test", "synthetic private repository config"]);
    await mkdir(join(fixture.commonDirectory, "hooks"), { recursive: true });
    await writeFile(join(fixture.commonDirectory, "hooks/pre-commit"), "synthetic private hook body\n");
    await git(fixture.repository, ["worktree", "add", "-q", "-b", "ai/other", otherWorkspace]);
    const runtimeProfile = await loadSandboxRuntimeProfile(
      resolve(process.cwd(), "config/runtime-profile.example.yaml"),
    );
    const options = {
      ...fixture,
      runtimeProfile,
      ignorePaths: [],
      access: "read_only" as const,
      timeoutMs: 10_000,
    };
    const inaccessible = [
      join(fixture.commonDirectory, "config"),
      join(fixture.commonDirectory, "hooks/pre-commit"),
      join(otherWorkspace, ".git"),
      join(unrelated.repository, ".git/config"),
    ];

    for (const path of inaccessible) {
      const result = await readSandboxPath(options, path);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic private");
    }
  },
);
