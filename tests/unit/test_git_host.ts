// ============================================================
// test_git_host.ts
// Purpose : Verify verified Git snapshots and idempotent Draft PR delivery
// Feature : Draft delivery
// Role    : Unit Tests
// API Doc : src/adapters/git_host/github.ts
// ============================================================
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { Ticket, VerificationResult } from "@/engine/contracts";
import { createGitHubHost } from "@/adapters/git_host/github";
import { assertDeliverySnapshot, prepareCommit, pushBranch } from "@/adapters/git_host/delivery_git";

type Fixture = { root: string; source: string; workspace: string; remote: string };
type Push = (input: { workspace: string; branch: string; commit: string }) => Promise<void>;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-git-host-"));
  const source = join(root, "source");
  const workspace = join(root, "builder");
  const remote = join(root, "origin.git");
  await mkdir(source);
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.name", "Factory Test"]);
  git(source, ["config", "user.email", "factory@example.invalid"]);
  await writeFile(join(source, "base.txt"), "base\n");
  git(source, ["add", "base.txt"]);
  git(source, ["commit", "-m", "base"]);
  git(source, ["init", "--bare", remote]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "origin", "main"]);
  git(source, ["worktree", "add", "-b", "ai/issue-17", workspace, "main"]);
  git(workspace, ["config", "user.name", "Factory Test"]);
  git(workspace, ["config", "user.email", "factory@example.invalid"]);
  return { root, source, workspace, remote };
}

function repository(workspace: string): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: workspace,
    use_worktree: true,
    base_branch: "main",
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    privacy: { allow_cloud_llm: true },
    tracker: { provider: "github", repo: "owner/sample", token_env: "GITHUB_TOKEN" },
    verification: { secret_scan: "gitleaks detect" },
  };
}

const ticket: Ticket = {
  id: "17",
  project: "sample",
  title: "Fix sample",
  description: "A synthetic ticket",
  acceptance_criteria: ["Works"],
  state: "ai_reviewing",
  author: "operator",
  url: "https://example.invalid/tickets/17",
};
const verification: VerificationResult = { passed: true, attempt: 1, failed_step: null, summary: "All checks passed" };

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function pullRequest(
  input: {
    draft?: boolean;
    commit?: string;
    headRepository?: string;
    baseRepository?: string;
    body?: string;
    url?: string;
  } = {},
): object {
  return {
    number: 42,
    html_url: input.url ?? "https://github.com/owner/sample/pull/42",
    body: input.body ?? "",
    draft: input.draft ?? true,
    head: {
      ref: "ai/issue-17",
      sha: input.commit ?? "a".repeat(40),
      repo: { full_name: input.headRepository ?? "owner/sample" },
    },
    base: { ref: "main", repo: { full_name: input.baseRepository ?? "owner/sample" } },
  };
}

async function deliveryInput(current: Fixture) {
  await writeFile(join(current.workspace, "delivery.txt"), "ready for delivery\n");
  const commit = await prepareCommit({
    workspace: current.workspace,
    branch: "ai/issue-17",
    message: "feat: synthetic change",
  });
  return {
    repository: repository(current.workspace),
    workspace: current.workspace,
    branch: "ai/issue-17",
    baseBranch: "main",
    commit,
    ticket,
    plan: "Update the sample file.",
    verification,
    review: "Looks good.",
  };
}

function expectedPullRequestBody(input: Awaited<ReturnType<typeof deliveryInput>>): string {
  return [
    `Ticket: [#${input.ticket.id}](${input.ticket.url}) ${input.ticket.title}`,
    "## Plan summary",
    input.plan,
    "## Verification",
    `Passed: ${input.verification.passed}`,
    `Attempt: ${input.verification.attempt}`,
    `Failed step: ${input.verification.failed_step ?? "none"}`,
    input.verification.summary,
    "## Reviewer report",
    input.review,
    `<!-- software-factory-delivery:${createHash("sha256")
      .update(`${input.ticket.id}\0${input.commit}\0${input.review}`)
      .digest("hex")} -->`,
  ].join("\n\n");
}

it("commits and pushes only the immutable ai issue worktree snapshot", async () => {
  const current = await fixture();
  try {
    await writeFile(join(current.workspace, "change.txt"), "change\n");
    const commit = await prepareCommit({ workspace: current.workspace, branch: "ai/issue-17", message: "change" });
    expect(commit).toMatch(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i);
    await assertDeliverySnapshot({ workspace: current.workspace, branch: "ai/issue-17", commit });
    await pushBranch({ workspace: current.workspace, branch: "ai/issue-17", commit });
    expect(git(current.source, ["--git-dir", current.remote, "rev-parse", "refs/heads/ai/issue-17"])).toBe(commit);

    await writeFile(join(current.workspace, "later.txt"), "late change\n");
    await expect(
      assertDeliverySnapshot({ workspace: current.workspace, branch: "ai/issue-17", commit }),
    ).rejects.toThrow(/changes/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("rejects protected branches and configured Git filters before staging", async () => {
  const current = await fixture();
  const hookMarker = join(current.root, "filter-ran");
  try {
    await expect(prepareCommit({ workspace: current.workspace, branch: "main", message: "invalid" })).rejects.toThrow(
      /ai\/issue/,
    );
    await writeFile(join(current.workspace, "filtered.txt"), "contents\n");
    git(current.workspace, ["config", "filter.synthetic.clean", `touch '${hookMarker}'`]);
    await expect(
      prepareCommit({ workspace: current.workspace, branch: "ai/issue-17", message: "filtered" }),
    ).rejects.toThrow(/filters/);
    expect(git(current.workspace, ["diff", "--cached", "--name-only"])).toBe("");
    await expect(import("node:fs/promises").then(({ access }) => access(hookMarker))).rejects.toThrow();
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("creates a Draft PR containing the full reviewer report without posting comments", async () => {
  const current = await fixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const push: Push = async () => {};
  let commit = "a".repeat(40);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/pulls?")) return response([]);
    if (url.endsWith("/pulls")) {
      const body = JSON.parse(String(init?.body)) as { body: string };
      return response(pullRequest({ commit, body: body.body }));
    }
    throw new Error("unexpected request");
  };
  try {
    const input = await deliveryInput(current);
    commit = input.commit;
    const result = await createGitHubHost({
      repository: "owner/sample",
      token: "synthetic-token",
      fetcher,
      push,
    }).openDraft(input);
    expect(result).toEqual({ url: "https://github.com/owner/sample/pull/42", number: 42, commit: input.commit });
    const create = calls.find((call) => call.url.endsWith("/pulls"));
    const createdBody = JSON.parse(String(create?.init?.body)) as Record<string, unknown>;
    expect(createdBody).toMatchObject({ head: "ai/issue-17", base: "main", draft: true });
    expect(String(createdBody.body)).toContain("All checks passed");
    expect(String(createdBody.body)).toContain("Looks good.");
    expect(calls.some((call) => call.url.includes("/issues/42/comments"))).toBe(false);
    expect(
      calls.every((call) => new Headers(call.init?.headers).get("Authorization") === "Bearer synthetic-token"),
    ).toBe(true);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("reuses only an existing Draft for the exact commit and report", async () => {
  const current = await fixture();
  let pushes = 0;
  const push: Push = async () => {
    pushes += 1;
  };
  let body = "";
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/pulls?")) return response([pullRequest({ commit: currentCommit, body })]);
    throw new Error("unexpected request");
  };
  let currentCommit = "";
  try {
    const input = await deliveryInput(current);
    currentCommit = input.commit;
    body = expectedPullRequestBody(input);
    const result = await createGitHubHost({ repository: "owner/sample", token: "token", fetcher, push }).openDraft(
      input,
    );
    expect(result).toEqual({ url: "https://github.com/owner/sample/pull/42", number: 42, commit: input.commit });
    expect(pushes).toBe(1);
    expect(body).toContain(input.review);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("refuses an existing non-draft PR and missing secret scan before push", async () => {
  const current = await fixture();
  let pushes = 0;
  const push: Push = async () => {
    pushes += 1;
  };
  const fetcher: typeof fetch = async () => response([pullRequest({ draft: false })]);
  try {
    const input = await deliveryInput(current);
    await expect(
      createGitHubHost({ repository: "owner/sample", token: "token", fetcher, push }).openDraft(input),
    ).rejects.toThrow(/not a draft/);
    expect(pushes).toBe(0);
    await expect(
      createGitHubHost({ repository: "owner/sample", token: "token", fetcher, push }).openDraft({
        ...input,
        repository: { ...input.repository, verification: {} },
      }),
    ).rejects.toThrow(/secret scan/);
    expect(pushes).toBe(0);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("rejects a mismatched existing Draft and an oversized report before pushing", async () => {
  const current = await fixture();
  let pushes = 0;
  const push: Push = async () => {
    pushes += 1;
  };
  let existing: object = pullRequest({ commit: "b".repeat(40) });
  const fetcher: typeof fetch = async () => response([existing]);
  try {
    const input = await deliveryInput(current);
    const host = createGitHubHost({ repository: "owner/sample", token: "token", fetcher, push });
    await expect(host.openDraft(input)).rejects.toThrow(/does not match/);
    existing = pullRequest({ commit: input.commit, body: "another report" });
    await expect(host.openDraft(input)).rejects.toThrow(/does not match/);
    await expect(host.openDraft({ ...input, review: "x".repeat(70_000) })).rejects.toThrow(/body length/);
    expect(pushes).toBe(0);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("rejects an existing Draft with a noncanonical receipt before pushing", async () => {
  const current = await fixture();
  let pushes = 0;
  let posts = 0;
  const push: Push = async () => {
    pushes += 1;
  };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/pulls?")) {
      return response([pullRequest({ commit: currentCommit, body, url: "https://github.com/other/repo/pull/42" })]);
    }
    if (url.endsWith("/pulls")) posts += 1;
    throw new Error("unexpected request");
  };
  let currentCommit = "";
  let body = "";
  try {
    const input = await deliveryInput(current);
    currentCommit = input.commit;
    body = expectedPullRequestBody(input);
    const host = createGitHubHost({ repository: "owner/sample", token: "token", fetcher, push });
    await expect(host.openDraft(input)).rejects.toThrow(/invalid pull request URL/);
    expect(pushes).toBe(0);
    expect(posts).toBe(0);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("marks uncertain Draft creation with the immutable commit and hides response details", async () => {
  const current = await fixture();
  try {
    const input = await deliveryInput(current);
    const host = createGitHubHost({
      repository: "owner/sample",
      token: "synthetic-token",
      fetcher: async (url) => {
        const value = String(url);
        if (value.includes("/pulls?")) return response([]);
        if (value.endsWith("/pulls")) return response({ message: "synthetic-token response" }, 503);
        throw new Error("unexpected request");
      },
      push: async () => {},
    });
    let failure: unknown;
    try {
      await host.openDraft(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: "DraftCreationUnknownError", commit: input.commit });
    expect(String(failure)).not.toContain("synthetic-token");
    expect(Reflect.get(failure as object, "cause")).toBeUndefined();
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

it("marks a successful but mismatched PR creation acknowledgement as unknown", async () => {
  const current = await fixture();
  try {
    const input = await deliveryInput(current);
    const body = expectedPullRequestBody(input);
    const host = createGitHubHost({
      repository: "owner/sample",
      token: "synthetic-token",
      fetcher: async (url) => {
        const value = String(url);
        if (value.includes("/pulls?")) return response([]);
        if (value.endsWith("/pulls")) {
          return response(
            {
              ...pullRequest({ commit: input.commit, body }),
              html_url: "https://github.com/other/repository/pull/42",
            },
            201,
          );
        }
        throw new Error("unexpected request");
      },
      push: async () => {},
    });
    let failure: unknown;
    try {
      await host.openDraft(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: "DraftCreationUnknownError", commit: input.commit });
    expect(String(failure)).not.toContain("other/repository");
    expect(Reflect.get(failure as object, "cause")).toBeUndefined();
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
