// ============================================================
// run_agent.ts
// Purpose : Resolve a configured repository and run one agent role
// Feature : Agent execution
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Phase 1
// ============================================================
import { createAgyInvocation, parseAgyOutput } from "@/adapters/cli_runner/agy";
import { createCodexInvocation, parseCodexOutput } from "@/adapters/cli_runner/codex";
import { createOpenCodeInvocation, parseOpenCodeOutput } from "@/adapters/cli_runner/opencode";
import { runSandboxed } from "@/adapters/cli_runner/sandbox";
import { assertBuilderWorkspace, assertRepositoryWorkspace } from "@/adapters/cli_runner/workspace";
import type { CliRequest } from "@/adapters/cli_runner/types";
import { AgentResultSchema, type AgentResult } from "@/engine/contracts";
import { loadConfig } from "@/engine/config_loader";
import {
  RepositoriesConfigSchema,
  type FactoryConfig,
  type ModelsConfig,
  type ResolvedRepository,
} from "@/engine/config_schemas";
import { isIgnoredPath } from "@/engine/context_builder";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export type RunAgentOptions = {
  role: "planner" | "builder" | "reviewer";
  workspace: string;
  promptPath: string;
  outputDirectory: string;
  repoId?: string;
  configDirectory?: string;
};

const RoleSchema = z
  .object({
    access: z.enum(["read_only", "read_write"]),
    prompt_file: z.string().min(1),
    output_file: z.string().min(1),
  })
  .strict();

type AgentRole = RunAgentOptions["role"];
type RoleMetadata = z.infer<typeof RoleSchema>;
const artifactNames: Record<AgentRole, string> = {
  planner: "PLAN.md",
  builder: "BUILDER_SUMMARY.md",
  reviewer: "REVIEW_REPORT.md",
};

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path));
}

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
    logLevel: "silent",
  });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("Invalid configuration YAML");
  return document.toJS();
}

async function resolveRepositoryId(configDirectory: string, workspace: string): Promise<string> {
  let config: z.infer<typeof RepositoriesConfigSchema>;
  try {
    config = RepositoriesConfigSchema.parse(parseYaml(await readFile(resolve(configDirectory, "repos.yaml"), "utf8")));
  } catch {
    throw new Error("Unable to resolve repository from configuration");
  }
  const matches: string[] = [];
  for (const repository of config.repos.filter((item) => item.enabled)) {
    try {
      if ((await realpath(repository.local_path)) === workspace) matches.push(repository.id);
    } catch {
      continue;
    }
  }
  if (matches.length !== 1 || !matches[0])
    throw new Error("Workspace must match exactly one enabled configured repository");
  return matches[0];
}

async function readRole(root: string, role: AgentRole): Promise<RoleMetadata> {
  const path = resolve(root, "src/agents", role, "role.yaml");
  try {
    const metadata = RoleSchema.parse(parseYaml(await readFile(path, "utf8")));
    const access = role === "builder" ? "read_write" : "read_only";
    if (metadata.access !== access || metadata.output_file !== artifactNames[role]) throw new Error();
    return metadata;
  } catch {
    throw new Error("Invalid metadata for agent role " + role);
  }
}

async function ensureOutputDirectory(workspace: string, requested: string): Promise<string> {
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const output = await realpath(requested);
  if (isInside(workspace, output) || isInside(output, workspace))
    throw new Error("Agent outputs must be outside the repository");
  if ((await readdir(output)).length > 0) throw new Error("Agent output directory must be empty");
  return output;
}

async function readPrompt(path: string, workspace: string, ignorePaths: string[]): Promise<string> {
  const actual = await realpath(path);
  if (isInside(workspace, actual) && isIgnoredPath(relative(workspace, actual).split(sep).join("/"), ignorePaths)) {
    throw new Error("Agent prompt cannot come from a privacy ignored path");
  }
  if (!(await lstat(actual)).isFile()) throw new Error("Agent prompt must be a regular file");
  return readFile(actual, "utf8");
}

function assertProviderRoute(cli: string, providerName: string, provider: ModelsConfig["providers"][string]): void {
  const nativeProvider = cli === "agy" ? "antigravity" : cli === "codex" ? "openai" : undefined;
  if (!nativeProvider) return;
  if (providerName !== nativeProvider || provider.auth_mode !== "cli" || provider.is_local) {
    throw new Error(cli + " CLI does not support the configured provider route");
  }
}

function selectedRoute(repository: ResolvedRepository, role: AgentRole, models: ModelsConfig) {
  const route = repository.agents[role];
  if (!["agy", "codex", "opencode"].includes(route.cli)) throw new Error("Unsupported CLI runner: " + route.cli);
  const provider = models.providers[route.provider];
  if (!provider) throw new Error("Selected agent provider is missing from models config");
  assertProviderRoute(route.cli, route.provider, provider);
  if (!route.model.trim()) throw new Error("Configured agent model must not be empty");
  return route;
}

function runnerFor(cli: string) {
  if (cli === "agy") return { create: createAgyInvocation, parse: parseAgyOutput };
  if (cli === "codex") return { create: createCodexInvocation, parse: parseCodexOutput };
  return { create: createOpenCodeInvocation, parse: parseOpenCodeOutput };
}

function timeoutMs(factory: FactoryConfig): number {
  const minutes = factory.limits?.agent_timeout_minutes ?? 15;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Invalid agent timeout");
  return Math.floor(minutes * 60_000);
}

function instructionFiles(repository: ResolvedRepository, workspace: string): string[] {
  const files = (repository.context?.repo_files ?? ["AGENTS.md"]).map((path) => resolve(workspace, path));
  if (process.env.HOME) {
    files.push(resolve(process.env.HOME, "AGENTS.md"));
    files.push(resolve(process.env.HOME, ".codex/AGENTS.md"));
    files.push(resolve(process.env.HOME, ".config/opencode/AGENTS.md"));
    files.push(resolve(process.env.HOME, ".gemini/GEMINI.md"));
  }
  return files;
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function failedResult(options: {
  role: AgentRole;
  repository: ResolvedRepository;
  outputFile: string;
  duration: number;
}): AgentResult {
  return AgentResultSchema.parse({
    role: options.role,
    status: "failed",
    provider_used: options.repository.agents[options.role].provider,
    model_used: options.repository.agents[options.role].model,
    duration_seconds: options.duration,
    tokens_used: null,
    estimated_cost_usd: null,
    output_file: options.outputFile,
  });
}

type PreparedAgentRun = {
  root: string;
  configDirectory: string;
  workspace: string;
  repository: ResolvedRepository;
  metadata: RoleMetadata;
  outputFile: string;
  resultFile: string;
  prompt: string;
  rolePrompt: string;
  route: ReturnType<typeof selectedRoute>;
  apiKey?: string;
  scratchDirectory: string;
  timeoutMs: number;
};

async function loadRepositoryConfig(options: RunAgentOptions, workspace: string) {
  const root = resolve(process.env.SOFTWARE_FACTORY_ROOT ?? process.cwd());
  const configDirectory = resolve(options.configDirectory ?? resolve(root, "config"));
  const repoId = options.repoId ?? (await resolveRepositoryId(configDirectory, workspace));
  const loaded = await loadConfig({
    factoryPath: resolve(configDirectory, "factory.yaml"),
    modelsPath: resolve(configDirectory, "models.yaml"),
    reposPath: resolve(configDirectory, "repos.yaml"),
    repoId,
  });
  const repository = loaded.config.repos.find((item) => item.id === repoId);
  if (!repository) throw new Error("Selected repository could not be loaded");
  return { root, configDirectory, loaded, repository };
}

async function prepareAgentRun(options: RunAgentOptions): Promise<PreparedAgentRun> {
  const workspace = await realpath(options.workspace);
  const config = await loadRepositoryConfig(options, workspace);
  const { root, configDirectory, loaded, repository } = config;
  if (options.role === "builder") await assertBuilderWorkspace({ workspace, repository: repository.local_path });
  else await assertRepositoryWorkspace({ workspace, repository: repository.local_path });

  const metadata = await readRole(root, options.role);
  const outputDirectory = await ensureOutputDirectory(workspace, options.outputDirectory);
  const outputFile = resolve(outputDirectory, metadata.output_file);
  const resultFile = resolve(outputDirectory, "AgentResult.json");
  const prompt = await readPrompt(options.promptPath, workspace, repository.privacy.ignore_paths ?? []);
  const promptFile = resolve(root, "src/agents", options.role, metadata.prompt_file);
  if (!isInside(resolve(root, "src/agents"), promptFile))
    throw new Error("Role prompt path escapes the agent directory");
  const rolePrompt = await readFile(promptFile, "utf8");
  const route = selectedRoute(repository, options.role, loaded.config.models);
  const provider = loaded.config.models.providers[route.provider];
  if (!provider) throw new Error("Selected provider is missing from models config");
  const apiKey = provider.api_key_env ? loaded.secrets.get(provider.api_key_env) : undefined;
  const scratch = await mkdtemp(resolve(tmpdir(), "software-factory-agent-"));
  const scratchDirectory = await realpath(scratch);
  if (isInside(workspace, scratchDirectory) || isInside(scratchDirectory, workspace))
    throw new Error("Agent scratch must be outside the workspace");
  return {
    root,
    configDirectory,
    workspace,
    repository,
    metadata,
    outputFile,
    resultFile,
    prompt,
    rolePrompt,
    route,
    ...(apiKey ? { apiKey } : {}),
    scratchDirectory,
    timeoutMs: timeoutMs(loaded.config.factory),
  };
}

async function executePreparedRun(options: RunAgentOptions, prepared: PreparedAgentRun): Promise<AgentResult> {
  const request: CliRequest = {
    role: options.role,
    workspace: prepared.workspace,
    prompt: prepared.rolePrompt + "\n\n" + prepared.prompt,
    provider: prepared.route.provider,
    model: prepared.route.model,
    access: prepared.metadata.access,
    timeoutMs: prepared.timeoutMs,
    contextMode: prepared.repository.context?.mode ?? "merge",
    scratchDirectory: prepared.scratchDirectory,
    ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
  };
  const runner = runnerFor(prepared.route.cli);
  const invocation = runner.create(request);
  const execution = await runSandboxed(invocation.command, invocation.args, {
    workspace: prepared.workspace,
    ignorePaths: prepared.repository.privacy.ignore_paths ?? [],
    access: prepared.metadata.access === "read_only" ? "read_only" : "workspace_write",
    timeoutMs: request.timeoutMs,
    scratchDirectory: prepared.scratchDirectory,
    blockedPaths: [
      ...instructionFiles(prepared.repository, prepared.workspace),
      prepared.configDirectory,
      dirname(prepared.resultFile),
    ],
    env: invocation.env,
  });
  if (execution.timedOut || execution.outputLimit || execution.exitCode !== 0)
    throw new Error("CLI execution did not complete successfully");
  const output = runner.parse(execution.stdout);
  if (!output.text.trim()) throw new Error("CLI returned no agent output");
  await writeExclusive(prepared.outputFile, output.text);
  return AgentResultSchema.parse({
    role: options.role,
    status: "success",
    provider_used: prepared.route.provider,
    model_used: prepared.route.model,
    duration_seconds: 0,
    tokens_used: output.tokensUsed,
    estimated_cost_usd: output.costUsd,
    output_file: prepared.outputFile,
  });
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const prepared = await prepareAgentRun(options);
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await executePreparedRun(options, prepared);
    result.duration_seconds = (Date.now() - started) / 1000;
  } catch {
    await writeExclusive(prepared.outputFile, "Agent run failed. Check the safe CLI diagnostic on stderr.\n");
    result = failedResult({
      role: options.role,
      repository: prepared.repository,
      outputFile: prepared.outputFile,
      duration: (Date.now() - started) / 1000,
    });
  } finally {
    await rm(prepared.scratchDirectory, { recursive: true, force: true });
  }
  await writeExclusive(prepared.resultFile, JSON.stringify(result, null, 2) + "\n");
  return result;
}

const ArgumentsSchema = z
  .object({
    "--role": z.enum(["planner", "builder", "reviewer"]),
    "--workspace": z.string().min(1),
    "--prompt": z.string().min(1),
    "--output-dir": z.string().min(1),
    "--repo-id": z.string().min(1).optional(),
    "--config-dir": z.string().min(1).optional(),
  })
  .strict();

function parseArguments(args: string[]): RunAgentOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key))
      throw new Error("Invalid runner arguments");
    values[key] = value;
  }
  const parsed = ArgumentsSchema.parse(values);
  return {
    role: parsed["--role"],
    workspace: parsed["--workspace"],
    promptPath: parsed["--prompt"],
    outputDirectory: parsed["--output-dir"],
    ...(parsed["--repo-id"] !== undefined ? { repoId: parsed["--repo-id"] } : {}),
    ...(parsed["--config-dir"] !== undefined ? { configDirectory: parsed["--config-dir"] } : {}),
  };
}

export async function runAgentCli(args: string[]): Promise<number> {
  if (args[0] === "--help") {
    process.stdout.write(
      "Usage: src/agents/run.sh --role <planner|builder|reviewer> --workspace <path> --prompt <file> --output-dir <path> [--repo-id <id>] [--config-dir <path>]\n",
    );
    return 0;
  }
  try {
    const result = await runAgent(parseArguments(args));
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.status === "failed" ? 1 : 0;
  } catch {
    process.stderr.write("Agent runner could not start. Check role, repository, config and workspace inputs.\n");
    return 1;
  }
}
