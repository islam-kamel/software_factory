// ============================================================
// workspace.ts
// Purpose : Validate Builder worktrees and collect privacy-filtered diffs
// Feature : Agent execution security
// Role    : Workspace Adapter
// API Doc : N/A
// ============================================================
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIgnoredPath } from "@/engine/context_builder";

const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 12 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function git(args: string[], cwd: string, allowDiffExit = false): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout) => {
        if (error && !(allowDiffExit && error.code === 1)) {
          reject(new Error("Unable to inspect Builder workspace"));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

async function gitPath(workspace: string, argument: string): Promise<string> {
  const value = (await git(["rev-parse", argument], workspace)).trim();
  return realpath(isAbsolute(value) ? value : resolve(workspace, value));
}

export async function assertBuilderWorkspace(options: { workspace: string; repository: string }): Promise<void> {
  const workspace = await realpath(options.workspace);
  const repository = await realpath(options.repository);
  await assertRepositoryWorkspace({ workspace, repository });
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).trim();
  if (!branch.startsWith("ai/") || ["main", "master", "develop"].includes(branch)) {
    throw new Error("Builder requires an ai/ branch");
  }
  const workspaceGitDir = await gitPath(workspace, "--git-dir");
  const workspaceCommonDir = await gitPath(workspace, "--git-common-dir");
  if (workspaceGitDir === workspaceCommonDir) {
    throw new Error("Builder requires a linked ai worktree of the configured repository");
  }
}

export async function assertRepositoryWorkspace(options: { workspace: string; repository: string }): Promise<void> {
  const workspace = await realpath(options.workspace);
  const repository = await realpath(options.repository);
  const root = await git(["rev-parse", "--show-toplevel"], workspace);
  if ((await realpath(root.trim())) !== workspace) throw new Error("Agent workspace must be a Git worktree root");
  const workspaceCommonDir = await gitPath(workspace, "--git-common-dir");
  const repositoryCommonDir = await gitPath(repository, "--git-common-dir");
  if (workspaceCommonDir !== repositoryCommonDir)
    throw new Error("Agent workspace must belong to the configured repository");
}

async function isSafePath(workspace: string, path: string, ignorePaths: string[]): Promise<boolean> {
  if (isIgnoredPath(path, ignorePaths)) return false;
  try {
    const absolute = resolve(workspace, path);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) return false;
    const actual = await realpath(absolute);
    return isInside(workspace, actual) && !isIgnoredPath(relative(workspace, actual), ignorePaths);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

function pathsFromGit(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function appendDiff(current: string, next: string): string {
  if (Buffer.byteLength(current) + Buffer.byteLength(next) > MAX_DIFF_BYTES) {
    throw new Error("Workspace diff exceeds the supported size");
  }
  return current + next;
}

async function trackedDiff(workspace: string, paths: string[], base: string): Promise<string> {
  let result = "";
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100).map((path) => `:(literal)${path}`);
    result = appendDiff(
      result,
      await git(["diff", "--no-ext-diff", "--binary", "--unified=3", base, "--", ...batch], workspace),
    );
  }
  return result;
}

async function untrackedDiff(workspace: string, paths: string[]): Promise<string> {
  let result = "";
  for (const path of paths) {
    const absolute = resolve(workspace, path);
    const details = await lstat(absolute);
    if (!details.isFile() || details.isSymbolicLink()) continue;
    const patch = await git(
      ["diff", "--no-index", "--no-ext-diff", "--binary", "--unified=3", "--", "/dev/null", absolute],
      workspace,
      true,
    );
    result = appendDiff(result, patch);
  }
  return result;
}

export async function getWorkspaceDiff(options: {
  workspace: string;
  ignorePaths: string[];
  baseBranch?: string;
}): Promise<string> {
  const workspace = await realpath(options.workspace);
  const tracked = pathsFromGit(await git(["ls-files", "-z"], workspace));
  const untracked = pathsFromGit(await git(["ls-files", "--others", "--exclude-standard", "-z"], workspace));
  const safeTracked: string[] = [];
  for (const path of tracked) {
    if (await isSafePath(workspace, path, options.ignorePaths)) safeTracked.push(path);
  }
  const safeUntracked: string[] = [];
  for (const path of untracked) {
    if (await isSafePath(workspace, path, options.ignorePaths)) safeUntracked.push(path);
  }
  return appendDiff(
    await trackedDiff(workspace, safeTracked, options.baseBranch ?? "HEAD"),
    await untrackedDiff(workspace, safeUntracked),
  );
}
