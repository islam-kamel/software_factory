// ============================================================
// test_phase2.ts
// Purpose : Exercise the managed approval, repair, review and Draft PR lifecycle
// Feature : Phase 2 managed automation
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 2 Acceptance Criteria
// ============================================================
import { access, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentRunner } from "@/engine/orchestrator";
import type { NotificationEvent, Notifier } from "@/adapters/notifier/console";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import { resumeManagedTicket } from "@/engine/automation";
import type { Fixture } from "./phase2_fixture";
import {
  addApproval,
  cleanupFixtures,
  fakeGitHubHost,
  git,
  makeAgentRunner,
  makeFixture,
  makeVerifier,
  managedOptions,
  planFixture,
} from "./phase2_fixture";

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

afterEach(cleanupFixtures);

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
