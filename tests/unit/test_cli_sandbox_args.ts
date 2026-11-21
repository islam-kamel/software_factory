// ============================================================
// test_cli_sandbox_args.ts
// Purpose : Verify Linux sandbox mount ordering and command isolation
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { expect, it } from "vitest";
import { createBwrapArgs } from "@/adapters/cli_runner/sandbox";

const workspace = "/tmp/factory-worktree";
const scratch = "/tmp/factory-run";
const hidden = [
  { path: `${workspace}/.env`, isDirectory: false },
  { path: `${workspace}/private`, isDirectory: true },
];

it("mounts Planner workspaces read-only and overlays privacy paths", () => {
  const args = createBwrapArgs({
    command: "codex",
    args: ["exec"],
    options: {
      workspace,
      ignorePaths: [".env", "private/**"],
      access: "read_only",
      timeoutMs: 1_000,
      scratchDirectory: scratch,
    },
    workspace,
    hidden,
  });
  const rootMount = args.indexOf("--ro-bind");
  const workspaceMount = args.indexOf(workspace, args.indexOf(workspace, rootMount + 1) + 1);
  const writeMount = args.indexOf("--bind", workspaceMount - 1);

  expect(args.slice(0, 12)).toContain("--ro-bind");
  expect(args).toContain("--cap-drop");
  expect(args).toContain("ALL");
  expect(args).toContain("/dev/null");
  expect(args).toContain(`${workspace}/private`);
  expect(args).toContain("--remount-ro");
  expect(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 4)).toEqual([
    "--tmpfs",
    `${workspace}/private`,
    "--remount-ro",
    `${workspace}/private`,
  ]);
  expect(args.slice(-3)).toEqual(["--", "codex", "exec"]);
  expect(writeMount).toBe(-1);
});

it("makes only the ai worktree writable for Builder", () => {
  const args = createBwrapArgs({
    command: "agy",
    args: ["--print"],
    options: {
      workspace,
      ignorePaths: [".env", "private/**"],
      access: "workspace_write",
      timeoutMs: 1_000,
      scratchDirectory: scratch,
    },
    workspace,
    hidden,
  });
  const readOnlyWorkspace = args.findIndex(
    (value, index) => value === "--ro-bind" && args[index + 1] === workspace && args[index + 2] === workspace,
  );
  const writableWorkspace = args.findIndex(
    (value, index) =>
      index > readOnlyWorkspace && value === "--bind" && args[index + 1] === workspace && args[index + 2] === workspace,
  );

  expect(args.slice(writableWorkspace, writableWorkspace + 3)).toEqual(["--bind", workspace, workspace]);
  expect(args.indexOf("--tmpfs", writableWorkspace)).toBeGreaterThan(writableWorkspace);
});
