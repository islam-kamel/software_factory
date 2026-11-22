// ============================================================
// sandbox.ts
// Purpose : Run agent CLIs inside host-native filesystem sandboxes
// Feature : Agent execution security
// Role    : Security Adapter
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { EGRESS_BRIDGE_SCRIPT } from "@/adapters/llm/egress_proxy";
import { isIgnoredPath } from "@/engine/context_builder";
import {
  assertRuntimeMountsOutside,
  resolveRuntimeCommand,
  type SandboxRuntimeProfile,
} from "@/adapters/cli_runner/runtime_profile";
import { prepareSandboxGit } from "@/adapters/cli_runner/sandbox_git";
import {
  createSystemdScopeArgs,
  stopSystemdScope,
  systemdControlEnvironment,
  SYSTEMD_RUN_EXECUTABLE,
} from "@/adapters/cli_runner/resource_scope";
import type { ResourceLimits } from "@/engine/config_schemas";

export type SandboxOptions = {
  workspace: string;
  ignorePaths: string[];
  access: "read_only" | "workspace_write";
  timeoutMs: number;
  scratchDirectory: string;
  runtimeProfile: SandboxRuntimeProfile;
  offline?: boolean;
  resourceLimits?: ResourceLimits;
  egressSocket?: string;
  repository?: string;
  blockedPaths?: string[];
  env?: NodeJS.ProcessEnv;
};

export type SandboxResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimit: boolean;
};

export type HiddenPath = { path: string; isDirectory: boolean };

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BWRAP_EXECUTABLE = "/usr/bin/bwrap";

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function ignoredEntries(workspace: string, patterns: string[]): Promise<string[]> {
  const ignored = new Set<string>();
  const pending = [workspace];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      let target = path;
      try {
        target = await realpath(path);
      } catch {
        // Keep the lexical path so a broken symlink cannot reopen its ignored entry.
      }
      const names = [relative(workspace, path), ...(isInside(workspace, target) ? [relative(workspace, target)] : [])];
      if (names.some((name) => isIgnoredPath(name, patterns))) {
        ignored.add(path);
        ignored.add(target);
        continue;
      }
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return [...ignored];
}

async function hiddenPaths(options: SandboxOptions, workspace: string): Promise<HiddenPath[]> {
  const candidates = new Set([
    ...(await ignoredEntries(workspace, options.ignorePaths)),
    ...(options.blockedPaths ?? []),
  ]);
  const result: HiddenPath[] = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) throw new Error("Invalid sandbox path");
    try {
      const path = await realpath(candidate);
      result.push({ path, isDirectory: (await stat(path)).isDirectory() });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const gitMetadata = await workspaceGitMetadata(workspace);
  if (gitMetadata) result.push(gitMetadata);
  return pruneHiddenDescendants(result);
}

function pruneHiddenDescendants(paths: HiddenPath[]): HiddenPath[] {
  const directories = paths.filter((entry) => entry.isDirectory);
  return paths.filter(
    (entry) => !directories.some((directory) => directory.path !== entry.path && isInside(directory.path, entry.path)),
  );
}

async function workspaceGitMetadata(workspace: string): Promise<HiddenPath | undefined> {
  const gitPath = resolve(workspace, ".git");
  try {
    const details = await lstat(gitPath);
    if (details.isSymbolicLink()) throw new Error("Workspace Git metadata cannot be a symlink");
    return { path: gitPath, isDirectory: details.isDirectory() };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return undefined;
}

type BwrapRequest = {
  command: string;
  args: string[];
  options: SandboxOptions;
  workspace: string;
  hidden: HiddenPath[];
  runtimeProfile: SandboxRuntimeProfile;
  gitMounts?: Array<{ source: string; target: string }>;
};

export function createBwrapArgs(request: BwrapRequest): string[] {
  const { command, args, options, workspace, hidden, runtimeProfile, gitMounts = [] } = request;
  const resolvedCommand = resolveRuntimeCommand(runtimeProfile, command);
  const runtimeCommand = options.egressSocket ? resolveRuntimeCommand(runtimeProfile, "node") : undefined;
  const result = createBwrapBaseArgs(options);
  addRuntimeMounts(result, runtimeProfile.mounts);
  addRuntimeMounts(result, gitMounts);
  result.push("--ro-bind", workspace, workspace);
  if (options.access === "workspace_write") result.push("--bind", workspace, workspace);
  addHiddenPaths(result, hidden);
  addSandboxCommand(result, { runtimeCommand, resolvedCommand, args });
  return result;
}

function createBwrapBaseArgs(options: SandboxOptions): string[] {
  const scratch = options.scratchDirectory;
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.offline ? ["--unshare-net"] : []),
    ...(options.egressSocket ? ["--dir", "/run", "--dir", "/run/factory"] : []),
    ...(options.egressSocket ? ["--ro-bind", options.egressSocket, "/run/factory/egress.sock"] : []),
    "--unsetenv",
    "XDG_RUNTIME_DIR",
    "--unsetenv",
    "DBUS_SESSION_BUS_ADDRESS",
    "--unsetenv",
    "SYSTEMD_BUS_ADDRESS",
    "--cap-drop",
    "ALL",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/home/factory",
    "--bind",
    scratch,
    scratch,
  ];
}

function addRuntimeMounts(result: string[], mounts: Array<{ source: string; target: string }>): void {
  for (const mount of mounts) result.push("--ro-bind", mount.source, mount.target);
}

function addHiddenPaths(result: string[], hidden: HiddenPath[]): void {
  for (const entry of hidden) {
    if (entry.isDirectory) result.push("--tmpfs", entry.path, "--remount-ro", entry.path);
    else result.push("--ro-bind", "/dev/null", entry.path);
  }
}

function addSandboxCommand(
  result: string[],
  input: { runtimeCommand: string | undefined; resolvedCommand: string; args: string[] },
): void {
  const { runtimeCommand, resolvedCommand, args } = input;
  if (runtimeCommand) {
    result.push(
      "--",
      runtimeCommand,
      "--input-type=commonjs",
      "--eval",
      EGRESS_BRIDGE_SCRIPT,
      "--",
      resolvedCommand,
      ...args,
    );
    return;
  }
  result.push("--", resolvedCommand, ...args);
}

function appendOutput(current: string, chunk: Buffer): { value: string; overflow: boolean } {
  const next = current + chunk.toString("utf8");
  const overflow = Buffer.byteLength(next) > MAX_OUTPUT_BYTES;
  return { value: overflow ? next.slice(0, MAX_OUTPUT_BYTES) : next, overflow };
}

const forwardedEnvironment = new Set([
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
]);

function safeEnvironment(options: SandboxOptions): NodeJS.ProcessEnv {
  const path = [...new Set(Object.values(options.runtimeProfile.commands).map((target) => dirname(target)))].join(":");
  const environment: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: "/home/factory",
    LANG: "C",
    TMPDIR: options.scratchDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (options.egressSocket && /(?:API_KEY|TOKEN|SECRET)/i.test(key)) continue;
    if (forwardedEnvironment.has(key) && value !== undefined) environment[key] = value;
  }
  return environment;
}

async function gitSnapshot(options: SandboxOptions, workspace: string, scratch: string) {
  if (!options.repository) return undefined;
  return prepareSandboxGit({ workspace, repository: options.repository, scratchDirectory: scratch });
}

async function hasWorkspacePrivacyBoundary(options: SandboxOptions, workspace: string): Promise<boolean> {
  if (options.ignorePaths.length > 0) return true;
  for (const blockedPath of options.blockedPaths ?? []) {
    if (!isAbsolute(blockedPath)) throw new Error("Invalid sandbox path");
    if (isInside(workspace, resolve(blockedPath))) return true;
    if (isInside(workspace, await canonicalPotentialPath(blockedPath))) return true;
  }
  return false;
}

async function canonicalPotentialPath(path: string): Promise<string> {
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

function assertSandboxTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid agent timeout");
}

function assertScratchBoundary(workspace: string, scratch: string): void {
  if (isInside(workspace, scratch) || isInside(scratch, workspace))
    throw new Error("Agent scratch directory must be outside the workspace");
  if (!isInside("/tmp", scratch)) throw new Error("Agent scratch must be under /tmp for isolated execution");
}

async function assertEgressSocket(options: SandboxOptions, workspace: string, scratch: string): Promise<void> {
  if (!options.egressSocket) return;
  const socket = options.egressSocket;
  if (!isAbsolute(socket) || socket.length > 100 || isInside(workspace, socket) || isInside(scratch, socket)) {
    throw new Error("Invalid egress proxy socket path");
  }
  const parent = await realpath(dirname(socket));
  if (resolve(parent, basename(socket)) !== socket) throw new Error("Egress proxy socket path cannot use symlinks");
  const info = await lstat(socket);
  if (info.isSymbolicLink() || !info.isSocket()) throw new Error("Egress proxy path must be a Unix socket");
  if (!options.offline) throw new Error("Egress proxy sandboxes must disable network access");
}

type ProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  controlEnv?: NodeJS.ProcessEnv;
  scopeName?: string;
  timeoutMs: number;
};

type SandboxContext = {
  workspace: string;
  options: SandboxOptions;
  hidden: HiddenPath[];
  gitData?: Awaited<ReturnType<typeof gitSnapshot>>;
};

type ProcessState = SandboxResult & { settled: boolean };

function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function captureOutput(
  options: {
    state: ProcessState;
    child: ReturnType<typeof spawn>;
    stream: "stdout" | "stderr";
    scopeName?: string;
    controlEnv?: NodeJS.ProcessEnv;
    stopScope: () => void;
  },
  chunk: Buffer,
): void {
  const appended = appendOutput(options.state[options.stream], chunk);
  options.state[options.stream] = appended.value;
  options.state.outputLimit ||= appended.overflow;
  if (appended.overflow) {
    options.stopScope();
    killGroup(options.child, "SIGKILL");
  }
}

function createScopeStopper(options: ProcessOptions): {
  stop: () => void;
  wait: () => Promise<void>;
  error: () => Error | undefined;
} {
  const { scopeName, controlEnv } = options;
  if (!scopeName || !controlEnv) {
    return { stop: () => undefined, wait: async () => undefined, error: () => undefined };
  }
  let cleanupPromise: Promise<void> | undefined;
  let cleanupError: Error | undefined;
  const stop = (): void => {
    cleanupPromise ??= stopSystemdScope(scopeName, controlEnv).catch((error: unknown) => {
      cleanupError = error instanceof Error ? error : new Error("Unable to confirm sandbox resource scope cleanup");
    });
  };
  return { stop, wait: async () => cleanupPromise, error: () => cleanupError };
}

async function finishProcess(
  code: number | null,
  input: {
    state: ProcessState;
    timers: Array<NodeJS.Timeout | undefined>;
    stopper: ReturnType<typeof createScopeStopper>;
  },
): Promise<SandboxResult> {
  const { state, timers, stopper } = input;
  if (state.settled) throw new Error("Sandbox process settled more than once");
  state.settled = true;
  for (const timer of timers) if (timer) clearTimeout(timer);
  stopper.stop();
  await stopper.wait();
  const error = stopper.error();
  if (error) throw error;
  return {
    exitCode: code,
    stdout: state.stdout,
    stderr: state.stderr,
    timedOut: state.timedOut,
    outputLimit: state.outputLimit,
  };
}

function runProcess(options: ProcessOptions): Promise<SandboxResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const state: ProcessState = {
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputLimit: false,
    settled: false,
  };
  const stopper = createScopeStopper(options);
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  return new Promise((resolveResult, rejectResult) => {
    const finish = (code: number | null): void => {
      if (state.settled) return;
      void finishProcess(code, { state, timers: [timer, killTimer], stopper }).then(resolveResult, rejectResult);
    };
    child.stdout.on("data", (chunk: Buffer) =>
      captureOutput({ state, child, stream: "stdout", ...options, stopScope: stopper.stop }, chunk),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      captureOutput({ state, child, stream: "stderr", ...options, stopScope: stopper.stop }, chunk),
    );
    child.once("error", () => {
      if (state.settled) return;
      state.settled = true;
      for (const activeTimer of [timer, killTimer]) if (activeTimer) clearTimeout(activeTimer);
      stopper.stop();
      void stopper
        .wait()
        .then(() => rejectResult(stopper.error() ?? new Error("Unable to start the required host sandbox")));
    });
    child.once("close", finish);
    timer = setTimeout(() => {
      state.timedOut = true;
      stopper.stop();
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 250);
    }, options.timeoutMs);
  });
}

export async function runSandboxed(command: string, args: string[], options: SandboxOptions): Promise<SandboxResult> {
  const context = await prepareSandboxContext(options);
  const sandboxArgs = createBwrapArgs({
    command,
    args,
    options: context.options,
    workspace: context.workspace,
    hidden: context.hidden,
    runtimeProfile: context.options.runtimeProfile,
    ...(context.gitData ? { gitMounts: context.gitData.mounts } : {}),
  });
  return runProcess(createSandboxProcessOptions({ options, context, sandboxArgs }));
}

async function prepareSandboxContext(options: SandboxOptions): Promise<SandboxContext> {
  if (process.platform !== "linux")
    throw new Error("Agent filesystem sandbox requires Linux with bubblewrap installed");
  assertSandboxTimeout(options.timeoutMs);
  const workspace = await realpath(options.workspace);
  const scratch = await realpath(options.scratchDirectory);
  assertScratchBoundary(workspace, scratch);
  await assertEgressSocket(options, workspace, scratch);
  assertRuntimeMountsOutside({ profile: options.runtimeProfile, workspace, scratchDirectory: scratch });
  const readyOptions = { ...options, scratchDirectory: scratch };
  const hidden = await hiddenPaths(readyOptions, workspace);
  const hasPrivacyBoundary = await hasWorkspacePrivacyBoundary(options, workspace);
  const gitData = hasPrivacyBoundary ? undefined : await gitSnapshot(options, workspace, scratch);
  return { workspace, options: readyOptions, hidden, ...(gitData ? { gitData } : {}) };
}

function createSandboxProcessOptions(input: {
  options: SandboxOptions;
  context: SandboxContext;
  sandboxArgs: string[];
}): ProcessOptions {
  const { options, context, sandboxArgs } = input;
  const scope = options.resourceLimits ? createResourceScope(options, sandboxArgs) : undefined;
  return {
    command: scope ? SYSTEMD_RUN_EXECUTABLE : BWRAP_EXECUTABLE,
    args: scope?.args ?? sandboxArgs,
    cwd: context.workspace,
    env: createSandboxEnvironment(context, scope?.controlEnv),
    ...(scope ? { controlEnv: scope.controlEnv, scopeName: scope.name } : {}),
    timeoutMs: options.timeoutMs,
  };
}

function createResourceScope(
  options: SandboxOptions,
  sandboxArgs: string[],
): { name: string; controlEnv: NodeJS.ProcessEnv; args: string[] } {
  const resourceLimits = options.resourceLimits;
  if (!resourceLimits) throw new Error("Sandbox resource limits are required to create a systemd scope");
  const name = `factory-${randomUUID()}.scope`;
  const controlEnv = systemdControlEnvironment();
  return {
    name,
    controlEnv,
    args: createSystemdScopeArgs({
      unitName: name,
      resourceLimits,
      timeoutMs: options.timeoutMs,
      command: BWRAP_EXECUTABLE,
      args: sandboxArgs,
    }),
  };
}

function createSandboxEnvironment(context: SandboxContext, controlEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sandboxEnv = safeEnvironment(context.options);
  const gitEnv = context.gitData?.env ?? {};
  if (!controlEnv) return { ...sandboxEnv, ...gitEnv };
  return {
    ...controlEnv,
    ...sandboxEnv,
    PATH: `${sandboxEnv.PATH}:${controlEnv.PATH ?? "/usr/bin:/bin"}`,
    ...gitEnv,
  };
}
