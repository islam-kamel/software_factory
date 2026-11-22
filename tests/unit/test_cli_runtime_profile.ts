// ============================================================
// test_cli_runtime_profile.ts
// Purpose : Validate explicit sandbox runtime files and executable mappings
// Feature : Agent execution security
// Role    : Unit Test
// API Doc : N/A
// ============================================================
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, it } from "vitest";
import {
  assertRuntimeMountsOutside,
  loadSandboxRuntimeProfile,
  resolveRuntimeCommand,
} from "@/adapters/cli_runner/runtime_profile";

const roots: string[] = [];

async function profileFile(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-runtime-profile-"));
  roots.push(root);
  const path = join(root, "runtime.yaml");
  await writeFile(path, stringify(value));
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("loads an explicit mounted executable and resolves only named commands", async () => {
  const profile = await loadSandboxRuntimeProfile(
    await profileFile({
      version: 1,
      mounts: [{ source: process.execPath, target: "/runtime/node" }],
      commands: { node: "/runtime/node" },
    }),
  );

  expect(resolveRuntimeCommand(profile, "node")).toBe("/runtime/node");
  expect(() => resolveRuntimeCommand(profile, "bash")).toThrow("does not allow command");
});

it("rejects broad system directories and canonicalizes exact file symlinks", async () => {
  const broad = await profileFile({
    version: 1,
    mounts: [{ source: "/usr", target: "/usr" }],
    commands: { tool: "/usr/bin/tool" },
  });
  await expect(loadSandboxRuntimeProfile(broad)).rejects.toThrow("selected code package roots");

  const root = await mkdtemp(join(tmpdir(), "factory-runtime-symlink-"));
  roots.push(root);
  const link = join(root, "node-link");
  await symlink(process.execPath, link);
  const linked = await loadSandboxRuntimeProfile(
    await profileFile({
      version: 1,
      mounts: [{ source: link, target: "/runtime/node" }],
      commands: { node: "/runtime/node" },
    }),
  );
  expect(linked.mounts[0]?.source).toBe(await realpath(process.execPath));
});

it("rejects commands without a matching mounted file and duplicate targets", async () => {
  const missing = await profileFile({
    version: 1,
    mounts: [{ source: process.execPath, target: "/runtime/node" }],
    commands: { node: "/runtime/other" },
  });
  await expect(loadSandboxRuntimeProfile(missing)).rejects.toThrow("explicitly mounted file");

  const duplicate = await profileFile({
    version: 1,
    mounts: [
      { source: process.execPath, target: "/runtime/node" },
      { source: process.execPath, target: "/runtime/node" },
    ],
    commands: { node: "/runtime/node" },
  });
  await expect(loadSandboxRuntimeProfile(duplicate)).rejects.toThrow("repeats a mount target");
});

it("rejects runtime mounts that expose Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runtime-git-"));
  roots.push(root);
  const object = join(root, ".git/objects/blob");
  await mkdir(join(root, ".git/objects"), { recursive: true });
  await writeFile(object, "synthetic object");
  const profile = await profileFile({
    version: 1,
    mounts: [{ source: object, target: "/runtime/blob" }],
    commands: { tool: "/runtime/blob" },
  });

  await expect(loadSandboxRuntimeProfile(profile)).rejects.toThrow("cannot expose Git metadata");
});

it("rejects profile files inside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runtime-boundary-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const scratchDirectory = join(root, "scratch");
  await Promise.all([mkdir(workspace), mkdir(scratchDirectory)]);
  const canonicalWorkspace = await realpath(workspace);
  const canonicalScratch = await realpath(scratchDirectory);
  const profileInWorkspace = join(workspace, "runtime.yaml");
  await writeFile(
    profileInWorkspace,
    stringify({
      version: 1,
      mounts: [{ source: process.execPath, target: "/runtime/node" }],
      commands: { node: "/runtime/node" },
    }),
  );
  const loadedWorkspaceProfile = await loadSandboxRuntimeProfile(profileInWorkspace);
  expect(() =>
    assertRuntimeMountsOutside({
      profile: loadedWorkspaceProfile,
      workspace: canonicalWorkspace,
      scratchDirectory: canonicalScratch,
    }),
  ).toThrow("Runtime profile cannot overlap");
});

it("rejects runtime sources and targets inside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runtime-boundary-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const scratchPath = join(root, "scratch");
  await Promise.all([mkdir(workspacePath), mkdir(scratchPath)]);
  const workspace = await realpath(workspacePath);
  const scratchDirectory = await realpath(scratchPath);
  const source = join(workspace, "executable");
  await writeFile(source, "synthetic executable");
  const externalProfile = await loadSandboxRuntimeProfile(
    await profileFile({
      version: 1,
      mounts: [{ source, target: "/runtime/node" }],
      commands: { node: "/runtime/node" },
    }),
  );
  expect(() =>
    assertRuntimeMountsOutside({
      profile: externalProfile,
      workspace,
      scratchDirectory,
    }),
  ).toThrow("Runtime files cannot overlap");

  const target = join(workspace, "node");
  const targetProfile = await loadSandboxRuntimeProfile(
    await profileFile({
      version: 1,
      mounts: [{ source: process.execPath, target }],
      commands: { node: target },
    }),
  );
  expect(() =>
    assertRuntimeMountsOutside({
      profile: targetProfile,
      workspace,
      scratchDirectory,
    }),
  ).toThrow("targets cannot overlap");
});
