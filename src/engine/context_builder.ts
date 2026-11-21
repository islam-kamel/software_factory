// ============================================================
// context_builder.ts
// Purpose : Assemble scoped repository and factory instructions for agents
// Feature : Agent context
// Role    : Application Service
// API Doc : docs/architecture.md, Context Layering
// ============================================================
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { ResolvedRepository } from "@/engine/config_schemas";
import type { Ticket } from "@/engine/contracts";

export type BuildContextOptions = {
  repository: ResolvedRepository;
  workspace: string;
  factoryRoot: string;
  ticket: Ticket;
  plan?: string;
  diff?: string;
};

type InstructionFile = { path: string; content: string };

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveContained(root: string, path: string): Promise<string | null> {
  const candidate = resolve(root, path);
  try {
    const actual = await realpath(candidate);
    if (!isInside(root, actual)) throw new Error(`Context path escapes its root: ${path}`);
    if (!(await stat(actual)).isFile()) return null;
    return actual;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function isIgnoredPath(path: string, patterns: string[]): boolean {
  const normalized = path.split(sep).join("/");
  return patterns.some(
    (pattern) =>
      matchesGlob(normalized, pattern) ||
      (pattern.endsWith("/**") && matchesGlob(normalized, pattern.slice(0, -3))) ||
      (!pattern.includes("/") && normalized.split("/").some((part) => matchesGlob(part, pattern))),
  );
}

function isIgnored(root: string, file: string, patterns: string[]): boolean {
  return isIgnoredPath(relative(root, file), patterns);
}

async function readInstruction(root: string, path: string, patterns: string[]): Promise<InstructionFile | null> {
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) throw new Error(`Context path escapes its root: ${path}`);
  if (isIgnored(root, candidate, patterns)) return null;
  const actual = await resolveContained(root, path);
  if (!actual || isIgnored(root, actual, patterns)) return null;
  return { path: actual, content: await readFile(actual, "utf8") };
}

async function repositoryInstructions(
  options: BuildContextOptions,
  patterns: string[],
): Promise<{ primary: InstructionFile | null; pointers: string[] }> {
  const files = options.repository.context?.repo_files ?? ["AGENTS.md"];
  let primary: InstructionFile | null = null;
  const pointers: string[] = [];
  for (const path of files) {
    const instruction = await readInstruction(options.workspace, path, patterns);
    if (!instruction) continue;
    if (!primary) primary = instruction;
    else pointers.push(relative(options.workspace, instruction.path).split(sep).join("/"));
  }
  return { primary, pointers };
}

async function factoryInstructions(
  options: BuildContextOptions,
  root: string,
  patterns: string[],
): Promise<string | null> {
  const path = options.repository.context?.factory_extra;
  if (!path) return null;
  const instruction = await readInstruction(root, path, patterns);
  if (!instruction && options.repository.context?.mode === "factory_only") {
    throw new Error("factory_only context requires a readable factory_extra file");
  }
  return instruction?.content ?? null;
}

function addSection(parts: string[], title: string, content: string | undefined): void {
  if (content === undefined || content.length === 0) return;
  parts.push(`## ${title}\n\n${content}`);
}

function privacyReminder(patterns: string[]): string {
  const items = patterns.length > 0 ? patterns.map((pattern) => `- \`${pattern}\``).join("\n") : "- (none configured)";
  return `Do not read, print, log, or modify paths matching these patterns:\n${items}`;
}

export async function buildContext(options: BuildContextOptions): Promise<string> {
  const workspace = await realpath(options.workspace);
  const factoryRoot = await realpath(options.factoryRoot);
  const patterns = options.repository.privacy.ignore_paths ?? [];
  const mode = options.repository.context?.mode ?? "merge";
  const parts: string[] = [];

  if (mode !== "repo_only") {
    addSection(parts, "Factory Instructions", (await factoryInstructions(options, factoryRoot, patterns)) ?? undefined);
  }
  if (mode !== "factory_only") {
    const repo = await repositoryInstructions({ ...options, workspace }, patterns);
    if (repo.primary) {
      const precedence =
        mode === "merge" ? "Factory instructions take precedence for security and workflow." : undefined;
      addSection(parts, "Repository Instructions", [precedence, repo.primary.content].filter(Boolean).join("\n\n"));
    }
    if (repo.pointers.length > 0) {
      addSection(parts, "Additional Repository Instructions", repo.pointers.map((path) => `- \`${path}\``).join("\n"));
    }
  }

  addSection(parts, "Ticket", JSON.stringify(options.ticket, null, 2));
  addSection(parts, "Approved Plan", options.plan);
  addSection(parts, "Review Diff", options.diff);
  addSection(parts, "Privacy", privacyReminder(patterns));
  return parts.join("\n\n");
}
