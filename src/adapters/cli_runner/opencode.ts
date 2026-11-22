// ============================================================
// opencode.ts
// Purpose : Invoke OpenCode CLI and parse its JSON event stream
// Feature : Agent execution
// Role    : CLI Runner Adapter
// API Doc : https://opencode.ai/docs/cli/
// ============================================================
import { count, getRecord, parseJsonLines, price } from "@/adapters/cli_runner/events";
import { cliEnvironment, type CliInvocation, type CliRequest, type CliUsage } from "@/adapters/cli_runner/types";

export function createOpenCodeInvocation(request: CliRequest): CliInvocation {
  if (request.egressConfigPath && request.apiKey) {
    throw new Error("OpenCode egress mode cannot receive a provider API key");
  }
  const args = ["run", "--format", "json", "--model", `${request.provider}/${request.model}`, request.prompt];
  const configDir = request.scratchDirectory ? `${request.scratchDirectory}/opencode-config` : undefined;
  const configEnv: NodeJS.ProcessEnv = {};
  if (request.egressConfigPath) configEnv.OPENCODE_CONFIG = request.egressConfigPath;
  else if (configDir) configEnv.OPENCODE_CONFIG_DIR = configDir;
  return {
    command: "opencode",
    args,
    cwd: request.workspace,
    env: cliEnvironment(request, "OPENCODE_API_KEY", {
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ...configEnv,
    }),
  };
}

export function parseOpenCodeOutput(output: string): CliUsage {
  let text = "";
  let tokensUsed: number | null = null;
  let costUsd: number | null = null;
  for (const event of parseJsonLines(output)) {
    const parsed = parseOpenCodeEvent(event);
    text += parsed.text;
    if (parsed.tokens !== null) tokensUsed = (tokensUsed ?? 0) + parsed.tokens;
    if (parsed.cost !== null) costUsd = (costUsd ?? 0) + parsed.cost;
  }
  return { text, tokensUsed, costUsd };
}

function parseOpenCodeEvent(event: Record<string, unknown>): {
  text: string;
  tokens: number | null;
  cost: number | null;
} {
  const part = getRecord(event.part);
  if (event.type === "text" && typeof part?.text === "string") return { text: part.text, tokens: null, cost: null };
  if (event.type !== "step_finish" || !part) return { text: "", tokens: null, cost: null };
  const usage = getRecord(part.tokens);
  const tokens = usage ? tokenTotal(usage) : null;
  const cost = Object.hasOwn(part, "cost") ? price(part.cost) : null;
  if (Object.hasOwn(part, "cost") && cost === null) throw new Error("OpenCode returned malformed cost usage");
  return { text: "", tokens, cost };
}

function tokenTotal(usage: Record<string, unknown>): number {
  const input = count(usage.input);
  const output = count(usage.output);
  if (input === null || output === null) throw new Error("OpenCode returned malformed token usage");
  return input + output;
}
