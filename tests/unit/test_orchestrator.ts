// ============================================================
// test_orchestrator.ts
// Purpose : Verify pause, approval, build, verification and review gates
// Feature : Single-ticket orchestration
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Minimal Single-Ticket Orchestrator
// ============================================================
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { planTicket, resumeTicket, type AgentRunner } from "@/engine/orchestrator";
import type { Ticket, VerificationResult } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { TrackerAdapter } from "@/adapters/tracker/types";

vi.mock("@/adapters/cli_runner/workspace", () => ({
  assertBuilderWorkspace: vi.fn(async () => undefined),
  getWorkspaceDiff: vi.fn(async () => "diff --git a/file b/file"),
}));

const roots: string[] = [];
type ApprovalBox = { current: boolean };

async function makeDirectories(root: string) {
  const workspace = join(root, "repository");
  const factoryRoot = join(root, "factory");
  const outputDirectory = join(factoryRoot, "runs");
  await mkdir(workspace);
  await mkdir(join(factoryRoot, "src/agents/planner"), { recursive: true });
  await mkdir(join(factoryRoot, "src/agents/builder"), { recursive: true });
  await mkdir(join(factoryRoot, "src/agents/reviewer"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "Repository rules");
  await writeFile(join(factoryRoot, "src/agents/planner/prompt.md"), "Planner role");
  await writeFile(join(factoryRoot, "src/agents/builder/prompt.md"), "Builder role");
  await writeFile(join(factoryRoot, "src/agents/reviewer/prompt.md"), "Reviewer role");
  return { workspace, factoryRoot, outputDirectory };
}

function makeTicket(): Ticket {
  return {
    id: "17",
    project: "sample",
    title: "Ticket",
    description: "Description",
    acceptance_criteria: ["works"],
    state: "ai_ready",
    author: "reporter",
    url: "https://example.test/issues/17",
  };
}

function makeRepository(workspace: string): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: workspace,
    use_worktree: true,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true, ignore_paths: [".env*"] },
    context: { mode: "repo_only", repo_files: ["AGENTS.md"] },
    tracker: { provider: "local_md", allowed_approvers: ["maintainer"] },
  };
}

function makeTracker(ticket: Ticket, calls: string[], approval: ApprovalBox): TrackerAdapter {
  return {
    listReadyTickets: async () => [ticket],
    getTicket: async () => ticket,
    publishPlan: async ({ planHash }) => {
      calls.push(`plan:${planHash}`);
    },
    getApproval: async ({ planHash }) => (approval.current ? { author: "maintainer", planHash } : null),
    updateState: async ({ state }) => {
      calls.push(`state:${state}`);
    },
  };
}

function makeAgentRunner(calls: string[], verdict: string): AgentRunner {
  return async (input) => {
    calls.push(input.role);
    const filenames = { planner: "PLAN.md", builder: "BUILDER_SUMMARY.md", reviewer: "REVIEW_REPORT.md" };
    const outputFile = join(input.outputDirectory, filenames[input.role]);
    const content = input.role === "planner" ? "Approved plan" : `**Verdict:** \`${verdict}\`\n`;
    await writeFile(outputFile, content);
    return {
      role: input.role,
      status: "success",
      provider_used: "openai",
      model_used: "test",
      duration_seconds: 1,
      tokens_used: 10,
      estimated_cost_usd: 0,
      output_file: outputFile,
    };
  };
}

async function makeOptions(verdict = "APPROVE_FOR_DRAFT_PR") {
  const root = await mkdtemp(join(tmpdir(), "factory-run-"));
  roots.push(root);
  const { workspace, factoryRoot, outputDirectory } = await makeDirectories(root);
  const ticket = makeTicket();
  const repository = makeRepository(workspace);
  const approval = { current: false };
  const calls: string[] = [];
  const tracker = makeTracker(ticket, calls, approval);
  const agentRunner = makeAgentRunner(calls, verdict);
  const verifier = async (): Promise<VerificationResult> => ({
    passed: true,
    attempt: 1,
    failed_step: null,
    summary: "passed",
  });
  return {
    root,
    calls,
    approve: () => (approval.current = true),
    planOptions: { ticketId: ticket.id, repository, tracker, workspace, factoryRoot, outputDirectory, agentRunner },
    resumeOptions: { repository, tracker, factoryRoot, builderWorkspace: workspace, agentRunner, verifier },
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("publishes a plan and pauses before the Builder runs", async () => {
  const fixture = await makeOptions();
  const result = await planTicket(fixture.planOptions);
  expect(result.status).toBe("needs_approval");
  expect(fixture.calls).toContain("planner");
  expect(fixture.calls).not.toContain("builder");
});

it("does not build before a current allowed approval exists", async () => {
  const fixture = await makeOptions();
  const planned = await planTicket(fixture.planOptions);
  const result = await resumeTicket({ ...fixture.resumeOptions, runFile: planned.runFile });
  expect(result.status).toBe("needs_approval");
  expect(fixture.calls).not.toContain("builder");
});

it("runs Builder, verification and a fresh Reviewer after approval", async () => {
  const fixture = await makeOptions();
  const planned = await planTicket(fixture.planOptions);
  fixture.approve();
  const result = await resumeTicket({ ...fixture.resumeOptions, runFile: planned.runFile });
  expect(result.status).toBe("reviewed");
  expect(fixture.calls).toContain("builder");
  expect(fixture.calls).toContain("reviewer");
});

it("stops before Reviewer when verification fails", async () => {
  const fixture = await makeOptions();
  fixture.resumeOptions.verifier = async () => ({
    passed: false,
    attempt: 1,
    failed_step: "test",
    summary: "failed",
  });
  const planned = await planTicket(fixture.planOptions);
  fixture.approve();
  const result = await resumeTicket({ ...fixture.resumeOptions, runFile: planned.runFile });
  expect(result.status).toBe("failed");
  expect(fixture.calls).not.toContain("reviewer");
});

it("does not mark a review requesting changes as ready", async () => {
  const fixture = await makeOptions("CHANGES_REQUESTED");
  const planned = await planTicket(fixture.planOptions);
  fixture.approve();
  const result = await resumeTicket({ ...fixture.resumeOptions, runFile: planned.runFile });
  expect(result.status).toBe("changes_requested");
  expect(fixture.calls).not.toContain("state:ai_pr_ready");
});
