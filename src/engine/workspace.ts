// ============================================================
// workspace.ts
// Purpose : Create and remove factory-owned Builder worktrees
// Feature : Phase 2 workspace isolation
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Git Worktree Workspace Manager
// ============================================================
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ResolvedRepository } from "@/engine/config_schemas";
import {
  branchExists,
  createGitWorktree,
  inspectGitWorktree,
  inspectRepository,
  removeGitWorktree,
  type GitWorkspaceInfo,
} from "@/adapters/git_host/workspace";

export type ManagedWorkspace = GitWorkspaceInfo & { token: string; root: string; metadataPath: string };

type OwnershipRecord = Omit<ManagedWorkspace, "token"> & { version: 1; token: string };

const PATH_CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

const OwnershipRecordSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    repository: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f\d]{40,64}$/i),
    commonDirectory: z.string().min(1),
    root: z.string().min(1),
    metadataPath: z.string().min(1),
  })
  .strict();

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function overlaps(first: string, second: string): boolean {
  const child = relative(first, second);
  const parent = relative(second, first);
  return (
    child === "" ||
    parent === "" ||
    (!child.startsWith(`..${sep}`) && child !== "..") ||
    (!parent.startsWith(`..${sep}`) && parent !== "..")
  );
}

export async function resolvePotentialPath(path: string): Promise<string> {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

function workspaceInfo(record: OwnershipRecord): GitWorkspaceInfo {
  return {
    repository: record.repository,
    path: record.path,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommit: record.baseCommit,
    commonDirectory: record.commonDirectory,
  };
}

async function writeOwnership(path: string, record: OwnershipRecord): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readOwnership(path: string): Promise<OwnershipRecord> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Managed workspace ownership record is invalid");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return OwnershipRecordSchema.parse(value);
}

type WorkspacePaths = {
  base: Omit<GitWorkspaceInfo, "path" | "branch">;
  root: string;
  path: string;
  branch: string;
  metadataPath: string;
};

async function assertAvailablePath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Managed workspace path already exists");
}

async function prepareMetadataDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (details.isSymbolicLink() || details.mode & 0o077 || (await realpath(path)) !== path) {
    throw new Error("Managed workspace metadata path is invalid");
  }
}

async function prepareWorkspacePaths(options: {
  repository: ResolvedRepository;
  worktreeRoot: string;
  ticketId: string;
}): Promise<WorkspacePaths> {
  const repositoryPath = await realpath(options.repository.local_path);
  const baseBranch = options.repository.base_branch ?? "main";
  const base = await inspectRepository(repositoryPath, baseBranch);
  const potentialRoot = await resolvePotentialPath(options.worktreeRoot);
  if (PATH_CONTROL.test(repositoryPath + potentialRoot)) {
    throw new Error("Repository and worktree paths cannot contain control characters");
  }
  await assertOutsideRepository(repositoryPath, potentialRoot);
  await mkdir(potentialRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(potentialRoot);
  await assertOutsideRepository(repositoryPath, root);

  const branch = `ai/issue-${options.ticketId}`;
  const path = join(root, `${options.repository.id}-issue-${options.ticketId}`);
  const metadataDirectory = join(root, ".software-factory-managed");
  const metadataPath = join(metadataDirectory, `${options.repository.id}-issue-${options.ticketId}.json`);
  await assertAvailablePath(path);
  if (await branchExists(repositoryPath, branch)) throw new Error("Managed branch already exists");
  await prepareMetadataDirectory(metadataDirectory);
  return { base, root, path, branch, metadataPath };
}

async function assertOutsideRepository(repository: string, worktreeRoot: string): Promise<void> {
  if (overlaps(repository, worktreeRoot)) throw new Error("Managed worktree root must be outside the repository");
}

export async function createWorkspace(options: {
  repository: ResolvedRepository;
  worktreeRoot: string;
  ticketId: string;
}): Promise<ManagedWorkspace> {
  if (!options.repository.enabled || !options.repository.use_worktree) {
    throw new Error("Repository is not enabled for managed worktrees");
  }
  if (!safeSegment(options.repository.id) || !safeSegment(options.ticketId)) {
    throw new Error("Repository and ticket identifiers must be safe path segments");
  }

  const paths = await prepareWorkspacePaths(options);
  const token = randomUUID();
  const record: OwnershipRecord = {
    ...paths.base,
    path: paths.path,
    branch: paths.branch,
    root: paths.root,
    metadataPath: paths.metadataPath,
    token,
    version: 1,
  };
  await writeOwnership(paths.metadataPath, record);
  try {
    await createGitWorktree(workspaceInfo(record));
  } catch (error) {
    if (!(await inspectGitWorktree(workspaceInfo(record)))) {
      await unlink(paths.metadataPath);
    }
    throw error;
  }
  return { ...workspaceInfo(record), token, root: paths.root, metadataPath: paths.metadataPath };
}

function matchesOwnership(record: OwnershipRecord, expected: OwnershipRecord): boolean {
  const fields: Array<keyof OwnershipRecord> = [
    "token",
    "path",
    "root",
    "repository",
    "branch",
    "baseBranch",
    "baseCommit",
    "commonDirectory",
    "metadataPath",
  ];
  for (const field of fields) {
    if (record[field] !== expected[field]) return false;
  }
  return true;
}

async function verifyWorkspaceOwnership(
  workspace: ManagedWorkspace,
): Promise<{ path: string; metadataPath: string; repository: string }> {
  const root = await realpath(workspace.root);
  const path = resolve(workspace.path);
  const metadataPath = resolve(workspace.metadataPath);
  if (
    root !== workspace.root ||
    dirname(path) !== root ||
    dirname(metadataPath) !== join(root, ".software-factory-managed")
  ) {
    throw new Error("Managed workspace paths are invalid");
  }
  if ((await realpath(dirname(metadataPath))) !== dirname(metadataPath)) {
    throw new Error("Managed workspace metadata path was replaced");
  }
  const record = await readOwnership(metadataPath);
  const expected: OwnershipRecord = { ...workspace, root, path, metadataPath, version: 1 };
  if (!matchesOwnership(record, expected)) {
    throw new Error("Managed workspace ownership could not be verified");
  }
  return { path, metadataPath, repository: await realpath(workspace.repository) };
}

export async function removeWorkspace(workspace: ManagedWorkspace): Promise<void> {
  const owned = await verifyWorkspaceOwnership(workspace);
  const worktree = await lstat(owned.path);
  if (worktree.isSymbolicLink() || (await realpath(owned.path)) !== owned.path) {
    throw new Error("Managed workspace path was replaced");
  }
  const gitWorkspace = { ...workspace, repository: owned.repository, path: owned.path };
  if (!(await inspectGitWorktree(gitWorkspace))) {
    throw new Error("Managed Git worktree ownership could not be verified");
  }
  await removeGitWorktree(gitWorkspace);
  await unlink(owned.metadataPath);
}
