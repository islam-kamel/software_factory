// ============================================================
// delivery_git.ts
// Purpose : Commit and push only a verified ai issue worktree snapshot
// Feature : Draft delivery
// Role    : Git Host Adapter
// API Doc : docs/implementation_plan.md, Draft PR Only
// ============================================================
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;
const BRANCH_PATTERN = /^ai\/issue-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COMMIT_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

type GitOptions = { timeoutMs?: number; allowedExitCodes?: number[] };

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "false",
  };
}

function git(args: string[], workspace: string, options: GitOptions = {}): Promise<string> {
  const hooks = process.platform === "win32" ? "NUL" : "/dev/null";
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.sshCommand=ssh",
        ...args,
      ],
      {
        cwd: workspace,
        env: cleanGitEnvironment(),
        encoding: "utf8",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error?.code === "ENOENT" ? 127 : -1;
        if (error && !options.allowedExitCodes?.includes(exitCode)) {
          reject(new Error("Git delivery operation failed"));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

async function assertWorktreeBranch(workspace: string, branch: string): Promise<void> {
  if (!BRANCH_PATTERN.test(branch)) throw new Error("Delivery requires an ai/issue-<id> branch");
  const workspacePath = await realpath(workspace);
  const root = (await git(["rev-parse", "--show-toplevel"], workspacePath)).trim();
  const currentBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).trim();
  const gitDirectory = resolve(workspacePath, (await git(["rev-parse", "--git-dir"], workspacePath)).trim());
  const commonDirectory = resolve(workspacePath, (await git(["rev-parse", "--git-common-dir"], workspacePath)).trim());
  if (resolve(root) !== workspacePath || currentBranch !== branch || gitDirectory === commonDirectory) {
    throw new Error("Delivery requires the matching linked ai issue worktree");
  }
}

async function assertNoConfiguredFilters(workspace: string): Promise<void> {
  const configuredFilters = await git(["config", "--get-regexp", "^filter\\."], workspace, { allowedExitCodes: [1] });
  if (configuredFilters.trim())
    throw new Error("Git filters are configured; delivery refused to avoid running repository filters");
}

async function changedFiles(workspace: string): Promise<string> {
  return git(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"], workspace);
}

export async function assertDeliverySnapshot(input: {
  workspace: string;
  branch: string;
  commit: string;
}): Promise<void> {
  if (!COMMIT_PATTERN.test(input.commit)) throw new Error("Delivery commit must be a full Git object ID");
  await assertWorktreeBranch(input.workspace, input.branch);
  const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"], input.workspace)).trim();
  if (head.toLowerCase() !== input.commit.toLowerCase())
    throw new Error("Delivery worktree HEAD does not match the verified commit");
  if ((await changedFiles(input.workspace)).length > 0) {
    throw new Error("Delivery worktree has staged, unstaged or untracked changes");
  }
}

export async function prepareCommit(input: { workspace: string; branch: string; message: string }): Promise<string> {
  await assertWorktreeBranch(input.workspace, input.branch);
  if (!input.message.trim() || input.message.length > 5000)
    throw new Error("Commit message must contain 1 to 5000 characters");
  await assertNoConfiguredFilters(input.workspace);
  if ((await changedFiles(input.workspace)).length === 0) throw new Error("Delivery worktree has no changes to commit");
  await git(["add", "-A", "--", "."], input.workspace);
  const staged = await git(["diff", "--cached", "--name-only", "-z"], input.workspace);
  if (!staged) throw new Error("Delivery worktree has no changes to commit");
  await git(["commit", "--no-verify", "--no-gpg-sign", "-m", input.message], input.workspace);
  const commit = (await git(["rev-parse", "--verify", "HEAD^{commit}"], input.workspace)).trim();
  await assertDeliverySnapshot({ ...input, commit });
  return commit;
}

async function pushRemote(workspace: string): Promise<string> {
  const output = await git(["remote", "get-url", "--push", "--all", "origin"], workspace);
  const remotes = output.split(/\r?\n/).filter(Boolean);
  if (remotes.length !== 1 || !isSafePushUrl(remotes[0] ?? ""))
    throw new Error("Origin must have one safe GitHub or local push URL");
  return remotes[0] ?? "";
}

function isSafePushUrl(remote: string): boolean {
  if (isAbsolute(remote)) return true;
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote)) return true;
  try {
    const url = new URL(remote);
    return url.protocol === "file:" ? isAbsolute(fileURLToPath(url)) : isSafeGitHubUrl(url);
  } catch {
    return false;
  }
}

function isSafeGitHubUrl(url: URL): boolean {
  if (url.hostname !== "github.com" || url.password || url.search || url.hash) return false;
  return (url.protocol === "https:" && !url.username) || (url.protocol === "ssh:" && url.username === "git");
}

export async function pushBranch(input: { workspace: string; branch: string; commit: string }): Promise<void> {
  await assertDeliverySnapshot(input);
  const remote = await pushRemote(input.workspace);
  await git(
    ["push", "--no-verify", "--porcelain", remote, `${input.commit}:refs/heads/${input.branch}`],
    input.workspace,
    { timeoutMs: PUSH_TIMEOUT_MS },
  );
}
