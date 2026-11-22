// ============================================================
// github.ts
// Purpose : Push verified ai branches and deliver GitHub Draft PR reports
// Feature : Draft delivery
// Role    : Git Host Adapter
// API Doc : GitHub REST API, Pull Requests
// ============================================================
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FactoryConfig, ResolvedRepository } from "@/engine/config_schemas";
import { parseTicket, parseVerificationResult, type Ticket, type VerificationResult } from "@/engine/contracts";
import { assertDeliverySnapshot, pushBranch } from "@/adapters/git_host/delivery_git";

const GITHUB_API = "https://api.github.com";
const API_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_BODY_LENGTH = 65_536;
const MAX_PLAN_LENGTH = 5000;
const MAX_VERIFICATION_SUMMARY_LENGTH = 1800;

const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.url(),
    body: z.string().nullable().optional(),
    draft: z.boolean(),
    head: z
      .object({
        ref: z.string(),
        sha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
        repo: z.object({ full_name: z.string() }).passthrough().nullable(),
      })
      .passthrough(),
    base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).passthrough() }).passthrough(),
  })
  .passthrough();
const PullRequestListSchema = z.array(PullRequestSchema);

export type DraftRequest = {
  repository: ResolvedRepository;
  workspace: string;
  branch: string;
  baseBranch: string;
  commit: string;
  ticket: Ticket;
  plan: string;
  verification: VerificationResult;
  review: string;
};

export type DraftReceipt = { url: string; number: number; commit: string };

export class DraftCreationUnknownError extends Error {
  readonly commit: string;

  constructor(commit: string) {
    super("Draft PR creation outcome is unknown");
    this.name = "DraftCreationUnknownError";
    this.commit = commit;
  }
}

export type GitHostAdapter = {
  openDraft(input: DraftRequest): Promise<DraftReceipt>;
};

type GitHubPullRequest = z.infer<typeof PullRequestSchema>;

function repositoryParts(repository: string): { owner: string; name: string } {
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) {
    throw new Error("GitHub repository must use owner/name format");
  }
  const owner = parts[0];
  const name = parts[1];
  if (!owner || !name) throw new Error("GitHub repository must use owner/name format");
  return { owner, name };
}

function parseGitHubUrl(value: string, repository: string, number: number): string {
  try {
    const url = new URL(value);
    const expected = `https://github.com/${repository}/pull/${number}`;
    if (url.toString() !== expected) {
      throw new Error("invalid");
    }
    return expected;
  } catch {
    throw new Error("GitHub returned an invalid pull request URL");
  }
}

function receiptFor(pull: GitHubPullRequest, repository: string, commit: string): DraftReceipt {
  return { url: parseGitHubUrl(pull.html_url, repository, pull.number), number: pull.number, commit };
}

function deliveryMarker(input: DraftRequest): string {
  const hash = createHash("sha256").update(`${input.ticket.id}\0${input.commit}\0${input.review}`).digest("hex");
  return `<!-- software-factory-delivery:${hash} -->`;
}

function pullRequestBody(input: DraftRequest): string {
  const plan = input.plan.slice(0, MAX_PLAN_LENGTH);
  const summary = input.verification.summary.slice(0, MAX_VERIFICATION_SUMMARY_LENGTH);
  return [
    `Ticket: [#${input.ticket.id}](${input.ticket.url}) ${input.ticket.title}`,
    "## Plan summary",
    plan,
    "## Verification",
    `Passed: ${input.verification.passed}`,
    `Attempt: ${input.verification.attempt}`,
    `Failed step: ${input.verification.failed_step ?? "none"}`,
    summary,
    "## Reviewer report",
    input.review,
    deliveryMarker(input),
  ].join("\n\n");
}

type RequestInput = { fetcher: typeof fetch; token: string; url: string; init?: RequestInit };

async function request(input: RequestInput): Promise<Response> {
  try {
    const response = await input.fetcher(input.url, {
      ...input.init,
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(input.init?.body ? { "Content-Type": "application/json" } : {}),
        ...input.init?.headers,
      },
    });
    if (!response.ok) throw new Error("GitHub API request failed");
    return response;
  } catch {
    throw new Error("GitHub API request failed");
  }
}

async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  try {
    const payload: unknown = await response.json();
    return schema.parse(payload);
  } catch {
    throw new Error("GitHub returned an invalid API response");
  }
}

async function listOpenPullRequests(input: {
  fetcher: typeof fetch;
  token: string;
  repository: string;
  owner: string;
  branch: string;
  baseBranch: string;
}): Promise<GitHubPullRequest[]> {
  const matches: GitHubPullRequest[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      state: "open",
      head: `${input.owner}:${input.branch}`,
      base: input.baseBranch,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const response = await request({
      fetcher: input.fetcher,
      token: input.token,
      url: `${GITHUB_API}/repos/${input.repository}/pulls?${query.toString()}`,
    });
    const pulls = await responseJson(response, PullRequestListSchema);
    matches.push(...pulls.filter((pull) => pull.head.ref === input.branch && pull.base.ref === input.baseBranch));
    if (pulls.length < PAGE_SIZE) return matches;
  }
  throw new Error("GitHub pull request pagination limit exceeded");
}

function validateDelivery(input: DraftRequest, repository: string): DraftRequest {
  const ticket = parseTicket(input.ticket);
  const verification = parseVerificationResult(input.verification);
  const expectedBranch = `ai/issue-${ticket.id}`;
  if (!hasSecretScan(input)) throw new Error("Draft delivery requires a configured secret scan");
  if (!isValidDelivery({ ...input, verification }, repository, expectedBranch))
    throw new Error("Draft delivery request is invalid");
  return { ...input, ticket, verification };
}

function isValidDelivery(input: DraftRequest, repository: string, expectedBranch: string): boolean {
  return (
    input.repository.tracker.repo === repository &&
    input.branch === expectedBranch &&
    input.baseBranch === (input.repository.base_branch ?? "main") &&
    input.verification.passed &&
    input.verification.failed_step === null &&
    hasSecretScan(input) &&
    hasCompleteReport(input)
  );
}

function hasSecretScan(input: DraftRequest): boolean {
  return Boolean(input.repository.verification?.secret_scan?.trim());
}

function hasCompleteReport(input: DraftRequest): boolean {
  return Boolean(input.plan.trim() && input.review.trim());
}

function existingDraft(input: {
  pulls: GitHubPullRequest[];
  repository: string;
  branch: string;
  baseBranch: string;
  commit: string;
  expectedBody: string;
}): GitHubPullRequest | null {
  const exact = input.pulls.filter(
    (pull) =>
      pull.head.ref === input.branch &&
      pull.base.ref === input.baseBranch &&
      pull.head.repo?.full_name.toLowerCase() === input.repository.toLowerCase(),
  );
  if (input.pulls.length !== exact.length || exact.length > 1)
    throw new Error("An ambiguous open pull request already uses this branch");
  const pull = exact[0];
  if (pull && !pull.draft) throw new Error("An existing pull request for this branch is not a draft");
  if (pull && (pull.head.sha.toLowerCase() !== input.commit.toLowerCase() || pull.body !== input.expectedBody)) {
    throw new Error("An existing Draft PR does not match the verified delivery snapshot");
  }
  return pull ?? null;
}

async function createPullRequest(input: {
  fetcher: typeof fetch;
  token: string;
  repository: string;
  request: DraftRequest;
}): Promise<GitHubPullRequest> {
  try {
    const response = await request({
      fetcher: input.fetcher,
      token: input.token,
      url: `${GITHUB_API}/repos/${input.repository}/pulls`,
      init: {
        method: "POST",
        body: JSON.stringify({
          title: `#${input.request.ticket.id} ${input.request.ticket.title}`.slice(0, 256),
          head: input.request.branch,
          base: input.request.baseBranch,
          body: pullRequestBody(input.request),
          draft: true,
        }),
      },
    });
    const pull = await responseJson(response, PullRequestSchema);
    if (!isMatchingCreatedDraft(pull, input.request)) throw new Error("invalid Draft response");
    receiptFor(pull, input.request.repository.tracker.repo ?? "", input.request.commit);
    return pull;
  } catch {
    throw new DraftCreationUnknownError(input.request.commit);
  }
}

function isMatchingCreatedDraft(pull: GitHubPullRequest, input: DraftRequest): boolean {
  const repository = input.repository.tracker.repo?.toLowerCase();
  return Boolean(
    pull.draft &&
    pull.head.ref === input.branch &&
    pull.head.sha.toLowerCase() === input.commit.toLowerCase() &&
    pull.head.repo?.full_name.toLowerCase() === repository &&
    pull.base.ref === input.baseBranch &&
    pull.base.repo.full_name.toLowerCase() === repository &&
    pull.body === pullRequestBody(input),
  );
}

export function createGitHubHost(options: {
  repository: string;
  token: string;
  fetcher?: typeof fetch;
  push?: typeof pushBranch;
}): GitHostAdapter {
  const parts = repositoryParts(options.repository);
  if (!options.token.trim()) throw new Error("GitHub token is required");
  const fetcher = options.fetcher ?? fetch;
  const push = options.push ?? pushBranch;

  return {
    async openDraft(rawInput) {
      const input = validateDelivery(rawInput, `${parts.owner}/${parts.name}`);
      if (pullRequestBody(input).length > MAX_BODY_LENGTH) {
        throw new Error("Draft PR report exceeds GitHub's supported body length");
      }
      await assertDeliverySnapshot({ workspace: input.workspace, branch: input.branch, commit: input.commit });
      const pulls = await listOpenPullRequests({
        fetcher,
        token: options.token,
        repository: `${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
        owner: parts.owner,
        branch: input.branch,
        baseBranch: input.baseBranch,
      });
      const pull = existingDraft({
        pulls,
        repository: `${parts.owner}/${parts.name}`,
        branch: input.branch,
        baseBranch: input.baseBranch,
        commit: input.commit,
        expectedBody: pullRequestBody(input),
      });
      if (pull) return receiptFor(pull, `${parts.owner}/${parts.name}`, input.commit);
      await push({ workspace: input.workspace, branch: input.branch, commit: input.commit });
      const deliveredPull = await createPullRequest({
        fetcher,
        token: options.token,
        repository: `${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
        request: input,
      });
      return receiptFor(deliveredPull, `${parts.owner}/${parts.name}`, input.commit);
    },
  };
}

export function createGitHost(options: {
  factory: FactoryConfig;
  repository: ResolvedRepository;
  secrets?: ReadonlyMap<string, string>;
  fetcher?: typeof fetch;
  push?: typeof pushBranch;
}): GitHostAdapter {
  const adapter = options.factory.adapters?.git_host ?? "github";
  if (adapter !== "github") throw new Error(`Unsupported Git host adapter: ${adapter}`);
  const token = configuredToken(options);
  const repository = options.repository.tracker.repo;
  if (!repository) throw new Error("Repository tracker.repo is required for GitHub delivery");
  const hostOptions = {
    repository,
    token,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.push ? { push: options.push } : {}),
  };
  return createGitHubHost(hostOptions);
}

function configuredToken(options: { repository: ResolvedRepository; secrets?: ReadonlyMap<string, string> }): string {
  const tokenName = options.repository.tracker.token_env;
  const token = tokenName ? (options.secrets?.get(tokenName) ?? process.env[tokenName]) : undefined;
  if (!token || !token.trim()) throw new Error("Configured GitHub token is unavailable");
  return token;
}
