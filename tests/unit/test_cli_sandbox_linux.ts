// ============================================================
// test_cli_sandbox_linux.ts
// Purpose : Prove Linux sandbox filesystem access boundaries
// Feature : Agent execution security
// Role    : Unit Test
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSandboxed } from "@/adapters/cli_runner/sandbox";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ workspace: string; scratchDirectory: string }> {
  const base = await mkdtemp(resolve(tmpdir(), "factory-sandbox-test-"));
  temporaryDirectories.push(base);
  const workspace = resolve(base, "workspace");
  const scratchDirectory = resolve(base, "scratch");
  await mkdir(resolve(workspace, "private"), { recursive: true });
  await mkdir(resolve(workspace, "src/private"), { recursive: true });
  await mkdir(scratchDirectory);
  await writeFile(resolve(workspace, "visible.txt"), "visible\n");
  await writeFile(resolve(workspace, "private/ignored.txt"), "private\n");
  await writeFile(resolve(workspace, "src/public.txt"), "public\n");
  await writeFile(resolve(workspace, "src/private/hidden.txt"), "nested private\n");
  return { workspace, scratchDirectory };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("Linux agent sandbox", () => {
  it("allows safe reads while denying ignored reads and repository writes", async () => {
    const options = {
      ...(await fixture()),
      ignorePaths: ["private/**", "src/private/**"],
      access: "read_only" as const,
      timeoutMs: 5000,
    };
    const allowed = await runSandboxed("/bin/cat", ["visible.txt"], options);
    const nestedPublic = await runSandboxed("/bin/cat", ["src/public.txt"], options);
    const ignored = await runSandboxed("/bin/cat", ["private/ignored.txt"], options);
    const nestedIgnored = await runSandboxed("/bin/cat", ["src/private/hidden.txt"], options);
    const deniedWrite = await runSandboxed("/usr/bin/touch", ["blocked.txt"], options);
    expect(allowed).toMatchObject({ exitCode: 0, stdout: "visible\n" });
    expect(nestedPublic).toMatchObject({ exitCode: 0, stdout: "public\n" });
    expect(ignored.exitCode).not.toBe(0);
    expect(nestedIgnored.exitCode).not.toBe(0);
    expect(deniedWrite.exitCode).not.toBe(0);
    await expect(readFile(resolve(options.workspace, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Builder writes inside safe workspace paths", async () => {
    const options = {
      ...(await fixture()),
      ignorePaths: ["private/**", "src/private/**"],
      access: "workspace_write" as const,
      timeoutMs: 5000,
    };
    const allowed = await runSandboxed("/usr/bin/touch", ["created.txt"], options);
    const nestedAllowed = await runSandboxed("/usr/bin/touch", ["src/public-created.txt"], options);
    const ignored = await runSandboxed("/usr/bin/touch", ["private/created.txt"], options);
    const nestedIgnored = await runSandboxed("/usr/bin/touch", ["src/private/created.txt"], options);
    expect(allowed.exitCode).toBe(0);
    expect(nestedAllowed.exitCode).toBe(0);
    expect(ignored.exitCode).not.toBe(0);
    expect(nestedIgnored.exitCode).not.toBe(0);
    await expect(readFile(resolve(options.workspace, "created.txt"))).resolves.toEqual(Buffer.alloc(0));
    await expect(readFile(resolve(options.workspace, "src/public-created.txt"))).resolves.toEqual(Buffer.alloc(0));
    await expect(readFile(resolve(options.workspace, "private/created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(options.workspace, "src/private/created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
