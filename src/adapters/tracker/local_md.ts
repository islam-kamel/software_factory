// ============================================================
// local_md.ts
// Purpose : Read and update tickets stored as Markdown files
// Feature : Ticket tracking
// Role    : Tracker Adapter
// API Doc : docs/implementation_plan.md, Local Markdown Tracker
// ============================================================
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { parseTicket, type Ticket } from "@/engine/contracts";
import type { ResolvedRepository } from "@/engine/config_schemas";
import { allowedApprover, approvalCommand, validatePlanHash, type TrackerAdapter } from "@/adapters/tracker/types";
import type { LocalMarkdownTrackerOptions } from "@/adapters/tracker/types";

const ApprovalSchema = z.object({
  author: z.string(),
  command: z.string(),
  plan_hash: z.string(),
});

const FrontmatterSchema = z
  .object({
    id: z.string().min(1),
    project: z.string().min(1),
    title: z.string(),
    description: z.string().optional(),
    acceptance_criteria: z.array(z.string()),
    state: z.enum([
      "ai_ready",
      "ai_planning",
      "needs_approval",
      "ai_approved",
      "ai_building",
      "verifying",
      "ai_reviewing",
      "ai_pr_ready",
      "ai_failed",
    ]),
    author: z.string(),
    url: z.url().optional(),
    factory_plan: z.string().optional(),
    factory_plan_hash: z.string().optional(),
    factory_approval: ApprovalSchema.optional(),
  })
  .passthrough();

type ParsedMarkdown = {
  document: ReturnType<typeof parseDocument>;
  fields: z.infer<typeof FrontmatterSchema>;
  body: string;
};

function parseMarkdown(markdown: string): ParsedMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("Ticket Markdown must start with YAML frontmatter");
  const document = parseDocument(match[1] ?? "", { strict: true, stringKeys: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("Ticket frontmatter is invalid");
  const result = FrontmatterSchema.safeParse(document.toJS());
  if (!result.success) throw new Error("Ticket frontmatter is missing required fields");
  return { document, fields: result.data, body: markdown.slice(match[0].length) };
}

function toTicket(fields: ParsedMarkdown["fields"], body: string, file: string): Ticket {
  return parseTicket({
    id: fields.id,
    project: fields.project,
    title: fields.title,
    description: fields.description ?? body.trim(),
    acceptance_criteria: fields.acceptance_criteria,
    state: fields.state,
    author: fields.author,
    url: fields.url ?? pathToFileURL(file).href,
  });
}

function ensureRepository(repository: ResolvedRepository): void {
  if (!repository.enabled) throw new Error(`Repository ${repository.id} is disabled`);
  if (repository.tracker.provider !== "local_md") throw new Error("Repository tracker is not local_md");
}

async function ticketFiles(directory: string): Promise<string[]> {
  const root = await realpath(directory);
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function readTicketFile(file: string): Promise<{ ticket: Ticket; parsed: ParsedMarkdown }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Ticket path must be a regular file");
  const parsed = parseMarkdown(await readFile(file, "utf8"));
  return { ticket: toTicket(parsed.fields, parsed.body, file), parsed };
}

async function findTicket(directory: string, id: string): Promise<{ file: string; parsed: ParsedMarkdown }> {
  for (const file of await ticketFiles(directory)) {
    const result = await readTicketFile(file);
    if (result.ticket.id === id) return { file, parsed: result.parsed };
  }
  throw new Error(`Ticket ${id} was not found`);
}

async function writeTicket(file: string, parsed: ParsedMarkdown): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Ticket path must be a regular file");
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  const content = `---\n${parsed.document.toString()}---\n${parsed.body}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createLocalMarkdownTracker(options: LocalMarkdownTrackerOptions): TrackerAdapter {
  ensureRepository(options.repository);
  const directory = resolve(options.ticketsDirectory ?? join(options.repository.local_path, "tickets"));

  return {
    async listReadyTickets() {
      const tickets: Ticket[] = [];
      for (const file of await ticketFiles(directory)) {
        const { ticket } = await readTicketFile(file);
        if (ticket.state === "ai_ready") tickets.push(ticket);
      }
      return tickets;
    },
    async getTicket(id) {
      const { file, parsed } = await findTicket(directory, id);
      return toTicket(parsed.fields, parsed.body, file);
    },
    async publishPlan(input) {
      validatePlanHash(input.planHash);
      const { file, parsed } = await findTicket(directory, input.ticketId);
      parsed.document.set("factory_plan", input.plan);
      parsed.document.set("factory_plan_hash", input.planHash);
      await writeTicket(file, parsed);
    },
    async getApproval(input) {
      validatePlanHash(input.planHash);
      const { parsed } = await findTicket(directory, input.ticketId);
      const approval = parsed.fields.factory_approval;
      if (!approval || parsed.fields.factory_plan_hash !== input.planHash) return null;
      if (approval.command.trim() !== approvalCommand(options.repository)) return null;
      if (approval.plan_hash !== input.planHash || !allowedApprover(options.repository, approval.author)) return null;
      return { author: approval.author, planHash: input.planHash };
    },
    async updateState(input) {
      const { file, parsed } = await findTicket(directory, input.ticketId);
      parsed.document.set("state", input.state);
      await writeTicket(file, parsed);
    },
  };
}
