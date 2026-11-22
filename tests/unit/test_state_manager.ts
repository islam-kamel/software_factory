// ============================================================
// test_state_manager.ts
// Purpose : Verify atomic ticket claims and validated lifecycle transitions
// Feature : Phase 2 ticket state and locking
// Role    : Unit Test
// API Doc : docs/system_design.md, Ticket Lifecycle
// ============================================================
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createTicketClaim,
  enterTicketClaim,
  finishTicketClaim,
  leaveTicketClaim,
  transitionTicket,
  validateTransition,
  type TicketClaim,
} from "@/engine/state_manager";
import type { Ticket } from "@/engine/contracts";
import type { TrackerAdapter } from "@/adapters/tracker/types";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "software-factory-state-"));
  fixtureRoots.push(root);
  const repository = join(root, "repository");
  const claims = join(root, "claims");
  await mkdir(repository);
  return { root, repository, claims };
}

function makeTracker(state: Ticket["state"], updates: Ticket["state"][]): TrackerAdapter {
  const ticket = {
    id: "17",
    project: "sample",
    title: "Ticket",
    description: "Description",
    acceptance_criteria: [],
    state,
    author: "reporter",
    url: "https://example.test/issues/17",
  } satisfies Ticket;
  return {
    listReadyTickets: async () => [],
    getTicket: async () => ticket,
    publishPlan: async () => undefined,
    getApproval: async () => null,
    updateState: async ({ state: next }) => {
      updates.push(next);
    },
  };
}

it("allows only one simultaneous claim for a repository ticket", async () => {
  const fixture = await makeFixture();
  const input = { root: fixture.claims, repository: fixture.repository, ticketId: "17" };
  const results = await Promise.allSettled([createTicketClaim(input), createTicketClaim(input)]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");

  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  if (winners[0]?.status === "fulfilled") {
    const keyDirectory = join(fixture.claims, (await readdir(fixture.claims))[0] ?? "");
    expect((await stat(fixture.claims)).mode & 0o077).toBe(0);
    expect((await stat(keyDirectory)).mode & 0o077).toBe(0);
    expect((await stat(join(keyDirectory, "claim.json"))).mode & 0o077).toBe(0);
    await finishTicketClaim(winners[0].value);
  }
});

it("keeps a claim across approval pause and permits one resume at a time", async () => {
  const fixture = await makeFixture();
  const active = await createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "17" });
  const claim: TicketClaim = {
    root: active.root,
    repository: active.repository,
    ticketId: active.ticketId,
    token: active.token,
  };

  await leaveTicketClaim(active);
  const resumes = await Promise.allSettled([enterTicketClaim(claim), enterTicketClaim(claim)]);
  const winners = resumes.filter((result) => result.status === "fulfilled");

  expect(winners).toHaveLength(1);
  if (winners[0]?.status === "fulfilled") await finishTicketClaim(winners[0].value);
  await expect(enterTicketClaim(claim)).rejects.toThrow(/claim/i);
});

it("rejects wrong tokens without releasing another owner's active claim", async () => {
  const fixture = await makeFixture();
  const active = await createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "17" });

  await expect(leaveTicketClaim({ ...active, executionToken: "0".repeat(64) })).rejects.toThrow(/claim/i);
  const names = await readdir(fixture.claims);
  expect(names).toHaveLength(1);
  await finishTicketClaim(active);
});

it("canonicalizes repository aliases and keeps different ticket IDs distinct", async () => {
  const fixture = await makeFixture();
  const alias = join(fixture.root, "repository-alias");
  await symlink(fixture.repository, alias);
  const first = await createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "a/b" });

  await expect(createTicketClaim({ root: fixture.claims, repository: alias, ticketId: "a/b" })).rejects.toThrow(
    /claim/i,
  );
  const second = await createTicketClaim({ root: fixture.claims, repository: alias, ticketId: "a?b" });
  expect(first.repository).toBe(await realpath(fixture.repository));
  expect(second.repository).toBe(await realpath(fixture.repository));

  await finishTicketClaim(first);
  await finishTicketClaim(second);
});

it("fails closed on abandoned active claims and tampered metadata", async () => {
  const fixture = await makeFixture();
  const active = await createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "17" });
  const claim: TicketClaim = {
    root: active.root,
    repository: active.repository,
    ticketId: active.ticketId,
    token: active.token,
  };
  await expect(enterTicketClaim(claim)).rejects.toThrow(/active execution/i);
  await leaveTicketClaim(active);
  const keyDirectory = join(fixture.claims, (await readdir(fixture.claims))[0] ?? "");
  const metadataPath = join(keyDirectory, "claim.json");
  await writeFile(metadataPath, "{}", { mode: 0o600 });

  await expect(enterTicketClaim(claim)).rejects.toThrow(/invalid/i);
  await expect(readFile(metadataPath, "utf8")).resolves.toBe("{}");
});

it("rejects unsafe inputs and claim roots overlapping the repository", async () => {
  const fixture = await makeFixture();

  await expect(createTicketClaim({ root: "", repository: fixture.repository, ticketId: "17" })).rejects.toThrow(
    /input/i,
  );
  await expect(
    createTicketClaim({ root: fixture.repository, repository: fixture.repository, ticketId: "17" }),
  ).rejects.toThrow(/outside/i);
  const nestedClaims = join(fixture.repository, "claims");
  await expect(
    createTicketClaim({ root: nestedClaims, repository: fixture.repository, ticketId: "17" }),
  ).rejects.toThrow(/outside/i);
  await expect(access(nestedClaims)).rejects.toThrow();
  await expect(
    createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "" }),
  ).rejects.toThrow(/input/i);
});

it("validates documented lifecycle transitions and rejects skipped states", async () => {
  const allowed: Array<[Ticket["state"], Ticket["state"]]> = [
    ["ai_ready", "ai_planning"],
    ["ai_planning", "needs_approval"],
    ["ai_planning", "ai_failed"],
    ["needs_approval", "ai_approved"],
    ["needs_approval", "ai_planning"],
    ["needs_approval", "ai_failed"],
    ["ai_approved", "ai_building"],
    ["ai_approved", "ai_failed"],
    ["ai_building", "verifying"],
    ["ai_building", "ai_failed"],
    ["verifying", "ai_building"],
    ["verifying", "ai_failed"],
    ["verifying", "ai_reviewing"],
    ["ai_reviewing", "ai_pr_ready"],
    ["ai_reviewing", "ai_failed"],
    ["ai_failed", "ai_ready"],
  ];
  const states: Ticket["state"][] = [
    "ai_ready",
    "ai_planning",
    "needs_approval",
    "ai_approved",
    "ai_building",
    "verifying",
    "ai_reviewing",
    "ai_pr_ready",
    "ai_failed",
  ];

  for (const from of states) {
    for (const to of states) {
      if (allowed.some(([start, end]) => start === from && end === to))
        expect(() => validateTransition(from, to)).not.toThrow();
      else expect(() => validateTransition(from, to)).toThrow(/transition/i);
    }
  }
});

it("reads current state and refuses an invalid transition before updating", async () => {
  const updates: Ticket["state"][] = [];
  const tracker = makeTracker("ai_ready", updates);

  await expect(transitionTicket({ tracker, ticketId: "17", state: "ai_building" })).rejects.toThrow(/transition/i);
  expect(updates).toEqual([]);
  await transitionTicket({ tracker, ticketId: "17", state: "ai_planning" });
  expect(updates).toEqual(["ai_planning"]);
});

it("rejects a symlinked claim metadata file", async () => {
  const fixture = await makeFixture();
  const active = await createTicketClaim({ root: fixture.claims, repository: fixture.repository, ticketId: "17" });
  const keyDirectory = join(fixture.claims, (await readdir(fixture.claims))[0] ?? "");
  const metadataPath = join(keyDirectory, "claim.json");
  const target = join(fixture.root, "outside.json");
  await writeFile(target, JSON.stringify({ token: active.token }), { mode: 0o600 });
  await unlink(metadataPath);
  await symlink(target, metadataPath);

  await expect(leaveTicketClaim(active)).rejects.toThrow(/invalid/i);
});
