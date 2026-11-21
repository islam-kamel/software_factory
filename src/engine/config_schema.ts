// ============================================================
// config_schema.ts
// Purpose : Validate parsed factory, model and repository config
// Feature : Configuration
// Role    : Configuration Schema
// API Doc : config/factory.yaml, config/models.yaml, config/repos.example.yaml
// ============================================================
import { z } from "zod";

const RouteSchema = z
  .object({
    cli: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    access: z.enum(["read_only", "read_write"]).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
  })
  .strict();
const RouteLayerSchema = RouteSchema.partial().strict();
const PlannerRouteSchema = RouteSchema.extend({ access: z.literal("read_only") });
const BuilderRouteSchema = RouteSchema.extend({ access: z.literal("read_write") });
const ReviewerRouteSchema = RouteSchema.extend({ access: z.literal("read_only") });
const AgentMapSchema = z
  .object({ planner: PlannerRouteSchema, builder: BuilderRouteSchema, reviewer: ReviewerRouteSchema })
  .strict();
const AgentLayerSchema = z
  .object({
    planner: RouteLayerSchema.optional(),
    builder: RouteLayerSchema.optional(),
    reviewer: RouteLayerSchema.optional(),
  })
  .strict();

const PrivacySchema = z
  .object({
    data_classification: z.enum(["public", "internal", "confidential"]),
    allow_cloud_llm: z.boolean(),
    ignore_paths: z.array(z.string()),
  })
  .strict();
const PrivacyLayerSchema = z
  .object({
    data_classification: z.enum(["public", "internal", "confidential"]).optional(),
    allow_cloud_llm: z.boolean().optional(),
    ignore_paths: z.array(z.string()).optional(),
  })
  .strict();
const ContextSchema = z
  .object({
    mode: z.enum(["repo_only", "merge", "factory_only"]),
    repo_files: z.array(z.string()),
    factory_extra: z.string(),
  })
  .strict();
const ContextLayerSchema = z
  .object({
    mode: z.enum(["repo_only", "merge", "factory_only"]).optional(),
    repo_files: z.array(z.string()).optional(),
    factory_extra: z.string().optional(),
  })
  .strict();
const TrackerSchema = z
  .object({
    provider: z.enum(["github", "gitlab", "jira", "local_md"]),
    repo: z.string().optional(),
    token_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    allowed_approvers: z.array(z.string()).optional(),
  })
  .strict()
  .refine((tracker) => tracker.provider === "local_md" || Boolean(tracker.token_env), {
    path: ["token_env"],
    error: "is required for external trackers",
  });
const TrackerLayerSchema = z
  .object({
    provider: z.enum(["github", "gitlab", "jira", "local_md"]).optional(),
    repo: z.string().optional(),
    token_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    allowed_approvers: z.array(z.string()).optional(),
  })
  .strict();
const ProviderSchema = z
  .object({
    is_local: z.boolean(),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    auth_mode: z.enum(["cli"]).optional(),
    base_url: z.string().url().optional(),
  })
  .strict()
  .refine((provider) => provider.is_local || provider.auth_mode === "cli" || Boolean(provider.api_key_env), {
    path: ["api_key_env"],
    error: "is required for cloud providers using environment authentication",
  });
const RoleMapSchema = AgentMapSchema;
const ModelConfigSchema = z
  .object({
    version: z.string(),
    providers: z.record(z.string().min(1), ProviderSchema),
    roles: RoleMapSchema,
  })
  .strict();
const NotificationsSchema = z
  .object({
    tracker_mention: z.boolean(),
    external: z.object({ provider: z.string(), enabled: z.boolean() }).strict(),
  })
  .strict();
const NotificationsLayerSchema = z
  .object({
    tracker_mention: z.boolean().optional(),
    external: z.object({ provider: z.string().optional(), enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict();

const RepoLayerShape = {
  id: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  local_path: z.string().min(1).optional(),
  use_worktree: z.boolean().optional(),
  base_branch: z.string().min(1).optional(),
  branch_prefix: z.string().min(1).optional(),
  draft_pr: z.boolean().optional(),
  approval_command: z.string().min(1).optional(),
  max_retries: z.number().int().positive().optional(),
  context: ContextLayerSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  agents: AgentLayerSchema.optional(),
  notifications: NotificationsLayerSchema.optional(),
  privacy: PrivacyLayerSchema.optional(),
  tracker: TrackerLayerSchema.optional(),
  verification: z.record(z.string(), z.string()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
};
const RepoLayerSchema = z.object(RepoLayerShape).strict();
const RepoSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    local_path: z.string().min(1).optional(),
    use_worktree: z.boolean().optional(),
    base_branch: z.string().min(1).optional(),
    branch_prefix: z.string().min(1).optional(),
    draft_pr: z.boolean().optional(),
    approval_command: z.string().min(1).optional(),
    max_retries: z.number().int().positive().optional(),
    context: ContextSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    agents: AgentMapSchema,
    notifications: NotificationsSchema.optional(),
    privacy: PrivacySchema,
    tracker: TrackerSchema.optional(),
    verification: z.record(z.string(), z.string()).optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const RepoRegistrySchema = z
  .object({
    version: z.string(),
    defaults: RepoLayerSchema,
    repos: z.array(RepoLayerSchema.extend({ id: z.string().min(1) })),
  })
  .strict();
const FactoryConfigSchema = z
  .object({
    version: z.string(),
    adapters: z
      .object({
        tracker: z.enum(["github", "gitlab", "jira", "local_md"]),
        git_host: z.enum(["github", "gitlab", "bitbucket", "local_git"]),
        cli_runner: z.enum(["opencode", "aider", "claude_code", "codex", "copilot-cli"]),
        notifier: z.enum(["telegram", "discord", "slack", "console", "none"]),
      })
      .strict(),
    limits: z
      .object({
        max_self_heal_retries: z.number().int().positive(),
        max_parallel_tasks: z.number().int().positive(),
        agent_timeout_minutes: z.number().int().positive(),
        polling_interval_seconds: z.number().int().positive(),
      })
      .strict(),
    workspace: z
      .object({
        use_worktree: z.boolean(),
        worktree_root: z.string().min(1),
        cleanup_on_complete: z.boolean(),
        branch_prefix: z.string().min(1),
        draft_pr_only: z.boolean(),
      })
      .strict(),
    security: z
      .object({
        require_human_approval: z.boolean(),
        approval_command: z.string().min(1),
        require_secret_scan: z.boolean(),
        fail_closed_on_cloud_violation: z.boolean(),
      })
      .strict(),
    logging: z
      .object({
        dir: z.string().min(1),
        level: z.enum(["debug", "info", "warn", "error"]),
        track_cost: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ConfigSchemas = {
  factory: FactoryConfigSchema,
  models: ModelConfigSchema,
  repos: RepoRegistrySchema,
  repoLayer: RepoLayerSchema,
  repo: RepoSchema,
  privacy: PrivacySchema,
  context: ContextSchema,
  notifications: NotificationsSchema,
  tracker: TrackerSchema,
  agents: AgentMapSchema,
  providers: z.record(z.string(), ProviderSchema),
};

export type FactorySettings = z.infer<typeof FactoryConfigSchema>;
export type ModelSettings = z.infer<typeof ModelConfigSchema>;
export type RepositoryLayer = z.infer<typeof RepoLayerSchema>;
export type RepositorySettings = z.infer<typeof RepoSchema>;
