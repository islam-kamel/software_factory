// ============================================================
// verifier.ts
// Purpose : Run configured repository checks in a fixed fail-fast order
// Feature : Quality verification
// Role    : Quality Gate
// API Doc : docs/implementation_plan.md, Deterministic Verifier
// ============================================================
import { runSandboxed, type SandboxResult } from "@/adapters/cli_runner/sandbox";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { VerificationResult } from "@/engine/contracts";

export type CheckStep = "secret_scan" | "lint" | "typecheck" | "test";
export type CheckRunnerOptions = {
  workspace: string;
  ignorePaths: string[];
  timeoutMs: number;
  scratchDirectory: string;
};
export type CheckRunner = (step: CheckStep, command: string, options: CheckRunnerOptions) => Promise<SandboxResult>;

export type VerifyOptions = {
  repository: ResolvedRepository;
  workspace: string;
  attempt?: number;
  timeoutMs?: number;
};

const STEP_ORDER: CheckStep[] = ["secret_scan", "lint", "typecheck", "test"];
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

async function runCheck(step: CheckStep, command: string, options: CheckRunnerOptions): Promise<SandboxResult> {
  return runSandboxed("/bin/bash", ["-euo", "pipefail", "-c", command], {
    ...options,
    access: "workspace_write",
  });
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
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

function outputSummary(output: string): string {
  const escape = String.fromCharCode(27);
  const clean = output.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "").trim();
  const lines = clean.split(/\r?\n/).filter(Boolean).slice(-12);
  return lines.join("\n").slice(-1800) || "Command failed without output";
}

function failedResult(attempt: number, step: string, summary: string): VerificationResult {
  return { passed: false, attempt, failed_step: step, summary };
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
    return withScratch(options.workspace, (scratchDirectory) =>
      runSteps({ runner, options, steps, attempt, timeoutMs, scratchDirectory }),
    );
  };
}

async function runSteps(input: {
  runner: CheckRunner;
  options: VerifyOptions;
  steps: Array<{ step: CheckStep; command: string }>;
  attempt: number;
  timeoutMs: number;
  scratchDirectory: string;
}): Promise<VerificationResult> {
  const { runner, options, steps, attempt, timeoutMs, scratchDirectory } = input;
  for (const { step, command } of steps) {
    if (command.trim().length === 0) return failedResult(attempt, step, "Configured command is empty");
    let result: SandboxResult;
    try {
      result = await runner(step, command, {
        workspace: options.workspace,
        ignorePaths: options.repository.privacy.ignore_paths ?? [],
        timeoutMs,
        scratchDirectory,
      });
    } catch {
      return failedResult(attempt, step, "Unable to start verification command");
    }
    if (result.timedOut) return failedResult(attempt, step, "Verification command timed out");
    if (result.outputLimit) return failedResult(attempt, step, "Verification command exceeded the output limit");
    if (result.exitCode !== 0) return failedResult(attempt, step, outputSummary(`${result.stderr}\n${result.stdout}`));
  }
  return { passed: true, attempt, failed_step: null, summary: `Passed ${steps.length} verification steps` };
}
