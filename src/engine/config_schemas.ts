// ============================================================
// config_schemas.ts
// Purpose : Validate factory, model registry and repository configuration
// Feature : Configuration
// Role    : Domain Service
// API Doc : N/A
// ============================================================
import { z } from "zod";

const ContextSchema = z
  .object({
    mode: z.enum(["repo_only", "merge", "factory_only"]).optional(),
    repo_files: z.array(z.string()).optional(),
    factory_extra: z.string().optional(),
  })
  .strict();

const RoleOverrideSchema = z
  .object({
    cli: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    access: z.enum(["read_only", "read_write"]).optional(),
    temperature: z.number().optional(),
  })
  .strict();

export const AgentOverridesSchema = z
  .object({
    planner: RoleOverrideSchema.optional(),
    builder: RoleOverrideSchema.optional(),
    reviewer: RoleOverrideSchema.optional(),
  })
  .strict();

const RoleSchema = z
  .object({
    cli: z.string(),
    provider: z.string(),
    model: z.string(),
    access: z.enum(["read_only", "read_write"]).optional(),
    temperature: z.number().optional(),
  })
  .strict();

const PrivacySchema = z
  .object({
    data_classification: z.enum(["public", "internal", "confidential"]).optional(),
    allow_cloud_llm: z.boolean(),
    ignore_paths: z.array(z.string()).optional(),
  })
  .strict();

const RepoPrivacySchema = PrivacySchema.partial();

const DefaultsSchema = z
  .object({
    base_branch: z.string().optional(),
    branch_prefix: z.string().optional(),
    draft_pr: z.boolean().optional(),
    approval_command: z.string().optional(),
    max_retries: z.number().int().positive().optional(),
    context: ContextSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    agents: AgentOverridesSchema.optional(),
    notifications: z.record(z.string(), z.unknown()).optional(),
    privacy: RepoPrivacySchema.optional(),
  })
  .strict();

const TrackerSchema = z
  .object({
    provider: z.string(),
    repo: z.string().optional(),
    token_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    allowed_approvers: z.array(z.string()).optional(),
  })
  .strict();

const VerificationSchema = z
  .object({
    secret_scan: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.string().optional(),
  })
  .strict();

const RepoSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean(),
    visibility: z.enum(["public", "private"]),
    local_path: z.string(),
    use_worktree: z.boolean(),
    base_branch: z.string().optional(),
    branch_prefix: z.string().optional(),
    draft_pr: z.boolean().optional(),
    approval_command: z.string().optional(),
    max_retries: z.number().int().positive().optional(),
    context: ContextSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    agents: AgentOverridesSchema.optional(),
    notifications: z.record(z.string(), z.unknown()).optional(),
    privacy: RepoPrivacySchema.optional(),
    tracker: TrackerSchema,
    verification: VerificationSchema.optional(),
    overrides: z
      .object({
        max_retries: z.number().int().positive().optional(),
        agents: AgentOverridesSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ProviderSchema = z
  .object({
    is_local: z.boolean(),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    auth_mode: z.string().optional(),
    base_url: z.url().optional(),
  })
  .strict()
  .superRefine((provider, context) => {
    if (!provider.is_local && provider.auth_mode !== "cli" && !provider.api_key_env) {
      context.addIssue({ code: "custom", path: ["api_key_env"], message: "Cloud provider requires api_key_env" });
    }
  });

const FactoryLimitsSchema = z
  .object({
    cpu_quota_percent: z.number().finite().min(1).max(10_000).optional(),
    memory_mb: z.number().int().min(1).max(1_048_576).optional(),
    max_pids: z.number().int().min(1).max(1_000_000).optional(),
  })
  .catchall(z.number());

const UnixSocketPathSchema = z
  .string()
  .max(100)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "Expected an absolute Unix socket path");

const EgressProxySchema = z
  .object({
    enabled: z.boolean().default(false),
    public_socket: UnixSocketPathSchema.optional(),
    local_socket: UnixSocketPathSchema.optional(),
  })
  .strict()
  .superRefine((proxy, context) => {
    if (!proxy.enabled) return;
    if (!proxy.public_socket) context.addIssue({ code: "custom", path: ["public_socket"], message: "Required" });
    if (!proxy.local_socket) context.addIssue({ code: "custom", path: ["local_socket"], message: "Required" });
    if (proxy.public_socket && proxy.public_socket === proxy.local_socket) {
      context.addIssue({ code: "custom", path: ["local_socket"], message: "Must be a separate socket" });
    }
  });

export const FactoryConfigSchema = z
  .object({
    version: z.string(),
    adapters: z.record(z.string(), z.string()).optional(),
    limits: FactoryLimitsSchema.optional(),
    egress_proxy: EgressProxySchema.optional(),
    workspace: z.record(z.string(), z.unknown()).optional(),
    security: z.record(z.string(), z.unknown()).optional(),
    logging: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ModelsConfigSchema = z
  .object({
    version: z.string(),
    providers: z.record(z.string(), ProviderSchema),
    roles: z
      .object({
        planner: RoleSchema,
        builder: RoleSchema,
        reviewer: RoleSchema,
      })
      .strict(),
  })
  .strict();

export const RepositoriesConfigSchema = z
  .object({
    version: z.string(),
    defaults: DefaultsSchema.optional(),
    repos: z.array(RepoSchema),
  })
  .strict();

export const ResolvedRepositorySchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    visibility: z.enum(["public", "private"]),
    local_path: z.string(),
    use_worktree: z.boolean(),
    base_branch: z.string().optional(),
    branch_prefix: z.string().optional(),
    draft_pr: z.boolean().optional(),
    approval_command: z.string().optional(),
    max_retries: z.number().int().positive().optional(),
    context: ContextSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    agents: z.object({ planner: RoleSchema, builder: RoleSchema, reviewer: RoleSchema }).strict(),
    notifications: z.record(z.string(), z.unknown()).optional(),
    privacy: RepoPrivacySchema,
    tracker: TrackerSchema,
    verification: VerificationSchema.optional(),
  })
  .strict();

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type ResourceLimits = {
  cpu_quota_percent: number;
  memory_mb: number;
  max_pids: number;
};
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type RepositoriesConfig = z.infer<typeof RepositoriesConfigSchema>;
export type ResolvedRepository = z.infer<typeof ResolvedRepositorySchema>;

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpu_quota_percent: 100,
  memory_mb: 2048,
  max_pids: 256,
};

export function getResourceLimits(limits?: FactoryConfig["limits"]): ResourceLimits {
  return {
    cpu_quota_percent: limits?.cpu_quota_percent ?? DEFAULT_RESOURCE_LIMITS.cpu_quota_percent,
    memory_mb: limits?.memory_mb ?? DEFAULT_RESOURCE_LIMITS.memory_mb,
    max_pids: limits?.max_pids ?? DEFAULT_RESOURCE_LIMITS.max_pids,
  };
}
