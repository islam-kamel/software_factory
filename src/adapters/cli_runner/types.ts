// ============================================================
// types.ts
// Purpose : Define shared inputs and outputs for CLI runner adapters
// Feature : Agent execution
// Role    : Adapter Contract
// API Doc : N/A
// ============================================================
export type AgentRole = "planner" | "builder" | "reviewer";
export type CliId = "opencode" | "agy" | "codex";
export type ContextMode = "repo_only" | "merge" | "factory_only";

export type CliRequest = {
  role: AgentRole;
  workspace: string;
  prompt: string;
  provider: string;
  model: string;
  access: "read_only" | "read_write";
  timeoutMs: number;
  contextMode: ContextMode;
  scratchDirectory?: string;
  apiKey?: string;
};

export type CliInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CliUsage = {
  text: string;
  tokensUsed: number | null;
  costUsd: number | null;
};

export type CliAdapterResult = CliUsage & {
  provider: string;
  model: string;
};

export function cliEnvironment(
  request: CliRequest,
  keyName?: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: request.scratchDirectory,
    ...(request.apiKey && keyName ? { [keyName]: request.apiKey } : {}),
    ...extra,
  };
}
