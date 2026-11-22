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
const runtimeProfile = {
  mounts: [
    { source: "/usr/bin/bash", target: "/runtime/codex", isDirectory: false },
    { source: "/usr/bin/bash", target: "/runtime/agy", isDirectory: false },
  ],
  commands: { codex: "/runtime/codex", agy: "/runtime/agy" },
  path: "/factory/config/runtime-profile.yaml",
};
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
      runtimeProfile,
    },
    workspace,
    hidden,
    runtimeProfile,
  });
  const rootMount = args.indexOf("--ro-bind");
  const workspaceMount = args.indexOf(workspace, args.indexOf(workspace, rootMount + 1) + 1);
  const writeMount = args.indexOf("--bind", workspaceMount - 1);

  expect(args.some((value, index) => value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/")).toBe(
    false,
  );
  expect(args).toContain("--cap-drop");
  expect(args).toContain("ALL");
  expect(args.some((value, index) => value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/")).toBe(
    false,
  );
  expect(args).toContain("/runtime/codex");
  expect(args).toContain("/dev/null");
  expect(args).toContain(`${workspace}/private`);
  expect(args).toContain("--remount-ro");
  const ignoredDirectory = args.findIndex(
    (value, index) => value === "--tmpfs" && args[index + 1] === `${workspace}/private`,
  );
  expect(args.slice(ignoredDirectory, ignoredDirectory + 4)).toEqual([
    "--tmpfs",
    `${workspace}/private`,
    "--remount-ro",
    `${workspace}/private`,
  ]);
  expect(args.slice(-3)).toEqual(["--", "/runtime/codex", "exec"]);
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
      runtimeProfile,
    },
    workspace,
    hidden,
    runtimeProfile,
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
