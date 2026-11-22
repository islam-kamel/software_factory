// ============================================================
// state_manager.ts
// Purpose : Coordinate local ticket claims and validate state transitions
// Feature : Phase 2 ticket state and locking
// Role    : Application Service
// API Doc : docs/system_design.md, Ticket Lifecycle
// ============================================================
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TrackerAdapter } from "@/adapters/tracker/types";
import type { Ticket } from "@/engine/contracts";

export type TicketClaim = { root: string; repository: string; ticketId: string; token: string };
export type ActiveTicketClaim = TicketClaim & { executionToken: string };

type ClaimPaths = { root: string; repository: string; ticketId: string; keyDirectory: string; key: string };
type ClaimMetadata = { version: 1; root: string; repository: string; ticketId: string; token: string };
type ActiveMetadata = { version: 1; token: string; executionToken: string };

const CLAIM_FILE = "claim.json";
const ACTIVE_DIRECTORY = "active";
const ACTIVE_FILE = "active.json";
const TOKEN_PATTERN = /^[a-f\d]{64}$/;
// Runtime failures in the approval, build, and review paths are persisted as ai_failed.
const TRANSITIONS: Record<Ticket["state"], readonly Ticket["state"][]> = {
  ai_ready: ["ai_planning"],
  ai_planning: ["needs_approval", "ai_failed"],
  needs_approval: ["ai_approved", "ai_planning", "ai_failed"],
  ai_approved: ["ai_building", "ai_failed"],
  ai_building: ["verifying", "ai_failed"],
  verifying: ["ai_building", "ai_reviewing", "ai_failed"],
  ai_reviewing: ["ai_pr_ready", "ai_failed"],
  ai_pr_ready: [],
  ai_failed: ["ai_ready"],
};

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function hasValidText(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function validateInputs(input: { root: string; repository: string; ticketId: string }): void {
  if (
    !hasValidText(input.root) ||
    !isAbsolute(input.root) ||
    !hasValidText(input.repository) ||
    !hasValidText(input.ticketId, 256)
  ) {
    throw new Error("Ticket claim input is invalid");
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Ticket claim directory is unsafe");
  await chmod(path, 0o700);
}

async function createDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await assertDirectory(path);
}

async function canonicalRoot(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("Ticket claim root is invalid", { cause: error });
      missing.push(basename(current));
      current = parent;
      continue;
    }
    if (missing.length === 0 && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Ticket claim root is unsafe");
    if (missing.length > 0 && !(await stat(current)).isDirectory()) throw new Error("Ticket claim root is unsafe");
    return join(await realpath(current), ...missing.reverse());
  }
}

async function getClaimPaths(input: { root: string; repository: string; ticketId: string }): Promise<ClaimPaths> {
  validateInputs(input);
  const [root, repository] = await Promise.all([canonicalRoot(input.root), realpath(input.repository)]);
  if (isInside(repository, root) || isInside(root, repository))
    throw new Error("Ticket claim root must be outside the repository");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root);
  const key = createHash("sha256").update(repository).update("\0").update(input.ticketId).digest("hex");
  return { root, repository, ticketId: input.ticketId, key, keyDirectory: join(root, key) };
}

async function writeJson(path: string, value: object): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function readJson(path: string): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error();
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Ticket claim metadata is invalid");
  }
}

function isClaimMetadata(value: unknown, paths: ClaimPaths, token: string): value is ClaimMetadata {
  if (value === null || typeof value !== "object") return false;
  const metadata = value as Partial<ClaimMetadata>;
  return (
    metadata.version === 1 &&
    metadata.root === paths.root &&
    metadata.repository === paths.repository &&
    metadata.ticketId === paths.ticketId &&
    metadata.token === token &&
    TOKEN_PATTERN.test(metadata.token)
  );
}

async function verifyClaim(paths: ClaimPaths, claim: TicketClaim): Promise<void> {
  await assertDirectory(paths.keyDirectory);
  if (
    !TOKEN_PATTERN.test(claim.token) ||
    !isClaimMetadata(await readJson(join(paths.keyDirectory, CLAIM_FILE)), paths, claim.token)
  ) {
    throw new Error("Ticket claim is invalid");
  }
}

async function activate(paths: ClaimPaths, claim: TicketClaim): Promise<ActiveTicketClaim> {
  const activeDirectory = join(paths.keyDirectory, ACTIVE_DIRECTORY);
  try {
    await createDirectory(activeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Ticket claim already has an active execution", { cause: error });
    }
    throw error;
  }
  const executionToken = randomBytes(32).toString("hex");
  await writeJson(join(activeDirectory, ACTIVE_FILE), { version: 1, token: claim.token, executionToken });
  return { ...claim, executionToken };
}

async function verifyActive(active: ActiveTicketClaim, paths: ClaimPaths): Promise<void> {
  await verifyClaim(paths, active);
  if (!TOKEN_PATTERN.test(active.executionToken)) throw new Error("Ticket claim is invalid");
  const activeDirectory = join(paths.keyDirectory, ACTIVE_DIRECTORY);
  await assertDirectory(activeDirectory);
  const value = await readJson(join(activeDirectory, ACTIVE_FILE));
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<ActiveMetadata>).version !== 1 ||
    (value as Partial<ActiveMetadata>).token !== active.token ||
    (value as Partial<ActiveMetadata>).executionToken !== active.executionToken
  ) {
    throw new Error("Ticket claim is invalid");
  }
}

export async function createTicketClaim(input: {
  root: string;
  repository: string;
  ticketId: string;
}): Promise<ActiveTicketClaim> {
  // shortcut: claims coordinate processes sharing this filesystem; use distributed CAS for multi-host locking.
  const paths = await getClaimPaths(input);
  try {
    await createDirectory(paths.keyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Ticket already has a claim", { cause: error });
    }
    throw error;
  }
  const claim: TicketClaim = {
    root: paths.root,
    repository: paths.repository,
    ticketId: paths.ticketId,
    token: randomBytes(32).toString("hex"),
  };
  await writeJson(join(paths.keyDirectory, CLAIM_FILE), {
    version: 1,
    root: claim.root,
    repository: claim.repository,
    ticketId: claim.ticketId,
    token: claim.token,
  });
  return activate(paths, claim);
}

export async function enterTicketClaim(claim: TicketClaim): Promise<ActiveTicketClaim> {
  const paths = await getClaimPaths(claim);
  await verifyClaim(paths, claim);
  return activate(paths, claim);
}

export async function leaveTicketClaim(active: ActiveTicketClaim): Promise<void> {
  const paths = await getClaimPaths(active);
  await verifyActive(active, paths);
  const activeDirectory = join(paths.keyDirectory, ACTIVE_DIRECTORY);
  await unlink(join(activeDirectory, ACTIVE_FILE));
  await rmdir(activeDirectory);
}

export async function finishTicketClaim(active: ActiveTicketClaim): Promise<void> {
  const paths = await getClaimPaths(active);
  await verifyActive(active, paths);
  const finishedDirectory = join(paths.root, `.${paths.key}.finished-${randomBytes(8).toString("hex")}`);
  await rename(paths.keyDirectory, finishedDirectory);
  const activeDirectory = join(finishedDirectory, ACTIVE_DIRECTORY);
  await unlink(join(activeDirectory, ACTIVE_FILE));
  await rmdir(activeDirectory);
  await unlink(join(finishedDirectory, CLAIM_FILE));
  await rmdir(finishedDirectory);
}

export function validateTransition(from: Ticket["state"], to: Ticket["state"]): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new Error(`Ticket transition from ${from} to ${to} is not allowed`);
}

// Caller must hold the ticket's active local claim before changing tracked state.
export async function transitionTicket(input: {
  tracker: TrackerAdapter;
  ticketId: string;
  state: Ticket["state"];
}): Promise<void> {
  const ticket = await input.tracker.getTicket(input.ticketId);
  validateTransition(ticket.state, input.state);
  await input.tracker.updateState({ ticketId: input.ticketId, state: input.state });
}
