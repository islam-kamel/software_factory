// ============================================================
// resource_scope.ts
// Purpose : Apply and clean up systemd resource limits for sandbox process trees
// Feature : Agent execution security
// Role    : Process Runtime Adapter
// API Doc : https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
// ============================================================
import { spawn } from "node:child_process";
import type { ResourceLimits } from "@/engine/config_schemas";

export const SYSTEMD_RUN_EXECUTABLE = "/usr/bin/systemd-run";

export function systemdControlEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { SYSTEMD_COLORS: "0" };
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SYSTEMD_BUS_ADDRESS",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.PATH ??= "/usr/bin:/bin";
  return environment;
}

export type SystemdScopeRequest = {
  unitName: string;
  resourceLimits: ResourceLimits;
  timeoutMs: number;
  command: string;
  args: string[];
};

export function createSystemdScopeArgs(request: SystemdScopeRequest): string[] {
  const { unitName, resourceLimits, timeoutMs, command, args } = request;
  validateScopeRequest(request);
  return [
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    "--expand-environment=no",
    `--unit=${unitName}`,
    `--property=CPUQuota=${resourceLimits.cpu_quota_percent}%`,
    `--property=MemoryMax=${resourceLimits.memory_mb}M`,
    "--property=MemorySwapMax=0",
    `--property=TasksMax=${resourceLimits.max_pids}`,
    `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}s`,
    "--property=TimeoutStopSec=2s",
    "--property=OOMPolicy=kill",
    "--",
    command,
    ...args,
  ];
}

export function isSystemdScopeInactive(activeState: string, tasksCurrent: number): boolean {
  return (
    (activeState === "inactive" || activeState === "failed") && Number.isSafeInteger(tasksCurrent) && tasksCurrent === 0
  );
}

function validateScopeRequest(request: SystemdScopeRequest): void {
  validateScopeName(request.unitName);
  validateScopeTimeout(request.timeoutMs);
  validateResourceLimits(request.resourceLimits);
}

function validateScopeName(unitName: string): void {
  if (!/^factory-[a-f\d-]{36}\.scope$/.test(unitName)) throw new Error("Invalid sandbox resource scope name");
}

function validateScopeTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid sandbox resource scope timeout");
}

function validateResourceLimits(resourceLimits: ResourceLimits): void {
  if (
    !Number.isFinite(resourceLimits.cpu_quota_percent) ||
    resourceLimits.cpu_quota_percent < 1 ||
    resourceLimits.cpu_quota_percent > 10_000 ||
    !Number.isSafeInteger(resourceLimits.memory_mb) ||
    resourceLimits.memory_mb < 1 ||
    resourceLimits.memory_mb > 1_048_576 ||
    !Number.isSafeInteger(resourceLimits.max_pids) ||
    resourceLimits.max_pids < 1 ||
    resourceLimits.max_pids > 1_000_000
  ) {
    throw new Error("Invalid sandbox resource limits");
  }
}

export async function stopSystemdScope(unitName: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!/^factory-[a-f\d-]{36}\.scope$/.test(unitName)) throw new Error("Invalid sandbox resource scope name");
  await runSystemctl(["stop", "--no-block", unitName], env);
  if (await waitForInactive(unitName, env)) return;
  await runSystemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", unitName], env);
  if (!(await waitForInactive(unitName, env))) throw new Error("Unable to confirm sandbox resource scope cleanup");
}

async function waitForInactive(unitName: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const listing = await runSystemctl(["list-units", "--all", "--full", "--no-legend", "--no-pager", unitName], env);
    if (listing.code !== 0) throw new Error("Unable to inspect sandbox resource scope");
    if (!listing.stdout.trim()) return true;
    const active = await runSystemctl(["show", "--property=ActiveState", "--value", unitName], env);
    const tasks = await runSystemctl(["show", "--property=TasksCurrent", "--value", unitName], env);
    if (active.code !== 0 || tasks.code !== 0) throw new Error("Unable to inspect sandbox resource scope");
    const currentTasks = Number(tasks.stdout.trim());
    if (isSystemdScopeInactive(active.stdout.trim(), currentTasks)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function runSystemctl(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/systemctl", ["--user", ...args], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      reject(new Error("Timed out controlling sandbox resource scope"));
    }, 1_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to control sandbox resource scope"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_024) stdout += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}
