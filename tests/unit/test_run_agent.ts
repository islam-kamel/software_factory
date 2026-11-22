// ============================================================
// test_run_agent.ts
// Purpose : Verify every public agent run uses approved isolated egress
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : src/agents/run_agent.ts
// ============================================================
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSandboxed } from "@/adapters/cli_runner/sandbox";
import type { SandboxRuntimeProfile } from "@/adapters/cli_runner/runtime_profile";
import { loadConfig, type LoadedConfig } from "@/engine/config_loader";
import {
  FactoryConfigSchema,
  ModelsConfigSchema,
  ResolvedRepositorySchema,
  type FactoryConfig,
  type ResolvedRepository,
} from "@/engine/config_schemas";
import { runAgent, type RunAgentOptions } from "@/agents/run_agent";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runSandboxed: vi.fn(),
  loadRuntimeProfile: vi.fn(),
  assertBuilderWorkspace: vi.fn(),
  assertRepositoryWorkspace: vi.fn(),
  socketPaths: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const details = await actual.lstat(...args);
      return mocks.socketPaths.has(String(args[0])) ? Object.assign(details, { isSocket: () => true }) : details;
    },
  };
});
vi.mock("@/engine/config_loader", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("@/adapters/cli_runner/sandbox", () => ({ runSandboxed: mocks.runSandboxed }));
vi.mock("@/adapters/cli_runner/runtime_profile", () => ({ loadSandboxRuntimeProfile: mocks.loadRuntimeProfile }));
vi.mock("@/adapters/cli_runner/workspace", () => ({
  assertBuilderWorkspace: mocks.assertBuilderWorkspace,
  assertRepositoryWorkspace: mocks.assertRepositoryWorkspace,
}));

type Role = RunAgentOptions["role"];
type Route = { cli: string; provider: string; model: string };
type LoadedConfigOptions = {
  proxy?: "enabled" | "disabled" | "implicit" | "omitted";
  routes?: Partial<Record<Role, Route>>;
  allowCloud?: boolean;
  socket?: { publicSocket?: string; localSocket?: string };
};

const root = resolve(process.cwd());
const temporaryDirectories: string[] = [];
const runtimeProfile: SandboxRuntimeProfile = { mounts: [], commands: {}, path: "/tmp/runtime-profile.yaml" };
let fixtureRoot = "";
let workspace = "";
let promptPath = "";
let publicSocket = "";
let localSocket = "";
let loaded: LoadedConfig;

function createLoadedConfig(options: LoadedConfigOptions = {}): LoadedConfig {
  const proxy = options.proxy ?? "enabled";
  const factoryInput: Record<string, unknown> = { version: "1.0" };
  if (proxy !== "omitted") {
    factoryInput.egress_proxy = {
      ...(proxy === "implicit" ? {} : { enabled: proxy === "enabled" }),
      public_socket: options.socket?.publicSocket ?? publicSocket,
      local_socket: options.socket?.localSocket ?? localSocket,
    };
  }
  const factory: FactoryConfig = FactoryConfigSchema.parse(factoryInput);
  const routes: Record<Role, Route> = {
    planner: { cli: "opencode", provider: "openrouter", model: "test-model" },
    builder: { cli: "opencode", provider: "ollama-local", model: "test-model" },
    reviewer: { cli: "opencode", provider: "openai", model: "test-model" },
    ...options.routes,
  };
  const models = ModelsConfigSchema.parse({
    version: "1.0",
    providers: {
      openrouter: { is_local: false, api_key_env: "OPENROUTER_API_KEY" },
      openai: { is_local: false, api_key_env: "OPENAI_API_KEY" },
      "ollama-local": { is_local: true },
      antigravity: { is_local: false, auth_mode: "cli" },
    },
    roles: routes,
  });
  const repository: ResolvedRepository = ResolvedRepositorySchema.parse({
    id: "test-repo",
    enabled: true,
    visibility: "private",
    local_path: workspace,
    use_worktree: true,
    agents: routes,
    privacy: { allow_cloud_llm: options.allowCloud ?? true, ignore_paths: [] },
    tracker: { provider: "local_md" },
  });
  return {
    config: { factory, models, defaults: undefined, repos: [repository] },
    secrets: new Map([
      ["OPENROUTER_API_KEY", "synthetic-openrouter-key"],
      ["OPENAI_API_KEY", "synthetic-openai-key"],
    ]),
  };
}

function agentOptions(role: Role): RunAgentOptions {
  return {
    role,
    workspace,
    promptPath,
    outputDirectory: join(fixtureRoot, `output-${role}`),
    repoId: "test-repo",
    configDirectory: join(root, "config"),
  };
}

async function scratchDirectories(): Promise<string[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries.filter((entry) => entry.name.startsWith("software-factory-agent-")).map((entry) => entry.name);
}

async function expectRejectedWithoutArtifacts(role: Role): Promise<void> {
  const options = agentOptions(role);
  const before = await scratchDirectories();
  await expect(runAgent(options)).rejects.toThrow();
  expect(await readdir(fixtureRoot)).not.toContain(`output-${role}`);
  expect(await scratchDirectories()).toEqual(before);
  expect(vi.mocked(runSandboxed)).not.toHaveBeenCalled();
}

beforeEach(async () => {
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "factory-run-agent-")));
  temporaryDirectories.push(fixtureRoot);
  workspace = join(fixtureRoot, "repository");
  await mkdir(workspace);
  promptPath = join(fixtureRoot, "prompt.md");
  await writeFile(promptPath, "Synthetic request\n");
  publicSocket = join(fixtureRoot, "public.sock");
  localSocket = join(fixtureRoot, "local.sock");
  await Promise.all([
    writeFile(publicSocket, "synthetic socket path"),
    writeFile(localSocket, "synthetic socket path"),
  ]);
  mocks.socketPaths.add(publicSocket);
  mocks.socketPaths.add(localSocket);
  loaded = createLoadedConfig();
  vi.mocked(loadConfig).mockImplementation(async () => loaded);
  vi.mocked(runSandboxed).mockResolvedValue({
    exitCode: 0,
    stdout: '{"type":"text","part":{"text":"synthetic response"}}\n',
    stderr: "",
    timedOut: false,
    outputLimit: false,
  });
  vi.mocked(mocks.loadRuntimeProfile).mockResolvedValue(runtimeProfile);
  vi.mocked(mocks.assertBuilderWorkspace).mockResolvedValue(undefined);
  vi.mocked(mocks.assertRepositoryWorkspace).mockResolvedValue(undefined);
  vi.stubEnv("SOFTWARE_FACTORY_ROOT", root);
  vi.stubEnv("OPENROUTER_API_KEY", "ambient-synthetic-key");
  vi.stubEnv("OPENAI_API_KEY", "ambient-synthetic-key");
});

afterEach(async () => {
  mocks.socketPaths.clear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.each(["planner", "reviewer"] as const)("runs %s only offline through the selected socket", async (role) => {
  const result = await runAgent(agentOptions(role));
  const invocation = vi.mocked(runSandboxed).mock.calls[0];

  expect(result.status).toBe("success");
  expect(invocation?.[2].offline).toBe(true);
  expect(invocation?.[2].egressSocket).toBe(publicSocket);
  expect(invocation?.[2].env).not.toHaveProperty("OPENROUTER_API_KEY");
  expect(invocation?.[2].env).not.toHaveProperty("OPENAI_API_KEY");
  await expect(readFile(join(fixtureRoot, `output-${role}`, "AgentResult.json"), "utf8")).resolves.toContain(
    '"status": "success"',
  );
});

it("routes a cloud-permitted local model through the local socket", async () => {
  const result = await runAgent(agentOptions("builder"));
  const invocation = vi.mocked(runSandboxed).mock.calls[0];

  expect(result.status).toBe("success");
  expect(invocation?.[2].offline).toBe(true);
  expect(invocation?.[2].egressSocket).toBe(localSocket);
});

it.each(["disabled", "implicit", "omitted"] as const)(
  "rejects %s proxy before artifacts or process spawn",
  async (proxy) => {
    loaded = createLoadedConfig({ proxy });
    await expectRejectedWithoutArtifacts("planner");
  },
);

it("routes confidential local-model runs through the local socket", async () => {
  loaded = createLoadedConfig({ allowCloud: false });

  const result = await runAgent(agentOptions("builder"));
  const invocation = vi.mocked(runSandboxed).mock.calls[0];

  expect(result.status).toBe("success");
  expect(invocation?.[2].offline).toBe(true);
  expect(invocation?.[2].egressSocket).toBe(localSocket);
});

it.each([
  { cli: "codex", provider: "openai", message: /codex CLI does not support/ },
  { cli: "agy", provider: "antigravity", message: /OpenCode CLI/ },
  { cli: "opencode", provider: "unsupported", message: /missing from models config/ },
] as const)("rejects unsupported route $cli/$provider before artifacts", async ({ cli, provider, message }) => {
  loaded = createLoadedConfig({ routes: { planner: { cli, provider, model: "test-model" } } });
  const options = agentOptions("planner");
  const before = await scratchDirectories();

  await expect(runAgent(options)).rejects.toThrow(message);
  expect(await readdir(fixtureRoot)).not.toContain("output-planner");
  expect(await scratchDirectories()).toEqual(before);
  expect(vi.mocked(runSandboxed)).not.toHaveBeenCalled();
});

it("rejects missing, linked, and regular-file proxy paths before artifacts", async () => {
  const missingSocket = join(fixtureRoot, "missing.sock");
  const linkedSocket = join(fixtureRoot, "linked.sock");
  const regularFile = join(fixtureRoot, "regular.sock");
  await symlink(publicSocket, linkedSocket);
  await writeFile(regularFile, "not a socket");

  for (const socket of [missingSocket, linkedSocket, regularFile]) {
    loaded = createLoadedConfig({ socket: { publicSocket: socket, localSocket } });
    await expectRejectedWithoutArtifacts("planner");
  }
});
