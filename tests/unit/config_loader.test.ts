// ============================================================
// config_loader.test.ts
// Purpose : Verify config loading, merging and credential lookup
// Feature : Configuration
// Role    : Unit Test
// API Doc : config/repos.example.yaml
// ============================================================
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveCredentials } from "../../src/engine/config_loader.js";

const tempDirs: string[] = [];

async function fixtureConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "software-factory-config-"));
  tempDirs.push(dir);
  for (const file of ["factory.yaml", "models.yaml", "repos.example.yaml"]) {
    const source = await readFile(join(process.cwd(), "config", file), "utf8");
    await writeFile(join(dir, file), source);
  }
  return dir;
}

async function loadExampleConfig(configDir: string) {
  return loadConfig(configDir, "repos.example.yaml");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config merging", () => {
  it("requires explicit example registry selection", async () => {
    const dir = await fixtureConfig();
    await expect(loadConfig(dir)).rejects.toThrow("Could not read repos.yaml");
    const example = await loadConfig(dir, "repos.example.yaml");
    expect(example.repositories).toHaveLength(3);
  });

  it("merges defaults and nested role overrides while replacing arrays", async () => {
    const config = await loadExampleConfig(await fixtureConfig());
    const repo = config.repositories.find((item) => item.id === "client-dashboard");
    expect(repo?.agents.builder).toMatchObject({
      cli: "copilot-cli",
      provider: "github-copilot",
      model: "glm-5.3",
      access: "read_write",
    });
    expect(repo?.context?.repo_files).toEqual(["AGENTS.md", ".factory/AGENTS.md"]);
    expect(repo?.privacy.ignore_paths).toEqual([".env*", "*.pem", "*.key", "secrets/**"]);
  });
});

describe("credential resolution", () => {
  it("resolves only selected env references and reports names without values", async () => {
    const config = await loadExampleConfig(await fixtureConfig());
    expect(() =>
      resolveCredentials(config, {
        repositoryId: "ecommerce-api",
        role: "planner",
        environment: { GITHUB_TOKEN: "token" },
      }),
    ).toThrow("OPENROUTER_API_KEY");
    expect(
      resolveCredentials(config, {
        repositoryId: "fintech-client-api",
        role: "planner",
        environment: { FINTECH_GH_TOKEN: "token" },
      }),
    ).toMatchObject({ providerApiKey: undefined });
  });

  it("fails on blank selected tracker tokens and provider keys", async () => {
    const config = await loadExampleConfig(await fixtureConfig());
    expect(() =>
      resolveCredentials(config, {
        repositoryId: "ecommerce-api",
        role: "planner",
        environment: {},
      }),
    ).toThrow("Missing required environment variable: GITHUB_TOKEN");
    expect(() =>
      resolveCredentials(config, {
        repositoryId: "ecommerce-api",
        role: "planner",
        environment: { GITHUB_TOKEN: " " },
      }),
    ).toThrow("Missing required environment variable: GITHUB_TOKEN");
    expect(() =>
      resolveCredentials(config, {
        repositoryId: "ecommerce-api",
        role: "planner",
        environment: { GITHUB_TOKEN: "token", OPENROUTER_API_KEY: " " },
      }),
    ).toThrow("Missing required environment variable: OPENROUTER_API_KEY");
  });
});

describe("credential lookup safety", () => {
  it("fails if a provider route resolves to an inherited object property", async () => {
    const config = await loadExampleConfig(await fixtureConfig());
    const repository = config.repositories.find((item) => item.id === "ecommerce-api");
    if (!repository) throw new Error("Fixture repository is missing");
    repository.agents.planner.provider = "constructor";
    expect(() =>
      resolveCredentials(config, {
        repositoryId: "ecommerce-api",
        role: "planner",
        environment: { GITHUB_TOKEN: "token" },
      }),
    ).toThrow("Unknown provider for role: planner");
  });
});

describe("YAML diagnostics", () => {
  it("rejects malformed YAML without including its content in the error", async () => {
    const dir = await fixtureConfig();
    await writeFile(join(dir, "factory.yaml"), "private value: SECRET_VALUE: [");
    await expect(loadExampleConfig(dir)).rejects.toThrow(/factory\.yaml/);
    await expect(loadExampleConfig(dir)).rejects.not.toThrow(/SECRET_VALUE/);
  });
});

describe("configuration security", () => {
  it.each(["planner", "reviewer"] as const)("rejects write access for %s after overrides", async (role) => {
    const dir = await fixtureConfig();
    const reposFile = join(dir, "repos.example.yaml");
    const repos = await readFile(reposFile, "utf8");
    const override = `      agents:\n        ${role}:\n          access: read_write\n        builder:`;
    await writeFile(reposFile, repos.replace("      agents:\n        builder:", override));
    await expect(loadExampleConfig(dir)).rejects.toThrow(`agents.${role}.access`);
  });

  it("validates the factory security configuration shape", async () => {
    const dir = await fixtureConfig();
    const factoryFile = join(dir, "factory.yaml");
    const factory = await readFile(factoryFile, "utf8");
    await writeFile(factoryFile, factory.replace("require_secret_scan: true", 'require_secret_scan: "true"'));
    await expect(loadExampleConfig(dir)).rejects.toThrow("security.require_secret_scan");
  });
});

describe("repository validation", () => {
  it("rejects duplicate repository ids and unknown providers", async () => {
    const duplicateDir = await fixtureConfig();
    const reposFile = join(duplicateDir, "repos.example.yaml");
    const repos = await readFile(reposFile, "utf8");
    await writeFile(reposFile, repos.replace('id: "client-dashboard"', 'id: "ecommerce-api"'));
    await expect(loadExampleConfig(duplicateDir)).rejects.toThrow("Duplicate repository id");

    const unknownDir = await fixtureConfig();
    const modelsFile = join(unknownDir, "models.yaml");
    const models = await readFile(modelsFile, "utf8");
    await writeFile(modelsFile, models.replace('provider: "openrouter"', 'provider: "unknown-cloud"'));
    await expect(loadExampleConfig(unknownDir)).rejects.toThrow("Unknown provider");

    const inheritedDir = await fixtureConfig();
    const inheritedFile = join(inheritedDir, "models.yaml");
    const inheritedModels = await readFile(inheritedFile, "utf8");
    await writeFile(inheritedFile, inheritedModels.replace('provider: "openrouter"', 'provider: "constructor"'));
    await expect(loadExampleConfig(inheritedDir)).rejects.toThrow("Unknown provider: constructor");
  });

  it("fails closed when any local-only role resolves to a cloud provider", async () => {
    const dir = await fixtureConfig();
    const reposFile = join(dir, "repos.example.yaml");
    const repos = await readFile(reposFile, "utf8");
    await writeFile(reposFile, repos.replace('provider: "ollama-local"', 'provider: "openrouter"'));
    await expect(loadExampleConfig(dir)).rejects.toThrow("Cloud provider openrouter is blocked");
  });

  it("rejects provider metadata without an explicit locality flag", async () => {
    const dir = await fixtureConfig();
    const modelsFile = join(dir, "models.yaml");
    const models = await readFile(modelsFile, "utf8");
    await writeFile(modelsFile, models.replace("    is_local: false\n", ""));
    await expect(loadExampleConfig(dir)).rejects.toThrow(/models\.yaml fields: providers\.openrouter\.is_local/);
  });

  it("rejects malformed privacy override keys", async () => {
    const dir = await fixtureConfig();
    const reposFile = join(dir, "repos.example.yaml");
    const repos = await readFile(reposFile, "utf8");
    await writeFile(reposFile, repos.replace("allow_cloud_llm: false", "allow_cloud_lllm: false"));
    await expect(loadExampleConfig(dir)).rejects.toThrow(/repos\.2\.privacy/);
  });
});
