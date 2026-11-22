// ============================================================
// phase2_fixture.ts
// Purpose : Share isolated fixtures and adapters for Phase 2 lifecycle specs
// Feature : Phase 2 managed automation
// Role    : Test Utility
// API Doc : N/A
// ============================================================
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubHost } from "@/adapters/git_host/github";
import { createLocalMarkdownTracker } from "@/adapters/tracker/local_md";
import type { AgentRequest, AgentRunner } from "@/engine/orchestrator";
import type { FactoryConfig, ResolvedRepository } from "@/engine/config_schemas";
import type { AgentResult, VerificationResult } from "@/engine/contracts";
import type { Notifier } from "@/adapters/notifier/console";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import { planManagedTicket } from "@/engine/automation";

const roots: string[] = [];

export type Fixture = {
  root: string;
  repositoryPath: string;
  factoryRoot: string;
  ticketsDirectory: string;
  outputDirectory: string;
  worktreeRoot: string;
  repository: ResolvedRepository;
  factory: FactoryConfig;
  tracker: ReturnType<typeof createLocalMarkdownTracker>;
};

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-phase2-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const factoryRoot = join(root, "factory");
  const ticketsDirectory = join(factoryRoot, "tickets");
  const outputDirectory = join(factoryRoot, "runs");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath);
  git(repositoryPath, ["init", "-b", "main"]);
  git(repositoryPath, ["config", "user.name", "Factory Test"]);
  git(repositoryPath, ["config", "user.email", "factory@example.invalid"]);
  await writeFile(join(repositoryPath, "AGENTS.md"), "Repository rules\n");
  git(repositoryPath, ["add", "AGENTS.md"]);
  git(repositoryPath, ["commit", "-m", "base"]);
  const remote = join(root, "origin.git");
  git(repositoryPath, ["init", "--bare", remote]);
  git(repositoryPath, ["remote", "add", "origin", remote]);
  git(repositoryPath, ["push", "origin", "main"]);
  for (const role of ["planner", "builder", "reviewer"]) {
    const directory = join(factoryRoot, "src/agents", role);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "prompt.md"), `${role} instructions`);
  }
  await mkdir(ticketsDirectory, { recursive: true });
  await writeTicket(ticketsDirectory);
  const repository = makeRepository(repositoryPath);
  return {
    root,
    repositoryPath,
    factoryRoot,
    ticketsDirectory,
    outputDirectory,
    worktreeRoot,
    repository,
    factory: makeFactory(worktreeRoot),
    tracker: createLocalMarkdownTracker({ repository, ticketsDirectory }),
  };
}

async function writeTicket(directory: string): Promise<void> {
  await writeFile(
    join(directory, "17.md"),
    [
      "---",
      'id: "17"',
      "project: sample",
      "title: Managed ticket",
      "acceptance_criteria:",
      "  - implement behavior",
      "state: ai_ready",
      "author: reporter",
      "---",
      "Ticket description",
      "",
    ].join("\n"),
  );
}

function makeRepository(localPath: string): ResolvedRepository {
  const role = { cli: "codex", provider: "openai", model: "test" };
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: localPath,
    use_worktree: true,
    base_branch: "main",
    agents: { planner: role, builder: role, reviewer: role },
    privacy: { allow_cloud_llm: true, ignore_paths: [".env*"] },
    context: { mode: "repo_only", repo_files: ["AGENTS.md"] },
    tracker: { provider: "local_md", repo: "owner/sample", allowed_approvers: ["maintainer"] },
    verification: { secret_scan: "secret-scan", lint: "lint", typecheck: "typecheck", test: "test" },
  };
}

function makeFactory(worktreeRoot: string): FactoryConfig {
  return {
    version: "1",
    adapters: { git_host: "github", notifier: "console" },
    limits: { max_self_heal_retries: 3, agent_timeout_minutes: 1 },
    workspace: {
      use_worktree: true,
      worktree_root: worktreeRoot,
      cleanup_on_complete: true,
      branch_prefix: "ai/",
      draft_pr_only: true,
    },
  };
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function managedOptions(fixture: Fixture) {
  return {
    repository: fixture.repository,
    factory: fixture.factory,
    tracker: fixture.tracker,
    factoryRoot: fixture.factoryRoot,
  };
}

export async function planFixture(fixture: Fixture, agentRunner: AgentRunner, notifier: Notifier) {
  return planManagedTicket({
    ...managedOptions(fixture),
    ticketId: "17",
    outputDirectory: fixture.outputDirectory,
    agentRunner,
    notifier,
  });
}

export function failReadyUpdate(tracker: TrackerAdapter, updates: string[]): TrackerAdapter {
  return {
    ...tracker,
    updateState: async (input) => {
      updates.push(input.state);
      if (input.state === "ai_pr_ready") throw new Error("synthetic tracker write failure");
      await tracker.updateState(input);
    },
  };
}

export function applyReadyUpdateThenFail(tracker: TrackerAdapter): TrackerAdapter {
  return {
    ...tracker,
    updateState: async (input) => {
      await tracker.updateState(input);
      if (input.state === "ai_pr_ready") throw new Error("synthetic post-write failure");
    },
  };
}

async function writeBuilderChange(request: AgentRequest, protectedWrite: boolean): Promise<void> {
  const target = join(request.workspace, protectedWrite ? ".env.local" : "feature.txt");
  await writeFile(target, protectedWrite ? "synthetic value" : "feature implementation\n");
}

function agentContent(role: AgentRequest["role"], verdict: string): string {
  if (role === "planner") return "Approved plan";
  if (role === "reviewer") return `**Verdict:** \`${verdict}\`\n`;
  return "Builder completed";
}

export function makeAgentRunner(verdict: string, protectedWrite = false): { runner: AgentRunner; roles: string[] } {
  const roles: string[] = [];
  const runner: AgentRunner = async (request: AgentRequest): Promise<AgentResult> => {
    roles.push(request.role);
    const filename = { planner: "PLAN.md", builder: "BUILDER_SUMMARY.md", reviewer: "REVIEW_REPORT.md" }[request.role];
    const outputFile = join(request.outputDirectory, filename);
    if (request.role === "builder") await writeBuilderChange(request, protectedWrite);
    await writeFile(outputFile, agentContent(request.role, verdict));
    return {
      role: request.role,
      status: "success",
      provider_used: "test",
      model_used: "test",
      duration_seconds: 1,
      tokens_used: 0,
      estimated_cost_usd: 0,
      output_file: outputFile,
    };
  };
  return { runner, roles };
}

export function fakeGitHubHost(
  requests: Array<{ method: string; url: string; body?: string }>,
  repositoryPath: string,
  failCreate = false,
) {
  const response = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, ...(body ? { body } : {}) });
    return mockGitHubResponse({ url, method, body, repositoryPath, failCreate, response });
  };
  return createGitHubHost({ repository: "owner/sample", token: "test-token", fetcher });
}

function mockGitHubResponse(input: {
  url: string;
  method: string;
  body: string | undefined;
  repositoryPath: string;
  failCreate: boolean;
  response: (value: unknown) => Response;
}): Response {
  if (input.failCreate && input.method === "POST" && input.url.endsWith("/pulls")) {
    throw new Error("synthetic connection reset");
  }
  if (input.method === "GET" && input.url.includes("/pulls?")) return input.response([]);
  if (input.method === "POST" && input.url.endsWith("/pulls")) return mockPullResponse(input);
  throw new Error(`Unexpected mocked GitHub request: ${input.url}`);
}

function mockPullResponse(input: {
  url: string;
  body: string | undefined;
  repositoryPath: string;
  response: (value: unknown) => Response;
}): Response {
  const payload = JSON.parse(input.body ?? "{}") as { head?: string; base?: string; body?: string; draft?: boolean };
  const sha = git(input.repositoryPath, ["rev-parse", "refs/heads/ai/issue-17"]);
  return input.response({
    number: 41,
    html_url: "https://github.com/owner/sample/pull/41",
    draft: payload.draft,
    body: payload.body,
    head: { ref: payload.head, sha, repo: { full_name: "owner/sample" } },
    base: { ref: payload.base, repo: { full_name: "owner/sample" } },
  });
}

export async function addApproval(fixture: Fixture, planHash: string): Promise<void> {
  const path = join(fixture.ticketsDirectory, "17.md");
  const markdown = await readFile(path, "utf8");
  await writeFile(
    path,
    markdown.replace(
      "state: needs_approval\n",
      `state: needs_approval\nfactory_approval:\n  author: maintainer\n  command: /approve\n  plan_hash: ${planHash}\n`,
    ),
  );
}

export function makeVerifier(calls: number[], failFirst: boolean, timeoutCalls: number[] = []) {
  return async (options: {
    attempt?: number;
    workspace: string;
    baseBranch?: string;
    logDirectory?: string;
    timeoutMs?: number;
  }): Promise<VerificationResult> => {
    calls.push(options.attempt ?? 1);
    if (options.timeoutMs !== undefined) timeoutCalls.push(options.timeoutMs);
    if (failFirst && calls.length === 1) {
      return { passed: false, attempt: options.attempt ?? 1, failed_step: "lint", summary: "lint failed" };
    }
    return { passed: true, attempt: options.attempt ?? 1, failed_step: null, summary: "all checks passed" };
  };
}
