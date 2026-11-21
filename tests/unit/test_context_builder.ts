// ============================================================
// test_context_builder.ts
// Purpose : Verify context layering excludes duplicate and private instructions
// Feature : Agent context
// Role    : Unit Test
// API Doc : docs/architecture.md, Context Layering
// ============================================================
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildContext, isIgnoredPath } from "@/engine/context_builder";
import type { Ticket } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "factory-context-"));
  roots.push(path);
  return path;
}

function makeRepository(workspace: string, mode: "repo_only" | "merge" | "factory_only"): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: workspace,
    use_worktree: true,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "gpt-test" },
      builder: { cli: "codex", provider: "openai", model: "gpt-test" },
      reviewer: { cli: "codex", provider: "openai", model: "gpt-test" },
    },
    privacy: { allow_cloud_llm: true, ignore_paths: [".env*"] },
    tracker: { provider: "local_md", allowed_approvers: ["owner"] },
    context: { mode, repo_files: ["AGENTS.md", "nested/AGENTS.md"], factory_extra: "config/factory.md" },
  };
}

const ticket: Ticket = {
  id: "1",
  project: "sample",
  title: "Ticket title",
  description: "Ticket description",
  acceptance_criteria: ["passes"],
  state: "ai_ready",
  author: "owner",
  url: "https://example.test/issues/1",
};

it("matches ignored directory roots as well as their descendants", () => {
  expect(isIgnoredPath("private", ["private/**"])).toBe(true);
  expect(isIgnoredPath("src", ["src/private/**"])).toBe(false);
  expect(isIgnoredPath("src/public.ts", ["src/private/**"])).toBe(false);
  expect(isIgnoredPath("src/private", ["src/private/**"])).toBe(true);
  expect(isIgnoredPath("src/private/secret", ["src/private/**"])).toBe(true);
  expect(isIgnoredPath("nested/secrets", ["**/secrets/**"])).toBe(true);
  expect(isIgnoredPath("public/file.txt", ["private/**"])).toBe(false);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("uses factory-only instructions without reading repository AGENTS files", async () => {
  const root = await makeRoot();
  const workspace = join(root, "repo");
  await mkdir(join(workspace, "nested"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "private root rules");
  await writeFile(join(workspace, "nested/AGENTS.md"), "private nested rules");
  await writeFile(join(root, "config/factory.md"), "Factory rules");

  const context = await buildContext({
    repository: makeRepository(workspace, "factory_only"),
    workspace,
    factoryRoot: root,
    ticket,
  });

  expect(context).toContain("Factory rules");
  expect(context).not.toContain("private root rules");
  expect(context).not.toContain("private nested rules");
  expect(context).toContain('"id": "1"');
  expect(context).toContain(".env*");
});

it("includes the root instructions once and points to safe nested instructions", async () => {
  const root = await makeRoot();
  const workspace = join(root, "repo");
  await mkdir(join(workspace, "nested"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "repository rules");
  await writeFile(join(workspace, "nested/AGENTS.md"), "nested rules");
  await writeFile(join(workspace, ".env.local"), "private test value");
  await writeFile(join(root, "config/factory.md"), "Factory rules");

  const context = await buildContext({
    repository: makeRepository(workspace, "merge"),
    workspace,
    factoryRoot: root,
    ticket,
    plan: "approved plan",
    diff: "safe patch",
  });

  expect(context.match(/repository rules/g)).toHaveLength(1);
  expect(context).toContain("nested/AGENTS.md");
  expect(context).toContain("Factory rules");
  expect(context).toContain("approved plan");
  expect(context).toContain("safe patch");
  expect(context).not.toContain("private test value");
});

it("falls back to a configured instruction when the root file is missing", async () => {
  const root = await makeRoot();
  const workspace = join(root, "repo");
  await mkdir(join(workspace, "nested"), { recursive: true });
  await writeFile(join(workspace, "nested/AGENTS.md"), "nested primary rules");
  const context = await buildContext({
    repository: makeRepository(workspace, "repo_only"),
    workspace,
    factoryRoot: root,
    ticket,
  });
  expect(context).toContain("nested primary rules");
});

it("rejects instruction symlinks that escape their configured root", async () => {
  const root = await makeRoot();
  const workspace = join(root, "repo");
  const factoryRoot = join(root, "factory");
  await mkdir(workspace);
  await mkdir(factoryRoot);
  await writeFile(join(root, "outside.md"), "outside rules");
  await writeFile(join(workspace, "AGENTS.md"), "repository rules");
  const { symlink } = await import("node:fs/promises");
  await symlink(join(root, "outside.md"), join(factoryRoot, "factory.md"));

  const repository = makeRepository(workspace, "merge");
  repository.context = { ...repository.context, factory_extra: "factory.md" };
  await expect(buildContext({ repository, workspace, factoryRoot, ticket })).rejects.toThrow(/escapes its root/i);
});
