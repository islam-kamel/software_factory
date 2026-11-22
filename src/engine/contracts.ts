// ============================================================
// contracts.ts
// Purpose : Define and validate the shared ticket and agent result contracts
// Feature : Core contracts
// Role    : Domain Service
// API Doc : docs/system_design.md, Standard Data Contracts
// ============================================================
import { z } from "zod";

const TicketStates = [
  "ai_ready",
  "ai_planning",
  "needs_approval",
  "ai_approved",
  "ai_building",
  "verifying",
  "ai_reviewing",
  "ai_pr_ready",
  "ai_failed",
] as const;

export const TicketSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    title: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    state: z.enum(TicketStates),
    author: z.string(),
    url: z.url(),
  })
  .strict();

export const AgentResultSchema = z
  .object({
    role: z.enum(["planner", "builder", "reviewer"]),
    status: z.enum(["success", "failed"]),
    provider_used: z.string(),
    model_used: z.string(),
    duration_seconds: z.number().nonnegative(),
    tokens_used: z.number().int().nonnegative().nullable(),
    estimated_cost_usd: z.number().nonnegative().nullable(),
    output_file: z.string(),
  })
  .strict();

export const VerificationResultSchema = z
  .object({
    passed: z.boolean(),
    attempt: z.number().int().positive(),
    failed_step: z.string().nullable(),
    summary: z.string(),
  })
  .strict();

export type Ticket = z.infer<typeof TicketSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

function describeIssues(label: string, error: z.ZodError): Error {
  const issues = error.issues.map((issue) => {
    const path = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : String(part))).join(".");
    return `${path || "<root>"} (${issue.code})`;
  });
  return new Error(`${label} validation failed: ${issues.join(", ")}`);
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw describeIssues(label, result.error);
  return result.data;
}

export function parseTicket(value: unknown): Ticket {
  return parseContract(TicketSchema, value, "Ticket");
}

export function parseAgentResult(value: unknown): AgentResult {
  return parseContract(AgentResultSchema, value, "AgentResult");
}

export function parseVerificationResult(value: unknown): VerificationResult {
  return parseContract(VerificationResultSchema, value, "VerificationResult");
}
