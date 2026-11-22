// ============================================================
// types.ts
// Purpose : Define the common ticket tracker adapter contract
// Feature : Ticket tracking
// Role    : Adapter Interface
// API Doc : docs/system_design.md, Ticket Contract
// ============================================================
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { Ticket } from "@/engine/contracts";

export type Approval = { author: string; planHash: string };

export type TrackerAdapter = {
  listReadyTickets(): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket>;
  publishPlan(input: { ticketId: string; plan: string; planHash: string }): Promise<void>;
  getApproval(input: { ticketId: string; planHash: string }): Promise<Approval | null>;
  updateState(input: { ticketId: string; state: Ticket["state"] }): Promise<void>;
};

export type LocalMarkdownTrackerOptions = {
  repository: ResolvedRepository;
  ticketsDirectory?: string;
};

export type GitHubTrackerOptions = {
  repository: ResolvedRepository;
  token: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

export function allowedApprover(repository: ResolvedRepository, author: string): boolean {
  const approvers = repository.tracker.allowed_approvers ?? [];
  return approvers.some((approver) => approver.toLowerCase() === author.toLowerCase());
}

export function approvalCommand(repository: ResolvedRepository): string {
  return repository.approval_command ?? "/approve";
}

export function validatePlanHash(planHash: string): void {
  if (!/^[a-f\d]{64}$/i.test(planHash)) throw new Error("Plan hash must be a SHA-256 hex digest");
}
