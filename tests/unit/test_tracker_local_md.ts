// ============================================================
// test_tracker_local_md.ts
// Purpose : Verify local Markdown tickets and plan-bound approvals
// Feature : Ticket tracking
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Local Markdown Tracker
// ============================================================
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalMarkdownTracker } from "@/adapters/tracker/local_md";
import type { ResolvedRepository } from "@/engine/config_schemas";

const roots: string[] = [];
const currentHash = "a".repeat(64);

async function makeTracker(markdown: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-tickets-"));
  roots.push(root);
  await writeFile(join(root, "1.md"), markdown);
  return { root, tracker: createLocalMarkdownTracker({ repository: makeRepository(root), ticketsDirectory: root }) };
}

function makeRepository(root: string): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: root,
    use_worktree: false,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true },
    tracker: { provider: "local_md", allowed_approvers: ["maintainer"] },
  };
}

function ticketMarkdown(fields = ""): string {
  return `---\nid: "1"\nproject: sample\ntitle: Ticket\nacceptance_criteria:\n  - works\nstate: ai_ready\nauthor: reporter\n${fields}---\nTicket description\n`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("parses local tickets and returns only ready tickets", async () => {
  const { tracker } = await makeTracker(ticketMarkdown());
  const ready = await tracker.listReadyTickets();
  expect(ready).toHaveLength(1);
  expect(ready[0]).toMatchObject({ id: "1", title: "Ticket", description: "Ticket description" });
});

it("binds the exact allowed approval to the latest published plan", async () => {
  const { tracker, root } = await makeTracker(ticketMarkdown());
  await tracker.publishPlan({ ticketId: "1", plan: "steps", planHash: currentHash });
  const file = join(root, "1.md");
  const markdown = await readFile(file, "utf8");
  await writeFile(
    file,
    markdown.replace(
      "state: ai_ready\n",
      `state: ai_ready\nfactory_approval:\n  author: maintainer\n  command: /approve\n  plan_hash: ${currentHash}\n`,
    ),
  );

  await expect(tracker.getApproval({ ticketId: "1", planHash: currentHash })).resolves.toEqual({
    author: "maintainer",
    planHash: currentHash,
  });
  await expect(tracker.getApproval({ ticketId: "1", planHash: "b".repeat(64) })).resolves.toBeNull();
});

it("rejects unlisted authors and non-exact approval commands", async () => {
  const { tracker, root } = await makeTracker(
    ticketMarkdown(
      `factory_plan_hash: ${currentHash}\nfactory_approval:\n  author: stranger\n  command: /approve\n  plan_hash: ${currentHash}\n`,
    ),
  );
  await expect(tracker.getApproval({ ticketId: "1", planHash: currentHash })).resolves.toBeNull();
  await writeFile(
    join(root, "1.md"),
    ticketMarkdown(
      `factory_plan_hash: ${currentHash}\nfactory_approval:\n  author: maintainer\n  command: /approve please\n  plan_hash: ${currentHash}\n`,
    ),
  );
  await expect(tracker.getApproval({ ticketId: "1", planHash: currentHash })).resolves.toBeNull();
});

it("updates the state without replacing the ticket description", async () => {
  const { tracker, root } = await makeTracker(ticketMarkdown());
  await tracker.updateState({ ticketId: "1", state: "ai_planning" });
  const updated = await readFile(join(root, "1.md"), "utf8");
  expect(updated).toContain("state: ai_planning");
  expect(updated).toContain("Ticket description");
});
