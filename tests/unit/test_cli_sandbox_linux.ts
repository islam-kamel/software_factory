// ============================================================
// test_cli_sandbox_linux.ts
// Purpose : Prove Linux sandbox filesystem access boundaries
// Feature : Agent execution security
// Role    : Unit Test
// API Doc : https://github.com/containers/bubblewrap
// ============================================================
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, it } from "vitest";
import { runSandboxed } from "@/adapters/cli_runner/sandbox";
import { loadSandboxRuntimeProfile, type SandboxRuntimeProfile } from "@/adapters/cli_runner/runtime_profile";

const temporaryDirectories: string[] = [];
const linuxRuntime = process.platform === "linux" ? getLinuxRuntimePaths(process.arch) : undefined;
const linuxLibraryDirectory = linuxRuntime?.libraryDirectory ?? "";
const supportsLinuxRuntime = linuxRuntime !== undefined;
const runtimeFiles = [
  ["/usr/bin/bash", "/bin/bash"],
  [resolve(linuxLibraryDirectory, "libtinfo.so.6"), resolve(linuxLibraryDirectory, "libtinfo.so.6")],
  [resolve(linuxLibraryDirectory, "libc.so.6"), resolve(linuxLibraryDirectory, "libc.so.6")],
  ...(linuxRuntime ? ([[linuxRuntime.loader, linuxRuntime.loader]] as const) : []),
  [process.execPath, "/usr/local/bin/node"],
  ...["libatomic.so.1", "libdl.so.2", "libm.so.6", "libstdc++.so.6", "libgcc_s.so.1", "libpthread.so.0"].map(
    (library) => [resolve(linuxLibraryDirectory, library), resolve(linuxLibraryDirectory, library)] as const,
  ),
] as const;

function getLinuxRuntimePaths(architecture: string): { libraryDirectory: string; loader: string } {
  if (architecture === "arm64") {
    return { libraryDirectory: "/lib/aarch64-linux-gnu", loader: "/lib/ld-linux-aarch64.so.1" };
  }
  if (architecture === "x64") {
    return { libraryDirectory: "/lib/x86_64-linux-gnu", loader: "/lib64/ld-linux-x86-64.so.2" };
  }
  throw new Error(`Unsupported architecture for Linux sandbox fixture: ${architecture}`);
}

async function runtimeProfile(base: string, cliPath: string): Promise<SandboxRuntimeProfile> {
  const mounts = await Promise.all([
    ...runtimeFiles.map(async ([source, target]) => ({
      source: await realpath(source),
      target,
    })),
    (async () => ({
      source: await realpath(cliPath),
      target: "/runtime/codex",
    }))(),
  ]);
  const path = resolve(base, "runtime-profile.yaml");
  await writeFile(
    path,
    stringify({
      version: 1,
      mounts,
      commands: {
        "/bin/bash": "/bin/bash",
        node: "/usr/local/bin/node",
        codex: "/runtime/codex",
      },
    }),
  );
  return loadSandboxRuntimeProfile(path);
}

async function fixture(): Promise<{
  workspace: string;
  scratchDirectory: string;
  configurationDirectory: string;
  runtimeProfile: SandboxRuntimeProfile;
}> {
  const base = await mkdtemp(resolve(tmpdir(), "factory-sandbox-test-"));
  temporaryDirectories.push(base);
  const workspace = resolve(base, "workspace");
  const scratchDirectory = resolve(base, "scratch");
  const configurationDirectory = resolve(base, "configuration");
  await mkdir(resolve(workspace, "private"), { recursive: true });
  await mkdir(resolve(workspace, "src/private"), { recursive: true });
  await Promise.all([mkdir(scratchDirectory), mkdir(configurationDirectory)]);
  await writeFile(resolve(workspace, "visible.txt"), "visible\n");
  await writeFile(resolve(workspace, "private/ignored.txt"), "private\n");
  await writeFile(resolve(workspace, "src/public.txt"), "public\n");
  await writeFile(resolve(workspace, "src/private/hidden.txt"), "nested private\n");
  const hostHome = resolve(base, "unrelated-home");
  await mkdir(hostHome);
  await writeFile(resolve(hostHome, "credential.txt"), "synthetic credential\n");
  await symlink(resolve(hostHome, "credential.txt"), resolve(workspace, "home-escape"));
  // Keep the executable fixture off temporary filesystems that may be mounted noexec.
  const cliDirectory = await mkdtemp(resolve(process.cwd(), ".factory-sandbox-cli-"));
  temporaryDirectories.push(cliDirectory);
  const cliPath = resolve(cliDirectory, "fake-codex");
  await writeFile(cliPath, "#!/bin/bash\nprintf 'synthetic-codex 1.0\\n'\n");
  await chmod(cliPath, 0o700);
  return {
    workspace,
    scratchDirectory,
    configurationDirectory,
    runtimeProfile: await runtimeProfile(configurationDirectory, cliPath),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.skipIf(!supportsLinuxRuntime)("runs explicitly mounted Node and CLI help", async () => {
  const fixtureData = await fixture();
  const options = {
    ...fixtureData,
    ignorePaths: [],
    access: "read_only" as const,
    timeoutMs: 5000,
  };
  const node = await runSandboxed("node", ["--version"], options);
  const cli = await runSandboxed("codex", ["--help"], options);
  expect(node).toMatchObject({ exitCode: 0, stdout: `${process.version}\n` });
  expect(cli).toMatchObject({
    exitCode: 0,
    stdout: "synthetic-codex 1.0\n",
  });

  const key = "SF_TEST_HOST_ONLY";
  const previous = process.env[key];
  process.env[key] = "synthetic-host-only-value";
  try {
    const environment = await runSandboxed(
      "node",
      ["-e", "process.stdout.write(process.env.HOME + '\\n' + (process.env.SF_TEST_HOST_ONLY ?? 'missing'))"],
      options,
    );
    expect(environment).toMatchObject({ exitCode: 0, stdout: "/home/factory\nmissing" });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

it.skipIf(!supportsLinuxRuntime)("launches the host sandbox with a runtime-only guest PATH", async () => {
  const fixtureData = await fixture();
  const runtimeProfile = {
    ...fixtureData.runtimeProfile,
    mounts: fixtureData.runtimeProfile.mounts.map((mount) =>
      mount.target === "/bin/bash" ? { ...mount, target: "/runtime/bash" } : mount,
    ),
    commands: { bash: "/runtime/bash" },
  };
  const result = await runSandboxed("bash", ["-c", 'test "$PATH" = "/runtime" && printf runtime-only-path'], {
    ...fixtureData,
    runtimeProfile,
    ignorePaths: [],
    access: "read_only",
    timeoutMs: 5000,
  });

  expect(result).toMatchObject({ exitCode: 0, stdout: "runtime-only-path" });
});

it.skipIf(!supportsLinuxRuntime)("launches while masking a parent and nested runtime profile", async () => {
  const fixtureData = await fixture();
  const baseOptions = {
    ...fixtureData,
    ignorePaths: [],
    access: "read_only" as const,
    timeoutMs: 5000,
  };
  const nested = await runSandboxed(
    "/bin/bash",
    [
      "-c",
      'test -d "$1" && test ! -e "$2" && printf nested-hidden',
      "--",
      fixtureData.configurationDirectory,
      fixtureData.runtimeProfile.path,
    ],
    {
      ...baseOptions,
      blockedPaths: [fixtureData.configurationDirectory, fixtureData.runtimeProfile.path],
    },
  );
  const standalone = await runSandboxed(
    "/bin/bash",
    ["-c", 'value=$(< "$1"); test -z "$value" && printf standalone-hidden', "--", fixtureData.runtimeProfile.path],
    { ...baseOptions, blockedPaths: [fixtureData.runtimeProfile.path] },
  );

  expect(nested).toMatchObject({ exitCode: 0, stdout: "nested-hidden" });
  expect(standalone).toMatchObject({ exitCode: 0, stdout: "standalone-hidden" });
});

it.skipIf(!supportsLinuxRuntime)("allows public reads and denies ignored reads", async () => {
  const fixtureData = await fixture();
  const options = {
    ...fixtureData,
    ignorePaths: ["private/**", "src/private/**"],
    access: "read_only" as const,
    timeoutMs: 5000,
  };
  const allowed = await runSandboxed(
    "/bin/bash",
    ["-c", "IFS= read -r line < visible.txt; printf '%s\\n' \"$line\""],
    options,
  );
  const nestedPublic = await runSandboxed(
    "/bin/bash",
    ["-c", "IFS= read -r line < src/public.txt; printf '%s\\n' \"$line\""],
    options,
  );
  const ignored = await runSandboxed("/bin/bash", ["-c", "IFS= read -r line < private/ignored.txt"], options);
  const nestedIgnored = await runSandboxed("/bin/bash", ["-c", "IFS= read -r line < src/private/hidden.txt"], options);
  expect(allowed).toMatchObject({ exitCode: 0, stdout: "visible\n" });
  expect(nestedPublic).toMatchObject({ exitCode: 0, stdout: "public\n" });
  expect(ignored.exitCode).not.toBe(0);
  expect(nestedIgnored.exitCode).not.toBe(0);
});

it.skipIf(!supportsLinuxRuntime)("blocks loopback connections only when offline is enabled", async () => {
  const server = createServer((socket) => socket.end("reachable"));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");

  try {
    const fixtureData = await fixture();
    const options = {
      ...fixtureData,
      ignorePaths: [],
      access: "read_only" as const,
      timeoutMs: 5000,
    };
    const probe = [
      "const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');",
      "let response = '';",
      "socket.setEncoding('utf8');",
      "socket.on('data', (chunk) => { response += chunk; });",
      "socket.once('connect', () => socket.end());",
      "socket.once('end', () => process.exit(response === 'reachable' ? 0 : 3));",
      "socket.once('error', () => process.exit(2));",
    ].join("\n");
    const available = await runSandboxed("node", ["-e", probe, String(address.port)], options);
    const blocked = await runSandboxed("node", ["-e", probe, String(address.port)], { ...options, offline: true });

    expect(available.exitCode).toBe(0);
    expect(blocked.exitCode).not.toBe(0);
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});

it.skipIf(!supportsLinuxRuntime)("denies Planner writes, host-home symlinks, and unrelated system files", async () => {
  const fixtureData = await fixture();
  const options = {
    ...fixtureData,
    ignorePaths: [],
    access: "read_only" as const,
    timeoutMs: 5000,
  };
  const deniedWrite = await runSandboxed("/bin/bash", ["-c", "printf blocked > blocked.txt"], options);
  const outside = await runSandboxed("/bin/bash", ["-c", "test -r home-escape"], options);
  const system = await runSandboxed("/bin/bash", ["-c", "test -e /etc/passwd -o -e /usr/local/share"], options);
  expect(deniedWrite.exitCode).not.toBe(0);
  expect(outside.exitCode).not.toBe(0);
  expect(system.exitCode).not.toBe(0);
  await expect(readFile(resolve(options.workspace, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(!supportsLinuxRuntime)("keeps Builder writes inside safe workspace paths", async () => {
  const fixtureData = await fixture();
  const options = {
    ...fixtureData,
    ignorePaths: ["private/**", "src/private/**"],
    access: "workspace_write" as const,
    timeoutMs: 5000,
  };
  const allowed = await runSandboxed("/bin/bash", ["-c", "printf created > created.txt"], options);
  const nestedAllowed = await runSandboxed("/bin/bash", ["-c", "printf created > src/public-created.txt"], options);
  const ignored = await runSandboxed("/bin/bash", ["-c", "printf blocked > private/created.txt"], options);
  const nestedIgnored = await runSandboxed("/bin/bash", ["-c", "printf blocked > src/private/created.txt"], options);
  expect(allowed.exitCode).toBe(0);
  expect(nestedAllowed.exitCode).toBe(0);
  expect(ignored.exitCode).not.toBe(0);
  expect(nestedIgnored.exitCode).not.toBe(0);
  await expect(readFile(resolve(options.workspace, "created.txt"))).resolves.toEqual(Buffer.from("created"));
  await expect(readFile(resolve(options.workspace, "src/public-created.txt"))).resolves.toEqual(Buffer.from("created"));
  await expect(readFile(resolve(options.workspace, "private/created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(resolve(options.workspace, "src/private/created.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
