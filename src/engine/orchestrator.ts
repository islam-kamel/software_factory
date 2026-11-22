// ============================================================
// orchestrator.ts
// Purpose : Run one ticket through planning, approval, build and review
// Feature : Single-ticket orchestration
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Minimal Single-Ticket Orchestrator
// ============================================================
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentResult, Ticket, VerificationResult } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";
import { buildContext } from "@/engine/context_builder";
import { createVerifier, type VerifyOptions } from "@/self_healing/verifier";
import { assertBuilderWorkspace, getWorkspaceDiff } from "@/adapters/cli_runner/workspace";
import { runAgent } from "@/agents/run_agent";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import { runVerificationLoop } from "@/self_healing/retry_loop";

type Role = "planner" | "builder" | "reviewer";
export type AgentRequest = {
  role: Role;
  workspace: string;
  promptPath: string;
  outputDirectory: string;
  repoId: string;
  configDirectory?: string;
};
export type AgentRunner = (options: AgentRequest) => Promise<AgentResult>;
export type VerifyFunction = (options: VerifyOptions) => Promise<VerificationResult>;

type RunPhase = "needs_approval" | "running" | "reviewed" | "failed";
type RunState = {
  version: 1;
  repositoryId: string;
  ticketId: string;
  workspace: string;
  repositoryPath: string;
  factoryRoot: string;
  outputDirectory: string;
  planFile: string;
  planHash: string;
  phase: RunPhase;
  reviewFile?: string | undefined;
  reviewedDiffHash?: string | undefined;
};

const RunStateSchema = z
  .object({
    version: z.literal(1),
    repositoryId: z.string().min(1),
    ticketId: z.string().min(1),
    workspace: z.string().min(1),
    repositoryPath: z.string().min(1),
    factoryRoot: z.string().min(1),
    outputDirectory: z.string().min(1),
    planFile: z.string().min(1),
    planHash: z.string().regex(/^[a-f\d]{64}$/i),
    phase: z.enum(["needs_approval", "running", "reviewed", "failed"]),
    reviewFile: z.string().min(1).optional(),
    reviewedDiffHash: z
      .string()
      .regex(/^[a-f\d]{64}$/i)
      .optional(),
  })
  .strict();

type SharedOptions = {
  repository: ResolvedRepository;
  tracker: TrackerAdapter;
  configDirectory?: string;
  timeoutMs?: number;
  agentRunner?: AgentRunner;
  verifier?: VerifyFunction;
};

export type PlanTicketOptions = SharedOptions & {
  ticketId: string;
  workspace: string;
  factoryRoot: string;
  outputDirectory: string;
};

export type ResumeTicketOptions = SharedOptions & {
  runFile: string;
  factoryRoot: string;
  builderWorkspace: string;
  maxAttempts?: number;
  baseBranch?: string;
  logDirectory?: string;
};

export type OrchestrationResult = {
  status: "needs_approval" | "reviewed" | "changes_requested" | "failed";
  ticketId: string;
  planHash: string;
  runFile: string;
  summary?: string;
  approver?: string;
  reviewFile?: string | undefined;
  reviewedDiffHash?: string | undefined;
};

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_-]/g, "_");
  if (segment.length === 0) throw new Error("Ticket and repository identifiers must contain safe characters");
  return segment;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function createArtifactDirectory(options: {
  rootPath: string;
  workspacePath: string;
  repositoryId: string;
  ticketId: string;
}): Promise<string> {
  const workspace = await realpath(options.workspacePath);
  const root = await resolvePotentialPath(options.rootPath);
  if (overlaps(root, workspace)) throw new Error("Agent artifacts must be outside the repository workspace");
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  if (overlaps(actualRoot, workspace)) throw new Error("Agent artifacts must be outside the repository workspace");
  const artifactPath = join(actualRoot, safeSegment(options.repositoryId), safeSegment(options.ticketId), randomUUID());
  await mkdir(artifactPath, { recursive: true });
  const actual = await realpath(artifactPath);
  if (!isInside(actualRoot, actual) || overlaps(actual, workspace)) throw new Error("Agent artifact path is unsafe");
  return actual;
}

async function agentOutput(result: AgentResult, outputDirectory: string): Promise<{ path: string; content: string }> {
  if (result.status !== "success") throw new Error("Agent run failed");
  const requested = isAbsolute(result.output_file) ? result.output_file : resolve(outputDirectory, result.output_file);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent output must be a regular file");
  const actual = await realpath(requested);
  if (!isInside(outputDirectory, actual)) throw new Error("Agent output escaped the artifact directory");
  return { path: actual, content: await readFile(actual, "utf8") };
}

async function saveRunState(path: string, state: RunState): Promise<void> {
  const temporary = join(state.outputDirectory, `.run.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadRunState(path: string): Promise<RunState> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Run state must be a regular file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Run state is invalid JSON");
  }
  const state = RunStateSchema.safeParse(parsed);
  if (!state.success) throw new Error("Run state does not match the expected contract");
  const output = await realpath(state.data.outputDirectory);
  const runFile = await realpath(path);
  const planFile = await realpath(state.data.planFile);
  const workspace = await realpath(state.data.workspace);
  if (!isInside(output, runFile) || !isInside(output, planFile) || overlaps(output, workspace)) {
    throw new Error("Run state paths escape their safe directories");
  }
  return { ...state.data, outputDirectory: output, planFile, workspace };
}

export async function getRunState(runFile: string): Promise<Readonly<RunState>> {
  return loadRunState(runFile);
}

async function contextPrompt(options: {
  repository: ResolvedRepository;
  workspace: string;
  factoryRoot: string;
  outputDirectory: string;
  role: Role;
  ticket: Ticket;
  plan?: string;
  diff?: string;
}): Promise<string> {
  const context = await buildContext(options);
  const contextDirectory = join(options.outputDirectory, "contexts");
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
  const output = join(contextDirectory, `${options.role}.${randomUUID()}.context.md`);
  await writeFile(output, context, { encoding: "utf8", mode: 0o600 });
  return output;
}

async function roleOutputDirectory(root: string, role: Role): Promise<string> {
  const directory = join(root, `${role}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function failure(state: RunState, summary: string): OrchestrationResult {
  return {
    status: "failed",
    ticketId: state.ticketId,
    planHash: state.planHash,
    runFile: join(state.outputDirectory, "run.json"),
    summary,
  };
}

async function markFailed(options: SharedOptions, state: RunState, summary: string): Promise<OrchestrationResult> {
  state.phase = "failed";
  await saveRunState(join(state.outputDirectory, "run.json"), state);
  await options.tracker.updateState({ ticketId: state.ticketId, state: "ai_failed" });
  return failure(state, summary);
}

async function failPlanningSetup(options: PlanTicketOptions, ticketId: string, reason: unknown): Promise<never> {
  try {
    await options.tracker.updateState({ ticketId, state: "ai_failed" });
  } catch (stateError) {
    throw new AggregateError([reason, stateError], "Planning setup failed and ticket state update also failed", {
      cause: stateError,
    });
  }
  throw reason;
}

async function preparePlanningRun(input: {
  options: PlanTicketOptions;
  ticket: Ticket;
  workspace: string;
  repositoryPath: string;
}): Promise<{ outputDirectory: string; runFile: string; state: RunState }> {
  const { options, ticket, workspace, repositoryPath } = input;
  try {
    const outputDirectory = await createArtifactDirectory({
      rootPath: options.outputDirectory,
      workspacePath: options.workspace,
      repositoryId: options.repository.id,
      ticketId: ticket.id,
    });
    const state = await createRunState({ options, ticket, outputDirectory, workspace, repositoryPath });
    return { outputDirectory, runFile: join(outputDirectory, "run.json"), state };
  } catch (error) {
    return await failPlanningSetup(options, ticket.id, error);
  }
}

async function launchAgent(
  options: SharedOptions,
  request: Omit<AgentRequest, "repoId" | "configDirectory">,
): Promise<AgentResult> {
  const runner = options.agentRunner ?? runAgent;
  return runner({
    ...request,
    repoId: options.repository.id,
    ...(options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory }),
  });
}

export async function planTicket(options: PlanTicketOptions): Promise<OrchestrationResult> {
  const ticket = await options.tracker.getTicket(options.ticketId);
  if (ticket.state !== "ai_ready") throw new Error(`Ticket ${ticket.id} is not ready for planning`);
  const repositoryPath = await realpath(options.repository.local_path);
  const workspace = await realpath(options.workspace);
  if (workspace !== repositoryPath) throw new Error("Planner must use the configured repository workspace");
  await options.tracker.updateState({ ticketId: ticket.id, state: "ai_planning" });
  const setup = await preparePlanningRun({ options, ticket, workspace, repositoryPath });
  const { outputDirectory, runFile, state: placeholder } = setup;
  try {
    const promptPath = await contextPrompt({
      repository: options.repository,
      workspace: placeholder.workspace,
      factoryRoot: placeholder.factoryRoot,
      outputDirectory,
      role: "planner",
      ticket,
    });
    const agentDirectory = await roleOutputDirectory(outputDirectory, "planner");
    const result = await launchAgent(options, {
      role: "planner",
      workspace: placeholder.workspace,
      promptPath,
      outputDirectory: agentDirectory,
    });
    const plan = await agentOutput(result, agentDirectory);
    if (plan.content.trim().length === 0)
      return await markFailed(options, placeholder, "Planner returned an empty plan");
    placeholder.planFile = plan.path;
    placeholder.planHash = hashText(plan.content);
    placeholder.phase = "needs_approval";
    await options.tracker.publishPlan({ ticketId: ticket.id, plan: plan.content, planHash: placeholder.planHash });
    await options.tracker.updateState({ ticketId: ticket.id, state: "needs_approval" });
    await saveRunState(runFile, placeholder);
    return { status: "needs_approval", ticketId: ticket.id, planHash: placeholder.planHash, runFile };
  } catch {
    return await markFailed(options, placeholder, "Planning failed; inspect the safe agent summary");
  }
}

async function createRunState(input: {
  options: PlanTicketOptions;
  ticket: Ticket;
  outputDirectory: string;
  workspace: string;
  repositoryPath: string;
}): Promise<RunState> {
  const { options, ticket, outputDirectory, workspace, repositoryPath } = input;
  return {
    version: 1,
    repositoryId: options.repository.id,
    ticketId: ticket.id,
    workspace,
    repositoryPath,
    factoryRoot: await realpath(options.factoryRoot),
    outputDirectory,
    planFile: join(outputDirectory, "PLAN.md"),
    planHash: "0".repeat(64),
    phase: "running",
  };
}

function reviewVerdict(report: string): "APPROVE_FOR_DRAFT_PR" | "CHANGES_REQUESTED" | null {
  const matches = [...report.matchAll(/^\*\*Verdict:\*\*\s*`(APPROVE_FOR_DRAFT_PR|CHANGES_REQUESTED)`\s*$/gm)];
  if (matches.length !== 1) return null;
  const verdict = matches[0]?.[1];
  return verdict === "APPROVE_FOR_DRAFT_PR" || verdict === "CHANGES_REQUESTED" ? verdict : null;
}

export async function resumeTicket(options: ResumeTicketOptions): Promise<OrchestrationResult> {
  const state = await loadRunState(options.runFile);
  if (state.repositoryId !== options.repository.id) throw new Error("Run state belongs to another repository");
  if (state.repositoryPath !== (await realpath(options.repository.local_path))) {
    throw new Error("Run state belongs to another repository path");
  }
  if (state.factoryRoot !== (await realpath(options.factoryRoot)))
    throw new Error("Run state belongs to another factory");
  if (state.phase !== "needs_approval") return failure(state, "Run is not waiting for approval");
  const ticket = await options.tracker.getTicket(state.ticketId);
  const approval = await options.tracker.getApproval({ ticketId: ticket.id, planHash: state.planHash });
  if (!approval)
    return { status: "needs_approval", ticketId: ticket.id, planHash: state.planHash, runFile: options.runFile };

  try {
    return await runApprovedTicket({ options, state, ticket, approver: approval.author });
  } catch {
    return await markFailed(options, state, "Approved run failed; inspect safe agent and verification summaries");
  }
}

export { planManagedTicket, resumeManagedTicket } from "@/engine/automation";

async function runBuilder(input: {
  options: ResumeTicketOptions;
  state: RunState;
  ticket: Ticket;
  plan: string;
  workspace: string;
}): Promise<void> {
  const { options, state, ticket, plan, workspace } = input;
  state.phase = "running";
  await saveRunState(options.runFile, state);
  await options.tracker.updateState({ ticketId: ticket.id, state: "ai_approved" });
  await options.tracker.updateState({ ticketId: ticket.id, state: "ai_building" });
  await runBuilderAgent({ options, state, ticket, plan, workspace });
}

async function runBuilderAgent(input: {
  options: ResumeTicketOptions;
  state: RunState;
  ticket: Ticket;
  plan: string;
  workspace: string;
}): Promise<void> {
  const { options, state, ticket, plan, workspace } = input;
  const promptPath = await contextPrompt({
    repository: options.repository,
    workspace,
    factoryRoot: state.factoryRoot,
    outputDirectory: state.outputDirectory,
    role: "builder",
    ticket,
    plan,
  });
  const agentDirectory = await roleOutputDirectory(state.outputDirectory, "builder");
  const result = await launchAgent(options, {
    role: "builder",
    workspace,
    promptPath,
    outputDirectory: agentDirectory,
  });
  await agentOutput(result, agentDirectory);
}

async function repairBuild(input: {
  options: ResumeTicketOptions;
  state: RunState;
  ticket: Ticket;
  plan: string;
  workspace: string;
  failure: VerificationResult;
}): Promise<void> {
  const { options, state, ticket, plan, workspace, failure: verification } = input;
  await options.tracker.updateState({ ticketId: ticket.id, state: "ai_building" });
  const repairPlan = `${plan}\n\n## Verification diagnostics\n\n${verification.failed_step}: ${verification.summary}`;
  await runBuilderAgent({ options, state, ticket, plan: repairPlan, workspace });
}

async function verifyBuild(input: {
  options: ResumeTicketOptions;
  ticket: Ticket;
  workspace: string;
  attempt: number;
}): Promise<VerificationResult> {
  const { options, ticket, workspace, attempt } = input;
  await options.tracker.updateState({ ticketId: ticket.id, state: "verifying" });
  const verify = options.verifier ?? createVerifier();
  return verify({
    repository: options.repository,
    workspace,
    attempt,
    timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    ...(options.logDirectory ? { logDirectory: options.logDirectory } : {}),
  });
}

async function runReviewer(input: {
  options: ResumeTicketOptions;
  state: RunState;
  ticket: Ticket;
  plan: string;
  workspace: string;
}): Promise<string | null> {
  const { options, state, ticket, plan, workspace } = input;
  const diff = await getWorkspaceDiff({
    workspace,
    ignorePaths: options.repository.privacy.ignore_paths ?? [],
    baseBranch: options.baseBranch ?? options.repository.base_branch ?? "main",
  });
  await options.tracker.updateState({ ticketId: ticket.id, state: "ai_reviewing" });
  const promptPath = await contextPrompt({
    repository: options.repository,
    workspace,
    factoryRoot: state.factoryRoot,
    outputDirectory: state.outputDirectory,
    role: "reviewer",
    ticket,
    plan,
    diff,
  });
  const agentDirectory = await roleOutputDirectory(state.outputDirectory, "reviewer");
  const result = await launchAgent(options, {
    role: "reviewer",
    workspace,
    promptPath,
    outputDirectory: agentDirectory,
  });
  const report = await agentOutput(result, agentDirectory);
  state.reviewFile = report.path;
  state.reviewedDiffHash = hashText(diff);
  return reviewVerdict(report.content);
}

async function runApprovedTicket(input: {
  options: ResumeTicketOptions;
  state: RunState;
  ticket: Ticket;
  approver: string;
}): Promise<OrchestrationResult> {
  const { options, state, ticket, approver } = input;
  const plan = await readFile(state.planFile, "utf8");
  if (hashText(plan) !== state.planHash) return markFailed(options, state, "Approved plan changed after approval");
  await assertBuilderWorkspace({ workspace: options.builderWorkspace, repository: state.repositoryPath });
  const workspace = await realpath(options.builderWorkspace);
  await runBuilder({ options, state, ticket, plan, workspace });
  const verified = await runVerificationLoop({
    maxAttempts: options.maxAttempts ?? 1,
    verify: (attempt) => verifyBuild({ options, ticket, workspace, attempt }),
    repair: (verification) => repairBuild({ options, state, ticket, plan, workspace, failure: verification }),
  });
  if (!verified.passed)
    return markFailed(options, state, `Verification failed at ${verified.failed_step}: ${verified.summary}`);
  const verdict = await runReviewer({ options, state, ticket, plan, workspace });
  if (verdict === "CHANGES_REQUESTED") {
    const failed = await markFailed(options, state, "Reviewer requested changes");
    return { ...failed, status: "changes_requested" };
  }
  if (verdict !== "APPROVE_FOR_DRAFT_PR")
    return markFailed(options, state, "Reviewer report has no single valid verdict");
  state.phase = "reviewed";
  await saveRunState(options.runFile, state);
  return {
    status: "reviewed",
    ticketId: ticket.id,
    planHash: state.planHash,
    runFile: options.runFile,
    approver,
    ...(state.reviewFile ? { reviewFile: state.reviewFile } : {}),
    ...(state.reviewedDiffHash ? { reviewedDiffHash: state.reviewedDiffHash } : {}),
  };
}
