// ============================================================
// test_phase1.ts
// Purpose : Exercise a complete local ticket lifecycle with a deterministic agent
// Feature : Phase 1 MVP
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 1 Acceptance Criteria
// ============================================================
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { planTicket, resumeTicket, type AgentRequest } from "@/engine/orchestrator";
import { createLocalMarkdownTracker } from "@/adapters/tracker/local_md";
import type { AgentResult, VerificationResult } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";

vi.mock("@/adapters/cli_runner/workspace", () => ({
  assertBuilderWorkspace: vi.fn(async () => undefined),
  getWorkspaceDiff: vi.fn(async () => "scoped diff including new files"),
}));

const roots: string[] = [];

type PhaseFixture = {
  root: string;
  workspace: string;
  factoryRoot: string;
  ticketsDirectory: string;
  outputDirectory: string;
  repository: ResolvedRepository;
  tracker: ReturnType<typeof createLocalMarkdownTracker>;
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function prepareFixture(root: string): Promise<PhaseFixture> {
  const workspace = join(root, "repository");
  const factoryRoot = join(root, "factory");
  const ticketsDirectory = join(factoryRoot, "tickets");
  const outputDirectory = join(factoryRoot, "runs");
  await mkdir(workspace);
  await mkdir(ticketsDirectory, { recursive: true });
  for (const role of ["planner", "builder", "reviewer"]) {
    await mkdir(join(factoryRoot, "src/agents", role), { recursive: true });
    await writeFile(join(factoryRoot, "src/agents", role, "prompt.md"), `${role} role instructions`);
  }
  await writeFile(join(workspace, "AGENTS.md"), "Repository instructions");
  await writeTicket(ticketsDirectory);
  const repository = makeRepository(workspace);
  const tracker = createLocalMarkdownTracker({ repository, ticketsDirectory });
  return { root, workspace, factoryRoot, ticketsDirectory, outputDirectory, repository, tracker };
}

async function writeTicket(directory: string): Promise<void> {
  const markdown = [
    "---",
    'id: "17"',
    "project: sample",
    "title: Local ticket",
    "acceptance_criteria:",
    "  - implement behavior",
    "state: ai_ready",
    "author: reporter",
    "---",
    "Ticket description",
    "",
  ].join("\n");
  await writeFile(join(directory, "17.md"), markdown);
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
    verification: { secret_scan: "scan", lint: "lint", typecheck: "types", test: "tests" },
  };
}

function makeAgentRunner(roles: string[]): (request: AgentRequest) => Promise<AgentResult> {
  return async (request) => {
    roles.push(request.role);
    await checkPrompt(request);
    const files = { planner: "PLAN.md", builder: "BUILDER_SUMMARY.md", reviewer: "REVIEW_REPORT.md" };
    const outputFile = join(request.outputDirectory, files[request.role]);
    const content = request.role === "planner" ? "Approved plan" : "**Verdict:** `APPROVE_FOR_DRAFT_PR`\n";
    await writeFile(outputFile, content);
    return {
      role: request.role,
      status: "success",
      provider_used: "openai",
      model_used: "test",
      duration_seconds: 1,
      tokens_used: 12,
      estimated_cost_usd: 0,
      output_file: outputFile,
    };
  };
}

async function checkPrompt(request: AgentRequest): Promise<void> {
  const prompt = await readFile(request.promptPath, "utf8");
  expect(prompt).toContain("Local ticket");
  if (request.role === "builder") expect(prompt).toContain("Approved plan");
  if (request.role === "reviewer") expect(prompt).toContain("scoped diff including new files");
}

it("completes Plan, local approval, Build, Verify and Review outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-phase1-"));
  roots.push(root);
  const fixture = await prepareFixture(root);
  const roles: string[] = [];
  const agentRunner = makeAgentRunner(roles);
  const verifier = async (): Promise<VerificationResult> => ({
    passed: true,
    attempt: 1,
    failed_step: null,
    summary: "All four checks passed",
  });

  const planned = await planTicket({
    ticketId: "17",
    repository: fixture.repository,
    tracker: fixture.tracker,
    workspace: fixture.workspace,
    factoryRoot: fixture.factoryRoot,
    outputDirectory: fixture.outputDirectory,
    agentRunner,
  });
  expect(planned.status).toBe("needs_approval");
  expect(roles).toEqual(["planner"]);

  const ticketFile = join(fixture.ticketsDirectory, "17.md");
  const markdown = await readFile(ticketFile, "utf8");
  await writeFile(
    ticketFile,
    markdown.replace(
      "state: needs_approval\n",
      `state: needs_approval\nfactory_approval:\n  author: maintainer\n  command: /approve\n  plan_hash: ${planned.planHash}\n`,
    ),
  );

  const result = await resumeTicket({
    repository: fixture.repository,
    tracker: fixture.tracker,
    runFile: planned.runFile,
    factoryRoot: fixture.factoryRoot,
    builderWorkspace: fixture.workspace,
    agentRunner,
    verifier,
  });
  expect(result.status).toBe("reviewed");
  expect(result.approver).toBe("maintainer");
  expect(roles).toEqual(["planner", "builder", "reviewer"]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_reviewing");
  expect(result.runFile).not.toContain(fixture.workspace);
});
