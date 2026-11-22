// ============================================================
// retry_loop.ts
// Purpose : Retry verification with bounded Builder repair attempts
// Feature : Phase 2 self-healing
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Error Parser & Self-Healing Retry Loop
// ============================================================
import { parseVerificationResult, type VerificationResult } from "@/engine/contracts";
import { parseErrorSummary } from "@/self_healing/error_parser";

type VerificationLoopOptions = {
  maxAttempts?: number;
  verify: (attempt: number) => Promise<VerificationResult>;
  repair: (failure: VerificationResult) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const HARD_FAILURE_STEPS = new Set(["configuration", "secret_scan", "protected_files", "logging"]);

export async function runVerificationLoop(options: VerificationLoopOptions): Promise<VerificationResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const verification = await options.verify(attempt);
    const result = parseVerificationResult(verification);
    if (result.attempt !== attempt) throw new Error("Verifier returned a mismatched attempt number");
    if (result.passed || attempt === maxAttempts || HARD_FAILURE_STEPS.has(result.failed_step ?? ""))
      return verification;
    await options.repair({ ...result, summary: parseErrorSummary(result.summary) });
  }

  throw new Error("Verification loop ended without a result");
}
