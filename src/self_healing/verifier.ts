// ============================================================
// verifier.ts
// Purpose : Enforce safe diffs and run configured repository checks
// Feature : Quality verification
// Role    : Quality Gate
// API Doc : docs/implementation_plan.md, Deterministic Verifier and Protected Files Gate
// ============================================================
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runSandboxed, SandboxCleanupError, type SandboxResult } from "@/adapters/cli_runner/sandbox";
import { loadSandboxRuntimeProfile, type SandboxRuntimeProfile } from "@/adapters/cli_runner/runtime_profile";
import { getChangedPaths } from "@/adapters/git_host/workspace";
import { assertBuilderWorkspace } from "@/adapters/cli_runner/workspace";
import { isIgnoredPath } from "@/engine/context_builder";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { VerificationResult } from "@/engine/contracts";
import { writeRunLog } from "@/engine/run_log";
import { parseErrorSummary } from "@/self_healing/error_parser";
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from "@/engine/config_schemas";

export type CheckStep = "secret_scan" | "lint" | "typecheck" | "test";
export type CheckRunnerOptions = {
  repository: string;
  workspace: string;
  ignorePaths: string[];
  timeoutMs: number;
  scratchDirectory: string;
  runtimeProfile?: SandboxRuntimeProfile;
  resourceLimits?: ResourceLimits;
};
export type CheckRunner = (step: CheckStep, command: string, options: CheckRunnerOptions) => Promise<SandboxResult>;

export type VerifyOptions = {
  repository: ResolvedRepository;
  workspace: string;
  attempt?: number;
  timeoutMs?: number;
  runtimeProfile?: SandboxRuntimeProfile;
  resourceLimits?: ResourceLimits;
  baseBranch?: string;
  logDirectory?: string;
};

const STEP_ORDER: CheckStep[] = ["secret_scan", "lint", "typecheck", "test"];
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const PROTECTED_PATHS = [".env*", ".github/workflows/**", "config/repos.yaml"];

async function runCheck(step: CheckStep, command: string, options: CheckRunnerOptions): Promise<SandboxResult> {
  const runtimeProfile = options.runtimeProfile;
  if (!runtimeProfile) throw new Error("Sandbox runtime profile is required");
  return runSandboxed("/bin/bash", ["-euo", "pipefail", "-c", command], {
    repository: options.repository,
    workspace: options.workspace,
    ignorePaths: options.ignorePaths,
    access: "workspace_write",
    timeoutMs: options.timeoutMs,
    scratchDirectory: options.scratchDirectory,
    runtimeProfile,
    resourceLimits: options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
    offline: true,
  });
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

async function resolvePotentialPath(path: string): Promise<string> {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(candidate.slice(parent.length + 1));
      candidate = parent;
    }
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Verification log directory cannot be a symlink");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function assertOutsideRoots(
  path: string,
  options: VerifyOptions,
): Promise<{ repository: string; workspace: string }> {
  const repository = await realpath(options.repository.local_path);
  const workspace = await realpath(options.workspace);
  if (overlaps(path, repository) || overlaps(path, workspace)) {
    throw new Error("Verification log directory must be outside the repository and workspace");
  }
  return { repository, workspace };
}

async function assertPrivateLogDirectory(
  path: string,
  potential: string,
  roots: { repository: string; workspace: string },
): Promise<void> {
  const details = await lstat(path);
  if (
    details.isSymbolicLink() ||
    details.mode & 0o077 ||
    path !== potential ||
    overlaps(path, roots.repository) ||
    overlaps(path, roots.workspace)
  ) {
    throw new Error("Verification log directory is not private and external");
  }
}

async function prepareLogDirectory(options: VerifyOptions): Promise<string> {
  if (!options.logDirectory) throw new Error("External verification log directory is required");
  const requested = resolve(options.logDirectory);
  await assertNotSymlink(requested);
  const potential = await resolvePotentialPath(requested);
  const roots = await assertOutsideRoots(potential, options);
  await mkdir(potential, { recursive: true, mode: 0o700 });
  const directory = await realpath(potential);
  await assertPrivateLogDirectory(directory, potential, roots);
  return directory;
}

async function writeFailureLog(input: {
  options: VerifyOptions;
  step: CheckStep;
  attempt: number;
  output: string;
}): Promise<string | undefined> {
  if (!input.options.logDirectory) return undefined;
  const directory = await prepareLogDirectory(input.options);
  return writeRunLog({
    directory,
    fileName: `verification-${randomUUID()}-${input.step}-${input.attempt}.log`,
    content: input.output,
  });
}

async function protectedFailure(options: VerifyOptions, attempt: number): Promise<VerificationResult | null> {
  if (options.baseBranch === undefined) return null;
  try {
    await assertProtectedDiff({
      repository: options.repository,
      workspace: options.workspace,
      baseBranch: options.baseBranch,
    });
    return null;
  } catch {
    return failedResult(attempt, "protected_files", "Protected or ignored path changes block verification");
  }
}

async function failedCheckResult(input: {
  options: VerifyOptions;
  attempt: number;
  step: CheckStep;
  output: string;
  summary?: string;
  includeLogPath?: boolean;
}): Promise<VerificationResult> {
  const protectedResult = await protectedFailure(input.options, input.attempt);
  if (protectedResult) return protectedResult;
  try {
    const logPath = await writeFailureLog(input);
    const summary = input.includeLogPath && logPath ? `${input.summary}: ${logPath}` : input.summary;
    return failedResult(input.attempt, input.step, summary ?? parseErrorSummary(input.output));
  } catch {
    return failedResult(input.attempt, "logging", "Unable to save verification failure log");
  }
}

async function withScratch<T>(workspace: string, run: (scratchDirectory: string) => Promise<T>): Promise<T> {
  const scratchDirectory = await mkdtemp(resolve(tmpdir(), "software-factory-verify-"));
  try {
    const scratch = await realpath(scratchDirectory);
    const root = await realpath(workspace);
    if (isInside(root, scratch) || isInside(scratch, root)) throw new Error("Verifier scratch overlaps workspace");
    return await run(scratch);
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

function failedResult(attempt: number, step: string, summary: string): VerificationResult {
  return { passed: false, attempt, failed_step: step, summary };
}

export async function assertProtectedDiff(options: {
  repository: ResolvedRepository;
  workspace: string;
  baseBranch: string;
}): Promise<void> {
  const workspace = await realpath(options.workspace);
  const repository = await realpath(options.repository.local_path);
  await assertBuilderWorkspace({ workspace, repository });
  const ignoredPaths = [...PROTECTED_PATHS, ...(options.repository.privacy.ignore_paths ?? [])];
  const changedPaths = await getChangedPaths({
    workspace,
    baseBranch: options.baseBranch,
    ignorePaths: ignoredPaths,
  });
  for (const path of changedPaths) {
    if (isIgnoredPath(path, ignoredPaths)) throw new Error("Protected or ignored path was modified");
    await assertPathStaysInside(workspace, path);
  }
}

async function isSymlinkInsideWorkspace(workspace: string, path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    const actual = await realpath(path);
    if (!isInside(workspace, actual)) throw new Error("Changed path escapes the Builder workspace");
    return details.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertPathStaysInside(workspace: string, path: string): Promise<void> {
  let current = resolve(workspace, path);
  if (!isInside(workspace, current)) throw new Error("Changed path escapes the Builder workspace");
  while (isInside(workspace, current)) {
    if ((await isSymlinkInsideWorkspace(workspace, current)) || current === workspace) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function configuredSteps(repository: ResolvedRepository): Array<{ step: CheckStep; command: string }> {
  const verification = repository.verification;
  if (!verification) return [];
  return STEP_ORDER.flatMap((step) => {
    const command = verification[step];
    return command === undefined ? [] : [{ step, command }];
  });
}

export function createVerifier(runner: CheckRunner = runCheck) {
  return async function verify(options: VerifyOptions): Promise<VerificationResult> {
    const attempt = options.attempt ?? 1;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(attempt) || attempt < 1) return failedResult(1, "configuration", "Attempt must be positive");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return failedResult(attempt, "configuration", "Verification timeout must be positive");
    }
    const steps = configuredSteps(options.repository);
    if (steps.length === 0) return failedResult(attempt, "configuration", "No verification commands are configured");
    return executeVerification({ runner, options, steps, attempt, timeoutMs });
  };
}

async function executeVerification(input: {
  runner: CheckRunner;
  options: VerifyOptions;
  steps: Array<{ step: CheckStep; command: string }>;
  attempt: number;
  timeoutMs: number;
}): Promise<VerificationResult> {
  const { runner, options, steps, attempt, timeoutMs } = input;
  const initialProtectionFailure = await protectedFailure(options, attempt);
  if (initialProtectionFailure) return initialProtectionFailure;
  let runtimeProfile: SandboxRuntimeProfile | undefined;
  try {
    runtimeProfile = await verifierProfile(runner, options.runtimeProfile);
  } catch {
    return failedResult(attempt, "configuration", "Sandbox runtime profile is unavailable");
  }
  if (runner === runCheck && !runtimeProfile)
    return failedResult(attempt, "configuration", "Sandbox runtime profile is unavailable");
  return withScratch(options.workspace, (scratchDirectory) =>
    runSteps({ runner, options, steps, attempt, timeoutMs, scratchDirectory, runtimeProfile }),
  );
}

async function verifierProfile(
  runner: CheckRunner,
  configured?: SandboxRuntimeProfile,
): Promise<SandboxRuntimeProfile | undefined> {
  if (configured || runner !== runCheck) return configured;
  const factoryRoot = resolve(process.env.SOFTWARE_FACTORY_ROOT ?? process.cwd());
  try {
    return await loadSandboxRuntimeProfile(resolve(factoryRoot, "config/runtime-profile.yaml"));
  } catch {
    return undefined;
  }
}

async function runSteps(input: {
  runner: CheckRunner;
  options: VerifyOptions;
  steps: Array<{ step: CheckStep; command: string }>;
  attempt: number;
  timeoutMs: number;
  scratchDirectory: string;
  runtimeProfile: SandboxRuntimeProfile | undefined;
}): Promise<VerificationResult> {
  const { runner, options, steps, attempt } = input;
  for (const { step, command } of steps) {
    if (command.trim().length === 0) return failedResult(attempt, step, "Configured command is empty");
    let result: SandboxResult;
    try {
      result = await runner(step, command, createCheckSandboxOptions(input));
    } catch (error) {
      if (error instanceof SandboxCleanupError) {
        const result = error.result;
        return failedCheckResult({
          options,
          attempt,
          step,
          output: `${result.stderr}\n${result.stdout}`,
          summary: "Unable to confirm sandbox cleanup",
          includeLogPath: true,
        });
      }
      return failedCheckResult({ options, attempt, step, output: "", summary: "Unable to start verification command" });
    }
    const output = `${result.stderr}\n${result.stdout}`;
    if (result.timedOut) {
      return failedCheckResult({ options, attempt, step, output, summary: "Verification command timed out" });
    }
    if (result.outputLimit) {
      return failedCheckResult({
        options,
        attempt,
        step,
        output,
        summary: "Verification command exceeded the output limit",
      });
    }
    if (result.exitCode !== 0) return failedCheckResult({ options, attempt, step, output });
  }
  const finalProtectionFailure = await protectedFailure(options, attempt);
  if (finalProtectionFailure) return finalProtectionFailure;
  return { passed: true, attempt, failed_step: null, summary: `Passed ${steps.length} verification steps` };
}

function createCheckSandboxOptions(input: {
  options: VerifyOptions;
  timeoutMs: number;
  scratchDirectory: string;
  runtimeProfile: SandboxRuntimeProfile | undefined;
}): CheckRunnerOptions {
  const { options, timeoutMs, scratchDirectory, runtimeProfile } = input;
  return {
    repository: options.repository.local_path,
    workspace: options.workspace,
    ignorePaths: options.repository.privacy.ignore_paths ?? [],
    timeoutMs,
    scratchDirectory,
    ...(runtimeProfile ? { runtimeProfile } : {}),
    ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
  };
}
