// ============================================================
// test_cli_adapters.ts
// Purpose : Verify CLI routing and usage parsing
// Feature : Agent execution
// Role    : Unit Tests
// API Doc : src/adapters/cli_runner/types.ts
// ============================================================
import { expect, it } from "vitest";
import { createAgyInvocation, parseAgyOutput } from "@/adapters/cli_runner/agy";
import { createCodexInvocation, parseCodexOutput } from "@/adapters/cli_runner/codex";
import { createOpenCodeInvocation, parseOpenCodeOutput } from "@/adapters/cli_runner/opencode";
import type { CliRequest } from "@/adapters/cli_runner/types";

const request: CliRequest = {
  role: "planner",
  workspace: "/tmp/repo",
  prompt: "Inspect safely",
  provider: "openai",
  model: "gpt-test",
  access: "read_only",
  timeoutMs: 60_000,
  contextMode: "merge",
};

it("routes Codex to the configured model with native read-only controls", () => {
  const invocation = createCodexInvocation(request);

  expect(invocation.cwd).toBe(request.workspace);
  expect(invocation.args).toContain("read-only");
  expect(invocation.args).toContain("--skip-git-repo-check");
  expect(invocation.args).toContain("gpt-test");
  expect(invocation.args).toContain("project_doc_max_bytes=0");
});

it("routes Agy from the workspace with the selected model and bounded output", () => {
  const prompt = "--review\nliteral `value` and $HOME";
  const invocation = createAgyInvocation({ ...request, provider: "antigravity", prompt });

  expect(invocation.cwd).toBe(request.workspace);
  expect(invocation.args).toContain(`--print=${prompt}`);
  expect(invocation.args).toContain("json");
  expect(invocation.args).not.toContain(prompt);
  expect(invocation.args).toContain("--sandbox");
  expect(invocation.args).toContain("--model");
  expect(invocation.args).toContain("gpt-test");
  expect(invocation.args).toContain("--print-timeout");
  expect(invocation.args).toContain("60s");
  expect(invocation.args).not.toContain("--dangerously-skip-permissions");
});

it("enables Agy writes only for Builder requests", () => {
  const invocation = createAgyInvocation({ ...request, provider: "antigravity", access: "read_write" });

  expect(invocation.args).toContain("--dangerously-skip-permissions");
});

it("routes OpenCode to the exact configured provider/model", () => {
  const invocation = createOpenCodeInvocation({ ...request, provider: "openrouter" });

  expect(invocation.cwd).toBe(request.workspace);
  expect(invocation.args).toContain("openrouter/gpt-test");
  expect(invocation.args).toContain("--format");
});

it("uses Codex totals without adding cached or reasoning breakdowns", () => {
  const usage = parseCodexOutput(
    [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "review" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_tokens: 8 },
      }),
    ].join("\n"),
  );

  expect(usage).toEqual({ text: "review", tokensUsed: 120, costUsd: null });
});

it("uses OpenCode input/output totals and reports actual cost", () => {
  const usage = parseOpenCodeOutput(
    [
      JSON.stringify({ type: "text", part: { text: "plan" } }),
      JSON.stringify({
        type: "step_finish",
        part: { cost: 0.05, tokens: { input: 100, output: 20, reasoning: 8, cache: { read: 40, write: 10 } } },
      }),
    ].join("\n"),
  );

  expect(usage).toEqual({ text: "plan", tokensUsed: 120, costUsd: 0.05 });
});

it("parses the documented Agy JSON envelope including pretty JSON", () => {
  const output = `{
    "status": "SUCCESS",
    "response": "plan text",
    "duration_seconds": 3.2,
    "usage": { "input_tokens": 8, "output_tokens": 2, "total_tokens": 10 }
  }`;

  expect(parseAgyOutput(output)).toEqual({ text: "plan text", tokensUsed: 10, costUsd: null });
});

it("rejects Agy error, missing status, and malformed response without exposing payload", () => {
  const invalid = [
    { status: "ERROR", response: "should not be accepted", usage: { total_tokens: 0 } },
    { status: "WAITING", response: "nonterminal status", usage: { total_tokens: 0 } },
    { response: "missing status", usage: { total_tokens: 0 } },
    { status: "SUCCESS", response: { text: "not a string" }, usage: { total_tokens: 0 } },
  ];

  for (const envelope of invalid) expect(() => parseAgyOutput(JSON.stringify(envelope))).toThrow();
});

it("rejects malformed Agy token usage", () => {
  const output = JSON.stringify({ status: "SUCCESS", response: "done", usage: { total_tokens: -1 } });

  expect(() => parseAgyOutput(output)).toThrow();
});
