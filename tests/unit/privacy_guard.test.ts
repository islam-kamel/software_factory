// ============================================================
// privacy_guard.test.ts
// Purpose : Verify local-only route validation for every role
// Feature : Privacy and Security
// Role    : Unit Test
// API Doc : config/repos.example.yaml
// ============================================================
import { describe, expect, it } from "vitest";
import type { FactoryConfig, ManagedRepository } from "../../src/engine/config_loader.js";
import { assertPrivacy } from "../../src/engine/privacy_guard.js";

const repository: ManagedRepository = {
  id: "private-project",
  agents: {
    planner: { cli: "opencode", provider: "local", model: "small", access: "read_only" },
    builder: { cli: "opencode", provider: "local", model: "small", access: "read_write" },
    reviewer: { cli: "opencode", provider: "local", model: "small", access: "read_only" },
  },
  privacy: { data_classification: "confidential", allow_cloud_llm: false, ignore_paths: [] },
};

const config: FactoryConfig = {
  factory: {
    version: "1.0",
    adapters: { tracker: "github", git_host: "github", cli_runner: "opencode", notifier: "none" },
    limits: {
      max_self_heal_retries: 3,
      max_parallel_tasks: 1,
      agent_timeout_minutes: 15,
      polling_interval_seconds: 60,
    },
    workspace: {
      use_worktree: true,
      worktree_root: "/tmp/worktrees",
      cleanup_on_complete: true,
      branch_prefix: "ai/",
      draft_pr_only: true,
    },
    security: {
      require_human_approval: true,
      approval_command: "/approve",
      require_secret_scan: true,
      fail_closed_on_cloud_violation: true,
    },
    logging: { dir: "./logs", level: "info", track_cost: false },
  },
  models: {
    version: "1.0",
    providers: {
      local: { is_local: true, base_url: "http://localhost:11434" },
      cloud: { is_local: false, api_key_env: "CLOUD_KEY" },
    },
    roles: {
      planner: { cli: "opencode", provider: "local", model: "small", access: "read_only" },
      builder: { cli: "opencode", provider: "local", model: "small", access: "read_write" },
      reviewer: { cli: "opencode", provider: "local", model: "small", access: "read_only" },
    },
  },
  repositories: [],
};

describe("privacy guard", () => {
  it("accepts a repository whose roles all use local providers", () => {
    expect(() => assertPrivacy(config, repository)).not.toThrow();
  });

  it.each(["planner", "builder", "reviewer"] as const)("rejects a cloud route for %s", (role) => {
    const routed = structuredClone(repository);
    routed.agents[role].provider = "cloud";
    expect(() => assertPrivacy(config, routed)).toThrow(`blocked for ${repository.id} ${role}`);
  });

  it("rejects an unknown provider", () => {
    const routed = structuredClone(repository);
    routed.agents.planner.provider = "unknown";
    expect(() => assertPrivacy(config, routed)).toThrow("Unknown provider");
  });

  it("rejects inherited object property names as providers", () => {
    const routed = structuredClone(repository);
    routed.agents.planner.provider = "constructor";
    expect(() => assertPrivacy(config, routed)).toThrow("Unknown provider");
  });
});
