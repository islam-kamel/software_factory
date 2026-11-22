// ============================================================
// test_phase2.ts
// Purpose : Exercise the managed approval, repair, review and Draft PR lifecycle
// Feature : Phase 2 managed automation
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 2 Acceptance Criteria
// ============================================================
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitHubHost } from "@/adapters/git_host/github";
import { createLocalMarkdownTracker } from "@/adapters/tracker/local_md";
import type { AgentRequest, AgentRunner } from "@/engine/orchestrator";
import type { FactoryConfig, ResolvedRepository } from "@/engine/config_schemas";
import type { AgentResult, VerificationResult } from "@/engine/contracts";
import type { NotificationEvent, Notifier } from "@/adapters/notifier/console";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import { planManagedTicket, resumeManagedTicket } from "@/engine/automation";

const roots: string[] = [];

type Fixture = {
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function makeFixture(): Promise<Fixture> {
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

function managedOptions(fixture: Fixture) {
  return {
    repository: fixture.repository,
    factory: fixture.factory,
    tracker: fixture.tracker,
    factoryRoot: fixture.factoryRoot,
  };
}

async function planFixture(fixture: Fixture, agentRunner: AgentRunner, notifier: Notifier) {
  return planManagedTicket({
    ...managedOptions(fixture),
    ticketId: "17",
    outputDirectory: fixture.outputDirectory,
    agentRunner,
    notifier,
  });
}

function failApprovalReadOnce(tracker: TrackerAdapter): TrackerAdapter {
  let failed = false;
  return {
    ...tracker,
    getApproval: async (input) => {
      if (!failed) {
        failed = true;
        throw new Error("synthetic tracker read failure");
      }
      return tracker.getApproval(input);
    },
  };
}

function failReadyUpdate(tracker: TrackerAdapter, updates: string[]): TrackerAdapter {
  return {
    ...tracker,
    updateState: async (input) => {
      updates.push(input.state);
      if (input.state === "ai_pr_ready") throw new Error("synthetic tracker write failure");
      await tracker.updateState(input);
    },
  };
}

async function resumeWithoutApproval(input: {
  fixture: Fixture;
  runFile: string;
  agentRunner: AgentRunner;
  notifier: Notifier;
}) {
  return resumeManagedTicket({
    ...managedOptions(input.fixture),
    runFile: input.runFile,
    agentRunner: input.agentRunner,
    notifier: input.notifier,
  });
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

function makeAgentRunner(verdict: string, protectedWrite = false): { runner: AgentRunner; roles: string[] } {
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

function fakeGitHubHost(
  requests: Array<{ method: string; url: string; body?: string }>,
  repositoryPath: string,
  failCreate = false,
) {
  const response = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
  function createPullResponse(body: string | undefined): Response {
    const payload = JSON.parse(body ?? "{}") as { head?: string; base?: string; body?: string; draft?: boolean };
    return response({
      number: 41,
      html_url: "https://github.com/owner/sample/pull/41",
      draft: payload.draft,
      body: payload.body,
      head: {
        ref: payload.head,
        sha: git(repositoryPath, ["rev-parse", "refs/heads/ai/issue-17"]),
        repo: { full_name: "owner/sample" },
      },
      base: { ref: payload.base, repo: { full_name: "owner/sample" } },
    });
  }
  function apiResponse(url: string, method: string, body: string | undefined): Response {
    if (method === "GET" && url.includes("/pulls?")) return response([]);
    if (method === "POST" && url.endsWith("/pulls")) return createPullResponse(body);
    throw new Error(`Unexpected mocked GitHub request: ${url}`);
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, ...(body ? { body } : {}) });
    if (failCreate && method === "POST" && url.endsWith("/pulls")) throw new Error("synthetic connection reset");
    return apiResponse(url, method, body);
  };
  return createGitHubHost({ repository: "owner/sample", token: "test-token", fetcher });
}

async function addApproval(fixture: Fixture, planHash: string): Promise<void> {
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

function makeVerifier(calls: number[], failFirst: boolean, timeoutCalls: number[] = []) {
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("pauses before worktree creation, repairs once, and delivers the verified Draft PR", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const events: NotificationEvent[] = [];
  const notifier: Notifier = {
    notify: async (event) => {
      events.push(event);
      if (event.state === "needs_approval" || event.state === "ai_pr_ready")
        throw new Error("mock notification failure");
    },
  };
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const verifyCalls: number[] = [];
  const timeoutCalls: number[] = [];
  const planned = await planFixture(fixture, runner, notifier);
  expect(planned.status).toBe("needs_approval");
  expect(planned.notificationError).toMatch(/failed/i);
  expect(roles).toEqual(["planner"]);
  expect(await readdir(fixture.worktreeRoot)).toEqual([".claims"]);
  const pending = await resumeWithoutApproval({ fixture, runFile: planned.runFile, agentRunner: runner, notifier });
  expect(pending.status).toBe("needs_approval");
  expect(roles).toEqual(["planner"]);
  expect(await readdir(fixture.worktreeRoot)).toEqual([".claims"]);

  await addApproval(fixture, planned.planHash);
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier(verifyCalls, true, timeoutCalls),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier,
  });

  expect(result.status).toBe("pr_ready");
  expect(result.notificationError).toMatch(/failed/i);
  expect(result.url).toBe("https://github.com/owner/sample/pull/41");
  expect(roles).toEqual(["planner", "builder", "builder", "reviewer"]);
  expect(verifyCalls).toHaveLength(4);
  expect(timeoutCalls).toEqual([60_000, 60_000, 60_000, 60_000]);
  expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({ draft: true, head: "ai/issue-17", base: "main" });
  expect(requests[1]?.body).toContain("Approved plan");
  expect(requests[1]?.body).toContain("APPROVE_FOR_DRAFT_PR");
  expect(requests[1]?.body).toContain("## Reviewer report");
  expect(requests[1]?.body).toContain("**Verdict:** `APPROVE_FOR_DRAFT_PR`");
  expect(events.map((event) => event.state)).toEqual(["needs_approval", "ai_pr_ready"]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_pr_ready");
  expect(await readdir(fixture.worktreeRoot)).toContain(".software-factory-managed");
  expect(git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
  expect(git(join(fixture.root, "origin.git"), ["rev-parse", "refs/heads/ai/issue-17"])).toMatch(/^[a-f\d]{40,64}$/i);
});

it("blocks protected-file delivery and records the terminal failure", async () => {
  const fixture = await makeFixture();
  const { runner } = makeAgentRunner("APPROVE_FOR_DRAFT_PR", true);
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier([], false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("failed");
  expect(requests).toEqual([]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_failed");
  expect(git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
});

it("releases only the active execution after a tracker read failure and then resumes once", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const tracker = failApprovalReadOnce(fixture.tracker);
  const options = {
    ...managedOptions(fixture),
    tracker,
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier([], false),
    gitHost: fakeGitHubHost([], fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  };
  await expect(resumeManagedTicket(options)).rejects.toThrow(/read ticket approval state/i);
  expect((await fixture.tracker.getTicket("17")).state).toBe("needs_approval");
  expect(roles).toEqual(["planner"]);
  const result = await resumeManagedTicket(options);
  expect(result.status).toBe("pr_ready");
  expect(roles).toEqual(["planner", "builder", "reviewer"]);
});

it("returns a delivered PR when the final tracker state write fails", async () => {
  const fixture = await makeFixture();
  const { runner } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const updates: string[] = [];
  const tracker = failReadyUpdate(fixture.tracker, updates);
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    tracker,
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier([], false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("pr_ready");
  expect(result.url).toBe("https://github.com/owner/sample/pull/41");
  expect(result.trackerError).toMatch(/status could not be updated/i);
  expect(updates).not.toContain("ai_failed");
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_reviewing");
  expect(JSON.parse(await readFile(join(dirname(planned.runFile), "managed.json"), "utf8"))).toMatchObject({
    delivery: { url: result.url, number: 41 },
  });
  const claims = join(fixture.worktreeRoot, ".claims");
  const claimKey = (await readdir(claims))[0];
  expect(claimKey).toBeTruthy();
  expect(await readdir(join(claims, claimKey ?? ""))).toContain("active");
  expect(requests).toHaveLength(2);
});

it("retains an active claim when Draft creation has an uncertain response", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const options = {
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier([], false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath, true),
    notifier: { notify: async () => undefined },
  };

  const result = await resumeManagedTicket(options);

  expect(result.status).toBe("delivery_pending");
  expect(result.url).toBeUndefined();
  expect(result.lifecycleError).toMatch(/unknown/i);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_reviewing");
  expect(roles).toEqual(["planner", "builder", "reviewer"]);
  expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  expect(JSON.parse(await readFile(join(dirname(planned.runFile), "managed.json"), "utf8"))).toMatchObject({
    delivery: { status: "unknown", commit: expect.stringMatching(/^[a-f\d]{40,64}$/i) },
  });
  expect(await readdir(fixture.worktreeRoot)).toContain(".software-factory-managed");
  expect(git(join(fixture.root, "origin.git"), ["rev-parse", "refs/heads/ai/issue-17"])).toMatch(/^[a-f\d]{40,64}$/i);

  const retryRequests: Array<{ method: string; url: string; body?: string }> = [];
  const retry = await resumeManagedTicket({
    ...options,
    gitHost: fakeGitHubHost(retryRequests, fixture.repositoryPath),
  });
  expect(retry.status).toBe("delivery_pending");
  expect(roles).toEqual(["planner", "builder", "reviewer"]);
  expect(retryRequests).toEqual([]);
  const claims = join(fixture.worktreeRoot, ".claims");
  const claimKey = (await readdir(claims))[0];
  expect(await readdir(join(claims, claimKey ?? ""))).toContain("active");
});

it("does not create a Draft PR when Reviewer requests changes", async () => {
  const fixture = await makeFixture();
  const { runner } = makeAgentRunner("CHANGES_REQUESTED");
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier([], false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("changes_requested");
  expect(requests).toEqual([]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_failed");
});

it("rejects relative worktree roots before creating claims or launching agents", async () => {
  const fixture = await makeFixture();
  fixture.factory.workspace = { ...fixture.factory.workspace, worktree_root: "relative-phase2-worktrees" };
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  await expect(planFixture(fixture, runner, { notify: async () => undefined })).rejects.toThrow(/absolute/i);
  await expect(access(join(fixture.worktreeRoot, ".claims"))).rejects.toThrow();
  expect(roles).toEqual([]);
});

it("rejects a symlinked worktree ancestor before creating anything in the repository", async () => {
  const fixture = await makeFixture();
  const alias = join(fixture.root, "repository-alias");
  await symlink(fixture.repositoryPath, alias);
  fixture.factory.workspace = { ...fixture.factory.workspace, worktree_root: join(alias, "worktrees") };
  const before = await readdir(fixture.repositoryPath);
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");

  await expect(planFixture(fixture, runner, { notify: async () => undefined })).rejects.toThrow(/outside/i);

  expect(await readdir(fixture.repositoryPath)).toEqual(before);
  await expect(access(join(fixture.repositoryPath, "worktrees"))).rejects.toThrow();
  expect(git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
  expect(roles).toEqual([]);
  await expect(access(join(fixture.worktreeRoot, ".claims"))).rejects.toThrow();
});

it("finishes a non-ready plan preflight without leaving an orphan claim", async () => {
  const fixture = await makeFixture();
  const path = join(fixture.ticketsDirectory, "17.md");
  const ticket = await readFile(path, "utf8");
  await writeFile(path, ticket.replace("state: ai_ready", "state: ai_failed"));
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  await expect(planFixture(fixture, runner, { notify: async () => undefined })).rejects.toThrow(/not ready/i);
  await expect(access(join(fixture.worktreeRoot, ".claims"))).rejects.toThrow();
  await writeFile(path, ticket);
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  expect(planned.status).toBe("needs_approval");
  expect(roles).toEqual(["planner"]);
});

it("uses the resolved repository retry override over the factory limit", async () => {
  const fixture = await makeFixture();
  fixture.repository.max_retries = 1;
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const attempts: number[] = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: async ({ attempt = 1 }) => {
      attempts.push(attempt);
      return { passed: false, attempt, failed_step: "lint", summary: "lint failed" };
    },
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("failed");
  expect(attempts).toEqual([1]);
  expect(roles).toEqual(["planner", "builder"]);
  expect(requests).toEqual([]);
});

it("stops on secret-scan failure without retrying or delivering", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const attempts: number[] = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: async ({ attempt = 1 }) => {
      attempts.push(attempt);
      return { passed: false, attempt, failed_step: "secret_scan", summary: "scanner failed" };
    },
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("failed");
  expect(attempts).toEqual([1]);
  expect(roles).toEqual(["planner", "builder"]);
  expect(requests).toEqual([]);
});

it("stops after three failed verification attempts and cleans the owned worktree", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const attempts: number[] = [];
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: async ({ attempt = 1 }) => {
      attempts.push(attempt);
      return { passed: false, attempt, failed_step: "test", summary: "tests fail" };
    },
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("failed");
  expect(attempts).toEqual([1, 2, 3]);
  expect(roles).toEqual(["planner", "builder", "builder", "builder"]);
  expect(requests).toEqual([]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_failed");
  expect(await readdir(fixture.worktreeRoot)).toContain(".software-factory-managed");
  expect(git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
});

it("blocks delivery if the final verifier changes the committed worktree", async () => {
  const fixture = await makeFixture();
  const { runner } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  let attempts = 0;
  const result = await resumeManagedTicket({
    ...managedOptions(fixture),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: async ({ workspace, attempt = 1 }) => {
      attempts += 1;
      if (attempts === 3) await writeFile(join(workspace, "feature.txt"), "late mutation\n");
      return { passed: true, attempt, failed_step: null, summary: "passed" };
    },
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  });
  expect(result.status).toBe("failed");
  expect(result.cleanupError).toBeUndefined();
  expect(attempts).toBe(3);
  expect(requests).toEqual([]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_failed");
  expect(await readdir(fixture.worktreeRoot)).toContain(".software-factory-managed");
  expect(git(fixture.repositoryPath, ["status", "--porcelain"])).toBe("");
});
