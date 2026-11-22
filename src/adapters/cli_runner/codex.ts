// ============================================================
// codex.ts
// Purpose : Invoke Codex CLI and parse its JSONL usage events
// Feature : Agent execution
// Role    : CLI Runner Adapter
// API Doc : https://github.com/openai/codex
// ============================================================
import { count, getRecord, parseJsonLines } from "@/adapters/cli_runner/events";
import { cliEnvironment, type CliInvocation, type CliRequest, type CliUsage } from "@/adapters/cli_runner/types";

export function createCodexInvocation(request: CliRequest): CliInvocation {
  if (request.provider !== "openai") throw new Error("Codex CLI requires the openai provider");
  const sandbox = request.access === "read_only" ? "read-only" : "workspace-write";
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--cd",
    request.workspace,
    "--sandbox",
    sandbox,
    "--ask-for-approval",
    "never",
    "--json",
    "--model",
    request.model,
    "-c",
    "project_doc_max_bytes=0",
    request.prompt,
  ];
  return {
    command: "codex",
    args,
    cwd: request.workspace,
    env: cliEnvironment(request, "OPENAI_API_KEY"),
  };
}

export function parseCodexOutput(output: string): CliUsage {
  let text = "";
  let tokensUsed: number | null = null;
  for (const event of parseJsonLines(output)) {
    const item = getRecord(event.item);
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      text += item.text;
    }
    if (event.type === "turn.completed") {
      const usage = getRecord(event.usage);
      if (!usage) continue;
      const input = count(usage.input_tokens);
      const outputTokens = count(usage.output_tokens);
      if (input === null || outputTokens === null) throw new Error("Codex returned malformed token usage");
      tokensUsed = input + outputTokens;
    }
  }
  return { text, tokensUsed, costUsd: null };
}
