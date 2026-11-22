// ============================================================
// test_tracker_github.ts
// Purpose : Verify GitHub issue and approval behavior without network access
// Feature : Ticket tracking
// Role    : Unit Test
// API Doc : GitHub REST API, Issues and Issue Comments
// ============================================================
import { expect, it } from "vitest";
import { createGitHubTracker } from "@/adapters/tracker/github";
import type { ResolvedRepository } from "@/engine/config_schemas";

const planHash = "c".repeat(64);

function makeRepository(): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: "/tmp/sample",
    use_worktree: true,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true },
    tracker: { provider: "github", repo: "owner/repo", allowed_approvers: ["maintainer"] },
  };
}

function issue(labels = ["ai-ready", "bug"]): object {
  return {
    number: 7,
    title: "Ticket title",
    body: "Description\n- [ ] acceptance",
    html_url: "https://github.com/owner/repo/issues/7",
    user: { login: "reporter" },
    labels: labels.map((name) => ({ name })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

it("lists only ready issues and excludes pull requests", async () => {
  const requests: string[] = [];
  const tracker = createGitHubTracker({
    repository: makeRepository(),
    token: "test-token",
    fetcher: async (input) => {
      requests.push(String(input));
      return jsonResponse([issue(), { ...issue(), number: 8, pull_request: { url: "https://api.test/pr" } }]);
    },
  });

  const tickets = await tracker.listReadyTickets();
  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ id: "7", project: "owner/repo", author: "reporter", state: "ai_ready" });
  const firstPage = new URL(requests[0] ?? "https://api.test");
  expect(firstPage.pathname).toBe("/repos/owner/repo/issues");
  expect(firstPage.searchParams.get("state")).toBe("open");
  expect(firstPage.searchParams.get("labels")).toBe("ai-ready");
  expect(firstPage.searchParams.get("per_page")).toBe("100");
  expect(firstPage.searchParams.get("page")).toBe("1");
});

it("preserves issue filters across pagination pages", async () => {
  const requests: string[] = [];
  const tracker = createGitHubTracker({
    repository: makeRepository(),
    token: "test-token",
    fetcher: async (input) => {
      requests.push(String(input));
      const page = new URL(String(input)).searchParams.get("page");
      return jsonResponse(page === "1" ? Array.from({ length: 100 }, () => issue()) : []);
    },
  });

  await tracker.listReadyTickets();
  expect(requests).toHaveLength(2);
  for (const [index, request] of requests.entries()) {
    const url = new URL(request);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("labels")).toBe("ai-ready");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("page")).toBe(String(index + 1));
  }
});

it("accepts an exact allowed approval after the latest plan comment", async () => {
  const marker = `<!-- software-factory-plan:${planHash} -->`;
  const tracker = createGitHubTracker({
    repository: makeRepository(),
    token: "test-token",
    fetcher: async () =>
      jsonResponse([
        { body: "/approve", user: { login: "maintainer" }, created_at: "2026-01-01T00:00:00Z" },
        { body: `Plan\n${marker}`, user: { login: "bot" }, created_at: "2026-01-01T00:01:00Z" },
        { body: "/approve please", user: { login: "maintainer" }, created_at: "2026-01-01T00:02:00Z" },
        { body: "/approve", user: { login: "MAINTAINER" }, created_at: "2026-01-01T00:03:00Z" },
      ]),
  });

  await expect(tracker.getApproval({ ticketId: "7", planHash })).resolves.toEqual({
    author: "MAINTAINER",
    planHash,
  });
});

it("ignores unauthorized approvals and preserves unrelated labels on state updates", async () => {
  const requests: { url: string; method: string; body: string | undefined }[] = [];
  const tracker = createGitHubTracker({
    repository: makeRepository(),
    token: "test-token",
    fetcher: async (input, init) => {
      const request = { url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() };
      requests.push(request);
      if (request.url.includes("/comments?")) {
        return jsonResponse([
          {
            body: `Plan\n<!-- software-factory-plan:${planHash} -->`,
            user: { login: "bot" },
            created_at: "2026-01-01T00:00:00Z",
          },
          { body: "/approve", user: { login: "stranger" }, created_at: "2026-01-01T00:01:00Z" },
        ]);
      }
      if (request.method === "GET") return jsonResponse(issue(["ai-ready", "bug", "triage"]));
      return jsonResponse({});
    },
  });

  await expect(tracker.getApproval({ ticketId: "7", planHash })).resolves.toBeNull();
  await tracker.updateState({ ticketId: "7", state: "ai_building" });
  expect(requests.some((request) => request.method === "DELETE" && request.url.endsWith("/labels/ai-ready"))).toBe(
    true,
  );
  expect(requests.some((request) => request.method === "POST" && request.body?.includes("ai-building"))).toBe(true);
  expect(requests.some((request) => request.url.endsWith("/labels/bug"))).toBe(false);
  expect(requests.some((request) => request.url.endsWith("/labels/triage"))).toBe(false);
});

it("publishes a plan with its hash marker and never includes the token", async () => {
  let requestBody = "";
  let authorization = "";
  const tracker = createGitHubTracker({
    repository: makeRepository(),
    token: "test-token",
    fetcher: async (_input, init) => {
      requestBody = init?.body?.toString() ?? "";
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({});
    },
  });
  await tracker.publishPlan({ ticketId: "7", plan: "steps", planHash });
  expect(requestBody).toContain(planHash);
  expect(requestBody).toContain("steps");
  expect(requestBody).not.toContain("test-token");
  expect(authorization).toBe("Bearer test-token");
});
