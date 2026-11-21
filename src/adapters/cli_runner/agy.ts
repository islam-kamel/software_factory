// ============================================================
// agy.ts
// Purpose : Invoke Antigravity CLI and parse structured output
// Feature : Agent execution
// Role    : CLI Runner Adapter
// API Doc : https://github.com/google-antigravity/antigravity-cli
// ============================================================
import { count, getRecord } from "@/adapters/cli_runner/events";
import { cliEnvironment, type CliInvocation, type CliRequest, type CliUsage } from "@/adapters/cli_runner/types";

export function createAgyInvocation(request: CliRequest): CliInvocation {
  if (request.provider !== "antigravity") throw new Error("Agy CLI requires the antigravity provider");
  const timeout = `${Math.ceil(request.timeoutMs / 1000)}s`;
  const args = [
    `--print=${request.prompt}`,
    "--output-format",
    "json",
    "--print-timeout",
    timeout,
    "--sandbox",
    "--model",
    request.model,
  ];
  if (request.access === "read_write") args.push("--dangerously-skip-permissions");
  return {
    command: "agy",
    args,
    cwd: request.workspace,
    env: cliEnvironment(request, "GOOGLE_API_KEY"),
  };
}

export function parseAgyOutput(output: string): CliUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Agy returned malformed JSON output");
  }
  const result = successfulResponse(parsed);
  return { ...result, costUsd: null };
}

function successfulResponse(parsed: unknown): { text: string; tokensUsed: number | null } {
  const envelope = getRecord(parsed);
  if (!envelope || envelope.status !== "SUCCESS" || typeof envelope.response !== "string")
    throw new Error("Agy did not return a successful response");
  const usage = envelope.usage === undefined ? undefined : getRecord(envelope.usage);
  if (envelope.usage !== undefined && !usage) throw new Error("Agy returned malformed token usage");
  const tokensUsed = usage ? count(usage.total_tokens) : null;
  if (usage && tokensUsed === null) throw new Error("Agy returned malformed token usage");
  return { text: envelope.response, tokensUsed };
}
