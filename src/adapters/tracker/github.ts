// ============================================================
// github.ts
// Purpose : Load GitHub tickets and verify plan-bound approvals
// Feature : Ticket tracking
// Role    : Tracker Adapter
// API Doc : https://docs.github.com/en/rest/issues
// ============================================================
import { z } from "zod";
import { parseTicket, type Ticket } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";
import {
  allowedApprover,
  approvalCommand,
  validatePlanHash,
  type TrackerAdapter,
  type GitHubTrackerOptions,
} from "@/adapters/tracker/types";

const UserSchema = z.object({ login: z.string().min(1) });
const LabelSchema = z.object({ name: z.string() });
const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url(),
  user: UserSchema.nullable(),
  labels: z.array(LabelSchema),
  pull_request: z.unknown().optional(),
});
const CommentSchema = z.object({
  body: z.string().nullable(),
  user: UserSchema.nullable(),
  created_at: z.string(),
});

type GitHubIssue = z.infer<typeof IssueSchema>;
type GitHubComment = z.infer<typeof CommentSchema>;

function repositoryPath(repository: ResolvedRepository): string {
  const name = projectName(repository);
  const parts = name.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("GitHub tracker.repo must be owner/repository");
  }
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}

function projectName(repository: ResolvedRepository): string {
  const name = repository.tracker.repo;
  if (!name) throw new Error("GitHub tracker requires tracker.repo");
  return name;
}

function ticketId(number: string): string {
  if (!/^[1-9]\d*$/.test(number)) throw new Error("GitHub ticket id must be a positive issue number");
  return number;
}

function parseIssue(value: unknown): GitHubIssue {
  const result = IssueSchema.safeParse(value);
  if (!result.success || !result.data.user) throw new Error("GitHub issue response is invalid");
  return result.data;
}

function parseComment(value: unknown): GitHubComment {
  const result = CommentSchema.safeParse(value);
  if (!result.success) throw new Error("GitHub comment response is invalid");
  return result.data;
}

function stateLabels(repository: ResolvedRepository): Record<Ticket["state"], string> {
  const labels = repository.labels ?? {};
  return {
    ai_ready: labels.ready ?? "ai-ready",
    ai_planning: labels.planning ?? "ai-planning",
    needs_approval: labels.needs_approval ?? "needs-approval",
    ai_approved: labels.approved ?? "ai-approved",
    ai_building: labels.building ?? "ai-building",
    verifying: "ai-verifying",
    ai_reviewing: "ai-reviewing",
    ai_pr_ready: labels.pr_ready ?? "ai-pr-ready",
    ai_failed: labels.failed ?? "ai-failed",
  };
}

function issueState(repository: ResolvedRepository, issue: GitHubIssue): Ticket["state"] {
  const names = new Set(issue.labels.map((label) => label.name.toLowerCase()));
  const labels = stateLabels(repository);
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
  const state = states.find((candidate) => names.has(labels[candidate].toLowerCase()));
  if (!state) throw new Error(`GitHub issue #${issue.number} has no factory state label`);
  return state;
}

function toTicket(repository: ResolvedRepository, issue: GitHubIssue): Ticket {
  const description = issue.body ?? "";
  const acceptance = [...description.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)].map((match) => match[1] ?? "");
  return parseTicket({
    id: String(issue.number),
    project: projectName(repository),
    title: issue.title,
    description,
    acceptance_criteria: acceptance,
    state: issueState(repository, issue),
    author: issue.user?.login ?? "",
    url: issue.html_url,
  });
}

function safeArray<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("GitHub response did not match the expected shape");
  return value.map(parse);
}

function createRequest(options: GitHubTrackerOptions, repoPath: string) {
  const base = options.apiBaseUrl ?? "https://api.github.com";
  const fetcher = options.fetcher ?? fetch;
  return async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await fetcher(new URL(`${repoPath}${path}`, base), {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
    if (response.status === 204) return null;
    const payload: unknown = await response.json();
    return payload;
  };
}

function createPaginator<T>(request: ReturnType<typeof createRequest>, parse: (value: unknown) => T) {
  return async (path: string): Promise<T[]> => {
    const values: T[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const url = new URL(path, "https://pagination.invalid");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = safeArray(await request(`${url.pathname}${url.search}`), parse);
      values.push(...response);
      if (response.length < 100) return values;
    }
    throw new Error("GitHub result exceeded 100000 records");
  };
}

function approvalFromComments(
  repository: ResolvedRepository,
  comments: GitHubComment[],
  planHash: string,
): { author: string; planHash: string } | null {
  let latestPlanIndex = -1;
  let latestPlanHash = "";
  comments.forEach((comment, index) => {
    const match = comment.body?.match(/<!-- software-factory-plan:([a-f\d]{64}) -->/i);
    if (match?.[1]) {
      latestPlanIndex = index;
      latestPlanHash = match[1];
    }
  });
  if (latestPlanHash.toLowerCase() !== planHash.toLowerCase()) return null;
  for (const comment of comments.slice(latestPlanIndex + 1)) {
    const author = comment.user?.login;
    if (comment.body?.trim() === approvalCommand(repository) && author && allowedApprover(repository, author)) {
      return { author, planHash };
    }
  }
  return null;
}

export function createGitHubTracker(options: GitHubTrackerOptions): TrackerAdapter {
  if (!options.repository.enabled) throw new Error(`Repository ${options.repository.id} is disabled`);
  if (options.repository.tracker.provider !== "github") throw new Error("Repository tracker is not github");
  if (!options.token) throw new Error("GitHub tracker token is required");
  const repoPath = repositoryPath(options.repository);
  const request = createRequest(options, repoPath);
  const paginate = createPaginator(request, parseIssue);
  const labels = stateLabels(options.repository);

  return {
    async listReadyTickets() {
      const readyLabel = options.repository.labels?.ready ?? "ai-ready";
      const issues = await paginate(`/issues?state=open&labels=${encodeURIComponent(readyLabel)}`);
      return issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => toTicket(options.repository, issue));
    },
    async getTicket(id) {
      const issue = parseIssue(await request(`/issues/${ticketId(id)}`));
      return toTicket(options.repository, issue);
    },
    async publishPlan(input) {
      validatePlanHash(input.planHash);
      const body = `## Software Factory Plan\n\n<!-- software-factory-plan:${input.planHash} -->\n\n${input.plan}`;
      await request(`/issues/${ticketId(input.ticketId)}/comments`, "POST", { body });
    },
    async getApproval(input) {
      validatePlanHash(input.planHash);
      const comments = await createPaginator(request, parseComment)(`/issues/${ticketId(input.ticketId)}/comments`);
      return approvalFromComments(options.repository, comments, input.planHash);
    },
    async updateState(input) {
      const id = ticketId(input.ticketId);
      const current = parseIssue(await request(`/issues/${id}`));
      const target = labels[input.state];
      const statusLabels = new Set(Object.values(labels).map((label) => label.toLowerCase()));
      const existing = new Set(current.labels.map((label) => label.name.toLowerCase()));
      for (const label of existing) {
        if (statusLabels.has(label) && label !== target.toLowerCase()) {
          await request(`/issues/${id}/labels/${encodeURIComponent(label)}`, "DELETE");
        }
      }
      if (!existing.has(target.toLowerCase())) {
        await request(`/issues/${id}/labels`, "POST", { labels: [target] });
      }
    },
  };
}
