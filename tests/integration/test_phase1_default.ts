// ============================================================
// test_phase1_default.ts
// Purpose : Exercise the default runner and verifier in a ticket lifecycle
// Feature : Phase 1 MVP
// Role    : Integration Test
// API Doc : docs/implementation_plan.md, Phase 1 Acceptance Criteria
// ============================================================
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { planTicket, resumeTicket } from "@/engine/orchestrator";
import { createLocalMarkdownTracker } from "@/adapters/tracker/local_md";
import type { ResolvedRepository } from "@/engine/config_schemas";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const originalRoot = process.env.SOFTWARE_FACTORY_ROOT;
const originalPath = process.env.PATH;

type Fixture = {
  root: string;
  repositoryPath: string;
  workspace: string;
  configDirectory: string;
  ticketsDirectory: string;
  outputDirectory: string;
  repository: ResolvedRepository;
  tracker: ReturnType<typeof createLocalMarkdownTracker>;
};
type FactoryFilesInput = { root: string; config: string; repositoryPath: string; check: string };

async function git(args: string[], cwd?: string): Promise<void> {
  await execFile("git", args, { cwd });
}

async function makeFixture(check: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-default-phase1-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const workspace = join(root, "builder");
  const configDirectory = join(root, "config");
  const ticketsDirectory = join(root, "tickets");
  const outputDirectory = join(root, "runs");
  const fakeBin = join(root, "bin");
  await Promise.all([mkdir(repositoryPath), mkdir(configDirectory), mkdir(ticketsDirectory), mkdir(fakeBin)]);
  await writeFile(join(repositoryPath, "AGENTS.md"), "Synthetic repository rules\n");
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await initializeGit(repositoryPath, workspace);
  await writeFactoryFiles({ root, config: configDirectory, repositoryPath, check });
  await writeCli(fakeBin);
  process.env.SOFTWARE_FACTORY_ROOT = root;
  process.env.PATH = `${fakeBin}:${originalPath ?? "/usr/bin:/bin"}`;
  const repository = makeRepository(repositoryPath, check);
  const tracker = createLocalMarkdownTracker({ repository, ticketsDirectory });
  await writeFile(
    join(ticketsDirectory, "17.md"),
    "---\nid: '17'\nproject: sample\ntitle: Default lifecycle\nacceptance_criteria: [write generated file]\nstate: ai_ready\nauthor: reporter\n---\nCreate generated.txt\n",
  );
  return { root, repositoryPath, workspace, configDirectory, ticketsDirectory, outputDirectory, repository, tracker };
}

async function initializeGit(repository: string, workspace: string): Promise<void> {
  await git(["init", "-b", "main", repository]);
  await git(["-C", repository, "config", "user.email", "factory@example.test"]);
  await git(["-C", repository, "config", "user.name", "Factory Test"]);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", "base"]);
  await git(["-C", repository, "worktree", "add", "-b", "ai/17", workspace, "HEAD"]);
}

async function writeFactoryFiles(input: FactoryFilesInput): Promise<void> {
  const { root, config, repositoryPath: repository, check } = input;
  await mkdir(join(root, "src/agents"), { recursive: true });
  const roles: Array<{ name: string; output: string; access: "read_only" | "read_write" }> = [
    { name: "planner", output: "PLAN.md", access: "read_only" },
    { name: "builder", output: "BUILDER_SUMMARY.md", access: "read_write" },
    { name: "reviewer", output: "REVIEW_REPORT.md", access: "read_only" },
  ];
  for (const role of roles) {
    const directory = join(root, "src/agents", role.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "prompt.md"), `${role.name.toUpperCase()}_ROLE`);
    await writeFile(
      join(directory, "role.yaml"),
      stringify({ access: role.access, prompt_file: "prompt.md", output_file: role.output }),
    );
  }
  const route = { cli: "codex", provider: "openai", model: "test-model" };
  await writeFile(join(config, "factory.yaml"), stringify({ version: "1.0" }));
  await writeFile(
    join(config, "models.yaml"),
    stringify({
      version: "1.0",
      providers: { openai: { is_local: false, auth_mode: "cli" } },
      roles: { planner: route, builder: route, reviewer: route },
    }),
  );
  await writeFile(
    join(config, "repos.yaml"),
    stringify({
      version: "1.0",
      defaults: { context: { mode: "repo_only", repo_files: ["AGENTS.md"] }, privacy: { allow_cloud_llm: true } },
      repos: [
        {
          id: "sample",
          enabled: true,
          visibility: "private",
          local_path: repository,
          use_worktree: true,
          agents: { planner: route, builder: route, reviewer: route },
          tracker: { provider: "local_md", allowed_approvers: ["maintainer"] },
          verification: { secret_scan: check, lint: check, typecheck: check, test: check },
        },
      ],
    }),
  );
}

async function writeCli(directory: string): Promise<void> {
  const cli = join(directory, "codex");
  const script = [
    "#!/bin/sh",
    'case "$*" in',
    '  *PLANNER_ROLE*) text="Implement generated file" ;;',
    '  *BUILDER_ROLE*) printf "built\\n" > generated.txt; text="Builder complete" ;;',
    "  *REVIEWER_ROLE*) text='**Verdict:** `APPROVE_FOR_DRAFT_PR`' ;;",
    "  *) exit 2 ;;",
    "esac",
    'printf \'{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n\' "$text"',
    'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}\'',
  ].join("\n");
  await writeFile(cli, script);
  await chmod(cli, 0o700);
}

function makeRepository(path: string, check: string): ResolvedRepository {
  const route = { cli: "codex", provider: "openai", model: "test-model" };
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: path,
    use_worktree: true,
    base_branch: "main",
    agents: { planner: route, builder: route, reviewer: route },
    privacy: { allow_cloud_llm: true, ignore_paths: [".env*", "private/**", "secrets/**"] },
    context: { mode: "repo_only", repo_files: ["AGENTS.md"] },
    tracker: { provider: "local_md", allowed_approvers: ["maintainer"] },
    verification: { secret_scan: check, lint: check, typecheck: check, test: check },
  };
}

async function approve(fixture: Fixture, planHash: string): Promise<void> {
  const ticket = join(fixture.ticketsDirectory, "17.md");
  const current = await readFile(ticket, "utf8");
  const approval = `factory_approval:\n  author: maintainer\n  command: /approve\n  plan_hash: ${planHash}\n`;
  await writeFile(ticket, current.replace("state: needs_approval\n", `state: needs_approval\n${approval}`));
}

async function runPlan(fixture: Fixture) {
  return planTicket({
    ticketId: "17",
    repository: fixture.repository,
    tracker: fixture.tracker,
    workspace: fixture.repositoryPath,
    factoryRoot: fixture.root,
    outputDirectory: fixture.outputDirectory,
    configDirectory: fixture.configDirectory,
  });
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await filesBelow(path) : [entry.name]));
  }
  return files;
}

async function completeDefaultLifecycle(): Promise<void> {
  const fixture = await makeFixture("test -f generated.txt");
  const planned = await runPlan(fixture);
  expect(planned.status).toBe("needs_approval");
  const paused = await resume(fixture, planned.runFile);
  expect(paused.status).toBe("needs_approval");
  await approve(fixture, planned.planHash);
  const completed = await resume(fixture, planned.runFile);

  expect(completed.status).toBe("reviewed");
  await expect(readFile(join(fixture.workspace, "generated.txt"), "utf8")).resolves.toBe("built\n");
  const artifacts = await filesBelow(join(fixture.outputDirectory, "sample", "17"));
  expect(artifacts).toContain("PLAN.md");
  expect(artifacts).toContain("BUILDER_SUMMARY.md");
  expect(artifacts).toContain("REVIEW_REPORT.md");
  expect(await readFile(completed.runFile, "utf8")).toContain('"phase": "reviewed"');
}

async function rejectDefaultVerification(): Promise<void> {
  const fixture = await makeFixture("false");
  const planned = await runPlan(fixture);
  await approve(fixture, planned.planHash);
  const failed = await resume(fixture, planned.runFile);

  expect(failed.status).toBe("failed");
  expect(failed.summary).toContain("Verification failed at secret_scan");
  await expect(readFile(join(fixture.workspace, "generated.txt"), "utf8")).resolves.toBe("built\n");
  const artifacts = await filesBelow(join(fixture.outputDirectory, "sample", "17"));
  expect(artifacts).not.toContain("REVIEW_REPORT.md");
  expect(await readFile(failed.runFile, "utf8")).toContain('"phase": "failed"');
}

async function resume(fixture: Fixture, runFile: string) {
  return resumeTicket({
    repository: fixture.repository,
    tracker: fixture.tracker,
    runFile,
    factoryRoot: fixture.root,
    builderWorkspace: fixture.workspace,
    configDirectory: fixture.configDirectory,
  });
}

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.SOFTWARE_FACTORY_ROOT;
  else process.env.SOFTWARE_FACTORY_ROOT = originalRoot;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("Default Phase 1 lifecycle", () => {
  it("uses the real runner and sandboxed verifier through review", completeDefaultLifecycle);
  it("rejects a failed default verifier before launching Reviewer", rejectDefaultVerification);
});
