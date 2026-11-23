// ============================================================
// test_run_log.ts
// Purpose : Verify raw run logs are stored privately and exclusively
// Feature : Shared
// Role    : Unit Test
// API Doc : N/A
// ============================================================
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeRunLog } from "@/engine/run_log";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "factory-run-log-"));
  directories.push(directory);
  return directory;
}

it("writes exact raw content with private permissions", async () => {
  const directory = await makeDirectory();
  const content = "token=synthetic-private-value\nsecond line\n";

  const path = await writeRunLog({ directory, fileName: "stderr.log", content });

  expect(await readFile(path, "utf8")).toBe(content);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("writes empty content", async () => {
  const directory = await makeDirectory();

  const path = await writeRunLog({ directory, fileName: "empty.log", content: "" });

  expect(await readFile(path, "utf8")).toBe("");
});

it("does not overwrite an existing file", async () => {
  const directory = await makeDirectory();
  const path = join(directory, "stderr.log");
  await writeFile(path, "original\n");

  await expect(writeRunLog({ directory, fileName: "stderr.log", content: "replacement" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(path, "utf8")).toBe("original\n");
});

it("does not follow an existing symlink", async () => {
  const directory = await makeDirectory();
  const target = join(directory, "target.log");
  await writeFile(target, "original target\n");
  await symlink(target, join(directory, "stderr.log"));

  await expect(writeRunLog({ directory, fileName: "stderr.log", content: "replacement" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(target, "utf8")).toBe("original target\n");
});

it("rejects relative directories and invalid file names", async () => {
  const directory = await makeDirectory();
  await expect(writeRunLog({ directory: ".", fileName: "stderr.log", content: "x" })).rejects.toThrow();

  for (const fileName of ["", ".", "..", "sub/log", "sub\\log"]) {
    await expect(writeRunLog({ directory, fileName, content: "x" })).rejects.toThrow();
  }
});

it("propagates missing-directory errors", async () => {
  const directory = join(await makeDirectory(), "missing");

  await expect(writeRunLog({ directory, fileName: "stderr.log", content: "x" })).rejects.toMatchObject({
    code: "ENOENT",
  });
});
