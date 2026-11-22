// ============================================================
// automation_state.ts
// Purpose : Persist and validate private managed-run sidecar metadata
// Feature : Phase 2 managed ticket lifecycle
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Managed Automation
// ============================================================
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { OrchestrationResult } from "@/engine/orchestrator";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { TicketClaim } from "@/engine/state_manager";

const ManagedDeliverySchema = z
  .object({
    status: z.enum(["complete", "unknown"]).default("complete"),
    url: z.url({ protocol: /^https$/ }).optional(),
    number: z.number().int().positive().optional(),
    commit: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
  })
  .strict()
  .superRefine((delivery, context) => {
    const hasReceipt = Boolean(delivery.url && delivery.number);
    if (delivery.status === "unknown" && hasReceipt) {
      context.addIssue({ code: "custom", message: "Unknown delivery cannot contain a Draft PR receipt" });
    }
    if (delivery.status === "complete" && !hasReceipt) {
      context.addIssue({ code: "custom", message: "Known delivery requires a complete Draft PR receipt" });
    }
  });

const ManagedRecordSchema = z
  .object({
    version: z.literal(1),
    repositoryId: z.string().min(1),
    repositoryPath: z.string().min(1),
    ticketId: z.string().min(1),
    runFile: z.string().min(1),
    planHash: z.string().regex(/^[a-f\d]{64}$/i),
    claim: z
      .object({
        root: z.string().min(1),
        repository: z.string().min(1),
        ticketId: z.string().min(1),
        token: z.string().regex(/^[a-f\d]{64}$/),
      })
      .strict(),
    delivery: ManagedDeliverySchema.optional(),
  })
  .strict();

export type ManagedRecord = z.infer<typeof ManagedRecordSchema>;
type ManagedRunState = {
  factoryRoot: string;
  repositoryId: string;
  repositoryPath: string;
  workspace: string;
  phase: string;
  ticketId: string;
  planHash: string;
};
type ManagedRunOptions = { runFile: string; repository: { id: string } };
type ManagedRoots = { repositoryPath: string; factoryRoot: string; claimRoot: string };

export function createManagedRecord(
  result: OrchestrationResult,
  repository: ResolvedRepository,
  claim: TicketClaim,
): ManagedRecord {
  return ManagedRecordSchema.parse({
    version: 1,
    repositoryId: repository.id,
    repositoryPath: claim.repository,
    ticketId: result.ticketId,
    runFile: result.runFile,
    planHash: result.planHash,
    claim: { root: claim.root, repository: claim.repository, ticketId: claim.ticketId, token: claim.token },
  });
}

export async function readManagedRecord(runFile: string): Promise<ManagedRecord> {
  const path = join(dirname(runFile), "managed.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Managed run metadata is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Managed run metadata is invalid");
  }
  return ManagedRecordSchema.parse(value);
}

export async function writeManagedRecord(runFile: string, record: ManagedRecord): Promise<void> {
  const path = join(dirname(runFile), "managed.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(ManagedRecordSchema.parse(record))}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function persistManagedDelivery(
  runFile: string,
  delivery: NonNullable<ManagedRecord["delivery"]>,
): Promise<boolean> {
  try {
    const record = await readManagedRecord(runFile);
    await writeManagedRecord(runFile, { ...record, delivery });
    return true;
  } catch {
    return false;
  }
}

function matchesManagedRun(input: {
  options: ManagedRunOptions;
  roots: ManagedRoots;
  record: ManagedRecord;
  state: ManagedRunState;
  runFile: string;
}): boolean {
  const { options, roots, record, state, runFile } = input;
  const matchesRecord = [
    record.repositoryId === options.repository.id,
    record.repositoryPath === roots.repositoryPath,
    record.ticketId === state.ticketId,
    record.planHash === state.planHash,
    record.runFile === runFile,
  ].every(Boolean);
  const matchesClaim = [
    record.claim.root === roots.claimRoot,
    record.claim.repository === roots.repositoryPath,
    record.claim.ticketId === state.ticketId,
  ].every(Boolean);
  const matchesState = [
    state.factoryRoot === roots.factoryRoot,
    state.repositoryId === options.repository.id,
    state.repositoryPath === roots.repositoryPath,
    state.workspace === roots.repositoryPath,
    state.phase === "needs_approval" || (state.phase === "reviewed" && record.delivery?.status === "unknown"),
  ].every(Boolean);
  return matchesRecord && matchesClaim && matchesState;
}

export async function validateManagedRun<State extends ManagedRunState>(input: {
  options: ManagedRunOptions;
  roots: ManagedRoots;
  loadState: (runFile: string) => Promise<State>;
}): Promise<{ runFile: string; record: ManagedRecord; state: State }> {
  const runFile = await realpath(input.options.runFile);
  const record = await readManagedRecord(runFile);
  const state = await input.loadState(runFile);
  if (!matchesManagedRun({ ...input, record, state, runFile })) {
    throw new Error("Managed run does not match the configured repository and approval state");
  }
  return { runFile, record, state };
}
