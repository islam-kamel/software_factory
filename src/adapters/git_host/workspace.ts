// ============================================================
// workspace.ts
// Purpose : Manage Git worktree creation, inspection and removal
// Feature : Isolated Builder workspaces
// Role    : Git Host Adapter
// API Doc : docs/implementation_plan.md, Git Worktree Workspace Manager
// ============================================================
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const OBJECT_ID_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

export type GitWorkspaceInfo = {
  repository: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  commonDirectory: string;
};

type WorktreeRecord = { path: string; branch?: string };

function git(args: string[], cwd: string, allowedExitCodes: number[] = []): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      ["-c", `core.hooksPath=${HOOKS_PATH}`, ...args],
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error?.code === "ENOENT" ? 127 : -1;
        if (error && !allowedExitCodes.includes(exitCode)) {
          reject(new Error("Git worktree operation failed"));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function parseWorktrees(output: string): WorktreeRecord[] {
  return output
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((record) => {
      const fields = new Map(
        record.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      const path = fields.get("worktree") ?? "";
      const branch = fields.get("branch");
      return branch ? { path, branch } : { path };
    });
}

async function gitDirectory(repository: string, argument: string): Promise<string> {
  const value = (await git(["rev-parse", argument], repository)).trim();
  return resolve(repository, value);
}

export async function inspectRepository(
  repository: string,
  baseBranch: string,
): Promise<{
  repository: string;
  baseBranch: string;
  baseCommit: string;
  commonDirectory: string;
}> {
  const root = (await git(["rev-parse", "--show-toplevel"], repository)).trim();
  if (resolve(root) !== resolve(repository)) throw new Error("Configured repository must be a Git worktree root");
  await git(["check-ref-format", `refs/heads/${baseBranch}`], repository);
  const baseCommit = (await git(["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`], repository)).trim();
  const commonDirectory = await gitDirectory(repository, "--git-common-dir");
  return { repository: root, baseBranch, baseCommit, commonDirectory };
}

export async function branchExists(repository: string, branch: string): Promise<boolean> {
  const output = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repository, [1]);
  return output.trim().length > 0;
}

function ignoredPathspecs(patterns: string[]): string[] {
  const pathspecs = new Set<string>();
  for (const pattern of patterns) {
    pathspecs.add(`:(glob)${pattern}`);
    if (!pattern.includes("/")) pathspecs.add(`:(glob)**/${pattern}`);
    if (pattern.endsWith("/**")) pathspecs.add(`:(glob)${pattern.slice(0, -3)}`);
  }
  return [...pathspecs];
}

function changedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function resolveBaseCommit(workspace: string, baseBranch: string): Promise<string> {
  const objectId = OBJECT_ID_PATTERN.test(baseBranch);
  const reference = objectId ? baseBranch : `refs/heads/${baseBranch}`;
  if (!objectId) await git(["check-ref-format", `refs/heads/${baseBranch}`], workspace);
  const commit = (await git(["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`], workspace)).trim();
  if (!OBJECT_ID_PATTERN.test(commit)) throw new Error("Git base reference did not resolve to a full commit ID");
  return commit;
}

export async function getChangedPaths(input: {
  workspace: string;
  baseBranch: string;
  ignorePaths?: string[];
}): Promise<string[]> {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], input.workspace)).trim();
  if (!branch.startsWith("ai/") || ["main", "master", "develop"].includes(branch)) {
    throw new Error("Protected file checks require an ai/ branch");
  }
  const baseCommit = await resolveBaseCommit(input.workspace, input.baseBranch);
  const committed = await git(["diff", "--name-only", "--no-renames", "-z", `${baseCommit}...HEAD`], input.workspace);
  const working = await git(["diff", "--name-only", "--no-renames", "-z", "HEAD"], input.workspace);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], input.workspace);
  const ignoredPatterns = [".env*", ".github/workflows/**", "config/repos.yaml", ...(input.ignorePaths ?? [])];
  const ignored = await git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...ignoredPathspecs(ignoredPatterns)],
    input.workspace,
  );
  return [
    ...new Set([
      ...changedPaths(committed),
      ...changedPaths(working),
      ...changedPaths(untracked),
      ...changedPaths(ignored),
    ]),
  ];
}

export async function createGitWorktree(input: GitWorkspaceInfo): Promise<void> {
  await git(["worktree", "add", "-b", input.branch, input.path, input.baseCommit], input.repository);
}

export async function inspectGitWorktree(input: GitWorkspaceInfo): Promise<boolean> {
  const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], input.repository));
  const actualPath = resolve(input.path);
  const record = worktrees.find((worktree) => resolve(worktree.path) === actualPath);
  if (!record || record.branch !== `refs/heads/${input.branch}`) return false;
  const commonDirectory = await gitDirectory(input.path, "--git-common-dir");
  return commonDirectory === input.commonDirectory;
}

export async function removeGitWorktree(input: GitWorkspaceInfo): Promise<void> {
  if (!(await inspectGitWorktree(input))) throw new Error("Managed Git worktree ownership could not be verified");
  await git(["worktree", "remove", "--force", input.path], input.repository);
  const branch = await git(["branch", "-D", input.branch], input.repository, [1]);
  if (!branch.length && (await branchExists(input.repository, input.branch))) {
    throw new Error("Managed Git branch could not be removed");
  }
}
