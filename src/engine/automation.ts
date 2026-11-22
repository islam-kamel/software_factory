// ============================================================
// automation.ts
// Purpose : Manage claims, worktrees and Draft PR delivery around ticket orchestration
// Feature : Phase 2 managed ticket lifecycle
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Managed Automation
// ============================================================
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DraftCreationUnknownError, type DraftReceipt, type GitHostAdapter } from "@/adapters/git_host/github";
import { createNotifier, type NotificationEvent, type Notifier } from "@/adapters/notifier/console";
import type { AgentRunner, OrchestrationResult, VerifyFunction } from "@/engine/orchestrator";
import { getRunState, planTicket, resumeTicket } from "@/engine/orchestrator";
import { getResourceLimits, type FactoryConfig, type ResolvedRepository } from "@/engine/config_schemas";
import type { Ticket } from "@/engine/contracts";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import {
  createTicketClaim,
  finishTicketClaim,
  enterTicketClaim,
  leaveTicketClaim,
  transitionTicket,
  type ActiveTicketClaim,
} from "@/engine/state_manager";
import { createWorkspace, removeWorkspace, resolvePotentialPath, type ManagedWorkspace } from "@/engine/workspace";
import { prepareDraft, type DeliveryOptions } from "@/engine/automation_delivery";
import {
  createManagedRecord,
  persistManagedDelivery,
  validateManagedRun,
  writeManagedRecord,
  type ManagedRecord,
} from "@/engine/automation_state";

const ManagedWorkspaceConfigSchema = z
  .object({
    use_worktree: z.literal(true),
    worktree_root: z.string().min(1),
    cleanup_on_complete: z.literal(true).optional(),
    branch_prefix: z.literal("ai/").optional(),
    draft_pr_only: z.literal(true),
  })
  .passthrough();

type ManagedOptions = {
  repository: ResolvedRepository;
  factory: FactoryConfig;
  tracker: TrackerAdapter;
  factoryRoot: string;
  configDirectory?: string;
  timeoutMs?: number;
  agentRunner?: AgentRunner;
  verifier?: VerifyFunction;
  gitHost?: GitHostAdapter;
  notifier?: Notifier;
  secrets?: ReadonlyMap<string, string>;
};
export type PlanManagedTicketOptions = ManagedOptions & { ticketId: string; outputDirectory: string };
export type ResumeManagedTicketOptions = ManagedOptions & { runFile: string };
export type ManagedResult = {
  status: "needs_approval" | "pr_ready" | "delivery_pending" | "failed" | "changes_requested";
  ticketId: string;
  planHash: string;
  runFile: string;
  url?: string;
  notificationError?: string;
  cleanupError?: string;
  lifecycleError?: string;
  trackerError?: string;
  deliveryError?: string;
};

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

function configuredWorktreeRoot(options: ManagedOptions): string {
  const workspace = ManagedWorkspaceConfigSchema.safeParse(options.factory.workspace);
  if (!workspace.success) throw new Error("Managed automation requires isolated worktrees and Draft PR only mode");
  if (!isAbsolute(workspace.data.worktree_root)) throw new Error("Factory worktree_root must be absolute");
  if (options.repository.branch_prefix !== undefined && options.repository.branch_prefix !== "ai/") {
    throw new Error("Managed automation requires the ai/ branch prefix");
  }
  configuredAttempts(options.repository, options.factory);
  managedTimeout(options);
  if (!options.repository.enabled || !options.repository.use_worktree || options.repository.draft_pr === false) {
    throw new Error("Repository is not enabled for managed Draft PR automation");
  }
  return resolve(workspace.data.worktree_root);
}

async function configuredRoots(
  options: ManagedOptions,
): Promise<{ repositoryPath: string; factoryRoot: string; worktreeRoot: string; claimRoot: string }> {
  const configuredRoot = configuredWorktreeRoot(options);
  const repositoryPath = await realpath(options.repository.local_path);
  const factoryRoot = await realpath(options.factoryRoot);
  const worktreeTarget = await resolvePotentialPath(configuredRoot);
  if (overlaps(repositoryPath, worktreeTarget) || overlaps(factoryRoot, worktreeTarget)) {
    throw new Error("Factory worktree root must be outside the repository and factory artifacts");
  }
  await mkdir(worktreeTarget, { recursive: true, mode: 0o700 });
  const worktreeRoot = await realpath(worktreeTarget);
  if (worktreeRoot !== worktreeTarget) throw new Error("Factory worktree root changed during validation");
  return { repositoryPath, factoryRoot, worktreeRoot, claimRoot: join(worktreeRoot, ".claims") };
}

function managedTracker(tracker: TrackerAdapter, onStateUpdate?: () => void): TrackerAdapter {
  return {
    listReadyTickets: () => tracker.listReadyTickets(),
    getTicket: (id) => tracker.getTicket(id),
    publishPlan: (input) => tracker.publishPlan(input),
    getApproval: (input) => tracker.getApproval(input),
    updateState: (input) => {
      onStateUpdate?.();
      return transitionTicket({ tracker, ticketId: input.ticketId, state: input.state });
    },
  };
}

function managedOptions(
  options: ManagedOptions,
  tracker: TrackerAdapter,
): {
  repository: ResolvedRepository;
  tracker: TrackerAdapter;
  configDirectory?: string;
  timeoutMs?: number;
  resourceLimits: ReturnType<typeof getResourceLimits>;
  agentRunner?: AgentRunner;
  verifier?: VerifyFunction;
} {
  return {
    repository: options.repository,
    tracker,
    ...(options.configDirectory ? { configDirectory: options.configDirectory } : {}),
    timeoutMs: managedTimeout(options),
    resourceLimits: getResourceLimits(options.factory.limits),
    ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  };
}

async function notify(options: ManagedOptions, event: NotificationEvent): Promise<string | undefined> {
  try {
    const notifier = options.notifier ?? createNotifier({ factory: options.factory, repository: options.repository });
    await notifier.notify(event);
    return undefined;
  } catch {
    return "Notification configuration or delivery failed";
  }
}

function notificationEvent(input: {
  state: NotificationEvent["state"];
  repository: ResolvedRepository;
  ticketId: string;
  url?: string;
}): NotificationEvent {
  return {
    state: input.state,
    repositoryId: input.repository.id,
    ticketId: input.ticketId,
    ...(input.url ? { url: input.url } : {}),
  };
}

function configuredAttempts(repository: ResolvedRepository, factory: FactoryConfig): number {
  const attemptCount = repository.max_retries ?? factory.limits?.max_self_heal_retries ?? 3;
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1)
    throw new Error("Factory verification attempt limit is invalid");
  return attemptCount;
}

function managedTimeout(options: ManagedOptions): number {
  const timeout = options.timeoutMs ?? Number(options.factory.limits?.agent_timeout_minutes ?? 15) * 60_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Factory agent timeout is invalid");
  return timeout;
}

async function cleanWorkspace(workspace: ManagedWorkspace | undefined): Promise<string | undefined> {
  if (!workspace) return undefined;
  try {
    await removeWorkspace(workspace);
    return undefined;
  } catch {
    return "Managed worktree cleanup failed; inspect the retained worktree";
  }
}

async function terminalState(tracker: TrackerAdapter, ticketId: string): Promise<boolean> {
  const state = (await tracker.getTicket(ticketId)).state;
  return state === "ai_failed" || state === "ai_pr_ready";
}

async function markManagedFailure(tracker: TrackerAdapter, ticketId: string): Promise<boolean> {
  try {
    const ticket = await tracker.getTicket(ticketId);
    if (ticket.state === "ai_failed" || ticket.state === "ai_pr_ready") return true;
    await transitionTicket({ tracker, ticketId, state: "ai_failed" });
    return true;
  } catch {
    return false;
  }
}

async function settlePlanningClaim(input: {
  claim: ActiveTicketClaim;
  tracker: TrackerAdapter;
  ticketId: string;
  stateUpdateAttempted: boolean;
}): Promise<void> {
  if (!input.stateUpdateAttempted) {
    await finishTicketClaim(input.claim);
    return;
  }
  try {
    if (await terminalState(input.tracker, input.ticketId)) await finishTicketClaim(input.claim);
  } catch {
    // An uncertain tracker state keeps the active claim fail-closed.
  }
}

async function createPlanningClaim(
  options: PlanManagedTicketOptions,
  roots: Awaited<ReturnType<typeof configuredRoots>>,
): Promise<ActiveTicketClaim> {
  const initial = await options.tracker.getTicket(options.ticketId);
  if (initial.state !== "ai_ready") throw new Error("Ticket is not ready for managed planning");
  const claim = await createTicketClaim({
    root: roots.claimRoot,
    repository: roots.repositoryPath,
    ticketId: options.ticketId,
  });
  try {
    const current = await options.tracker.getTicket(options.ticketId);
    if (current.state !== "ai_ready") throw new Error("Ticket is no longer ready for managed planning");
    return claim;
  } catch {
    await finishTicketClaim(claim);
    throw new Error("Managed planning preflight failed before ticket state changed");
  }
}

export async function planManagedTicket(options: PlanManagedTicketOptions): Promise<ManagedResult> {
  const roots = await configuredRoots(options);
  const claim = await createPlanningClaim(options, roots);
  let stateUpdateAttempted = false;
  try {
    const tracker = managedTracker(options.tracker, () => {
      stateUpdateAttempted = true;
    });
    const result = await planTicket({
      ...managedOptions(options, tracker),
      ticketId: options.ticketId,
      workspace: roots.repositoryPath,
      factoryRoot: roots.factoryRoot,
      outputDirectory: options.outputDirectory,
    });
    await getRunState(result.runFile);
    const record = createManagedRecord(result, options.repository, claim);
    await writeManagedRecord(result.runFile, record);
    if (result.status === "needs_approval") {
      const notificationError = await notify(
        options,
        notificationEvent({ state: "needs_approval", repository: options.repository, ticketId: result.ticketId }),
      );
      await leaveTicketClaim(claim);
      return { ...result, status: "needs_approval", ...(notificationError ? { notificationError } : {}) };
    }
    const notificationError = await notify(
      options,
      notificationEvent({ state: "ai_failed", repository: options.repository, ticketId: result.ticketId }),
    );
    await finishTicketClaim(claim);
    return {
      status: "failed",
      ticketId: result.ticketId,
      planHash: result.planHash,
      runFile: result.runFile,
      ...(notificationError ? { notificationError } : {}),
    };
  } catch {
    await settlePlanningClaim({
      claim,
      tracker: options.tracker,
      ticketId: options.ticketId,
      stateUpdateAttempted,
    });
    throw new Error("Managed planning failed; inspect the ticket state and private run artifacts");
  }
}

async function loadReview(runState: Awaited<ReturnType<typeof getRunState>>): Promise<string> {
  const path = runState.reviewFile;
  if (!path || !isInside(runState.outputDirectory, path)) throw new Error("Reviewer report is unavailable");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Reviewer report is unsafe");
  const actual = await realpath(path);
  if (!isInside(runState.outputDirectory, actual)) throw new Error("Reviewer report escaped the artifact directory");
  return readFile(actual, "utf8");
}

function logDirectory(outputDirectory: string): string {
  return join(outputDirectory, "verification-logs");
}

function deliveryOptions(options: ResumeManagedTicketOptions): DeliveryOptions {
  return {
    repository: options.repository,
    factory: options.factory,
    timeoutMs: managedTimeout(options),
    ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.gitHost ? { gitHost: options.gitHost } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
}

function persistReceipt(runFile: string, receipt: DraftReceipt): Promise<boolean> {
  return persistManagedDelivery(runFile, {
    status: "complete",
    url: receipt.url,
    number: receipt.number,
    commit: receipt.commit,
  });
}

function persistUnknownDraft(runFile: string, commit: string): Promise<boolean> {
  return persistManagedDelivery(runFile, { status: "unknown", commit });
}

type DraftReadyResultInput = {
  ticketId: string;
  planHash: string;
  runFile: string;
  url: string;
  trackerError?: string | undefined;
  notificationError?: string | undefined;
  cleanupError?: string | undefined;
  lifecycleError?: string | undefined;
};

function draftReadyResult(input: DraftReadyResultInput): ManagedResult {
  return {
    status: "pr_ready",
    ticketId: input.ticketId,
    planHash: input.planHash,
    runFile: input.runFile,
    url: input.url,
    ...(input.trackerError ? { trackerError: input.trackerError } : {}),
    ...(input.notificationError ? { notificationError: input.notificationError } : {}),
    ...(input.cleanupError ? { cleanupError: input.cleanupError } : {}),
    ...(input.lifecycleError ? { lifecycleError: input.lifecycleError } : {}),
  };
}

async function updateReadyState(tracker: TrackerAdapter, ticketId: string): Promise<string | undefined> {
  try {
    await transitionTicket({ tracker, ticketId, state: "ai_pr_ready" });
    return undefined;
  } catch {
    return "Draft PR was delivered but ticket status could not be updated";
  }
}

async function reconcileReadyState(tracker: TrackerAdapter, ticketId: string): Promise<string | undefined> {
  try {
    const ticket = await tracker.getTicket(ticketId);
    if (ticket.state === "ai_pr_ready") return undefined;
    if (ticket.state !== "ai_reviewing") return "Draft PR was delivered; ticket status needs manual recovery";
    return await updateReadyState(tracker, ticketId);
  } catch {
    return "Draft PR was delivered but ticket status could not be read or updated";
  }
}

async function releaseDeliveredClaim(claim: ActiveTicketClaim): Promise<string | undefined> {
  try {
    await finishTicketClaim(claim);
    return undefined;
  } catch {
    return "Draft PR is ready but the ticket claim could not be released";
  }
}

async function finalizeDraftReady(input: {
  options: ResumeManagedTicketOptions;
  claim: ActiveTicketClaim;
  workspace: ManagedWorkspace | undefined;
  ticketId: string;
  planHash: string;
  runFile: string;
  receipt: DraftReceipt;
  deliveryPersisted: boolean;
}): Promise<ManagedResult> {
  const { options, claim, workspace, ticketId, planHash, runFile, receipt, deliveryPersisted } = input;
  const trackerError = deliveryPersisted ? await reconcileReadyState(options.tracker, ticketId) : undefined;
  const notificationError = await notify(
    options,
    notificationEvent({ state: "ai_pr_ready", repository: options.repository, ticketId, url: receipt.url }),
  );
  const cleanupError = await cleanWorkspace(workspace);
  let lifecycleError: string | undefined;
  if (!deliveryPersisted) lifecycleError = "Draft PR was delivered but its receipt could not be saved";
  else if (!cleanupError && trackerError) {
    try {
      await leaveTicketClaim(claim);
    } catch {
      lifecycleError = "Draft PR is ready but the active execution could not be released";
    }
  } else if (!trackerError && !cleanupError) lifecycleError = await releaseDeliveredClaim(claim);
  return draftReadyResult({
    ticketId,
    planHash,
    runFile,
    url: receipt.url,
    trackerError,
    notificationError,
    cleanupError,
    lifecycleError,
  });
}

function deliveryPendingResult(input: {
  ticketId: string;
  planHash: string;
  runFile: string;
  url?: string;
  cleanupError?: string;
  lifecycleError?: string;
}): ManagedResult {
  return {
    status: "delivery_pending",
    ticketId: input.ticketId,
    planHash: input.planHash,
    runFile: input.runFile,
    deliveryError: "Draft PR delivery is incomplete and requires safe recovery",
    ...(input.url ? { url: input.url } : {}),
    ...(input.cleanupError ? { cleanupError: input.cleanupError } : {}),
    ...(input.lifecycleError ? { lifecycleError: input.lifecycleError } : {}),
  };
}

async function handleUnknownDraft(input: {
  workspace: ManagedWorkspace | undefined;
  ticketId: string;
  planHash: string;
  runFile: string;
  commit: string;
}): Promise<ManagedResult> {
  const persisted = await persistUnknownDraft(input.runFile, input.commit);
  const cleanupError = await cleanWorkspace(input.workspace);
  return deliveryPendingResult({
    ticketId: input.ticketId,
    planHash: input.planHash,
    runFile: input.runFile,
    ...(cleanupError ? { cleanupError } : {}),
    lifecycleError: persisted
      ? "Draft creation status is unknown; inspect the remote branch before manual recovery"
      : "Draft creation status is unknown and recovery metadata could not be saved",
  });
}

async function deliverReviewedRun(input: {
  options: ResumeManagedTicketOptions;
  runFile: string;
  workspace: ManagedWorkspace;
  result: OrchestrationResult;
  claim: ActiveTicketClaim;
}): Promise<ManagedResult> {
  const { options, runFile, workspace, result, claim } = input;
  const runState = await getRunState(runFile);
  const ticket = await options.tracker.getTicket(result.ticketId);
  const review = await loadReview(runState);
  let prepared: Awaited<ReturnType<typeof prepareDraft>>;
  try {
    prepared = await prepareDraft({
      options: deliveryOptions(options),
      workspace,
      runFile,
      outputDirectory: runState.outputDirectory,
      ticket,
      reviewedDiffHash: result.reviewedDiffHash,
      review,
    });
  } catch (error) {
    if (error instanceof DraftCreationUnknownError) {
      return handleUnknownDraft({
        workspace,
        ticketId: ticket.id,
        planHash: result.planHash,
        runFile,
        commit: error.commit,
      });
    }
    throw error;
  }
  const deliveryPersisted = await persistReceipt(runFile, prepared.receipt);
  return finalizeDraftReady({
    options,
    claim,
    workspace,
    ticketId: ticket.id,
    planHash: result.planHash,
    runFile,
    receipt: prepared.receipt,
    deliveryPersisted,
  });
}

type WorkspaceHolder = { value: ManagedWorkspace | undefined };

async function executeApprovedRun(input: {
  options: ResumeManagedTicketOptions;
  roots: Awaited<ReturnType<typeof configuredRoots>>;
  runFile: string;
  ticketId: string;
  holder: WorkspaceHolder;
}): Promise<OrchestrationResult> {
  const { options, roots, runFile, ticketId, holder } = input;
  holder.value = await createWorkspace({ repository: options.repository, worktreeRoot: roots.worktreeRoot, ticketId });
  return resumeTicket({
    ...managedOptions(options, managedTracker(options.tracker)),
    runFile,
    factoryRoot: roots.factoryRoot,
    builderWorkspace: holder.value.path,
    maxAttempts: configuredAttempts(options.repository, options.factory),
    baseBranch: holder.value.baseCommit,
    logDirectory: logDirectory(dirname(runFile)),
  });
}

async function finishUnreviewedRun(input: {
  options: ResumeManagedTicketOptions;
  active: ActiveTicketClaim;
  ticketId: string;
  planHash: string;
  runFile: string;
  orchestration: OrchestrationResult;
  workspace: WorkspaceHolder;
}): Promise<ManagedResult> {
  const { options, active, ticketId, planHash, runFile, orchestration, workspace } = input;
  const cleanupError = await cleanWorkspace(workspace.value);
  workspace.value = undefined;
  if (orchestration.status === "needs_approval") {
    if (!cleanupError) await leaveTicketClaim(active);
    return { status: "needs_approval", ticketId, planHash, runFile, ...(cleanupError ? { cleanupError } : {}) };
  }
  const notificationError = await notify(
    options,
    notificationEvent({ state: "ai_failed", repository: options.repository, ticketId }),
  );
  if (!cleanupError && (await terminalState(options.tracker, ticketId))) await finishTicketClaim(active);
  return {
    status: orchestration.status === "changes_requested" ? "changes_requested" : "failed",
    ticketId,
    planHash,
    runFile,
    ...(cleanupError ? { cleanupError } : {}),
    ...(notificationError ? { notificationError } : {}),
  };
}

async function failManagedRun(input: {
  options: ResumeManagedTicketOptions;
  active: ActiveTicketClaim;
  ticketId: string;
  planHash: string;
  runFile: string;
  workspace: WorkspaceHolder;
}): Promise<ManagedResult> {
  const { options, active, ticketId, planHash, runFile, workspace } = input;
  const stateSaved = await markManagedFailure(options.tracker, ticketId);
  const cleanupError = await cleanWorkspace(workspace.value);
  const notificationError = await notify(
    options,
    notificationEvent({ state: "ai_failed", repository: options.repository, ticketId }),
  );
  if (stateSaved && !cleanupError) await finishTicketClaim(active);
  return {
    status: "failed",
    ticketId,
    planHash,
    runFile,
    ...(cleanupError ? { cleanupError } : {}),
    ...(!stateSaved ? { lifecycleError: "Ticket state update failed; claim retained" } : {}),
    ...(notificationError ? { notificationError } : {}),
  };
}

async function resumeApprovedRun(input: {
  options: ResumeManagedTicketOptions;
  roots: Awaited<ReturnType<typeof configuredRoots>>;
  active: ActiveTicketClaim;
  runFile: string;
  record: ManagedRecord;
  ticketId: string;
}): Promise<ManagedResult> {
  const { options, roots, active, runFile, record, ticketId } = input;
  const holder: WorkspaceHolder = { value: undefined };
  try {
    const orchestration = await executeApprovedRun({ options, roots, runFile, ticketId, holder });
    if (orchestration.status === "reviewed" && holder.value) {
      return await deliverReviewedRun({
        options,
        runFile,
        workspace: holder.value,
        result: orchestration,
        claim: active,
      });
    }
    return finishUnreviewedRun({
      options,
      active,
      ticketId,
      planHash: record.planHash,
      runFile,
      orchestration,
      workspace: holder,
    });
  } catch {
    return failManagedRun({ options, active, ticketId, planHash: record.planHash, runFile, workspace: holder });
  }
}

async function resumeCompletedReceipt(input: {
  options: ResumeManagedTicketOptions;
  active: ActiveTicketClaim;
  runFile: string;
  record: ManagedRecord;
}): Promise<ManagedResult> {
  const { options, active, runFile, record } = input;
  if (!record.delivery?.url || !record.delivery.number) {
    await leaveTicketClaim(active);
    throw new Error("Managed Draft PR receipt is incomplete");
  }
  return finalizeDraftReady({
    options,
    claim: active,
    workspace: undefined,
    ticketId: record.ticketId,
    planHash: record.planHash,
    runFile,
    receipt: { url: record.delivery.url, number: record.delivery.number, commit: record.delivery.commit },
    deliveryPersisted: true,
  });
}
export async function resumeManagedTicket(options: ResumeManagedTicketOptions): Promise<ManagedResult> {
  const roots = await configuredRoots(options);
  const { runFile, record } = await validateManagedRun({ options, roots, loadState: getRunState });
  if (record.delivery?.status === "unknown") {
    return deliveryPendingResult({
      ticketId: record.ticketId,
      planHash: record.planHash,
      runFile,
      lifecycleError: "Draft creation status is unknown; inspect the remote branch before manual recovery",
    });
  }
  const active = await enterTicketClaim(record.claim);
  if (record.delivery?.status === "complete") {
    return resumeCompletedReceipt({ options, active, runFile, record });
  }
  let ticket: Ticket;
  let approval: Awaited<ReturnType<TrackerAdapter["getApproval"]>>;
  try {
    ticket = await options.tracker.getTicket(record.ticketId);
    approval = await options.tracker.getApproval({ ticketId: ticket.id, planHash: record.planHash });
  } catch {
    await leaveTicketClaim(active);
    throw new Error("Unable to read ticket approval state; managed claim remains available for retry");
  }
  if (!approval) {
    await leaveTicketClaim(active);
    return { status: "needs_approval", ticketId: ticket.id, planHash: record.planHash, runFile };
  }
  return resumeApprovedRun({ options, roots, active, runFile, record, ticketId: ticket.id });
}
