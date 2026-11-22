// ============================================================
// sandbox_git.ts
// Purpose : Stage a minimal read-only Git view for sandboxed workspaces
// Feature : Agent execution security
// Role    : Security Adapter
// API Doc : N/A
// ============================================================
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeMount } from "@/adapters/cli_runner/runtime_profile";

type GitLocations = { gitDirectory: string; commonDirectory: string; worktreeFile: string };
export type SandboxGit = { mounts: RuntimeMount[]; env: Record<string, string> };

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function regularFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Sandbox Git metadata must use regular files");
}

async function readMetadata(path: string): Promise<string> {
  await regularFile(path);
  return (await readFile(path, "utf8")).trim();
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Sandbox Git metadata must use directories");
  return canonical;
}

async function resolveCommonDirectory(gitDirectory: string): Promise<string> {
  const path = join(gitDirectory, "commondir");
  const contents = await readMetadata(path);
  if (!contents || contents.includes("\n")) throw new Error("Invalid Git commondir metadata");
  const commonDirectory = await canonicalDirectory(resolve(gitDirectory, contents));
  if (!isInside(commonDirectory, gitDirectory) && gitDirectory !== commonDirectory)
    throw new Error("Git worktree metadata escapes its common repository");
  return commonDirectory;
}

async function validateBackPointer(worktreeFile: string, gitDirectory: string, commonDirectory: string): Promise<void> {
  const worktrees = join(commonDirectory, "worktrees");
  const canonicalWorktrees = await canonicalDirectory(worktrees);
  if (canonicalWorktrees !== worktrees || dirname(gitDirectory) !== worktrees)
    throw new Error("Git worktree metadata escapes its common repository");
  const pointer = await readMetadata(join(gitDirectory, "gitdir"));
  if (!isAbsolute(pointer)) throw new Error("Invalid Git worktree back-pointer");
  const backPointer = await realpath(pointer);
  if (backPointer !== (await realpath(worktreeFile))) throw new Error("Git worktree back-pointer does not match");
}

async function locateGit(workspace: string): Promise<GitLocations> {
  const worktreeFile = join(workspace, ".git");
  const details = await lstat(worktreeFile);
  if (details.isSymbolicLink()) throw new Error("Sandbox Git metadata cannot be a symlink");
  if (details.isDirectory()) {
    const gitDirectory = await canonicalDirectory(worktreeFile);
    return { gitDirectory, commonDirectory: gitDirectory, worktreeFile };
  }
  if (!details.isFile()) throw new Error("Workspace does not contain supported Git metadata");
  const pointer = await readMetadata(worktreeFile);
  const match = /^gitdir: (.+)$/.exec(pointer);
  if (!match?.[1]) throw new Error("Invalid linked-worktree Git pointer");
  const gitDirectory = await canonicalDirectory(resolve(workspace, match[1]));
  const commonDirectory = await resolveCommonDirectory(gitDirectory);
  await validateBackPointer(worktreeFile, gitDirectory, commonDirectory);
  return { gitDirectory, commonDirectory, worktreeFile };
}

async function assertSafeTree(path: string): Promise<void> {
  const root = await lstat(path);
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new Error("Git object and ref trees must be real directories");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const details = await lstat(child);
    if (details.isSymbolicLink()) throw new Error("Git object and ref trees cannot contain symlinks");
    if (details.isDirectory()) await assertSafeTree(child);
    else if (!details.isFile()) throw new Error("Git object and ref trees must contain regular files");
  }
}

function validateIndexPaths(index: Buffer, workspace: string, entries: number): number {
  let offset = 12;
  for (let count = 0; count < entries; count += 1) {
    const entryStart = offset;
    if (offset + 62 > index.length - 20) throw new Error("Invalid Git index entry");
    const flags = index.readUInt16BE(offset + 60);
    offset += 62 + (flags & 0x4000 ? 2 : 0);
    const end = index.indexOf(0, offset);
    if (end < 0 || end >= index.length - 20) throw new Error("Invalid Git index path");
    const path = index.toString("utf8", offset, end);
    const invalidPart = path.split("/").some((part) => part === ".." || part === "." || part === "");
    if (path.startsWith("/") || invalidPart || !isInside(workspace, resolve(workspace, path)))
      throw new Error("Git index path escapes its workspace");
    offset = entryStart + Math.ceil((end + 1 - entryStart) / 8) * 8;
  }
  return offset;
}

function validateIndexExtensions(index: Buffer, start: number): void {
  let offset = start;
  while (offset < index.length - 20) {
    if (offset + 8 > index.length - 20) throw new Error("Invalid Git index extension");
    const signature = index.toString("ascii", offset, offset + 4);
    const size = index.readUInt32BE(offset + 4);
    if (signature === "link") throw new Error("Git split index is unsupported");
    if (offset + 8 + size > index.length - 20) throw new Error("Invalid Git index extension");
    offset += 8 + size;
  }
}

function validateIndex(index: Buffer, workspace: string): void {
  if (index.length < 32 || index.toString("ascii", 0, 4) !== "DIRC" || ![2, 3].includes(index.readUInt32BE(4)))
    throw new Error("Unsupported Git index format");
  const entries = index.readUInt32BE(8);
  validateIndexExtensions(index, validateIndexPaths(index, workspace, entries));
}

function isSafeHead(head: string): boolean {
  if (/^[a-f0-9]{40}$/.test(head)) return true;
  if (!head.startsWith("ref: refs/") || !/^ref: refs\/[A-Za-z0-9_./-]+$/.test(head)) return false;
  const path = head.slice("ref: ".length);
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function validateGitData(gitDirectory: string, commonDirectory: string, workspace: string): Promise<void> {
  const head = await readMetadata(join(gitDirectory, "HEAD"));
  if (!isSafeHead(head)) throw new Error("Unsupported Git HEAD format");
  const indexPath = join(gitDirectory, "index");
  await regularFile(indexPath);
  validateIndex(await readFile(indexPath), workspace);
  const worktreeEntries = await readdir(gitDirectory);
  if (worktreeEntries.some((entry) => entry.startsWith("sharedindex.")))
    throw new Error("Git split index is unsupported");
  const objects = join(commonDirectory, "objects");
  await assertSafeTree(objects);
  if (await stat(objects).then((details) => !details.isDirectory())) throw new Error("Git objects must be a directory");
  const alternates = join(objects, "info", "alternates");
  try {
    await lstat(alternates);
    throw new Error("Git object alternates are unsupported");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const refs = join(commonDirectory, "refs");
  await assertSafeTree(refs);
}

async function makeGitMounts(locations: GitLocations, commonDirectory: string): Promise<RuntimeMount[]> {
  const objects = join(locations.commonDirectory, "objects");
  const refs = join(locations.commonDirectory, "refs");
  const packedRefs = join(locations.commonDirectory, "packed-refs");
  const mounts: RuntimeMount[] = [
    { source: objects, target: join(commonDirectory, "objects"), isDirectory: true },
    { source: refs, target: join(commonDirectory, "refs"), isDirectory: true },
  ];
  try {
    await regularFile(packedRefs);
    mounts.push({ source: packedRefs, target: join(commonDirectory, "packed-refs"), isDirectory: false });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return mounts;
}

function gitEnvironment(gitDirectory: string, commonDirectory: string, workspace: string): Record<string, string> {
  return {
    GIT_DIR: gitDirectory,
    GIT_COMMON_DIR: commonDirectory,
    GIT_WORK_TREE: workspace,
    GIT_INDEX_FILE: join(gitDirectory, "index"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
}

async function createSnapshot(
  locations: GitLocations,
  workspace: string,
  scratchDirectory: string,
): Promise<SandboxGit> {
  const root = await mkdtemp(join(scratchDirectory, "sandbox-git-"));
  const gitDirectory = join(root, "worktree");
  const commonDirectory = join(root, "common");
  await mkdir(gitDirectory);
  await mkdir(commonDirectory);
  await mkdir(join(commonDirectory, "objects"));
  await mkdir(join(commonDirectory, "refs"));
  await copyFile(join(locations.gitDirectory, "HEAD"), join(gitDirectory, "HEAD"));
  await copyFile(join(locations.gitDirectory, "index"), join(gitDirectory, "index"));
  await writeFile(
    join(gitDirectory, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
  );
  return {
    mounts: await makeGitMounts(locations, commonDirectory),
    env: gitEnvironment(gitDirectory, commonDirectory, workspace),
  };
}

export async function prepareSandboxGit(options: {
  workspace: string;
  repository: string;
  scratchDirectory: string;
}): Promise<SandboxGit> {
  const workspace = await canonicalDirectory(options.workspace);
  const repository = await canonicalDirectory(options.repository);
  const scratchDirectory = await canonicalDirectory(options.scratchDirectory);
  if (isInside(workspace, scratchDirectory) || isInside(scratchDirectory, workspace))
    throw new Error("Git scratch and workspace paths must be separate");
  const locations = await locateGit(workspace);
  const repositoryLocations = await locateGit(repository);
  if (locations.commonDirectory !== repositoryLocations.commonDirectory)
    throw new Error("Workspace Git metadata does not match the configured repository");
  await validateGitData(locations.gitDirectory, locations.commonDirectory, workspace);
  return createSnapshot(locations, workspace, scratchDirectory);
}
