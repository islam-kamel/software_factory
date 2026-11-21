// ============================================================
// contracts.test.ts
// Purpose : Verify public data contract validation behavior
// Feature : Core Contracts
// Role    : Unit Test
// API Doc : docs/system_design.md
// ============================================================
import { describe, expect, it } from "vitest";
import {
  AgentResultSchema,
  TicketSchema,
  validateContract,
  VerificationResultSchema,
} from "../../src/engine/contracts.js";

describe("standard contracts", () => {
  it("accepts canonical example payloads", () => {
    expect(
      TicketSchema.safeParse({
        id: "42",
        project: "ecommerce-api",
        title: "Fix duplicate signup",
        description: "Return an error when email exists.",
        acceptance_criteria: ["Return status 400"],
        state: "ai_ready",
        author: "owner",
        url: "https://example.com/issues/42",
      }).success,
    ).toBe(true);
    expect(
      AgentResultSchema.safeParse({
        role: "builder",
        status: "success",
        provider_used: "openrouter",
        model_used: "example-model",
        duration_seconds: 48,
        tokens_used: 14200,
        estimated_cost_usd: 0.02,
        output_file: "/tmp/output.md",
      }).success,
    ).toBe(true);
    expect(
      VerificationResultSchema.safeParse({
        passed: false,
        attempt: 1,
        failed_step: "unit_tests",
        summary: "Test failed.",
      }).success,
    ).toBe(true);
  });
});

describe("invalid contracts", () => {
  it("reports invalid contract fields without echoing values", () => {
    let diagnostic = "";
    try {
      validateContract(TicketSchema, { id: 7, title: "SECRET_VALUE" });
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : "";
    }
    expect(diagnostic).toBe(
      "Invalid contract fields: id, project, description, acceptance_criteria, state, author, url",
    );
    expect(diagnostic).not.toContain("SECRET_VALUE");
  });

  it("rejects inconsistent verification result status", () => {
    expect(
      VerificationResultSchema.safeParse({
        passed: true,
        attempt: 1,
        failed_step: "test",
        summary: "Passed.",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed agent and verification fields with field paths", () => {
    const agent = AgentResultSchema.safeParse({ role: "unknown", status: "success" });
    expect(agent.success).toBe(false);
    if (!agent.success) expect(JSON.stringify(agent.error.issues)).toContain("role");

    const verification = VerificationResultSchema.safeParse({
      passed: false,
      attempt: -1,
      failed_step: null,
      summary: "Invalid attempt.",
    });
    expect(verification.success).toBe(false);
    if (!verification.success) expect(JSON.stringify(verification.error.issues)).toContain("attempt");
  });
});
