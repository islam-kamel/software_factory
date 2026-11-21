// ============================================================
// contracts.ts
// Purpose : Define validated ticket and agent result contracts
// Feature : Core Contracts
// Role    : Domain Contract
// API Doc : docs/system_design.md
// ============================================================
import { z } from "zod";

export const TicketSchema = z
  .object({
    id: z.string().min(1),
    project: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    state: z.enum([
      "ai_ready",
      "ai_planning",
      "needs_approval",
      "ai_approved",
      "ai_building",
      "verifying",
      "ai_reviewing",
      "ai_pr_ready",
      "ai_failed",
    ]),
    author: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const AgentResultSchema = z
  .object({
    role: z.enum(["planner", "builder", "reviewer"]),
    status: z.string().min(1),
    provider_used: z.string().min(1),
    model_used: z.string().min(1),
    duration_seconds: z.number().finite().nonnegative(),
    tokens_used: z.number().int().nonnegative(),
    estimated_cost_usd: z.number().finite().nonnegative(),
    output_file: z.string().min(1),
  })
  .strict();

export const VerificationResultSchema = z
  .object({
    passed: z.boolean(),
    attempt: z.number().int().positive(),
    failed_step: z.string().min(1).nullable(),
    summary: z.string(),
  })
  .strict()
  .refine((result) => result.passed === (result.failed_step === null), {
    path: ["failed_step"],
    error: "must be null on success and named on failure",
  });

export type Ticket = z.infer<typeof TicketSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export function validateContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => issue.path.join(".") || "payload");
  throw new Error(`Invalid contract fields: ${[...new Set(fields)].join(", ")}`);
}
