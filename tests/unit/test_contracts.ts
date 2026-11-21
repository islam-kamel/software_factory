// ============================================================
// test_contracts.ts
// Purpose : Verify the shared JSON contract validators
// Feature : Core contracts
// Role    : Unit Tests
// API Doc : docs/system_design.md, Standard Data Contracts
// ============================================================
import { expect, it } from "vitest";
import { parseAgentResult, parseTicket, parseVerificationResult } from "@/engine/contracts";

it("accepts the documented Ticket shape and rejects invalid lifecycle states", () => {
  const ticket = {
    id: "42",
    project: "ecommerce-api",
    title: "Return HTTP 400 on duplicate email signup",
    description: "Handle duplicate email.",
    acceptance_criteria: ["Return 400"],
    state: "ai_ready",
    author: "maintainer",
    url: "https://example.com/issues/42",
  };

  expect(parseTicket(ticket)).toEqual(ticket);
  expect(() => parseTicket({ ...ticket, state: "invented" })).toThrow(/state/);
});

it("reports malformed fields without echoing payload values", () => {
  let errorMessage = "";
  (() => {
    try {
      parseTicket({ id: "sensitive title", title: 1 });
    } catch (caught) {
      errorMessage = caught instanceof Error ? caught.message : "";
      return;
    }
    throw new Error("Expected contract validation to fail");
  })();

  expect(errorMessage).toMatch(/acceptance_criteria/);
  expect(errorMessage).not.toContain("sensitive title");
});

it("validates nullable agent telemetry without fabricating missing values", () => {
  const unknownTelemetry = {
    role: "planner",
    status: "success",
    provider_used: "codex",
    model_used: "configured-model",
    duration_seconds: 1,
    tokens_used: null,
    estimated_cost_usd: null,
    output_file: "/tmp/PLAN.md",
  };

  expect(parseAgentResult(unknownTelemetry)).toEqual(unknownTelemetry);
  expect(() => parseAgentResult({ ...unknownTelemetry, tokens_used: -1 })).toThrow(/tokens_used/);
  expect(() => parseAgentResult({ ...unknownTelemetry, estimated_cost_usd: -1 })).toThrow(/estimated_cost_usd/);
});

it("validates AgentResult and VerificationResult numeric fields", () => {
  const agentResult = {
    role: "builder",
    status: "success",
    provider_used: "opencode_go",
    model_used: "model",
    duration_seconds: 48,
    tokens_used: 14200,
    estimated_cost_usd: 0.02,
    output_file: "/tmp/output.md",
  };
  const verification = {
    passed: false,
    attempt: 1,
    failed_step: "unit_tests",
    summary: "One test failed",
  };

  expect(parseAgentResult(agentResult)).toEqual(agentResult);
  expect(parseVerificationResult(verification)).toEqual(verification);
  expect(() => parseAgentResult({ ...agentResult, duration_seconds: -1 })).toThrow(/duration_seconds/);
  expect(() => parseVerificationResult({ ...verification, attempt: 0 })).toThrow(/attempt/);
});
