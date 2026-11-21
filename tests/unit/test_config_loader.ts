// ============================================================
// test_config_loader.ts
// Purpose : Verify config merging and environment secret resolution
// Feature : Configuration
// Role    : Unit Tests
// API Doc : docs/implementation_plan.md, Phase 0
// ============================================================
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { parseDocument, stringify } from "yaml";
import { loadConfig } from "@/engine/config_loader";

const configDir = fileURLToPath(new URL("../../config/", import.meta.url));
const exampleReposPath = join(configDir, "repos.example.yaml");
const temporaryDirectories: string[] = [];

function readYamlRecord(contents: string): Record<string, unknown> {
  const value: unknown = parseDocument(contents).toJS();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a YAML object");
  return Object.fromEntries(Object.entries(value));
}

afterEach(() => {
  vi.unstubAllEnvs();
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function stubExampleEnvironment(): void {
  vi.stubEnv("GITHUB_TOKEN", "test-github-token");
  vi.stubEnv("CLIENT_DASHBOARD_GH_TOKEN", "test-dashboard-token");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("OPENCODE_API_KEY", "test-opencode-key");
}

function createTemporaryFile(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "factory-phase0-"));
  temporaryDirectories.push(directory);
  const file = join(directory, name);
  writeFileSync(file, contents);
  return file;
}

function createExampleOverrides(update: (repos: Record<string, unknown>) => void): string {
  const data = readYamlRecord(readFileSync(exampleReposPath, "utf8"));
  update(data);
  return createTemporaryFile("repos.yaml", stringify(data));
}

it("merges model roles, defaults, repo context and overrides without loading disabled secrets", async () => {
  stubExampleEnvironment();
  const loaded = await loadConfig({
    factoryPath: join(configDir, "factory.yaml"),
    modelsPath: join(configDir, "models.yaml"),
    reposPath: exampleReposPath,
  });
  const [baseRepo, overriddenRepo, disabledRepo] = loaded.config.repos;

  expect(baseRepo?.agents.builder.provider).toBe("opencode-go");
  expect(overriddenRepo?.agents.builder).toMatchObject({
    cli: "copilot-cli",
    provider: "github-copilot",
    model: "glm-5.3",
  });
  expect(overriddenRepo?.context?.repo_files).toEqual(["AGENTS.md", ".factory/AGENTS.md"]);
  expect(disabledRepo?.agents.planner.provider).toBe("ollama-local");
  expect(loaded.config.defaults?.agents?.builder?.provider).toBe("opencode-go");
  expect(loaded.secrets.get("FINTECH_GH_TOKEN")).toBeUndefined();
  expect(JSON.stringify(loaded.config)).not.toContain("test-openrouter-key");
});

it("resolves only the explicitly selected repository credentials", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-github-token");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("OPENCODE_API_KEY", "test-opencode-key");

  const loaded = await loadConfig({
    factoryPath: join(configDir, "factory.yaml"),
    modelsPath: join(configDir, "models.yaml"),
    reposPath: exampleReposPath,
    repoId: "ecommerce-api",
  });

  expect(loaded.secrets.get("GITHUB_TOKEN")).toBe("test-github-token");
  expect(loaded.secrets.get("CLIENT_DASHBOARD_GH_TOKEN")).toBeUndefined();
});

it("resolves every enabled repository when repoId is omitted", async () => {
  stubExampleEnvironment();
  vi.stubEnv("CLIENT_DASHBOARD_GH_TOKEN", "");

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath: exampleReposPath,
    }),
  ).rejects.toThrow(/CLIENT_DASHBOARD_GH_TOKEN/);
});

it("validates privacy for disabled repositories", async () => {
  const reposPath = createExampleOverrides((data) => {
    const repos = data.repos;
    if (!Array.isArray(repos)) throw new Error("Expected repositories array");
    const disabledRepo = readYamlRecord(JSON.stringify(repos[2]));
    disabledRepo.privacy = { allow_cloud_llm: false };
    disabledRepo.overrides = { agents: { planner: { provider: "openrouter" } } };
    repos[2] = disabledRepo;
  });

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath,
      repoId: "fintech-client-api",
    }),
  ).rejects.toThrow(/forbids cloud LLMs/);
});

it("rejects a repo privacy policy without allow_cloud_llm", async () => {
  const reposPath = createExampleOverrides((data) => {
    const defaults = readYamlRecord(JSON.stringify(data.defaults));
    delete defaults.privacy;
    data.defaults = defaults;
    const repos = data.repos;
    if (!Array.isArray(repos)) throw new Error("Expected repositories array");
    for (let index = 1; index < repos.length; index += 1) {
      const repo = readYamlRecord(JSON.stringify(repos[index]));
      repo.privacy = { allow_cloud_llm: true };
      repos[index] = repo;
    }
    const firstRepo = readYamlRecord(JSON.stringify(repos[0]));
    firstRepo.privacy = { data_classification: "internal" };
    repos[0] = firstRepo;
  });

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath,
    }),
  ).rejects.toThrow(/privacy.allow_cloud_llm/);
});

it("rejects an empty repoId instead of loading every enabled repo", async () => {
  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath: exampleReposPath,
      repoId: "",
    }),
  ).rejects.toThrow(/repository ID must not be empty/);
});

it("rejects an unknown repoId before resolving credentials", async () => {
  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath: exampleReposPath,
      repoId: "missing-repository",
    }),
  ).rejects.toThrow(/Selected repository does not exist/);
});

it("rejects explicitly selecting a disabled repository before resolving credentials", async () => {
  const options = {
    factoryPath: join(configDir, "factory.yaml"),
    modelsPath: join(configDir, "models.yaml"),
    reposPath: exampleReposPath,
    repoId: "fintech-client-api",
  };

  vi.stubEnv("FINTECH_GH_TOKEN", "");
  await expect(loadConfig(options)).rejects.toThrow(/disabled.*enabled: true/i);
  vi.stubEnv("FINTECH_GH_TOKEN", "test-fintech-token");
  await expect(loadConfig(options)).rejects.toThrow(/disabled.*enabled: true/i);
});

it("names missing secret variables without exposing secret values", async () => {
  stubExampleEnvironment();
  vi.stubEnv("OPENCODE_API_KEY", "");

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath: exampleReposPath,
    }),
  ).rejects.toThrow(/OPENCODE_API_KEY/);
});

it("requires tracker tokens for enabled repositories", async () => {
  stubExampleEnvironment();
  vi.stubEnv("GITHUB_TOKEN", "");

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath: exampleReposPath,
    }),
  ).rejects.toThrow(/GITHUB_TOKEN/);
});

it("rejects an unknown provider before looking up environment variables", async () => {
  const reposPath = createExampleOverrides((data) => {
    const repos = data.repos;
    if (!Array.isArray(repos)) throw new Error("Expected repositories array");
    const firstRepo = readYamlRecord(JSON.stringify(repos[0]));
    firstRepo.overrides = { agents: { planner: { provider: "missing-provider" } } };
    repos[0] = firstRepo;
  });

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath,
    }),
  ).rejects.toThrow(/unknown provider/);
});

it("rejects missing provider locality even when cloud routing is allowed", async () => {
  const models = readYamlRecord(readFileSync(join(configDir, "models.yaml"), "utf8"));
  const providers = models.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("Expected providers object");
  }
  const providerMap = Object.fromEntries(Object.entries(providers));
  const openrouter = readYamlRecord(JSON.stringify(providerMap.openrouter));
  delete openrouter.is_local;
  providerMap.openrouter = openrouter;
  models.providers = providerMap;
  const modelsPath = createTemporaryFile("models.yaml", stringify(models));

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath,
      reposPath: exampleReposPath,
    }),
  ).rejects.toThrow(/is_local/);
});

it("enforces local-only privacy before secrets even if the factory switch is false", async () => {
  const reposPath = createExampleOverrides((data) => {
    const repos = data.repos;
    if (!Array.isArray(repos)) throw new Error("Expected repositories array");
    const firstRepo = readYamlRecord(JSON.stringify(repos[0]));
    firstRepo.privacy = { allow_cloud_llm: false };
    repos[0] = firstRepo;
  });
  const factoryData = readYamlRecord(readFileSync(join(configDir, "factory.yaml"), "utf8"));
  const security = readYamlRecord(JSON.stringify(factoryData.security));
  security.fail_closed_on_cloud_violation = false;
  factoryData.security = security;
  const factoryPath = createTemporaryFile("factory.yaml", stringify(factoryData));

  await expect(loadConfig({ factoryPath, modelsPath: join(configDir, "models.yaml"), reposPath })).rejects.toThrow(
    /forbids cloud LLMs/,
  );
});

it("rejects malformed YAML and invalid top-level configuration", async () => {
  const malformedYaml = createTemporaryFile("repos.yaml", "version: [\n");
  const customTag = createTemporaryFile("custom-tag.yaml", "version: !secret sentinel-secret-value\n");
  const invalidRoot = createTemporaryFile("invalid.yaml", "- not-an-object\n");
  const options = { factoryPath: join(configDir, "factory.yaml"), modelsPath: join(configDir, "models.yaml") };

  await expect(loadConfig({ ...options, reposPath: malformedYaml })).rejects.toThrow(/Invalid YAML/);
  await expect(loadConfig({ ...options, reposPath: customTag })).rejects.not.toThrow("sentinel-secret-value");
  await expect(loadConfig({ ...options, reposPath: invalidRoot })).rejects.toThrow(/Invalid repositories config/);
});

it("rejects prototype keys in YAML without mutating Object.prototype", async () => {
  const reposPath = createTemporaryFile(
    "repos.yaml",
    'version: "1.0"\ndefaults: {}\nrepos:\n  - id: test\n    overrides:\n      agents:\n        planner:\n          "__proto__":\n            polluted: true\n',
  );

  await expect(
    loadConfig({
      factoryPath: join(configDir, "factory.yaml"),
      modelsPath: join(configDir, "models.yaml"),
      reposPath,
    }),
  ).rejects.toThrow(/unsafe config key/);
  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
});
