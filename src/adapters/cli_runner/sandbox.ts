// ============================================================
// sandbox.ts
// Purpose : Run agent CLIs inside host-native filesystem sandboxes
// Feature : Agent execution security
// Role    : Security Adapter
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIgnoredPath } from "@/engine/context_builder";

export type SandboxOptions = {
  workspace: string;
  ignorePaths: string[];
  access: "read_only" | "workspace_write";
  timeoutMs: number;
  scratchDirectory: string;
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
  return result;
}

type BwrapRequest = {
  command: string;
  args: string[];
  options: SandboxOptions;
  workspace: string;
  hidden: HiddenPath[];
};

export function createBwrapArgs(request: BwrapRequest): string[] {
  const { command, args, options, workspace, hidden } = request;
  const scratch = options.scratchDirectory;
  const result = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    scratch,
    scratch,
    "--ro-bind",
    workspace,
    workspace,
  ];
  if (options.access === "workspace_write") result.push("--bind", workspace, workspace);
  for (const entry of hidden) {
    if (entry.isDirectory) result.push("--tmpfs", entry.path, "--remount-ro", entry.path);
    else result.push("--ro-bind", "/dev/null", entry.path);
  }
  result.push("--", command, ...args);
  return result;
}

function appendOutput(current: string, chunk: Buffer): { value: string; overflow: boolean } {
  const next = current + chunk.toString("utf8");
  const overflow = Buffer.byteLength(next) > MAX_OUTPUT_BYTES;
  return { value: overflow ? next.slice(0, MAX_OUTPUT_BYTES) : next, overflow };
}

function safeEnvironment(options: SandboxOptions): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: options.scratchDirectory,
    ...options.env,
  };
}

type ProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
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
  options: { state: ProcessState; child: ReturnType<typeof spawn>; stream: "stdout" | "stderr" },
  chunk: Buffer,
): void {
  const appended = appendOutput(options.state[options.stream], chunk);
  options.state[options.stream] = appended.value;
  options.state.outputLimit ||= appended.overflow;
  if (appended.overflow) killGroup(options.child, "SIGKILL");
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
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  return new Promise((resolveResult, rejectResult) => {
    const finish = (code: number | null): void => {
      if (state.settled) return;
      state.settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({
        exitCode: code,
        stdout: state.stdout,
        stderr: state.stderr,
        timedOut: state.timedOut,
        outputLimit: state.outputLimit,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => captureOutput({ state, child, stream: "stdout" }, chunk));
    child.stderr.on("data", (chunk: Buffer) => captureOutput({ state, child, stream: "stderr" }, chunk));
    child.once("error", () => {
      state.settled = true;
      if (timer) clearTimeout(timer);
      rejectResult(new Error("Unable to start the required host sandbox"));
    });
    child.once("close", finish);
    timer = setTimeout(() => {
      state.timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 250);
    }, options.timeoutMs);
  });
}

export async function runSandboxed(command: string, args: string[], options: SandboxOptions): Promise<SandboxResult> {
  if (process.platform !== "linux")
    throw new Error("Agent filesystem sandbox requires Linux with bubblewrap installed");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid agent timeout");
  const workspace = await realpath(options.workspace);
  const scratch = await realpath(options.scratchDirectory);
  if (isInside(workspace, scratch) || isInside(scratch, workspace))
    throw new Error("Agent scratch directory must be outside the workspace");
  const readyOptions = { ...options, scratchDirectory: scratch };
  const hidden = await hiddenPaths(readyOptions, workspace);
  const sandboxArgs = createBwrapArgs({ command, args, options: readyOptions, workspace, hidden });
  return runProcess({
    command: "bwrap",
    args: sandboxArgs,
    cwd: workspace,
    env: safeEnvironment(readyOptions),
    timeoutMs: options.timeoutMs,
  });
}
