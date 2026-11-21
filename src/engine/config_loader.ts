// ============================================================
// config_loader.ts
// Purpose : Load, validate and resolve Software Factory settings
// Feature : Configuration
// Role    : Application Service
// API Doc : config/factory.yaml, config/models.yaml, config/repos.example.yaml
// ============================================================
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ConfigSchemas, type FactorySettings, type ModelSettings, type RepositorySettings } from "./config_schema.js";
import { assertPrivacy } from "./privacy_guard.js";

export interface FactoryConfig {
  factory: FactorySettings;
  models: ModelSettings;
  repositories: RepositorySettings[];
}

export interface ResolvedCredentials {
  trackerToken: string | undefined;
  providerApiKey: string | undefined;
}

export interface CredentialRequest {
  repositoryId: string;
  role: keyof RepositorySettings["agents"];
  environment?: NodeJS.ProcessEnv;
}

export type ManagedRepository = RepositorySettings;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeLayers(base: unknown, override: unknown, path = "config"): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`Invalid configuration key at ${path}.${key}`);
    }
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`Invalid configuration key at ${path}.${key}`);
    }
    merged[key] = Object.hasOwn(base, key) ? mergeLayers(base[key], value, `${path}.${key}`) : value;
  }
  return merged;
}

async function readYaml<T>(dir: string, file: string, schema: z.ZodType<T>): Promise<T> {
  let source: string;
  try {
    source = await readFile(join(dir, file), "utf8");
  } catch {
    throw new Error(`Could not read ${file}`);
  }
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`Invalid YAML in ${file}`);
  const result = schema.safeParse(document.toJS());
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "root");
    throw new Error(`Invalid ${file} fields: ${[...new Set(fields)].join(", ")}`);
  }
  return result.data;
}

function resolveRepository(models: ModelSettings, defaults: unknown, repo: unknown): RepositorySettings {
  if (!isPlainObject(repo)) throw new Error("Invalid repository configuration");
  const { overrides, ...repository } = repo;
  const withDefaults = mergeLayers({ agents: models.roles }, defaults);
  const withRepository = mergeLayers(withDefaults, repository);
  const resolved = mergeLayers(withRepository, overrides ?? {});
  const result = ConfigSchemas.repo.safeParse(resolved);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "repository");
    throw new Error(`Invalid repository fields: ${[...new Set(fields)].join(", ")}`);
  }
  return result.data;
}

export async function loadConfig(
  configDir = join(process.cwd(), "config"),
  repoFile = "repos.yaml",
): Promise<FactoryConfig> {
  const factory = await readYaml(configDir, "factory.yaml", ConfigSchemas.factory);
  const models = await readYaml(configDir, "models.yaml", ConfigSchemas.models);
  const registry = await readYaml(configDir, repoFile, ConfigSchemas.repos);
  for (const route of Object.values(models.roles)) {
    if (!Object.hasOwn(models.providers, route.provider)) throw new Error(`Unknown provider: ${route.provider}`);
  }
  const ids = new Set<string>();
  const repositories = registry.repos.map((repo) => {
    if (ids.has(repo.id)) throw new Error(`Duplicate repository id: ${repo.id}`);
    ids.add(repo.id);
    const resolved = resolveRepository(models, registry.defaults, repo);
    for (const route of Object.values(resolved.agents)) {
      if (!Object.hasOwn(models.providers, route.provider)) throw new Error(`Unknown provider: ${route.provider}`);
    }
    assertPrivacy({ factory, models, repositories: [] }, resolved);
    return resolved;
  });
  return { factory, models, repositories };
}

function getRequiredEnv(envName: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[envName];
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${envName}`);
  return value;
}

function resolveTrackerToken(repository: RepositorySettings, environment: NodeJS.ProcessEnv): string | undefined {
  const tracker = repository.tracker;
  if (!tracker || tracker.provider === "local_md") return undefined;
  return getRequiredEnv(tracker.token_env ?? "", environment);
}

function resolveProviderApiKey(
  provider: ModelSettings["providers"][string],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (!provider.api_key_env || provider.auth_mode === "cli" || provider.is_local) return undefined;
  return getRequiredEnv(provider.api_key_env, environment);
}

export function resolveCredentials(config: FactoryConfig, request: CredentialRequest): ResolvedCredentials {
  const repository = config.repositories.find((item) => item.id === request.repositoryId);
  if (!repository) throw new Error(`Unknown repository: ${request.repositoryId}`);
  const environment = request.environment ?? process.env;
  const providerName = repository.agents[request.role].provider;
  const provider = config.models.providers[providerName];
  if (!Object.hasOwn(config.models.providers, providerName) || !provider) {
    throw new Error(`Unknown provider for role: ${request.role}`);
  }
  const trackerToken = resolveTrackerToken(repository, environment);
  const providerApiKey = resolveProviderApiKey(provider, environment);
  return { trackerToken, providerApiKey };
}
