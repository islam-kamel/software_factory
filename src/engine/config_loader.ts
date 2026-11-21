// ============================================================
// config_loader.ts
// Purpose : Load, validate, merge and resolve factory configuration
// Feature : Configuration
// Role    : Application Service
// API Doc : docs/implementation_plan.md, Phase 0
// ============================================================
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { assertRepositoryPrivacy } from "@/engine/privacy_guard";
import {
  FactoryConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  ResolvedRepositorySchema,
  type FactoryConfig,
  type ModelsConfig,
  type RepositoriesConfig,
  type ResolvedRepository,
} from "@/engine/config_schemas";

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

export type LoadConfigOptions = {
  factoryPath: string;
  modelsPath: string;
  reposPath: string;
  repoId?: string;
};

export type LoadedConfig = {
  config: {
    factory: FactoryConfig;
    models: ModelsConfig;
    defaults: RepositoriesConfig["defaults"];
    repos: ResolvedRepository[];
  };
  secrets: ReadonlyMap<string, string>;
};

type FileConfig = { label: string; path: string };
type Visit = { value: unknown; path: string; exit: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeKeys(value: unknown): void {
  const active = new WeakSet<object>();
  const pending: Visit[] = [{ value, path: "<root>", exit: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (current.exit) {
      active.delete(current.value);
      continue;
    }
    if (active.has(current.value)) throw new Error(`Cyclic YAML value at ${current.path}`);
    active.add(current.value);
    pending.push({ ...current, exit: true });
    for (const [key, child] of Object.entries(current.value)) {
      const childPath = `${current.path}.${key}`;
      if (forbiddenKeys.has(key)) throw new Error(`unsafe config key at ${childPath}`);
      pending.push({ value: child, path: childPath, exit: false });
    }
  }
}

function readYaml(path: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Unable to read config file ${basename(path)}`);
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
      logLevel: "silent",
    });
  } catch {
    throw new Error(`Invalid YAML in ${basename(path)}`);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`Invalid YAML in ${basename(path)}`);
  }

  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    throw new Error(`Invalid YAML in ${basename(path)}`);
  }
  assertSafeKeys(value);
  return value;
}

function formatSchemaError(label: string, error: z.ZodError): Error {
  const fields = error.issues.map((issue) => {
    const path = issue.path
      .map((part) =>
        typeof part === "number" ? `[${part}]` : /^[a-zA-Z0-9_-]{1,60}$/.test(String(part)) ? part : "<key>",
      )
      .join(".");
    return `${path || "<root>"} (${issue.code})`;
  });
  return new Error(`Invalid ${label} config: ${fields.join(", ")}`);
}

function parseConfig<T>(file: FileConfig, schema: z.ZodType<T>): T {
  const result = schema.safeParse(readYaml(file.path));
  if (!result.success) throw formatSchemaError(file.label, result.error);
  return result.data;
}

function mergeConfig(target: unknown, source: unknown): unknown {
  if (!isRecord(target) || !isRecord(source)) return source;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) result[key] = value;
  for (const [key, value] of Object.entries(source)) result[key] = mergeConfig(target[key], value);
  return result;
}

function resolveRepository(
  defaults: RepositoriesConfig["defaults"],
  repo: RepositoriesConfig["repos"][number],
  models: ModelsConfig,
): ResolvedRepository {
  const { agents, overrides, ...repoFields } = repo;
  const defaultsAgents = defaults?.agents ?? {};
  let resolvedAgents: unknown = mergeConfig(models.roles, defaultsAgents);
  resolvedAgents = mergeConfig(resolvedAgents, agents ?? {});
  resolvedAgents = mergeConfig(resolvedAgents, overrides?.agents ?? {});

  const base = mergeConfig(defaults ?? {}, repoFields);
  const overlay = { agents: resolvedAgents, ...(overrides?.max_retries ? { max_retries: overrides.max_retries } : {}) };
  const result = ResolvedRepositorySchema.safeParse(mergeConfig(base, overlay));
  if (!result.success) throw formatSchemaError(`repository ${repo.id}`, result.error);
  return result.data;
}

function readSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function resolveSecrets(
  repositories: ResolvedRepository[],
  models: ModelsConfig,
  repoId: string | undefined,
): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const repo of repositories) {
    if (repoId === undefined ? !repo.enabled : repo.id !== repoId) continue;
    const tokenEnv = repo.tracker.token_env;
    if (repo.tracker.provider !== "local_md" && !tokenEnv) {
      throw new Error(`repos.${repo.id}.tracker.token_env is required`);
    }
    if (tokenEnv) secrets.set(tokenEnv, readSecret(tokenEnv));

    for (const role of ["planner", "builder", "reviewer"] as const) {
      const provider = models.providers[repo.agents[role].provider];
      if (provider?.api_key_env) secrets.set(provider.api_key_env, readSecret(provider.api_key_env));
    }
  }
  return secrets;
}

function assertRepositorySelection(repositories: ResolvedRepository[], repoId: string | undefined): void {
  if (repoId === undefined) return;
  if (repoId.trim().length === 0) throw new Error("Selected repository ID must not be empty");
  if (!repositories.some((repository) => repository.id === repoId)) {
    throw new Error("Selected repository does not exist in config");
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const factory = parseConfig({ label: "factory", path: options.factoryPath }, FactoryConfigSchema);
  const models = parseConfig({ label: "models", path: options.modelsPath }, ModelsConfigSchema);
  const repositoriesConfig = parseConfig({ label: "repositories", path: options.reposPath }, RepositoriesConfigSchema);
  const repositories = repositoriesConfig.repos.map((repo) =>
    resolveRepository(repositoriesConfig.defaults, repo, models),
  );
  assertRepositoryPrivacy(repositories, models);
  assertRepositorySelection(repositories, options.repoId);
  const secrets = resolveSecrets(repositories, models, options.repoId);

  return {
    config: { factory, models, defaults: repositoriesConfig.defaults, repos: repositories },
    secrets,
  };
}
