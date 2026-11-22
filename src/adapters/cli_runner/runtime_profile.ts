// ============================================================
// runtime_profile.ts
// Purpose : Validate the operator-owned files and commands visible to sandboxed processes
// Feature : Agent execution security
// Role    : Runtime Configuration
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, posix, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const RuntimeProfileSchema = z
  .object({
    version: z.literal(1),
    mounts: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) }).strict()).min(1),
    commands: z.record(z.string().min(1), z.string().min(1)).refine((commands) => Object.keys(commands).length > 0),
  })
  .strict();

const forbiddenDirectorySources = new Set([
  "/",
  "/bin",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/usr/bin",
  "/usr/local",
  "/usr/local/share",
  "/var",
]);

export type RuntimeMount = { source: string; target: string; isDirectory: boolean };
export type SandboxRuntimeProfile = {
  mounts: RuntimeMount[];
  commands: Record<string, string>;
  path: string;
};

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

function parseProfile(source: string): unknown {
  const document = parseDocument(source, { strict: true, stringKeys: true, uniqueKeys: true, version: "1.2" });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("Invalid runtime profile YAML");
  return document.toJS();
}

function validateTarget(target: string): void {
  if (!posix.isAbsolute(target) || posix.normalize(target) !== target || target === "/")
    throw new Error("Runtime mount targets must be normalized absolute paths");
  if (["/dev", "/home", "/proc", "/tmp", "/workspace"].includes(target))
    throw new Error("Runtime mount target is reserved by the sandbox");
  if (target.split("/").includes(".git")) throw new Error("Runtime mounts cannot expose Git metadata");
}

function isSelectedPackageDirectory(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const packageIndex = parts.lastIndexOf("node_modules");
  return (packageIndex >= 0 && packageIndex < parts.length - 1) || (parts[0] === "opt" && parts.length === 2);
}

async function validateMount(mount: { source: string; target: string }): Promise<RuntimeMount> {
  if (!isAbsolute(mount.source) || normalize(mount.source) !== mount.source)
    throw new Error("Runtime mount sources must be normalized absolute paths");
  validateTarget(mount.target);
  const details = await lstat(mount.source);
  const source = await realpath(mount.source);
  if (source.split(sep).includes(".git")) throw new Error("Runtime mounts cannot expose Git metadata");
  const sourceDetails = await stat(source);
  assertRuntimeSource({
    source,
    requestedSource: mount.source,
    isSymbolicLink: details.isSymbolicLink(),
    isFile: sourceDetails.isFile(),
    isDirectory: sourceDetails.isDirectory(),
  });
  return { source, target: mount.target, isDirectory: sourceDetails.isDirectory() };
}

function assertRuntimeSource(options: {
  source: string;
  requestedSource: string;
  isSymbolicLink: boolean;
  isFile: boolean;
  isDirectory: boolean;
}): void {
  if (!options.isFile && !options.isDirectory) throw new Error("Runtime source must be a file or package directory");
  if (
    options.isDirectory &&
    (options.isSymbolicLink ||
      options.source !== options.requestedSource ||
      forbiddenDirectorySources.has(options.source) ||
      !isSelectedPackageDirectory(options.source))
  )
    throw new Error("Runtime directories may include only selected code package roots");
}

function validateCommands(commands: Record<string, string>, mounts: RuntimeMount[]): void {
  const fileTargets = new Set(mounts.filter((mount) => !mount.isDirectory).map((mount) => mount.target));
  for (const [command, target] of Object.entries(commands)) {
    if (!/^(?:[A-Za-z0-9_.-]+|\/[A-Za-z0-9_./-]+)$/.test(command) || !fileTargets.has(target))
      throw new Error("Runtime command must refer to an explicitly mounted file");
  }
}

export async function loadSandboxRuntimeProfile(profilePath: string): Promise<SandboxRuntimeProfile> {
  const requestedPath = resolve(profilePath);
  const details = await lstat(requestedPath).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink())
    throw new Error("Runtime profile must be a regular operator-owned config file");
  const normalizedPath = await realpath(requestedPath);
  let raw: unknown;
  try {
    raw = parseProfile(await readFile(normalizedPath, "utf8"));
  } catch {
    throw new Error("Unable to read a valid config/runtime-profile.yaml");
  }
  const parsed = RuntimeProfileSchema.parse(raw);
  const mounts = await Promise.all(parsed.mounts.map(validateMount));
  const targets = mounts.map((mount) => mount.target);
  if (new Set(targets).size !== targets.length) throw new Error("Runtime profile repeats a mount target");
  validateCommands(parsed.commands, mounts);
  return { mounts, commands: parsed.commands, path: normalizedPath };
}

export function resolveRuntimeCommand(profile: SandboxRuntimeProfile, command: string): string {
  const resolved = profile.commands[command];
  if (!resolved) throw new Error(`Runtime profile does not allow command: ${command}`);
  return resolved;
}

export function assertRuntimeMountsOutside(options: {
  profile: SandboxRuntimeProfile;
  workspace: string;
  scratchDirectory: string;
}): void {
  assertPathsOutside(options.profile.path, [options.workspace, options.scratchDirectory], "Runtime profile");
  for (const mount of options.profile.mounts) {
    assertPathsOutside(mount.source, [options.workspace, options.scratchDirectory], "Runtime files");
    assertPathsOutside(mount.target, [options.workspace, options.scratchDirectory], "Runtime mount targets");
  }
}

function assertPathsOutside(path: string, roots: string[], label: string): void {
  if (roots.some((root) => overlaps(root, path))) {
    throw new Error(`${label} cannot overlap workspace or scratch paths`);
  }
}
