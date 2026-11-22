// ============================================================
// automation_delivery.ts
// Purpose : Verify reviewed worktrees and coordinate Draft PR adapter calls
// Feature : Phase 2 managed ticket lifecycle
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Managed Automation
// ============================================================
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitHost, type DraftReceipt, type GitHostAdapter } from "@/adapters/git_host/github";
import { assertDeliverySnapshot, prepareCommit } from "@/adapters/git_host/delivery_git";
import { assertProtectedDiff, createVerifier } from "@/self_healing/verifier";
import type { VerifyFunction } from "@/engine/orchestrator";
import { getRunState } from "@/engine/orchestrator";
import { getResourceLimits, type FactoryConfig, type ResolvedRepository } from "@/engine/config_schemas";
import type { Ticket, VerificationResult } from "@/engine/contracts";
import type { ManagedWorkspace } from "@/engine/workspace";
import { getWorkspaceDiff } from "@/adapters/cli_runner/workspace";

export type DeliveryOptions = {
  repository: ResolvedRepository;
  factory: FactoryConfig;
  verifier?: VerifyFunction;
  gitHost?: GitHostAdapter;
  secrets?: ReadonlyMap<string, string>;
  timeoutMs: number;
};

async function assertReviewedSnapshot(
  workspace: ManagedWorkspace,
  repository: ResolvedRepository,
  expectedHash: string | undefined,
): Promise<void> {
  const diff = await getWorkspaceDiff({
    workspace: workspace.path,
    ignorePaths: repository.privacy.ignore_paths ?? [],
    baseBranch: workspace.baseCommit,
  });
  const actualHash = createHash("sha256").update(diff, "utf8").digest("hex");
  if (!expectedHash || expectedHash !== actualHash) throw new Error("Reviewed worktree changed before delivery");
}

async function verifyDelivery(input: {
  options: DeliveryOptions;
  workspace: ManagedWorkspace;
  outputDirectory: string;
}): Promise<VerificationResult> {
  const { options, workspace, outputDirectory } = input;
  if (!options.repository.verification?.secret_scan?.trim()) {
    throw new Error("Managed delivery requires a configured secret scan");
  }
  const verify: VerifyFunction = options.verifier ?? createVerifier();
  return verify({
    repository: options.repository,
    workspace: workspace.path,
    attempt: 1,
    timeoutMs: options.timeoutMs,
    resourceLimits: getResourceLimits(options.factory.limits),
    baseBranch: workspace.baseCommit,
    logDirectory: join(outputDirectory, "verification-logs"),
  });
}

async function assertDeliveryGate(repository: ResolvedRepository, workspace: ManagedWorkspace): Promise<void> {
  await assertProtectedDiff({ repository, workspace: workspace.path, baseBranch: workspace.baseCommit });
}

async function verifyAndCommit(input: {
  options: DeliveryOptions;
  workspace: ManagedWorkspace;
  outputDirectory: string;
  ticketId: string;
  reviewedDiffHash: string | undefined;
}): Promise<{ commit: string; verification: VerificationResult }> {
  const { options, workspace, outputDirectory, ticketId, reviewedDiffHash } = input;
  await assertReviewedSnapshot(workspace, options.repository, reviewedDiffHash);
  await assertDeliveryGate(options.repository, workspace);
  const beforeCommit = await verifyDelivery({ options, workspace, outputDirectory });
  if (!beforeCommit.passed) throw new Error("Final committed-content verification failed");
  await assertDeliveryGate(options.repository, workspace);
  await assertReviewedSnapshot(workspace, options.repository, reviewedDiffHash);
  const commit = await prepareCommit({
    workspace: workspace.path,
    branch: workspace.branch,
    message: `feat: automate ${ticketId}`,
  });
  const verification = await verifyDelivery({ options, workspace, outputDirectory });
  if (!verification.passed) throw new Error("Committed-content verification failed");
  await assertDeliveryGate(options.repository, workspace);
  await assertDeliverySnapshot({ workspace: workspace.path, branch: workspace.branch, commit });
  return { commit, verification };
}

function selectHost(options: DeliveryOptions): GitHostAdapter {
  return (
    options.gitHost ??
    createGitHost({
      factory: options.factory,
      repository: options.repository,
      ...(options.secrets ? { secrets: options.secrets } : {}),
    })
  );
}

export async function prepareDraft(input: {
  options: DeliveryOptions;
  workspace: ManagedWorkspace;
  runFile: string;
  outputDirectory: string;
  ticket: Ticket;
  reviewedDiffHash: string | undefined;
  review: string;
}): Promise<{ receipt: DraftReceipt; verification: VerificationResult }> {
  const { options, workspace, runFile, outputDirectory, ticket, reviewedDiffHash, review } = input;
  const prepared = await verifyAndCommit({
    options,
    workspace,
    outputDirectory,
    ticketId: ticket.id,
    reviewedDiffHash,
  });
  const state = await getRunState(runFile);
  const receipt = await selectHost(options).openDraft({
    repository: options.repository,
    workspace: workspace.path,
    branch: workspace.branch,
    baseBranch: options.repository.base_branch ?? "main",
    commit: prepared.commit,
    ticket,
    plan: await readFile(state.planFile, "utf8"),
    verification: prepared.verification,
    review,
  });
  return { receipt, verification: prepared.verification };
}
