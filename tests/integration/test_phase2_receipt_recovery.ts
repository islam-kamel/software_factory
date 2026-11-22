// ============================================================
// test_phase2_receipt_recovery.ts
// Purpose : Verify safe retries for persisted Draft PR receipts
// Feature : Phase 2 managed automation
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 2 Acceptance Criteria
// ============================================================
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import { resumeManagedTicket } from "@/engine/automation";
import { readManagedRecord, writeManagedRecord } from "@/engine/automation_state";
import type { ManagedRecord } from "@/engine/automation_state";
import {
  addApproval,
  applyReadyUpdateThenFail,
  cleanupFixtures,
  failReadyUpdate,
  fakeGitHubHost,
  makeAgentRunner,
  makeFixture,
  makeVerifier,
  managedOptions,
  planFixture,
} from "./phase2_fixture";

afterEach(cleanupFixtures);

function failTicketReadOnce(tracker: TrackerAdapter): TrackerAdapter {
  let failed = false;
  return {
    ...tracker,
    getTicket: async (ticketId) => {
      if (!failed) {
        failed = true;
        throw new Error("synthetic completed-receipt tracker read failure");
      }
      return tracker.getTicket(ticketId);
    },
  };
}

type ReceiptOptions = Parameters<typeof resumeManagedTicket>[0];

async function verifyRetryFailures(input: {
  fixture: Awaited<ReturnType<typeof makeFixture>>;
  options: ReceiptOptions;
  claims: string;
  claimKey: string | undefined;
}): Promise<void> {
  const { fixture, options, claims, claimKey } = input;
  const readFailure = await resumeManagedTicket({ ...options, tracker: failTicketReadOnce(fixture.tracker) });
  expect(readFailure.trackerError).toMatch(/could not be read or updated/i);
  expect(await readdir(join(claims, claimKey ?? ""))).not.toContain("active");
  const writeFailure = await resumeManagedTicket({ ...options, tracker: failReadyUpdate(fixture.tracker, []) });
  expect(writeFailure.trackerError).toMatch(/status could not be updated/i);
  expect(await readdir(join(claims, claimKey ?? ""))).not.toContain("active");
  const appliedThenFailed = await resumeManagedTicket({
    ...options,
    tracker: applyReadyUpdateThenFail(fixture.tracker),
  });
  expect(appliedThenFailed.trackerError).toMatch(/status could not be updated/i);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_pr_ready");
  expect(await readdir(join(claims, claimKey ?? ""))).not.toContain("active");
}

async function verifyConcurrentRetry(input: {
  fixture: Awaited<ReturnType<typeof makeFixture>>;
  options: ReceiptOptions;
  claims: string;
  claimKey: string | undefined;
  expectedUrl: string | undefined;
  roles: string[];
  verifyCalls: number[];
  initialVerifyCalls: number;
  requests: Array<{ method: string; url: string; body?: string }>;
}): Promise<void> {
  const { fixture, options, claims, claimKey } = input;
  let unblock = () => {};
  let signalRead = () => {};
  const readStarted = new Promise<void>((resolve) => (signalRead = resolve));
  const readGate = new Promise<void>((resolve) => (unblock = resolve));
  const blockedTracker: TrackerAdapter = {
    ...fixture.tracker,
    getTicket: async (ticketId) => {
      signalRead();
      await readGate;
      return fixture.tracker.getTicket(ticketId);
    },
  };
  const winnerPromise = resumeManagedTicket({ ...options, tracker: blockedTracker });
  await readStarted;
  await expect(resumeManagedTicket({ ...options, tracker: fixture.tracker })).rejects.toThrow(/active execution/i);
  expect(await readdir(join(claims, claimKey ?? ""))).toContain("active");
  unblock();
  const winner = await winnerPromise;
  expect(winner.status).toBe("pr_ready");
  expect(winner.url).toBe(input.expectedUrl);
  expect(await readdir(claims)).not.toContain(claimKey);
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_pr_ready");
  expect(input.roles).toEqual(["planner", "builder", "reviewer"]);
  expect(input.verifyCalls).toHaveLength(input.initialVerifyCalls);
  expect(input.requests).toHaveLength(2);
}

it("returns a delivered PR when the final tracker state write fails", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const verifyCalls: number[] = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const updates: string[] = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const options = {
    ...managedOptions(fixture),
    tracker: failReadyUpdate(fixture.tracker, updates),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier(verifyCalls, false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  };
  const result = await resumeManagedTicket(options);
  expect(result.status).toBe("pr_ready");
  expect(result.url).toBe("https://github.com/owner/sample/pull/41");
  expect(result.trackerError).toMatch(/status could not be updated/i);
  const initialVerifyCalls = verifyCalls.length;
  expect(updates).not.toContain("ai_failed");
  expect((await fixture.tracker.getTicket("17")).state).toBe("ai_reviewing");
  expect(JSON.parse(await readFile(join(dirname(planned.runFile), "managed.json"), "utf8"))).toMatchObject({
    delivery: { url: result.url, number: 41 },
  });
  const claims = join(fixture.worktreeRoot, ".claims");
  const claimKey = (await readdir(claims))[0];
  expect(claimKey).toBeTruthy();
  expect(await readdir(join(claims, claimKey ?? ""))).not.toContain("active");
  expect(requests).toHaveLength(2);
  await expect(access(join(fixture.worktreeRoot, "sample-issue-17"))).rejects.toThrow();
  await verifyRetryFailures({ fixture, options, claims, claimKey });
  await verifyConcurrentRetry({
    fixture,
    options,
    claims,
    claimKey,
    expectedUrl: result.url,
    roles,
    verifyCalls,
    initialVerifyCalls,
    requests,
  });
});

it("rejects a complete receipt while its run still needs approval", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  const original = await readManagedRecord(planned.runFile);
  const receipt: NonNullable<ManagedRecord["delivery"]> = {
    status: "complete",
    url: "https://github.com/owner/sample/pull/41",
    number: 41,
    commit: "a".repeat(40),
  };
  await writeManagedRecord(planned.runFile, { ...original, delivery: receipt });
  const trackerCalls: string[] = [];
  const tracker: TrackerAdapter = {
    ...fixture.tracker,
    getTicket: async (ticketId) => {
      trackerCalls.push("getTicket");
      return fixture.tracker.getTicket(ticketId);
    },
    getApproval: async (input) => {
      trackerCalls.push("getApproval");
      return fixture.tracker.getApproval(input);
    },
    updateState: async (input) => {
      trackerCalls.push("updateState");
      await fixture.tracker.updateState(input);
    },
  };
  const options = { ...managedOptions(fixture), tracker, runFile: planned.runFile, agentRunner: runner };
  await expect(resumeManagedTicket(options)).rejects.toThrow(/approval state/i);
  expect(trackerCalls).toEqual([]);
  expect((await fixture.tracker.getTicket("17")).state).toBe("needs_approval");
  expect(roles).toEqual(["planner"]);
});

it("rejects repository context tampering on a valid completed receipt", async () => {
  const fixture = await makeFixture();
  const { runner, roles } = makeAgentRunner("APPROVE_FOR_DRAFT_PR");
  const verifyCalls: number[] = [];
  const planned = await planFixture(fixture, runner, { notify: async () => undefined });
  await addApproval(fixture, planned.planHash);
  const trackerCalls: string[] = [];
  const countedTracker: TrackerAdapter = {
    ...fixture.tracker,
    getTicket: async (ticketId) => {
      trackerCalls.push("getTicket");
      return fixture.tracker.getTicket(ticketId);
    },
    getApproval: async (input) => {
      trackerCalls.push("getApproval");
      return fixture.tracker.getApproval(input);
    },
    updateState: async (input) => {
      trackerCalls.push("updateState");
      await fixture.tracker.updateState(input);
    },
  };
  const updates: string[] = [];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const options = {
    ...managedOptions(fixture),
    tracker: failReadyUpdate(countedTracker, updates),
    runFile: planned.runFile,
    agentRunner: runner,
    verifier: makeVerifier(verifyCalls, false),
    gitHost: fakeGitHubHost(requests, fixture.repositoryPath),
    notifier: { notify: async () => undefined },
  };
  const delivered = await resumeManagedTicket(options);
  expect(delivered.trackerError).toMatch(/status could not be updated/i);
  const priorTrackerCalls = trackerCalls.length;
  const priorAgentCalls = roles.length;
  const priorVerifierCalls = verifyCalls.length;
  const priorHostCalls = requests.length;
  const record = await readManagedRecord(planned.runFile);
  await writeManagedRecord(planned.runFile, { ...record, repositoryId: "other" });
  await expect(resumeManagedTicket(options)).rejects.toThrow(/approval state/i);
  expect(trackerCalls).toHaveLength(priorTrackerCalls);
  expect(roles).toHaveLength(priorAgentCalls);
  expect(verifyCalls).toHaveLength(priorVerifierCalls);
  expect(requests).toHaveLength(priorHostCalls);
});
